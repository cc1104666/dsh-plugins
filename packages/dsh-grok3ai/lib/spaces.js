/**
 * Site registry: what grok3ai.org actually runs.
 *
 * IMPORTANT (this is the whole point of this file):
 *   www.grok3ai.org has **no model of its own**. Every /xx/chat page is an SEO shell
 *   that drops an <iframe> onto a HuggingFace Space; the JS assigns the URL six times
 *   and only the last one wins, so what a visitor actually talks to is
 *   `minimaxai-minimax-vl-01.hf.space` (MiniMax's Hailuo AI), not Grok.
 *
 *   So the honest way to "bring this site's capability into DSH" is to talk to those
 *   Spaces directly. Each Space is a Gradio app; we call its named endpoint.
 *
 * Each entry needs three things:
 *   build(prompt, opts) -> the `data` array Gradio expects
 *   pick(payload)       -> how to get the assistant text out of the output array
 *   fn                  -> the api_name of the chat endpoint (must exist in /config)
 *
 * Shapes were read off each Space's /config (see README for the full table).
 */

/** Text of a Gradio output slot, whatever shape it came in. */
function asText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return asText(value[0])
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.value === 'string') return value.value
    if (typeof value.content === 'string') return value.content
  }
  return String(value)
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export const SPACES = [
  {
    id: 'minimax-vl-01',
    name: 'MiniMax-VL-01',
    vendor: 'MiniMax（海螺 AI）',
    base: 'https://minimaxai-minimax-vl-01.hf.space',
    fn: 'chat',
    gradio: '5.0.1',
    note: 'grok3ai.org 的聊天页现在嵌的就是这个 Space（页面里 aiUrl 最后一行）',
    /**
     * inputs = [multimodaltextbox, state, tokens, temperature, top_p]
     * 输入框是 multimodaltextbox，值必须是 {text, files} 对象，直接传字符串会让
     * 后端抛一个 message 为 null 的 error 事件（踩过）。
     */
    build(prompt, opts) {
      return [{ text: prompt, files: [] }, [], clamp(opts.maxTokens, 64, 32000, 12800), clamp(opts.temperature, 0, 2, 0.3), clamp(opts.topP, 0.05, 1, 0.9)]
    },
    pick(payload) {
      return asText(payload && payload[0])
    },
  },
  {
    id: 'llama-2-7b',
    name: 'Llama-2-7B-Chat',
    vendor: 'Meta / HuggingFace Projects',
    base: 'https://huggingface-projects-llama-2-7b-chat.hf.space',
    fn: 'generate',
    gradio: '6.19.0',
    note: '同一份 aiUrl 清单里的老模型，还在跑；中文很差，只当兜底',
    /**
     * inputs = [textbox, state, system, max_new_tokens, temperature, top_p, top_k, repetition]
     * 输出是 [Response(json), state]，实际回的是纯字符串。
     */
    build(prompt, opts) {
      return [prompt, [], '', clamp(opts.maxTokens, 16, 2048, 1024), clamp(opts.temperature, 0.01, 2, 0.6), clamp(opts.topP, 0.05, 1, 0.9), 40, 1.2]
    },
    pick(payload) {
      return asText(payload && payload[0])
    },
  },
]

/** 站点清单里另外三个，实测已经死了 —— 只用来在面板上解释"为什么只有两个能用"。 */
export const DEAD_SPACES = [
  { id: 'qwen3-30b', name: 'Qwen3-30B-A3B', base: 'https://openfree-qwen3-30b-a3b-research.hf.space', reason: '上游 Fireworks 的 key 失效，接口回 412' },
  { id: 'qwen2-5-max', name: 'Qwen2.5-Max', base: 'https://qwen-qwen2-5-max-demo.hf.space', reason: 'Space 已删（404）' },
  { id: 'qwq-32b', name: 'QwQ-32B', base: 'https://qwen-qwq-32b-demo.hf.space', reason: 'Space 在睡且叫不醒（503）' },
]

export const DEFAULT_SPACE = SPACES[0].id

export function findSpace(id) {
  const key = String(id || '').trim()
  return SPACES.find((space) => space.id === key) || SPACES.find((space) => space.name.toLowerCase() === key.toLowerCase()) || null
}

/** 宽容匹配：DSH 里可能叫 minimax-vl-01 / MiniMax-VL-01 / minimaxvl01。 */
export function resolveSpace(id) {
  if (!id) return null
  const direct = findSpace(id)
  if (direct) return direct
  const norm = String(id).toLowerCase().replace(/[^a-z0-9]/g, '')
  return SPACES.find((space) => space.id.replace(/[^a-z0-9]/g, '') === norm || space.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm) || null
}

/** 注册进 DSH 时用的模型清单。 */
export function toProviderModels(spaces) {
  const list = Array.isArray(spaces) && spaces.length > 0 ? spaces : SPACES
  return list.map((space) => ({
    id: space.id,
    name: space.name,
    input: ['text'],
  }))
}
