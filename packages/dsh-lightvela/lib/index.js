/**
 * dsh-lightvela —— 宿主半区（Node 侧）。
 *
 * 一句话：把 LightVela 套餐里的模型，变成 DSH 模型选择器里的一组可选模型。
 *
 * 为什么不叫「反代」：
 * LightVela 的模型网关（token.lightvela.com/v1）本身就是 OpenAI 兼容的，
 * 而且**公网直接可达**。所以不需要在 127.0.0.1 起一个转发层 —— DSH 拿着
 * baseURL + key 就能直连。这一点和 VibeX 那套（网关只认特定头、必须本地补头）
 * 完全不同。
 *
 * 真正麻烦的是「key 从哪来」：LightVela 卖的是云上 Agent 实例，模型额度是平台
 * 代付的，没有对外发 API Key 的接口。凭据只存在于实例沙箱里的 ~/.hermes/.env。
 * 所以插件干的事是：
 *
 *   扫码登录（拿 lc_session）
 *     → 列出实例（找到在跑的那个）
 *     → 进沙箱读 CUSTOM_API_KEY + config.yaml 的 model.base_url
 *     → 打一发探针确认能出字
 *     → 写进 llm-pi-ai 的 providers.lightvela
 *
 * 浏览器半区通过 /plugins/dsh-lightvela/* 这几条同源路由跟这里说话。
 */
import { createStore } from './store.js'
import { createWechatLogin } from './login.js'
import { normalizeModels, toProviderModels } from './models.js'
import {
  fetchSession,
  listInstances,
  pullSandboxKey,
  listGatewayModels,
  probeChat,
} from './lightvela.js'

export const name = 'lightvela'

const BASE = '/plugins/dsh-lightvela'
const MAX_BODY = 1024 * 1024

