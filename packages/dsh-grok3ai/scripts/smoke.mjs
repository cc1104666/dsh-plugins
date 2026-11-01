/**
 * 冒烟测试：不启动 DSH、不联网，把插件跑一遍。
 *
 *   node scripts/smoke.mjs
 *
 * 覆盖：
 *   1. store：配置覆盖、状态落盘；
 *   2. spaces：Space 注册表、宽容的名字匹配、provider 形状；
 *   3. upstream：OpenAI messages → 单段提示词的翻译、报错翻译；
 *   4. gradio 客户端：起一个假 Gradio 服务器，真跑 call/event 两段式 ——
 *      累计输出 diff 成增量、error 事件、503、SSE 跨 chunk 分片；
 *   5. 轮换：坏出口 → 直连；吐字后不换；Space 自身报错不换；
 *   6. 反代：真起 http，把假 Space 包成 OpenAI 接口（流式 + 非流式）；
 *   7. 宿主路由：注册情况、/status、出口池入库与开关、provider 注册写的是什么；
 *   8. 浏览器半区：factory 求值、插槽注册、首帧（status=null）渲染。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'grok3ai-smoke-'))
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------ [1] store

console.log('\n[1] store')
const { createStore, DEFAULT_CONFIG } = await import(pathToFileURL(path.join(ROOT, 'lib/store.js')).href)
const store = createStore({ dataDir: sandbox })

await ok('默认配置：反代端口、providerId、上下文上限', () => {
  const cfg = store.config()
  assert.equal(cfg.relayPort, 43695)
  assert.equal(cfg.providerId, 'grok3ai')
  assert.equal(cfg.contextChars, 24000)
  assert.equal(cfg.proxyMode, 'off', '出口池默认关 —— 不换 IP 也应该能用')
})
await ok('patchConfig 会覆盖并落盘，新实例读得到', () => {
  store.patchConfig({ maxTokens: 1234 })
  assert.equal(store.config().maxTokens, 1234)
  assert.equal(createStore({ dataDir: sandbox }).config().maxTokens, 1234)
  store.patchConfig({ maxTokens: DEFAULT_CONFIG.maxTokens })
})
await ok('dataDir 不会被并进 config', () => assert.notEqual(store.config().dataDir, sandbox))
await ok('state 能落盘、新实例读得到', () => {
  store.patchState({ probes: { 'minimax-vl-01': { ok: true, ms: 10, at: Date.now() } } })
  const again = createStore({ dataDir: sandbox }).state()
  assert.equal(again.probes['minimax-vl-01'].ok, true)
})

// ------------------------------------------------------------------ [2] spaces

console.log('\n[2] Space 注册表')
const spacesMod = await import(pathToFileURL(path.join(ROOT, 'lib/spaces.js')).href)
const { SPACES, DEAD_SPACES, resolveSpace, toProviderModels, DEFAULT_SPACE } = spacesMod

await ok('两个能用的 Space，各自指向真正的 Gradio 接口', () => {
  assert.equal(SPACES.length, 2)
  assert.equal(SPACES[0].base, 'https://minimaxai-minimax-vl-01.hf.space')
  assert.equal(SPACES[0].fn, 'chat')
  assert.equal(SPACES[1].fn, 'generate')
  assert.equal(DEFAULT_SPACE, 'minimax-vl-01')
})
await ok('站点里另外三个死掉的只做说明，不进模型列表', () => {
  assert.equal(DEAD_SPACES.length, 3)
  const ids = SPACES.map((item) => item.id)
  for (const dead of DEAD_SPACES) assert.equal(ids.includes(dead.id), false)
})
await ok('模型名宽容匹配：id / 名字 / 去掉符号都认', () => {
  assert.equal(resolveSpace('minimax-vl-01').id, 'minimax-vl-01')
  assert.equal(resolveSpace('MiniMax-VL-01').id, 'minimax-vl-01')
  assert.equal(resolveSpace('minimaxvl01').id, 'minimax-vl-01')
  assert.equal(resolveSpace('llama-2-7b').id, 'llama-2-7b')
  assert.equal(resolveSpace('gpt-4o'), null)
})
await ok('provider 模型形状是 {id,name,input}', () => {
  const models = toProviderModels(SPACES)
  assert.deepEqual(models[0], { id: 'minimax-vl-01', name: 'MiniMax-VL-01', input: ['text'] })
})
await ok('minimax 的入参是 {text,files} 对象（传字符串会让它抛空异常）', () => {
  const data = SPACES[0].build('你好', { maxTokens: 99, temperature: 5, topP: 9 })
  assert.equal(typeof data[0], 'object')
  assert.equal(data[0].text, '你好')
  assert.deepEqual(data[0].files, [])
  assert.equal(data[1] && data[1].length, 0, '第二格是 history state，必须是数组')
  assert.equal(data[2], 99, 'tokens 透传')
  assert.equal(data[3], 2, 'temperature 夹在 0~2')
  assert.equal(data[4], 1, 'top_p 夹在 0~1')
})

// ------------------------------------------------------------------ [3] prompt

console.log('\n[3] 提示词翻译')
const up = await import(pathToFileURL(path.join(ROOT, 'lib/upstream.js')).href)
const { buildPrompt, buildOptions, explainFailure, textOf } = up

await ok('单条用户消息原样发，不加角色前缀', () => {
  assert.equal(buildPrompt([{ role: 'user', content: '你好' }]), '你好')
})
await ok('多轮压成带角色标记的一段', () => {
  const prompt = buildPrompt([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在' },
    { role: 'user', content: '继续' },
  ])
  assert.match(prompt, /用户：你好/)
  assert.match(prompt, /助手：在/)
  assert.match(prompt, /用户：继续/)
  assert.match(prompt, /助手：$/, '结尾要留一个助手的引子')
})
await ok('system 提到最前面，并且不会重复塞进正文', () => {
  const prompt = buildPrompt([
    { role: 'system', content: '只回答数字' },
    { role: 'user', content: '1+1' },
  ])
  assert.match(prompt, /以下是系统设定/)
  assert.match(prompt, /只回答数字/)
  assert.equal((prompt.match(/只回答数字/g) || []).length, 1)
})
await ok('content 是数组（带图片）也能取到文本', () => {
  assert.equal(textOf([{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'x' } }]), '看图\n[图片]')
  assert.equal(buildPrompt([{ role: 'user', content: [{ type: 'text', text: '看' }] }]), '看')
})
await ok('超长上下文从头裁，尾巴（最新的话）一定留着', () => {
  const long = buildPrompt(
    [
      { role: 'user', content: 'A'.repeat(500) },
      { role: 'user', content: '最后一句' },
    ],
    { contextChars: 60 },
  )
  assert.ok(long.length <= 60)
  assert.match(long, /最后一句/)
})
await ok('采样参数缺省时用配置里的值', () => {
  const opts = buildOptions({ maxTokens: 4096, temperature: 0.3, topP: 0.9 }, {})
  assert.equal(opts.maxTokens, 4096)
  assert.equal(opts.temperature, 0.3)
  assert.equal(buildOptions({}, { max_tokens: 100, temperature: 1.2 }).maxTokens, 100)
})
await ok('失败翻译说人话，且区分"重试有用"和"没用"', () => {
  assert.match(explainFailure({ code: 'busy' }), /冷启动/)
  assert.match(explainFailure({ code: 'rate' }), /限流/)
  assert.match(explainFailure({ code: 'space_error', message: 'Space 报错：上游 key 失效' }), /key 失效/)
  assert.match(explainFailure({ code: 'timeout', switches: 2 }), /换过 2 个入口/)
})

// ------------------------------------------------------------------ 假 Gradio 服务器

/**
 * 极简 Gradio 服务器：/config、POST call/chat、GET call/chat/{id}（SSE）。
 * 用 options 控制它怎么答，用来测客户端的各种分支。
 */
