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
import { createRelay } from './relay.js'
import { normalizeModels, toProviderModels } from './models.js'
import {
  fetchSession,
  listInstances,
  pullSandboxKey,
  listGatewayModels,
  probeChat,
  checkReferralCode,
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
  /** 邀请码校验结果缓存：别让面板每次轮询都去打一次站点。 */
  let referralCheck = null
  /** 账号池里最后一次真正写盘的 touchOk 时间（省得每个请求都写一次盘）。 */
  let lastTouchOkAt = 0

  const accountLabel = (account) =>
    (account && (account.label || (account.user && (account.user.name || account.user.id)) || account.id)) || '未命名账号'

  /**
   * 本机转发器。DSH 的模型请求会打到它，它按「当前账号 → 其它正常账号 →
   * 没额度的账号」的顺序挑钥匙；撞到 402 立刻换下一个重试。
   *
   * 单账号时它也照样跑 —— 一条代码路径，比「单账号直连 / 多账号转发」两套
   * 逻辑少一半边界情况。
   */
  const relay = createRelay({
    getConfig: () => store.config(),
    getCandidates: () =>
      store.candidates().map((account) => ({
        id: account.id,
        label: accountLabel(account),
        apiKey: account.apiKey,
        gatewayBase: account.gatewayBase || store.config().gatewayBase,
      })),
    log,
    /** 某个账号被判死（402 没额度 / 401 钥匙失效）时记下来。 */
    onQuota: (id, status, note) => {
      // retry = 只是被限流，不标死，下一条还能用。否则会把频繁限流的账号永久踢掉。
      if (status === 'retry') return
      const saved = store.markQuota(id, status, note)
      if (!saved) return
      log(`账号「${accountLabel(saved)}」标记为 ${status}：${note}`)
      // 当前账号被标死，顺手切到下一个能用的，面板上能立刻看到变化。
      const pool = store.pool()
      if (pool.activeId === id) {
        const next = store.candidates().find((item) => item.id !== id && item.quotaStatus !== 'exhausted')
        if (next) {
          store.setActive(next.id)
          log(`当前账号没额度，已切到「${accountLabel(next)}」`)
        }
      }
    },
    /** 转发器实际用上了某个账号：让它成为「当前账号」，并记一次活跃时间。 */
    onActive: (id) => {
      const pool = store.pool()
      if (pool.activeId !== id) {
        store.setActive(id)
        lastTouchOkAt = Date.now()
        log(`已切到账号「${id}」`)
        return
      }
      if (Date.now() - lastTouchOkAt > 60 * 1000) {
        lastTouchOkAt = Date.now()
        store.touchOk(id)
      }
    },
  })

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
      // 扫码的可能是「再加一个账号」，所以先看池子里现在有几个。
      const total = store.pool().accounts.length
      log(total > 1 ? `新增账号「${accountLabel(saved)}」，池子里共 ${total} 个` : `登录成功：${accountLabel(saved)}`)
      // 登录只是登录。取钥匙放在 afterLogin 里做，这样"登录成功但没钥匙"能被单独看见。
      afterLogin(saved && saved.id).catch((error) => log(`登录后自动取钥匙失败：${fail(error)}`))
      return saved
    },
  })

  const snapshot = () => {
    const cfg = store.config()
    const pool = store.pool()
    const auth = store.auth()
    const saved = hydrateCatalog()
    const qrView = login.view()
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
      /**
       * 账号池。面板按这个渲染列表；exhausted 的账号会被转发器跳过。
       * active 那一条就是 DSH 现在实际在用的钥匙。
       */
      activeId: pool.activeId,
      accounts: pool.accounts.map((item) => ({
        id: item.id,
        label: item.label || '',
        name: (item.user && (item.user.name || item.user.id)) || '',
        active: item.id === pool.activeId,
        keyReady: item.apiKey !== '',
        authed: item.sessionToken !== '',
        instanceName: item.instanceName || '',
        gatewayBase: item.gatewayBase || '',
        keyPulledAt: item.keyPulledAt || null,
        quotaStatus: item.quotaStatus,
        quotaNote: item.quotaNote || '',
        exhaustedAt: item.exhaustedAt || 0,
        lastOkAt: item.lastOkAt || 0,
        source: item.source || '',
      })),
      /** 转发器状态：running=false 说明端口没起来，面板要提示退化成直连。 */
      relay: {
        running: relay.port > 0,
        port: relay.port,
        baseURL: relay.baseURL,
      },
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
      qr: qrView,
      /**
       * 邀请归因。code/url 来自配置，applied 是这一轮扫码实际挂上去的码。
       * 面板拿它渲染「还没账号？用邀请链接注册」那颗按钮。
       */
      referral: {
        code: cfg.referralCode || '',
        url: cfg.referralCode ? `${cfg.siteBase}/?ref=${encodeURIComponent(cfg.referralCode)}` : '',
        applied: qrView.referral || '',
        check: referralCheck,
      },
    }
  }

  const requireSession = (accountId) => {
    const auth = accountId ? store.pool().accounts.find((item) => item.id === accountId) : store.auth()
    if (!auth || !auth.sessionToken) {
      throw new Error(accountId ? '这个账号没有登录态，先扫码重新登录' : '还没登录 LightVela。先在上面扫码。')
    }
    return auth
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

    const gatewayBase = relay.baseURL || auth.gatewayBase || store.config().gatewayBase
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
    // 转发器起来了就指本机 —— 多账号切换必须经过它。起不来才退回直连
    // （直连也能用，只是额度用尽时没法自动换账号）。
    const baseURL = (relay.baseURL || auth.gatewayBase || cfg.gatewayBase).replace(/\/$/, '')
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

  /**
   * 给某个账号拉钥匙：找实例 → 进沙箱读 CUSTOM_API_KEY → 落盘。
   * 不传 accountId 就拉当前账号的。
   */
  const pullKeyFor = async (accountId, preferInstanceId) => {
    const account = requireSession(accountId)
    const cfg = store.config()
    const instance = await pickInstance(account.sessionToken, preferInstanceId || account.instanceId || '')
    const key = await pullSandboxKey(cfg, account.sessionToken, instance.instanceId)
    if (!key.ok) {
      log(`账号「${accountLabel(account)}」没取到钥匙：${key.code} ${key.note}`)
      return { account, instance, key }
    }
    const saved = store.patchAccount(account.id, {
      apiKey: key.apiKey,
      gatewayBase: key.baseUrl,
      instanceId: instance.instanceId,
      instanceName: instance.name,
      keyPulledAt: new Date().toISOString(),
      // 换了钥匙就重新给它机会 —— 原来标死的理由（额度/失效）可能已经不成立了。
      quotaStatus: 'ok',
      quotaNote: '',
      exhaustedAt: 0,
    })
    log(`账号「${accountLabel(saved || account)}」取到模型钥匙（${key.apiKey.length} 字符，实例 ${instance.name}）`)
    return { account: saved || account, instance, key }
  }

  /** 登录成功后：顺手把实例和钥匙一起拉回来，少让用户点一次。 */
  const afterLogin = async (accountId) => {
    const { account, instance, key } = await pullKeyFor(accountId)
    if (!key.ok) return { instance, key }
    return { account, instance, key }
  }

  const routes = [
    {
      path: '/status',
      handler: async (req, res) => json(res, 200, snapshot()),
    },
    {
      /**
       * 邀请码体检：面板上那颗「用邀请链接注册」的按钮点开前先问一次，
       * 免得邀请活动已经结束、用户却还被送去一个不返利的页面。
       * 结果缓存 10 分钟，面板轮询不会把站点打穿。
       */
      path: '/referral',
      handler: async (req, res) => {
        const cfg = store.config()
        const code = String(cfg.referralCode || '').trim()
        if (code === '') {
          return json(res, 200, { ok: true, code: '', url: '', check: null })
        }
        const stale = !referralCheck || referralCheck.at === undefined || Date.now() - referralCheck.at > CATALOG_TTL
        if (stale) {
          const result = await checkReferralCode(cfg, code)
          referralCheck = { ...result, at: Date.now() }
          log(`邀请码 ${code}：${result.ok ? `有效（${result.campaign || '未命名活动'}）` : result.note}`)
        }
        return json(res, 200, {
          ok: true,
          code,
          url: `${cfg.siteBase}/?ref=${encodeURIComponent(code)}`,
          check: referralCheck,
        })
      },
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
          const saved = store.patchAuth({ sessionToken: raw, user: probe.user, source: 'manual' })
          await afterLogin(saved && saved.id).catch((error) => log(`手贴登录后取钥匙失败：${fail(error)}`))
          return json(res, 200, { ...snapshot(), ok: true })
        } catch (error) {
          return json(res, 500, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      /** 重新拉钥匙（实例重建、钥匙过期时用）。可指定 accountId 拉某个账号的。 */
      path: '/key/pull',
      handler: async (req, res) => {
        try {
          let accountId = ''
          let prefer = ''
          try {
            const body = await readJsonBody(req, MAX_BODY)
            if (body && typeof body.instanceId === 'string') prefer = body.instanceId
            if (body && typeof body.accountId === 'string') accountId = body.accountId
          } catch {
            /* 没 body 也正常 */
          }
          const { instance, key } = await pullKeyFor(accountId || undefined, prefer)
          if (!key.ok) {
            return json(res, 200, { ...snapshot(), ok: false, error: key.note, keyCode: key.code })
          }
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
          let accountId = ''
          try {
            const body = await readJsonBody(req, MAX_BODY)
            if (body && typeof body.accountId === 'string') accountId = body.accountId
          } catch {
            /* ignore */
          }
          const account = requireSession(accountId || undefined)
          const instances = await listInstances(store.config(), account.sessionToken)
          return json(res, 200, { ...snapshot(), ok: true, instances })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      /**
       * 账号池操作。多账号是这套插件的核心，所以这些都是一等公民路由：
       *   switch  切当前账号（转发器下一发就用它）
       *   label   改备注名（多个微信号分不清时很有用）
       *   remove  删掉某个账号
       *   quota   清掉「没额度」标记（充值后 / 想重试一次）
       */
      path: '/accounts',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const action = String(body.action || '')
          const id = typeof body.id === 'string' ? body.id : ''

          if (action === 'switch') {
            if (!id) return json(res, 400, { ...snapshot(), ok: false, error: '要给 id' })
            if (!store.setActive(id)) return json(res, 200, { ...snapshot(), ok: false, error: '没有这个账号' })
            log(`手动切到账号「${id}」`)
            return json(res, 200, { ...snapshot(), ok: true })
          }

          if (action === 'label') {
            if (!id) return json(res, 400, { ...snapshot(), ok: false, error: '要给 id' })
            const saved = store.patchAccount(id, { label: String(body.label || '').slice(0, 40) })
            if (!saved) return json(res, 200, { ...snapshot(), ok: false, error: '没有这个账号' })
            return json(res, 200, { ...snapshot(), ok: true })
          }

          if (action === 'remove') {
            if (!id) return json(res, 400, { ...snapshot(), ok: false, error: '要给 id' })
            store.removeAccount(id)
            log(`删掉账号「${id}」`)
            return json(res, 200, { ...snapshot(), ok: true })
          }

          if (action === 'quota') {
            store.clearQuota(id || undefined)
            log(id ? `清掉账号「${id}」的没额度标记` : '清掉全部账号的没额度标记')
            return json(res, 200, { ...snapshot(), ok: true })
          }

          return json(res, 400, { ...snapshot(), ok: false, error: `不认识的 action：${action || '(空)'}` })
        } catch (error) {
          return json(res, 500, { ...snapshot(), ok: false, error: fail(error) })
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
          // 探测也走转发器：某个账号没额度时它会自动换下一个，探测结果才是「这套账号池能不能用」。
          const gatewayBase = (relay.baseURL || auth.gatewayBase || store.config().gatewayBase).replace(/\/$/, '')
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
          const gatewayBase = (relay.baseURL || auth.gatewayBase || store.config().gatewayBase).replace(/\/$/, '')
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
  ctx.inject(['settings', 'credentials'], async (seamCtx) => {
    settingsSeam = (seamCtx && seamCtx.settings) || null
    credentialsSeam = (seamCtx && seamCtx.credentials) || null

    /**
     * 先起转发器，再注册 provider —— 顺序不能反：provider 的 baseURL 要指转发器
     * 的端口，端口只有起来之后才知道。
     */
    try {
      await relay.start(store.config().relayPort)
    } catch (error) {
      log(`转发器起不来（${fail(error)}），退回直连网关：这样还能用，但额度用尽时不会自动换账号`)
    }

    const auth = store.auth()
    if (!auth || !auth.apiKey) {
      log('还没有模型钥匙，等面板里完成「扫码 → 取钥匙」后再注册')
      return
    }
    publishProvider({ force: false }).catch((error) => log(`启动时注册模型失败：${fail(error)}`))
  })
}
