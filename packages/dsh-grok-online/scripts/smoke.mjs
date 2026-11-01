/**
 * 冒烟测试：不启动 DSH 也把插件跑一遍。
 *
 *   node scripts/smoke.mjs
 *
 * 覆盖：
 *   1. store：配置覆盖、额度缓存跨天失效；
 *   2. models：模型名归一（x-ai/grok-4.20 → grok-4-20）、locked 判定、provider 形状；
 *   3. upstream：OpenAI → grok.online 的请求翻译（system→role、上下文裁剪、tool→user）、
 *      报错翻译；
 *   4. 宿主半区：6 条路由、额度查询/领取、provider 注册、本机反代真起真应答
 *      （流式 chunk 必须是标准 OpenAI 形状，否则 DSH 那边会卡住）；
 *   5. 浏览器半区：factory 能求值、apply 注册插槽、插件页卡片首帧能渲染。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-online-smoke-'))
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

console.log('\n[1] store')
const { createStore, DEFAULT_CONFIG, utcDay } = await import(pathToFileURL(path.join(ROOT, 'lib/store.js')).href)
const store = createStore({ dataDir: sandbox })

await ok('默认配置指向 grok.online，providerId 不带点', () => {
  assert.equal(store.config().siteBase, 'https://grok.online')
  assert.equal(store.config().apiPath, '/api/chat')
  assert.equal(store.config().providerId, 'grok-online')
  assert.equal(store.config().relayPort, 43690)
})
await ok('patchConfig 会覆盖', () => {
  assert.equal(store.patchConfig({ contextChars: 5000 }).contextChars, 5000)
  assert.equal(store.patchConfig({ contextChars: DEFAULT_CONFIG.contextChars }).contextChars, 10000)
})
await ok('dataDir 不会被并进 config', () => assert.notEqual(store.config().dataDir, sandbox))
await ok('额度缓存能落盘、新实例读得到', () => {
  store.patchState({ credits: 7, bonus: 'locked' })
  const fresh = createStore({ dataDir: sandbox })
  assert.equal(fresh.state().credits, 7)
  assert.equal(fresh.state().bonus, 'locked')
})
await ok('跨天的额度缓存会作废', () => {
  const fresh = createStore({ dataDir: sandbox })
  fresh.patchState({ credits: 3, bonus: 'used', day: '2000-01-01' })
  const state = createStore({ dataDir: sandbox }).state()
  assert.equal(state.credits, null, '昨天的数字不该当成今天的')
  assert.equal(state.stale, true)
  assert.equal(state.day, '2000-01-01')
})
await ok('utcDay 是 UTC 日期', () => {
  assert.equal(utcDay(new Date('2026-10-30T23:30:00+08:00')), '2026-10-30')
  assert.equal(utcDay(new Date('2026-10-31T01:30:00+08:00')), '2026-10-30')
})

console.log('\n[2] 模型清单')
const modelsMod = await import(pathToFileURL(path.join(ROOT, 'lib/models.js')).href)
const { canonicalModel, isLockedModel, toProviderModels, MODELS, LOCKED_MODELS } = modelsMod

await ok('三种写法都能收成上游 key', () => {
  assert.equal(canonicalModel('grok-4-20'), 'grok-4-20')
  assert.equal(canonicalModel('grok-4.20'), 'grok-4-20')
  assert.equal(canonicalModel('x-ai/grok-4.20'), 'grok-4-20')
  assert.equal(canonicalModel('Grok 4.3 Thinking'), 'grok-4-3')
  assert.equal(canonicalModel('x-ai/grok-4.3'), 'grok-4-3')
})
await ok('认不出来时回落到默认模型，而不是抛错', () => {
  assert.equal(canonicalModel(''), 'grok-4-20')
  assert.equal(canonicalModel('gpt-4o'), 'grok-4-20')
  assert.equal(canonicalModel(undefined), 'grok-4-20')
})
await ok('grok-4-7 被识别为 locked', () => {
  assert.equal(isLockedModel('grok-4-7'), true)
  assert.equal(isLockedModel('x-ai/grok-4.7'), true)
  assert.equal(isLockedModel('grok-4-20'), false)
})
await ok('只有两个模型会进选择器', () => {
  assert.equal(MODELS.length, 2)
  assert.equal(LOCKED_MODELS.length, 1)
  assert.deepEqual(
    toProviderModels(MODELS).map((m) => m.id),
    ['grok-4-20', 'grok-4-3'],
  )
  assert.deepEqual(toProviderModels([MODELS[0]])[0], { id: 'grok-4-20', name: 'Grok 4.20', input: ['text'] })
})

console.log('\n[3] 请求翻译')
const up = await import(pathToFileURL(path.join(ROOT, 'lib/upstream.js')).href)
const { buildGrokPayload, contentText, explainFailure } = up
const cfg = { ...DEFAULT_CONFIG, dataDir: sandbox }

await ok('system 抽出来塞进 role，正文按原顺序留下', () => {
  const payload = buildGrokPayload(cfg, {
    model: 'grok-4.20',
    messages: [
      { role: 'system', content: '你是一个简洁的中文助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在' },
      { role: 'user', content: '再说一句' },
    ],
  })
  assert.equal(payload.model, 'grok-4-20')
  assert.equal(payload.role, '你是一个简洁的中文助手')
  assert.deepEqual(payload.messages, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在' },
    { role: 'user', content: '再说一句' },
  ])
})
await ok('role 超过 2000 字符会被截断（站点硬限制）', () => {
  const payload = buildGrokPayload(cfg, {
    model: 'grok-4-20',
    messages: [
      { role: 'system', content: 'x'.repeat(5000) },
      { role: 'user', content: 'hi' },
    ],
  })
  assert.equal(payload.role.length, 2000)
})
await ok('tool 结果当成 user 喂回去，不丢信息', () => {
  const payload = buildGrokPayload(cfg, {
    model: 'grok-4-20',
    messages: [
      { role: 'user', content: '查一下时间' },
      { role: 'tool', content: '2026-10-30 09:00' },
    ],
  })
  assert.equal(payload.messages[1].role, 'user')
  assert.match(payload.messages[1].content, /2026-10-30/)
})
await ok('超长上下文从最早的开始裁，最后一条用户消息必须留下', () => {
  const payload = buildGrokPayload({ ...cfg, contextChars: 100 }, {
    model: 'grok-4-20',
    messages: [
      { role: 'user', content: 'A'.repeat(80) },
      { role: 'assistant', content: 'B'.repeat(80) },
      { role: 'user', content: '最后一句' },
    ],
  })
  // 倒着装：最后一句（4 字符）+ 上一条 assistant（80）刚好塞得下，最早那条被丢掉。
  assert.equal(payload.messages[payload.messages.length - 1].content, '最后一句')
  assert.equal(
    payload.messages.some((item) => item.content.startsWith('AAAA')),
    false,
    '最早的那条应该被裁掉',
  )
})
await ok('裁剪时最后一条无论多长都保留（否则等于没问）', () => {
  const payload = buildGrokPayload({ ...cfg, contextChars: 10 }, {
    model: 'grok-4-20',
    messages: [{ role: 'user', content: 'C'.repeat(500) }],
  })
  assert.equal(payload.messages.length, 1)
  assert.equal(payload.messages[0].content.length, 500)
})
await ok('content 是分段数组时取文本、图片留占位', () => {
  assert.equal(contentText([{ type: 'text', text: '看这个' }, { type: 'image_url', image_url: { url: 'x' } }]), '看这个\n[图片]')
  assert.equal(contentText('纯字符串'), '纯字符串')
  assert.equal(contentText(null), '')
})
await ok('空消息也能构造出合法请求（至少一条 user）', () => {
  const payload = buildGrokPayload(cfg, { model: 'grok-4-20', messages: [] })
  assert.equal(payload.messages.length, 1)
  assert.equal(payload.messages[0].role, 'user')
})
await ok('报错翻译成人话，limit 要说清 4+5 和重置时间', () => {
  const text = explainFailure({ code: 'limit', bonus: 'available' })
  assert.match(text, /额度/)
  assert.match(text, /4 条/)
  assert.match(text, /5 条/)
  assert.match(text, /UTC/)
  assert.match(explainFailure({ code: 'model_locked' }), /App/)
  assert.match(explainFailure({ code: 'rate' }), /快/)
})

console.log('\n[4] 宿主半区 + 反代')

/** 假网络：模拟 /api/chat 的三种动作。 */
/** 假 SSE：第一条报剩余额度，正文两段，最后 finish + usage + [DONE]。 */
const sseLines = (credits) => [
  `data: {"credits":${credits},"bonus":"locked"}`,
  '',
  ': OPENROUTER PROCESSING',
  '',
  'data: {"id":"gen-1","object":"chat.completion.chunk","model":"x-ai/grok-4.20","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"先想一下"},"finish_reason":null}]}',
  '',
  'data: {"id":"gen-1","object":"chat.completion.chunk","model":"x-ai/grok-4.20","choices":[{"index":0,"delta":{"content":"可用"},"finish_reason":null}]}',
  '',
  'data: {"id":"gen-1","object":"chat.completion.chunk","model":"x-ai/grok-4.20","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
  '',
  'data: [DONE]',
  '',
]

