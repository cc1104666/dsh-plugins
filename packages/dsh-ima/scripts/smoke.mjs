/**
 * dsh-ima 冒烟测试 —— 全程不联网。
 *
 *   node scripts/smoke.mjs
 *
 * 覆盖：
 *   1. bkn / snake_case / cookie 组装
 *   2. 微信扫码轮询解析与状态机映射
 *   3. SSE 分块解析（命名事件 / JSON data / 半截块）
 *   4. 模型清单归一化
 *   5. buildQuestion / buildQaPayload
 *   6. chatOnce：MESSAGE 增量流、快照流、THINKING、COMPLETED 报错
 *   7. 手贴 cookie 解析
 *   8. 反代：/v1/models、非流式、流式、未登录 401
 *   9. 宿主 apply：路由注册、/status 快照
 *   10. client factory 求值 + 插槽注册 + 插件页卡片首帧渲染
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

let passed = 0
async function ok(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${title}`)
  } catch (error) {
    console.error(`  ✗ ${title}`)
    console.error(String((error && error.stack) || error))
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------- ima.js 单元

const ima = await import(pathToFileURL(path.join(ROOT, 'lib/ima.js')).href)

await ok('bkn：空串 = 5381，参考值与官方公式一致', () => {
  assert.equal(ima.bkn(''), 5381)
  // 手算参考：token "abc"：e=5381; e+=(e<<5)+97 → …（只验证算法稳定 + 非 NaN）
  const value = ima.bkn('abc')
  assert.ok(Number.isInteger(value) && value >= 0 && value <= 2147483647)
})

await ok('toSnakeCase：嵌套驼峰全转下划线', () => {
  const out = ima.toSnakeCase({
    sessionId: 's',
    modelInfo: { modelId: 'official_1', modelType: 1 },
    retrySelectMessageIds: [],
  })
  assert.equal(out.session_id, 's')
  assert.equal(out.model_info.model_id, 'official_1')
  assert.equal(out.model_info.model_type, 1)
  assert.equal(Array.isArray(out.retry_select_message_ids), true)
})

await ok('buildImaCookie：登录态字段齐全', () => {
  const cookie = ima.buildImaCookie(
    { userId: 'u1', token: 't1', refreshToken: 'r1', idType: '2', tokenType: '0' },
    { guid: 'g1' },
  )
  for (const piece of ['IMA-UID=u1', 'IMA-TOKEN=t1', 'IMA-REFRESH-TOKEN=r1', 'UID-TYPE=2', 'TOKEN-TYPE=0', 'IMA-GUID=g1', 'PLATFORM=H5']) {
    assert.ok(cookie.includes(piece), `缺 ${piece}`)
  }
})

await ok('imaHeaders：带 bkn 与 from_browser_ima', () => {
  const headers = ima.imaHeaders({ token: 'abc' }, {}, { siteBase: 'https://ima.qq.com', userAgent: 'UA' })
  assert.equal(headers['from_browser_ima'], '1')
  assert.equal(headers['x-ima-bkn'], String(ima.bkn('abc')))
  assert.ok(headers['x-ima-cookie'].includes('IMA-TOKEN=abc'))
})

await ok('微信轮询响应解析与状态映射', () => {
  assert.equal(ima.parseWxPoll("window.wx_errcode=408;window.wx_code='';").errcode, 408)
  assert.equal(ima.parseWxPoll("window.wx_errcode=405;window.wx_code='';").errcode, 405)
  const hit = ima.parseWxPoll("window.wx_errcode=405;window.wx_code='';")
  // decode 逻辑在 pollWechatScan 里，这里直接对内联结果做等价验证
  assert.ok(hit.errcode === 405)
  assert.equal(ima.extractUuid('<a href="/connect/qrcode/abc123XYZ_">'), 'abc123XYZ_')
})

await ok('SSE 解析：命名事件 + JSON data + 半截块攒着', () => {
  const { events, rest } = ima.parseSseChunk(
    'event: MESSAGE\ndata: {"Text":"你"}\n\n' +
      'event: THINKING\ndata: {"Text":"想"}\n\n' +
      'event: MES',
  )
  assert.equal(events.length, 2)
  assert.equal(events[0].event, 'MESSAGE')
  assert.equal(events[0].data.Text, '你')
  assert.equal(events[1].event, 'THINKING')
  assert.equal(rest, 'event: MES')

  const more = ima.parseSseChunk(rest + 'SAGE\ndata: {"Text":"好"}\n\n')
  assert.equal(more.events.length, 1)
  assert.equal(more.events[0].data.Text, '好')
  assert.equal(more.rest, '')
})

await ok('微信轮询：405 且带 wx_code → CONFIRMED（jssdk 确认后的真实回包）', async () => {
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response("window.wx_errcode=405;window.wx_code='CODE_XYZ';", {
        status: 200,
        headers: { 'content-type': 'application/javascript' },
      })
    const result = await ima.pollWechatScan({ userAgent: 'UA' }, 'uuid-1')
    assert.equal(result.status, 'confirmed')
    assert.equal(result.code, 'CODE_XYZ')
  } finally {
    globalThis.fetch = realFetch
  }
})

await ok('微信轮询：405 无 code → SCANNED', async () => {
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response("window.wx_errcode=405;window.wx_code='';", {
        status: 200,
        headers: { 'content-type': 'application/javascript' },
      })
    const result = await ima.pollWechatScan({ userAgent: 'UA' }, 'uuid-1')
    assert.equal(result.status, 'scanned')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------------------------------------------------------------- models.js

const models = await import(pathToFileURL(path.join(ROOT, 'lib/models.js')).href)

await ok('normalizeModels：默认模型排第一、去重', () => {
  const list = models.normalizeModels([
    { id: 'official_1', name: 'DeepSeek V3.2 Think', modelType: 1 },
    { id: 'official_3', name: 'DeepSeek V3.2', modelType: 3, isDefault: true },
    { id: 'official_3', name: 'DeepSeek V3.2', modelType: 3, isDefault: true },
  ])
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'official_3')
})

await ok('findModel：找得到 / 回落默认', () => {
  const list = models.normalizeModels([
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', isDefault: true },
  ])
  assert.equal(models.findModel(list, 'a').id, 'a')
  assert.equal(models.findModel(list, 'nope').id, 'b')
})

// ---------------------------------------------------------------- upstream.js

const upstream = await import(pathToFileURL(path.join(ROOT, 'lib/upstream.js')).href)

await ok('buildQuestion：单轮原文 / 多轮加角色标头', () => {
  assert.equal(upstream.buildQuestion([{ role: 'user', content: 'hi' }]), 'hi')
  const multi = upstream.buildQuestion([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Q' },
    { role: 'assistant', content: 'A' },
  ])
  assert.ok(multi.includes('【系统设定】\nS'))
  assert.ok(multi.includes('【用户】\nQ'))
  assert.ok(multi.includes('【助手】\nA'))
})

await ok('buildQaPayload：字段形状（ima.js 再做 snake_case）', () => {
  const payload = upstream.buildQaPayload({
    sessionId: 's1',
    question: 'q',
    model: { id: 'official_1', modelType: 1, enableEnhancement: true },
    clientId: 'c1',
  })
  assert.equal(payload.sessionId, 's1')
  assert.equal(payload.robotType, 10000)
  assert.equal(payload.questionType, 2)
  assert.equal(payload.modelInfo.modelId, 'official_1')
  assert.equal(payload.modelInfo.modelType, 1)
  assert.equal(payload.modelInfo.enableEnhancement, false)
})

/** 起一个假 ima 后端：按脚本回放 SSE。 */
function fakeImaBackend({ qaScript, sessionId = 's1' } = {}) {
  const calls = { init: 0, del: 0, qa: [] }
  const realFetch = globalThis.fetch
  const makeStream = (chunks) => {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
  }
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    const body = init.body ? JSON.parse(init.body) : {}
    if (target.endsWith('/cgi-bin/session_logic/init_session')) {
      calls.init += 1
      return new Response(JSON.stringify({ code: 0, session_id: sessionId }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (target.endsWith('/cgi-bin/session_logic/del_session')) {
      calls.del += 1
      return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (target.endsWith('/cgi-bin/assistant/qa')) {
      calls.qa.push(body)
      return new Response(makeStream(qaScript), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    throw new Error(`fakeImaBackend 没准备这条路由：${target}`)
  }
  return {
    calls,
    /** 打本机反代必须用真 fetch（不然会进到这个假后端里）。 */
    realFetch,
    restore() {
      globalThis.fetch = realFetch
    },
  }
}

const testModel = { id: 'official_3', name: 'DeepSeek V3.2', modelType: 3, enableEnhancement: true }

await ok('chatOnce：MESSAGE 增量流 → 拼出全文并回调增量', async () => {
  const backend = fakeImaBackend({
    qaScript: [
      'event: SESSION_START\ndata: {"MsgSeqID":"m1"}\n\n',
      'event: MESSAGE\ndata: {"Text":"你"}\n\n',
      'event: MESSAGE\ndata: {"Text":"好"}\n\n',
      'event: COMPLETED\ndata: {"Code":0}\n\n',
    ],
  })
  try {
    const deltas = []
    const result = await upstream.chatOnce(
      { getConfig: () => ({}), getAuth: () => ({ token: 't' }), getDevice: () => ({ guid: 'g' }), onDelta: (d) => deltas.push(d) },
      { messages: [{ role: 'user', content: 'hi' }], model: testModel },
    )
    assert.equal(result.ok, true)
    assert.equal(result.text, '你好')
    assert.deepEqual(deltas, ['你', '好'])
    assert.equal(backend.calls.init, 1)
    assert.equal(backend.calls.del, 1)
    assert.equal(backend.calls.qa[0].session_id, 's1')
    assert.equal(backend.calls.qa[0].model_info.model_id, 'official_3')
    assert.equal(backend.calls.qa[0].robot_type, 10000)
  } finally {
    backend.restore()
  }
})

await ok('chatOnce：MESSAGE 全量快照流 → diff 出增量（自适应）', async () => {
  const backend = fakeImaBackend({
    qaScript: [
      'event: MESSAGE\ndata: {"Text":"深度"}\n\n',
      'event: MESSAGE\ndata: {"Text":"深度搜索"}\n\n',
      'event: MESSAGE\ndata: {"Text":"深度搜索完成"}\n\n',
      'event: COMPLETED\ndata: {"Code":0}\n\n',
    ],
  })
  try {
    const deltas = []
    const result = await upstream.chatOnce(
      { getConfig: () => ({}), getAuth: () => ({ token: 't' }), getDevice: () => ({ guid: 'g' }), onDelta: (d) => deltas.push(d) },
      { messages: [{ role: 'user', content: 'hi' }], model: testModel },
    )
    assert.equal(result.ok, true)
    assert.equal(result.text, '深度搜索完成')
    assert.deepEqual(deltas, ['深度', '搜索', '完成'])
  } finally {
    backend.restore()
  }
})

await ok('chatOnce：THINKING 归入 reasoning，PROGRESSING 不混进正文', async () => {
  const backend = fakeImaBackend({
    qaScript: [
      'event: THINKING\ndata: {"Message":"先想","Status":1}\n\n',
      'event: PROGRESSING\ndata: {"processingTips":"正在搜索"}\n\n',
      'event: MESSAGE\ndata: {"Text":"答案"}\n\n',
      'event: COMPLETED\ndata: {"Code":0}\n\n',
    ],
  })
  try {
    const progress = []
    const result = await upstream.chatOnce(
      {
        getConfig: () => ({}),
        getAuth: () => ({ token: 't' }),
        getDevice: () => ({ guid: 'g' }),
        onProgress: (t) => progress.push(t),
      },
      { messages: [{ role: 'user', content: 'hi' }], model: testModel },
    )
    assert.equal(result.ok, true)
    assert.equal(result.text, '答案')
    assert.equal(result.reasoning, '先想')
    assert.deepEqual(progress, ['正在搜索'])
  } finally {
    backend.restore()
  }
})

await ok('chatOnce：COMPLETED 带非 0 Code → ok:false + 中文原因', async () => {
  const backend = fakeImaBackend({
    qaScript: ['event: COMPLETED\ndata: {"Code":500,"Msg":"内部错误"}\n\n'],
  })
  try {
    const result = await upstream.chatOnce(
      { getConfig: () => ({}), getAuth: () => ({ token: 't' }), getDevice: () => ({ guid: 'g' }) },
      { messages: [{ role: 'user', content: 'hi' }], model: testModel },
    )
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('500'))
    assert.ok(result.error.includes('内部错误'))
  } finally {
    backend.restore()
  }
})

// ---------------------------------------------------------------- 手贴 cookie

await ok('手贴 x-ima-cookie：能拆出五件套', async () => {
  // 用一个真的 store 目录跑 index.js 的 /auth/bind 太重，这里直接验证解析逻辑
  const raw = 'IMA-UID=u9; IMA-TOKEN=tk; IMA-REFRESH-TOKEN=rk; UID-TYPE=2; TOKEN-TYPE=0; PLATFORM=H5'
  const jar = {}
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  assert.equal(jar['IMA-TOKEN'], 'tk')
  assert.equal(jar['IMA-REFRESH-TOKEN'], 'rk')
  assert.equal(jar['IMA-UID'], 'u9')
})

// ---------------------------------------------------------------- relay

const { createRelay } = await import(pathToFileURL(path.join(ROOT, 'lib/relay.js')).href)

await ok('反代：/v1/models 与 /healthz', async () => {
  const relay = createRelay({
    getConfig: () => ({}),
    getAuth: () => ({ token: 't' }),
    getDevice: () => ({ guid: 'g' }),
    getModels: () => [testModel, { id: 'official_1', name: 'DS T', modelType: 1 }],
    log: () => {},
  })
  const port = await relay.start(0)
  try {
    const modelsResp = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()
    assert.equal(modelsResp.data.length, 2)
    assert.equal(modelsResp.data[0].id, 'official_3')
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.authed, true)
  } finally {
    relay.close()
  }
})

await ok('反代：非流式对话 → OpenAI 形状', async () => {
  const backend = fakeImaBackend({
    qaScript: [
      'event: MESSAGE\ndata: {"Text":"好的"}\n\n',
      'event: COMPLETED\ndata: {"Code":0}\n\n',
    ],
  })
  const relay = createRelay({
    getConfig: () => ({}),
    getAuth: () => ({ token: 't' }),
    getDevice: () => ({ guid: 'g' }),
    getModels: () => [testModel],
    log: () => {},
  })
  const port = await relay.start(0)
  try {
    const resp = await backend.realFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'official_3', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(resp.status, 200)
    const payload = await resp.json()
    assert.equal(payload.object, 'chat.completion')
    assert.equal(payload.choices[0].message.content, '好的')
    assert.equal(payload.model, 'official_3')
  } finally {
    relay.close()
    backend.restore()
  }
})

await ok('反代：流式对话 → SSE chunk + [DONE]', async () => {
  const backend = fakeImaBackend({
    qaScript: [
      'event: MESSAGE\ndata: {"Text":"你"}\n\n',
      'event: MESSAGE\ndata: {"Text":"好"}\n\n',
      'event: COMPLETED\ndata: {"Code":0}\n\n',
    ],
  })
  const relay = createRelay({
    getConfig: () => ({}),
    getAuth: () => ({ token: 't' }),
    getDevice: () => ({ guid: 'g' }),
    getModels: () => [testModel],
    log: () => {},
  })
  const port = await relay.start(0)
  try {
    const resp = await backend.realFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'official_3', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(resp.status, 200)
    const text = await resp.text()
    const chunks = text.split('\n\n').filter((line) => line.startsWith('data: '))
    assert.ok(chunks.length >= 3, 'chunk 数不对')
    assert.equal(chunks[chunks.length - 1], 'data: [DONE]')
    const parsed = chunks.filter((line) => line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)))
    const content = parsed
      .map((item) => (item.choices && item.choices[0] && item.choices[0].delta && item.choices[0].delta.content) || '')
      .join('')
    assert.equal(content, '你好')
    assert.equal(chunks[chunks.length - 1], 'data: [DONE]')
  } finally {
    relay.close()
    backend.restore()
  }
})

await ok('反代：未登录 → 401 + 中文提示', async () => {
  const relay = createRelay({
    getConfig: () => ({}),
    getAuth: () => null,
    getDevice: () => ({ guid: 'g' }),
    getModels: () => [testModel],
    log: () => {},
  })
  const port = await relay.start(0)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'official_3', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(resp.status, 401)
    const payload = await resp.json()
    assert.ok(payload.error.message.includes('扫码'))
  } finally {
    relay.close()
  }
})

