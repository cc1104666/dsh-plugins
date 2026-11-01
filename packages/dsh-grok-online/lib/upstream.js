/**
 * grok.online 的上游客户端。
 *
 * 站点只有一个接口：POST /api/chat（api/chat.php → llmproxy → OpenRouter）。
 * 它**不是** OpenAI 兼容接口，但很接近：
 *
 *   请求  { model: "grok-4-20", role: "<系统提示，≤2000 字符>", messages: [{role, content}] }
 *   响应  text/event-stream，每条 `data: {...}` 就是一个 OpenAI 风格的 chunk
 *         （choices[0].delta.content），最后有 `data: [DONE]`；
 *         流开头会先来一条 `{"credits":N,"bonus":"locked|available|used"}` 告诉你还剩几条。
 *
 * 另外三个动作挂在同一个路径上：
 *   GET  /api/chat?credits=1   → {"credits":N,"bonus":"..."}  不消耗额度
 *   POST /api/chat?unlock=1    → 领当天额外的 5 条（用完后才 available）
 *
 * 没有任何鉴权：不种 cookie、不要 key，额度按 IP 记，UTC 零点重置。
 */
import { canonicalModel } from './models.js'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 站点自己的上限，超过会被上游截断或报 too_long。 */
const ROLE_CHARS = 2000

function endpoint(config, query = '') {
  const base = String(config.siteBase || 'https://grok.online').replace(/\/$/, '')
  const api = config.apiPath || '/api/chat'
  return `${base}${api}${query}`
}

function headersFor(config, accept) {
  const headers = {
    'content-type': 'application/json',
    accept,
    origin: String(config.siteBase || 'https://grok.online').replace(/\/$/, ''),
    referer: `${String(config.siteBase || 'https://grok.online').replace(/\/$/, '')}/chat`,
    'user-agent': config.userAgent || DEFAULT_UA,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
  if (config.cookie) headers.cookie = config.cookie
  return headers
}

/** 一条消息取纯文本：OpenAI 的 content 可能是字符串，也可能是 [{type:'text',text}]。 */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (!part || typeof part !== 'object') return ''
        if (typeof part.text === 'string') return part.text
        // 图片等非文本片段：站点不支持，用一个占位符代替，避免整段丢失
        if (part.type === 'image_url' || part.type === 'input_image') return '[图片]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * OpenAI 请求 → grok.online 请求。
 *
 * 两个必须做的转换：
 * 1. system 那几条要抽出来塞进 `role` 字段（它没有 system 角色），上限 2000 字符。
 * 2. 上下文要按字符数裁到 contextChars（站点前端自己也是 10000 字符），
 *    但**最后一条用户消息必须保留** —— 否则裁完啥也没了。
 */
export function buildGrokPayload(config, body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : []
  const systemParts = []
  const rest = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const role = String(message.role || 'user')
    const text = contentText(message.content)
    if (role === 'system') {
      if (text) systemParts.push(text)
      continue
    }
    if (role === 'tool') {
      // 工具结果对站点来说是陌生角色，当成 user 喂回去，至少不丢信息
      rest.push({ role: 'user', content: `工具返回：\n${text}` })
      continue
    }
    if (role !== 'user' && role !== 'assistant') continue
    if (!text) continue
    rest.push({ role, content: text })
  }

  const limit = Number(config.contextChars) > 0 ? Number(config.contextChars) : 10000
  const picked = []
  let used = 0
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const item = rest[i]
    const size = item.content.length
    const isLast = i === rest.length - 1
    if (!isLast && used + size > limit) break
    picked.unshift(item)
    used += size
  }
  // 倒数第二条必须和最后一条配对上下文才连贯；如果只剩一条 user，站点会当成新对话，也能用。

  return {
    model: canonicalModel(body && body.model),
    role: systemParts.join('\n\n').slice(0, ROLE_CHARS),
    messages: picked.length > 0 ? picked : [{ role: 'user', content: '' }],
  }
}

