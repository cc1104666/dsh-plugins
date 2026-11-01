/**
 * dsh-grok-online —— 宿主半区（Node 侧）。
 *
 * 一句话：把 grok.online 的免费对话额度，变成 DSH 模型选择器里的两个模型。
 *
 * 和前面两个插件的关系：
 *   dsh-vibex-vision  要本地补站点专用头 → 有反代
 *   dsh-lightvela     网关本身 OpenAI 兼容 → 没有反代
 *   dsh-grok-online   上游是自定义接口 + 自带 SSE 格式 → **必须有反代**（翻译层）
 *
 * 另外它不需要任何凭据：站点没有登录、不发 cookie、不要 key。额度按出口 IP 记，
 * 每天 4 条，用完可以再领 5 条奖励。这件事必须让用户一眼看见，否则用两次就会
 * 以为插件坏了 —— 所以面板第一块就是额度，且把「UTC 零点重置」写清楚。
 *
 * 出口池（②）是后来加的：既然额度按 IP 记，那就把"从哪个 IP 出去"做成一个池子，
 * 一个出口用完自动换下一个。注意它不是"无限次"——
 *   静态代理 N 个 → 9N 条/天；
 *   动态隧道代理   → 每次连接换出口，实际上是"每次请求一份新额度"，但能拿多少
 *                    取决于代理商和站点的风控，插件不承诺数字。
 */
import { DEFAULT_MODEL, MODELS, LOCKED_MODELS, toProviderModels } from './models.js'
import { buildGrokPayload, explainFailure, fetchCredits, unlockBonus } from './upstream.js'
import { createRelay } from './relay.js'
import { createStore, utcDay } from './store.js'
import { makeFetcher, probeExitIp } from './proxy-agent.js'
import { chatWithRotation } from './rotate.js'
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

export const name = 'grok-online'

const BASE = '/plugins/dsh-grok-online'
const MAX_BODY = 1024 * 1024
const MODEL_KEY_ENV = 'GROK_ONLINE_API_KEY'
/** 面板里「测试全部」一次最多测几个，防止一口气打几百个连接。 */
const PROBE_LIMIT = 12
/** 启动时顺手探几个出口，别开机就把整个池子刷一遍。 */
const BOOT_PROBE_LIMIT = 4

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

