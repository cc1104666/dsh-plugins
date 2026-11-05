/** 真机验证 chatOnce 全链路（用 auth.json 里已保存的登录态，不需要扫码）。 */
import fs from 'node:fs'
import { createStore } from '../lib/store.js'
import { normalizeModels } from '../lib/models.js'
import { fetchModels } from '../lib/ima.js'
import { chatOnce } from '../lib/upstream.js'

const store = createStore({ dataDir: '' })
const config = store.config()
const auth = store.auth()
const device = JSON.parse(fs.readFileSync(`${store.dir}/device.json`, 'utf8'))
console.log('登录态：', auth.userId, 'token len', auth.token.length)

const rows = await fetchModels(config)
const models = normalizeModels(rows)
console.log('模型：', models.map((m) => `${m.id}(${m.name})`).join(' | '))

for (const m of models) {
  const deltas = []
  const reasoning = []
  const result = await chatOnce(
    {
      getConfig: () => config,
      getAuth: () => auth,
      getDevice: () => device,
      onDelta: (d) => deltas.push(d),
      onReasoning: (d) => reasoning.push(d),
    },
    { messages: [{ role: 'user', content: '7-2=?' }], model: m },
  )
  console.log(`\n== ${m.id} ${m.name}`)
  console.log(`   ok=${result.ok} elapsed=${result.elapsed}ms`)
  console.log(`   text=${JSON.stringify(result.text)}`)
  if (result.reasoning) console.log(`   reasoning(${reasoning.length} 块)=${JSON.stringify(result.reasoning.slice(0, 120))}`)
  if (!result.ok) console.log(`   error=${result.error}`)
}
