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

    /** 登录态 + 模型钥匙。两半分开存：换钥匙不该把登录态冲掉。 */
    auth() {
      const value = readJSON(authPath, null)
      if (!isPlainObject(value)) return null
      const hasSession = typeof value.sessionToken === 'string' && value.sessionToken !== ''
      const hasKey = typeof value.apiKey === 'string' && value.apiKey !== ''
      if (!hasSession && !hasKey) return null
      return value
    },

    patchAuth(patch) {
      const current = store.auth() || {}
      const next = { ...current, ...patch }
      next.savedAt = new Date().toISOString()
      writeJSON(
        authPath,
        {
          sessionToken: next.sessionToken || '',
          user: next.user || null,
          /** 模型钥匙：从实例沙箱里拉回来的 CUSTOM_API_KEY。 */
          apiKey: next.apiKey || '',
          gatewayBase: next.gatewayBase || '',
          /** 钥匙来自哪个实例。实例重建后 key 会变，留着便于判断该不该重拉。 */
          instanceId: next.instanceId || '',
          instanceName: next.instanceName || '',
          keyPulledAt: next.keyPulledAt || null,
          /** 登录态怎么来的：wechat-qr（扫码）/ manual（手贴）。 */
          source: next.source || '',
          savedAt: next.savedAt,
        },
        0o600,
      )
      return store.auth()
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
