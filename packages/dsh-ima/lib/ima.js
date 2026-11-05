/**
 * ima.qq.com 的 HTTP 客户端核心。
 *
 * 全部结构从官方前端产物里核对过（fe-static.ima.myqcloud.com 的 app bundle）：
 *
 *   业务前缀    {siteBase}/cgi-bin/
 *   免登录模型  POST /cgi-bin/intelligent_assistant_http_nl/get_models   → 4 个官方模型
 *   登录        POST /cgi-bin/auth_login/login       {account_type:2, code, auth_appid, client_info}
 *               （LoginHttpService 的 urlPrefix 是 "auth_login"，不是裸 /cgi-bin —— 实测裸路径 404）
 *   换票        POST /cgi-bin/auth_login/refresh     {refresh_token}
 *   会话        POST /cgi-bin/init_session / get_session / del_session
 *   对话（SSE）  POST /cgi-bin/assistant/qa    命名事件流
 *
 * 鉴权不在 Cookie 里，在三个自定义头（官方叫 headerService）：
 *   x-ima-cookie: IMA-UID=..; IMA-TOKEN=..; IMA-REFRESH-TOKEN=..; UID-TYPE=..; TOKEN-TYPE=..
 *                 ; IMA-GUID=..; IMA-Q36=..; IMA-IUA=..; PLATFORM=H5; CLIENT-TYPE=..; WEB-VERSION=..
 *   from_browser_ima: 1
 *   x-ima-bkn:   bkn(IMA-TOKEN) —— 经典 QQ g_tk：e=5381; e += (e<<5)+code; e & 2147483647
 *
 * SSE 事件（jsonEvents 白名单里挑要紧的）：
 *   SESSION_START {MsgSeqID}      开始
 *   MESSAGE       {Text}          正文（增量 / 快照未定，relay 里做 diff 兜底）
 *   THINKING      {…}             思考过程
 *   COMPLETED     {Code,Msg,…}    结束（Code=0 成功）
 *   PROGRESSING   {…}             阶段提示（深度搜索之类）
 *
 * /cgi-bin/s/ 那条加密链路（x-ima-cm/x-ima-ckey）只有桌面终端 < 2.5.0 的 bridge 才能走，
 * 网页端一律明文 /cgi-bin/，我们照网页端来。
 */

const WX_QR_PAGE = 'https://open.weixin.qq.com/connect/qrconnect'
const WX_QR_IMAGE = 'https://open.weixin.qq.com/connect/qrcode'
const WX_POLL = 'https://lp.open.weixin.qq.com/connect/l/qrconnect'

/** 登录账号类型（前端 LS 枚举）：WX=2。 */
export const ACCOUNT_TYPE_WX = 2
/** client_info.platform（前端 ck 枚举）：网页登录页伪装成 MAC=4。 */
export const PLATFORM_MAC = 4
/** 主对话 robotType（前端 Xs 枚举 Main=10000）。 */
export const ROBOT_MAIN = 10000
/** 会话类型：Child=0（单会话，不建父子结构）。 */
export const SESSION_CHILD = 0
/** questionType：Input=2（用户手输）。 */
export const QUESTION_INPUT = 2

/** 经典 QQ bkn（g_tk）。对 token 全量哈希。 */
export function bkn(token) {
  try {
    let hash = 5381
    const text = String(token || '')
    for (let i = 0; i < text.length; i += 1) {
      hash += (hash << 5) + text.charCodeAt(i)
    }
    return hash & 2147483647
  } catch {
    return 0
  }
}

/** 驼峰 → 下划线（官方 ye 序列化器干的事，递归一层就够，深了也不亏）。 */
export function toSnakeCase(value) {
  if (Array.isArray(value)) return value.map(toSnakeCase)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
      out[snake] = toSnakeCase(item)
    }
    return out
  }
  return value
}

