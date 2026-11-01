/**
 * 冒烟测试：不启动 DSH 也把插件跑一遍。
 *
 *   node scripts/smoke.mjs
 *
 * 覆盖：
 *   1. store：配置读写、登录态与钥匙两半互不覆盖、模型缓存；
 *   2. models：mock 过滤、auto 排序、去重；
 *   3. lightvela.js 的纯函数：Set-Cookie 解析、uuid 提取、微信轮询响应解析；
 *   4. 宿主半区：13 条路由、扫码全链路（假网络）、邀请归因、取钥匙、注册 provider；
 *   5. 浏览器半区：factory 能求值、apply 会注册 dock 与插件页插槽。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lightvela-smoke-'))
let passed = 0

async function ok(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    console.error(`  ✗ ${label}\n    ${error.message}`)
    throw error
  }
}

// 一张 1x1 的 PNG，冒充二维码图片。
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

console.log('\n[1] store')
const { createStore, DEFAULT_CONFIG } = await import(pathToFileURL(path.join(ROOT, 'lib/store.js')).href)
const store = createStore({ dataDir: sandbox })

await ok('默认配置指向 api.lightvela.com', () => {
  assert.equal(store.config().apiBase, 'https://api.lightvela.com')
  assert.equal(store.config().siteBase, 'https://lightvela.com')
  assert.equal(store.config().providerId, 'lightvela')
})
await ok('patchConfig 会覆盖', () => {
  assert.equal(store.patchConfig({ providerName: 'XX' }).providerName, 'XX')
  // 改回来：后面 [4] 用的是同一个 dataDir，不能带着这个值跑。
  assert.equal(store.patchConfig({ providerName: DEFAULT_CONFIG.providerName }).providerName, 'LightVela')
})
await ok('dataDir 不会被并进 config', () => assert.notEqual(store.config().dataDir, sandbox))

await ok('登录态与钥匙两半互不覆盖', () => {
  store.clearAuth()
  store.patchAuth({ sessionToken: 'tk-1', user: { id: 'usr_1', name: '微信用户' } })
  assert.equal(store.auth().sessionToken, 'tk-1')
  store.patchAuth({ apiKey: 'sk-abc', gatewayBase: 'https://token.lightvela.com/v1' })
  assert.equal(store.auth().sessionToken, 'tk-1', '绑钥匙不该把登录态冲掉')
  assert.equal(store.auth().apiKey, 'sk-abc')
})
await ok('只有钥匙也算有凭据', () => {
  store.clearAuth()
  store.patchAuth({ apiKey: 'sk-1' })
  assert.equal(store.auth().apiKey, 'sk-1')
  assert.equal(store.auth().sessionToken, '')
})
await ok('模型缓存落盘、新实例能读到', () => {
  store.saveModels({ models: [{ id: 'auto', name: 'Auto' }], gatewayBase: 'https://token.lightvela.com/v1' })
  const fresh = createStore({ dataDir: sandbox })
  assert.equal(fresh.models().models.length, 1)
  assert.equal(fresh.models().models[0].id, 'auto')
})
await ok('clearAuth 把登录态和模型缓存一起清掉', () => {
  store.clearAuth()
  assert.equal(store.auth(), null)
  assert.equal(store.models(), null)
})

console.log('\n[2] 模型清单整理')
const { normalizeModels, toProviderModels, isHidden } = await import(
  pathToFileURL(path.join(ROOT, 'lib/models.js')).href
)

await ok('mock 模型被藏掉', () => {
  assert.equal(isHidden('llmgw-mock-chat'), true)
  assert.equal(isHidden('auto'), false)
})
await ok('auto 排第一、ep- 端点垫底、去重', () => {
  const rows = [
    { id: 'ep-hyasr3' },
    { id: 'deepseek-v4-pro-202606' },
    { id: 'auto' },
    { id: 'auto' },
    { id: 'llmgw-mock-chat' },
  ]
  const models = normalizeModels(rows)
  assert.deepEqual(
    models.map((m) => m.id),
    ['auto', 'deepseek-v4-pro-202606', 'ep-hyasr3'],
  )
})
await ok('友好名：auto / deepseek / 自定义端点', () => {
  const models = normalizeModels([{ id: 'auto' }, { id: 'deepseek-v4-pro-202606' }, { id: 'ep-x1' }])
  assert.match(models[0].name, /Auto/)
  assert.match(models[1].name, /DeepSeek V4 Pro/)
  assert.match(models[2].name, /自定义端点/)
})
await ok('转成 provider.models 形状', () => {
  const list = toProviderModels([{ id: 'auto', name: 'Auto' }])
  assert.deepEqual(list, [{ id: 'auto', name: 'Auto', input: ['text'] }])
})

console.log('\n[3] 协议解析（纯函数）')
const lv = await import(pathToFileURL(path.join(ROOT, 'lib/lightvela.js')).href)

function fakeResponse({ status = 200, headers = {}, body = '' } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => map.get(String(name).toLowerCase()) || null,
      getSetCookie: () => headers['set-cookie-list'] || [],
    },
    async text() {
      return body
    },
    async json() {
      return JSON.parse(body)
    },
    async arrayBuffer() {
      return Buffer.from(body)
    },
  }
}

await ok('readSetCookies 摘出 name=value', () => {
  const res = fakeResponse({
    headers: {
      'set-cookie-list': [
        'lc_wechat_oauth_state=abc; Path=/auth/oauth/wechat/callback; Max-Age=600',
        'lc_session=deadbeef; Path=/; HttpOnly',
      ],
    },
  })
  const list = lv.readSetCookies(res)
  assert.equal(list.length, 2)
  assert.equal(list[0].name, 'lc_wechat_oauth_state')
  assert.equal(list[0].value, 'abc')
  assert.equal(list[1].name, 'lc_session')
})
await ok('cookieHeader 三种入参都能拼', () => {
  assert.equal(lv.cookieHeader([{ name: 'a', value: '1' }]), 'a=1')
  assert.equal(lv.cookieHeader({ a: '1', b: '2' }), 'a=1; b=2')
  assert.equal(lv.cookieHeader('x=9'), 'x=9')
})
await ok('extractUuid 从二维码页面里揪出 uuid', () => {
  const html = '<img src="https://open.weixin.qq.com/connect/qrcode/001aIWYv0jWHll2A" />'
  assert.equal(lv.extractUuid(html), '001aIWYv0jWHll2A')
})
await ok('parseWxPoll：408 = 没人扫，0 = 拿到 code', () => {
  assert.deepEqual(lv.parseWxPoll("window.wx_errcode=408;window.wx_code='';"), { errcode: 408, code: '' })
  const done = lv.parseWxPoll("window.wx_errcode=0;window.wx_code='CODE123';")
  assert.equal(done.errcode, 0)
  assert.equal(done.code, 'CODE123')
})

console.log('\n[4] 宿主半区')

// ---- 假网络：把整条扫码链路顶住 ----
const calls = []
const QR_UUID = '001smokeUUIDxxxx'
const SESSION_TOKEN = 'session-abc'
const SANDBOX_KEY = 'sk-smoke-' + 'x'.repeat(86)
let qrScanned = false

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  const method = options.method || 'GET'
  calls.push({ url: target, method, body: options.body, headers: options.headers || {} })

  // 1. 申请扫码
  if (target.includes('/auth/oauth/wechat/start')) {
    return fakeResponse({
      status: 307,
      headers: {
        location: 'https://open.weixin.qq.com/connect/qrconnect?appid=wx622c70c4608a3b23&state=STATE1#wechat_redirect',
        'set-cookie-list': [
          'lc_wechat_oauth_state=STATE1; Path=/auth/oauth/wechat/callback',
          'lc_wechat_oauth_mode=website; Path=/auth/oauth/wechat/callback',
        ],
      },
    })
  }
  // 2. 微信二维码页
  if (target.includes('open.weixin.qq.com/connect/qrconnect')) {
    return fakeResponse({
      status: 200,
      body: `<img src="https://open.weixin.qq.com/connect/qrcode/${QR_UUID}">`,
    })
  }
  // 3. 二维码图片
  if (target.startsWith('https://open.weixin.qq.com/connect/qrcode/')) {
    return {
      status: 200,
      ok: true,
      headers: { get: () => 'image/png', getSetCookie: () => [] },
      async arrayBuffer() {
        return TINY_PNG
      },
      async text() {
        return ''
      },
    }
  }
  // 4. 长轮询：第一次没扫，之后给 code
  if (target.includes('lp.open.weixin.qq.com/connect/l/qrconnect')) {
    if (!qrScanned) {
      qrScanned = true
      return fakeResponse({ status: 200, body: "window.wx_errcode=408;window.wx_code='';" })
    }
    return fakeResponse({ status: 200, body: "window.wx_errcode=0;window.wx_code='WXCODE';" })
  }
  // 5. 回调换会话
  if (target.includes('/auth/oauth/wechat/callback')) {
    return fakeResponse({
      status: 302,
      headers: { location: 'https://lightvela.com/auth/sign-in', 'set-cookie-list': [`lc_session=${SESSION_TOKEN}; Path=/`] },
    })
  }
  // 6. 会话校验
  if (target.endsWith('/auth/session')) {
    const body = JSON.stringify({
      session: { sessionToken: SESSION_TOKEN, user: { id: 'usr_583a', name: '微信用户', phone: '152****5347' } },
    })
    return fakeResponse({ status: 200, body })
  }
  // 7. 实例列表
  if (target.includes('/v1/instances?')) {
    return fakeResponse({
      status: 200,
      body: JSON.stringify({
        code: 'OK',
        data: { items: [{ instance_id: 'ins-1', name: '小助手', status: 'Running', sandbox_id: 'sb-1' }] },
      }),
    })
  }
  // 8. 沙箱 exec
  if (target.includes('/debug/exec')) {
    const out = [
      '__BASE__=https://token.lightvela.com/v1',
      `__KEY__=${SANDBOX_KEY}`,
      '__YAML_BASE__=https://token.lightvela.com/v1',
      '__MODEL__=auto',
    ].join('\n')
    return fakeResponse({ status: 200, body: JSON.stringify({ code: 'OK', data: { status: 'SUCCESS', exit_code: 0, output: out } }) })
  }
  // 8.5 邀请归因：校验邀请码 + 种 lc_referral_context
  if (target.includes('/v1/referrals/codes/')) {
    return fakeResponse({
      status: 200,
      body: JSON.stringify({
        success: true,
        data: {
          Code: 'JAKDMLAGJR',
          CampaignID: 'camp-smoke',
          CampaignName: '好友邀请奖励',
          StartsAt: '2026-09-15T16:00:00Z',
          EndsAt: '2099-12-31T15:59:59Z',
        },
      }),
    })
  }
  if (target.endsWith('/auth/referral/prepare')) {
    return fakeResponse({
      status: 204,
      headers: { 'set-cookie-list': ['lc_referral_context=JAKDMLAGJR; Path=/auth; Max-Age=1800; HttpOnly'] },
    })
  }
  // 9. 网关模型清单
  if (target.endsWith('/v1/models')) {
    return fakeResponse({
      status: 200,
      body: JSON.stringify({
        data: [
          { id: 'deepseek-v4-pro-202606', owned_by: 'openai' },
          { id: 'auto', owned_by: 'openai' },
          { id: 'llmgw-mock-chat', owned_by: 'openai' },
        ],
      }),
    })
  }
  // 10. 对话
  if (target.endsWith('/chat/completions')) {
    return fakeResponse({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: '可用' } }] }),
    })
  }
  throw new Error(`假网络没准备这条请求：${method} ${target}`)
}

const host = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href)

const routes = new Map()
const settingsOps = []
const credentialWrites = []
const fakeCtx = {
  inject(services, callback) {
    const bag = {}
    for (const service of services) {
      if (service === 'webServer') bag.webServer = { register: (route) => routes.set(route.path, route) }
      if (service === 'settings') {
        bag.settings = {
          async mutate(namespace, ops) {
            settingsOps.push({ namespace, ops })
          },
        }
      }
      if (service === 'credentials') {
        bag.credentials = {
          async set(name, value) {
            credentialWrites.push({ name, value })
          },
        }
      }
    }
    callback(bag)
  },
}

host.apply(fakeCtx, { dataDir: sandbox })

await ok('导出 name / apply', () => {
  assert.equal(host.name, 'lightvela')
  assert.equal(typeof host.apply, 'function')
})
await ok('注册了 13 条路由，且都在插件前缀下', () => {
  assert.equal(routes.size, 13, `实际 ${routes.size} 条：${[...routes.keys()].join(', ')}`)
  assert.ok([...routes.keys()].every((key) => key.startsWith('/plugins/dsh-lightvela/')))
})

function fakeRes() {
  const out = { status: 0, body: '' }
  return {
    out,
    writeHead(status) {
      out.status = status
    },
    end(body) {
      out.body = body
    },
  }
}

function call(routePath, payload) {
  const route = routes.get(`/plugins/dsh-lightvela/${routePath}`)
  if (!route) throw new Error(`没有这条路由：${routePath}`)
  const res = fakeRes()
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')])
  req.headers = {}
  return Promise.resolve(route.handler(req, res)).then(() => ({
    status: res.out.status,
    json: JSON.parse(res.out.body || '{}'),
  }))
}

await ok('/status 未登录时如实报告', async () => {
  const { status, json } = await call('status')
  assert.equal(status, 200)
  assert.equal(json.authed, false)
  assert.equal(json.keyReady, false)
  assert.equal(json.relay, false, '这个插件不该声称要反代')
  assert.equal(json.modelPicker.providerId, 'lightvela')
})

await ok('扫码全链路：申请 → 轮询 → 换会话 → 自动取钥匙', async () => {
  const { json } = await call('auth/qr/start', {})
  assert.equal(json.qr.phase, 'wait')
  assert.ok(String(json.qr.qr).startsWith('data:image/png;base64,'), '二维码应转成 dataURL')
  assert.ok(json.qr.secondsLeft > 0)

  // 等宿主自己把轮询走完（假网络里第二轮就给 code）
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    const current = await call('auth/qr/status')
    if (current.json.qr.phase === 'done' || current.json.qr.phase === 'error') break
  }

  const after = await call('status')
  assert.equal(after.json.qr.phase, 'done', `扫码没走完：${JSON.stringify(after.json.qr)}`)
  assert.equal(after.json.authed, true)
  assert.equal(after.json.account.name, '微信用户')

  // afterLogin 是后台跑的，等它把钥匙落盘。
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    const current = await call('status')
    if (current.json.keyReady) break
  }
  const ready = await call('status')
  assert.equal(ready.json.keyReady, true, '登录后应自动把钥匙取回来')
  assert.equal(ready.json.instance.name, '小助手')
  assert.equal(ready.json.gatewayBase, 'https://token.lightvela.com/v1')
})

await ok('微信回调带上了邀请归因 cookie', () => {
  const callback = calls.find((c) => c.url.includes('/auth/oauth/wechat/callback'))
  assert.ok(callback, '应该调用过回调')
  const sent = String((callback.headers && callback.headers.cookie) || '')
  assert.match(sent, /lc_referral_context=JAKDMLAGJR/, '回调没带邀请 cookie，归因会丢')
  assert.match(sent, /lc_wechat_oauth_state=STATE1/, '原有的 oauth cookie 不能被覆盖掉')
})

await ok('/referral 校验邀请码并给出邀请链接', async () => {
  const { json } = await call('referral')
  assert.equal(json.ok, true)
  assert.equal(json.code, 'JAKDMLAGJR')
  assert.equal(json.url, 'https://lightvela.com/?ref=JAKDMLAGJR')
  assert.equal(json.check.ok, true)
  assert.equal(json.check.campaign, '好友邀请奖励')
})

await ok('钥匙确实来自实例沙箱的 .env，不是别处', () => {
  const saved = createStore({ dataDir: sandbox }).auth()
  assert.equal(saved.apiKey, SANDBOX_KEY)
  assert.equal(saved.instanceId, 'ins-1')
  const exec = calls.find((c) => c.url.includes('/debug/exec'))
  assert.ok(exec, '应该调用过 /debug/exec')
  assert.match(String(exec.body), /CUSTOM_API_KEY/)
})

await ok('/models/refresh 读网关清单并过滤掉 mock', async () => {
  const { json } = await call('models/refresh', {})
  assert.equal(json.ok, true)
  const ids = json.models.map((m) => m.id)
  assert.deepEqual(ids, ['auto', 'deepseek-v4-pro-202606'])
})

await ok('/models/probe 给每个模型标上可用性', async () => {
  const { json } = await call('models/probe', {})
  assert.equal(json.ok, true)
  assert.ok(json.models.every((m) => m.usable === true))
  assert.ok(json.models.every((m) => typeof m.note === 'string' && m.note.includes('ms')))
})

await ok('/models/register 写进 llm-pi-ai 的 providers.lightvela', async () => {
  const { json } = await call('models/register', {})
  assert.equal(json.ok, true)
  assert.equal(json.modelPicker.registered, true)
  assert.equal(json.modelPicker.count, 2)

  const op = settingsOps.at(-1)
  assert.equal(op.namespace, 'llm-pi-ai')
  const value = op.ops[0].value
  assert.equal(op.ops[0].op, 'set')
  assert.deepEqual(op.ops[0].path, ['providers', 'lightvela'])
  assert.equal(value.displayName, 'LightVela')
  assert.equal(value.api, 'openai-completions')
  assert.equal(value.apiKeyEnv, 'LIGHTVELA_API_KEY')
  // 关键断言：baseURL 是公网网关，不是 127.0.0.1 反代
  assert.equal(value.baseURL, 'https://token.lightvela.com/v1')
  assert.equal(value.models.length, 2)
})

await ok('钥匙写进了 credentials', () => {
  const write = credentialWrites.at(-1)
  assert.equal(write.name, 'LIGHTVELA_API_KEY')
  assert.equal(write.value, SANDBOX_KEY)
})

await ok('/test 能打一发并取回文字', async () => {
  const { json } = await call('test', { model: 'auto' })
  assert.equal(json.ok, true)
  assert.equal(json.text, '可用')
})

await ok('/instances 列出实例', async () => {
  const { json } = await call('instances')
  assert.equal(json.ok, true)
  assert.equal(json.instances.length, 1)
  assert.equal(json.instances[0].status, 'Running')
})

await ok('/logout 清掉凭据与缓存', async () => {
  const { json } = await call('logout', {})
  assert.equal(json.authed, false)
  assert.equal(json.keyReady, false)
  assert.equal(createStore({ dataDir: sandbox }).auth(), null)
})

console.log('\n[5] 浏览器半区')

await ok('client factory 能求值，apply 会注册 dock 与插件页插槽', () => {
  let factory = null
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory: fn }) => {
        factory = fn
      },
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }
  globalThis.document = {
    documentElement: { dataset: {}, className: '', style: {} },
  }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.fetch = async () => ({ json: async () => ({ ok: true }) })

  const clientPath = pathToFileURL(path.join(ROOT, 'lib/client.js')).href
  return import(`${clientPath}?v=${Date.now()}`).then(() => {
    assert.equal(typeof factory, 'function', 'factory 没被注册到模块加载器')
    const mod = factory((id) => {
      if (id === 'react') {
        return {
          createElement: (...args) => ({ args }),
          useState: (v) => [v, () => {}],
          useEffect: () => {},
          useCallback: (fn) => fn,
          useRef: (v) => ({ current: v }),
        }
      }
      throw new Error(`没准备这个模块：${id}`)
    })
    assert.equal(typeof mod.apply, 'function')
    assert.deepEqual(mod.inject, ['slots'])
    mod.apply({
      slots: {
        inject(name, fn) {
          registrations.push(name)
          fn()
        },
        register(meta) {
          return meta
        },
      },
    })
    assert.ok(registrations.includes('conversation.composer.dock'))
    assert.ok(registrations.includes('plugins.bundle.config'))
    assert.ok(registrations.includes('plugins.row.config'))
  })
})

await ok('插件页卡片能在首帧渲染（status 还是 null 时不能崩）', () => {
  // 这条是回归：/status 还没回来时 status 是 null，
  // 之前直接写 status.instance 会在 'plugins.bundle.config' 插槽里抛 TypeError，整块卡片消失。
  let factory = null
  const components = []
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory: fn }) => {
        factory = fn
      },
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} },
  }
  globalThis.document = { documentElement: { dataset: {}, className: '', style: {} } }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.fetch = async () => ({ json: async () => ({ ok: true }) })

  // 一个够用的极简渲染器：只求「能不能渲染出来」，不模拟状态更新。
  const pending = []
  const render = (node, depth = 0) => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!node || typeof node !== 'object') return ''
    if (pending.length > 0 && depth === 0) {
      // 顶层是函数组件时，先把它展开
    }
    const { type, props } = node
    if (typeof type === 'function') return render(type(props || {}), depth + 1)
    const children = props && props.children
    const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
    return list.map((child) => render(child, depth + 1)).join('')
  }

  const clientPath = pathToFileURL(path.join(ROOT, 'lib/client.js')).href
  return import(`${clientPath}?v=render-${Date.now()}`).then(() => {
    const mod = factory((id) => {
      if (id !== 'react') throw new Error(`没准备这个模块：${id}`)
      return {
        createElement: (type, props, ...children) => ({
          type,
          props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
        }),
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
        useRef: (v) => ({ current: v }),
        useMemo: (fn) => fn(),
      }
    })
    mod.apply({
      slots: {
        inject(name, fn) {
          fn()
        },
        register(meta, component) {
          components.push({ name: meta.name, component })
          return meta
        },
      },
    })
    const card = components.find((item) => item.name === 'plugins.bundle.config')
    assert.ok(card && typeof card.component === 'function', '没拿到插件页卡片组件')
    const html = render(card.component())
    assert.ok(html.includes('LightVela') || html.includes('Vela'), '卡片渲染出来是空的')
  })
})

/** 面板拿到真实 status 时的渲染。status 一非 null，邀请归因那段代码才会被求值。 */
function renderPanelWith(status) {
  let factory = null
  const components = []
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory: fn }) => {
        factory = fn
      },
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} },
  }
  globalThis.document = { documentElement: { dataset: {}, className: '', style: {} } }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.fetch = async () => ({ json: async () => ({ ok: true }) })

  const render = (node, depth = 0) => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    // children 传数组时会嵌成 `[a, b, [c, d]]`，不解开就会把整段静默丢掉。
    if (Array.isArray(node)) return node.map((child) => render(child, depth)).join('')
    if (!node || typeof node !== 'object') return ''
    const { type, props } = node
    if (typeof type === 'function') return render(type(props || {}), depth + 1)
    const children = props && props.children
    const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
    return list.map((child) => render(child, depth + 1)).join('')
  }

  const clientPath = pathToFileURL(path.join(ROOT, 'lib/client.js')).href
  return import(`${clientPath}?v=panel-${Math.random()}`).then(() => {
    let statusGiven = false
    const mod = factory((id) => {
      if (id !== 'react') throw new Error(`没准备这个模块：${id}`)
      return {
        createElement: (type, props, ...children) => ({
          type,
          props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
        }),
        useState: (initial) => {
          // 面板里第一次 `useState(null)` 就是 status（前面只有 useTheme 的布尔）。
          if (initial === null && !statusGiven) {
            statusGiven = true
            return [status, () => {}]
          }
          return [typeof initial === 'function' ? initial() : initial, () => {}]
        },
        useEffect: () => {},
        useCallback: (fn) => fn,
        useRef: (v) => ({ current: v }),
        useMemo: (fn) => fn(),
      }
    })
    mod.apply({
      slots: {
        inject(name, fn) {
          fn()
        },
        register(meta, component) {
          components.push({ name: meta.name, component })
          return meta
        },
      },
    })
    const card = components.find((item) => item.name === 'plugins.bundle.config')
    assert.ok(card && typeof card.component === 'function', '没拿到插件页卡片组件')
    return render(card.component())
  })
}

