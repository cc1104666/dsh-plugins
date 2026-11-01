/**
 * 翻译层：OpenAI 的 messages → 一个 Space 能吃的单段提示词。
 *
 * 为什么不做多轮 state：每个 Space 的 state 形状都不一样（minimax 是 state，
 * llama2 是 state+system+5 个滑杆），而且都是"上一次调用的返回值"，反代一旦重启
 * 就接不上。DSH 每一轮本来就会把完整历史发过来，所以干脆**无状态**：把历史压成
 * 一段带角色标记的文本。代价是模型看到的不是原生多轮模板，换来的是：
 *   - 不用维护会话表（重启不断线）
 *   - 换 Space / 换出口都无感
 *   - 历史裁剪只有一处
 */

/** 一条 message 的纯文本（content 可能是字符串，也可能是 [{type:'text',text}] 数组）。 */
export function textOf(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        if (part && part.type === 'image_url') return '[图片]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text
  return String(content)
}

function trimToChars(text, limit) {
  const value = String(text || '')
  const max = Number(limit) > 0 ? Number(limit) : 24000
  if (value.length <= max) return value
  return value.slice(value.length - max)
}

/**
 * @param {Array} messages OpenAI messages
 * @param {{contextChars?:number}} options
 */
export function buildPrompt(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : []
  const systems = []
  const turns = []

  for (const message of list) {
    if (!message) continue
    const role = String(message.role || 'user')
    const text = textOf(message.content).trim()
    if (!text) continue
    if (role === 'system') {
      systems.push(text)
      continue
    }
    turns.push({ role, text })
  }

  const systemBlock = systems.length ? `以下是系统设定，请始终遵守：\n${systems.join('\n\n')}` : ''

  // 只有一条用户消息：原样发，别加角色前缀（对 chat 微调过的模型更自然）
  if (turns.length === 1 && turns[0].role === 'user' && !systemBlock) {
    return trimToChars(turns[0].text, options.contextChars)
  }

  const lines = []
  for (const turn of turns) {
    if (turn.role === 'assistant') lines.push(`助手：${turn.text}`)
    else if (turn.role === 'tool' || turn.role === 'function') lines.push(`工具结果：${turn.text}`)
    else lines.push(`用户：${turn.text}`)
  }

  // 最后一条是助手的话，就让它接着往下写；否则留一个"助手："的引子
  const tail = turns.length && turns[turns.length - 1].role === 'assistant' ? '' : '助手：'
  const body = [systemBlock, lines.join('\n\n'), tail].filter(Boolean).join('\n\n')
  return trimToChars(body, options.contextChars)
}

/** OpenAI 请求里的采样参数 → Space 的入参（各自的区间在 spaces.js 里夹）。 */
export function buildOptions(config, body) {
  const source = body || {}
  const pick = (value, fallback) => (value === null || value === undefined || value === '' ? fallback : Number(value))
  return {
    maxTokens: pick(source.max_tokens, Number(config && config.maxTokens) || 4096),
    temperature: pick(source.temperature, Number(config && config.temperature)),
    topP: pick(source.top_p, Number(config && config.topP)),
  }
}

/** 粗略 token 估算（中英混排按 2.5 字符/token 算），只用于 usage 字段。 */
export function estimateTokens(text) {
  const length = String(text || '').length
  return Math.max(1, Math.round(length / 2.5))
}

/**
 * 把失败翻成"能照着做"的中文。
 *
 * 这里最容易被误解的两件事：
 *   1. 一次冷启动要十几秒 —— 不是插件坏了，Space 睡醒了就好；
 *   2. Space 报错但 message 是 null —— 是它自己后端的锅（比如上游 key 失效），
 *      换模型才是正解，不是重试能解决的。
 */
export function explainFailure(result) {
  const code = String((result && result.code) || '')
  const raw = String((result && result.message) || '')
  const switches = Number((result && result.switches) || 0)
  const tried = switches > 0 ? `（已经换过 ${switches} 个入口）` : ''

  if (code === 'busy') {
    return `Space 在睡觉或者在冷启动${tried}。等十几秒再发一次；实在不行去 huggingface.co 上点一下那个 Space，让它醒过来。`
  }
  if (code === 'timeout') {
    return `等结果超时了${tried}。这类 Space 是排队跑的，前面有人在用就会很慢；换个模型，或者把问题说短一点。`
  }
  if (code === 'rate') {
    return `HuggingFace 对匿名访问按 IP 限流，现在被拦了${tried}。等一会儿，或者打开出口池换个 IP。`
  }
  if (code === 'space_error') {
    return raw || 'Space 内部报错，但没给出原因。换一个模型再试。'
  }
  if (code === 'empty') {
    return `Space 一个字都没回${tried}。有时候是它刚好在重启，再发一次。`
  }
  if (code === 'network') {
    return `${raw || '连不上'}。检查网络能不能访问 *.hf.space；如果开了出口池，可能是出口坏了。`
  }
  if (code === 'http') {
    return raw || 'Space 回了 HTTP 错误。'
  }
  return raw || code || '未知错误'
}