let creditsLeft = 9
let bonusState = 'locked'
const calls = []

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  calls.push({ url: target, method: options.method || 'GET' })
  if (target.includes('credits=1')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ credits: creditsLeft, bonus: bonusState }),
    }
  }
  if (target.includes('unlock=1')) {
    bonusState = 'used'
    creditsLeft += 5
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ credits: creditsLeft, bonus: 'used' }),
    }
  }
  if (target.includes('/api/chat')) {
    creditsLeft = Math.max(0, creditsLeft - 1)
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream; charset=utf-8' },
      body: Readable.from(sseLines(creditsLeft).map((line) => Buffer.from(`${line}\n`, 'utf8'))),
      text: async () => '',
    }
  }
  throw new Error(`假网络没准备这个地址：${target}`)
}
const fakeFetch = globalThis.fetch

const host = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href)
const routes = new Map()
const settingsOps = []
const credentialWrites = []

host.apply(
  {
    inject(services, callback) {
      const bag = {}
      if (services.includes('webServer')) {
        bag.webServer = {
          register(route) {
            routes.set(route.path, route)
          },
        }
      }
      if (services.includes('settings')) {
        bag.settings = {
          async mutate(namespace, ops) {
            settingsOps.push({ namespace, ops })
          },
        }
      }
      if (services.includes('credentials')) {
        bag.credentials = {
          async set(name, value) {
            credentialWrites.push({ name, value })
          },
        }
      }
      callback(bag)
    },
    on() {},
  },
  { dataDir: sandbox },
)
// 等启动时那次 publishProvider 跑完
await new Promise((resolve) => setTimeout(resolve, 120))