const BASE_STATUS = {
  ok: true,
  authed: false,
  keyReady: false,
  account: null,
  instance: { id: '', name: '' },
  gatewayBase: 'https://token.lightvela.com/v1',
  modelPicker: {},
  models: [],
  qr: { phase: 'idle' },
}

await ok('未登录时渲染出「用邀请链接注册」按钮', async () => {
  const html = await renderPanelWith({
    ...BASE_STATUS,
    referral: { code: 'JAKDMLAGJR', url: 'https://lightvela.com/?ref=JAKDMLAGJR', applied: '', check: null },
  })
  assert.ok(html.includes('用邀请链接注册'), '没渲染注册按钮')
  assert.ok(html.includes('JAKDMLAGJR'), '没显示邀请码')
  assert.ok(html.includes('复制链接'), '没渲染复制按钮')
})

await ok('已登录时把入口改成「邀请好友」，并标出已带归因', async () => {
  const html = await renderPanelWith({
    ...BASE_STATUS,
    authed: true,
    account: { id: 'usr_1', name: '微信用户' },
    referral: { code: 'JAKDMLAGJR', url: 'https://lightvela.com/?ref=JAKDMLAGJR', applied: 'JAKDMLAGJR', check: null },
  })
  assert.ok(html.includes('邀请好友'), '已登录时没换成「邀请好友」')
  assert.ok(html.includes('已带邀请'), '没标出这次登录已带归因')
})

await ok('没配邀请码时整块邀请区不出现', async () => {
  const html = await renderPanelWith({ ...BASE_STATUS, referral: { code: '', url: '', applied: '', check: null } })
  assert.ok(!html.includes('用邀请链接注册'), '关了邀请码不该还有按钮')
})

console.log(`\n全部通过：${passed} 项\n`)
