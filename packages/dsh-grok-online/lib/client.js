/**
 * dsh-grok-online —— 浏览器半区。
 *
 * 形态：输入框下方 dock 里一个「Grok」胶囊 + 插件页里的一张卡片（同一份面板）。
 *
 * 面板只讲三件事：
 *   ① 今天还剩几条（这是全站唯一的硬约束，必须第一眼看到）
 *   ② 出口池：额度按 IP 记，那就把"从哪个 IP 出去"做成一池子，用完自动换
 *   ③ 模型清单（4.20 / 4.3；4.7 网页版锁了，只做说明）
 *   ④ 一键注册进 DSH 模型选择器 + 试一句
 *
 * 注意：整个文件包在 IIFE 里。DSH 把每个插件的 client.js 当普通脚本塞进同一个
 * 全局作用域，顶层写 const 会跟别的插件撞名（踩过：MODULE_LOADER 重复声明，
 * 直接把 DSH 打进恢复模式）。
 */
;(function () {
  const MODULE_LOADER = window.__ModuleLoader__ || window.ModuleLoader
  if (!MODULE_LOADER || typeof MODULE_LOADER.load !== 'function') {
    console.error('[dsh-grok-online] 找不到模块加载器，浏览器半区未加载')
  } else
    MODULE_LOADER.load({
      id: 'dsh-grok-online',
      factory: (require) => {
        const module = { exports: {} }
        const exports = module.exports

        const React = require('react')
        const h = React.createElement

        const BASE = '/plugins/dsh-grok-online'
        const name = 'dsh-grok-online-client'
        const inject = ['slots']

        // ---------------------------------------------------------------- 基础工具

        async function api(path, body) {
          try {
            const options =
              body === undefined
                ? { method: 'GET' }
                : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            const response = await fetch(BASE + path, options)
            const parsed = await response.json().catch(() => null)
            if (parsed === null) {
              // dsh 对没注册的路径不返 JSON：GET 404 空体 / POST 405 空体。
              // 这几乎总是"宿主还是旧代码、面板已经是新代码"。
              if (response.status === 404 || response.status === 405) {
                return {
                  ok: false,
                  stale: true,
                  error: `宿主端没有这条接口（${path} → HTTP ${response.status}）——插件刚装/刚更新过，重启 DSH 后生效`,
                }
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
            observer.observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['data-theme', 'class', 'style'],
            })
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
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginBottom: 6,
                },
              },
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

        function GrokPanel(props) {
          const embedded = Boolean(props && props.embedded)
          const p = palette(useTheme())

          const [status, setStatus] = React.useState(null)
          const [open, setOpen] = React.useState(embedded)
          const [busy, setBusy] = React.useState('')
          const [error, setError] = React.useState('')
          const [notice, setNotice] = React.useState('')
          const [testModel, setTestModel] = React.useState('grok-4-20')
          const [testText, setTestText] = React.useState('用一句话说明你是谁')
          const [testResult, setTestResult] = React.useState(null)
          /** 出口池的粘贴框。不预填已有代理（里面带密码，没必要往 DOM 里塞），只在保存时用。 */
          const [proxyText, setProxyText] = React.useState('')

          // 首帧 status 还是 null：所有字段都从 view 取，避免 null.xxx 把整块卡片打崩。
          const view = status || {}
          const credits = view.credits === null || view.credits === undefined ? null : view.credits
          const bonus = view.bonus || ''
          const models = Array.isArray(view.models) ? view.models : []
          const locked = Array.isArray(view.locked) ? view.locked : []
          const provider = view.provider || {}
          const relay = view.relay || {}
          const quotaInfo = view.quota || {}
          const proxy = view.proxy || {}
          const proxies = Array.isArray(view.proxies) ? view.proxies : []
          const autoExit = proxy.mode === 'auto'

          const refresh = React.useCallback(async () => {
            const result = await api('/status')
            if (result && result.ok !== false) setStatus(result)
            else if (result && result.error) setError(result.error)
            return result
          }, [])

          React.useEffect(() => {
            refresh()
          }, [refresh])

          const run = async (key, path, body, done) => {
            setBusy(key)
            setError('')
            setNotice('')
            const result = body === undefined ? await api(path) : await api(path, body)
            setBusy('')
            if (result && result.ok === false && result.error) setError(result.error)
            else if (done) setNotice(done)
            else if (result && result.message) setNotice(result.message)
            await refresh()
            return result
          }

          const refreshCredits = () => run('credits', '/credits/refresh', {}, '额度已刷新')
          const unlock = () => run('unlock', '/credits/unlock', {})
          const register = () => run('register', '/models/register', {}, '已写进 DSH 的模型选择器，刷新页面就能选')
          const restartRelay = () => run('relay', '/relay/restart', {}, '反代已重启')

          const runTest = async () => {
            setBusy('test')
            setTestResult(null)
            const result = await api('/test', { model: testModel, text: testText })
            setBusy('')
            setTestResult(result)
            await refresh()
          }

          const toggleExit = () => run('exit-mode', '/proxy/mode', { mode: autoExit ? 'off' : 'auto' })
          const saveProxy = () => run('exit-save', '/proxy/save', { text: proxyText })
          const clearProxy = () => run('exit-clear', '/proxy/save', { text: '', clear: true }, '出口池已清空')
          const testOne = (id) => run(`probe:${id}`, '/proxy/test', { id })
          const testAll = () => run('probe-all', '/proxy/test', {})
          const removeProxy = (id) => run(`rm:${id}`, '/proxy/remove', { id }, '已删掉')

          // ------------------------------------------------------------ 各区块

          const statusLine = h(
            'div',
            {
              style: {
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                alignItems: 'center',
                fontSize: 11,
                color: p.muted,
                marginBottom: 14,
                paddingBottom: 12,
                borderBottom: `1px solid ${p.border}`,
              },
            },
            h('span', null, autoExit
              ? `直连 ${credits === null ? '?' : credits} 条 · 池子 ${proxy.totalCredits === undefined ? '?' : proxy.totalCredits} 条`
              : credits === null
                ? '额度未知'
                : `今天还剩 ${credits} 条`),
            h(Badge, { p, tone: credits === null ? 'warn' : credits > 0 ? 'ok' : 'error' }, credits === null ? '待刷新' : credits > 0 ? '可用' : '已用完'),
            autoExit ? h(Badge, { p, tone: 'ok' }, `自动换出口 ${proxy.count || 0}`) : null,
            bonus === 'available' ? h(Badge, { p, tone: 'warn' }, '可领 +5') : null,
            bonus === 'used' ? h(Badge, { p, tone: 'info' }, '奖励已领') : null,
            provider.registered ? h(Badge, { p, tone: 'ok' }, `已注册 ${provider.count} 个`) : null,
          )

          const quotaBlock = h(
            Section,
            {
              p,
              title: '① 今日额度',
              hint:
                'grok.online 不登录、不发 key，额度按出口 IP 记：每天 4 条，用完还能领 5 条奖励，合计 9 条。' +
                'UTC 零点（北京时间早上 8 点）重置。这些数字是它的规则，不是插件的限制。',
              right: h(
                'div',
                { style: { display: 'flex', gap: 6 } },
                h(Button, { p, tone: 'ghost', onClick: refreshCredits, disabled: busy === 'credits' }, busy === 'credits' ? '查询中…' : '刷新'),
                h(Button, { p, onClick: unlock, disabled: busy === 'unlock' || bonus !== 'available' }, busy === 'unlock' ? '领取中…' : '领取 +5'),
              ),
            },
            h(
              'div',
              { style: { fontSize: 11.5, color: p.text, lineHeight: 1.9 } },
              h('div', null, `剩余：${credits === null ? '—' : `${credits} 条`}`),
              h('div', null, `规则：${quotaInfo.free || 4} 条免费 + ${quotaInfo.bonus || 5} 条奖励 · ${quotaInfo.reset || 'UTC 零点重置'}`),
              h('div', null, `记法：${quotaInfo.by || '按出口 IP 记'}`),
            ),
            bonus === 'available'
              ? h(Notice, { p, tone: 'warn' }, '今天的免费额度用完了，但还有 5 条奖励没领 —— 点右上「领取 +5」，或者直接发消息（插件会自动领一次）。')
              : null,
            credits === 0 && bonus === 'used'
              ? h(Notice, { p, tone: 'error' }, '直连这个 IP 今天的 9 条用完了。要么等 UTC 零点重置，要么在下面 ② 出口池里放几个代理并打开「自动换」。')
              : null,
          )

          // ---------------------------------------------------------------- 出口池

          const proxyRows = proxies.map((item) => {
            const tone =
              item.state === 'ready' || item.state === 'rotating'
                ? 'ok'
                : item.state === 'empty' || item.state === 'cooling'
                  ? 'error'
                  : 'info'
            const bits = [
              item.modeText,
              item.template ? '每发请求换 IP' : item.credits === null || item.credits === undefined ? '额度未测' : `剩 ${item.credits} 条`,
              item.ip ? `出口 ${item.ip}${item.template ? '（上一次的）' : ''}` : '',
              item.ms ? `${item.ms}ms` : '',
              item.used ? `用过 ${item.used} 次` : '',
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
                  padding: '6px 8px',
                  borderRadius: 7,
                  background: p.soft,
                  marginBottom: 5,
                  fontSize: 11.5,
                },
              },
              h(
                'div',
                { style: { flex: '1 1 auto', minWidth: 0 } },
                h(
                  'div',
                  {
                    style: {
                      color: p.text,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 11,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  item.masked,
                ),
                h('div', { style: { color: p.muted, fontSize: 10.5, lineHeight: 1.6 } }, bits),
                item.lastError
                  ? h('div', { style: { color: p.danger, fontSize: 10.5, lineHeight: 1.6 } }, item.lastError)
                  : null,
              ),
              h(Badge, { p, tone }, item.stateText),
              h(
                Button,
                { p, tone: 'ghost', onClick: () => testOne(item.id), disabled: busy === `probe:${item.id}` },
                busy === `probe:${item.id}` ? '测…' : '测',
              ),
              h(
                Button,
                { p, tone: 'ghost', onClick: () => removeProxy(item.id), disabled: busy === `rm:${item.id}` },
                '删',
              ),
            )
          })

          const proxyBlock = h(
            Section,
            {
              p,
              title: '② 出口池（用完自动换 IP）',
              hint:
                '额度按出口 IP 记，换个 IP 就是新的一份。最管用的是账号里带 {session} 的住宅代理：插件每发请求换一个随机会话，' +
                '于是每次都是新 IP、每次都是新的一份额度。静态代理 N 个 ≈ 9N 条/天，行尾 #rotating 的隧道代理看代理商心情。' +
                '插件不承诺"无限"，只保证「这一发失败了自动换下一个」。',
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
                  h('div', null, `池子：${proxy.count} 个出口 · 已知剩余合计 ${proxy.totalCredits || 0} 条`),
                  h(
                    'div',
                    null,
                    `状态：可用 ${proxy.ready} · 未测 ${proxy.fresh} · 用完 ${proxy.empty} · 冷却 ${proxy.cooling}` +
                      (proxy.rotating ? ` · 动态 ${proxy.rotating}` : ''),
                  ),
                )
              : h(Notice, { p, tone: 'warn' }, '池子是空的，现在只走直连。往下粘几行代理保存，再打开「自动换」。'),
            ...proxyRows,
            h('div', { style: { marginTop: 8 } },
              h(TextArea, {
                p,
                value: proxyText,
                onChange: setProxyText,
                rows: 4,
                placeholder:
                  '一行一个，例如：\nhttp://user:pass@1.2.3.4:8000\nsocks5://5.6.7.8:1080\nhttp://gate.proxy.cn:15818 #rotating\nhttp://账号-country_SG-r_1m-s_{session}:密码@gate.nstproxy.io:24125',
              }),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
              h(Button, { p, tone: 'primary', onClick: saveProxy, disabled: busy === 'exit-save' }, busy === 'exit-save' ? '保存中…' : '保存'),
              h(Button, { p, onClick: testAll, disabled: busy === 'probe-all' }, busy === 'probe-all' ? '测着…' : '测试全部'),
              h(Button, { p, tone: 'ghost', onClick: clearProxy, disabled: busy === 'exit-clear' }, '清空'),
            ),
            h(
              'div',
              { style: { fontSize: 10.5, color: p.muted, lineHeight: 1.7, marginTop: 6 } },
              '保存不会自动测；「测试全部」挨个查额度（不消耗额度），顺便显示出口 IP。',
              autoExit ? ' 现在开着自动换：一发请求失败会自动往下试，最多试 ' + (proxy.maxAttempts || 10) + ' 次。' : '',
            ),
          )

          const modelRows = models.map((item) =>
            h(
              'div',
              {
                key: item.id,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 7,
                  background: p.soft,
                  marginBottom: 5,
                  fontSize: 11.5,
                },
              },
              h(
                'div',
                { style: { flex: '1 1 auto', minWidth: 0 } },
                h('div', { style: { color: p.text, fontWeight: 600 } }, item.name),
                h(
                  'div',
                  { style: { color: p.muted, fontSize: 10.5, fontFamily: 'ui-monospace, monospace' } },
                  `${item.id} → 上游 ${item.mono}`,
                ),
              ),
              item.note ? h('span', { style: { color: p.muted, fontSize: 10.5 } }, item.note) : null,
              h(Badge, { p, tone: 'ok' }, '可调'),
            ),
          )

          const lockedRows = locked.map((item) =>
            h(
              'div',
              {
                key: item.id,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 7,
                  border: `1px dashed ${p.border}`,
                  marginBottom: 5,
                  fontSize: 11.5,
                  color: p.muted,
                },
              },
              h(
                'div',
                { style: { flex: '1 1 auto', minWidth: 0 } },
                h('div', { style: { fontWeight: 600 } }, item.name),
                h('div', { style: { fontSize: 10.5, lineHeight: 1.5 } }, item.reason),
              ),
              h(Badge, { p, tone: 'warn' }, '不可用'),
            ),
          )

          const modelBlock = h(
            Section,
            {
              p,
              title: '③ 模型',
              hint:
                '这两个是网页版真正能调的。第三个 Grok 4.7 在站点菜单里能看到，但接口一律拒绝（403 model_locked），所以不注册。',
              right: h(Button, { p, tone: 'primary', onClick: register, disabled: busy === 'register' }, busy === 'register' ? '写入中…' : '注册进 DSH'),
            },
            modelRows,
            lockedRows,
            h(
              'div',
              { style: { fontSize: 10.5, color: p.muted, lineHeight: 1.7, marginTop: 6 } },
              `反代：${relay.baseURL || '未启动'}　`,
              h(
                'span',
                {
                  onClick: restartRelay,
                  style: { color: p.accent, cursor: busy === 'relay' ? 'default' : 'pointer' },
                },
                busy === 'relay' ? '重启中…' : '重启反代',
              ),
            ),
            provider.registered
              ? h(Notice, { p, tone: 'ok' }, `已经写进 DSH 了（${provider.count} 个模型 → ${provider.baseURL}）。刷新页面后，模型选择器里会出现「${provider.providerName || 'Grok.online'}」组。`)
              : h(Notice, { p, tone: 'warn' }, '还没注册。点右上「注册进 DSH」，然后刷新页面，模型选择器里就会出现这一组。'),
          )

          const testBlock = h(
            Section,
            {
              p,
              title: '④ 试一句',
              hint: '真打一发（会消耗 1 条额度）。用来分辨"模型不行"还是"没注册上"。',
            },
            h(
              'div',
              { style: { display: 'flex', gap: 6, marginBottom: 8 } },
              ...models.map((item) =>
                h(
                  Button,
                  {
                    key: item.id,
                    p,
                    tone: testModel === item.id ? 'primary' : 'ghost',
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
              h(Button, { p, onClick: runTest, disabled: busy === 'test' }, busy === 'test' ? '请求中…' : '发一句'),
            ),
            testResult
              ? h(
                  'div',
                  { style: { marginTop: 8, fontSize: 11.5, lineHeight: 1.7, color: p.text, whiteSpace: 'pre-wrap' } },
                  testResult.ok
                    ? `✅ ${testResult.model} · ${testResult.elapsed}ms · 剩余 ${testResult.credits === null || testResult.credits === undefined ? '?' : testResult.credits} 条\n${testResult.text || '（没有正文，可能全在 reasoning 里）'}`
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
            quotaBlock,
            proxyBlock,
            modelBlock,
            testBlock,
            h(
              'div',
              {
                style: {
                  fontSize: 10.5,
                  color: p.muted,
                  lineHeight: 1.7,
                  borderTop: `1px solid ${p.border}`,
                  paddingTop: 10,
                },
              },
              '说明：这条链路不花钱、不需要 key，代价是每个出口 IP 每天 9 条（4 条免费 + 5 条奖励）。',
              'DSH 的一轮工具调用可能消耗好几条，所以它更适合"问一句答一句"，不适合跑长任务。',
              '出口池能把这个上限乘以出口个数，但它本质是绕开站点的免费额度设计 —— 换得太凶可能被风控（403 / 加验证码），别拿它当主力模型刷长任务。',
            ),
          )

          if (!open) {
            return h(
              'div',
              { style: { padding: '4px 0' } },
              h(
                Button,
                { p, tone: 'ghost', onClick: () => setOpen(true) },
                autoExit ? `Grok · 池子 ${proxy.totalCredits || 0} 条` : `Grok · 剩 ${credits === null ? '?' : credits} 条`,
              ),
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
              h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Grok.online 模型接管', h(Badge, { p, tone: 'ok' }, '本机反代')),
              embedded ? null : h(Button, { p, tone: 'ghost', onClick: () => setOpen(false) }, '收起'),
            ),
            body,
          )
        }

        /** 插件页里的卡片。 */
        function GrokCard() {
          return h(GrokPanel, { embedded: true })
        }

        /** 输入框下方 dock 里的胶囊。点开就是一个浮层。 */
        function GrokDock() {
          const [open, setOpen] = React.useState(false)
          const p = palette(useTheme())
          return h(
            'div',
            { style: { position: 'relative' } },
            h(Button, { p, tone: 'ghost', onClick: () => setOpen(!open) }, 'Grok'),
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
                  h(GrokPanel, { embedded: true }),
                )
              : null,
          )
        }

        // ---------------------------------------------------------------- 装配

        const CARD_KEYS = ['dsh-grok-online', 'include:dsh-grok-online']

        function apply(ctx) {
          try {
            ctx.slots.inject('conversation.composer.dock', () =>
              ctx.slots.register(
                { name: 'conversation.composer.dock', id: 'dsh-grok-online-dock', order: 42 },
                GrokDock,
              ),
            )
          } catch (error) {
            console.error('[dsh-grok-online] 注册输入框插槽失败：', error)
          }

          const registerCard = (slotName, key) => {
            try {
              return ctx.slots.inject(slotName, () =>
                ctx.slots.register({ name: slotName, key, priority: 32 }, GrokCard),
              )
            } catch (error) {
              console.error(`[dsh-grok-online] 注册插件页卡片 "${slotName}" 失败：`, error)
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
