/**
 * 本机反代：把 DSH 的 OpenAI 请求译成 grok.online 的那一套。
 *
 * 为什么这里**必须**有反代（和 LightVela 相反）：
 *   LightVela 的网关本身就是 OpenAI 兼容的，填个 baseURL 就行；
 *   grok.online 只有一个自定义接口 /api/chat —— 请求要 {model, role, messages}，
 *   响应是它自己拼的 SSE。模型选择器只会说标准 OpenAI，所以中间得有人翻译。
 *
 * 只做三件事：
 *   GET  /v1/models             列模型
 *   POST /v1/chat/completions   对话（stream / 非 stream 都支持）
 *   GET  /healthz               探活
 *
 * 翻译规则写在 lib/upstream.js 里（buildGrokPayload / chat），出口轮换取
 * lib/rotate.js（deps.getPlan 给出这一轮按什么顺序试代理），这里只负责协议适配。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { buildGrokPayload, explainFailure } from './upstream.js'
import { chatWithRotation } from './rotate.js'
import { MODELS, canonicalModel } from './models.js'

function sendJson(res, status, value, extraHeaders) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  })
  res.end(body)
}

function sendError(res, status, message, code) {
  sendJson(res, status, {
    error: { message, type: 'grok_online_relay_error', code: code || 'grok_error' },
  })
}

/** 上游 code → HTTP 状态码。DSH 靠状态码分类（429 可以重试，4xx 不行）。 */
function statusOf(result) {
  const code = String((result && result.code) || '')
  if (code === 'limit' || code === 'rate') return 429
  if (code === 'model_locked') return 403
  if (code === 'too_long') return 413
  if (code === 'network' || code === 'busy' || code === 'empty' || code === 'http') return 502
  return (result && result.status) || 502
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function estimateTokens(text) {
  const length = String(text || '').length
  // 中英混排粗估：中文约 1 字 1 token，英文约 4 字符 1 token；取中间值 2.5
  return Math.max(1, Math.round(length / 2.5))
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig      运行期配置
 * @param {() => object} [deps.getPlan]      这一轮的出口计划（见 lib/rotate.js）
 * @param {(info:{credits:number,bonus:string,route?:object})=>void} [deps.onCredits]
 * @param {(line:string)=>void} [deps.log]
 */
export function createRelay(deps) {
  const log = deps.log || (() => {})
  let server = null
  let port = 0

  const plan = () => (typeof deps.getPlan === 'function' ? deps.getPlan() : {})

  async function handleChat(req, res) {
    const config = deps.getConfig()
    const raw = await readBody(req)
    let body
    try {
      body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'))
    } catch {
      sendError(res, 400, '请求体不是合法 JSON', 'bad_request')
      return
    }

    const payload = buildGrokPayload(config, body)
    const wantStream = Boolean(body && body.stream)
    const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const created = Math.floor(Date.now() / 1000)
    const modelName = canonicalModel(payload.model)

    if (!wantStream) {
      const result = await chatWithRotation(config, payload, {}, plan())
      if (!result.ok) {
        sendError(res, statusOf(result), explainFailure(result), result.code || 'grok_error')
        return
      }
      if (result.credits !== null && result.credits !== undefined && deps.onCredits) {
        deps.onCredits({ credits: result.credits, bonus: result.bonus, route: result.route })
      }
      const usage = {
        prompt_tokens: (result.usage && result.usage.prompt_tokens) || estimateTokens(JSON.stringify(payload.messages)),
        completion_tokens: (result.usage && result.usage.completion_tokens) || estimateTokens(result.text),
        total_tokens: 0,
      }
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
      sendJson(
        res,
        200,
        {
          id,
          object: 'chat.completion',
          created,
          model: modelName,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: result.text },
              finish_reason: result.finishReason || 'stop',
            },
          ],
          usage,
        },
        result.route ? { 'x-grok-exit': encodeURIComponent(result.route.label) } : undefined,
      )
      return
    }

    // 流式：先不写头，等第一块内容到了再写 —— 否则上游报错时就没法拉回状态码了。
    let started = false
    const startStream = () => {
      if (started) return
      started = true
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
    }
    const writeChunk = (delta, finishReason) => {
      startStream()
      const chunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [{ index: 0, delta, finish_reason: finishReason || null }],
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    let sentRole = false
    const result = await chatWithRotation(
      config,
      payload,
      {
        onDelta: (delta) => {
          if (!sentRole) {
            sentRole = true
            writeChunk({ role: 'assistant', content: '' })
          }
          writeChunk({ content: delta })
        },
        onReasoning: (delta) => {
          if (!sentRole) {
            sentRole = true
            writeChunk({ role: 'assistant', content: '' })
          }
          // reasoning 用 OpenAI 社区惯用的字段回传，DSH 不认也不影响正文
          writeChunk({ reasoning_content: delta })
        },
        onCredits: (credits, bonus, route) => {
          if (deps.onCredits) deps.onCredits({ credits, bonus, route })
        },
      },
      plan(),
    )

    if (!result.ok) {
      const message = explainFailure(result)
      if (!started) {
        sendError(res, statusOf(result), message, result.code || 'grok_error')
        return
      }
      // 已经吐过字了：用一条错误事件收尾，让 DSH 知道这轮是残缺的
      res.write(`data: ${JSON.stringify({ error: { message, code: result.code || 'grok_error' } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    if (result.credits !== null && result.credits !== undefined && deps.onCredits) {
      deps.onCredits({ credits: result.credits, bonus: result.bonus, route: result.route })
    }

    if (!sentRole) {
      // 一个字都没吐就结束了（全在 reasoning 里也算有内容，上面已经发过）
      writeChunk({ role: 'assistant', content: result.text || '' })
    }
    const usage = {
      prompt_tokens: (result.usage && result.usage.prompt_tokens) || estimateTokens(JSON.stringify(payload.messages)),
      completion_tokens: (result.usage && result.usage.completion_tokens) || estimateTokens(result.text),
      total_tokens: 0,
    }
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
    startStream()
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [{ index: 0, delta: {}, finish_reason: result.finishReason || 'stop' }],
        usage,
      })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
    res.end()
  }

  const handler = async (req, res) => {
    const path = String(req.url || '').split('?')[0]
    try {
      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        sendJson(res, 200, {
          object: 'list',
          data: MODELS.map((item) => ({
            id: item.id,
            object: 'model',
            owned_by: 'grok.online',
            created: 0,
          })),
        })
        return
      }
      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        await handleChat(req, res)
        return
      }
      if (req.method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true, port })
        return
      }
      sendError(res, 404, `没有这条路由：${path}`, 'not_found')
    } catch (error) {
      log(`relay 出错：${String((error && error.message) || error)}`)
      if (!res.headersSent) sendError(res, 500, String((error && error.message) || error), 'relay_error')
      else res.end()
    }
  }

  return {
    /** 起服务（重复调用无害），返回监听端口。固定端口被占就顺延，最后才随机。 */
    async start(preferred) {
      if (server && port) return port
      const candidates = []
      const base = Number(preferred) > 0 ? Number(preferred) : 43690
      for (let i = 0; i < 12; i += 1) candidates.push(base + i)
      candidates.push(0)

      for (const candidate of candidates) {
        const attempt = http.createServer(handler)
        try {
          await new Promise((resolve, reject) => {
            attempt.once('error', reject)
            attempt.listen(candidate, '127.0.0.1', resolve)
          })
          server = attempt
          port = attempt.address().port
          log(`反代已启动：http://127.0.0.1:${port}/v1`)
          return port
        } catch (error) {
          attempt.close()
          if (candidate === 0) throw error
        }
      }
      throw new Error('找不到可用端口起反代')
    },
    get port() {
      return port
    },
    get baseURL() {
      return port ? `http://127.0.0.1:${port}/v1` : ''
    },
    close() {
      if (server) {
        server.close()
        server = null
        port = 0
      }
    },
  }
}