await ok('导出 name / apply', () => {
  assert.equal(host.name, 'grok-online')
  assert.equal(typeof host.apply, 'function')
})
await ok('注册了 10 条路由，且都在插件前缀下', () => {
  assert.equal(routes.size, 10, `实际 ${routes.size} 条：${[...routes.keys()].join(', ')}`)
  assert.ok([...routes.keys()].every((key) => key.startsWith('/plugins/dsh-grok-online/')))
})
await ok('开机就注册了 provider，baseURL 指向本机反代', () => {
  assert.equal(settingsOps.length >= 1, true)
  const op = settingsOps[settingsOps.length - 1]
  assert.equal(op.namespace, 'llm-pi-ai')
  const value = op.ops[0].value
  assert.equal(op.ops[0].path[1], 'grok-online')
  assert.equal(value.displayName, 'Grok.online')
  assert.equal(value.api, 'openai-completions')
  assert.match(value.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.deepEqual(
    value.models.map((m) => m.id),
    ['grok-4-20', 'grok-4-3'],
  )
  assert.equal(value.apiKeyEnv, 'GROK_ONLINE_API_KEY')
})
await ok('假钥匙写进了 credentials（反代不校验，但 llm-pi-ai 要求有值）', () => {
  assert.equal(credentialWrites[credentialWrites.length - 1].name, 'GROK_ONLINE_API_KEY')
  assert.equal(credentialWrites[credentialWrites.length - 1].value, 'local-relay')
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
  const route = routes.get(`/plugins/dsh-grok-online/${routePath}`)
  if (!route) throw new Error(`没有这条路由：${routePath}`)
  const res = fakeRes()
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')])
  req.headers = {}
  return Promise.resolve(route.handler(req, res)).then(() => ({
    status: res.out.status,
    json: JSON.parse(res.out.body || '{}'),
  }))
}

await ok('/status 报告额度、模型、反代端口', async () => {
  const { status, json } = await call('status')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.credits, 9)
  assert.equal(json.provider.registered, true)
  assert.equal(json.models.length, 2)
  assert.equal(json.locked.length, 1)
  assert.match(json.relay.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.equal(json.quota.free, 4)
  assert.equal(json.quota.bonus, 5)
})
await ok('刷新额度会真的打上游（?credits=1）', async () => {
  creditsLeft = 6
  const { json } = await call('credits/refresh', {})
  assert.equal(json.credits, 6)
  assert.ok(calls.some((item) => item.url.includes('credits=1')))
})
await ok('领取奖励走 ?unlock=1，并把新额度写回', async () => {
  creditsLeft = 0
  bonusState = 'available'
  const { json } = await call('credits/unlock', {})
  assert.equal(json.ok, true)
  assert.equal(json.credits, 5)
  assert.equal(json.bonus, 'used')
  assert.ok(calls.some((item) => item.url.includes('unlock=1')))
})
await ok('试一句能拿到正文，并把剩余额度带回', async () => {
  creditsLeft = 4
  const { json } = await call('test', { model: 'grok-4.20', text: '说三个字' })
  assert.equal(json.ok, true)
  assert.equal(json.model, 'grok-4-20')
  assert.equal(json.text, '可用')
  assert.equal(json.credits, 3)
})
await ok('注册按钮会重写一次 provider', async () => {
  const before = settingsOps.length
  const { json } = await call('models/register', {})
  assert.equal(json.ok, true)
  assert.equal(settingsOps.length, before + 1)
})

// ---- 出口池（宿主侧：保存 / 开关 / 探测 / 坏出口回退直连）
await ok('/proxy/save 存下能认的行，坏行回错误但不丢好行', async () => {
  const { json } = await call('proxy/save', {
    text: 'http://127.0.0.1:1\nftp://1.1.1.1:21\n',
  })
  assert.equal(json.ok, false)
  assert.match(json.error, /第 2 行/)
  assert.equal(json.proxy.count, 1, '好的那行应该存下来')
  assert.equal(json.proxies.length, 1)
  assert.equal(json.proxies[0].masked, 'http://127.0.0.1:1')
})
await ok('/proxy/mode 打开自动换出口', async () => {
  const { json } = await call('proxy/mode', { mode: 'auto' })
  assert.equal(json.ok, true)
  assert.equal(json.proxy.mode, 'auto')
  assert.match(json.message, /已开启/)
})
await ok('/status 暴露出口池（含每个出口的状态）', async () => {
  const { json } = await call('status')
  assert.equal(json.proxy.mode, 'auto')
  assert.equal(json.proxy.count, 1)
  assert.equal(json.proxies[0].stateText, '未探测')
  assert.equal(json.proxy.allowDirect, true)
  assert.equal(json.config.proxyMode, 'auto')
})
await ok('/proxy/test 探不通报错，但不会把插件打挂', async () => {
  const before = routes.size
  const { json } = await call('proxy/test', {})
  assert.equal(routes.size, before)
  assert.equal(json.ok, false)
  assert.match(json.error, /不通/)
  assert.equal(json.proxies[0].stateText, '冷却中')
})
await ok('出口坏了会自动回退直连（一发请求里完成）', async () => {
  creditsLeft = 5
  const { json } = await call('test', { model: 'grok-4-20', text: '说三个字' })
  assert.equal(json.ok, true)
  assert.equal(json.route, '直连')
  assert.equal(json.switches, 1, '应该先试过那个坏出口')
  assert.equal(json.text, '可用')
})
await ok('/proxy/remove 删掉出口，清空也不出错', async () => {
  const first = await call('proxy/remove', { id: (await call('status')).json.proxies[0].id })
  assert.equal(first.json.ok, true)
  assert.equal(first.json.proxy.count, 0)
  const cleared = await call('proxy/save', { text: '', clear: true })
  assert.equal(cleared.json.ok, true)
  const off = await call('proxy/mode', { mode: 'off' })
  assert.equal(off.json.proxy.mode, 'off')
  globalThis.fetch = fakeFetch
})

// ---- 反代真起真应答（DSH 走的就是这条路）
const statusNow = (await call('status')).json
const baseURL = statusNow.relay.baseURL
assert.ok(baseURL, '反代没起来')

await ok('反代 /v1/models 返回 OpenAI 形状', async () => {
  const response = await fetchReal(`${baseURL}/models`)
  const json = await response.json()
  assert.equal(json.object, 'list')
  assert.deepEqual(
    json.data.map((item) => item.id),
    ['grok-4-20', 'grok-4-3'],
  )
})
await ok('反代流式：chunk 是标准 OpenAI chunk，最后有 [DONE]', async () => {
  creditsLeft = 2
  const response = await fetchReal(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-4.20', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /event-stream/)
  const text = await response.text()
  const lines = text.split('\n').filter((line) => line.startsWith('data: '))
  assert.ok(lines.includes('data: [DONE]'), '缺少 [DONE]')
  const chunks = lines
    .filter((line) => line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)))
  assert.ok(chunks.every((chunk) => chunk.object === 'chat.completion.chunk'))
  const content = chunks
    .map((chunk) => (chunk.choices[0].delta && chunk.choices[0].delta.content) || '')
    .join('')
  assert.equal(content, '可用')
  const last = chunks[chunks.length - 1]
  assert.equal(last.choices[0].finish_reason, 'stop')
  assert.ok(last.usage && last.usage.total_tokens > 0)
})
await ok('反代非流式：一次性返回完整 message', async () => {
  creditsLeft = 2
  const response = await fetchReal(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-4-20', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const json = await response.json()
  assert.equal(json.object, 'chat.completion')
  assert.equal(json.choices[0].message.content, '可用')
  assert.equal(json.model, 'grok-4-20')
})
await ok('反代把额度用完翻成 429 + 人话', async () => {
  creditsLeft = 0
  bonusState = 'used'
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    if (target.includes('credits=1')) {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"credits":0,"bonus":"used"}' }
    }
    return {
      ok: false,
      status: 429,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { code: 'limit', message: 'Daily allowance used' }, credits: 0, bonus: 'used', wait: 1 }),
    }
  }
  const response = await fetchReal(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-4-20', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(response.status, 429)
  const json = await response.json()
  assert.match(json.error.message, /额度/)
  assert.equal(json.error.code, 'limit')
})

