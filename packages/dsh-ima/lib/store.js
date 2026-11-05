/**
 * 插件自己的持久化层。
 *
 * 位置：<home>/.dsh/plugin-data/dsh-ima/
 *   config.json   运行期配置（面板写入）
 *   auth.json     登录态（IMA-TOKEN / IMA-REFRESH-TOKEN / 用户信息）
 *   models.json   上次读到的模型清单（离线也能让选择器有东西可选）
 *
 * 全部写盘走 tmp + rename，避免进程被 kill 时留下半截 JSON。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_CONFIG = {
  /** 站点本体。所有业务接口都在 {siteBase}/cgi-bin/ 下。 */
  siteBase: 'https://ima.qq.com',
  /** 微信开放平台网页授权的 appid（网页登录页在用）。 */
  wxAppId: 'wx0d63f5de059f1d52',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  /** 注册进 DSH 模型选择器的 provider id。 */
  providerId: 'ima',
  /** 注册进选择器的显示名。 */
  providerName: '腾讯 ima',
  /** 本机反代首选端口（被占则顺延）。 */
  relayPort: 43710,
  /** 对话无输出多久算超时（毫秒）。ima 生成长文时单事件间隔可能到几十秒。 */
  streamIdleTimeout: 120000,
  /** 登录态过期前多久主动 refresh（毫秒）。 */
  refreshAhead: 10 * 60 * 1000,
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
  return path.join(os.homedir(), '.dsh', 'plugin-data', 'dsh-ima')
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

    /** 登录态。 */
    auth() {
      const value = readJSON(authPath, null)
      if (!isPlainObject(value)) return null
      const hasToken = typeof value.token === 'string' && value.token !== ''
      if (!hasToken) return null
      return value
    },

    patchAuth(patch) {
      const current = store.auth() || {}
      const next = { ...current, ...patch }
      next.savedAt = new Date().toISOString()
      writeJSON(
        authPath,
        {
          /** IMA-TOKEN：业务请求的通行证，bkn 由它算出。 */
          token: next.token || '',
          /** IMA-REFRESH-TOKEN：换新 token 用。 */
          refreshToken: next.refreshToken || '',
          userId: next.userId || '',
          nickName: next.nickName || '',
          avatarUrl: next.avatarUrl || '',
          idType: next.idType === undefined ? '' : next.idType,
          tokenType: next.tokenType === undefined ? '' : next.tokenType,
          /** token 有效期（秒），0 表示未知。 */
          tokenValidTime: next.tokenValidTime || 0,
          refreshTokenValidTime: next.refreshTokenValidTime || 0,
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

    /** 模型清单缓存。 */
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
