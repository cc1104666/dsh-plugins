/**
 * 本机转发器：多账号轮换的唯一落点。
 *
 * 为什么必须在这一层做「额度用尽自动切换」：
 *   LightVela 的网关是 OpenAI 兼容的，DSH 拿到 baseURL + key 就自己直连了 ——
 *   插件根本不在请求链路里。等 DSH 报 402 回来，这一轮对话已经废了，插件也没
 *   机会换钥匙重试。所以要把 baseURL 指向本机，让「挑账号」发生在真正发请求之前。
 *
 * 它不是反代：不翻译协议、不改请求体、不改响应体。只做三件事：
 *   1. 按 store.candidates() 的顺序挑账号，把 Authorization 换成它的钥匙；
 *   2. 撞到 402（或 401 钥匙失效）就把这个账号标掉，**换下一个重试**；
 *   3. 成功的响应原样透传（含 SSE 流）。
 *
 * 只监听 127.0.0.1 —— 它不给外面用，是给同机的 DSH 用的。
 */
import http from 'node:http'
import { Readable } from 'node:stream'

const MAX_BODY = 32 * 1024 * 1024
/** 响应头里这几个不能照搬：undici 已经解过压缩，长度也对不上了。 */
const HOP_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive'])

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res, status, message, code) {
  sendJson(res, status, {
    error: { message, type: 'lightvela_relay_error', code: code || 'relay_error' },
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
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
 * 这是不是「这个账号没额度了」。
 *
 * 402 是明确的余额不足。429 一般是限流，不一定没额度，所以只换账号、不标死 ——
 * 下一条消息还可以再试它。401 是钥匙本身失效（实例重建过），标成 error 让人重拉。
 */
function classify(status, text) {
  if (status === 402) return 'exhausted'
  if (status === 401) return 'error'
  if (status === 429) return 'retry'
  if (status === 403) {
    return /quota|credit|balance|额度|余额/i.test(String(text || '')) ? 'exhausted' : ''
  }
  return ''
}

function explain(status, text) {
  const raw = String(text || '').trim()
  if (raw === '') return `HTTP ${status}`
  try {
    const parsed = JSON.parse(raw)
    const message = parsed && parsed.error && (parsed.error.message || parsed.error.code)
    if (message) return `${message}（HTTP ${status}）`
  } catch {
    /* 不是 JSON，退回原文 */
  }
  return raw.slice(0, 300)
}

/**
 * 复制响应头。real fetch 给的是 Headers 对象（有 forEach），
 * 但被测替身/某些代理实现可能给普通对象 —— 两种都接住，别在透传那一步炸。
 */
function copyHeaders(source) {
  const out = {}
  if (!source) return out
  if (typeof source.forEach === 'function') {
    source.forEach((value, key) => {
      if (!HOP_HEADERS.has(String(key).toLowerCase())) out[key] = value
    })
    return out
  }
  for (const [key, value] of Object.entries(source)) {
    if (HOP_HEADERS.has(String(key).toLowerCase())) continue
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * @param {object} deps
 * @param {() => Array<{id:string,label:string,apiKey:string,gatewayBase:string}>} deps.getCandidates
 * @param {() => object} deps.getConfig
 * @param {(id:string,status:string,note:string)=>void} [deps.onQuota]  账号被判死时回调
 * @param {(id:string)=>void} [deps.onActive]                           实际生效账号变了
 * @param {(line:string)=>void} [deps.log]
 */
export function createRelay(deps) {
  const log = deps.log || (() => {})
  let server = null
  let port = 0

  const candidates = () => {
    try {
      const list = deps.getCandidates ? deps.getCandidates() : []
      return Array.isArray(list) ? list.filter((item) => item && item.apiKey) : []
    } catch (error) {
      log(`取账号池失败：${String((error && error.message) || error)}`)
      return []
    }
  }

  const targetUrl = (account, pathAndQuery) => {
    const base = String(account.gatewayBase || '').replace(/\/+$/, '')
    // DSH 打的是 /v1/xxx，gatewayBase 本身就带 /v1，所以只接后面那段。
    const tail = pathAndQuery.startsWith('/v1/') ? pathAndQuery.slice(3) : pathAndQuery
    return `${base}${tail.startsWith('/') ? tail : `/${tail}`}`
  }

  /** 成功的响应原样倒给客户端，SSE 也不缓冲。 */
  const pipe = async (res, response, account) => {
    const headers = copyHeaders(response.headers)
    headers['x-lightvela-account'] = encodeURIComponent(account.label || account.id)

    if (!response.body) {
      // 没有流可透传（少见的空响应）：退回读文本，保证客户端拿得到东西。
      const text = typeof response.text === 'function' ? await response.text() : ''
      headers['content-length'] = String(Buffer.byteLength(text))
      res.writeHead(response.status, headers)
      res.end(text)
      return
    }

    res.writeHead(response.status, headers)
    const stream = Readable.fromWeb(response.body)
    stream.on('error', (error) => {
      log(`透传响应中断：${String((error && error.message) || error)}`)
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    })
    stream.pipe(res)
  }

  async function handle(req, res) {
    const rawUrl = String(req.url || '/')
    const queryIndex = rawUrl.indexOf('?')
    const path = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl
    const pathAndQuery = rawUrl

    if (req.method === 'GET' && (path === '/healthz' || path === '/')) {
      sendJson(res, 200, {
        ok: true,
        port,
        accounts: candidates().map((item) => ({ id: item.id, label: item.label })),
      })
      return
    }

    const pool = candidates()
    if (pool.length === 0) {
      sendError(res, 503, '还没有可用的模型钥匙。先在面板里扫码 + 拉钥匙。', 'no_account')
      return
    }

    const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req)
    const baseHeaders = {
      'content-type': req.headers['content-type'] || 'application/json',
      accept: req.headers.accept || 'application/json',
    }
    if (body.length > 0) baseHeaders['content-length'] = String(body.length)

    let last = null

    for (const account of pool) {
      // 客户端断开就别再往下试了
      if (res.writableEnded || res.destroyed) return

      let response
      try {
        response = await fetch(targetUrl(account, pathAndQuery), {
          method: req.method,
          headers: { ...baseHeaders, authorization: `Bearer ${account.apiKey}` },
          body: body.length > 0 ? body : undefined,
          redirect: 'manual',
        })
      } catch (error) {
        const note = String((error && error.message) || error)
        log(`账号 ${account.label || account.id} 请求失败：${note}`)
        last = { status: 502, text: JSON.stringify({ error: { message: note, code: 'network' } }), account }
        continue
      }

      if (response.ok) {
        if (deps.onActive && account.id) deps.onActive(account.id)
        await pipe(res, response, account)
        return
      }

      // 失败体一般很小，读成文本来判断；不能直接 pipe，否则没法重试。
      const text = await response.text().catch(() => '')
      const kind = classify(response.status, text)

      if (kind === 'exhausted' || kind === 'error' || kind === 'retry') {
        const note = explain(response.status, text)
        log(
          `账号 ${account.label || account.id} ${kind === 'exhausted' ? '没额度了' : kind === 'error' ? '钥匙失效' : '被限流'}：${note}`,
        )
        if (deps.onQuota) deps.onQuota(account.id, kind === 'retry' ? 'retry' : kind, note)
        last = { status: response.status, text, account }
        continue
      }

      // 其它错误（400 参数不对、404 没有这个模型…）换账号也没用，直接回给 DSH。
      const headers = copyHeaders(response.headers)
      headers['content-length'] = String(Buffer.byteLength(text))
      res.writeHead(response.status, headers)
      res.end(text)
      return
    }

    // 全试完了还是不行：把最后一个错误如实回给 DSH
    if (last) {
      sendError(res, last.status || 502, `${explain(last.status, last.text)}（已试过 ${pool.length} 个账号）`, 'all_accounts_failed')
      return
    }
    sendError(res, 503, '没有账号能处理这次请求', 'no_account')
  }

  return {
    /** 起服务（重复调用无害）。首选端口被占就顺延，最后才随机。 */
    async start(preferred) {
      if (server && port) return port
      const candidatesPorts = []
      const base = Number(preferred) > 0 ? Number(preferred) : 43720
      for (let i = 0; i < 12; i += 1) candidatesPorts.push(base + i)
      candidatesPorts.push(0)

      for (const candidate of candidatesPorts) {
        const attempt = http.createServer((req, res) => {
          handle(req, res).catch((error) => {
            log(`relay 出错：${String((error && error.message) || error)}`)
            if (!res.headersSent) sendError(res, 500, String((error && error.message) || error))
            else {
              try {
                res.end()
              } catch {
                /* ignore */
              }
            }
          })
        })
        try {
          await new Promise((resolve, reject) => {
            attempt.once('error', reject)
            attempt.listen(candidate, '127.0.0.1', resolve)
          })
          server = attempt
          port = attempt.address().port
          log(`转发器已启动：http://127.0.0.1:${port}/v1`)
          return port
        } catch (error) {
          attempt.close()
          if (candidate === 0) throw error
        }
      }
      throw new Error('找不到可用端口起转发器')
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
