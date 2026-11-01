/**
 * 出口池：一组代理 + 每个出口当天的额度账本 + 排序策略。
 *
 * 这个文件只做纯计算（不碰网络、不碰磁盘），这样排序和记账这两件最容易出错的事
 * 能在冒烟测试里被直接断言。
 *
 * 两种代理必须分开对待：
 *   静态代理（默认）    一个地址固定一个出口 IP；用完 9 条就真的没了，只能换下一个。
 *   动态/隧道代理       一个地址背后是一池 IP，**每次连接换一个出口**；
 *                       所以对它来说"额度用完"不是终点，重开一次连接就是新 IP。
 *                       行尾加 `#rotating`（或 `#动态`）标记它。
 *
 * 账本按 UTC 日和出口 id 记，跨天自动清空 —— 和站点的重置规则对齐。
 */
import { createHash } from 'node:crypto'
import { parseProxy, maskProxy } from './proxy-agent.js'

/** 站点每天每个出口的额度（4 免费 + 5 奖励）。 */
export const PER_EXIT_CREDITS = 9

export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

/** 把一行里的 `#rotating` / `#动态` 之类标记摘出来。 */
function splitMode(line) {
  const text = String(line || '')
  const match = /(?:^|\s)[#＃](rotating|dynamic|动态|隧道)\s*$/i.exec(text)
  if (!match) return { url: text.trim(), mode: 'sticky' }
  return { url: text.slice(0, match.index).trim(), mode: 'rotating' }
}

function idOf(parsed, mode) {
  const seed = `${parsed.protocol}://${parsed.host}:${parsed.port}|${parsed.auth ? parsed.auth.user : ''}|${mode}`
  return createHash('sha1').update(seed).digest('hex').slice(0, 10)
}

/**
 * 解析面板里粘进来的整段文本（每行一个）。
 * 坏行不抛错，收集到 errors 里 —— 用户一次粘 20 行，不该因为一行写错就全丢。
 */
export function parsePoolText(text) {
  const entries = []
  const errors = []
  const seen = new Set()
  const lines = String(text || '').split(/\r?\n/)
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) return
    const { url, mode: marked } = splitMode(trimmed)
    try {
      const parsed = parseProxy(url)
      // 账号里带 `{session}`：插件自己会换会话，等于每次连接一个新 IP。
      // 这类出口不用用户再记一个 `#rotating`，直接按动态处理。
      const mode = parsed.template ? 'rotating' : marked
      const id = idOf(parsed, mode)
      if (seen.has(id)) return
      seen.add(id)
      entries.push({
        id,
        mode,
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port,
        auth: Boolean(parsed.auth),
        // 账号自带 `{session}`：不用等站点限流，每发请求本来就是新 IP
        template: Boolean(parsed.template),
        label: parsed.label,
        masked: maskProxy(parsed),
        // 存回 config.json 用的规范写法
        spec: mode === 'rotating' ? `${url} #rotating` : url,
        proxy: parsed,
        line: index + 1,
      })
    } catch (error) {
      errors.push({ line: index + 1, text: trimmed, message: String((error && error.message) || error) })
    }
  })
  return { entries, errors }
}

/** config.proxyPool（字符串数组）→ 可直接用的条目（含解析后的代理对象）。 */
export function resolvePool(pool) {
  const list = Array.isArray(pool) ? pool.join('\n') : String(pool || '')
  return parsePoolText(list).entries
}

/** 把 spec 数组规范化（去掉坏行和重复行）。 */
export function normalizePoolText(text) {
  const { entries } = parsePoolText(text)
  return entries.map((entry) => entry.spec)
}

/** 面板里编辑用的原文。 */
export function poolText(pool) {
  return (Array.isArray(pool) ? pool : []).join('\n')
}

// ------------------------------------------------------------------ 账本

/** state.json 里存 `proxyLedger: { day, entries: { [id]: stats } }`。 */
export function emptyLedger(day = utcDay()) {
  return { day, entries: {} }
}

export function freshLedger(saved, day = utcDay()) {
  if (!saved || typeof saved !== 'object') return emptyLedger(day)
  if (saved.day !== day || !saved.entries || typeof saved.entries !== 'object') return emptyLedger(day)
  return { day, entries: { ...saved.entries } }
}

export function ledgerStats(ledger, id) {
  if (!ledger || !ledger.entries) return null
  const stats = ledger.entries[id]
  return stats && typeof stats === 'object' ? stats : null
}

function put(ledger, id, patch) {
  const current = ledgerStats(ledger, id) || {}
  ledger.entries[id] = { ...current, ...patch, at: Date.now() }
  return ledger.entries[id]
}

