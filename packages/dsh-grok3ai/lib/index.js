/**
 * dsh-grok3ai —— 宿主半区（Node 侧）。
 *
 * 一句话：把 www.grok3ai.org 的聊天能力，变成 DSH 模型选择器里的模型。
 *
 * 但必须先说清楚一件事（README 里也写了）：
 *   这个站点**自己没有模型**。它的 /xx/chat 页面是个 SEO 壳，只往 iframe 里塞一个
 *   HuggingFace Space —— 页面里 `aiUrl` 被赋值六次，只有最后一行生效。所以访客
 *   实际在聊的是 `minimaxai-minimax-vl-01.hf.space`（MiniMax 海螺），不是 Grok。
 *
 *   所以这里的做法是：直连那几个 Space，把它们各自注册成一个模型。
 *   站点清单里另有三个已经死了（412 / 404 / 503），只在面板上解释，不注册。
 *
 * 和前几个插件的关系：
 *   dsh-vibex-vision  要补站点专用头 → 有反代
 *   dsh-lightvela     网关本身 OpenAI 兼容 → 没有反代
 *   dsh-grok-online   自定义接口 + 自带 SSE → 有反代
 *   dsh-grok3ai       Gradio 的 call/event 两段式 → **必须有反代**
 *
 * 出口池是可选的：HF 对匿名访问按 IP 限流（429），池子用来在限流时换个 IP。
 * 默认关闭 —— 不换 IP 也能用，只是高峰期偶尔要等。
 */
import { SPACES, DEAD_SPACES, DEFAULT_SPACE, resolveSpace, toProviderModels } from './spaces.js'
import { probeSpace, runSpace } from './gradio.js'
import { buildOptions, buildPrompt, explainFailure } from './upstream.js'
import { createRelay } from './relay.js'
import { createStore } from './store.js'
import { makeFetcher, probeExitIp } from './proxy-agent.js'
import { runWithRotation } from './rotate.js'
import {
  freshLedger,
  markProbe,
  markResult,
  parsePoolText,
  rankEntries,
  resolvePool,
  stateLabel,
  summarize,
} from './pool.js'

export const name = 'grok3ai'

const BASE = '/plugins/dsh-grok3ai'
const MAX_BODY = 1024 * 1024
const MODEL_KEY_ENV = 'GROK3AI_API_KEY'
/** 探活结果缓存多久（毫秒）。Space 不常变，但冷启动要试出来，5 分钟够。 */
const PROBE_TTL = 5 * 60 * 1000
const PROBE_LIMIT = 8

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

const fail = (error) => String((error && error.message) || error)

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length)
  let cursor = 0
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      output[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return output
}