console.log('\n[5] 出口池：解析 / 排序 / 记账')
const poolMod = await import(pathToFileURL(path.join(ROOT, 'lib/pool.js')).href)
const {
  parsePoolText,
  rankEntries,
  markResult,
  markProbe,
  freshLedger,
  summarize,
  stateLabel,
  resolvePool,
} = poolMod

await ok('一行一个，http / socks5 / 四段 / #rotating 都能认', () => {
  const parsed = parsePoolText(
    [
      'http://u:p@1.1.1.1:8000',
      'socks5://2.2.2.2:1080',
      '3.3.3.3:9000:user:pass',
      'http://gate.proxy.cn:15818 #rotating',
      '# 这是注释',
      '',
    ].join('\n'),
  )
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.entries.length, 4)
  assert.equal(parsed.entries[0].protocol, 'http')
  assert.equal(parsed.entries[0].masked, 'http://u:***@1.1.1.1:8000')
  assert.equal(parsed.entries[1].protocol, 'socks5')
  assert.equal(parsed.entries[2].host, '3.3.3.3')
  assert.equal(parsed.entries[2].auth, true)
  assert.equal(parsed.entries[3].mode, 'rotating')
  assert.match(parsed.entries[3].spec, /#rotating$/)
})

await ok('坏行只记账不抛错；同一出口写两遍只留一个', () => {
  const parsed = parsePoolText('http://1.1.1.1:8000\nftp://nope\nhttp://1.1.1.1:8000\n')
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.errors.length, 1)
  assert.equal(parsed.errors[0].line, 2)
  assert.match(parsed.errors[0].message, /协议/)
})

await ok('排序：有额度的在前（多的优先）→ 未探测 → 冷却 → 已用完', () => {
  const entries = resolvePool('http://1.1.1.1:1\nhttp://2.2.2.2:1\nhttp://3.3.3.3:1\nhttp://4.4.4.4:1')
  const byHost = (host) => entries.find((entry) => entry.host === host)
  const ledger = freshLedger()
  markProbe(ledger, byHost('1.1.1.1'), { credits: 2 })
  markProbe(ledger, byHost('2.2.2.2'), { credits: 7 })
  markProbe(ledger, byHost('4.4.4.4'), { credits: 0 })
  markResult(ledger, byHost('3.3.3.3'), { ok: false, code: 'network', message: 'ECONNREFUSED' })
  const ranked = rankEntries(entries, ledger)
  assert.deepEqual(
    ranked.map((row) => row.entry.host),
    ['2.2.2.2', '1.1.1.1', '3.3.3.3', '4.4.4.4'],
  )
  assert.deepEqual(
    ranked.map((row) => row.state),
    ['ready', 'ready', 'cooling', 'empty'],
  )
  assert.equal(stateLabel(ranked[0].state), '可用')
})

