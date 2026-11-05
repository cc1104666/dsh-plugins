import { createStore } from '../lib/store.js'
import { imaHeaders, initSession, delSession } from '../lib/ima.js'
import fs from 'node:fs'
const store = createStore({ dataDir: '' })
const config = store.config()
const auth = store.auth()
const device = JSON.parse(fs.readFileSync(`${store.dir}/device.json`, 'utf8'))

for (const m of [
  { model_id: 'official_3', model_type: 3, enable_enhancement: false },
  { model_id: 'official_1', model_type: 1, enable_enhancement: false },
]) {
  const sessionId = await initSession(config, auth, device)
  const body = {
    session_id: sessionId, robot_type: 10000,
    question: '7-2=?', question_type: 2,
    client_id: 'dsh-probe-' + Date.now(),
    model_info: { ...m, robot_type: 10000 },
  }
  const resp = await fetch(`${config.siteBase}/cgi-bin/assistant/qa`, {
    method: 'POST',
    headers: { ...imaHeaders(auth, device, config), accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  console.log(`\n== ${m.model_id} status ${resp.status}`)
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buf = ''
  let done = false
  while (!done && events.length < 80) {
    const r = await reader.read()
    if (r.done) break
    buf += decoder.decode(r.value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const ev = /event:\s*(\S+)/.exec(block)
      const data = /data:\s*(.*)/.exec(block)
      events.push([ev && ev[1], data && data[1].slice(0, 140)])
      if (ev && ev[1] === 'COMPLETED') done = true
    }
  }
  for (const [e, d] of events) console.log(e, '|', d)
  await delSession(config, auth, device, sessionId)
}
