/**
 * 本机反代：把 DSH 的 OpenAI 请求译成 ima.qq.com 的那一套。
 *
 * 为什么这里**必须**有反代（和 grok-online 一样，和 LightVela 相反）：
 *   ima 的对话接口是 POST /cgi-bin/assistant/qa + 自己的命名事件 SSE，
 *   既不是 OpenAI 兼容、还要 x-ima-cookie / x-ima-bkn 三个自定义头。
 *   模型选择器只会说标准 OpenAI + Authorization，所以中间得有人翻译。
 *
 * 只做三件事：
 *   GET  /v1/models             列模型
 *   POST /v1/chat/completions   对话（stream / 非 stream 都支持）
 *   GET  /healthz               探活
 *
 * 没登录时一律 401 并给出中文提示（DSH 会把 error.message 显示在聊天框里）。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { chatOnce } from './upstream.js'
import { findModel } from './models.js'

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
    error: { message, type: 'ima_relay_error', code: code || 'ima_error' },
  })
}

function statusOf(result) {
  const code = String((result && result.code) || '')
  if (code === 'http_401') return 401
  if (code === 'http_429') return 429
  if (code === 'empty') return 400
  if (code === 'init') return 502
  if (code === 'aborted') return 499
  return 502
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
  return Math.max(1, Math.round(length / 2.5))
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig   运行期配置
 * @param {() => object|null} deps.getAuth  登录态（null = 未登录）
 * @param {() => object} deps.getDevice   设备信息 {guid, q36}
 * @param {() => Array} deps.getModels    当前模型清单（含 modelType）
 * @param {(line:string)=>void} [deps.log]
 */
export function createRelay(deps) {
  const log = deps.log || (() => {})
  let server = null
  let port = 0

  async function handleChat(req, res) {
    const raw = await readBody(req)
    let body
    try {
      body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'))
    } catch {
      sendError(res, 400, '请求体不是合法 JSON', 'bad_request')
      return
    }

    const auth = typeof deps.ensureAuth === 'function' ? await deps.ensureAuth() : deps.getAuth()
    if (!auth || !auth.token) {
      sendError(res, 401, 'ima 还没有登录。打开 dsh-ima 面板微信扫码登录后再试。', 'not_authed')
      return
    }

    const catalog = deps.getModels() || []
    const model = findModel(catalog, String(body.model || ''))
    if (!model) {
      sendError(res, 404, `模型清单是空的或找不到「${body.model}」。回面板点「读清单」刷新。`, 'model_not_found')
      return
    }

    const wantStream = Boolean(body.stream)
    const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const created = Math.floor(Date.now() / 1000)
    const messages = Array.isArray(body.messages) ? body.messages : []

    if (!wantStream) {
      const result = await chatOnce(deps, { messages, model })
      if (!result.ok) {
        sendError(res, statusOf(result), result.error, result.code)
        return
      }
      const usage = {
        prompt_tokens: estimateTokens(messages.map((m) => m.content).join('')),
        completion_tokens: estimateTokens(result.text),
        total_tokens: 0,
      }
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: model.id,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.text,
              ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
            },
            finish_reason: result.finishReason || 'stop',
          },
        ],
        usage,
      })
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
        model: model.id,
        choices: [{ index: 0, delta, finish_reason: finishReason || null }],
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    let sentRole = false
    const ensureRole = () => {
      if (sentRole) return
      sentRole = true
      writeChunk({ role: 'assistant', content: '' })
    }

    const result = await chatOnce(
      {
        ...deps,
        onDelta: (delta) => {
          ensureRole()
          writeChunk({ content: delta })
        },
        onReasoning: (delta) => {
          ensureRole()
          // reasoning 用 OpenAI 社区惯用的字段回传，DSH 不认也不影响正文
          writeChunk({ reasoning_content: delta })
        },
      },
      { messages, model },
    )

    if (!result.ok) {
      if (!started) {
        sendError(res, statusOf(result), result.error, result.code)
        return
      }
      // 已经吐过字了：用一条错误事件收尾，让 DSH 知道这轮是残缺的
      res.write(`data: ${JSON.stringify({ error: { message: result.error, code: result.code || 'ima_error' } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    if (!sentRole) {
      writeChunk({ role: 'assistant', content: result.text || '' })
    }
    const usage = {
      prompt_tokens: estimateTokens(messages.map((m) => m.content).join('')),
      completion_tokens: estimateTokens(result.text),
      total_tokens: 0,
    }
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
    startStream()
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: model.id,
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
        const catalog = deps.getModels() || []
        sendJson(res, 200, {
          object: 'list',
          data: catalog.map((item) => ({
            id: item.id,
            object: 'model',
            owned_by: 'ima.qq.com',
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
        const auth = deps.getAuth()
        sendJson(res, 200, { ok: true, port, authed: Boolean(auth && auth.token) })
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
      const base = Number(preferred) > 0 ? Number(preferred) : 43710
      if (Number(preferred) > 0) {
        for (let i = 0; i < 12; i += 1) candidates.push(base + i)
      }
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