await ok('静态出口限流即记账为「用完」；动态出口限流不算用完', () => {
  const entries = resolvePool('http://1.1.1.1:1\nsocks5://2.2.2.2:1 #rotating')
  const ledger = freshLedger()
  markResult(ledger, entries[0], { ok: false, code: 'limit', credits: 0, bonus: 'used' })
  markResult(ledger, entries[1], { ok: false, code: 'limit', credits: 0, bonus: 'used' })
  const ranked = rankEntries(entries, ledger)
  assert.equal(ranked.find((row) => row.entry.id === entries[0].id).state, 'empty')
  assert.equal(ranked.find((row) => row.entry.id === entries[1].id).state, 'rotating')
  // 动态代理永远排在最前面：它的"用完"只是这一发撞上了用尽的出口
  assert.equal(ranked[0].entry.id, entries[1].id)
})

await ok('账本跨天作废（站点 UTC 零点重置，插件跟着重置）', () => {
  const entries = resolvePool('http://1.1.1.1:1')
  const ledger = freshLedger()
  markProbe(ledger, entries[0], { credits: 0 })
  assert.equal(summarize(entries, ledger).totalCredits, 0)
  const stale = freshLedger({ ...ledger, day: '2020-01-01' })
  assert.deepEqual(stale.entries, {})
  assert.equal(summarize(entries, stale).fresh, 1)
})

await ok('汇总：总数 / 合计剩余 / 各状态计数', () => {
  const entries = resolvePool('http://1.1.1.1:1\nhttp://2.2.2.2:1\nhttp://3.3.3.3:1')
  const ledger = freshLedger()
  markProbe(ledger, entries[0], { credits: 4 })
  markProbe(ledger, entries[1], { credits: 0 })
  const summary = summarize(entries, ledger)
  assert.equal(summary.count, 3)
  assert.equal(summary.totalCredits, 4)
  assert.equal(summary.known, 2)
  assert.equal(summary.ready, 1)
  assert.equal(summary.empty, 1)
  assert.equal(summary.fresh, 1)
})

console.log('\n[6] 轮换：哪一发算成功、什么时候换出口')
const { chatWithRotation } = await import(pathToFileURL(path.join(ROOT, 'lib/rotate.js')).href)

const rotateConfig = { ...DEFAULT_CONFIG }
const rotatePayload = { model: 'grok-4-20', role: '', messages: [{ role: 'user', content: 'hi' }] }
const exitA = { id: 'a', label: 'a:1', proxy: { protocol: 'http', host: '1.1.1.1', port: 1 }, mode: 'sticky' }
const exitB = { id: 'b', label: 'b:1', proxy: { protocol: 'http', host: '2.2.2.2', port: 1 }, mode: 'sticky' }

function sseResponse(lines) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: Readable.from(lines.map((line) => Buffer.from(`${line}\n\n`, 'utf8'))),
    text: async () => '',
  }
}
function okResponse() {
  return sseResponse([
    'data: {"credits":8,"bonus":"locked"}',
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    'data: [DONE]',
  ])
}
function errorResponse(status, code, message) {
  const payload = JSON.stringify({ error: { code, message: message || code } })
  return { ok: false, status, headers: { get: () => 'application/json' }, text: async () => payload }
}
function limitResponse() {
  return errorResponse(429, 'limit', 'Daily allowance used')
}

/** 按 route.id 决定这一发返回什么；respond(n) 的 n 是第几次打这个出口。 */
function scriptedFetch(script) {
  const log = []
  const factory = (route) => async (url) => {
    log.push(route.id)
    const respond = script[route.id]
    if (!respond) throw new Error(`脚本里没准备出口 ${route.id}`)
    return respond(log.filter((id) => id === route.id).length)
  }
  return { factory, log }
}

await ok('第一个出口限流 → 自动换第二个 → 成功，switches=1', async () => {
  const { factory, log } = scriptedFetch({ a: () => limitResponse(), b: () => okResponse() })
  const result = await chatWithRotation(rotateConfig, rotatePayload, {}, {
    routes: [exitA, exitB],
    makeFetch: factory,
    maxAttempts: 4,
    rerollSticky: 0,
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, '好')
  assert.equal(result.route.id, 'b')
  assert.equal(result.switches, 1)
  assert.deepEqual(log, ['a', 'b'])
})

await ok('全都不行 → exhausted，返回最后一次失败（不是超时/空结果）', async () => {
  const { factory, log } = scriptedFetch({ a: () => limitResponse(), b: () => limitResponse() })
  const result = await chatWithRotation(rotateConfig, rotatePayload, {}, {
    routes: [exitA, exitB],
    makeFetch: factory,
    maxAttempts: 4,
    rerollSticky: 0,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'limit')
  assert.equal(result.exhausted, true)
  assert.equal(result.switches, 1)
  assert.deepEqual(log, ['a', 'b'])
})

await ok('已经开始吐字就不换出口（否则会拼出两段半截回答）', async () => {
  const { factory, log } = scriptedFetch({
    a: () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"半"}}]}',
        'data: {"error":{"code":"limit","message":"boom"}}',
      ]),
    b: () => okResponse(),
  })
  const result = await chatWithRotation(rotateConfig, rotatePayload, {}, {
    routes: [exitA, exitB],
    makeFetch: factory,
    maxAttempts: 4,
    rerollSticky: 0,
  })
  assert.equal(result.ok, false)
  assert.equal(result.partial, true)
  assert.equal(result.text, '半')
  assert.deepEqual(log, ['a'])
})

