/**
 * dsh-ima —— 浏览器半区。
 *
 * 形态：输入框下方 dock 里的一个「ima」胶囊 + 一个浮层面板；
 * 同时注册插件页里的那张卡片（同一份面板，去掉浮层外壳）。
 *
 * 面板要讲清楚的事：
 *   ① 微信扫码登录（和 ima.qq.com 网页版同一套开放平台授权）
 *   ② 模型清单免登录就能读（DeepSeek V3.2 / 混元 2.0，各带 Think 版）
 *   ③ 注册进模型选择器 —— 这一步需要本机反代（127.0.0.1），
 *      因为 ima 的对话接口不是 OpenAI 兼容的。
 */
;(function () {
const MODULE_LOADER = window.__ModuleLoader__ || window.ModuleLoader
if (!MODULE_LOADER || typeof MODULE_LOADER.load !== 'function') {
  console.error('[dsh-ima] 找不到模块加载器，浏览器半区未加载')
} else
  MODULE_LOADER.load({
    id: 'dsh-ima',
    factory: (require) => {
      const module = { exports: {} }
      const exports = module.exports

      const React = require('react')
      const h = React.createElement

      const BASE = '/plugins/dsh-ima'
      const name = 'dsh-ima-client'
      const inject = ['slots']

      // -------------------------------------------------------------- 基础工具

      async function api(path, body) {
        try {
          const options =
            body === undefined
              ? { method: 'GET' }
              : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          const response = await fetch(BASE + path, options)
          const parsed = await response.json().catch(() => null)
          if (parsed === null) {
            // dsh 对"没注册的路径"不返 JSON：GET 404 空体 / POST 405 空体。
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
          return true
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
              bg: '#17191f',
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
              bg: '#ffffff',
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

      // -------------------------------------------------------------- 小组件

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
          hint
            ? h('div', { style: { fontSize: 11, color: p.muted, lineHeight: 1.6, marginBottom: 8 } }, hint)
            : null,
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

      // -------------------------------------------------------------- 主面板

      function ImaPanel(props) {
        const embedded = Boolean(props && props.embedded)
        const dark = useTheme()
        const p = palette(dark)

        const [status, setStatus] = React.useState(null)
        const [open, setOpen] = React.useState(embedded)
        const [busy, setBusy] = React.useState('')
        const [error, setError] = React.useState('')
        const [notice, setNotice] = React.useState('')
        const [manualCookie, setManualCookie] = React.useState('')
        const [showManual, setShowManual] = React.useState(false)
        const [testText, setTestText] = React.useState('')
        const [testModel, setTestModel] = React.useState('')

        const qr = (status && status.qr) || { phase: 'idle' }
        const authed = Boolean(status && status.authed)
        const models = (status && status.models) || []
        const picker = (status && status.modelPicker) || {}
        // 首帧 status 还是 null：统一走 view，避免 `null.instance` 把插件页整块打崩。
        const view = status || {}

        const refresh = React.useCallback(async () => {
          const result = await api('/status')
          if (result && result.ok) setStatus(result)
          return result
        }, [])

        React.useEffect(() => {
          refresh()
        }, [refresh])

        /** 二维码在等扫码时持续问宿主（宿主自己也在轮微信），1.2s 一次足够。 */
        React.useEffect(() => {
          if (!status) return undefined
          const phase = qr.phase
          if (phase !== 'wait' && phase !== 'scan') return undefined
          const timer = setInterval(async () => {
            const result = await api('/status')
            if (!result || !result.ok) return
            setStatus(result)
            if (result.qr && result.qr.phase === 'done') {
              setNotice('登录成功，正在自动把模型注册进选择器…')
              setTimeout(refresh, 1500)
              setTimeout(refresh, 4000)
            }
          }, 1200)
          return () => clearInterval(timer)
        }, [status, qr.phase, refresh])

        const run = async (key, path, body, done) => {
          setBusy(key)
          setError('')
          setNotice('')
          const result = body === undefined ? await api(path) : await api(path, body)
          setBusy('')
          if (result && result.ok === false && result.error) setError(result.error)
          else if (done) setNotice(done)
          await refresh()
          return result
        }

        const startQr = () => run('qr', '/auth/qr/start', {})
        const cancelQr = () => run('qr', '/auth/qr/cancel', {})
        const refreshModels = () => run('models', '/models/refresh', {}, '模型清单已刷新')
        const register = () => run('register', '/models/register', {}, '已写进 DSH 的模型选择器，刷新页面就能选')

        const bindManual = async () => {
          const value = manualCookie.trim()
          if (value === '') {
            setError('请粘贴 x-ima-cookie 整串')
            return
          }
          await run('bind', '/auth/bind', { cookie: value }, '已绑上登录态')
          setManualCookie('')
          setShowManual(false)
        }

        const logout = async () => {
          setBusy('logout')
          await api('/logout', {})
          setBusy('')
          setNotice('已退出，模型选择器里的 ima 组会在下次重启 DSH 后消失')
          setStatus(null)
          await refresh()
        }

        const runTest = async () => {
          setBusy('test')
          setTestText('')
          const result = await api('/test', { model: testModel })
          setBusy('')
          setTestText(
            result && result.ok
              ? `✅ ${result.model} · ${result.elapsed}ms\n${result.text || '（没有文字）'}`
              : `❌ ${result.text || (result && result.error) || '失败'}`,
          )
        }

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
          h('span', null, authed ? `账号 ${(view.account && view.account.name) || '已登录'}` : '未登录'),
          h(Badge, { p, tone: authed ? 'ok' : 'warn' }, authed ? '登录态 OK' : '要扫码'),
          picker.registered ? h(Badge, { p, tone: 'ok' }, `已注册 ${picker.count} 个`) : null,
        )

        const loginBlock = h(
          Section,
          {
            p,
            title: '① 微信扫码登录',
            hint:
              '二维码是宿主在本地向微信开放平台申请的（和 ima.qq.com 网页登录同一套 snsapi_login 授权），' +
              '手机上点确认后宿主自己把 IMA-TOKEN 领回来 —— 不用开浏览器，也不用复制 cookie。',
            right: authed
              ? h(
                  'div',
                  { style: { display: 'flex', gap: 6 } },
                  h(Button, { p, tone: 'ghost', onClick: startQr, disabled: busy === 'qr' }, '重新登录'),
                  h(Button, { p, tone: 'ghost', onClick: logout, disabled: busy === 'logout' }, '退出'),
                )
              : null,
          },
          qr.phase === 'wait' || qr.phase === 'scan'
            ? h(
                'div',
                { style: { display: 'flex', gap: 14, alignItems: 'flex-start' } },
                h(
                  'div',
                  {
                    style: {
                      width: 148,
                      height: 148,
                      borderRadius: 10,
                      border: `1px solid ${p.border}`,
                      background: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      flex: '0 0 auto',
                    },
                  },
                  qr.qr
                    ? h('img', { src: qr.qr, width: 140, height: 140, alt: '微信扫码登录' })
                    : h('span', { style: { fontSize: 11, color: '#888' } }, '二维码加载中…'),
                ),
                h(
                  'div',
                  { style: { flex: '1 1 auto', minWidth: 0 } },
                  h(
                    'div',
                    { style: { fontSize: 12, color: p.text, lineHeight: 1.7 } },
                    qr.phase === 'scan' ? '已扫码，请在手机上点「确认登录」' : '用微信扫一扫',
                  ),
                  h(
                    'div',
                    { style: { fontSize: 11, color: p.muted, marginTop: 4 } },
                    qr.secondsLeft > 0 ? `二维码还有 ${qr.secondsLeft} 秒有效` : '',
                  ),
                  h(
                    'div',
                    { style: { marginTop: 8 } },
                    h(Button, { p, tone: 'ghost', onClick: cancelQr, disabled: busy === 'qr' }, '取消'),
                  ),
                ),
              )
            : h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h(
                  Button,
                  { p, tone: 'primary', onClick: startQr, disabled: busy === 'qr' },
                  busy === 'qr' ? '申请中…' : authed ? '再扫一次' : '生成二维码',
                ),
                h(
                  Button,
                  { p, tone: 'ghost', onClick: () => setShowManual(!showManual) },
                  showManual ? '收起手贴' : '扫码用不了？手贴',
                ),
              ),
          showManual
            ? h(
                'div',
                { style: { marginTop: 10 } },
                h(TextInput, {
                  p,
                  mono: true,
                  value: manualCookie,
                  onChange: setManualCookie,
                  placeholder: '浏览器登录 ima.qq.com 后，从任意请求头复制 x-ima-cookie 整串',
                }),
                h(
                  'div',
                  { style: { marginTop: 8 } },
                  h(Button, { p, onClick: bindManual, disabled: busy === 'bind' }, busy === 'bind' ? '校验中…' : '绑定'),
                ),
              )
            : null,
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
              h('div', { style: { color: p.text, fontWeight: 600 } }, item.name || item.id),
              h(
                'div',
                { style: { color: p.muted, fontSize: 10.5, fontFamily: 'ui-monospace, monospace' } },
                item.id,
                item.describe ? ` · ${item.describe}` : '',
              ),
            ),
            item.isDefault ? h(Badge, { p, tone: 'ok' }, '默认') : null,
          ),
        )

        const modelBlock = h(
          Section,
          {
            p,
            title: '② 模型清单（免登录）',
            hint: 'ima 的模型目录是公开接口，不登录也能读。当前是 DeepSeek V3.2 / 腾讯混元 2.0 各两档（带 Think 的会输出思考过程）。',
            right: h(Button, { p, tone: 'ghost', onClick: refreshModels, disabled: busy === 'models' }, busy === 'models' ? '读取中…' : '读清单'),
          },
          models.length === 0
            ? h('div', { style: { fontSize: 11.5, color: p.muted } }, '清单还没读回来（宿主启动时会自动拉一次）。')
            : h('div', null, modelRows),
        )

        const relayBlock = h(
          Section,
          {
            p,
            title: '③ 放进 DSH 模型选择器',
            hint:
              'ima 的对话接口不是 OpenAI 兼容（/cgi-bin/assistant/qa + 命名事件 SSE + x-ima-cookie 头），' +
              '所以插件在本机 127.0.0.1 起了一个翻译层。这一步把 baseURL 指向它、模型写进 llm-pi-ai。' +
              `写完刷新页面，选择器里就多出「${picker.providerName || '腾讯 ima'}」这一组。`,
            right: h(
              Button,
              { p, tone: 'primary', onClick: register, disabled: busy === 'register' || !authed },
              busy === 'register' ? '写入中…' : '注册',
            ),
          },
          h(
            'div',
            { style: { fontSize: 11.5, color: p.text, lineHeight: 1.9 } },
            h('div', null, `登录态：${authed ? 'OK' : '未登录（要先扫码）'}`),
            h('div', null, `反代：${view.relay ? view.relay.baseURL : '未启动（点「注册」会自动拉起）'}`),
          ),
          picker.registered
            ? h(
                'div',
                { style: { fontSize: 11, color: p.muted, marginTop: 8 } },
                `已注册 ${picker.count} 个模型 → ${picker.baseURL}，刷新 DSH 页面后在选择器里可见。`,
              )
            : null,
        )

        const testBlock = h(
          Section,
          { p, title: '④ 试一句', hint: '不经过 DSH，直接走完整链路（init_session → qa → 删会话），用来判断"是模型不行"还是"是配置没生效"。' },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h(TextInput, { p, value: testModel, onChange: setTestModel, placeholder: '留空用默认模型' }),
            h(Button, { p, onClick: runTest, disabled: busy === 'test' || !authed }, busy === 'test' ? '请求中…' : '发一句'),
          ),
          testText
            ? h(
                'div',
                { style: { marginTop: 8, fontSize: 11.5, lineHeight: 1.7, color: p.text, whiteSpace: 'pre-wrap' } },
                testText,
              )
            : null,
        )

        const body = h(
          'div',
          null,
          statusLine,
          error ? h(Notice, { p, tone: 'error' }, error) : null,
          notice ? h(Notice, { p, tone: 'ok' }, notice) : null,
          loginBlock,
          modelBlock,
          relayBlock,
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
            '说明：走的是你自己的 ima 账号额度（网页版同款）。',
            '每次对话都会建临时会话并在结束后删掉，不在你的 ima 历史里留垃圾。',
          ),
        )

        if (!open) {
          return h(
            'div',
            { style: { padding: '4px 0' } },
            h(
              Button,
              { p, tone: 'ghost', onClick: () => setOpen(true) },
              `ima${authed ? ' · 已就绪' : ' · 未登录'}`,
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
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              },
            },
            h(
              'div',
              { style: { fontSize: 13, fontWeight: 700 } },
              '腾讯 ima 模型接管',
              h(Badge, { p, tone: 'warn' }, '本机反代'),
            ),
            embedded ? null : h(Button, { p, tone: 'ghost', onClick: () => setOpen(false) }, '收起'),
          ),
          body,
        )
      }

      /** 输入框下方 dock 里的胶囊。点开就是一个浮层。 */
      function ImaDock(props) {
        const [open, setOpen] = React.useState(false)
        const p = palette(useTheme())
        React.useEffect(() => {
          if (props && props.embedded) setOpen(true)
        }, [props])
        return h(
          'div',
          { style: { position: 'relative' } },
          h(Button, { p, tone: 'ghost', onClick: () => setOpen(!open) }, 'ima'),
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
                h(ImaPanel, { embedded: true }),
              )
            : null,
        )
      }

      /** 插件页里的卡片。 */
      function ImaCard() {
        return h(ImaPanel, { embedded: true })
      }

      // -------------------------------------------------------------- 装配

      const CARD_KEYS = ['dsh-ima', 'include:dsh-ima']

      function apply(ctx) {
        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'dsh-ima-dock', order: 41 },
              ImaDock,
            ),
          )
        } catch (error) {
          console.error('[dsh-ima] 注册输入框插槽失败：', error)
        }

        const registerCard = (slotName, key) => {
          try {
            return ctx.slots.inject(slotName, () =>
              ctx.slots.register({ name: slotName, key, priority: 30 }, ImaCard),
            )
          } catch (error) {
            console.error(`[dsh-ima] 注册插件页卡片 "${slotName}" 失败：`, error)
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
