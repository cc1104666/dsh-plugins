/**
 * 插件自己的持久化层。
 *
 * 位置：<home>/.dsh/plugin-data/dsh-lightvela/
 *   config.json   运行期配置（面板"设置"页写入）
 *   auth.json     登录态 + 从实例里拉回来的模型钥匙
 *   models.json   上次读到的模型清单（离线也能让选择器有东西可选）
 *
 * 全部写盘走 tmp + rename，避免进程被 kill 时留下半截 JSON。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const DEFAULT_CONFIG = {
  /** 业务/鉴权接口。网页登录、实例列表、沙箱 exec 都在这下面。 */
  apiBase: 'https://api.lightvela.com',
  /** 站点本体，拼 Referer / Origin 用。 */
  siteBase: 'https://lightvela.com',
  /**
   * 模型网关。这个值是可以从实例里读到的（config.yaml 的 model.base_url），
   * 这里写一份默认值，是为了在"还没登录"时也能把界面说清楚。
   */
  gatewayBase: 'https://token.lightvela.com/v1',
  /** OAuth 回调后站点把我们送去哪。用登录页就行，我们只关心 Set-Cookie。 */
  returnTo: 'https://lightvela.com/auth/sign-in',
  /** 面板上「去登录」按钮打开的地址。 */
  loginUrl: 'https://lightvela.com/auth/sign-in',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  /** 注册进 DSH 模型选择器的 provider id。 */
  providerId: 'lightvela',
  /** 注册进选择器的显示名。 */
  providerName: 'LightVela',
  /**
   * 邀请码。留空 = 不带归因，纯裸登录。
   *
   * 站点是「邀请返利」制：新账号在微信授权回调那一刻若带着 lc_referral_context
   * cookie，就记到邀请人名下。插件在回调前会自己种这个 cookie，所以填上这里，
   * 经由插件扫码建号的新用户就会算成你的邀请。
   *
   * 想换成自己的码（或想彻底关掉），改 config.json 里的这个字段即可；
   * 改成空串 = 关闭。
   */
  referralCode: 'JAKDMLAGJR',
  /**
   * 多账号时本机转发器监听的首位端口。被占就顺延，最后才随机。
   * 只监听 127.0.0.1 —— 它不是给外面用的，是给 DSH 自己用的。
   */
  relayPort: 43720,
  /** 留空用默认目录。 */
  dataDir: '',
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mergeConfig(...layers) {
  const out = {}
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue
      out[key] = value
    }
  }
  return out
}

export function defaultDataDir() {
  return path.join(os.homedir(), '.dsh', 'plugin-data', 'dsh-lightvela')
}