await ok('model_locked 这种"换 IP 也没用"的错不换出口（不白烧额度）', async () => {
  const { factory, log } = scriptedFetch({
    a: () => errorResponse(403, 'model_locked', 'locked'),
    b: () => okResponse(),
  })
  const result = await chatWithRotation(rotateConfig, rotatePayload, {}, {
    routes: [exitA, exitB],
    makeFetch: factory,
    maxAttempts: 4,
    rerollSticky: 0,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'model_locked')
  assert.deepEqual(log, ['a'])
})

await ok('动态代理限流后对同一个地址重打一次（重开连接就是新出口）', async () => {
  const rotating = { ...exitB, id: 'g', label: 'gate:1', mode: 'rotating' }
  const { factory, log } = scriptedFetch({
    g: (n) => (n === 1 ? limitResponse() : okResponse()),
  })
  const result = await chatWithRotation(rotateConfig, rotatePayload, {}, {
    routes: [rotating],
    makeFetch: factory,
    maxAttempts: 4,
    rerollRotating: 1,
  })
  assert.equal(result.ok, true)
  assert.equal(result.route.id, 'g')
  assert.equal(result.attempts, 2)
  assert.deepEqual(log, ['g', 'g'])
})

await ok('预算上限生效：maxAttempts=2 时不会把 5 个出口全打一遍', async () => {
  const routes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    id,
    label: `${id}:1`,
    proxy: { protocol: 'http', host: '9.9.9.9', port: 1 },
    mode: 'sticky',
  }))
  const script = {}
  for (const route of routes) script[route.id] = () => limitResponse()
  const { factory, log } = scriptedFetch(script)
  const result = await chatWithRotation(rotateConfig, rotatePayload, {}, {
    routes,
    makeFetch: factory,
    maxAttempts: 2,
    rerollSticky: 0,
  })
  assert.equal(result.exhausted, true)
  assert.equal(log.length, 2)
})

console.log('\n[7] 传输层：真的穿过代理')
const { makeFetcher, parseProxy, maskProxy, probeExitIp, withSession, hasSessionToken } = await import(
  pathToFileURL(path.join(ROOT, 'lib/proxy-agent.js')).href
)
const CERT = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/localhost-cert.pem'))
const KEY = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/localhost-key.pem'))

const tlsTarget = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
  if (String(req.url).startsWith('/sse')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"n":1}\n\n')
    setTimeout(() => {
      res.write('data: {"n":2}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    }, 30)
    return
  }
  if (String(req.url).startsWith('/ip')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ip: '203.0.113.7' }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ path: req.url, ua: req.headers['user-agent'] }))
})
await new Promise((resolve) => tlsTarget.listen(0, '127.0.0.1', resolve))
const TLS_PORT = tlsTarget.address().port

let connects = 0
const connectProxy = http.createServer((req, res) => {
  res.writeHead(405)
  res.end()
})
connectProxy.on('connect', (req, clientSocket, head) => {
  connects += 1
  const want = `Basic ${Buffer.from('bob:secret').toString('base64')}`
  if (req.headers['proxy-authorization'] !== want) {
    clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    return
  }
  const [host, port] = String(req.url).split(':')
  const upstream = net.connect(Number(port), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstream.destroy())
})
await new Promise((resolve) => connectProxy.listen(0, '127.0.0.1', resolve))
const CONNECT_PORT = connectProxy.address().port

const socksProxy = net.createServer((socket) => {
  socket.once('data', (greeting) => {
    if (greeting[0] !== 0x05) return socket.destroy()
    socket.write(Buffer.from([0x05, 0x00]))
    socket.once('data', (request) => {
      const atyp = request[3]
      let host
      let offset
      if (atyp === 0x03) {
        const len = request[4]
        host = request.subarray(5, 5 + len).toString()
        offset = 5 + len
      } else {
        host = Array.from(request.subarray(4, 8)).join('.')
        offset = 8
      }
      const port = request.readUInt16BE(offset)
      const upstream = net.connect(port, host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', () => socket.destroy())
    })
  })
})
await new Promise((resolve) => socksProxy.listen(0, '127.0.0.1', resolve))
const SOCKS_PORT = socksProxy.address().port

/** 接受任何账号的 CONNECT 代理：只负责把「这一发用的用户名」记下来。 */
const seenUsers = []
const recordingProxy = http.createServer((req, res) => {
  res.writeHead(405)
  res.end()
})
recordingProxy.on('connect', (req, clientSocket, head) => {
  const header = String(req.headers['proxy-authorization'] || '')
  const decoded = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString() : ''
  seenUsers.push(decoded.split(':')[0] || '')
  const [host, port] = String(req.url).split(':')
  const upstream = net.connect(Number(port), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstream.destroy())
})
await new Promise((resolve) => recordingProxy.listen(0, '127.0.0.1', resolve))
const REC_PORT = recordingProxy.address().port

const tlsOptions = { ca: CERT, connectTimeout: 5000 }

await ok('CONNECT 隧道 + Basic 认证 + TLS：能拿到上游正文', async () => {
  const proxy = parseProxy(`http://bob:secret@127.0.0.1:${CONNECT_PORT}`)
  assert.equal(maskProxy(proxy).includes('secret'), false, '密码不该出现在展示串里')
  const response = await makeFetcher(proxy, tlsOptions)(`https://localhost:${TLS_PORT}/hello?x=1`, { method: 'GET' })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.path, '/hello?x=1')
})

