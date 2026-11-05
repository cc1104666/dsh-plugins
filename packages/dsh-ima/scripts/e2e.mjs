/**
 * dsh-ima 真机 e2e（要联网 + 要用户扫一次码）。
 *
 *   node scripts/e2e.mjs
 *
 * 流程：
 *   1. 申请微信二维码 → 存成 qr.png（用户扫它）
 *   2. 轮询等确认（最长 5 分钟）
 *   3. wx_code → POST /cgi-bin/login → 存 auth.json
 *   4. 免登录读模型清单
 *   5. 打一个真实问答（「回复两个字：可用」），把 SSE 原文 + 汇总打出来
 *
 * 数据落在 ~/.dsh/plugin-data/dsh-ima/（和插件同目录），跑完这次
 * 插件启动时就能直接复用登录态。
 */
import fs from 'node:fs'
import { createStore } from '../lib/store.js'
import {
  startWechatScan,
  pollWechatScan,
  loginWithWxCode,
  fetchQrImage,
  fetchModels,
  randomGuid,
  SCAN_STATE,
} from '../lib/ima.js'
import { normalizeModels, findModel } from '../lib/models.js'
import { chatOnce } from '../lib/upstream.js'

const store = createStore({ dataDir: '' })
const config = store.config()
const devicePath = `${store.dir}/device.json`
let device = null
try {
  device = JSON.parse(fs.readFileSync(devicePath, 'utf8'))
} catch {
  device = { guid: randomGuid(), q36: '', createdAt: new Date().toISOString() }
  fs.mkdirSync(store.dir, { recursive: true })
  fs.writeFileSync(devicePath, JSON.stringify(device, null, 2), 'utf8')
}

console.log('== 1. 申请微信二维码')
const scan = await startWechatScan(config)
console.log(`   uuid=${scan.uuid}  有效期 300s`)
console.log(`   二维码页面：${scan.qrUrl}`)

const dataUrl = await fetchQrImage(config, scan.qrUrl)
const b64 = dataUrl.split(',')[1]
fs.writeFileSync(`${store.dir}/qr.png`, Buffer.from(b64, 'base64'))
console.log(`   已存 ${store.dir}/qr.png —— 请用微信扫这张\n`)

console.log('== 2. 等待扫码确认（最长 300s）')
const deadline = Date.now() + 300 * 1000
let wxCode = ''
while (Date.now() < deadline && !wxCode) {
  const result = await pollWechatScan(config, scan.uuid)
  if (result.status === SCAN_STATE.CONFIRMED && result.code) {
    wxCode = result.code
  } else if (result.status === SCAN_STATE.CANCELLED) {
    console.error('   已取消')
    process.exit(1)
  } else if (result.status === SCAN_STATE.SCANNED) {
    console.log('   已扫码，等手机确认…')
  } else {
    process.stdout.write('.')
  }
}
if (!wxCode) {
  console.error('\n   超时，没扫')
  process.exit(1)
}
console.log(`\n   拿到 wx_code（${wxCode.slice(0, 6)}…）`)

console.log('== 3. wx_code → ima 登录态')
const account = await loginWithWxCode(config, wxCode, device)
const saved = store.patchAuth({ ...account, source: 'wechat-qr' })
console.log(`   登录成功：${saved.nickName || saved.userId}（uid=${saved.userId}）`)

console.log('== 4. 免登录读模型清单')
const rows = await fetchModels(config)
const models = normalizeModels(rows)
store.saveModels({ models })
for (const item of models) {
  console.log(`   ${item.id}  ${item.name}  (type=${item.modelType}${item.isDefault ? ', 默认' : ''})`)
}

console.log('== 5. 真实问答（默认模型）')
const model = findModel(models, '')
let streamed = ''
const result = await chatOnce(
  {
    getConfig: () => config,
    getAuth: () => saved,
    getDevice: () => device,
    onDelta: (d) => {
      streamed += d
    },
  },
  { messages: [{ role: 'user', content: '回复两个字：可用' }], model },
)
console.log(`   ok=${result.ok}  elapsed=${result.elapsed}ms`)
console.log(`   text=${JSON.stringify(result.text)}`)
if (result.reasoning) console.log(`   reasoning=${JSON.stringify(result.reasoning.slice(0, 200))}`)
if (!result.ok) console.log(`   error=${result.error}`)
process.exit(result.ok ? 0 : 2)