export function createStore(initialConfig = {}) {
  const patchRaw = isPlainObject(initialConfig) ? { ...initialConfig } : {}
  delete patchRaw.dataDir
  const dir = initialConfig.dataDir || defaultDataDir()
  const configPath = path.join(dir, 'config.json')
  const authPath = path.join(dir, 'auth.json')
  const modelsPath = path.join(dir, 'models.json')

  const ensure = () => {
    fs.mkdirSync(dir, { recursive: true })
  }

  const readJSON = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  }

  const writeJSON = (file, value, mode) => {
    ensure()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    if (mode !== undefined) {
      try {
        fs.chmodSync(tmp, mode)
      } catch {
        /* Windows 上 chmod 基本无效，忽略 */
      }
    }
    fs.renameSync(tmp, file)
  }

  ensure()

  let runtimeConfig = readJSON(configPath, {})
  if (!isPlainObject(runtimeConfig)) runtimeConfig = {}

  /* ---------------------------------------------------------------- 账号池
   *
   * auth.json 从 v1（单个账号平铺）升到 v2（账号数组 + activeId）。
   * v1 读进来会自动迁移，老用户不用重新扫码。
   *
   * 一个「账号」= 一把 sessionToken + 一把从它实例里挖出来的模型钥匙。
   * LightVela 的额度是按账号算的，所以「切换账号」等价于「换钥匙」。
   */

  const emptyAccount = () => ({
    id: '',
    /** 用户可改的备注名，空着就显示微信昵称。 */
    label: '',
    sessionToken: '',
    user: null,
    apiKey: '',
    gatewayBase: '',
    instanceId: '',
    instanceName: '',
    keyPulledAt: null,
    source: '',
    savedAt: null,
    /** ok / exhausted（没额度）/ error（钥匙坏了、要重新登录）。 */
    quotaStatus: 'ok',
    quotaNote: '',
    exhaustedAt: 0,
    lastOkAt: 0,
  })

  /** 账号 id：优先用户 id，退化到 token 摘要。要稳定，重复扫码才能落到同一条。 */
  const accountId = (user, sessionToken, apiKey) => {
    const uid = user && typeof user.id === 'string' ? user.id.trim() : ''
    if (uid !== '') return uid
    const seed = String(sessionToken || apiKey || '')
    if (seed === '') return ''
    return `acc-${createHash('sha1').update(seed).digest('hex').slice(0, 10)}`
  }

  const normalizeAccount = (raw) => {
    const base = emptyAccount()
    if (!isPlainObject(raw)) return base
    const merged = { ...base, ...raw }
    merged.id = String(merged.id || accountId(merged.user, merged.sessionToken, merged.apiKey) || '')
    merged.label = typeof merged.label === 'string' ? merged.label : ''
    merged.sessionToken = typeof merged.sessionToken === 'string' ? merged.sessionToken : ''
    merged.apiKey = typeof merged.apiKey === 'string' ? merged.apiKey : ''
    merged.gatewayBase = typeof merged.gatewayBase === 'string' ? merged.gatewayBase : ''
    merged.quotaNote = typeof merged.quotaNote === 'string' ? merged.quotaNote : ''
    if (!['ok', 'exhausted', 'error'].includes(merged.quotaStatus)) merged.quotaStatus = 'ok'
    for (const key of ['exhaustedAt', 'lastOkAt']) {
      if (typeof merged[key] !== 'number' || !Number.isFinite(merged[key])) merged[key] = 0
    }
    return merged
  }

  const readPool = () => {
    const value = readJSON(authPath, null)
    if (!isPlainObject(value)) return { version: 2, activeId: '', accounts: [] }

    // v1：{sessionToken, apiKey, user, ...} 平铺 —— 迁移成一个账号。
    if (!Array.isArray(value.accounts)) {
      const migrated = normalizeAccount(value)
      return { version: 2, activeId: migrated.id, accounts: migrated.id === '' ? [] : [migrated] }
    }

    const accounts = value.accounts.map(normalizeAccount).filter((item) => item.id !== '')
    const activeId = accounts.some((item) => item.id === value.activeId)
      ? value.activeId
      : accounts[0]
        ? accounts[0].id
        : ''
    return { version: 2, activeId, accounts }
  }

  const writePool = (pool) => {
    const accounts = (pool.accounts || []).filter((item) => item && item.id)
    const activeId = accounts.some((item) => item.id === pool.activeId)
      ? pool.activeId
      : accounts[0]
        ? accounts[0].id
        : ''
    writeJSON(authPath, { version: 2, activeId, accounts, savedAt: new Date().toISOString() }, 0o600)
    return { version: 2, activeId, accounts }
  }

  const publish = (pool) => ({
    version: 2,
    activeId: pool.activeId,
    accounts: pool.accounts,
  })

  const store = {
    dir,

    config() {
      return mergeConfig(DEFAULT_CONFIG, patchRaw, runtimeConfig)
    },

    patchConfig(patch) {
      if (!isPlainObject(patch)) return store.config()
      runtimeConfig = mergeConfig(runtimeConfig, patch)
      writeJSON(configPath, runtimeConfig)
      return store.config()
    },

    /* ------------------------------------------------------------ 账号池 */

    /** 整个池子（只读快照）。 */
    pool() {
      return publish(readPool())
    },

    /** 当前账号（扁平）。老代码全走这个，语义和单账号时代一致。 */
    auth() {
      const pool = readPool()
      const hit = pool.accounts.find((item) => item.id === pool.activeId)
      if (!hit) return null
      if (hit.sessionToken === '' && hit.apiKey === '') return null
      return hit
    },

    /**
     * 转发器要用的候选顺序：当前账号优先，其次正常账号，最后才是标记没额度的。
     * 全都没额度时也把 exhausted 的排进来 —— 宁可打一次 402，也别直接拒绝请求。
     */
    candidates() {
      const pool = readPool()
      const rank = (item) => {
        // 没额度的永远垫底 —— 哪怕它是「当前账号」。当前账号没额度时，
        // 转发器会直接把当前账号换成下一个能用的。
        if (item.quotaStatus === 'exhausted') return 2
        return item.id === pool.activeId ? 0 : 1
      }
      return pool.accounts
        .filter((item) => item.apiKey !== '')
        .slice()
        .sort((a, b) => rank(a) - rank(b) || (b.lastOkAt || 0) - (a.lastOkAt || 0))
    },

    /** 扫码拿到新账号：同一个 user.id 就更新，不同就追加，并设为当前。 */
    addAccount({ sessionToken, user, source }) {
      const pool = readPool()
      const id = accountId(user, sessionToken, '')
      if (id === '') return null
      const before = pool.accounts.find((item) => item.id === id) || emptyAccount()
      const merged = normalizeAccount({
        ...before,
        id,
        sessionToken: sessionToken || before.sessionToken,
        user: user || before.user,
        source: source || before.source,
        savedAt: new Date().toISOString(),
        // 重新登录过的账号，额度状态重新算 —— 用户可能刚充过钱。
        quotaStatus: 'ok',
        quotaNote: '',
        exhaustedAt: 0,
      })
      pool.accounts = [...pool.accounts.filter((item) => item.id !== id), merged]
      pool.activeId = id
      writePool(pool)
      return merged
    },

    /**
     * 老接口。带 user 的调用当成「登录了一个账号」，其余当成「改当前账号」。
     * 这样 index.js 里那些 patchAuth({apiKey: ...}) 不用改。
     */
    patchAuth(patch) {
      if (!isPlainObject(patch)) return store.auth()
      if (patch.user) return store.addAccount(patch)
      const pool = readPool()
      const hit = pool.accounts.find((item) => item.id === pool.activeId)
      if (hit) return store.patchAccount(hit.id, patch)

      // 池子里还没有账号，但手里先有一把钥匙（手贴 / 老数据）——
      // 给它造一条记录，别让这把钥匙无处安放。
      if (!patch.apiKey && !patch.sessionToken) return null
      const id = accountId(null, patch.sessionToken, patch.apiKey)
      if (id === '') return null
      const created = normalizeAccount({ ...patch, id, savedAt: new Date().toISOString() })
      writePool({ activeId: id, accounts: [...pool.accounts, created] })
      return created
    },

    patchAccount(id, patch) {
      const pool = readPool()
      const index = pool.accounts.findIndex((item) => item.id === id)
      if (index < 0) return null
      const merged = normalizeAccount({ ...pool.accounts[index], ...patch, id })
      pool.accounts[index] = merged
      writePool(pool)
      return merged
    },

    setActive(id) {
      const pool = readPool()
      if (!pool.accounts.some((item) => item.id === id)) return null
      pool.activeId = id
      writePool(pool)
      return store.auth()
    },

    removeAccount(id) {
      const pool = readPool()
      const next = pool.accounts.filter((item) => item.id !== id)
      if (next.length === pool.accounts.length) return store.pool()
      writePool({ accounts: next, activeId: pool.activeId === id ? '' : pool.activeId })
      return store.pool()
    },

    /** 清掉「没额度」标记：用户充钱了、或者你只是想再给它一次机会。 */
    clearQuota(id) {
      const pool = readPool()
      const targets = id ? pool.accounts.filter((item) => item.id === id) : pool.accounts
      if (targets.length === 0) return store.pool()
      for (const item of targets) {
        item.quotaStatus = 'ok'
        item.quotaNote = ''
        item.exhaustedAt = 0
      }
      writePool(pool)
      return store.pool()
    },

    /** 标记没额度 / 钥匙坏了。转发器撞到 402 或 401 时调。 */
    markQuota(id, status, note) {
      const pool = readPool()
      const hit = pool.accounts.find((item) => item.id === id)
      if (!hit) return null
      hit.quotaStatus = status
      hit.quotaNote = String(note || '').slice(0, 200)
      if (status === 'exhausted') hit.exhaustedAt = Date.now()
      writePool(pool)
      return hit
    },

    touchOk(id) {
      const pool = readPool()
      const hit = pool.accounts.find((item) => item.id === id)
      if (!hit) return null
      hit.lastOkAt = Date.now()
      if (hit.quotaStatus === 'exhausted') {
        hit.quotaStatus = 'ok'
        hit.quotaNote = ''
        hit.exhaustedAt = 0
      }
      writePool(pool)
      return hit
    },

    clearAuth() {
      for (const file of [authPath, modelsPath]) {
        try {
          fs.rmSync(file, { force: true })
        } catch {
          /* ignore */
        }
      }
    },

    /** 模型清单缓存：让"选择器里已经有东西"这件事不依赖每次开机都联网。 */
    models() {
      const value = readJSON(modelsPath, null)
      if (!isPlainObject(value) || !Array.isArray(value.models)) return null
      return value
    },

    saveModels(payload) {
      writeJSON(modelsPath, { ...payload, at: Date.now() })
      return store.models()
    },
  }

  return store
}