await ok('认证不对时给的是"代理要认证"而不是裸 407', async () => {
  const proxy = parseProxy(`http://bob:wrong@127.0.0.1:${CONNECT_PORT}`)
  await assert.rejects(
    () => makeFetcher(proxy, tlsOptions)(`https://localhost:${TLS_PORT}/hello`),
    /认证/,
  )
})

await ok('SOCKS5 也能穿（域名交给代理解析）', async () => {
  const proxy = parseProxy(`socks5://127.0.0.1:${SOCKS_PORT}`)
  const response = await makeFetcher(proxy, tlsOptions)(`https://localhost:${TLS_PORT}/socks`, { method: 'GET' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).path, '/socks')
})

await ok('流式响应能一块块读出来（SSE 全靠这条）', async () => {
  const proxy = parseProxy(`http://bob:secret@127.0.0.1:${CONNECT_PORT}`)
  const response = await makeFetcher(proxy, tlsOptions)(`https://localhost:${TLS_PORT}/sse`, { method: 'GET' })
  let text = ''
  for await (const chunk of response.body) text += chunk.toString()
  assert.match(text, /data: \[DONE\]/)
  assert.match(text, /"n":1/)
})

await ok('账号里带 {session}：每发请求都是新会话名（住宅代理换 IP 就靠这个）', async () => {
  seenUsers.length = 0
  const spec = `http://acct-lite-country_SG-r_10m-s_{session}:pw@127.0.0.1:${REC_PORT}`
  const proxy = parseProxy(spec)
  assert.equal(proxy.template, true, '要能认出这是个模板')
  const fetcher = makeFetcher(proxy, tlsOptions)
  await fetcher(`https://localhost:${TLS_PORT}/a`)
  await fetcher(`https://localhost:${TLS_PORT}/b`)
  assert.equal(seenUsers.length, 2)
  for (const user of seenUsers) assert.match(user, /^acct-lite-country_SG-r_10m-s_[a-z0-9]{10}$/)
  assert.notEqual(seenUsers[0], seenUsers[1], '两发请求用了同一个会话 —— 那就等于没换 IP')
})

await ok('没有占位符的账号不会被改动（静态代理的密码里有花括号也安全）', async () => {
  seenUsers.length = 0
  const proxy = parseProxy(`http://bob:sec{ret}@127.0.0.1:${REC_PORT}`)
  assert.equal(proxy.template, false)
  await makeFetcher(proxy, tlsOptions)(`https://localhost:${TLS_PORT}/c`)
  assert.equal(seenUsers[0], 'bob')
})

await ok('{s} / {sid} 也是占位符，且能指定会话名（测试与排障用）', async () => {
  const fixed = withSession(parseProxy('http://a-country_SG-s_{s}:p@1.2.3.4:1'), 'zzz9')
  assert.equal(fixed.auth.user, 'a-country_SG-s_zzz9')
  assert.equal(withSession(parseProxy('http://a-s_{sid}:p@1.2.3.4:1')).auth.user.startsWith('a-s_'), true)
  assert.equal(hasSessionToken('a-s_{session}'), true)
  assert.equal(hasSessionToken('a-s_abc'), false)
  // 密码里也能写（有些代理商把参数放密码）
  assert.equal(withSession(parseProxy('http://u:p-s_{session}@1.2.3.4:1'), 'kk').auth.pass, 'p-s_kk')
})

await ok('带 {session} 的行自动按动态代理处理（不用再写 #rotating）', async () => {
  const poolMod = await import(pathToFileURL(path.join(ROOT, 'lib/pool.js')).href)
  const parsed = poolMod.parsePoolText(
    'http://acct-lite-country_SG-r_10m-s_{session}:pw@gate.nstproxy.io:24125\nhttp://1.2.3.4:8000',
  )
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.entries[0].mode, 'rotating')
  assert.equal(parsed.entries[0].template, true)
  assert.equal(parsed.entries[1].mode, 'sticky')
  assert.equal(parsed.entries[1].template, false)
})

await ok('出口 IP 探测：通的时候给 IP，不通时不抛异常', async () => {
  const proxy = parseProxy(`http://bob:secret@127.0.0.1:${CONNECT_PORT}`)
  const alive = await probeExitIp(proxy, `https://localhost:${TLS_PORT}/ip`, { ...tlsOptions, connectTimeout: 3000 })
  assert.equal(alive.ok, true)
  assert.equal(alive.ip, '203.0.113.7')
  const noIp = await probeExitIp(proxy, `https://localhost:${TLS_PORT}/hello`, { ...tlsOptions, connectTimeout: 3000 })
  assert.equal(noIp.ok, false, '回的不是 IP 就该说查不到，而不是拿一段正文当 IP')
  const broken = await probeExitIp(parseProxy('http://127.0.0.1:1'), `https://localhost:${TLS_PORT}/hello`, {
    ...tlsOptions,
    connectTimeout: 2000,
  })
  assert.equal(broken.ok, false)
  assert.ok(broken.error)
})