/** 生成一个设备 guid。存进 auth.json，之后一直用它，别每次换（风控友好）。 */
export function randomGuid() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`
}

/** WEB-VERSION 用不着和官方完全一致，取一个近期版本。 */
const WEB_VERSION = '2.3.0'
/** CLIENT-TYPE：windows=256053（前端 ClientTypeMap）。 */
const CLIENT_TYPE = '256053'

/**
 * 组 x-ima-cookie 头。auth 里 token 必须有，其余尽力而为。
 */
export function buildImaCookie(auth, device) {
  const parts = [
    `PLATFORM=H5`,
    `CLIENT-TYPE=${CLIENT_TYPE}`,
    `WEB-VERSION=${WEB_VERSION}`,
  ]
  if (device && device.guid) parts.push(`IMA-GUID=${device.guid}`)
  if (device && device.q36) parts.push(`IMA-Q36=${device.q36}`)
  if (auth) {
    if (auth.userId) parts.push(`IMA-UID=${auth.userId}`)
    if (auth.token) parts.push(`IMA-TOKEN=${auth.token}`)
    if (auth.refreshToken) parts.push(`IMA-REFRESH-TOKEN=${auth.refreshToken}`)
    if (auth.idType !== undefined && auth.idType !== '') parts.push(`UID-TYPE=${auth.idType}`)
    if (auth.tokenType !== undefined && auth.tokenType !== '') parts.push(`TOKEN-TYPE=${auth.tokenType}`)
  }
  return parts.join('; ')
}

/** 业务请求的公共头。 */
export function imaHeaders(auth, device, extra = {}) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': extra.userAgent || 'Mozilla/5.0',
    origin: extra.siteBase || 'https://ima.qq.com',
    referer: `${extra.siteBase || 'https://ima.qq.com'}/`,
    'x-ima-cookie': buildImaCookie(auth, device),
    from_browser_ima: '1',
  }
  if (auth && auth.token) headers['x-ima-bkn'] = String(bkn(auth.token))
  return headers
}

/** ------------------------------------------------------------------ 微信扫码 */

export const SCAN_STATE = {
  PENDING: 'pending',
  SCANNED: 'scanned',
  CONFIRMED: 'confirmed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
}

function decodeWxErrcode(code) {
  switch (code) {
    case 408:
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

export function extractUuid(html) {
  const match = String(html || '').match(/connect\/qrcode\/([A-Za-z0-9_-]{8,})/)
  return match ? match[1] : ''
}

export function parseWxPoll(text) {
  const errcode = /wx_errcode\s*=\s*(-?\d+)/.exec(String(text || ''))
  const code = /wx_code\s*=\s*'([^']*)'/.exec(String(text || ''))
  return {
    errcode: errcode ? Number(errcode[1]) : null,
    code: code ? code[1] : '',
  }
}

/**
 * 申请微信扫码（开放平台网页授权，和登录页 iframe 同参）。
 * 返回 uuid / qrUrl / state。
 */
export async function startWechatScan(config) {
  const state = `dsh${Math.random().toString(36).slice(2, 10)}`
  const params = new URLSearchParams({
    appid: config.wxAppId,
    scope: 'snsapi_login',
    redirect_uri: `${config.siteBase}/login`,
    state,
    login_type: 'jssdk',
    self_redirect: 'false',
    style: 'black',
    stylelite: '1',
    fast_login: '1',
  })
  const page = await fetch(`${WX_QR_PAGE}?${params.toString()}`, {
    headers: { 'user-agent': config.userAgent, referer: `${config.siteBase}/` },
  })
  const html = await page.text()
  const uuid = extractUuid(html)
  if (!uuid) {
    throw new Error(`申请微信扫码失败：页面里找不到 uuid（HTTP ${page.status}）`)
  }
  return {
    state,
    uuid,
    qrUrl: `${WX_QR_IMAGE}/${uuid}`,
    expireAt: Date.now() + 300 * 1000,
  }
}

/** 一轮长轮询（微信自己会挂 ~25 秒）。 */
export async function pollWechatScan(config, uuid, signal) {
  const url = `${WX_POLL}?uuid=${encodeURIComponent(uuid)}&_=${Date.now()}`
  const response = await fetch(url, {
    headers: { 'user-agent': config.userAgent, referer: 'https://open.weixin.qq.com/' },
    signal,
  })
  const text = await response.text()
  const parsed = parseWxPoll(text)
  let status = decodeWxErrcode(parsed.errcode)
  // 关键：jssdk 模式下用户点了「确认登录」之后，回包是 errcode=405 **且带 wx_code** ——
  // 405 不再是"等确认"，而是"已确认"。所以判断顺序必须是 code 优先，errcode 只兜底。
  if (parsed.code) status = SCAN_STATE.CONFIRMED
  return {
    ...parsed,
    status,
    raw: text.slice(0, 200),
  }
}

/** 二维码图片转 dataURL（面板是 web origin，直引微信域名可能被防盗链拦）。 */
export async function fetchQrImage(config, url) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': config.userAgent, referer: 'https://open.weixin.qq.com/' },
    })
    if (!response.ok) return ''
    const type = String(response.headers.get('content-type') || 'image/png').split(';')[0].trim()
    if (!type.startsWith('image/')) return ''
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > 512 * 1024) return ''
    return `data:${type};base64,${buffer.toString('base64')}`
  } catch {
    return ''
  }
}

/**
 * 用 wx_code 换 ima 登录态。
 *
 * 官方 verifyWxCode 的请求体（ye 序列化后）：
 *   { account_type: 2, code, auth_appid, client_info: { guid, platform: 4, qimei36 } }
 * 响应 data：token / refresh_token / user_id / id_type / token_type /
 *   token_valid_time / refresh_token_valid_time / user_info{...}
 */
export async function loginWithWxCode(config, code, device) {
  const body = toSnakeCase({
    accountType: ACCOUNT_TYPE_WX,
    code,
    authAppid: config.wxAppId,
    clientInfo: {
      guid: device.guid || randomGuid(),
      platform: PLATFORM_MAC,
      qimei36: device.q36 || '',
    },
  })
  const response = await fetch(`${config.siteBase}/cgi-bin/auth_login/login`, {
    method: 'POST',
    headers: imaHeaders(null, device, config),
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!payload || payload.code !== 0) {
    const msg = (payload && payload.msg) || ''
    throw new Error(`ima 登录失败（HTTP ${response.status}${msg ? `：${msg}` : ''}）`)
  }
  const data = payload.data || payload
  if (!data.token) {
    throw new Error(`ima 登录成功但没发 token，响应形状：${JSON.stringify(payload).slice(0, 600)}`)
  }
  return normalizeAccount(data)
}

/** /cgi-bin/auth_login/login 与 refresh 的响应 → auth.json 形状（兼容驼峰/下划线）。 */
export function normalizeAccount(data) {
  const pick = (obj, ...names) => {
    for (const n of names) {
      if (obj && obj[n] !== undefined && obj[n] !== null) return obj[n]
    }
    return undefined
  }
  const userInfo = pick(data, 'userInfo', 'user_info') || {}
  const openInfo = pick(userInfo, 'openInfo', 'open_info') || {}
  const customInfo = pick(userInfo, 'customInfo', 'custom_info') || {}
  const num = (v) => (v === undefined || v === null ? 0 : Number(v))
  const str = (v) => (v === undefined || v === null ? '' : String(v))
  return {
    token: str(pick(data, 'token')),
    refreshToken: str(pick(data, 'refreshToken', 'refresh_token')),
    userId: str(pick(data, 'userId', 'user_id')),
    nickName: str(pick(openInfo, 'nickname', 'nickName') || pick(customInfo, 'nick', 'nickName')),
    avatarUrl: str(pick(openInfo, 'avatarUrl', 'avatar_url')),
    idType: str(pick(data, 'idType', 'id_type')),
    tokenType: str(pick(data, 'tokenType', 'token_type')),
    tokenValidTime: num(pick(data, 'tokenValidTime', 'token_valid_time')),
    refreshTokenValidTime: num(pick(data, 'refreshTokenValidTime', 'refresh_token_valid_time')),
  }
}

/**
 * 换新 token。官方 refresh 的请求体只有 refresh_token。
 * 失败返回 null（让调用方决定是否强制重登）。
 */
export async function refreshToken(config, auth, device) {
  const response = await fetch(`${config.siteBase}/cgi-bin/auth_login/refresh`, {
    method: 'POST',
    headers: imaHeaders(auth, device, config),
    body: JSON.stringify({ refresh_token: auth.refreshToken }),
  })
  const payload = await response.json().catch(() => null)
  if (!payload || payload.code !== 0 || !payload.data || !payload.data.token) return null
  const next = normalizeAccount(payload.data)
  // refresh 响应可能不带 refreshToken（沿用旧的）
  if (!next.refreshToken && auth.refreshToken) next.refreshToken = auth.refreshToken
  if (!next.userId && auth.userId) next.userId = auth.userId
  return next
}

/** ------------------------------------------------------------------ 业务接口 */

/** 免登录读模型清单。 */
export async function fetchModels(config) {
  const response = await fetch(`${config.siteBase}/cgi-bin/intelligent_assistant_http_nl/get_models`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': config.userAgent,
      origin: config.siteBase,
      referer: `${config.siteBase}/`,
      from_browser_ima: '1',
    },
    body: JSON.stringify({}),
  })
  const payload = await response.json().catch(() => null)
  if (!payload || payload.code !== 0 || !Array.isArray(payload.models)) {
    throw new Error(`读模型清单失败（HTTP ${response.status}）`)
  }
  return payload.models.map((row) => ({
    id: String(row.model_id || ''),
    name: String(row.model_name || row.model_id || ''),
    shortName: String(row.short_model_name || ''),
    describe: String(row.describe || ''),
    modelType: Number(row.model_type || 0),
    isDefault: Boolean(row.is_default),
    enableEnhancement: Boolean(row.enable_enhancement),
  }))
}

/**
 * 建会话。普通对话用 sessionType=Child + envInfo.robotType=Main。
 * 前缀实测是 /cgi-bin/session_logic/（SessionLogicHTTPServiceUrlPrefix）。
 * 响应是扁平 snake_case：{code:0, session_id:...}。
 */
export async function initSession(config, auth, device, { robotType = ROBOT_MAIN } = {}) {
  const body = toSnakeCase({
    name: '',
    sessionType: SESSION_CHILD,
    envInfo: { robotType },
  })
  const response = await fetch(`${config.siteBase}/cgi-bin/session_logic/init_session`, {
    method: 'POST',
    headers: imaHeaders(auth, device, config),
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!payload || payload.code !== 0) {
    throw new Error(`init_session 失败（HTTP ${response.status}${payload && payload.msg ? `：${payload.msg}` : ''}）`)
  }
  const sessionId = payload.session_id || (payload.data && payload.data.session_id) || ''
  if (!sessionId) throw new Error(`init_session 成功但没返回 session_id：${JSON.stringify(payload).slice(0, 300)}`)
  return String(sessionId)
}

/** 删会话（对话结束顺手清掉，别在用户的 ima 历史里留一串垃圾）。 */
export async function delSession(config, auth, device, sessionId) {
  try {
    await fetch(`${config.siteBase}/cgi-bin/session_logic/del_session`, {
      method: 'POST',
      headers: imaHeaders(auth, device, config),
      body: JSON.stringify(toSnakeCase({ sessionId })),
    })
  } catch {
    /* 删不掉就算了 */
  }
}

/**
 * 解析上游 SSE 的一个数据块（命名事件格式）。
 * 返回 [{event, data}] 列表；不完整的块攒着（由调用方传 buffer 进来）。
 */
export function parseSseChunk(buffer) {
  const events = []
  let rest = buffer
  for (;;) {
    const blockEnd = rest.indexOf('\n\n')
    if (blockEnd < 0) break
    const block = rest.slice(0, blockEnd)
    rest = rest.slice(blockEnd + 2)
    let event = 'message'
    const dataLines = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) continue
    const raw = dataLines.join('\n')
    let data = raw
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        data = JSON.parse(raw)
      } catch {
        data = raw
      }
    }
    events.push({ event, data })
  }
  return { events, rest }
}

/**
 * 发起 QA 流。
 *
 * body 形状（官方 ask 的 ye 序列化，挑必需的）：
 *   session_id, robot_type, question, question_type, client_id,
 *   model_info{model_id, model_type, enable_enhancement, robot_type}
 *
 * 回调：
 *   onEvent({event, data})  每个命名事件
 *   signal                   AbortSignal
 *
 * 返回 { ok, status, httpHeaders, text } —— text 是给错误路径看的头几百字节。
 */
export async function qaStream(config, auth, device, body, { onEvent, signal } = {}) {
  const response = await fetch(`${config.siteBase}/cgi-bin/assistant/qa`, {
    method: 'POST',
    headers: {
      ...imaHeaders(auth, device, config),
      accept: 'text/event-stream',
    },
    body: JSON.stringify(toSnakeCase(body)),
    signal,
  })

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    return {
      ok: false,
      status: response.status,
      funcRet: response.headers.get('trpc-func-ret') || '',
      errorText: text.slice(0, 300),
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false

  while (!finished) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const { events, rest } = parseSseChunk(buffer)
    buffer = rest
    for (const item of events) {
      if (onEvent) onEvent(item)
      if (item.event === 'COMPLETED') finished = true
    }
  }

  return { ok: true, status: response.status }
}
