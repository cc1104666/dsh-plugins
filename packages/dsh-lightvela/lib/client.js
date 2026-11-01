/**
 * dsh-lightvela —— 浏览器半区。
 *
 * 形态：输入框下方 dock 里的一个「Vela」胶囊 + 一个右侧抽屉面板；
 * 同时注册插件页里的那张卡片（和胶囊是同一份面板，只是去掉抽屉外壳）。
 *
 * 面板只有一件事要讲清楚：**它不需要反代**。
 * 第 ③ 块点一下，LightVela 的模型就出现在聊天框的模型选择器里了。
 * 所以在文案上把「为什么不需要」也写进去，否则用户会一直找代理端口。
 */
;(function () {
const MODULE_LOADER = window.__ModuleLoader__ || window.ModuleLoader
if (!MODULE_LOADER || typeof MODULE_LOADER.load !== 'function') {
  console.error('[dsh-lightvela] 找不到模块加载器，浏览器半区未加载')
} else
  MODULE_LOADER.load({
    id: 'dsh-lightvela',
    factory: (require) => {
      const module = { exports: {} }
      const exports = module.exports

      const React = require('react')
      const h = React.createElement

      const BASE = '/plugins/dsh-lightvela'
      const name = 'dsh-lightvela-client'
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

      function VelaPanel(props) {
        const embedded = Boolean(props && props.embedded)
        const dark = useTheme()
        const p = palette(dark)

        const [status, setStatus] = React.useState(null)
        const [open, setOpen] = React.useState(embedded)
        const [busy, setBusy] = React.useState('')
        const [error, setError] = React.useState('')
        const [notice, setNotice] = React.useState('')
        const [manualToken, setManualToken] = React.useState('')
        const [showManual, setShowManual] = React.useState(false)
        const [testText, setTestText] = React.useState('')
        const [testModel, setTestModel] = React.useState('auto')
        const [testResult, setTestResult] = React.useState(null)

        const qr = (status && status.qr) || { phase: 'idle' }
        const authed = Boolean(status && status.authed)
        const keyReady = Boolean(status && status.keyReady)
        const models = (status && status.models) || []
        const picker = (status && status.modelPicker) || {}
        const referral = (status && status.referral) || { code: '', url: '', applied: '', check: null }
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

        /**
         * 二维码在等扫码时要持续问一下宿主。
         * 宿主自己也在轮询微信，这里只是把它的状态搬到 UI 上，1.2s 一次足够。
         */
        React.useEffect(() => {
          if (!status) return undefined
          const phase = qr.phase
          if (phase !== 'wait' && phase !== 'scan') return undefined
          const timer = setInterval(async () => {
            const result = await api('/status')
            if (!result || !result.ok) return
            setStatus(result)
            if (result.qr && result.qr.phase === 'done') {
              setNotice('登录成功，正在自动从实例里取模型钥匙…')
              // afterLogin 是后台跑的，等它落到 auth.json 再刷一次。
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
        const pullKey = () => run('key', '/key/pull', {}, '模型钥匙已更新')
        const refreshModels = () => run('models', '/models/refresh', {}, '模型清单已刷新')
        const probeModels = () => run('probe', '/models/probe', {}, '探测完成，看下面每个模型的状态')
        const register = () => run('register', '/models/register', {}, '已写进 DSH 的模型选择器，刷新页面就能选')

        const bindManual = async () => {
          const value = manualToken.trim()
          if (value === '') {
            setError('请粘贴 sessionToken')
            return
          }
          await run('bind', '/auth/bind', { sessionToken: value }, '已绑上登录态')
          setManualToken('')
          setShowManual(false)
        }

        const logout = async () => {
          setBusy('logout')
          await api('/logout', {})
          setBusy('')
          setNotice('已退出，模型选择器里的 LightVela 组会在下次重启 DSH 后消失')
          setStatus(null)
          await refresh()
        }

        const runTest = async () => {
          setBusy('test')
          setTestResult(null)
          const result = await api('/test', { model: testModel })
          setBusy('')
          setTestResult(result)
        }

        /** 打开邀请注册页。先问一次宿主邀请码还活着没，别把人送去过期活动。 */
        const openInvite = async () => {
          let url = referral.url
          if (url === '') {
            setError('插件没配邀请码（config.json 的 referralCode 为空）')
            return
          }
          setBusy('invite')
          const info = await api('/referral')
          setBusy('')
          if (info && info.ok && info.url) url = info.url
          if (info && info.check && info.check.ok === false && info.check.note) {
            setNotice(`${info.check.note} —— 链接还是给你打开了，但这个码可能不返利`)
          }
          try {
            window.open(url, '_blank', 'noopener,noreferrer')
          } catch (openError) {
            setError(`打不开浏览器：${String((openError && openError.message) || openError)}`)
          }
        }

        const copyInvite = async () => {
          const text = referral.url || referral.code
          if (!text) {
            setError('插件没配邀请码')
            return
          }
          try {
            await navigator.clipboard.writeText(text)
            setNotice('邀请链接已复制，发到群里就行')
          } catch {
            setNotice(`复制失败，手动拿走：${text}`)
          }
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
          h('span', null, authed ? `账号 ${(view.account && (view.account.name || view.account.id)) || '已登录'}` : '未登录'),
          h(Badge, { p, tone: authed ? 'ok' : 'warn' }, authed ? '登录态 OK' : '要扫码'),
          h(Badge, { p, tone: keyReady ? 'ok' : 'warn' }, keyReady ? '模型钥匙 OK' : '没钥匙'),
          picker.registered ? h(Badge, { p, tone: 'ok' }, `已注册 ${picker.count} 个`) : null,
          referral.applied ? h(Badge, { p, tone: 'ok' }, `已带邀请 ${referral.applied}`) : null,
        )

        /**
         * 邀请注册入口。
         *
         * 两条路都留着，因为它们解决的不是同一件事：
         *   · 扫码登录那条已经自动带归因了 —— 新用户直接扫也能算邀请；
         *   · 这颗按钮是给人「正在用插件、顺手想注册」的场景，点开就是邀请页，
         *     归因走站点自己的 cookie，最稳。
         */
        const inviteBlock = referral.code
          ? h(
              'div',
              {
                style: {
                  marginTop: 12,
                  paddingTop: 10,
                  borderTop: `1px dashed ${p.border}`,
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 8,
                },
              },
              h(
                'div',
                { style: { flex: '1 1 200px', minWidth: 0, fontSize: 11.5, color: p.muted, lineHeight: 1.6 } },
                authed ? '想拉朋友一起用？把邀请页丢给他就行。' : '还没有 LightVela 账号？点右边直接用邀请链接注册，微信扫码即建号。',
                h(
                  'div',
                  { style: { marginTop: 2, fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: p.muted } },
                  `邀请码 ${referral.code}`,
                ),
              ),
              h(
                Button,
                { p, tone: authed ? 'ghost' : 'primary', onClick: openInvite, disabled: busy === 'invite' },
                busy === 'invite' ? '打开中…' : authed ? '邀请好友' : '用邀请链接注册',
              ),
              h(Button, { p, tone: 'ghost', onClick: copyInvite }, '复制链接'),
            )
          : null

        const loginBlock = h(
          Section,
          {
            p,
            title: '① 微信扫码登录',
            hint:
              '二维码是宿主自己在本地向 LightVela 申请的（微信开放平台网页授权），你在手机上点确认后，' +
              '宿主自己把登录态领回来 —— 不用开浏览器，也不用复制 cookie。' +
              '首次授权会自动建号，所以你直接扫就行。' +
              (referral.code ? `扫码时会自动带上邀请码 ${referral.code}，新账号按邀请归因。` : ''),
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
                  value: manualToken,
                  onChange: setManualToken,
                  placeholder: '粘贴 sessionToken（浏览器打开 api.lightvela.com/auth/session 可见）',
                }),
                h(
                  'div',
                  { style: { marginTop: 8 } },
                  h(Button, { p, onClick: bindManual, disabled: busy === 'bind' }, busy === 'bind' ? '校验中…' : '绑定'),
                ),
              )
            : null,
          inviteBlock,
        )

        const keyBlock = h(
          Section,
          {
            p,
            title: '② 模型钥匙',
            hint:
              'LightVela 的模型额度是平台代付的，它没有任何「对外发 API Key」的接口 —— 钥匙只存在于你那个云实例的 ' +
              '~/.hermes/.env 里（CUSTOM_API_KEY）。所以这一步是：用登录态进到实例沙箱读一次。' +
              '钥匙跟着实例走，实例重建后要重新拉。',
            right: h(Button, { p, tone: 'ghost', onClick: pullKey, disabled: busy === 'key' || !authed }, busy === 'key' ? '读取中…' : '重新拉取'),
          },
          h(
            'div',
            { style: { fontSize: 11.5, color: p.text, lineHeight: 1.9 } },
            h('div', null, `实例：${(view.instance && view.instance.name) || '—'}`),
            h('div', null, `网关：${(view.gatewayBase || '—')}`),
            h('div', null, `钥匙：${keyReady ? '已保存' : '未获取'}${view.keyPulledAt ? ` · ${String(view.keyPulledAt).slice(0, 19).replace('T', ' ')}` : ''}`),
          ),
          keyReady
            ? h(Notice, { p, tone: 'ok' }, '这把钥匙就是 LightVela 实例内部用的那一把 —— 用它花的额度走你的套餐积分。')
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
              ),
            ),
            item.note
              ? h('span', { style: { color: p.muted, fontSize: 10.5, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.note)
              : null,
            h(
              Badge,
              { p, tone: item.usable === true ? 'ok' : item.usable === false ? 'error' : 'warn' },
              item.usable === true ? '可调' : item.usable === false ? '打不通' : '未测',
            ),
          ),
        )

        const modelBlock = h(
          Section,
          {
            p,
            title: '③ 模型放进 DSH 选择器',
            hint:
              'LightVela 的网关本身就是 OpenAI 兼容的，公网直连可达 —— 所以这一步**不需要本机反代**，' +
              '插件只是把 baseURL + 钥匙写进 DSH 的 llm-pi-ai 配置。写完刷新页面，模型选择器里就多出 ' +
              `「${picker.providerName || 'LightVela'}」这一组。`,
            right: h(
              'div',
              { style: { display: 'flex', gap: 6 } },
              h(Button, { p, tone: 'ghost', onClick: refreshModels, disabled: busy === 'models' || !keyReady }, '读清单'),
              h(Button, { p, tone: 'ghost', onClick: probeModels, disabled: busy === 'probe' || !keyReady }, busy === 'probe' ? '探测中…' : '逐个探测'),
              h(Button, { p, tone: 'primary', onClick: register, disabled: busy === 'register' || !keyReady }, busy === 'register' ? '写入中…' : '注册'),
            ),
          },
          models.length === 0
            ? h('div', { style: { fontSize: 11.5, color: p.muted } }, keyReady ? '还没读清单，点右上「读清单」。' : '先把上面的钥匙拿到。')
            : h('div', null, modelRows),
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
          { p, title: '④ 试一句', hint: '直接拿钥匙打一发，不经过 DSH，用来判断"是模型不行"还是"是配置没生效"。' },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h(TextInput, { p, value: testModel, onChange: setTestModel, placeholder: 'auto' }),
            h(Button, { p, onClick: runTest, disabled: busy === 'test' || !keyReady }, busy === 'test' ? '请求中…' : '发一句'),
          ),
          testResult
            ? h(
                'div',
                { style: { marginTop: 8, fontSize: 11.5, lineHeight: 1.7, color: p.text } },
                testResult.ok
                  ? `✅ ${testResult.model} · ${testResult.elapsed}ms\n${testResult.text || '（没有文字，可能全在 reasoning 里）'}`
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
          loginBlock,
          keyBlock,
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
            '说明：这里取的是你账号自己实例里的凭据，消耗的是你自己的套餐积分。',
            '额度用尽时网关会返回 402，那不是插件的问题。',
          ),
        )

        if (!open) {
          return h(
            'div',
            { style: { padding: '4px 0' } },
            h(
              Button,
              { p, tone: 'ghost', onClick: () => setOpen(true) },
              `LightVela${authed ? (keyReady ? ' · 已就绪' : ' · 缺钥匙') : ' · 未登录'}`,
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
              'LightVela 模型接管',
              h(Badge, { p, tone: 'ok' }, '无需反代'),
            ),
            embedded
              ? null
              : h(Button, { p, tone: 'ghost', onClick: () => setOpen(false) }, '收起'),
          ),
          body,
        )
      }

      /** 输入框下方 dock 里的胶囊。点开就是一个浮层。 */
      function VelaDock(props) {
        const [open, setOpen] = React.useState(false)
        const p = palette(useTheme())
        React.useEffect(() => {
          if (props && props.embedded) setOpen(true)
        }, [props])
        return h(
          'div',
          { style: { position: 'relative' } },
          h(
            Button,
            { p, tone: 'ghost', onClick: () => setOpen(!open) },
            'LightVela',
          ),
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
                h(VelaPanel, { embedded: true }),
              )
            : null,
        )
      }

      /** 插件页里的卡片。 */
      function VelaCard() {
        return h(VelaPanel, { embedded: true })
      }

      // -------------------------------------------------------------- 装配

      const CARD_KEYS = ['dsh-lightvela', 'include:dsh-lightvela']

      function apply(ctx) {
        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'dsh-lightvela-dock', order: 40 },
              VelaDock,
            ),
          )
        } catch (error) {
          console.error('[dsh-lightvela] 注册输入框插槽失败：', error)
        }

        const registerCard = (slotName, key) => {
          try {
            return ctx.slots.inject(slotName, () =>
              ctx.slots.register({ name: slotName, key, priority: 30 }, VelaCard),
            )
          } catch (error) {
            console.error(`[dsh-lightvela] 注册插件页卡片 "${slotName}" 失败：`, error)
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
