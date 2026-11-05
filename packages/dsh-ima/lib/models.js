/**
 * 把 ima 的模型清单整理成 DSH 模型选择器能吃的形状。
 *
 * ima 免登录模型清单（/cgi-bin/intelligent_assistant_http_nl/get_models）实测四条：
 *   official_0  Tencent HY 2.0        （model_type 0）
 *   official_1  DeepSeek V3.2 Think   （model_type 1，推理）
 *   official_2  Tencent HY 2.0 Think  （model_type 2，推理）
 *   official_3  DeepSeek V3.2         （model_type 3，默认）
 *
 * 注意 ima 的「模型」是 model_id + model_type 二元组：QA 请求里两个都要带。
 * 排序：默认模型放第一，其余保持官方顺序。
 */

export function normalizeModels(rows) {
  const seen = new Set()
  const out = []
  for (const row of rows || []) {
    const id = String((row && row.id) || '').trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String((row && row.name) || id),
      shortName: String((row && row.shortName) || ''),
      describe: String((row && row.describe) || ''),
      modelType: Number((row && row.modelType) || 0),
      isDefault: Boolean(row && row.isDefault),
      enableEnhancement: Boolean(row && row.enableEnhancement),
      /** 探针结果：true 能出字 / false 打不通 / null 还没测。 */
      usable: null,
      note: '',
    })
  }

  out.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.id.localeCompare(b.id)
  })
  return out
}

/** 转 llm-pi-ai 的 provider.models 形状。 */
export function toProviderModels(models) {
  return (models || []).map((item) => ({
    id: item.id,
    name: item.name,
    input: ['text'],
  }))
}

/** 从 DSH 那边选中的模型 id 找回完整条目（modelType 要跟着进 QA 请求）。 */
export function findModel(models, id) {
  const list = models || []
  return list.find((item) => item.id === id) || list.find((item) => item.isDefault) || list[0] || null
}