await ok('不支持的协议和连不上的代理都有人话', async () => {
  assert.throws(() => parseProxy('ftp://1.2.3.4:21'), /协议/)
  await assert.rejects(() => makeFetcher(parseProxy('http://127.0.0.1:1'), tlsOptions)('https://localhost:443/x'), /./)
})

tlsTarget.close()
connectProxy.close()
recordingProxy.close()
socksProxy.close()

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

await ok('client factory 能求值，apply 注册 dock 与插件页插槽', async () => {
  const clientPath = pathToFileURL(path.join(ROOT, 'lib/client.js')).href
  await import(`${clientPath}?v=${Date.now()}`)
  assert.equal(typeof factory, 'function', 'factory 没被注册到模块加载器')
  const registrations = []
  const mod = factory((id) => {
    if (id === 'react') {
      return {
        createElement: (...args) => ({ args }),
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
        useRef: (v) => ({ current: v }),
        useMemo: (fn) => fn(),
      }
    }
    throw new Error(`没准备这个模块：${id}`)
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

await ok('插件页卡片能在首帧渲染（status 还是 null 时不能崩）', async () => {
  let captured = null
  const components = []
  const clientPath = pathToFileURL(path.join(ROOT, 'lib/client.js')).href
  await import(`${clientPath}?v=render-${Date.now()}`)
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
      inject(slotName, fn) {
        fn()
      },
      register(meta, component) {
        components.push({ name: meta.name, component })
        return meta
      },
    },
  })
  captured = components.find((item) => item.name === 'plugins.bundle.config')
  assert.ok(captured && typeof captured.component === 'function', '没拿到插件页卡片组件')

  const render = (node) => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (Array.isArray(node)) return node.map((child) => render(child)).join('')
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!node || typeof node !== 'object') return ''
    const { type, props } = node
    if (typeof type === 'function') return render(type(props || {}))
    const children = props && props.children
    const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
    return list.map((child) => render(child)).join('')
  }
  const html = render(captured.component())
  assert.ok(html.includes('Grok'), '卡片渲染出来是空的')
  assert.ok(html.includes('额度'), '首帧应该已经能显示额度区块')
})

await ok('有出口池数据时也能渲染（每个出口一行，密码打码）', async () => {
  const snapshot = {
    ok: true,
    credits: 3,
    bonus: 'locked',
    quota: { free: 4, bonus: 5, reset: 'UTC 零点重置', by: '按出口 IP 记' },
    relay: { baseURL: 'http://127.0.0.1:43690/v1' },
    provider: { registered: true, count: 2, baseURL: 'http://127.0.0.1:43690/v1', providerName: 'Grok.online' },
    models: [{ id: 'grok-4-20', name: 'Grok 4.20', mono: 'x-ai/grok-4.20', note: '快' }],
    locked: [{ id: 'grok-4-7', name: 'Grok 4.7', reason: '接口不开' }],
    proxy: { mode: 'auto', count: 2, ready: 1, fresh: 1, empty: 0, cooling: 0, rotating: 1, totalCredits: 5, maxAttempts: 10 },
    proxies: [
      {
        id: 'a',
        masked: 'http://u:***@1.1.1.1:8000',
        modeText: '静态',
        state: 'ready',
        stateText: '可用',
        credits: 5,
        ip: '1.1.1.1',
        ms: 120,
        used: 2,
        lastError: '',
      },
      {
        id: 'b',
        masked: 'socks5://2.2.2.2:1080',
        modeText: '动态',
        state: 'rotating',
        stateText: '动态',
        credits: 0,
        ip: '',
        ms: 0,
        used: 0,
        lastError: '',
      },
    ],
  }
  const components = []
  const clientPath = pathToFileURL(path.join(ROOT, 'lib/client.js')).href
  await import(`${clientPath}?v=render2-${Date.now()}`)
  const mod = factory((id) => {
    if (id !== 'react') throw new Error(`没准备这个模块：${id}`)
    let seen = 0
    return {
      createElement: (type, props, ...children) => ({
        type,
        props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
      }),
      // 第 1 个 useState 是 useTheme 的 dark，第 2 个才是 status
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
  const render = (node) => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (Array.isArray(node)) return node.map((child) => render(child)).join('')
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!node || typeof node !== 'object') return ''
    if (typeof node.type === 'function') return render(node.type(node.props || {}))
    const children = node.props && node.props.children
    const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
    return list.map((child) => render(child)).join('')
  }
  const html = render(card.component())
  assert.ok(html.includes('出口池'), '没渲染出出口池区块')
  assert.ok(html.includes('http://u:***@1.1.1.1:8000'), '出口行没出来')
  assert.ok(html.includes('自动换：开'), '开关状态没同步')
  assert.equal(html.includes('secret'), false)
})

/** 绕过被替换的 globalThis.fetch，真的发 HTTP 到本机反代。 */
function fetchReal(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode,
            headers: { get: (name) => res.headers[String(name).toLowerCase()] },
            text: async () => body,
            json: async () => JSON.parse(body),
          })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

console.log(`\n全部通过：${passed} 项\n`)
// 反代是真起的 http server，会一直挂着事件循环 —— 测完主动退出。
process.exit(0)
