/**
 * Gradio 客户端：跟一个 HuggingFace Space 说话。
 *
 * Gradio 4/5/6 的调用都一样，三步：
 *   1. POST {base}/gradio_api/call/{fn}   {data:[...]}
 *        → {"event_id": "..."}
 *   2. GET  {base}/gradio_api/call/{fn}/{event_id}   (text/event-stream)
 *        → event: generating / complete / error，data 是**累计**的输出数组
 *   3. 把累计值 diff 成增量，喂给上层
 *
 * 为什么不用 @gradio/client：DSH 宿主只保证 Node 自带能力，而这个协议就是两次
 * HTTP，手写反而更可控 —— 尤其是要支持"从代理出去"（fetchImpl 注入）。
 */
export class SpaceError extends Error {
  constructor(message, code, extra) {
    super(message)
    this.name = 'SpaceError'
    this.code = code || 'space_error'
    if (extra) Object.assign(this, extra)
  }
}

const HINTS = {
  503: 'Space 在睡觉或者正在冷启动（503）。第一次叫它可能要等十几秒，重试一发通常就醒',
  502: 'Space 网关回 502，通常是它在重启',
  404: '接口路径不存在（404）——Space 的 Gradio 版本变了，或者 fn 名字改了',
  401: 'Space 要登录（401）——这个 Space 可能已经改成私有',
  403: '被 HuggingFace 拦了（403），多半是出口 IP 触发了匿名额度限制',
  429: '被限流（429）——HF 对匿名访问按 IP 限制，等一会儿或换出口',
}

function httpHint(status, body) {
  const hint = HINTS[status] || `Space 回了 HTTP ${status}`
  const detail = String(body || '').replace(/\s+/g, ' ').slice(0, 160)
  return detail ? `${hint}：${detail}` : hint
}

/** Gradio 的 error 事件里 data 可能是一条 null（后端没抛 message），也可能是字符串。 */
function readErrorEvent(payload) {
  if (payload === null || payload === undefined) return ''
  if (typeof payload === 'string') return payload
  if (typeof payload === 'object') {
    if (typeof payload.error === 'string') return payload.error
    if (typeof payload.message === 'string') return payload.message
    if (Array.isArray(payload) && typeof payload[0] === 'string') return payload[0]
  }
  return ''
}

/** 上游给的是累计全文，这里 diff 出增量。 */
function nextDelta(previous, full) {
  if (!full) return ''
  if (full === previous) return ''
  if (full.startsWith(previous)) return full.slice(previous.length)
  // 少数 Space 会在中途改写整段（比如先回一段 "…" 再重写）；宁可整段重发也不丢字
  return full
}

function openController(signal, timeout) {
  const controller = new AbortController()
  let timer = null
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
  }
  if (timeout > 0) timer = setTimeout(() => controller.abort(new Error('timeout')), timeout)
  return {
    controller,
    signal: controller.signal,
    done() {
      if (timer) clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    },
    get mine() {
      return Boolean(timer && controller.signal.aborted)
    },
  }
}

/**
 * 真跑一发。
 *
 * @param {object} space    SPACES 里的一项
 * @param {string} prompt   已经拼好的纯文本
 * @param {object} opts     {maxTokens, temperature, topP}
 * @param {object} hooks    {signal, onDelta(delta, full), onEvent(name, payload), timeout}
 * @param {Function} fetchImpl  注入的 fetch（可能带代理）
 * @returns {Promise<{ok:boolean, text:string, elapsed:number, events:number, code?:string, message?:string}>}
 */
