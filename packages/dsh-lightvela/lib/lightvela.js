/**
 * LightVela 的 HTTP 客户端核心。
 *
 * 这个文件只做一件事：把「一个网页登录态」变成「一组可用的模型」。
 *
 * 链路（全部实测过）：
 *   start  → GET  /auth/oauth/wechat/start      拿 state + 4 个 oauth 校验 cookie
 *          → GET  open.weixin.qq.com/connect/qrconnect   拿 uuid
 *   poll   → GET  lp.open.weixin.qq.com/connect/l/qrconnect?uuid=…   长轮询 15s
 *   finish → GET  /auth/oauth/wechat/callback?code=&state=   换 lc_session
 *   key    → POST /v1/instances/{id}/debug/exec   在沙箱里读 ~/.hermes/.env
 *
 * 为什么最后一步要进沙箱：
 * LightVela 不是模型网关，它卖的是「云上跑 Hermes Agent 的实例」。模型额度
 * （它叫 AI 积分）是平台代付的，凭据只在实例里以 CUSTOM_API_KEY 的形式存在，
 * 没有任何对外发放 API Key 的接口。所以要拿它的模型，只能到它自己的实例里取。
 */

const WX_QR_BASE = 'https://open.weixin.qq.com/connect/qrcode'
const WX_POLL_BASE = 'https://lp.open.weixin.qq.com/connect/l/qrconnect'

/** 微信扫码状态机。和公众号带参二维码不同，网页应用是标准 OAuth。 */
export const SCAN_STATE = {
  PENDING: 'pending', // 还没人扫
  SCANNED: 'scanned', // 扫了，等手机上点确认
  CONFIRMED: 'confirmed', // 确认了，拿到 code
  EXPIRED: 'expired', // 二维码过期
  CANCELLED: 'cancelled', // 手机上点了取消
}

/**
 * 微信开放平台的扫码结果编码：
 *   408 = 这轮长轮询超时（什么都没发生，继续轮）
 *   404 = 二维码还没被扫
 *   405 = 扫了，等用户点「确认登录」
 *   403 = 用户点了取消
 *   0/402 = 成功，wx_code 里是授权码
 */
function decodeWxErrcode(code) {
  switch (code) {
    case 408:
      return SCAN_STATE.PENDING
    case 404:
      return SCAN_STATE.PENDING
    case 405:
      return SCAN_STATE.SCANNED
    case 403:
      return SCAN_STATE.CANCELLED
    case 0:
    case 402:
      return SCAN_STATE.CONFIRMED
    default:
      return null
  }
}

/** 把 Set-Cookie 头摘成 { name, value } 列表。Node 22 有 getSetCookie()。 */
export function readSetCookies(response) {
  let raw = []
  try {
    if (typeof response.headers.getSetCookie === 'function') raw = response.headers.getSetCookie()
  } catch {
    raw = []
  }
  if (raw.length === 0) {
    const single = response.headers.get('set-cookie')
    if (single) raw = [single]
  }
  const out = []
  for (const line of raw) {
    const head = String(line || '').split(';')[0]
    const eq = head.indexOf('=')
    if (eq <= 0) continue
    const name = head.slice(0, eq).trim()
    const value = head.slice(eq + 1).trim()
    if (name === '') continue
    out.push({ name, value })
  }
  return out
}

export function cookieHeader(jar) {
  if (!jar) return ''
  if (typeof jar === 'string') return jar
  if (Array.isArray(jar)) return jar.map((c) => `${c.name}=${c.value}`).join('; ')
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

function mergeCookies(jar, fresh) {
  const map = new Map()
  const add = (c) => {
    if (c && c.name) map.set(c.name, c.value)
  }
  if (Array.isArray(jar)) jar.forEach(add)
  else if (jar && typeof jar === 'object') Object.entries(jar).forEach(([name, value]) => add({ name, value }))
  fresh.forEach(add)
  return Object.fromEntries(map)
}

/** 从二维码页面 HTML 里揪出 uuid。页面里就一个 `connect/qrcode/<uuid>` 真实链接。 */
export function extractUuid(html) {
  const match = String(html || '').match(/connect\/qrcode\/([A-Za-z0-9_-]{8,})/)
  return match ? match[1] : ''
}

/** 解析 `window.wx_errcode=408;window.wx_code='';` 这种响应。 */
export function parseWxPoll(text) {
  const errcode = /wx_errcode\s*=\s*(-?\d+)/.exec(String(text || ''))
  const code = /wx_code\s*=\s*'([^']*)'/.exec(String(text || ''))
  return {
    errcode: errcode ? Number(errcode[1]) : null,
    code: code ? code[1] : '',
  }
}