/** GET ?credits=1 */
export async function fetchCredits(config, fetchImpl = fetch) {
  const response = await fetchImpl(endpoint(config, '?credits=1'), {
    method: 'GET',
    headers: headersFor(config, 'application/json'),
    cache: 'no-store',
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`查额度失败：HTTP ${response.status} ${text.slice(0, 120)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`额度接口返回的不是 JSON：${text.slice(0, 120)}`)
  }
  return {
    credits: Number.isFinite(Number(parsed.credits)) ? Number(parsed.credits) : null,
    bonus: typeof parsed.bonus === 'string' ? parsed.bonus : '',
  }
}

/** POST ?unlock=1 —— 用完当天 4 条之后可以再领 5 条。 */
export async function unlockBonus(config, fetchImpl = fetch) {
  const response = await fetchImpl(endpoint(config, '?unlock=1'), {
    method: 'POST',
    headers: headersFor(config, 'application/json'),
    body: '{}',
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* 不是 JSON 就走下面的兜底 */
  }
  const credits = parsed && Number.isFinite(Number(parsed.credits)) ? Number(parsed.credits) : null
  if (response.ok) {
    return { ok: true, credits, bonus: (parsed && parsed.bonus) || 'used', code: '' }
  }
  return {
    ok: false,
    credits,
    bonus: (parsed && parsed.bonus) || '',
    code: String((parsed && parsed.error && parsed.error.code) || 'error'),
    message: String((parsed && parsed.error && parsed.error.message) || text.slice(0, 160)),
  }
}

/**
 * 发一轮对话。
 *
 * 不抛异常：所有失败都收成 {ok:false, code, status, message}，
 * 因为反代那边要根据 code 决定回 429 还是 403，直接抛反而不好分类。
 *
 * @param {object} config
 * @param {{model:string, role?:string, messages:Array}} payload
 * @param {{signal?:AbortSignal, onDelta?:(delta:string, full:string)=>void, onReasoning?:(delta:string)=>void, onCredits?:(credits:number,bonus:string)=>void}} [hooks]
 */
export async function chat(config, payload, hooks = {}, fetchImpl = fetch) {
  const started = Date.now()
  const body = JSON.stringify({
    model: payload.model,
    role: String(payload.role || '').slice(0, ROLE_CHARS),
    messages: payload.messages,
  })

  let response
  try {
    response = await fetchImpl(endpoint(config), {
      method: 'POST',
      headers: headersFor(config, 'text/event-stream'),
      body,
      signal: hooks.signal,
    })
  } catch (error) {
    if (hooks.signal && hooks.signal.aborted) {
      return { ok: false, aborted: true, code: 'abort', status: 0, message: '请求被取消', elapsed: Date.now() - started }
    }
    return {
      ok: false,
      code: 'network',
      status: 0,
      message: `连不上 grok.online：${String((error && error.message) || error)}`,
      elapsed: Date.now() - started,
    }
  }

  const contentType = response.headers.get('content-type') || ''
  if (!response.ok || !contentType.includes('event-stream')) {
    const text = await response.text().catch(() => '')
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      /* 不是 JSON */
    }
    const err = parsed && parsed.error
    return {
      ok: false,
      status: response.status,
      code: String((err && err.code) || (response.status === 429 ? 'limit' : 'http')),
      message: String((err && err.message) || text.slice(0, 200) || `HTTP ${response.status}`),
      credits: parsed && Number.isFinite(Number(parsed.credits)) ? Number(parsed.credits) : null,
      bonus: (parsed && parsed.bonus) || '',
      wait: Number(parsed && parsed.wait) || 0,
      elapsed: Date.now() - started,
    }
  }

  if (!response.body) {
    return { ok: false, status: 502, code: 'empty', message: '上游没有返回内容', elapsed: Date.now() - started }
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let reasoning = ''
  let credits = null
  let bonus = ''
  let usage = null
  let finishReason = null
  let streamError = null
  let sawDone = false

  const handleLine = (raw) => {
    const line = raw.replace(/\r$/, '')
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '') return
    if (data === '[DONE]') {
      sawDone = true
      return
    }
    let chunk
    try {
      chunk = JSON.parse(data)
    } catch {
      return
    }
    if (chunk.credits !== undefined && !chunk.choices) {
      credits = Number(chunk.credits)
      bonus = chunk.bonus || ''
      if (hooks.onCredits) hooks.onCredits(credits, bonus)
      return
    }
    if (chunk.error) {
      const err = chunk.error
      streamError = {
        code: String(err.code || 'stream_error'),
        message: String(err.message || '上游在流式过程中报错'),
      }
      return
    }
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices && chunk.choices[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta || {}
    if (typeof delta.reasoning === 'string' && delta.reasoning) {
      reasoning += delta.reasoning
      if (hooks.onReasoning) hooks.onReasoning(delta.reasoning)
    }
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content
      if (hooks.onDelta) hooks.onDelta(delta.content, text)
    }
  }

  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) handleLine(line)
      if (sawDone) break
    }
    if (buffer) handleLine(buffer)
  } catch (error) {
    if (hooks.signal && hooks.signal.aborted) {
      return {
        ok: false,
        aborted: true,
        code: 'abort',
        status: 0,
        message: '请求被取消',
        text,
        reasoning,
        elapsed: Date.now() - started,
      }
    }
    return {
      ok: false,
      code: 'network',
      status: 0,
      message: `读到一半断了：${String((error && error.message) || error)}`,
      text,
      reasoning,
      elapsed: Date.now() - started,
    }
  }

  if (streamError) {
    return {
      ok: false,
      code: streamError.code,
      status: 502,
      message: streamError.message,
      text,
      reasoning,
      credits,
      bonus,
      elapsed: Date.now() - started,
    }
  }

  if (!text.trim() && !reasoning.trim()) {
    return {
      ok: false,
      code: 'empty',
      status: 502,
      message: '模型这次一个字都没吐（上游空响应），重试一次通常就好',
      credits,
      bonus,
      elapsed: Date.now() - started,
    }
  }

  return {
    ok: true,
    status: 200,
    text,
    reasoning,
    credits,
    bonus,
    usage,
    finishReason: finishReason || 'stop',
    elapsed: Date.now() - started,
  }
}

/**
 * 带"额度用完自动领奖励"的一轮对话。
 *
 * 站点把 5 条奖励藏在一个按钮后面（解锁后 bonus 从 locked → available），
 * 网页上是用户自己点；自动领一次不违背它的规则，而且用户少一次手动操作。
 * 只在**明确是 limit 且奖励还 available** 时做一次，不重试第二次。
 */
export async function chatWithBonus(config, payload, hooks = {}, fetchImpl = fetch) {
  const first = await chat(config, payload, hooks, fetchImpl)
  if (
    !first.ok &&
    first.code === 'limit' &&
    first.bonus === 'available' &&
    !(hooks && hooks.noBonus)
  ) {
    const unlocked = await unlockBonus(config, fetchImpl).catch(() => ({ ok: false }))
    if (unlocked && unlocked.ok) {
      if (hooks && hooks.onBonus) hooks.onBonus(unlocked)
      return chat(config, payload, hooks, fetchImpl)
    }
  }
  return first
}

/**
 * 把上游 code 翻成"能照着做"的中文。
 *
 * 这里最容易被误解的是 limit：用户会以为是插件坏了。实际上站点每天只给
 * 4 条 + 5 条奖励（按 IP 记，UTC 零点重置），这是它的商业模式，不是 bug。
 */
export function explainFailure(result) {
  const code = String((result && result.code) || '')
  const raw = String((result && result.message) || '')
  const switches = Number((result && result.switches) || 0)

  if (code === 'limit') {
    if (switches > 0) {
      return [
        `换过 ${switches} 个出口都还是限流。`,
        '说明这一批 IP 都已经用完了（或者代理池里没有能用的出口）。去插件面板 ② 出口池看看每个出口的状态：',
        '「已用完」的今天救不回来，「冷却中」的是网络问题，「不通」的是代理本身坏了。',
        '北京时间早上 8 点（UTC 零点）统一重置。',
      ].join('')
    }
    return [
      'grok.online 今天的免费额度用完了。',
      '它的规则是每个 IP 每天 4 条，用完可以再领 5 条奖励，合计 9 条，UTC 零点（北京时间早上 8 点）重置。',
      result.bonus === 'available'
        ? '现在还能领奖励：打开插件面板点「领取 +5」，或者再发一次（插件会自动领）。'
        : '奖励也领过了。要么等重置，要么在面板 ② 出口池里放几个代理、打开自动换出口 —— 额度是按出口 IP 记的，换 IP 就是新的一份。',
    ].join('')
  }
  if (code === 'no_route') {
    return '出口池开着但一个出口都没排上（池子空或全被禁用）。去面板 ② 出口池加几个代理，或者把自动换出口关掉走直连。'
  }
  if (code === 'model_locked') {
    return 'Grok 4.7 只在它们的 App 里开放，网页 API 一律拒绝（403 model_locked）。选 Grok 4.20 或 Grok 4.3。'
  }
  if (code === 'rate') {
    return `发得太快了，站点有每分钟限速（${raw}）。等一分钟再发。${switches > 0 ? `（已经换过 ${switches} 个出口）` : ''}`
  }
  if (code === 'busy') {
    return `上游模型忙或者网关在抽风（${raw}）。重试一次，或换另一个模型。`
  }
  if (code === 'too_long') {
    return `上下文太长，站点单轮只吃约 1 万字符（${raw}）。插件已经会截断，遇到这条就清一下会话再发。`
  }
  if (code === 'network') {
    return `${raw}。检查网络/代理能不能访问 grok.online。${switches > 0 ? `（已经换过 ${switches} 个出口）` : ''}`
  }
  if (code === 'empty') {
    return raw
  }
  return raw
}
