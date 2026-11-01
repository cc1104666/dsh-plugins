/**
 * 本机反代：把 DSH 的 OpenAI 请求译成 Gradio 的 call/event 那一套。
 *
 * 为什么必须反代：DSH 的模型选择器只会说标准 OpenAI（/v1/models +
 * /v1/chat/completions），而 Space 是「POST 拿 event_id → GET 订阅 SSE」。
 * 中间这一层负责：拼提示词、把累计输出 diff 成增量、把错误翻成人话。
 *
 * 只做三件事：
 *   GET  /v1/models             列模型（= 配置里启用的 Space）
 *   POST /v1/chat/completions   对话（stream / 非 stream）
 *   GET  /healthz               探活
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { buildOptions, buildPrompt, estimateTokens, explainFailure } from './upstream.js'
import { runWithRotation } from './rotate.js'
import { DEFAULT_SPACE, SPACES, resolveSpace } from './spaces.js'

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
  sendJson(res, status, { error: { message, type: 'grok3ai_relay_error', code: code || 'grok3ai_error' } })
}

/** 上游 code → HTTP 状态码。DSH 靠状态码分类（429 可重试，4xx 不行）。 */
function statusOf(result) {
  const code = String((result && result.code) || '')
  if (code === 'rate') return 429
  if (code === 'busy') return 503
  if (code === 'timeout') return 504
  if (code === 'too_long') return 413
  if (code === 'network' || code === 'space_error' || code === 'empty' || code === 'http') return 502
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

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {(spaceId:string) => object} [deps.getPlan]   这一轮的入口计划（见 lib/rotate.js）
 * @param {() => object[]} [deps.getModels]             启用中的 Space（默认全开）
 * @param {(info:object)=>void} [deps.onResult]
 * @param {(line:string)=>void} [deps.log]
 */
export function createRelay(deps) {
  const log = deps.log || (() => {})
  let server = null
  let port = 0

  const modelsOf = () => {
    if (typeof deps.getModels === 'function') {
      const list = deps.getModels()
      if (Array.isArray(list) && list.length > 0) return list
    }
    return SPACES
  }

  const planFor = (spaceId) => (typeof deps.getPlan === 'function' ? deps.getPlan(spaceId) : {})

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

    const wanted = resolveSpace(body.model) || resolveSpace(DEFAULT_SPACE) || modelsOf()[0]
    const messages = Array.isArray(body.messages) ? body.messages : []
    if (messages.length === 0) {
      sendError(res, 400, 'messages 是空的', 'bad_request')
      return
    }

    const prompt = buildPrompt(messages, { contextChars: config.contextChars })
    const opts = buildOptions(config, body)
    const wantStream = Boolean(body && body.stream)
    const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const created = Math.floor(Date.now() / 1000)
    const modelName = wanted.id
    const plan = planFor(wanted.id)

    if (!wantStream) {
      const result = await runWithRotation(config, { prompt, opts }, {}, plan)
      if (deps.onResult) deps.onResult(result)
      if (!result.ok) {
        sendError(res, statusOf(result), explainFailure(result), result.code || 'grok3ai_error')
        return
      }
      const usage = {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(result.text),
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
          choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
          usage,
        },
        result.route ? { 'x-grok3ai-route': encodeURIComponent(result.route.label) } : undefined,
      )
      return
    }

    // 流式：先不写头，等第一块内容到了再写 —— 否则上游报错时就没法拉回状态码了
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
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: modelName,
          choices: [{ index: 0, delta, finish_reason: finishReason || null }],
        })}\n\n`,
      )
    }

    let sentRole = false
    const result = await runWithRotation(
      config,
      { prompt, opts },
      {
        signal: undefined,
        onDelta: (delta) => {
          if (!sentRole) {
            sentRole = true
            writeChunk({ role: 'assistant', content: '' })
          }
          writeChunk({ content: delta })
        },
      },
      plan,
    )
    if (deps.onResult) deps.onResult(result)

    if (!result.ok) {
      const message = explainFailure(result)
      if (!started) {
        sendError(res, statusOf(result), message, result.code || 'grok3ai_error')
        return
      }
      res.write(`data: ${JSON.stringify({ error: { message, code: result.code || 'grok3ai_error' } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    if (!sentRole) writeChunk({ role: 'assistant', content: result.text || '' })
    const usage = {
      prompt_tokens: estimateTokens(prompt),
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
        model: modelName,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
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
          data: modelsOf().map((space) => ({ id: space.id, object: 'model', owned_by: 'grok3ai', created: 0 })),
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
      const want = Number(preferred)
      const base = Number.isFinite(want) && want >= 0 ? Math.trunc(want) : 43695
      // 传 0 表示"随便找个空闲端口"（冒烟测试用），别再往下顺延
      if (base === 0) candidates.push(0)
      else {
        for (let i = 0; i < 12; i += 1) candidates.push(base + i)
        candidates.push(0)
      }

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