/**
 * 第一步：申请扫码。
 * 返回 state（回调要用）、uuid（出二维码用）、cookies（回调时要带回去校验）。
 */
export async function startWechatScan(config) {
  const url =
    `${config.apiBase}/auth/oauth/wechat/start` +
    `?mode=website&return_to=${encodeURIComponent(config.returnTo)}`

  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'user-agent': config.userAgent, accept: 'text/html' },
  })

  const cookies = readSetCookies(response)
  const location = response.headers.get('location') || ''
  const stateInUrl = /[?&]state=([A-Za-z0-9]+)/.exec(location)
  const state = stateInUrl ? stateInUrl[1] : ''
  if (!state) {
    throw new Error(`申请微信扫码失败（HTTP ${response.status}）：没拿到 state，站点接口可能改了`)
  }

  // 微信那个页面里带着 uuid；不请求它就不知道二维码对应哪次会话。
  const page = await fetch(location, {
    method: 'GET',
    headers: { 'user-agent': config.userAgent, referer: 'https://lightvela.com/' },
  })
  const html = await page.text()
  const uuid = extractUuid(html)
  if (!uuid) {
    throw new Error(`申请微信扫码失败：微信页面里找不到 uuid（HTTP ${page.status}）`)
  }

  return {
    state,
    uuid,
    cookies,
    qrUrl: `${WX_QR_BASE}/${uuid}`,
    qrPageUrl: location,
    expireAt: Date.now() + 300 * 1000,
  }
}

/** 一轮长轮询（微信自己会挂 15 秒左右）。 */
export async function pollWechatScan(config, uuid, signal) {
  const url = `${WX_POLL_BASE}?uuid=${encodeURIComponent(uuid)}&_=${Date.now()}`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'user-agent': config.userAgent,
      referer: 'https://open.weixin.qq.com/',
    },
    signal,
  })
  const text = await response.text()
  const parsed = parseWxPoll(text)
  return {
    ...parsed,
    status: decodeWxErrcode(parsed.errcode),
    raw: text.slice(0, 200),
  }
}

/**
 * 第三步：拿 code 去换 LightVela 的会话。
 * 回调要带 start 时那 4 个 oauth cookie（state / mode / scope / return_to），少一个都会被拒。
 */
export async function finishWechatScan(config, ticket, code) {
  const url =
    `${config.apiBase}/auth/oauth/wechat/callback` +
    `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(ticket.state)}`

  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'user-agent': config.userAgent,
      cookie: cookieHeader(ticket.cookies),
      accept: 'text/html',
    },
  })

  const fresh = readSetCookies(response)
  const merged = mergeCookies(ticket.cookies, fresh)
  const session = fresh.find((c) => c.name === 'lc_session') || (merged.lc_session ? { name: 'lc_session', value: merged.lc_session } : null)

  if (!session) {
    const location = response.headers.get('location') || ''
    throw new Error(
      `微信授权换会话失败（HTTP ${response.status}）` +
        (location ? `：站点把请求转去了 ${location.slice(0, 120)}` : '：没有下发 lc_session'),
    )
  }

  return {
    sessionToken: session.value,
    cookies: merged,
    location: response.headers.get('location') || '',
  }
}

/** 用会话换用户信息。顺带确认这把会话是真的能用。 */
export async function fetchSession(config, sessionToken) {
  const response = await fetch(`${config.apiBase}/auth/session`, {
    headers: {
      'user-agent': config.userAgent,
      cookie: `lc_session=${sessionToken}`,
      origin: config.siteBase,
    },
  })
  if (response.status === 401) return { ok: false, status: 401, note: '会话已失效，需要重新扫码' }
  if (!response.ok) return { ok: false, status: response.status, note: `HTTP ${response.status}` }
  const payload = await response.json().catch(() => null)
  const user = payload && payload.session ? payload.session.user : null
  return { ok: true, status: response.status, user, sessionToken: payload && payload.session ? payload.session.sessionToken : '' }
}

/** 列出实例。模型凭据就藏在实例的沙箱里，所以第一步是找到它。 */
export async function listInstances(config, sessionToken) {
  const response = await fetch(`${config.apiBase}/v1/instances?page=1&page_size=100`, {
    headers: {
      'user-agent': config.userAgent,
      cookie: `lc_session=${sessionToken}`,
      origin: config.siteBase,
    },
  })
  if (!response.ok) {
    throw new Error(`读实例列表失败：HTTP ${response.status}`)
  }
  const payload = await response.json().catch(() => null)
  const items = payload && payload.data && Array.isArray(payload.data.items) ? payload.data.items : []
  return items.map((item) => ({
    instanceId: item.instance_id,
    name: item.name || item.instance_id,
    status: item.status || '',
    sandboxId: item.sandbox_id || '',
    createdAt: item.created_at || '',
  }))
}

