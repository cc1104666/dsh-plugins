/**
 * 插件自己的持久化层。
 *
 * 位置：<home>/.dsh/plugin-data/dsh-grok-online/
 *   config.json   运行期配置（面板写入，可覆盖 DEFAULT_CONFIG）
 *   state.json    今日额度缓存 + 反代端口（面板首帧就能显示"还剩几条"，不用等网络）
 *
 * 为什么只有这两个：grok.online 没有登录、没有 API Key，全站靠「每天免费 N 条」
 * 加 IP 记账。所以这里既没有 auth.json，也没有 apiKey —— 插件不需要任何凭据。
 *
 * 全部写盘走 tmp + rename，避免进程被 kill 时留下半截 JSON。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_CONFIG = {
  /** 站点本体。/api/chat 就挂在它下面，Referer/Origin 也得拼它。 */
  siteBase: 'https://grok.online',
  /** 对话接口路径（和号后面用 ?credits=1 / ?unlock=1 区分动作）。 */
  apiPath: '/api/chat',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  /**
   * 可选的 Cookie。站点现在不种任何 cookie（实测响应头里没有 Set-Cookie），
   * 额度是按 IP 记的；这个字段只是给"以后它改成账号制"留的口子。
   */
  cookie: '',
  /** 本机反代的固定端口。被占用会自动往后找，实际端口记在 state.json 里。 */
  relayPort: 43690,
  /** 注册进 DSH 模型选择器的 provider id / 显示名。 */
  providerId: 'grok-online',
  providerName: 'Grok.online',
  /** 单轮上下文上限（字符）。站点前端自己也是 10000 字符截断的。 */
  contextChars: 10000,
  /** DSH 端的假钥匙。反代不校验它，但 llm-pi-ai 要求有个 apiKeyEnv 有值。 */
  relayToken: 'local-relay',

  // ---------------------------------------------------------------- 出口池
  /**
   * 'off'  只用本机直连（一件都不改，等于插件原来的行为）
   * 'auto' 额度用完就自动换下一个出口
   */
  proxyMode: 'off',
  /** 一行一个代理；行尾加 `#rotating` 表示它是动态/隧道代理（每次连接换 IP）。 */
  proxyPool: [],
  /** 池子都试完了还回不回到直连。默认回 —— 不花额外代价，只是多用一次 429 的风险。 */
  proxyAllowDirect: true,
  /**
   * 同一出口失败后再打几次。
   * 动态代理靠这个白拿新 IP，所以默认给 2 次 —— 住宅出口的 TLS 抖动大概 10~20%，
   * 一次重试经常不够（换到下一个国家之前先把同一家多试一次更便宜）。
   */
  proxyRerollRotating: 2,
  proxyRerollSticky: 0,
  /** 单次对话最多试几个出口，防止池子写错时一发请求打几十个 429。 */
  proxyMaxAttempts: 10,
  /** 代理连接超时（毫秒）。 */
  proxyConnectTimeout: 15000,
  /**
   * 探测出口 IP 用的地址（只用于面板显示，失败不影响任何事）。
   * 默认挑国内直连最快的一个；失败时会自动兜一次 ipinfo.io/ip。
   */
  proxyProbeUrl: 'https://myip.ipip.net',

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
  return path.join(os.homedir(), '.dsh', 'plugin-data', 'dsh-grok-online')
}

/** 站点按 UTC 日切额度（前端缓存也是 toISOString().slice(0,10)）。 */
export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

export function createStore(initialConfig = {}) {
  const patchRaw = isPlainObject(initialConfig) ? { ...initialConfig } : {}
  delete patchRaw.dataDir
  const dir = initialConfig.dataDir || defaultDataDir()
  const configPath = path.join(dir, 'config.json')
  const statePath = path.join(dir, 'state.json')

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

  const writeJSON = (file, value) => {
    ensure()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  ensure()

  let runtimeConfig = readJSON(configPath, {})
  if (!isPlainObject(runtimeConfig)) runtimeConfig = {}

  const freshState = (value) => {
    if (!isPlainObject(value)) return null
    // 跨天就作废：昨天的"还剩 0 条"不该影响今天。
    if (value.day && value.day !== utcDay()) return { ...value, credits: null, bonus: null, stale: true }
    return value
  }

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

    /** 今日额度缓存：{credits, bonus, day, at, port} */
    state() {
      return freshState(readJSON(statePath, null))
    },

    patchState(patch) {
      const current = store.state() || {}
      const next = { ...current, ...patch }
      next.day = next.day || utcDay()
      next.at = Date.now()
      writeJSON(statePath, next)
      return store.state()
    },
  }

  return store
}
