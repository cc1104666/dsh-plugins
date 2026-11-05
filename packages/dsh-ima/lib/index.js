/**
 * dsh-ima —— 宿主半区（Node 侧）。
 *
 * 一句话：把 ima.qq.com（腾讯 IMA 知识管家）网页版的对话模型，
 * 变成 DSH 模型选择器里的一组可选模型。
 *
 * 和之前几个插件的关系：
 *   - 像 grok-online：上游不是 OpenAI 兼容（/cgi-bin/assistant/qa + 命名事件 SSE
 *     + x-ima-cookie/x-ima-bkn 自定义头），所以必须本机起反代做翻译。
 *   - 像 lightvela：登录是微信开放平台扫码（open.weixin.qq.com，snsapi_login），
 *     纯 Node 可闭环，拿 wx_code 直接打 ima 自己的 /cgi-bin/login。
 *   - 不一样的地方：模型清单免登录可读（intelligent_assistant_http_nl/get_models），
 *     登录只是为了「发消息」这个动作。
 *
 * 链路：
 *   扫码登录（拿 IMA-TOKEN / IMA-REFRESH-TOKEN）
 *     → 免登录读模型清单（4 个官方模型）
 *     → 本机 127.0.0.1 反代（OpenAI ⇄ ima SSE 翻译）
 *     → 写进 llm-pi-ai 的 providers.ima，baseURL 指反代
 *
 * 浏览器半区通过 /plugins/dsh-ima/* 这几条同源路由跟这里说话。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createStore } from './store.js'
import { createWechatLogin } from './login.js'
import { normalizeModels, toProviderModels, findModel } from './models.js'
import { createRelay } from './relay.js'
import { fetchModels, refreshToken, randomGuid } from './ima.js'
import { chatOnce } from './upstream.js'

export const name = 'ima'

const BASE = '/plugins/dsh-ima'
const MAX_BODY = 1024 * 1024

/** 模型清单缓存多久。清单本身免登录就能读，但没必要每秒打一次。 */
const CATALOG_TTL = 30 * 60 * 1000

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${String((error && error.message) || error)}`))
      }
    })
    req.on('error', reject)
  })
}

function fail(error) {
  return String((error && error.message) || error)
}

export function apply(ctx, config) {
  const store = createStore(config || {})
  const log = (...args) => console.log('[ima]', ...args)

  const MODEL_KEY_ENV = 'IMA_API_KEY'

  let settingsSeam = null
  let credentialsSeam = null
  /** 上次读到的模型清单（内存 + 磁盘各一份）。 */
  let catalog = null
  /** 上次注册进 llm-pi-ai 的结果，面板据此显示状态。 */
  let published = null

  // ------------------------------------------------------------------ 设备身份

  /** 设备 guid：一次生成，一直沿用。存 dataDir/device.json。 */
  const devicePath = path.join(store.dir, 'device.json')
  const readDevice = () => {
    try {
      return JSON.parse(fs.readFileSync(devicePath, 'utf8'))
    } catch {
      const device = { guid: randomGuid(), q36: '', createdAt: new Date().toISOString() }
      try {
        fs.mkdirSync(store.dir, { recursive: true })
        fs.writeFileSync(devicePath, JSON.stringify(device, null, 2), 'utf8')
      } catch {
        /* 读不了就算了，用内存值 */
      }
      return device
    }
  }
  const device = readDevice()
  const getDevice = () => device

  // ------------------------------------------------------------------ 登录态

  /** token 快过期时提前换票。返回最新 auth（可能没变）。 */
  const ensureAuth = async () => {
    const auth = store.auth()
    if (!auth || !auth.token) return auth
    const validMs = (auth.tokenValidTime || 0) * 1000
    const savedAt = auth.savedAt ? Date.parse(auth.savedAt) : 0
    const expiresAt = savedAt && validMs ? savedAt + validMs : 0
    const cfg = store.config()
    if (expiresAt && Date.now() < expiresAt - cfg.refreshAhead) return auth
    if (!auth.refreshToken) return auth

    try {
      const next = await refreshToken(cfg, auth, device)
      if (next && next.token) {
        const saved = store.patchAuth({ ...next, source: auth.source || 'wechat-qr' })
        log('token 已续期')
        return saved
      }
      log('refresh 没换到新 token，继续用旧的（失效时会 401）')
    } catch (error) {
      log(`refresh 失败：${fail(error)}`)
    }
    return auth
  }

  const hydrateCatalog = () => {
    if (catalog) return catalog
    const saved = store.models()
    if (saved) {
      catalog = {
        models: Array.isArray(saved.models) ? saved.models : [],
        at: saved.at || 0,
      }
    }
    return catalog
  }

  const login = createWechatLogin({
    getConfig: () => store.config(),
    getDevice,
    log,
    onAuthed: (account) => {
      const saved = store.patchAuth(account)
      afterLogin().catch((error) => log(`登录后自动注册失败：${fail(error)}`))
      return saved
    },
  })

  const snapshot = () => {
    const cfg = store.config()
    const auth = store.auth()
    const saved = hydrateCatalog()
    return {
      ok: true,
      authed: Boolean(auth && auth.token),
      account: auth
        ? { name: auth.nickName || auth.userId || '', avatarUrl: auth.avatarUrl || '', userId: auth.userId || '' }
        : null,
      source: auth ? auth.source || '' : '',
      savedAt: auth ? auth.savedAt : null,
      /** 模型选择器那边的情况。 */
      modelPicker: {
        registered: Boolean(published),
        count: published ? published.count : 0,
        baseURL: published ? published.baseURL : relay.baseURL,
        at: published ? published.at : null,
        catalog: saved ? saved.models.length : 0,
        catalogAt: saved ? saved.at || null : null,
        providerId: cfg.providerId,
        providerName: cfg.providerName,
      },
      models: saved ? saved.models : [],
      qr: login.view(),
      /** 明确告诉面板：这个插件需要本机反代。 */
      relay: relay.port ? { port: relay.port, baseURL: relay.baseURL } : null,
    }
  }

  // ------------------------------------------------------------------ 反代

  const relay = createRelay({
    getConfig: () => store.config(),
    getAuth: () => store.auth(),
    ensureAuth,
    getDevice,
    getModels: () => {
      const saved = hydrateCatalog()
      return saved ? saved.models : []
    },
    log,
  })

  // ------------------------------------------------------------------ 模型清单

  const refreshCatalog = async ({ force = false } = {}) => {
    const saved = hydrateCatalog()
    if (!force && saved && Date.now() - (saved.at || 0) < CATALOG_TTL) return saved

    const rows = await fetchModels(store.config())
    // ima 的清单免登录可读，重新拉时把上次探测到的 usable/note 按 id 贴回去。
    const probed = new Map(((saved && saved.models) || []).map((item) => [item.id, item]))
    const models = normalizeModels(rows).map((item) => {
      const before = probed.get(item.id)
      if (!before || before.usable == null) return item
      return { ...item, usable: before.usable, note: before.note }
    })
    catalog = { models, at: Date.now() }
    store.saveModels({ models })
    log(`模型清单：${models.length} 个（${models.map((m) => m.shortName || m.id).join(' / ')}）`)
    return catalog
  }

  /** 把 provider 写进 llm-pi-ai。baseURL 指本机反代。 */
  const publishProvider = async ({ force = false } = {}) => {
    if (!settingsSeam || typeof settingsSeam.mutate !== 'function') {
      throw new Error('宿主没有提供 settings 服务，模型注册不了')
    }
    const auth = store.auth()
    if (!auth || !auth.token) throw new Error('还没登录 ima，注册了也调不通')

    const port = await relay.start(store.config().relayPort)
    const baseURL = `http://127.0.0.1:${port}/v1`

    const loaded = await refreshCatalog({ force })
    if (!loaded || loaded.models.length === 0) {
      throw new Error('模型清单是空的，先点「读清单」')
    }

    if (credentialsSeam && typeof credentialsSeam.set === 'function') {
      // 反代不校验 key，但 llm-pi-ai 要求 credentials 里有值。
      await credentialsSeam.set(MODEL_KEY_ENV, 'local-relay')
    }

    const cfg = store.config()
    const models = toProviderModels(loaded.models)
    await settingsSeam.mutate('llm-pi-ai', [
      {
        op: 'set',
        path: ['providers', cfg.providerId],
        value: {
          displayName: cfg.providerName,
          apiKeyEnv: MODEL_KEY_ENV,
          api: 'openai-completions',
          baseURL,
          models,
        },
      },
    ])

    published = { at: Date.now(), count: models.length, baseURL }
    log(`已注册模型 provider「${cfg.providerName}」：${models.length} 个模型 → ${baseURL}`)
    return published
  }

  /** 登录成功后：顺手把反代拉起来 + provider 写一遍，少让用户点一次。 */
  const afterLogin = async () => {
    await refreshCatalog({})
    await publishProvider({ force: false })
  }

  // ------------------------------------------------------------------ 路由

  const routes = [
    {
      path: '/status',
      handler: async (req, res) => json(res, 200, snapshot()),
    },
    {
      /** 申请二维码。返回 dataURL，面板直接画出来。 */
      path: '/auth/qr/start',
      handler: async (req, res) => {
        const view = await login.start()
        return json(res, 200, { ...snapshot(), qr: view })
      },
    },
    {
      path: '/auth/qr/status',
      handler: async (req, res) => json(res, 200, { ok: true, qr: login.view() }),
    },
    {
      path: '/auth/qr/cancel',
      handler: async (req, res) => json(res, 200, { ...snapshot(), qr: login.cancel() }),
    },
    {
      /**
       * 手贴兜底：浏览器登录 ima.qq.com 后，从请求头里复制 x-ima-cookie 整串粘过来，
       * 插件自己拆 IMA-UID / IMA-TOKEN / IMA-REFRESH-TOKEN / UID-TYPE / TOKEN-TYPE。
       */
      path: '/auth/bind',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const raw = String(body.cookie || body.token || '').trim()
          if (raw === '') return json(res, 400, { ...snapshot(), ok: false, error: '请粘贴 x-ima-cookie 整串' })

          const jar = {}
          for (const part of raw.split(';')) {
            const eq = part.indexOf('=')
            if (eq <= 0) continue
            jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
          }
          if (!jar['IMA-TOKEN']) {
            return json(res, 200, { ...snapshot(), ok: false, error: '这串里没有 IMA-TOKEN，确认复制的是 x-ima-cookie 请求头' })
          }
          store.patchAuth({
            token: jar['IMA-TOKEN'],
            refreshToken: jar['IMA-REFRESH-TOKEN'] || '',
            userId: jar['IMA-UID'] || '',
            idType: jar['UID-TYPE'] !== undefined ? jar['UID-TYPE'] : '',
            tokenType: jar['TOKEN-TYPE'] !== undefined ? jar['TOKEN-TYPE'] : '',
            nickName: '',
            source: 'manual',
          })
          await afterLogin().catch((error) => log(`手贴登录后注册失败：${fail(error)}`))
          return json(res, 200, { ...snapshot(), ok: true })
        } catch (error) {
          return json(res, 500, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      /** 重新读模型清单（免登录接口）。 */
      path: '/models/refresh',
      handler: async (req, res) => {
        try {
          const loaded = await refreshCatalog({ force: true })
          return json(res, 200, { ...snapshot(), ok: true, models: loaded.models })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      /** 面板上的「试一句」：不经过 DSH，直接打一发完整链路。 */
      path: '/test',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const auth = await ensureAuth()
          if (!auth || !auth.token) throw new Error('还没登录 ima')
          const saved = hydrateCatalog()
          const model = findModel((saved && saved.models) || [], String(body.model || ''))
          if (!model) throw new Error('模型清单是空的，先点「读清单」')

          const result = await chatOnce(
            {
              getConfig: () => store.config(),
              getAuth: () => auth,
              getDevice,
            },
            {
              messages: [{ role: 'user', content: String(body.question || '回复两个字：可用') }],
              model,
            },
          )
          return json(res, 200, {
            ok: result.ok,
            elapsed: result.elapsed,
            model: model.id,
            text: (result.text || '').slice(0, 500),
            reasoning: (result.reasoning || '').slice(0, 300),
            error: result.ok ? '' : result.error,
          })
        } catch (error) {
          return json(res, 200, { ok: false, error: fail(error) })
        }
      },
    },
    {
      path: '/models/register',
      handler: async (req, res) => {
        try {
          const result = await publishProvider({ force: true })
          return json(res, 200, { ...snapshot(), ok: true, published: result })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      path: '/logout',
      handler: async (req, res) => {
        store.clearAuth()
        catalog = null
        published = null
        login.cancel()
        return json(res, 200, snapshot())
      },
    },
  ]

  ctx.inject(['webServer'], (serverCtx) => {
    const server = serverCtx.webServer
    if (!server || typeof server.register !== 'function') {
      log('webServer 不可用，浏览器半区将无法调用宿主')
      return
    }
    for (const route of routes) {
      try {
        server.register({
          kind: 'exact',
          path: `${BASE}${route.path}`,
          handler: (req, res) =>
            Promise.resolve()
              .then(() => route.handler(req, res))
              .catch((error) => {
                log(`路由 ${route.path} 出错：`, error)
                try {
                  json(res, 500, { ok: false, error: fail(error) })
                } catch {
                  /* 响应可能已经发出去了 */
                }
              }),
        })
      } catch (error) {
        log(`注册路由 ${route.path} 失败：`, error)
      }
    }
    log(`已注册 ${routes.length} 条路由，前缀 ${BASE}`)
  })

  /**
   * 启动时如果已经登录过，就把反代拉起来 + provider 重新写一遍。
   *
   * 为什么要重写：llm-pi-ai 的 providers 是宿主配置，插件重装 / profile 重建后
   * 会丢。重写一次几乎零成本，能让"重装插件后模型还在选择器里"成立。
   * 模型清单免登录可读，所以没登录也会先把清单拉回来。
   */
  ctx.inject(['settings', 'credentials'], (seamCtx) => {
    settingsSeam = (seamCtx && seamCtx.settings) || null
    credentialsSeam = (seamCtx && seamCtx.credentials) || null
    const auth = store.auth()
    refreshCatalog({})
      .catch((error) => log(`启动时读模型清单失败：${fail(error)}`))
      .then(() => {
        if (auth && auth.token) {
          return publishProvider({ force: false }).catch((error) => log(`启动时注册模型失败：${fail(error)}`))
        }
        log('还没登录 ima，等面板里完成扫码后再注册')
        return null
      })
  })
}