export async function runSpace(space, prompt, opts = {}, hooks = {}, fetchImpl = fetch) {
  const started = Date.now()
  const base = String(space.base || '').replace(/\/+$/, '')
  const prefix = space.apiPrefix || '/gradio_api'
  const gate = openController(hooks.signal, Number(hooks.timeout) > 0 ? Number(hooks.timeout) : 180000)
  let events = 0
  let text = ''
  let settled = false

  const fail = (message, code, extra) => {
    settled = true
    return { ok: false, text, elapsed: Date.now() - started, events, code: code || 'space_error', message, ...(extra || {}) }
  }

  try {
    const data = space.build(prompt, opts || {})
    let posted
    try {
      posted = await fetchImpl(`${base}${prefix}/call/${space.fn}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        // 不带 session_hash：Gradio 会自己建一个匿名会话。带着它反而会踩
        // "404: Session not found"（POST 认了这个 hash，GET 却要同一个会话才认，
        // 而 /call 这条路径并不会帮你注册它）。实测不带才通。
        body: JSON.stringify({ data }),
        signal: gate.signal,
      })
    } catch (error) {
      if (gate.controller.signal.aborted) {
        return fail(`请求被中断${hooks.signal && hooks.signal.aborted ? '' : '（超时）'}`, 'timeout')
      }
      return fail(`连不上 ${space.base}：${String((error && error.message) || error)}`, 'network')
    }

    const postText = await posted.text().catch(() => '')
    if (!posted.ok) {
      return fail(httpHint(posted.status, postText), posted.status === 429 ? 'rate' : posted.status === 503 ? 'busy' : 'http', {
        status: posted.status,
      })
    }

    let eventId = ''
    try {
      eventId = String(JSON.parse(postText).event_id || '')
    } catch {
      /* 下面统一报错 */
    }
    if (!eventId) return fail(`没有拿到 event_id（${postText.slice(0, 120)}）`, 'bad_response')

    let stream
    try {
      stream = await fetchImpl(`${base}${prefix}/call/${space.fn}/${eventId}`, {
        headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' },
        signal: gate.signal,
      })
    } catch (error) {
      if (gate.controller.signal.aborted) return fail('等待结果时超时或被打断', 'timeout')
      return fail(`订阅结果失败：${String((error && error.message) || error)}`, 'network')
    }
    if (!stream.ok) {
      return fail(httpHint(stream.status, ''), 'http', { status: stream.status })
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false

    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        cut = buffer.indexOf('\n\n')
        if (!block.trim()) continue

        const lines = block.split('\n')
        const eventName = (lines.find((line) => line.startsWith('event:')) || '').slice(6).trim()
        const dataLine = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
        if (!eventName && !dataLine) continue
        events += 1
        if (hooks.onEvent) hooks.onEvent(eventName, dataLine)

        if (eventName === 'heartbeat' || eventName === 'generating' || eventName === 'complete') {
          let payload
          try {
            payload = JSON.parse(dataLine)
          } catch {
            payload = null
          }
          if (eventName === 'complete') {
            finished = true
            if (payload) {
              const full = space.pick(payload)
              if (full && full !== text) {
                const delta = nextDelta(text, full)
                if (delta) {
                  text = full
                  if (hooks.onDelta) hooks.onDelta(delta, text)
                }
              }
            }
            settled = true
            return { ok: true, text, elapsed: Date.now() - started, events }
          }
          const full = space.pick(payload)
          const delta = nextDelta(text, full)
          if (delta) {
            text = full
            if (hooks.onDelta) hooks.onDelta(delta, text)
          }
          continue
        }

        if (eventName === 'error') {
          let payload = null
          try {
            payload = JSON.parse(dataLine)
          } catch {
            payload = dataLine
          }
          const detail = readErrorEvent(payload)
          return fail(
            detail
              ? `Space 报错：${detail}`
              : 'Space 内部报错，但没给原因（它的后端抛了个空异常）。换一个模型再试',
            'space_error',
          )
        }
      }
      if (finished) break
    }

    settled = true
    if (!text) return fail('Space 什么都没回（连一个字都没有）', 'empty')
    return { ok: true, text, elapsed: Date.now() - started, events }
  } catch (error) {
    if (settled) return { ok: true, text, elapsed: Date.now() - started, events }
    if (gate.controller.signal.aborted) return fail('请求超时或被打断', 'timeout')
    return fail(`运行出错：${String((error && error.message) || error)}`, 'network')
  } finally {
    gate.done()
  }
}

/**
 * 轻量探活：只读 /config，不看模型答得怎么样。
 * 能省下一次真实调用，也能告诉用户"这个 Space 的接口还叫不叫这个名字"。
 */
export async function probeSpace(space, fetchImpl = fetch, options = {}) {
  const base = String(space.base || '').replace(/\/+$/, '')
  const started = Date.now()
  const gate = openController(null, Number(options.timeout) > 0 ? Number(options.timeout) : 12000)
  try {
    const res = await fetchImpl(`${base}/config`, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-grok3ai/probe' },
      signal: gate.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, status: res.status, ms: Date.now() - started, error: httpHint(res.status, text) }
    }
    let config
    try {
      config = JSON.parse(text)
    } catch {
      return { ok: false, status: res.status, ms: Date.now() - started, error: '/config 回的不是 JSON' }
    }
    const deps = Array.isArray(config.dependencies) ? config.dependencies : []
    const hasFn = deps.some((dep) => dep && dep.api_name === space.fn)
    return {
      ok: hasFn,
      status: res.status,
      ms: Date.now() - started,
      version: config.version || '',
      mode: config.mode || '',
      error: hasFn ? '' : `这个 Space 里没有名为 ${space.fn} 的接口（Gradio 版本变了）`,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: gate.controller.signal.aborted ? '探活超时' : String((error && error.message) || error),
    }
  } finally {
    gate.done()
  }
}