function startFakeSpace(options = {}) {
  const state = { data: null, posts: 0 }
  const text = options.text === undefined ? '我是假模型' : options.text
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    if (url.pathname === '/config') {
      const dependencies = [{ api_name: 'chat' }, { api_name: 'lambda' }]
      if (options.noFn) dependencies[0].api_name = 'something_else'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: '5.0.1', mode: 'chat_interface', dependencies }))
      return
    }

    if (url.pathname === '/gradio_api/call/chat' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      try {
        state.data = JSON.parse(Buffer.concat(chunks).toString('utf8')).data
      } catch {
        state.data = null
      }
      state.posts += 1
      if (options.postStatus && options.postStatus !== 200) {
        res.writeHead(options.postStatus, { 'content-type': 'application/json' })
        res.end('{"detail":"Service Unavailable"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ event_id: 'ev-test' }))
      return
    }

    if (url.pathname.startsWith('/gradio_api/call/chat/')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (block) => res.write(block)
      const cumulative = options.steps || [text.slice(0, 2), text.slice(0, 4), text]
      for (const piece of cumulative) {
        send(`event: generating\ndata: ${JSON.stringify([piece, null])}\n\n`)
        if (options.delay) await sleep(options.delay)
      }
      if (options.errorAfter) {
        send(`event: error\ndata: ${JSON.stringify(options.errorMessage ? { error: options.errorMessage } : null)}\n\n`)
        res.end()
        return
      }
      send(`event: complete\ndata: ${JSON.stringify([text, null])}\n\n`)
      res.end()
      return
    }

    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`
      resolve({
        server,
        state,
        space: { ...SPACES[0], base },
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

// ------------------------------------------------------------------ [4] gradio

console.log('\n[4] Gradio 客户端（真起一个假 Space）')
const { runSpace, probeSpace } = await import(pathToFileURL(path.join(ROOT, 'lib/gradio.js')).href)

const fake = await startFakeSpace({ text: '一二三四五' })

await ok('跑一发：增量拼起来等于全文，data 走的是 minimax 那套形状', async () => {
  const deltas = []
  const result = await runSpace(fake.space, '你好', { maxTokens: 256 }, { onDelta: (d) => deltas.push(d), timeout: 8000 })
  assert.equal(result.ok, true)
  assert.equal(result.text, '一二三四五')
  assert.equal(deltas.join(''), '一二三四五', '增量不能重不能漏')
  assert.ok(result.events >= 3, `事件数应该 >=3，实际 ${result.events}`)
  assert.equal(typeof fake.state.data[0], 'object', 'multimodaltextbox 要收到对象')
  assert.equal(fake.state.data[0].text, '你好')
})
await ok('SSE 被拆成多个 TCP 包也能正确解析', async () => {
  const slow = await startFakeSpace({ text: '分片也没事', delay: 15 })
  try {
    const result = await runSpace(slow.space, 'hi', {}, { timeout: 8000 })
    assert.equal(result.ok, true)
    assert.equal(result.text, '分片也没事')
  } finally {
    await slow.close()
  }
})
await ok('error 事件（消息为 null）→ space_error，且不吞掉半截正文', async () => {
  const broken = await startFakeSpace({ text: '开了个头', errorAfter: true })
  try {
    const result = await runSpace(broken.space, 'hi', {}, { timeout: 8000 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'space_error')
    assert.match(result.message, /没给原因/, 'null 消息要单独说明，别让用户以为插件坏了')
    assert.equal(result.text, '开了个头', '已经吐出来的字不能丢')
  } finally {
    await broken.close()
  }
})
await ok('error 事件带原因时原样透出来（比如上游 key 失效）', async () => {
  const broken = await startFakeSpace({ errorAfter: true, errorMessage: 'API error: 412 Precondition Failed' })
  try {
    const result = await runSpace(broken.space, 'hi', {}, { timeout: 8000 })
    assert.equal(result.code, 'space_error')
    assert.match(result.message, /412/)
  } finally {
    await broken.close()
  }
})
await ok('503 → busy（冷启动的人话）', async () => {
  const asleep = await startFakeSpace({ postStatus: 503 })
  try {
    const result = await runSpace(asleep.space, 'hi', {}, { timeout: 8000 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'busy')
    assert.match(result.message, /冷启动|在睡/)
  } finally {
    await asleep.close()
  }
})
await ok('probe 只读 /config：认得出接口还在不在', async () => {
  const good = await probeSpace(fake.space, fetch, { timeout: 5000 })
  assert.equal(good.ok, true)
  assert.equal(good.version, '5.0.1')
  const wrongFn = await startFakeSpace({ noFn: true })
  try {
    const bad = await probeSpace({ ...SPACES[0], base: `http://127.0.0.1:${wrongFn.server.address().port}` }, fetch, { timeout: 5000 })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /没有名为 chat 的接口/)
  } finally {
    await wrongFn.close()
  }
})
await ok('连不上时是 network，不是崩掉', async () => {
  const result = await runSpace({ ...SPACES[0], base: 'http://127.0.0.1:1' }, 'hi', {}, { timeout: 3000 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'network')
})

// ------------------------------------------------------------------ [5] 轮换

console.log('\n[5] 轮换')
const { runWithRotation } = await import(pathToFileURL(path.join(ROOT, 'lib/rotate.js')).href)
const { parseProxy } = await import(pathToFileURL(path.join(ROOT, 'lib/proxy-agent.js')).href)

await ok('坏出口失败后自动落到直连（一发请求里完成）', async () => {
  const routes = [
    { id: 'dead', label: '死代理', space: fake.space, proxy: parseProxy('http://127.0.0.1:1'), mode: 'sticky' },
    { id: 'direct', label: '直连', space: fake.space, proxy: null, mode: 'sticky' },
  ]
  const seen = []
  const result = await runWithRotation({}, { prompt: '你好', opts: {} }, {}, {
    routes,
    timeout: 6000,
    onResult: (route, res) => seen.push([route.id, res.ok]),
  })
  assert.equal(result.ok, true)
  assert.equal(result.switches, 1)
  assert.equal(result.route.id, 'direct')
  assert.deepEqual(seen[0], ['dead', false])
})
await ok('已经吐字就不换出口（否则会拼出两段半截回答）', async () => {
  const partial = await startFakeSpace({ text: '半截', errorAfter: true })
  let calls = 0
  try {
    const routes = [
      { id: 'a', label: 'A', space: partial.space, proxy: null, mode: 'sticky' },
      { id: 'b', label: 'B', space: fake.space, proxy: null, mode: 'sticky' },
    ]
    const result = await runWithRotation({}, { prompt: 'hi', opts: {} }, { onDelta: () => {} }, { routes, timeout: 6000, onResult: () => (calls += 1) })
    assert.equal(result.ok, false)
    assert.equal(result.partial, true)
    assert.equal(calls, 1, '吐过字就不该再试第二个入口')
  } finally {
    await partial.close()
  }
})
await ok('Space 自家后端的错（space_error）换出口也没用，不浪费请求', async () => {
  const broken = await startFakeSpace({ errorAfter: true })
  let calls = 0
  try {
    const routes = [
      { id: 'a', label: 'A', space: broken.space, proxy: null, mode: 'sticky' },
      { id: 'b', label: 'B', space: fake.space, proxy: null, mode: 'sticky' },
    ]
    const result = await runWithRotation({}, { prompt: 'hi', opts: {} }, {}, { routes, timeout: 6000, onResult: () => (calls += 1) })
    assert.equal(result.code, 'space_error')
    assert.equal(calls, 1)
  } finally {
    await broken.close()
  }
})
await ok('预算上限生效：maxAttempts=1 时只打一发', async () => {
  let calls = 0
  const routes = [
    { id: 'a', label: 'A', space: { ...SPACES[0], base: 'http://127.0.0.1:1' }, proxy: null, mode: 'rotating' },
    { id: 'b', label: 'B', space: fake.space, proxy: null, mode: 'sticky' },
  ]
  const result = await runWithRotation({}, { prompt: 'hi', opts: {} }, {}, { routes, timeout: 3000, maxAttempts: 1, onResult: () => (calls += 1) })
  assert.equal(calls, 1)
  assert.equal(result.ok, false)
})

// ------------------------------------------------------------------ [6] 反代

console.log('\n[6] 反代：把假 Space 包成 OpenAI 接口')
const { createRelay } = await import(pathToFileURL(path.join(ROOT, 'lib/relay.js')).href)

const relaySpace = { ...fake.space, id: 'minimax-vl-01', name: 'MiniMax-VL-01' }
const relay = createRelay({
  getConfig: () => ({ ...DEFAULT_CONFIG, dataDir: sandbox }),
  getModels: () => [relaySpace],
  getPlan: () => ({
    routes: [{ id: 'direct', label: '直连', space: relaySpace, proxy: null, mode: 'sticky' }],
    timeout: 8000,
  }),
})
const relayPort = await relay.start(0)

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: relayPort,
        path,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            /* 流式不是 JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

await ok('/v1/models 列出的是真模型 id', async () => {
  const { status, json } = await httpJson('GET', '/v1/models')
  assert.equal(status, 200)
  assert.deepEqual(json.data.map((item) => item.id), ['minimax-vl-01'])
  assert.equal(json.data[0].owned_by, 'grok3ai')
})
await ok('非流式：返回标准 chat.completion，model 是请求的那个', async () => {
  const { status, json } = await httpJson('POST', '/v1/chat/completions', {
    model: 'MiniMax-VL-01',
    messages: [{ role: 'user', content: '你好' }],
  })
  assert.equal(status, 200)
  assert.equal(json.object, 'chat.completion')
  assert.equal(json.model, 'minimax-vl-01')
  assert.equal(json.choices[0].message.content, '一二三四五')
  assert.equal(json.choices[0].finish_reason, 'stop')
  assert.ok(json.usage.total_tokens > 0)
})
await ok('流式：chunk 是标准 OpenAI 形状，结尾有 [DONE]', async () => {
  const payload = JSON.stringify({
    model: 'minimax-vl-01',
    stream: true,
    messages: [
      { role: 'system', content: '你是简洁的助手' },
      { role: 'user', content: '你好' },
    ],
  })
  const { status, text, headers } = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: relayPort, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let buffer = ''
        res.on('data', (c) => (buffer += c))
        res.on('end', () => resolve({ status: res.statusCode, text: buffer, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
  assert.equal(status, 200)
  assert.match(String(headers['content-type']), /event-stream/)
  const lines = text.split('\n\n').filter(Boolean)
  const chunks = lines.map((line) => line.replace(/^data: /, '')).filter((data) => data !== '[DONE]')
  const parsed = chunks.map((data) => JSON.parse(data))
  const assembled = parsed.map((c) => (c.choices[0].delta.content || '')).join('')
  assert.equal(assembled, '一二三四五')
  assert.equal(parsed[0].choices[0].delta.role, 'assistant')
  assert.ok(text.includes('data: [DONE]'))
  // system 应该被压进提示词，而不是丢掉
  assert.match(fake.state.data[0].text, /以下是系统设定/)
})
await ok('上游 5xx 会变成 502 + 人话，不是空响应', async () => {
  const broken = await startFakeSpace({ postStatus: 503 })
  const brokenRelay = createRelay({
    getConfig: () => ({ ...DEFAULT_CONFIG }),
    getModels: () => [{ ...SPACES[0], base: `http://127.0.0.1:${broken.server.address().port}` }],
    getPlan: () => ({
      routes: [{ id: 'd', label: '直连', space: { ...SPACES[0], base: `http://127.0.0.1:${broken.server.address().port}` }, proxy: null, mode: 'sticky' }],
      timeout: 5000,
    }),
  })
  const port = await brokenRelay.start(0)
  try {
    const { status, json } = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          let buffer = ''
          res.on('data', (c) => (buffer += c))
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buffer) }))
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify({ model: 'minimax-vl-01', messages: [{ role: 'user', content: 'hi' }] }))
    })
    assert.equal(status, 503)
    assert.equal(json.error.code, 'busy')
    assert.match(json.error.message, /冷启动|在睡/)
  } finally {
    brokenRelay.close()
    await broken.close()
  }
})
relay.close()

// ------------------------------------------------------------------ [7] 宿主路由

console.log('\n[7] 宿主半区：路由 / 出口池 / provider 注册')
const plugin = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href)

const routes = new Map()
const mutations = []
const creds = {}
const ctx = {
  inject(names, fn) {
    const bag = {}
    for (const name of names) {
      if (name === 'webServer') {
        bag.webServer = {
          register(route) {
            routes.set(route.path, route.handler)
          },
        }
      }
      if (name === 'settings') {
        bag.settings = {
          mutate: async (service, ops) => {
            mutations.push({ service, ops })
          },
        }
      }
      if (name === 'credentials') {
        bag.credentials = {
          set: async (key, value) => {
            creds[key] = value
          },
        }
      }
    }
    fn(bag)
  },
  on() {},
}

plugin.apply(ctx, { dataDir: sandbox, relayPort: 0, probeOnStart: false })

const app = http.createServer((req, res) => {
  const pathname = String(req.url || '').split('?')[0]
  const handler = routes.get(pathname)
  if (!handler) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  handler(req, res)
})
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
const appPort = app.address().port
const call = (apiPath, body) => httpJson2(appPort, apiPath, body)

function httpJson2(port, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/plugins/dsh-grok3ai${apiPath}`,
        method: payload ? 'POST' : 'GET',
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode, json: null, text })
          }
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

await ok('注册了 10 条路由，且都在插件前缀下', async () => {
  assert.equal(routes.size, 10)
  for (const key of routes.keys()) assert.ok(key.startsWith('/plugins/dsh-grok3ai/'), key)
})
await ok('启动时就把 provider 写进 llm-pi-ai（重启后选择器里还在）', async () => {
  await sleep(30)
  assert.equal(mutations.length >= 1, true, '没有写 provider')
  const op = mutations[mutations.length - 1].ops[0]
  assert.equal(op.path[0], 'providers')
  assert.equal(op.path[1], 'grok3ai')
  assert.equal(op.value.api, 'openai-completions')
  assert.match(op.value.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.deepEqual(op.value.models.map((m) => m.id), ['minimax-vl-01', 'llama-2-7b'])
  assert.equal(creds.GROK3AI_API_KEY, 'local-relay')
})
await ok('/status 告诉面板"这个站其实是谁"', async () => {
  const { json } = await call('/status')
  assert.equal(json.ok, true)
  assert.equal(json.models.length, 2)
  assert.equal(json.models[0].base, 'https://minimaxai-minimax-vl-01.hf.space')
  assert.equal(json.dead.length, 3)
  assert.equal(json.proxy.mode, 'off')
  assert.equal(json.provider.registered, true)
})
await ok('/proxy/save：坏行报第几行，好行照样存', async () => {
  const { json } = await call('/proxy/save', { text: 'http://127.0.0.1:1\nftp://1.1.1.1:21\n' })
  assert.equal(json.ok, false)
  assert.match(json.error, /第 2 行/)
  assert.equal(json.proxy.count, 1)
})
await ok('/proxy/mode：开关和生效分开上报', async () => {
  const on = await call('/proxy/mode', { mode: 'auto' })
  assert.equal(on.json.proxy.mode, 'auto')
  assert.equal(on.json.proxy.effective, true)
  const off = await call('/proxy/mode', { mode: 'off' })
  assert.equal(off.json.proxy.effective, false)
})
await ok('/proxy/test 探不通时报错但不把插件打挂', async () => {
  const { json } = await call('/proxy/test', {})
  assert.equal(json.ok, false)
  assert.match(json.error, /不通/)
  assert.equal(json.proxies[0].state, 'cooling', '失败要进冷却，别连续撞')
})
await ok('/proxy/remove 删干净，清空也不出错', async () => {
  const id = (await call('/status')).json.proxies[0].id
  const one = await call('/proxy/remove', { id })
  assert.equal(one.json.proxy.count, 0)
  const cleared = await call('/proxy/save', { text: '', clear: true })
  assert.equal(cleared.json.ok, true)
})
await ok('/spaces/enable 至少留一个模型', async () => {
  const one = await call('/spaces/enable', { id: 'llama-2-7b', enabled: false })
  assert.equal(one.json.ok, true)
  assert.deepEqual(one.json.models.map((m) => m.id), ['minimax-vl-01'])
  const none = await call('/spaces/enable', { id: 'minimax-vl-01', enabled: false })
  assert.equal(none.json.ok, false)
  assert.match(none.json.error, /至少留一个/)
  await call('/spaces/enable', { id: 'llama-2-7b', enabled: true })
})

app.close()

// ------------------------------------------------------------------ [8] 浏览器半区

console.log('\n[8] 浏览器半区')

let factory = null
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

const clientPath = pathToFileURL(path.join(ROOT, 'lib/client.js')).href

await ok('client factory 能求值，apply 注册 dock 与插件页插槽', async () => {
  await import(`${clientPath}?v=${Date.now()}`)
  assert.equal(typeof factory, 'function', 'factory 没被注册到模块加载器')
  const registrations = []
  const mod = factory((id) => {
    if (id !== 'react') throw new Error(`没准备这个模块：${id}`)
    return {
      createElement: (...args) => ({ args }),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      useMemo: (fn) => fn(),
    }
  })
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
  mod.apply({
    slots: {
      inject(slotName, fn) {
        registrations.push(slotName)
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

/** 用极简 hook 模拟器把组件真跑一遍，把返回的树摊平成文本。 */
async function renderCard(snapshot) {
  const components = []
  await import(`${clientPath}?v=render-${Date.now()}-${Math.random()}`)
  const mod = factory((id) => {
    if (id !== 'react') throw new Error(`没准备这个模块：${id}`)
    let seen = 0
    return {
      createElement: (type, props, ...children) => ({
        type,
        props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
      }),
      // 第 1 个 useState 是 useTheme 的 dark，第 2 个是 status
      useState: (initial) => {
        seen += 1
        const value = seen === 2 ? snapshot : typeof initial === 'function' ? initial() : initial
        return [value, () => {}]
      },
      useEffect: () => {},
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      useMemo: (fn) => fn(),
    }
  })
  mod.apply({
    slots: {
      inject(slotName, fn) {
        fn()
      },
      register(meta, component) {
        components.push({ name: meta.name, component })
        return meta
      },
    },
  })
  const card = components.find((item) => item.name === 'plugins.bundle.config')
  assert.ok(card, '没拿到插件页卡片组件')
  const render = (node) => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (Array.isArray(node)) return node.map((child) => render(child)).join('')
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (typeof node !== 'object') return ''
    if (typeof node.type === 'function') return render(node.type(node.props || {}))
    const children = node.props && node.props.children
    const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
    return list.map((child) => render(child)).join('')
  }
  return render(card.component())
}

