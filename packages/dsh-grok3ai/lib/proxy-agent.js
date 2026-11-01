/**
 * 出口层：让一个 HTTP 请求从指定的代理出去。
 *
 * 为什么不用 undici 的 ProxyAgent：
 *   DSH 宿主只保证 Node 自带能力，undici 不是它的依赖。而这里需要的东西很少 ——
 *   一条 TCP（可能再加一层 TLS）隧道，剩下的 HTTP 报文交给 node:http 自己解析。
 *   所以 CONNECT 和 SOCKS5 握手都手写，零依赖。
 *
 * 支持的写法（一行一个）：
 *   host:port                 默认按 http 代理处理
 *   http://host:port          明文代理，走 CONNECT 隧道
 *   http://user:pass@host:port
 *   https://host:port         代理本身走 TLS
 *   socks5://host:port        SOCKS5，域名交给代理解析（socks5h:// 同义）
 *   1.2.3.4:8000:user:pass    国内代理商常见的四段格式
 *
 * 还有一种最值钱的写法：账号里带 `{session}` 占位符。
 *
 *   http://acct-residential_lite-country_SG-r_10m-s_{session}:pass@gate.nstproxy.io:24125
 *
 * 住宅代理商的"动态"其实是靠**换会话名**实现的：同一个账号 + 不同 s_xxx = 不同出口 IP。
 * 用户写 `{session}`，插件就每次建连时换一个随机串，于是一发请求一个 IP，
 * 额度（按 IP 记）也就跟着重置。这比"重开连接"更靠得住 —— 很多代理商对
 * 同一个 s_xxx 是 120 分钟粘性的，光重连根本换不出 IP。
 *
 * 对外只有 makeFetcher(proxy)：返回一个和 fetch 同形状的函数。
 * upstream.js 里所有请求都通过 fetchImpl 注入，所以走不走代理、走哪条，
 * 上游代码一行都不用改。
 */
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'

const DEFAULT_TIMEOUT = 15000
/** 握手阶段最多读这么多字节，防止坏代理无限灌数据。 */
const HANDSHAKE_LIMIT = 64 * 1024

const SCHEMES = {
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks5: 'socks5',
  socks5h: 'socks5',
}

function defaultPort(protocol) {
  if (protocol === 'https') return 443
  if (protocol === 'socks5') return 1080
  return 80
}

/** 会话占位符：`{session}` 是主写法，`{s}` / `{sid}` 是同义词（写起来短）。 */
const SESSION_TOKEN = /\{(session|sid|s)\}/gi

export function hasSessionToken(text) {
  SESSION_TOKEN.lastIndex = 0
  return SESSION_TOKEN.test(String(text || ''))
}

const SESSION_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 随机会话名。长度对齐常见代理商自己生成的样子（10 位）。 */
export function randomSession(length = 10) {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += SESSION_ALPHABET[Math.floor(Math.random() * SESSION_ALPHABET.length)]
  }
  return out
}

/**
 * 把 `{session}` 换成随机串，得到这一次连接的代理对象。
 * 没有占位符就原样返回（同一个对象，不产生垃圾）。
 */
export function withSession(proxy, session) {
  if (!proxy) return proxy
  const auth = proxy.auth
  if (!auth) return proxy
  const user = String(auth.user || '')
  const pass = String(auth.pass || '')
  if (!hasSessionToken(user) && !hasSessionToken(pass)) return proxy
  const token = session || randomSession()
  const swap = (text) => text.replace(SESSION_TOKEN, token)
  return { ...proxy, auth: { user: swap(user), pass: swap(pass) }, session: token }
}


/**
 * 解析一行代理。看不懂就抛错 —— 让面板那边能原样把"哪一行写错了"回给用户。
 *
 * @returns {{raw:string,url:string,protocol:string,host:string,port:number,auth:{user:string,pass:string}|null,label:string}}
 */
export function parseProxy(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim()
  if (!text) throw new Error('代理地址是空的')

  let work = text
  // 1.2.3.4:8000:user:pass —— 四段且第二段是纯数字，当成「地址:端口:账号:密码」
  const parts = work.split(':')
  if (!/^[a-z0-9+.-]+:\/\//i.test(work) && parts.length === 4 && /^\d+$/.test(parts[1])) {
    work = `http://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`
  } else if (!/^[a-z0-9+.-]+:\/\//i.test(work)) {
    work = `http://${work}`
  }

  let url
  try {
    url = new URL(work)
  } catch {
    throw new Error(`看不懂这个代理地址：${text}`)
  }

  const scheme = url.protocol.replace(':', '').toLowerCase()
  const protocol = SCHEMES[scheme]
  if (!protocol) throw new Error(`不支持的代理协议「${scheme}」：只认 http / https / socks5`)
  if (!url.hostname) throw new Error(`代理地址里没有主机名：${text}`)

  const port = number_or_default(url.port, defaultPort(protocol))
  const auth =
    url.username || url.password
      ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
      : null

  // 带 `{session}` 的代理天然是"每次连接换出口"，调用方据此把它当动态代理排在最前
  const template = Boolean(auth && (hasSessionToken(auth.user) || hasSessionToken(auth.pass)))

  return {
    raw: text,
    url: `${protocol}://${url.hostname}:${port}`,
    protocol,
    host: url.hostname,
    port,
    auth,
    template,
    // 面板上一行只能显示 label，同一家住宅代理的多个国家都长一样，所以把国家缀上去
    label: `${url.hostname}:${port}${countryTag(auth && auth.user)}`,
  }
}