/** 记一次真实请求的结果。 */
export function markResult(ledger, entry, result, now = Date.now()) {
  const code = String((result && result.code) || '')
  const credits = result && result.credits !== null && result.credits !== undefined ? Number(result.credits) : null
  const bonus = (result && result.bonus) || ''

  if (result && result.ok) {
    return put(ledger, entry.id, {
      credits: credits === null ? ledgerStats(ledger, entry.id)?.credits ?? null : credits,
      bonus,
      ok: true,
      used: (ledgerStats(ledger, entry.id)?.used || 0) + 1,
      lastError: '',
      fails: 0,
      cooldownUntil: 0,
    })
  }
  if (result && result.aborted) return ledgerStats(ledger, entry.id)

  if (code === 'limit') {
    // 动态代理的"用完"是假用完：重开连接就是新 IP，别给它扣死。
    if (entry.mode === 'rotating') {
      return put(ledger, entry.id, {
        credits,
        bonus,
        ok: false,
        used: (ledgerStats(ledger, entry.id)?.used || 0) + 1,
        lastError: '这一发撞到已用尽的出口（动态代理重打通常会换 IP）',
        fails: (ledgerStats(ledger, entry.id)?.fails || 0) + 1,
        cooldownUntil: 0,
      })
    }
    return put(ledger, entry.id, {
      credits: credits === null ? 0 : credits,
      bonus,
      ok: false,
      used: (ledgerStats(ledger, entry.id)?.used || 0) + 1,
      exhaustedAt: now,
      lastError: '今天的额度用完了',
      fails: 0,
      cooldownUntil: 0,
    })
  }
  if (code === 'network' || code === 'rate' || code === 'busy') {
    const fails = (ledgerStats(ledger, entry.id)?.fails || 0) + 1
    const backoff = Math.min(120000, 8000 * fails)
    return put(ledger, entry.id, {
      ok: false,
      fails,
      lastError: String((result && result.message) || code),
      cooldownUntil: now + backoff,
    })
  }
  return put(ledger, entry.id, {
    ok: false,
    lastError: String((result && result.message) || code || '出错'),
    fails: (ledgerStats(ledger, entry.id)?.fails || 0) + 1,
  })
}

/** 记一次探测（?credits=1，不消耗额度）。 */
export function markProbe(ledger, entry, probe, now = Date.now()) {
  const patch = {
    credits: probe.credits === null || probe.credits === undefined ? null : Number(probe.credits),
    bonus: probe.bonus || '',
    ip: probe.ip || ledgerStats(ledger, entry.id)?.ip || '',
    ms: Number(probe.ms) || 0,
    probedAt: now,
  }
  if (probe.error) {
    patch.lastError = probe.error
    patch.cooldownUntil = now + 60000
  } else {
    patch.lastError = ''
    patch.cooldownUntil = 0
  }
  return put(ledger, entry.id, patch)
}

// ------------------------------------------------------------------ 排序

const GROUP_LABEL = ['ready', 'fresh', 'cooling', 'empty']

/**
 * 决定这一轮按什么顺序试出口。
 *
 *   0 ready    今天已知还有额度（多的排前面，越久没用的排前面）
 *   0 rotating 动态代理：额度对它没有意义（每次连接换 IP），始终排最前
 *   1 fresh    今天还没探测过的（未知 = 值得一试）
 *   2 cooling  刚网络失败过（冷却没到就别浪费一次请求）
 *   3 empty    今天已经确认用完了（真没招了才回头试）
 */
export function rankEntries(entries, ledger, now = Date.now()) {
  const scored = entries.map((entry) => {
    const stats = ledgerStats(ledger, entry.id) || {}
    const cooling = Number(stats.cooldownUntil || 0) > now
    const credits = stats.credits === null || stats.credits === undefined ? null : Number(stats.credits)
    let group = 1
    let state = 'fresh'
    if (cooling) {
      group = 2
      state = 'cooling'
    } else if (entry.mode === 'rotating') {
      // 动态代理不会"用完"：它这一发跑的是哪个出口，插件根本不知道
      group = credits !== null && credits > 0 ? 0 : 1
      state = 'rotating'
    } else if (credits !== null && credits > 0) {
      group = 0
      state = 'ready'
    } else if (credits !== null && credits <= 0) {
      group = 3
      state = 'empty'
    }
    return {
      entry,
      group,
      state,
      credits,
      bonus: stats.bonus || '',
      cooling,
      used: Number(stats.used || 0) || 0,
      lastUsedAt: Number(stats.at || 0) || 0,
      stats,
    }
  })

  scored.sort((a, b) => {
    if (a.group !== b.group) return a.group - b.group
    if (a.group === 0) {
      const diff = (b.credits || 0) - (a.credits || 0)
      if (diff !== 0) return diff
    }
    if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt
    return a.entry.id.localeCompare(b.entry.id)
  })
  return scored
}

export function stateLabel(state) {
  if (state === 'ready') return '可用'
  if (state === 'rotating') return '动态'
  if (state === 'fresh') return '未探测'
  if (state === 'cooling') return '冷却中'
  if (state === 'empty') return '已用完'
  return state
}

/** 面板头部的汇总：还有几条、几个出口能用。 */
export function summarize(entries, ledger, now = Date.now()) {
  const rows = rankEntries(entries, ledger, now)
  let known = 0
  let total = 0
  let ready = 0
  let empty = 0
  let fresh = 0
  let cooling = 0
  for (const row of rows) {
    if (row.credits !== null && row.credits !== undefined) {
      known += 1
      total += Math.max(0, row.credits)
    }
    if (row.state === 'ready' || row.state === 'rotating') ready += 1
    else if (row.state === 'empty') empty += 1
    else if (row.state === 'fresh') fresh += 1
    else if (row.state === 'cooling') cooling += 1
  }
  return {
    count: rows.length,
    known,
    totalCredits: total,
    ready,
    empty,
    fresh,
    cooling,
    rotating: rows.filter((row) => row.entry.mode === 'rotating').length,
    rows,
  }
}

export { GROUP_LABEL }