await ok('首帧（status 还是 null）渲染不崩', async () => {
  const html = await renderCard(null)
  assert.ok(html.includes('Grok3AI'), '标题没出来')
  assert.ok(html.includes('未注册'), '状态行没出来')
})

await ok('有数据时渲染：模型、说明、出口池都在', async () => {
  const snapshot = {
    ok: true,
    relay: { port: 43695, baseURL: 'http://127.0.0.1:43695/v1' },
    provider: { registered: true, count: 2, baseURL: 'http://127.0.0.1:43695/v1', providerName: 'Grok3AI' },
    models: [
      {
        id: 'minimax-vl-01',
        name: 'MiniMax-VL-01',
        vendor: 'MiniMax（海螺 AI）',
        note: 'grok3ai.org 的聊天页现在嵌的就是这个',
        base: 'https://minimaxai-minimax-vl-01.hf.space',
        fn: 'chat',
        probe: { ok: true, ms: 420, version: '5.0.1', error: '', at: Date.now() },
      },
      {
        id: 'llama-2-7b',
        name: 'Llama-2-7B-Chat',
        vendor: 'Meta',
        note: '兜底',
        base: 'https://huggingface-projects-llama-2-7b-chat.hf.space',
        fn: 'generate',
        probe: { ok: false, ms: 0, version: '', error: '503', at: Date.now() },
      },
    ],
    dead: [{ id: 'qwen3-30b', name: 'Qwen3-30B-A3B', reason: '上游 key 失效' }],
    config: { contextChars: 24000, maxTokens: 4096, temperature: 0.3, requestTimeout: 180000, proxyMode: 'auto' },
    proxy: { mode: 'auto', effective: true, count: 1, ready: 1, fresh: 0, cooling: 0, rotating: 1, allowDirect: true, maxAttempts: 6 },
    proxies: [
      { id: 'a', masked: 'http://u:***@1.1.1.1:8000', label: '1.1.1.1:8000', mode: 'rotating', template: true, modeText: '自换 IP', state: 'rotating', stateText: '动态', ip: '1.1.1.1', ms: 120, used: 2, cooling: false, lastError: '' },
    ],
  }
  const html = await renderCard(snapshot)
  assert.ok(html.includes('MiniMax-VL-01'))
  assert.ok(html.includes('可用'), '探活状态没渲染')
  assert.ok(html.includes('不通'), '失败的 Space 应该有标记')
  assert.ok(html.includes('MiniMax（海螺 AI）'))
  assert.ok(html.includes('这个站到底是什么'), '必须解释站点其实是 iframe')
  assert.ok(html.includes('http://u:***@1.1.1.1:8000'), '出口行没出来')
  assert.equal(html.includes('secret'), false)
})

console.log(`\n全部通过：${passed} 项`)
await fake.close()
try {
  fs.rmSync(sandbox, { recursive: true, force: true })
} catch {
  /* 沙箱删不掉不影响结论 */
}
process.exit(0)
