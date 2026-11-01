/**
 * 把 LightVela 网关的模型清单整理成 DSH 模型选择器能吃的形状。
 *
 * 这个网关是 one-api / new-api 那一系的（报错里带 "under group default"），
 * `/v1/models` 返回的就是这把 token 在当前分组里能调的名字。实测只有四条：
 *
 *   auto                     通配符，网关自己挑，实测落到 glm-5.3-flash
 *   deepseek-v4-pro-202606   真实型号，能直接调
 *   ep-hyasr3                自定义端点，当前 "No available channel"
 *   llmgw-mock-chat          自检用的假模型，一调就 404
 *
 * 默认策略：把 mock 藏掉，其余全列出来，把「能不能调」交给探针去说。
 * 不替用户删模型 —— 今天没 channel 不等于明天还没有。
 */

/** 一眼就知道不能用的：自检假模型。 */
const HIDDEN = [/^llmgw-mock/i, /^mock-/i]

/** 把 id 翻成人话。没收录的模型直接用 id，不做花活。 */
const FRIENDLY = [
  [/^auto$/i, () => 'Auto · 网关自动路由'],
  [/^deepseek-v4-pro(\-\d+)?$/i, () => 'DeepSeek V4 Pro'],
  [/^deepseek-v4-flash/i, () => 'DeepSeek V4 Flash'],
  [/^glm-[\d.]+-flash/i, () => 'GLM Flash'],
  [/^glm-/i, () => 'GLM'],
  [/^qwen/i, () => 'Qwen'],
  [/^kimi/i, () => 'Kimi'],
  [/^ep-/i, () => '自定义端点'],
]

function friendlyName(id) {
  for (const [pattern, make] of FRIENDLY) {
    if (pattern.test(id)) return make(id)
  }
  return id
}

export function isHidden(id) {
  return HIDDEN.some((pattern) => pattern.test(String(id || '')))
}

/**
 * 归一化：去重、过滤、排序（auto 放第一，真实型号按字母序，端点垫底）。
 */
export function normalizeModels(rows) {
  const seen = new Set()
  const out = []
  for (const row of rows || []) {
    const id = String((row && row.id) || '').trim()
    if (id === '' || seen.has(id) || isHidden(id)) continue
    seen.add(id)
    out.push({
      id,
      name: friendlyName(id),
      ownedBy: String((row && row.ownedBy) || ''),
      /** 探针结果：true 能出字 / false 打不通 / null 还没测。 */
      usable: null,
      note: '',
    })
  }

  const rank = (item) => {
    if (/^auto$/i.test(item.id)) return 0
    if (/^ep-/i.test(item.id)) return 2
    return 1
  }
  out.sort((a, b) => {
    const diff = rank(a) - rank(b)
    if (diff !== 0) return diff
    return a.id.localeCompare(b.id)
  })
  return out
}

/** 转成 llm-pi-ai 的 provider.models 形状。 */
export function toProviderModels(models) {
  return (models || []).map((item) => ({
    id: item.id,
    name: item.name,
    input: ['text'],
  }))
}