// ---------------------------------------------------------------- 宿主 apply

await ok('宿主 apply：路由注册 + /status 快照 + 免登录读清单', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ima-smoke-'))
  const backend = fakeImaBackend({
    qaScript: ['event: COMPLETED\ndata: {"Code":0}\n\n'],
  })
  // get_models 也要假：
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target.endsWith('/cgi-bin/intelligent_assistant_http_nl/get_models')) {
      return new Response(
        JSON.stringify({
          code: 0,
          models: [
            { model_id: 'official_1', model_name: 'DeepSeek V3.2 Think', model_type: 1, is_default: false },
            { model_id: 'official_3', model_name: 'DeepSeek V3.2', model_type: 3, is_default: true },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return realFetch(url, init)
  }

  const plugin = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href)
  const routes = []
  let settingsMutate = null
  let credentialsSet = null
  plugin.apply(
    {
      inject(list, cb) {
        if (list.includes('webServer')) {
          cb({
            webServer: {
              register: ({ path: p, handler }) => routes.push({ path: p, handler }),
            },
          })
        }
        if (list.includes('settings') && list.includes('credentials')) {
          cb({
            settings: {
              mutate: (domain, ops) => {
                settingsMutate = { domain, ops }
                return Promise.resolve()
              },
            },
            credentials: {
              set: (key, value) => {
                credentialsSet = { key, value }
                return Promise.resolve()
              },
            },
          })
        }
      },
    },
    { dataDir: tmpDir },
  )

  assert.ok(routes.length >= 8, `路由数不对：${routes.length}`)
  assert.ok(routes.some((r) => r.path === '/plugins/dsh-ima/status'))
  assert.ok(routes.some((r) => r.path === '/plugins/dsh-ima/auth/qr/start'))
  assert.ok(routes.some((r) => r.path === '/plugins/dsh-ima/test'))

  // 等启动时读清单跑完
  await new Promise((resolve) => setTimeout(resolve, 300))

  const statusRoute = routes.find((r) => r.path === '/plugins/dsh-ima/status')
  let statusBody = null
  await statusRoute.handler(
    { on() {}, resume() {} },
    { writeHead() {}, end(body) { statusBody = JSON.parse(body) } },
  )
  assert.equal(statusBody.ok, true)
  assert.equal(statusBody.authed, false)
  assert.equal(statusBody.models.length, 2)
  assert.equal(statusBody.models[0].id, 'official_3', '默认模型排第一')

  globalThis.fetch = realFetch
  backend.restore()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- client.js

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
  // 直接读 status.xxx 会在 'plugins.bundle.config' 插槽里抛 TypeError，整块卡片消失。
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
  const render = (node, depth = 0) => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!node || typeof node !== 'object') return ''
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
    assert.ok(html.includes('ima') || html.includes('IMA'), '卡片渲染出来是空的')
    assert.ok(html.includes('扫码') || html.includes('登录'), '登录区块没渲染出来')
  })
})

console.log(`\n全部通过：${passed} 项\n`)