/** 限并发的 map —— 代理池探测必须限，不然 50 个出口会同时开 50 条连接。 */
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
  const log = (...args) => console.log('[grok-online]', ...args)

  let settingsSeam = null
  let credentialsSeam = null
  /** 上次注册进 llm-pi-ai 的结果。 */
  let published = null
  /** 直连额度：内存里保一份，写盘的那份给"下次开面板首帧"用。 */
  let quota = null
  /** 出口账本：每个代理今天还剩几条、上个 IP 是什么、在不在冷却。 */
  let ledger = freshLedger(store.state()?.proxyLedger)

  const saveLedger = () => {
    try {
      store.patchState({ proxyLedger: ledger })
    } catch (error) {
      log(`账本写盘失败：${fail(error)}`)
    }
  }

  // ------------------------------------------------------------ 额度 / 账本

  const setQuota = (credits, bonus) => {
    if (!Number.isFinite(Number(credits))) return
    quota = { credits: Number(credits), bonus: bonus || '', day: utcDay() }
    store.patchState(quota)
  }

  const hydrateQuota = () => {
    if (quota) return quota
    const saved = store.state()
    if (saved && Number.isFinite(Number(saved.credits))) {
      quota = { credits: Number(saved.credits), bonus: saved.bonus || '', day: saved.day }
    }
    return quota
  }

  /**
   * 每一次真实请求的结果都要落账。
   * 直连没有出口 id，它的额度就是面板顶部那个数字；代理出口各记各的。
   */
  const recordResult = (route, result) => {
    if (!route) return
    if (route.id === 'direct') {
      if (result && result.credits !== undefined && result.credits !== null) {
        setQuota(result.credits, result.bonus)
      }
      return
    }
    markResult(ledger, { id: route.id, mode: route.mode || 'sticky' }, result || {})
    saveLedger()
  }

  const recordCredits = (credits, bonus, route) => {
    if (!Number.isFinite(Number(credits))) return
    if (!route || route.id === 'direct') {
      setQuota(credits, bonus)
      return
    }
    markProbe(ledger, { id: route.id, mode: route.mode || 'sticky' }, { credits, bonus })
    saveLedger()
  }

  // ------------------------------------------------------------ 出口计划

  const transportOptions = () => ({ connectTimeout: Number(store.config().proxyConnectTimeout) || 15000 })

  /** 这一轮按什么顺序试出口。面板和 relay 用的是同一套排序。 */
  const buildPlan = () => {
    const cfg = store.config()
    const entries = resolvePool(cfg.proxyPool)
    const base = {
      onResult: recordResult,
      maxAttempts: Number(cfg.proxyMaxAttempts) || 10,
      rerollSticky: Number(cfg.proxyRerollSticky) || 0,
      rerollRotating: Number(cfg.proxyRerollRotating) || 0,
      transportOptions: transportOptions(),
    }
    if (cfg.proxyMode !== 'auto' || entries.length === 0) {
      return { ...base, routes: [{ id: 'direct', label: '直连', proxy: null, mode: 'sticky' }] }
    }
    const routes = rankEntries(entries, ledger).map((row) => ({
      id: row.entry.id,
      label: row.entry.label,
      proxy: row.entry.proxy,
      mode: row.entry.mode,
    }))
    if (cfg.proxyAllowDirect !== false) {
      routes.push({ id: 'direct', label: '直连', proxy: null, mode: 'sticky' })
    }
    return { ...base, routes }
  }

  /** 探一个出口：查额度（不消耗）+ 尽力看一眼出口 IP。 */
  const probeEntry = async (entry) => {
    const cfg = store.config()
    const started = Date.now()
    try {
      const fetcher = makeFetcher(entry.proxy, { connectTimeout: Number(cfg.proxyConnectTimeout) || 15000 })
      const credits = await fetchCredits(cfg, fetcher)
      // 住宅出口慢，8 秒经常不够；这一步只影响面板上那一列 IP，失败也不影响使用
      const exit = await probeExitIp(entry.proxy, cfg.proxyProbeUrl, {
        connectTimeout: Math.max(8000, Math.min(15000, Number(cfg.proxyConnectTimeout) || 15000)),
      })
      markProbe(ledger, entry, {
        credits: credits.credits,
        bonus: credits.bonus,
        ip: exit.ok ? exit.ip : '',
        ms: Date.now() - started,
      })
      return {
        id: entry.id,
        ok: true,
        credits: credits.credits,
        bonus: credits.bonus,
        ip: exit.ok ? exit.ip : '',
        ms: Date.now() - started,
        note: exit.ok ? '' : `连上了，但查不到出口 IP（${exit.error || '未知'}）`,
      }
    } catch (error) {
      markProbe(ledger, entry, { credits: null, bonus: '', error: fail(error), ms: Date.now() - started })
      return { id: entry.id, ok: false, ms: Date.now() - started, error: fail(error) }
    } finally {
      saveLedger()
    }
  }

  const probeMany = async (entries) => {
    if (entries.length === 0) return []
    return mapLimit(entries.slice(0, PROBE_LIMIT), 3, probeEntry)
  }

  // ------------------------------------------------------------ 面板数据

  const snapshot = () => {
    const cfg = store.config()
    const saved = hydrateQuota()
    const entries = resolvePool(cfg.proxyPool)
    const pool = summarize(entries, ledger)
    const wantAuto = cfg.proxyMode === 'auto'
    // 开关是"想不想自动换"，effective 是"现在真的会换吗"（池子空的时候不会）
    const active = wantAuto && entries.length > 0
    return {
      ok: true,
      /** 直连今天还剩几条（不知道就是 null，别假装 0）。 */
      credits: saved ? saved.credits : null,
      bonus: saved ? saved.bonus || '' : '',
      day: saved ? saved.day : utcDay(),
      quota: {
        free: 4,
        bonus: 5,
        total: 9,
        reset: 'UTC 零点（北京时间 08:00）重置',
        by: '按出口 IP 记，不需要登录',
      },
      relay: {
        port: relay.port,
        baseURL: relay.baseURL,
      },
      provider: {
        registered: Boolean(published),
        count: published ? published.count : 0,
        baseURL: published ? published.baseURL : '',
        at: published ? published.at : null,
        providerId: cfg.providerId,
        providerName: cfg.providerName,
      },
      models: MODELS.map((item) => ({ ...item })),
      locked: LOCKED_MODELS.map((item) => ({ ...item })),
      config: {
        siteBase: cfg.siteBase,
        contextChars: cfg.contextChars,
        proxyMode: wantAuto ? 'auto' : 'off',
        proxyConnectTimeout: cfg.proxyConnectTimeout,
      },
      proxy: {
        mode: wantAuto ? 'auto' : 'off',
        effective: active,
        count: pool.count,
        known: pool.known,
        ready: pool.ready,
        fresh: pool.fresh,
        empty: pool.empty,
        cooling: pool.cooling,
        rotating: pool.rotating,
        totalCredits: pool.totalCredits,
        allowDirect: cfg.proxyAllowDirect !== false,
        maxAttempts: cfg.proxyMaxAttempts,
        rerollRotating: cfg.proxyRerollRotating,
        rerollSticky: cfg.proxyRerollSticky,
        probeLimit: PROBE_LIMIT,
      },
      proxies: pool.rows.map((row) => ({
        id: row.entry.id,
        masked: row.entry.masked,
        label: row.entry.label,
        mode: row.entry.mode,
        // template = 账号里带 `{session}`，每发请求自己换会话；这种才是真正意义上的"无限"
        template: Boolean(row.entry.template),
        modeText: row.entry.template ? '自换 IP' : row.entry.mode === 'rotating' ? '动态' : '静态',
        protocol: row.entry.protocol,
        state: row.state,
        stateText: stateLabel(row.state),
        credits: row.credits,
        bonus: row.bonus,
        ip: (row.stats && row.stats.ip) || '',
        ms: (row.stats && row.stats.ms) || 0,
        used: row.used,
        cooling: row.cooling,
        lastError: (row.stats && row.stats.lastError) || '',
      })),
    }
  }

  // ------------------------------------------------------------ 模型注册

  /** 把 provider 写进 llm-pi-ai。baseURL 指向本机反代。 */
  const publishProvider = async () => {
    if (!settingsSeam || typeof settingsSeam.mutate !== 'function') {
      throw new Error('宿主没有提供 settings 服务，模型注册不了')
    }
    const cfg = store.config()
    const port = await relay.start(cfg.relayPort)
    const baseURL = `http://127.0.0.1:${port}/v1`
    const models = toProviderModels(MODELS)

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
    getPlan: () => buildPlan(),
    log,
    onCredits: ({ credits, bonus, route }) => recordCredits(credits, bonus, route),
  })

  // ------------------------------------------------------------ 路由

  const routes = [
    {
      path: '/status',
      handler: async (req, res) => json(res, 200, snapshot()),
    },
    {
      path: '/credits/refresh',
      handler: async (req, res) => {
        try {
          const result = await fetchCredits(store.config())
          setQuota(result.credits, result.bonus)
          return json(res, 200, { ...snapshot(), ok: true })
        } catch (error) {
          return json(res, 200, { ...snapshot(), ok: false, error: fail(error) })
        }
      },
    },
    {
      path: '/credits/unlock',
      handler: async (req, res) => {
        try {
          const result = await unlockBonus(store.config())
          if (result.credits !== null) setQuota(result.credits, result.bonus)
          const message = result.ok
            ? `领到了，现在还剩 ${result.credits} 条`
            : result.code === 'bonus_locked'
              ? '今天还有剩余额度，等用到 0 才能领这 5 条'
              : result.code === 'bonus_used'
                ? '今天的 5 条奖励已经领过了'
                : `领取失败：${result.message || result.code}`
          return json(res, 200, { ...snapshot(), ok: result.ok, message })
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
      /** 保存出口池。text 是整段原文，一行一个；clear=true 才是清空。 */
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
      /** 切开关。 */
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
      /** 探测：不传 id 就测全部（最多 12 个）。不消耗额度。 */
      path: '/proxy/test',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const entries = resolvePool(store.config().proxyPool)
          const targets = body.id ? entries.filter((entry) => entry.id === String(body.id)) : entries
          if (targets.length === 0) {
            return json(res, 200, { ...snapshot(), ok: false, error: '池子里没有这个出口' })
          }
          const results = await probeMany(targets)
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
    {
      /** 面板上的「试一句」：真打一发，用来分辨"模型不行"还是"没注册上"。会走出口池。 */
      path: '/test',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, MAX_BODY)
          const model = String(body.model || DEFAULT_MODEL)
          const text = String(body.text || '用一句话说明你是谁')
          const payload = buildGrokPayload(store.config(), {
            model,
            messages: [{ role: 'user', content: text }],
          })
          const result = await chatWithRotation(store.config(), payload, {}, buildPlan())
          if (!result.ok) {
            return json(res, 200, {
              ok: false,
              status: result.status,
              code: result.code,
              model: payload.model,
              route: result.route ? result.route.label : '',
              switches: result.switches || 0,
              error: explainFailure(result),
              raw: String(result.message || '').slice(0, 300),
            })
          }
          return json(res, 200, {
            ok: true,
            status: 200,
            elapsed: result.elapsed,
            model: payload.model,
            route: result.route ? result.route.label : '',
            switches: result.switches || 0,
            text: String(result.text || '').slice(0, 800),
            reasoning: String(result.reasoning || '').slice(0, 300),
            credits: result.credits,
          })
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

  /**
   * 启动就把反代起来 + 把 provider 写一遍。
   *
   * 为什么开机就写：llm-pi-ai 的 providers 是宿主配置，profile 重建/插件重装会丢；
   * 重写一次几乎零成本，换来"重装插件后选择器里还在"。反代端口也顺手记进 state，
   * 万一这次端口变了，面板能看出是新的。
   */
  ctx.inject(['settings', 'credentials'], (seamCtx) => {
    settingsSeam = (seamCtx && seamCtx.settings) || null
    credentialsSeam = (seamCtx && seamCtx.credentials) || null
    publishProvider().catch((error) => log(`启动时注册模型失败：${fail(error)}`))
    // 顺手拿一次额度，让面板首帧就是准的（失败不影响启动）
    fetchCredits(store.config())
      .then((result) => {
        setQuota(result.credits, result.bonus)
        log(`今日剩余额度：${result.credits}（bonus ${result.bonus || '-'}）`)
      })
      .catch((error) => log(`开机查额度失败（不影响使用）：${fail(error)}`))

    // 出口池开着才探，而且只探前几个 —— 开机不该卡在网络探测上
    const cfg = store.config()
    if (cfg.proxyMode === 'auto') {
      const entries = resolvePool(cfg.proxyPool).slice(0, BOOT_PROBE_LIMIT)
      if (entries.length > 0) {
        probeMany(entries)
          .then((results) => {
            const bad = results.filter((item) => !item.ok)
            log(`出口池：${results.length - bad.length}/${results.length} 个可用`)
          })
          .catch((error) => log(`开机探出口失败（不影响使用）：${fail(error)}`))
      }
    }
  })

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => relay.close())
    } catch {
      /* 老版本没有 dispose 事件，忽略 */
    }
  }
}