/** 在实例沙箱里跑一条 sh 命令。这是官方前端自己的调试通道，鉴权与登录态一致。 */
export async function execInSandbox(config, sessionToken, instanceId, command) {
  const response = await fetch(`${config.apiBase}/v1/instances/${encodeURIComponent(instanceId)}/debug/exec`, {
    method: 'POST',
    headers: {
      'user-agent': config.userAgent,
      cookie: `lc_session=${sessionToken}`,
      origin: config.siteBase,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ command }),
  })
  if (!response.ok) {
    throw new Error(`在沙箱里执行命令失败：HTTP ${response.status}`)
  }
  const payload = await response.json().catch(() => null)
  const data = payload && payload.data ? payload.data : {}
  return {
    status: data.status || '',
    exitCode: typeof data.exit_code === 'number' ? data.exit_code : null,
    output: typeof data.output === 'string' ? data.output : '',
  }
}

/**
 * 从沙箱里把模型凭据挖出来。
 *
 * 取的是 ~/.hermes/config.yaml 里的 model.base_url + ~/.hermes/.env 里的 CUSTOM_API_KEY。
 * 这两样是 Hermes 调模型时真正用的东西 —— 也就是说，拿到的就是「LightVela 给你
 * 这个实例配的那把钥匙」，包含套餐积分代付的额度。
 *
 * 只认 base_url 落在 token.lightvela.com 的情况。如果用户在 LightVela 里改成了
 * 自己的服务商（BYOB），那把 key 是他自己的，拿出去也没有意义，这里如实报告。
 */
export async function pullSandboxKey(config, sessionToken, instanceId) {
  const script = [
    'set -a',
    '. ~/.hermes/.env 2>/dev/null || true',
    'set +a',
    'echo "__BASE__=${CUSTOM_BASE_URL:-}"',
    'echo "__KEY__=${CUSTOM_API_KEY:-}"',
    'echo "__YAML_BASE__=$(sed -n "s/^[[:space:]]*base_url:[[:space:]]*//p" ~/.hermes/config.yaml 2>/dev/null | head -1)"',
    'echo "__MODEL__=$(sed -n "s/^[[:space:]]*default:[[:space:]]*//p" ~/.hermes/config.yaml 2>/dev/null | head -1)"',
  ].join('\n')

  const result = await execInSandbox(config, sessionToken, instanceId, script)
  const read = (tag) => {
    const match = new RegExp(`^__${tag}__=(.*)$`, 'm').exec(result.output || '')
    return match ? match[1].trim() : ''
  }

  const envBase = read('BASE')
  const yamlBase = read('YAML_BASE')
  const apiKey = read('KEY')
  const defaultModel = read('MODEL')
  const baseUrl = yamlBase || envBase

  const isLightvela = /token\.lightvela\.(com|ai)/i.test(baseUrl)

  if (!apiKey) {
    return {
      ok: false,
      code: 'no_key',
      baseUrl,
      defaultModel,
      note: '实例里没有 CUSTOM_API_KEY —— 可能这个 Bot 还没配模型，或者实例没跑起来',
    }
  }
  if (!isLightvela) {
    return {
      ok: false,
      code: 'byob',
      baseUrl,
      defaultModel,
      apiKey,
      note: `这个实例用的是你自己的服务商（${baseUrl || '未配置'}），不是 LightVela 的套餐网关，拿出去用没有意义`,
    }
  }

  return { ok: true, baseUrl, apiKey, defaultModel, envBase }
}

/** 读网关的模型清单。LightVela 的网关是 OpenAI 兼容的，直接 /v1/models。 */
export async function listGatewayModels(config, baseUrl, apiKey) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (response.status === 401) {
    throw new Error('网关不认这把钥匙（401）——实例可能重建过，回面板重新拉一次')
  }
  if (!response.ok) {
    throw new Error(`读模型清单失败：HTTP ${response.status}`)
  }
  const payload = await response.json().catch(() => null)
  const rows = payload && Array.isArray(payload.data) ? payload.data : []
  return rows.map((row) => ({ id: row.id, ownedBy: row.owned_by || '' }))
}

/** 打一发最小请求，确认这把钥匙真的能出字。 */
export async function probeChat(config, baseUrl, apiKey, model) {
  const startedAt = Date.now()
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '回复两个字：可用' }],
      max_tokens: 16,
    }),
  })
  const text = await response.text()
  const elapsed = Date.now() - startedAt
  return {
    ok: response.ok,
    status: response.status,
    elapsed,
    raw: text.slice(0, 600),
    body: safeJson(text),
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const WECHAT_POLL_INTERVAL = 1200
