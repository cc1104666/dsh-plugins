/**
 * dsh-grok3ai —— 浏览器半区。
 *
 * 形态：输入框下方 dock 里一个「Grok3AI」胶囊 + 插件页里的一张卡片（同一份面板）。
 *
 * 面板只讲四件事：
 *   ① 这个站到底是谁（它没有模型，只有 iframe）—— 不写清楚就是骗人
 *   ② 两个能用的 Space：探活、延迟、供应商
 *   ③ 一键注册进 DSH 模型选择器
 *   ④ 出口池（可选）：HF 按 IP 限流时换个出口
 *
 * 注意：整个文件包在 IIFE 里。DSH 把每个插件的 client.js 当经典脚本塞进同一个
 * 全局作用域，顶层写 const 会跟别的插件撞名（踩过：MODULE_LOADER 重复声明，
 * 直接把 DSH 打进恢复模式）。
 */
;(function () {
  const MODULE_LOADER = window.__ModuleLoader__ || window.ModuleLoader
  if (!MODULE_LOADER || typeof MODULE_LOADER.load !== 'function') {
    console.error('[dsh-grok3ai] 找不到模块加载器，浏览器半区未加载')
  } else
    MODULE_LOADER.load({
      id: 'dsh-grok3ai',
      factory: (require) => {
        const module = { exports: {} }
        const exports = module.exports

        const React = require('react')
        const h = React.createElement

        const BASE = '/plugins/dsh-grok3ai'
        const name = 'dsh-grok3ai-client'
        const inject = ['slots']

        async function api(path, body) {
          try {
            const options =
              body === undefined
                ? { method: 'GET' }
                : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            const response = await fetch(BASE + path, options)
            const parsed = await response.json().catch(() => null)
            if (parsed === null) {
              if (response.status === 404 || response.status === 405) {
                return { ok: false, stale: true, error: `宿主端没有这条接口（${path} → HTTP ${response.status}）——重启 DSH 后生效` }
              }
              return { ok: false, error: `响应不是 JSON（HTTP ${response.status}）` }
            }
            if (!parsed.ok && parsed.error === undefined) parsed.error = `HTTP ${response.status}`
            return parsed
          } catch (error) {
            return { ok: false, error: `请求失败：${String((error && error.message) || error)}` }
          }
        }

        function detectDark() {
          const root = document.documentElement
          const attr = `${root.dataset ? root.dataset.theme || '' : ''} ${root.className || ''}`
          if (/light/i.test(attr)) return false
          if (/dark/i.test(attr)) return true
          if (root.style && root.style.colorScheme) return root.style.colorScheme !== 'light'
          try {
            return window.matchMedia('(prefers-color-scheme: dark)').matches
          } catch {
            return false
          }
        }

        function useTheme() {
          const [dark, setDark] = React.useState(detectDark)
          React.useEffect(() => {
            let media
            try {
              media = window.matchMedia('(prefers-color-scheme: dark)')
            } catch {
              media = null
            }
            const sync = () => setDark(detectDark())
            const observer = new MutationObserver(sync)
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
            if (media && media.addEventListener) media.addEventListener('change', sync)
            return () => {
              observer.disconnect()
              if (media && media.removeEventListener) media.removeEventListener('change', sync)
            }
          }, [])
          return dark
        }

        function palette(dark) {
          return dark
            ? {
                dark,
                panel: '#1e2129',
                soft: '#232732',
                border: '#2e333f',
                text: '#e6e8ec',
                muted: '#98a1b0',
                accent: '#4c8dff',
                accentText: '#ffffff',
                ok: '#3ddc84',
                warn: '#ffb020',
                danger: '#ff6b6b',
                input: '#12141a',
              }
            : {
                dark,
                panel: '#f6f8fa',
                soft: '#eef1f5',
                border: '#dde2e9',
                text: '#1b1f24',
                muted: '#657083',
                accent: '#2f6fed',
                accentText: '#ffffff',
                ok: '#12a150',
                warn: '#b86e00',
                danger: '#d64545',
                input: '#ffffff',
              }
        }

        // ---------------------------------------------------------------- 小组件

        function Button(props) {
          const { p, children, onClick, disabled, tone, style } = props
          const background = tone === 'primary' ? p.accent : tone === 'ghost' ? 'transparent' : p.soft
          const color = tone === 'primary' ? p.accentText : p.text
          return h(
            'button',
            {
              type: 'button',
              onClick,
              disabled,
              style: {
                appearance: 'none',
                border: `1px solid ${tone === 'primary' ? p.accent : p.border}`,
                background,
                color: disabled ? p.muted : color,
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 500,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.6 : 1,
                lineHeight: 1.4,
                whiteSpace: 'nowrap',
                ...style,
              },
            },
            children,
          )
        }

        function TextInput(props) {
          const { p, value, onChange, placeholder, mono } = props
          return h('input', {
            type: 'text',
            value: value === undefined || value === null ? '' : value,
            placeholder,
            onChange: (event) => onChange(event.target.value),
            style: {
              width: '100%',
              boxSizing: 'border-box',
              background: p.input,
              color: p.text,
              border: `1px solid ${p.border}`,
              borderRadius: 8,
              padding: '7px 10px',
              fontSize: 12,
              fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
              outline: 'none',
            },
          })
        }

        function TextArea(props) {
          const { p, value, onChange, placeholder, rows } = props
          return h('textarea', {
            value: value === undefined || value === null ? '' : value,
            placeholder,
            rows: rows || 4,
            onChange: (event) => onChange(event.target.value),
            style: {
              width: '100%',
              boxSizing: 'border-box',
              background: p.input,
              color: p.text,
              border: `1px solid ${p.border}`,
              borderRadius: 8,
              padding: '7px 10px',
              fontSize: 11,
              lineHeight: 1.6,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              outline: 'none',
              resize: 'vertical',
            },
          })
        }

        function Notice(props) {
          const { p, tone, children } = props
          const color = tone === 'error' ? p.danger : tone === 'ok' ? p.ok : tone === 'warn' ? p.warn : p.muted
          return h(
            'div',
            {
              style: {
                border: `1px solid ${color}`,
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 11.5,
                lineHeight: 1.6,
                color: p.text,
                background: p.soft,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                marginBottom: 10,
              },
            },
            children,
          )
        }

        function Section(props) {
          const { p, title, hint, children, right } = props
          return h(
            'div',
            { style: { marginBottom: 18 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 } },
              h('div', { style: { fontSize: 12.5, fontWeight: 700, color: p.text } }, title),
              right || null,
            ),
            hint ? h('div', { style: { fontSize: 11, color: p.muted, lineHeight: 1.6, marginBottom: 8 } }, hint) : null,
            children,
          )
        }

        function Badge(props) {
          const { p, tone, children } = props
          const color = tone === 'ok' ? p.ok : tone === 'warn' ? p.warn : tone === 'error' ? p.danger : p.muted
          return h(
            'span',
            {
              style: {
                display: 'inline-block',
                padding: '1px 6px',
                borderRadius: 999,
                border: `1px solid ${color}`,
                color,
                fontSize: 10.5,
                lineHeight: 1.5,
                marginLeft: 6,
                verticalAlign: 'middle',
              },
            },
            children,
          )
        }

        // ---------------------------------------------------------------- 主面板

        function Grok3Panel(props) {
          const embedded = Boolean(props && props.embedded)
          const p = palette(useTheme())

          const [status, setStatus] = React.useState(null)
          const [open, setOpen] = React.useState(embedded)
          const [busy, setBusy] = React.useState('')
          const [error, setError] = React.useState('')
          const [notice, setNotice] = React.useState('')
          const [testModel, setTestModel] = React.useState('minimax-vl-01')
          const [testText, setTestText] = React.useState('用一句话说明你是谁')
          const [testResult, setTestResult] = React.useState(null)
          const [proxyText, setProxyText] = React.useState('')

          // 首帧 status 还是 null：所有字段都从 view 取，避免 null.xxx 把整块卡片打崩
          const view = status || {}
          const models = Array.isArray(view.models) ? view.models : []
          const dead = Array.isArray(view.dead) ? view.dead : []
          const proxy = view.proxy || {}
          const proxies = Array.isArray(view.proxies) ? view.proxies : []
          const provider = view.provider || {}
          const relay = view.relay || {}
          const cfg = view.config || {}
          const autoExit = proxy.mode === 'auto'

          const refresh = React.useCallback(async () => {
            const result = await api('/status')
            if (result && !result.stale && result.error && !result.models) {
              setError(result.error)
              return
            }
            setStatus(result)
            if (result.error) setError(result.error)
          }, [])

          React.useEffect(() => {
            refresh()
          }, [refresh])

          const run = async (key, path, body, okText) => {
            setBusy(key)
            setError('')
            setNotice('')
            const result = await api(path, body)
            setBusy('')
            if (result.models) setStatus(result)
            if (!result.ok) setError(result.error || '出错了')
            else setNotice(result.message || okText || '好了')
            return result
          }

          const probeAll = () => run('probe', '/probe', { force: true }, '探完了')
          const probeOne = (id) => run(`probe:${id}`, '/probe', { id, force: true }, '探完了')
          const register = () => run('register', '/models/register', {}, '已注册')
          const restartRelay = () => run('restart', '/relay/restart', {}, '反代已重启')
          const toggleExit = () => run('exit-mode', '/proxy/mode', { mode: autoExit ? 'off' : 'auto' }, '')
          const testProxy = (id) => run(id ? `p:${id}` : 'p:all', '/proxy/test', id ? { id } : {}, '测完了')
          const removeProxy = (id) => run(`rm:${id}`, '/proxy/remove', { id }, '已删掉')
          const saveProxy = () => run('exit-save', '/proxy/save', { text: proxyText }, '已保存')
          const clearProxy = () => run('exit-clear', '/proxy/save', { text: '', clear: true }, '出口池已清空')

          const runTest = async () => {
            setBusy('test')
            setTestResult(null)
            const result = await api('/test', { model: testModel, text: testText })
            setBusy('')
            setTestResult(result)
            if (result && result.models) setStatus(result)
          }

          // ---------------------------------------------------------------- 顶部状态

          const statusLine = h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: p.text, marginBottom: 10 } },
            h('span', null, `反代 ${relay.port ? `:${relay.port}` : '未启动'}`),
            provider.registered ? h(Badge, { p, tone: 'ok' }, `已注册 ${provider.count} 个`) : h(Badge, { p, tone: 'warn' }, '未注册'),
            h(Badge, { p, tone: proxy.effective ? 'ok' : 'info' }, proxy.effective ? `出口池 ${proxy.count}` : '直连'),
          )

          // ---------------------------------------------------------------- ① 这是什么

          const identityBlock = h(
            Section,
            {
              p,
              title: '① 这个站到底是什么',
              hint:
                'grok3ai.org 自己没有模型。它的每个 /xx/chat 页面只做一件事：往 iframe 里塞一个 HuggingFace Space —— ' +
                '页面里 aiUrl 被赋值六次，只有最后一行生效。所以你在站上聊的其实是 MiniMax（海螺），不是 Grok。' +
                '这个插件直连那两个还活着的 Space。',
            },
            h(
              'div',
              { style: { fontSize: 11.5, color: p.muted, lineHeight: 1.8 } },
              ...models.map((item) =>
                h(
                  'div',
                  { key: `id-${item.id}`, style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10.5 } },
                  `${item.base.replace('https://', '')}  →  ${item.fn}()`,
                ),
              ),
            ),
          )

          // ---------------------------------------------------------------- ② 模型

          const modelRows = models.map((item) => {
            const probe = item.probe || null
            const tone = probe ? (probe.ok ? 'ok' : 'error') : 'info'
            const stateText = probe ? (probe.ok ? '可用' : '不通') : '未探'
            const bits = [
              item.vendor,
              probe && probe.ok ? `${probe.ms}ms` : '',
              probe && probe.version ? `Gradio ${probe.version}` : '',
              probe && probe.error ? probe.error : '',
            ]
              .filter(Boolean)
              .join(' · ')
            return h(
              'div',
              {
                key: item.id,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '7px 9px',
                  borderRadius: 7,
                  background: p.soft,
                  marginBottom: 5,
                  fontSize: 11.5,
                },
              },
              h(
                'div',
                { style: { flex: '1 1 auto', minWidth: 0 } },
                h('div', { style: { color: p.text, fontWeight: 600 } }, item.name, h(Badge, { p, tone }, stateText)),
                h('div', { style: { color: p.muted, fontSize: 10.5, lineHeight: 1.6 } }, bits),
                h('div', { style: { color: p.muted, fontSize: 10.5, lineHeight: 1.6, fontStyle: 'italic' } }, item.note),
              ),
              h(Button, { p, tone: 'ghost', onClick: () => probeOne(item.id), disabled: busy === `probe:${item.id}` }, busy === `probe:${item.id}` ? '探…' : '探活'),
            )
          })

          const modelBlock = h(
            Section,
            {
              p,
              title: '② 模型（每个模型就是一个 Space）',
              hint: '「探活」只读一次 /config，不会真的提问，也不消耗任何东西。冷启动的 Space 第一次可能要等十几秒。',
              right: h(Button, { p, onClick: probeAll, disabled: busy === 'probe' }, busy === 'probe' ? '探着…' : '全部探活'),
            },
            ...modelRows,
            dead.length
              ? h(
                  'div',
                  { style: { fontSize: 10.5, color: p.muted, lineHeight: 1.7, marginTop: 6 } },
                  `站点里另外 ${dead.length} 个已经不注册了：` + dead.map((item) => `${item.name}（${item.reason}）`).join('；'),
                )
              : null,
          )

          // ---------------------------------------------------------------- ③ 注册

          const registerBlock = h(
            Section,
            {
              p,
              title: '③ 接进 DSH',
              hint: '把上面这些模型写进 DSH 的模型选择器（provider 指向本机反代）。重启 DSH 后这里会自动重写一次，一般不用手点。',
              right: h(Button, { p, tone: 'primary', onClick: register, disabled: busy === 'register' }, busy === 'register' ? '注册中…' : '注册'),
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: p.muted } },
              h('span', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, relay.baseURL || '（反代未启动）'),
              h(Button, { p, tone: 'ghost', onClick: restartRelay, disabled: busy === 'restart' }, busy === 'restart' ? '重启中…' : '重启反代'),
            ),
          )

          // ---------------------------------------------------------------- ④ 出口池

          const proxyRows = proxies.map((item) => {
            const tone = item.state === 'cooling' ? 'error' : item.state === 'ready' || item.state === 'rotating' ? 'ok' : 'info'
            const bits = [item.modeText, item.ip ? `出口 ${item.ip}` : '', item.ms ? `${item.ms}ms` : '', item.used ? `用过 ${item.used} 次` : '']
              .filter(Boolean)
              .join(' · ')
            return h(
              'div',
              {
                key: item.id,
                style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 7, background: p.soft, marginBottom: 5, fontSize: 11.5 },
              },
              h(
                'div',
                { style: { flex: '1 1 auto', minWidth: 0 } },
                h(
                  'div',
                  { style: { color: p.text, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  item.masked,
                ),
                h('div', { style: { color: p.muted, fontSize: 10.5, lineHeight: 1.6 } }, bits),
                item.lastError ? h('div', { style: { color: p.danger, fontSize: 10.5, lineHeight: 1.6 } }, item.lastError) : null,
              ),
              h(Badge, { p, tone }, item.stateText),
              h(Button, { p, tone: 'ghost', onClick: () => testProxy(item.id), disabled: busy === `p:${item.id}` }, '测'),
              h(Button, { p, tone: 'ghost', onClick: () => removeProxy(item.id), disabled: busy === `rm:${item.id}` }, '删'),
            )
          })

          const proxyBlock = h(
            Section,
            {
              p,
              title: '④ 出口池（可选）',
              hint: 'HuggingFace 对匿名访问是按 IP 限流的（429）。开池子就是"被限流时换个 IP 再打一发"。不填也能用。',
              right: h(
                Button,
                { p, tone: autoExit ? 'primary' : undefined, onClick: toggleExit, disabled: busy === 'exit-mode' },
                busy === 'exit-mode' ? '切换中…' : autoExit ? '自动换：开' : '自动换：关',
              ),
            },
            proxy.count > 0
              ? h(
                  'div',
                  { style: { fontSize: 11.5, color: p.text, lineHeight: 1.9, marginBottom: 8 } },
                  `池子：${proxy.count} 个出口 · 可用 ${proxy.ready} · 未测 ${proxy.fresh} · 冷却 ${proxy.cooling}`,
                )
              : null,
            ...proxyRows,
            h(
              'div',
              { style: { marginTop: 8 } },
              h(TextArea, {
                p,
                value: proxyText,
                onChange: setProxyText,
                rows: 3,
                placeholder:
                  '一行一个，例如：\nhttp://user:pass@1.2.3.4:8000\nhttp://账号-country_SG-r_1m-s_{session}:密码@gate.nstproxy.io:24125',
              }),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
              h(Button, { p, tone: 'primary', onClick: saveProxy, disabled: busy === 'exit-save' }, busy === 'exit-save' ? '保存中…' : '保存'),
              h(Button, { p, onClick: () => testProxy(), disabled: busy === 'p:all' }, busy === 'p:all' ? '测着…' : '测试全部'),
              h(Button, { p, tone: 'ghost', onClick: clearProxy, disabled: busy === 'exit-clear' }, '清空'),
            ),
          )

          // ---------------------------------------------------------------- ⑤ 试一句

          const testBlock = h(
            Section,
            { p, title: '⑤ 试一句', hint: '真打一发。这一步会真的让 Space 生成内容（不花钱，但会占它的队列）。' },
            h(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
              ...models.map((item) =>
                h(
                  Button,
                  {
                    key: `t-${item.id}`,
                    p,
                    tone: testModel === item.id ? 'primary' : undefined,
                    onClick: () => setTestModel(item.id),
                  },
                  item.name,
                ),
              ),
            ),
            h(TextInput, { p, value: testText, onChange: setTestText, placeholder: '问点什么' }),
            h(
              'div',
              { style: { marginTop: 8 } },
              h(Button, { p, onClick: runTest, disabled: busy === 'test' }, busy === 'test' ? '排队/生成中…' : '发一句'),
            ),
            testResult
              ? h(
                  'div',
                  { style: { marginTop: 8, fontSize: 11.5, lineHeight: 1.7, color: p.text, whiteSpace: 'pre-wrap' } },
                  testResult.ok
                    ? `✅ ${testResult.model} · ${testResult.elapsed}ms · 走 ${testResult.route}${testResult.switches ? `（换了 ${testResult.switches} 次）` : ''}\n${testResult.text || '（没有正文）'}`
                    : `❌ ${testResult.error || `HTTP ${testResult.status}`}`,
                )
              : null,
          )

          const body = h(
            'div',
            null,
            statusLine,
            error ? h(Notice, { p, tone: 'error' }, error) : null,
            notice ? h(Notice, { p, tone: 'ok' }, notice) : null,
            h(
              Notice,
              { p, tone: 'warn' },
              '一句话说清：这两个模型是别人的公开 Space，免费、不用 key，代价是排队、冷启动和偶发限流。',
              '它们不是 Grok —— 站点名字叫 grok3ai，但它到底跑什么模型由几个 iframe 决定。',
            ),
            identityBlock,
            modelBlock,
            registerBlock,
            proxyBlock,
            testBlock,
          )

          if (!open) {
            return h(
              'div',
              { style: { padding: '4px 0' } },
              h(Button, { p, tone: 'ghost', onClick: () => setOpen(true) }, models.length ? `Grok3AI · ${models.length} 个模型` : 'Grok3AI'),
            )
          }

          return h(
            'div',
            {
              style: {
                background: p.panel,
                border: `1px solid ${p.border}`,
                borderRadius: 12,
                padding: 14,
                color: p.text,
                fontFamily: 'inherit',
                maxWidth: 620,
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 } },
              h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Grok3AI 模型接管', h(Badge, { p, tone: 'ok' }, '本机反代')),
              embedded ? null : h(Button, { p, tone: 'ghost', onClick: () => setOpen(false) }, '收起'),
            ),
            body,
          )
        }

        function Grok3Card() {
          return h(Grok3Panel, { embedded: true })
        }

        function Grok3Dock() {
          const [open, setOpen] = React.useState(false)
          const p = palette(useTheme())
          return h(
            'div',
            { style: { position: 'relative' } },
            h(Button, { p, tone: 'ghost', onClick: () => setOpen(!open) }, 'Grok3AI'),
            open
              ? h(
                  'div',
                  {
                    style: {
                      position: 'absolute',
                      bottom: 34,
                      left: 0,
                      zIndex: 40,
                      boxShadow: '0 12px 32px rgba(0,0,0,.28)',
                      borderRadius: 12,
                    },
                  },
                  h(Grok3Panel, { embedded: true }),
                )
              : null,
          )
        }

        // ---------------------------------------------------------------- 装配

        const CARD_KEYS = ['dsh-grok3ai', 'include:dsh-grok3ai']

        function apply(ctx) {
          try {
            ctx.slots.inject('conversation.composer.dock', () =>
              ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-grok3ai-dock', order: 43 }, Grok3Dock),
            )
          } catch (error) {
            console.error('[dsh-grok3ai] 注册输入框插槽失败：', error)
          }

          const registerCard = (slotName, key) => {
            try {
              return ctx.slots.inject(slotName, () => ctx.slots.register({ name: slotName, key, priority: 33 }, Grok3Card))
            } catch (error) {
              console.error(`[dsh-grok3ai] 注册插件页卡片 "${slotName}" 失败：`, error)
              return undefined
            }
          }

          for (const key of CARD_KEYS) registerCard('plugins.bundle.config', key)
          for (const key of CARD_KEYS) registerCard('plugins.row.config', `${key}#${key}`)
        }

        exports.apply = apply
        exports.inject = inject
        exports.name = name
        return module.exports
      },
    })
})()