export function apply(ctx, config) {
  const store = createStore(config || {})
  const log = (...args) => console.log('[grok3ai]', ...args)

  let settingsSeam = null
  let credentialsSeam = null
  let published = null
  /** 探活缓存：id → {ok, ms, version, error, at} */
  const probes = new Map()
  let ledger = freshLedger(store.state()?.proxyLedger)

  const savedState = store.state() || {}
  if (savedState.probes && typeof savedState.probes === 'object') {
    for (const [id, value] of Object.entries(savedState.probes)) {
      if (value && Number(value.at)) probes.set(id, value)
    }
  }

  const saveLedger = () => {
    try {
      store.patchState({ proxyLedger: ledger })
    } catch (error) {
      log(`账本写盘失败：${fail(error)}`)
    }
  }

  const saveProbes = () => {
    try {
      store.patchState({ probes: Object.fromEntries(probes) })
    } catch (error) {
      log(`探活结果写盘失败：${fail(error)}`)
    }
  }

  // ------------------------------------------------------------ 启用哪些 Space

  const enabledSpaces = () => {
    const cfg = store.config()
    const wanted = Array.isArray(cfg.spaces) ? cfg.spaces.filter(Boolean) : []
    if (wanted.length === 0) return SPACES
    const list = wanted.map((id) => resolveSpace(id)).filter(Boolean)
    return list.length > 0 ? list : SPACES
  }

  // ------------------------------------------------------------ 出口计划

  const transportOptions = () => ({ connectTimeout: Number(store.config().proxyConnectTimeout) || 15000 })

  /** 这一轮按什么顺序试入口。同一个 Space 的多个出口算多个入口。 */
  const buildPlan = (spaceId) => {
    const cfg = store.config()
    const space = resolveSpace(spaceId) || SPACES.find((item) => item.id === DEFAULT_SPACE) || SPACES[0]
    const entries = resolvePool(cfg.proxyPool)
    const base = {
      maxAttempts: Number(cfg.proxyMaxAttempts) || 6,
      rerollSticky: Number(cfg.proxyRerollSticky) || 0,
      rerollRotating: Number(cfg.proxyRerollRotating) || 0,
      timeout: Number(cfg.requestTimeout) || 180000,
      transportOptions: transportOptions(),
      onResult: (route, result) => {
        if (!route || route.id === 'direct') return
        markResult(ledger, { id: route.id, mode: route.mode || 'sticky' }, result || {})
        saveLedger()
      },
    }
    if (cfg.proxyMode !== 'auto' || entries.length === 0) {
      return { ...base, routes: [{ id: 'direct', label: '直连', space, proxy: null, mode: 'sticky' }] }
    }
    const routes = rankEntries(entries, ledger).map((row) => ({
      id: row.entry.id,
      label: row.entry.label,
      space,
      proxy: row.entry.proxy,
      mode: row.entry.mode,
    }))
    if (cfg.proxyAllowDirect !== false) routes.push({ id: 'direct', label: '直连', space, proxy: null, mode: 'sticky' })
    return { ...base, routes }
  }

  // ------------------------------------------------------------ 探活

  const probeOne = async (space, { force = false } = {}) => {
    const cached = probes.get(space.id)
    if (!force && cached && Date.now() - Number(cached.at || 0) < PROBE_TTL) return cached
    const cfg = store.config()
    // 探活故意走直连：它只是读一个 /config，没必要为此消耗一条代理连接
    const result = await probeSpace(space, fetch, { timeout: Math.min(20000, Number(cfg.proxyConnectTimeout) || 12000) })
    const record = {
      ok: Boolean(result.ok),
      ms: Number(result.ms) || 0,
      version: result.version || '',
      mode: result.mode || '',
      status: result.status || 0,
      error: result.error || '',
      at: Date.now(),
    }
    probes.set(space.id, record)
    saveProbes()
    return record
  }

  const probeMany = async (spaces, options) => mapLimit(spaces.slice(0, PROBE_LIMIT), 2, (space) => probeOne(space, options))

  // ------------------------------------------------------------ 面板数据

  const snapshot = () => {
    const cfg = store.config()
    const spaces = enabledSpaces()
    const entries = resolvePool(cfg.proxyPool)
    const pool = summarize(entries, ledger)
    const wantAuto = cfg.proxyMode === 'auto'
    const active = wantAuto && entries.length > 0
    return {
      ok: true,
      relay: { port: relay.port, baseURL: relay.baseURL },
      provider: {
        registered: Boolean(published),
        count: published ? published.count : 0,
        baseURL: published ? published.baseURL : '',
        at: published ? published.at : null,
        providerId: cfg.providerId,
        providerName: cfg.providerName,
      },
      models: spaces.map((space) => ({
        id: space.id,
        name: space.name,
        vendor: space.vendor,
        note: space.note,
        base: space.base,
        fn: space.fn,
        probe: probes.get(space.id) || null,
      })),
      dead: DEAD_SPACES.map((item) => ({ ...item })),
      config: {
        contextChars: cfg.contextChars,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        requestTimeout: cfg.requestTimeout,
        proxyMode: wantAuto ? 'auto' : 'off',
      },
      proxy: {
        mode: wantAuto ? 'auto' : 'off',
        effective: active,
        count: pool.count,
        ready: pool.ready,
        fresh: pool.fresh,
        cooling: pool.cooling,
        rotating: pool.rotating,
        allowDirect: cfg.proxyAllowDirect !== false,
        maxAttempts: cfg.proxyMaxAttempts,
      },
      proxies: pool.rows.map((row) => ({
        id: row.entry.id,
        masked: row.entry.masked,
        label: row.entry.label,
        mode: row.entry.mode,
        template: Boolean(row.entry.template),
        modeText: row.entry.template ? '自换 IP' : row.entry.mode === 'rotating' ? '动态' : '静态',
        state: row.state,
        stateText: stateLabel(row.state),
        ip: (row.stats && row.stats.ip) || '',
        ms: (row.stats && row.stats.ms) || 0,
        used: row.used,
        cooling: row.cooling,
        lastError: (row.stats && row.stats.lastError) || '',
      })),
    }
  }

  // ------------------------------------------------------------ 模型注册

  const publishProvider = async () => {
    if (!settingsSeam || typeof settingsSeam.mutate !== 'function') {
      throw new Error('宿主没有提供 settings 服务，模型注册不了')
    }
    const cfg = store.config()
    const port = await relay.start(cfg.relayPort)
    const baseURL = `http://127.0.0.1:${port}/v1`
    const models = toProviderModels(enabledSpaces())

    if (credentialsSeam && typeof credentialsSeam.set === 'function') {
      await credentialsSeam.set(MODEL_KEY_ENV, cfg.relayToken)
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

    published = { at: Date.now(), count: models.length, baseURL }
    store.patchState({ port, baseURL })
    log(`已注册模型 provider「${cfg.providerName}」：${models.length} 个模型 → ${baseURL}`)
    return published
  }

  const relay = createRelay({
    getConfig: () => store.config(),
    getPlan: (spaceId) => buildPlan(spaceId),
    getModels: () => enabledSpaces(),
    log,
  })

  // ------------------------------------------------------------ 路由

  const routes = [
    { path: '/status', handler: async (req, res) => json(res, 200, snapshot()) },
    {
      /** 探活：只读 /config，不消耗任何额度，也不真正提问。 */
      path: '/probe',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const spaces = enabledSpaces()
          const targets = body.id ? spaces.filter((space) => space.id === String(body.id)) : spaces
          if (targets.length === 0) {
            return json(res, 200, { ...snapshot(), ok: false, error: '没有这个模型' })
          }
          const results = await probeMany(targets, { force: Boolean(body.force) })
          const bad = results.filter((item) => !item.ok)
          const message = `探了 ${results.length} 个：${results.length - bad.length} 个通，${bad.length} 个不通`
          return json(res, 200, {
            ...snapshot(),
            ok: bad.length === 0,
            message,
            ...(bad.length ? { error: `${message}\n${bad.map((item) => item.error).join('\n')}` } : {}),
            results,
          })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      /** 面板上的「试一句」：真打一发，分辨"Space 不行"还是"没注册上"。 */
      path: '/test',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const cfg = store.config()
          const space = resolveSpace(body.model) || enabledSpaces()[0]
          const text = String(body.text || '用一句话说明你是谁')
          const prompt = buildPrompt([{ role: 'user', content: text }], { contextChars: cfg.contextChars })
          const opts = buildOptions(cfg, { max_tokens: 512 })
          const result = await runWithRotation(cfg, { prompt, opts }, {}, buildPlan(space.id))
          if (!result.ok) {
            return json(res, 200, {
              ok: false,
              status: result.status || 0,
              code: result.code,
              model: space.id,
              route: result.route ? result.route.label : '',
              switches: result.switches || 0,
              elapsed: result.elapsed || 0,
              error: explainFailure(result),
              raw: String(result.message || '').slice(0, 300),
            })
          }
          return json(res, 200, {
            ok: true,
            status: 200,
            model: space.id,
            route: result.route ? result.route.label : '',
            switches: result.switches || 0,
            elapsed: result.elapsed,
            text: String(result.text || '').slice(0, 1200),
          })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      path: '/models/register',
      handler: async (req, res) => {
        try {
          const result = await publishProvider()
          return json(res, 200, { ...snapshot(), ok: true, published: result })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      path: '/relay/restart',
      handler: async (req, res) => {
        try {
          relay.close()
          const port = await relay.start(store.config().relayPort)
          const result = await publishProvider()
          return json(res, 200, { ...snapshot(), ok: true, message: `反代换到 127.0.0.1:${port}`, published: result })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      /** 启用/停用某个 Space（写 config.spaces）。 */
      path: '/spaces/enable',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const id = String(body.id || '')
          const space = resolveSpace(id)
          if (!space) return json(res, 200, { ...snapshot(), ok: false, error: `没这个模型：${id}` })
          const on = body.enabled !== false
          const current = enabledSpaces().map((item) => item.id)
          const next = on ? Array.from(new Set([...current, space.id])) : current.filter((item) => item !== space.id)
          if (next.length === 0) {
            return json(res, 200, { ...snapshot(), ok: false, error: '至少留一个模型' })
          }
          store.patchConfig({ spaces: next })
          await publishProvider().catch(() => null)
          return json(res, 200, { ...snapshot(), ok: true, message: `${space.name} 已${on ? '启用' : '停用'}` })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      path: '/proxy/save',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const clear = Boolean(body.clear)
          const text = String(body.text || '')
          const parsed = parsePoolText(clear ? '' : text)
          if (!clear && parsed.entries.length === 0 && parsed.errors.length === 0) {
            return json(res, 200, { ...snapshot(), ok: false, error: '一行代理都没有，没保存。要清空请用「清空」' })
          }
          const pool = parsed.entries.map((entry) => entry.spec)
          store.patchConfig({ proxyPool: pool })
          if (body.mode === 'auto' || body.mode === 'off') store.patchConfig({ proxyMode: body.mode })
          const bad = parsed.errors
          const message = clear
            ? '出口池已清空'
            : `已保存 ${pool.length} 个出口${bad.length ? `，${bad.length} 行没看懂（第 ${bad.map((item) => item.line).join('、')} 行）` : ''}`
          return json(res, 200, {
            ...snapshot(),
            ok: bad.length === 0,
            message,
            ...(bad.length ? { error: `${message}\n${bad.map((item) => `第 ${item.line} 行：${item.message}`).join('\n')}` } : {}),
            errors: bad,
          })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      path: '/proxy/mode',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const mode = body.mode === 'auto' ? 'auto' : 'off'
          const cfg = store.patchConfig({ proxyMode: mode })
          const count = resolvePool(cfg.proxyPool).length
          const message =
            mode === 'auto'
              ? count > 0
                ? `已开启自动换出口（${count} 个）`
                : '已开启，但池子是空的 —— 先粘几行代理进去'
              : '已关闭，只走直连'
          return json(res, 200, { ...snapshot(), ok: true, message })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      /** 测出口：能出去 + 出口 IP（不碰 Space，不消耗任何东西）。 */
      path: '/proxy/test',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const cfg = store.config()
          const entries = resolvePool(cfg.proxyPool)
          const targets = body.id ? entries.filter((entry) => entry.id === String(body.id)) : entries
          if (targets.length === 0) return json(res, 200, { ...snapshot(), ok: false, error: '池子里没有这个出口' })
          const results = await mapLimit(targets.slice(0, PROBE_LIMIT), 3, async (entry) => {
            const started = Date.now()
            const exit = await probeExitIp(entry.proxy, cfg.probeUrl, { connectTimeout: 12000 })
            markProbe(ledger, entry, { credits: null, bonus: '', ip: exit.ok ? exit.ip : '', ms: Date.now() - started, ...(exit.ok ? {} : { error: exit.error }) })
            saveLedger()
            return { id: entry.id, ok: exit.ok, ip: exit.ip || '', ms: Date.now() - started, error: exit.error || '' }
          })
          const bad = results.filter((item) => !item.ok)
          const message = `测了 ${results.length} 个：${results.length - bad.length} 个通，${bad.length} 个不通`
          return json(res, 200, {
            ...snapshot(),
            ok: bad.length === 0,
            message,
            ...(bad.length ? { error: `${message}\n${bad.map((item) => `${item.id}：${item.error}`).join('\n')}` } : {}),
            results,
          })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      path: '/proxy/remove',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const entries = resolvePool(store.config().proxyPool)
          const keep = entries.filter((entry) => entry.id !== String(body.id || '')).map((entry) => entry.spec)
          store.patchConfig({ proxyPool: keep })
          return json(res, 200, { ...snapshot(), ok: true, message: `已删掉，剩 ${keep.length} 个` })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
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

  ctx.inject(['settings', 'credentials'], (seamCtx) => {
    settingsSeam = (seamCtx && seamCtx.settings) || null
    credentialsSeam = (seamCtx && seamCtx.credentials) || null
    publishProvider().catch((error) => log(`启动时注册模型失败：${fail(error)}`))
    if (store.config().probeOnStart === false) return
    probeMany(enabledSpaces())
      .then((results) => {
        const bad = results.filter((item) => !item.ok)
        log(`Space 探活：${results.length - bad.length}/${results.length} 个可用${bad.length ? `（不通：${bad.map((i) => i.error).join('；')}）` : ''}`)
      })
      .catch((error) => log(`开机探活失败（不影响使用）：${fail(error)}`))
  })

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => relay.close())
    } catch {
      /* 老版本没有 dispose 事件 */
    }
  }
}

/** 面板/冒烟用得到的一个小工具：不启动宿主也能真跑一发。 */
export { runSpace, probeSpace, buildPrompt, buildOptions }
