/**
 * 插件自己的持久化层。
 *
 * 位置：<home>/.dsh/plugin-data/dsh-grok3ai/
 *   config.json   运行期配置（面板写入）
 *   state.json    上次探活结果 + 反代端口 + 出口账本
 *
 * 这插件不需要任何凭据：Space 是公开的，HuggingFace 不要求 key。
 * 唯一"敏感"的是出口池里的代理密码，那也只存在本机 config.json 里。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_CONFIG = {
  /** 本机反代端口。被占用会自动往后找，实际端口记在 state.json。 */
  relayPort: 43695,
  providerId: 'grok3ai',
  providerName: 'Grok3AI',
  /** 单轮上下文上限（字符）。压成一段提示词之后，这是唯一的护栏。 */
  contextChars: 24000,
  /** 生成上限。Space 自己的滑杆会再夹一次。 */
  maxTokens: 4096,
  temperature: 0.3,
  topP: 0.9,
  /** 单发请求最长等多久（毫秒）。排队型 Space 很慢，别设太小。 */
  requestTimeout: 180000,
  /** 启用哪些 Space（id 数组）。空数组 = 全开。 */
  spaces: [],
  /** 启动时探活一次（只是读 /config）。冒烟/离线环境可以关掉。 */
  probeOnStart: true,
  /** DSH 端的假钥匙。反代不校验，但 llm-pi-ai 要求 apiKeyEnv 有值。 */
  relayToken: 'local-relay',

  // ---------------------------------------------------------------- 出口池
  /** 'off' 只用本机直连；'auto' 失败时自动换出口。 */
  proxyMode: 'off',
  proxyPool: [],
  proxyAllowDirect: true,
  proxyRerollRotating: 2,
  proxyRerollSticky: 0,
  proxyMaxAttempts: 6,
  proxyConnectTimeout: 15000,
  probeUrl: 'https://myip.ipip.net',

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
  return path.join(os.homedir(), '.dsh', 'plugin-data', 'dsh-grok3ai')
}

export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

export function createStore(initialConfig = {}) {
  const patchRaw = isPlainObject(initialConfig) ? { ...initialConfig } : {}
  delete patchRaw.dataDir
  const dir = initialConfig.dataDir || defaultDataDir()
  const configPath = path.join(dir, 'config.json')
  const statePath = path.join(dir, 'state.json')

  const ensure = () => fs.mkdirSync(dir, { recursive: true })

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

  return {
    dir,
    configPath,
    statePath,
    config() {
      return mergeConfig(DEFAULT_CONFIG, patchRaw, runtimeConfig)
    },
    patchConfig(patch) {
      if (!isPlainObject(patch)) return this.config()
      runtimeConfig = mergeConfig(runtimeConfig, patch)
      writeJSON(configPath, runtimeConfig)
      return this.config()
    },
    state() {
      const value = readJSON(statePath, null)
      return isPlainObject(value) ? value : null
    },
    patchState(patch) {
      const current = this.state() || {}
      const next = { ...current, ...patch }
      next.at = Date.now()
      writeJSON(statePath, next)
      return this.state()
    },
  }
}
