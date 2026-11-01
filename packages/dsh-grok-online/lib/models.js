/**
 * grok.online 的模型清单。
 *
 * 站点自己的前端（assets/chat/core.js）里写死了三个 key，对应 api/_bootstrap.php 的 CG_MODELS：
 *
 *   grok-4-20  Grok 4.20          ← 快，实测走 x-ai/grok-4.20
 *   grok-4-3   Grok 4.3 Thinking  ← 带 reasoning，实测走 x-ai/grok-4.3
 *   grok-4-7   Grok 4.7           ← locked：菜单里有，但 API 一律 403 model_locked
 *
 * 第三个不能放进模型选择器 —— 放进去只会让人选中后报错，所以这里单独列成 LOCKED。
 *
 * 站点后面接的是 OpenRouter（响应里带 provider:"xAI"、gen- 开头的 id、
 * 甚至 "OPENROUTER PROCESSING" 这种注释行），所以同一个模型可能有多种写法
 * （x-ai/grok-4.20、grok-4.20、Grok 4.20），canonicalModel 统一收成上游 key。
 */

export const MODELS = [
  {
    id: 'grok-4-20',
    name: 'Grok 4.20',
    mono: 'grok-4.20',
    upstream: 'grok-4-20',
    note: '快，日常对话',
    input: ['text'],
  },
  {
    id: 'grok-4-3',
    name: 'Grok 4.3 Thinking',
    mono: 'grok-4.3',
    upstream: 'grok-4-3',
    note: '带推理，慢一点',
    input: ['text'],
  },
]

/** 菜单里有但网页 API 明确拒绝的模型，只用于面板上说明。 */
export const LOCKED_MODELS = [
  {
    id: 'grok-4-7',
    name: 'Grok 4.7',
    mono: 'grok-4.7',
    reason: '网页版锁住了（API 返回 403 model_locked），只在它们的 App 里开放',
  },
]

export const DEFAULT_MODEL = 'grok-4-20'

const BY_KEY = new Map()
for (const item of [...MODELS, ...LOCKED_MODELS]) {
  BY_KEY.set(item.id, item)
  BY_KEY.set(item.mono, item)
}

/**
 * 把各种写法收成上游 key：x-ai/grok-4.20 → grok-4-20，Grok 4.3 → grok-4-3。
 * 认不出来就返回默认模型（DSH 传什么进来都别直接 500）。
 */
export function canonicalModel(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return DEFAULT_MODEL
  const lower = raw.toLowerCase()
  if (BY_KEY.has(lower)) return BY_KEY.get(lower).id
  const normalized = lower.replace(/^x-ai\//, '').replace(/[\s_.]+/g, '-')
  if (BY_KEY.has(normalized)) return BY_KEY.get(normalized).id
  const hit = MODELS.find((item) => normalized.includes(item.id) || item.id.includes(normalized))
  return hit ? hit.id : DEFAULT_MODEL
}

/** 这个 key 是不是网页 API 明确拒绝的那个。 */
export function isLockedModel(value) {
  const id = canonicalModel(value)
  return LOCKED_MODELS.some((item) => item.id === id)
}

/** 转成 llm-pi-ai 要的模型条目形状。 */
export function toProviderModels(models = MODELS) {
  return models.map((item) => ({
    id: item.id,
    name: item.name,
    input: item.input || ['text'],
  }))
}