/** 模型清单缓存多久。网关那边很少变，但也不该一直信旧的。 */
const CATALOG_TTL = 10 * 60 * 1000

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
  const log = (...args) => console.log('[lightvela]', ...args)

  const MODEL_KEY_ENV = 'LIGHTVELA_API_KEY'

  let settingsSeam = null
  let credentialsSeam = null
  /** 上次读到的模型清单（内存 + 磁盘各一份）。 */
  let catalog = null
  /** 上次注册进 llm-pi-ai 的结果，面板据此显示状态。 */
  let published = null

  const hydrateCatalog = () => {
    if (catalog) return catalog
    const saved = store.models()
    if (saved) {
      catalog = {
        models: Array.isArray(saved.models) ? saved.models : [],
        at: saved.at || 0,
        gatewayBase: saved.gatewayBase || '',
      }
    }
    return catalog
  }

  const login = createWechatLogin({
    getConfig: () => store.config(),
    log,
    onAuthed: ({ sessionToken, user, source }) => {
      const saved = store.patchAuth({ sessionToken, user, source })
      // 登录只是登录。取钥匙放在 afterLogin 里做，这样"登录成功但没钥匙"能被单独看见。
      afterLogin().catch((error) => log(`登录后自动取钥匙失败：${fail(error)}`))
      return saved
    },
  })

  const snapshot = () => {
    const cfg = store.config()
    const auth = store.auth()
    const saved = hydrateCatalog()
    return {
      ok: true,
      authed: Boolean(auth && auth.sessionToken),
      /** 有没有把模型钥匙拉回来。没登录也可能有钥匙（手贴过）。 */
      keyReady: Boolean(auth && auth.apiKey),
      account: auth ? auth.user || null : null,
      source: auth ? auth.source || '' : '',
      savedAt: auth ? auth.savedAt : null,
      keyPulledAt: auth ? auth.keyPulledAt || null : null,
      instance: auth
        ? { id: auth.instanceId || '', name: auth.instanceName || '' }
        : { id: '', name: '' },
      gatewayBase: (auth && auth.gatewayBase) || cfg.gatewayBase,
      loginUrl: cfg.loginUrl,
      /** 模型选择器那边的情况。 */
      modelPicker: {
        registered: Boolean(published),
        count: published ? published.count : 0,
        baseURL: published ? published.baseURL : '',
        at: published ? published.at : null,
        catalog: saved ? saved.models.length : 0,
        catalogAt: saved ? saved.at || null : null,
        providerId: cfg.providerId,
        providerName: cfg.providerName,
      },
      models: saved ? saved.models : [],
      qr: login.view(),
      /** 明确告诉面板：这次不需要本机反代。 */
      relay: false,
    }
  }

  const requireSession = () => {
    const auth = store.auth()
    if (!auth || !auth.sessionToken) {
      throw new Error('还没登录 LightVela。先在上面扫码。')
    }
    return auth.sessionToken
  }

  /** 挑实例：优先 Running 的，多个就取第一个。 */
  const pickInstance = async (sessionToken, preferId) => {
    const instances = await listInstances(store.config(), sessionToken)
    if (instances.length === 0) {
      throw new Error('这个账号下还没有实例。先在 lightvela.com 上创建一个 Bot。')
    }
    if (preferId) {
      const hit = instances.find((item) => item.instanceId === preferId)
      if (hit) return hit
    }
    const running = instances.find((item) => /running/i.test(item.status))
    return running || instances[0]
  }

  /** 刷新模型清单：需要钥匙，走网关 /v1/models。 */
  const refreshCatalog = async ({ force = false } = {}) => {
    const auth = store.auth()
    if (!auth || !auth.apiKey) throw new Error('还没有模型钥匙。先点「从实例里取模型钥匙」。')
    const saved = hydrateCatalog()
    if (!force && saved && Date.now() - (saved.at || 0) < CATALOG_TTL) return saved

    const gatewayBase = auth.gatewayBase || store.config().gatewayBase
    const rows = await listGatewayModels(store.config(), gatewayBase, auth.apiKey)
    // 网关的 /v1/models 不带「能不能调」，探测结果只在本机存着。
    // 重新拉目录时把上次探测到的 usable/note 按 id 贴回去，否则每次刷新都把结论丢了。
    const probed = new Map(((saved && saved.models) || []).map((item) => [item.id, item]))
    const models = normalizeModels(rows).map((item) => {
      const before = probed.get(item.id)
      if (!before || before.usable == null) return item
      return { ...item, usable: before.usable, note: before.note }
    })
    catalog = { models, at: Date.now(), gatewayBase }
    store.saveModels({ models, gatewayBase })
    log(`模型清单：${models.length} 个（网关 ${gatewayBase}）`)
    return catalog
  }

  /**
   * 把 provider 写进 llm-pi-ai。
   *
   * 注意这里没有 relay：baseURL 直接就是 LightVela 的网关。DSH 发请求时只会带
   * Authorization: Bearer <credentials 里的值>，而这家网关正好也只认这个，所以
   * 直连即可。
   */
  const publishProvider = async ({ force = false } = {}) => {
    if (!settingsSeam || typeof settingsSeam.mutate !== 'function') {
      throw new Error('宿主没有提供 settings 服务，模型注册不了')
    }
    const auth = store.auth()
    if (!auth || !auth.apiKey) throw new Error('还没有模型钥匙，注册不了')

    const loaded = await refreshCatalog({ force })
    if (!loaded || loaded.models.length === 0) {
      throw new Error('网关没返回任何可用模型')
    }

    const cfg = store.config()
    const baseURL = (auth.gatewayBase || cfg.gatewayBase).replace(/\/$/, '')
    // 探测过且明确打不通的模型不进选择器 —— 放进去只会让人选中后报错。
    const healthy = loaded.models.filter((item) => item.usable !== false)
    const models = toProviderModels(healthy.length > 0 ? healthy : loaded.models)
    if (models.length === 0) throw new Error('网关返回的模型都不在可用通道上，先看面板里每个模型的探测结果')

    if (credentialsSeam && typeof credentialsSeam.set === 'function') {
      await credentialsSeam.set(MODEL_KEY_ENV, auth.apiKey)
    }

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

    published = {
      at: Date.now(),
      count: models.length,
      baseURL,
    }
    log(`已注册模型 provider「${cfg.providerName}」：${models.length} 个模型 → ${baseURL}`)
    return published
  }

  /** 登录成功后：顺手把实例和钥匙一起拉回来，少让用户点一次。 */
  const afterLogin = async () => {
    const sessionToken = requireSession()
    const current = store.auth() || {}
    const instance = await pickInstance(sessionToken, current.instanceId || '')
    const key = await pullSandboxKey(store.config(), sessionToken, instance.instanceId)
    if (!key.ok) {
      log(`登录成功，但没取到钥匙：${key.code} ${key.note}`)
      return { instance, key }
    }
    store.patchAuth({
      apiKey: key.apiKey,
      gatewayBase: key.baseUrl,
      instanceId: instance.instanceId,
      instanceName: instance.name,
      keyPulledAt: new Date().toISOString(),
    })
    log(`已从实例「${instance.name}」取到模型钥匙（${key.apiKey.length} 字符）`)
    return { instance, key }
  }

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
       * 手贴会话兜底：在浏览器里登录后，打开 https://api.lightvela.com/auth/session
       * 能看到 sessionToken，粘过来就行。扫码那条路失效时用它。
       */
      path: '/auth/bind',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const raw = String(body.sessionToken || '').trim()
          if (raw === '') return json(res, 400, { ...snapshot(), ok: false, error: '请粘贴 sessionToken' })
          const probe = await fetchSession(store.config(), raw)
          if (!probe.ok) {
            return json(res, 200, { ...snapshot(), ok: false, error: `这个会话用不了：${probe.note}` })
          }
          store.patchAuth({ sessionToken: raw, user: probe.user, source: 'manual' })
          await afterLogin().catch((error) => log(`手贴登录后取钥匙失败：${fail(error)}`))
          return json(res, 200, { ...snapshot(), ok: true })
        } catch (error) {
          return json(res, 500, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      /** 重新拉钥匙（实例重建、钥匙过期时用）。 */
      path: '/key/pull',
      handler: async (req, res) => {
        try {
          const sessionToken = requireSession()
          let prefer = store.config().instanceId || ''
          try {
            const body = await readJsonBody(req, MAX_BODY)
            if (body && typeof body.instanceId === 'string' && body.instanceId !== '') prefer = body.instanceId
          } catch {
            /* 没 body 也正常 */
          }
          const instance = await pickInstance(sessionToken, prefer)
          const key = await pullSandboxKey(store.config(), sessionToken, instance.instanceId)
          if (!key.ok) {
            return json(res, 200, { ...snapshot(), ok: false, error: key.note, keyCode: key.code })
          }
          store.patchAuth({
            apiKey: key.apiKey,
            gatewayBase: key.baseUrl,
            instanceId: instance.instanceId,
            instanceName: instance.name,
            keyPulledAt: new Date().toISOString(),
          })
          catalog = null
          return json(res, 200, { ...snapshot(), ok: true, instance })
        } catch (error) {
          return json(res, 500, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      /** 列一下这个账号下的实例，面板上让用户看清钥匙是从哪来的。 */
      path: '/instances',
      handler: async (req, res) => {
        try {
          const sessionToken = requireSession()
          const instances = await listInstances(store.config(), sessionToken)
          return json(res, 200, { ...snapshot(), ok: true, instances })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
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
      /** 逐个打一发，把"能调 / 打不通"标在清单上。 */
      path: '/models/probe',
      handler: async (req, res) => {
        try {
          const auth = store.auth()
          if (!auth || !auth.apiKey) throw new Error('还没有模型钥匙')
          const loaded = await refreshCatalog({})
          const gatewayBase = (auth.gatewayBase || store.config().gatewayBase).replace(/\/$/, '')
          const models = []
          for (const item of loaded.models) {
            const result = await probeChat(store.config(), gatewayBase, auth.apiKey, item.id)
            const errorText =
              result.body && result.body.error
                ? String(result.body.error.message || result.body.error.code || '').slice(0, 180)
                : ''
            models.push({
              ...item,
              usable: result.ok,
              note: result.ok ? `${result.elapsed}ms` : errorText || `HTTP ${result.status}`,
            })
          }
          catalog = { models, at: Date.now(), gatewayBase }
          store.saveModels({ models, gatewayBase })
          return json(res, 200, { ...snapshot(), ok: true, models })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
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
      /** 面板上的「试一句」：直接用当前钥匙打一发，不经过 DSH。 */
      path: '/test',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const auth = store.auth()
          if (!auth || !auth.apiKey) throw new Error('还没有模型钥匙')
          const gatewayBase = (auth.gatewayBase || store.config().gatewayBase).replace(/\/$/, '')
          const model = String(body.model || 'auto')
          const result = await probeChat(store.config(), gatewayBase, auth.apiKey, model)
          const text =
            result.body && result.body.choices && result.body.choices[0]
              ? String(result.body.choices[0].message.content || result.body.choices[0].message.reasoning_content || '')
              : ''
          return json(res, 200, {
            ok: result.ok,
            status: result.status,
            elapsed: result.elapsed,
            model,
            text: text.slice(0, 500),
            raw: result.ok ? '' : result.raw,
          })
        } catch (error) {
          return json(res, 200, { ok: false, error: fail(error) })
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
   * 启动时如果已经登录过、钥匙也还在，就把 provider 重新写一遍。
   *
   * 为什么要重写：llm-pi-ai 的 providers 是宿主配置，插件重装 / profile 重建后
   * 会丢。重写一次几乎零成本，能让"重装插件后模型还在选择器里"成立。
   */
  ctx.inject(['settings', 'credentials'], (seamCtx) => {
    settingsSeam = (seamCtx && seamCtx.settings) || null
    credentialsSeam = (seamCtx && seamCtx.credentials) || null
    const auth = store.auth()
    if (!auth || !auth.apiKey) {
      log('还没有模型钥匙，等面板里完成「扫码 → 取钥匙」后再注册')
      return
    }
    publishProvider({ force: false }).catch((error) => log(`启动时注册模型失败：${fail(error)}`))
  })
}