/** 从账号串里抠出国家码（nstproxy / 不少住宅代理商都用 country_XX 这种写法）。 */
function countryTag(user) {
  const match = /country[_-]([a-z]{2})\b/i.exec(String(user || ''))
  return match ? `/${match[1].toUpperCase()}` : ''
}

function number_or_default(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 面板上显示用：密码打码。 */
export function maskProxy(parsed) {
  if (!parsed) return ''
  const auth = parsed.auth ? `${parsed.auth.user}:***@` : ''
  return `${parsed.protocol}://${auth}${parsed.host}:${parsed.port}`
}

// ------------------------------------------------------------------ TCP / TLS

function tcpConnect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连不上代理 ${host}:${port}（${Math.round(timeout / 1000)} 秒超时）`))
    }, timeout)
    const done = (error) => {
      clearTimeout(timer)
      socket.off('error', onError)
      socket.off('connect', onConnect)
      if (error) {
        socket.destroy()
        reject(error)
        return
      }
      resolve(socket)
    }
    const onError = (error) => done(error)
    const onConnect = () => done(null)
    socket.once('error', onError)
    socket.once('connect', onConnect)
  })
}

function startTls(socket, servername, timeout, options) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      ...(options.ca ? { ca: options.ca } : {}),
    })
    const timer = setTimeout(() => {
      secure.destroy()
      reject(new Error(`和 ${servername} 的 TLS 握手超时`))
    }, timeout)
    secure.once('secureConnect', () => {
      clearTimeout(timer)
      secure.off('error', onError)
      secure.setTimeout(0)
      resolve(secure)
    })
    const onError = (error) => {
      clearTimeout(timer)
      secure.destroy()
      reject(new Error(`TLS 握手失败（${servername}）：${error.message}`))
    }
    secure.once('error', onError)
  })
}

// ------------------------------------------------------------------ 握手读写

/** 带缓冲的读：握手各步骤之间会剩下字节，不能丢。 */
class Reader {
  constructor(socket) {
    this.socket = socket
    this.chunks = []
    this.size = 0
    this.waiter = null
    this.failure = null
    this.onData = (chunk) => {
      this.chunks.push(chunk)
      this.size += chunk.length
      if (this.size > HANDSHAKE_LIMIT) this.failure = new Error('代理握手时回了太多数据')
      this.wake()
    }
    this.onError = (error) => {
      this.failure = this.failure || error
      this.wake()
    }
    this.onClose = () => {
      this.failure = this.failure || new Error('代理在你说话之前就把连接关了')
      this.wake()
    }
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('end', this.onClose)
    socket.on('close', this.onClose)
  }

  wake() {
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter()
    }
  }

  peek() {
    if (!this.size) return Buffer.alloc(0)
    return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size)
  }

  take(n) {
    const all = this.peek()
    const head = all.subarray(0, n)
    const rest = all.subarray(n)
    this.chunks = rest.length ? [rest] : []
    this.size = rest.length
    return head
  }

  async wait() {
    if (this.failure) throw this.failure
    await new Promise((resolve) => {
      this.waiter = resolve
    })
  }

  async need(n) {
    while (this.size < n) await this.wait()
    return this.take(n)
  }

  async until(token) {
    for (;;) {
      const all = this.peek()
      const index = all.indexOf(token)
      if (index >= 0) return this.take(index + token.length)
      if (this.failure) throw this.failure
      await this.wait()
    }
  }

  detach() {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('end', this.onClose)
    this.socket.off('close', this.onClose)
    this.socket.pause()
    this.chunks = []
    this.size = 0
  }
}

async function httpConnect(socket, host, port, proxy, timeout) {
  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`, 'Proxy-Connection: keep-alive']
  if (proxy.auth) {
    const token = Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64')
    lines.push(`Proxy-Authorization: Basic ${token}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  socket.setTimeout(timeout, () => socket.destroy(new Error('代理握手超时')))

  const reader = new Reader(socket)
  let head
  try {
    head = await reader.until('\r\n\r\n')
  } finally {
    reader.detach()
  }
  socket.setTimeout(0)

  const first = head.toString('latin1').split('\r\n')[0] || ''
  const match = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(first)
  if (!match) throw new Error(`代理回的不是 HTTP：${first.slice(0, 80)}`)
  const status = Number(match[1])
  if (status === 407) throw new Error('代理要认证（407），检查账号密码')
  if (status !== 200) throw new Error(`代理拒绝建隧道：${status} ${first.slice(0, 60)}`)
}

async function socks5Handshake(socket, host, port, proxy, timeout) {
  socket.setTimeout(timeout, () => socket.destroy(new Error('SOCKS5 握手超时')))
  const reader = new Reader(socket)
  try {
    const wantAuth = Boolean(proxy.auth)
    socket.write(Buffer.from(wantAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))

    const greeting = await reader.need(2)
    if (greeting[0] !== 0x05) throw new Error('对方不像 SOCKS5 代理（版本号不对）')
    const method = greeting[1]
    if (method === 0xff) throw new Error('SOCKS5 代理拒绝了所有认证方式')
    if (method === 0x02) {
      if (!proxy.auth) throw new Error('SOCKS5 代理要账号密码，但地址里没写')
      const user = Buffer.from(proxy.auth.user)
      const pass = Buffer.from(proxy.auth.pass)
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
      const reply = await reader.need(2)
      if (reply[1] !== 0x00) throw new Error('SOCKS5 账号密码不对')
    } else if (method !== 0x00) {
      throw new Error(`SOCKS5 代理要求不认识的认证方式：${method}`)
    }

    const name = Buffer.from(host)
    if (name.length > 255) throw new Error('主机名太长，SOCKS5 装不下')
    const portBuf = Buffer.alloc(2)
    portBuf.writeUInt16BE(port, 0)
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, portBuf]))

    const replyHead = await reader.need(4)
    if (replyHead[1] !== 0x00) {
      const reasons = {
        1: '代理内部错误',
        2: '规则不允许',
        3: '网络不可达',
        4: '主机不可达',
        5: '目标拒绝连接',
        6: 'TTL 过期',
        7: '不支持的命令',
        8: '不支持的地址类型',
      }
      throw new Error(`SOCKS5 拒绝连 ${host}:${port}（${reasons[replyHead[1]] || `code ${replyHead[1]}`}）`)
    }
    const atyp = replyHead[3]
    if (atyp === 0x01) await reader.need(4 + 2)
    else if (atyp === 0x03) {
      const len = (await reader.need(1))[0]
      await reader.need(len + 2)
    } else if (atyp === 0x04) await reader.need(16 + 2)
    else throw new Error(`SOCKS5 回了不认识的地址类型：${atyp}`)
  } finally {
    reader.detach()
  }
  socket.setTimeout(0)
}

/**
 * 打通一条到 target 的隧道。
 * @returns {Promise<import('node:net').Socket>} 已经连到目标（secure 时已完成 TLS）的 socket
 */
async function openTunnel(proxy, host, port, secure, options) {
  const timeout = number_or_default(options.connectTimeout, DEFAULT_TIMEOUT)
  let socket = await tcpConnect(proxy.host, proxy.port, timeout)
  try {
    if (proxy.protocol === 'https') {
      socket = await startTls(socket, proxy.host, timeout, options)
    }
    if (proxy.protocol === 'socks5') {
      await socks5Handshake(socket, host, port, proxy, timeout)
    } else {
      await httpConnect(socket, host, port, proxy, timeout)
    }
    if (secure) {
      socket = await startTls(socket, host, timeout, options)
    }
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

// ------------------------------------------------------------------ 发请求

/**
 * 只吐一次请求的 Agent：隧道已经建好了，直接交给 http 客户端去写报文和解析响应。
 * 这样 chunked / gzip / keep-alive 这些细节都还是 Node 自己在管，不用手写解析。
 */
class SingleSocketAgent extends http.Agent {
  constructor(socket) {
    super({ keepAlive: false, maxSockets: 1 })
    this.pending = socket
  }

  createConnection(options, callback) {
    const socket = this.pending
    this.pending = null
    if (!socket) {
      callback(new Error('这条隧道只能用一次'))
      return undefined
    }
    callback(null, socket)
    return undefined
  }
}

function normalizeHeaders(input) {
  const out = {}
  if (!input) return out
  if (Array.isArray(input)) {
    for (const pair of input) if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1])
    return out
  }
  if (typeof input.forEach === 'function' && !(input instanceof Map)) {
    // Headers 实例
    input.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value)
    })
    return out
  }
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    out[String(key).toLowerCase()] = String(value)
  }
  return out
}

function wrapResponse(res, href) {
  const headers = {
    get(name) {
      const value = res.headers[String(name).toLowerCase()]
      if (value === undefined) return null
      return Array.isArray(value) ? value.join(', ') : String(value)
    },
    raw: res.headers,
  }
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage || '',
    url: href,
    headers,
    // upstream.js 里是 `for await (const chunk of response.body)`
    body: res,
    async text() {
      const chunks = []
      for await (const chunk of res) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks).toString('utf8')
    },
    async json() {
      return JSON.parse(await this.text())
    },
  }
}

function dispatch(socket, target, init) {
  return new Promise((resolve, reject) => {
    const agent = new SingleSocketAgent(socket)
    let request
    try {
      request = http.request(
        {
          host: target.host,
          port: target.port,
          path: target.path,
          method: target.method,
          headers: target.headers,
          agent,
          signal: init.signal,
        },
        (res) => resolve(wrapResponse(res, target.href)),
      )
    } catch (error) {
      socket.destroy()
      reject(error)
      return
    }
    request.on('error', (error) => {
      socket.destroy()
      reject(error)
    })
    const idle = number_or_default(init.idleTimeout, 120000)
    request.setTimeout(idle, () => {
      request.destroy(new Error(`上游 ${Math.round(idle / 1000)} 秒没动静`))
    })
    if (init.body !== undefined && init.body !== null) request.write(init.body)
    request.end()
  })
}

/**
 * 生成一个 fetch 同形状的函数。
 *
 * proxy 传 null 就直接用全局 fetch（等于插件原来的行为）。
 * 注意：这里故意只实现 upstream.js 用到的那几个成员（ok/status/headers.get/
 * text/json/body），不做完整的 Request/Response。
 */
export function makeFetcher(proxy, options = {}) {
  if (!proxy) return (input, init) => fetch(input, init)

  return async function proxiedFetch(input, init = {}) {
    const href = typeof input === 'string' ? input : String((input && input.url) || input)
    const target = new URL(href)
    const secure = target.protocol === 'https:'
    if (!secure && target.protocol !== 'http:') {
      throw new Error(`代理只转发 http/https，不支持 ${target.protocol}`)
    }
    const host = target.hostname
    const port = number_or_default(target.port, secure ? 443 : 80)
    const headers = normalizeHeaders(init.headers)
    const body = init.body === undefined || init.body === null ? null : String(init.body)
    if (body !== null) headers['content-length'] = String(Buffer.byteLength(body))
    if (!headers['user-agent']) headers['user-agent'] = 'Mozilla/5.0 (compatible; dsh-grok-online)'

    const socket = await openTunnel(withSession(proxy), host, port, secure, options)
    return dispatch(
      socket,
      {
        href,
        host,
        port,
        path: `${target.pathname || '/'}${target.search || ''}`,
        method: String(init.method || 'GET').toUpperCase(),
        headers,
      },
      { body, signal: init.signal, idleTimeout: init.idleTimeout },
    )
  }
}

/**
 * 自检：能不能从这个代理出去、出去之后看到的是哪个 IP。
 *
 * 这一步只是"顺手看一眼"（面板上显示"这个出口是哪个 IP"），失败不影响主链路。
 * 默认用 myip.ipip.net：国内直连 200ms 左右，返回纯文本「当前 IP：x.x.x.x 来自于：…」；
 * ipify 在部分网络下会直接超时，所以只在主地址失败时兜一次底。
 */
async function readExitIp(proxy, target, options = {}) {
  try {
    const fetcher = makeFetcher(proxy, { ...options, connectTimeout: options.connectTimeout || 8000 })
    const response = await fetcher(target, { method: 'GET', idleTimeout: 8000 })
    const text = (await response.text()).trim()
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    let ip = ''
    try {
      const parsed = JSON.parse(text)
      // ipify / ipinfo / ip-api 字段名各不相同，能认几个认几个
      ip = String(parsed.ip || parsed.query || parsed.address || parsed.yourFacingIp || '').trim()
    } catch {
      // 纯文本形式的接口（myip.ipip.net 之类）从正文里抠 IP
    }
    if (!ip) {
      const match = /((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})/i.exec(text)
      ip = match ? match[1] : ''
    }
    if (!ip) return { ok: false, error: '这个地址没回 IP（可以在配置里换 proxyProbeUrl）' }
    return { ok: true, ip }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

const FALLBACK_PROBE = 'https://ipinfo.io/ip'

export async function probeExitIp(proxy, url, options = {}) {
  const primary = String(url || 'https://myip.ipip.net')
  const first = await readExitIp(proxy, primary, options)
  if (first.ok || primary === FALLBACK_PROBE) return first
  const second = await readExitIp(proxy, FALLBACK_PROBE, { ...options, connectTimeout: 5000 })
  if (second.ok) return second
  return { ok: false, error: `${first.error}；备用地址也失败：${second.error}` }
}
