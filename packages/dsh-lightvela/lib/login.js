/**
 * 微信扫码登录 LightVela —— 全程在宿主端跑，不弹浏览器、不用复制 cookie。
 *
 * 和 VibeX 那次（公众号带参二维码）不是同一套机制，这里是**微信开放平台网页应用
 * 授权**（snsapi_login）：
 *
 *   1. GET  {api}/auth/oauth/wechat/start  → 307 到 open.weixin.qq.com，同时下发
 *      4 个只能用于回调路径的 cookie：lc_wechat_oauth_state / _mode / _scope / _return_to
 *   2. 请求那个 307 地址，页面 HTML 里带着 `connect/qrcode/<uuid>`，uuid 就是这轮会话
 *   3. 二维码图片 = https://open.weixin.qq.com/connect/qrcode/<uuid>
 *   4. 长轮询 https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>
 *      → wx_errcode=408 超时（继续轮）/ 405 已扫待确认 / 403 已取消 / 0 成功且带 wx_code
 *   5. 拿 code + state 打 {api}/auth/oauth/wechat/callback（带上第 1 步那 4 个 cookie）
 *      → 站点下发 lc_session，这就是网页登录态
 *
 * 第 5 步之所以要带那 4 个 cookie：服务端把 state 存在 cookie 里做 CSRF 校验，
 * 只给 query 里的 state 是匹配不上的。
 */
import {
  startWechatScan,
  pollWechatScan,
  finishWechatScan,
  fetchSession,
  prepareReferral,
  mergeCookies,
  SCAN_STATE,
} from './lightvela.js'

/** 微信单轮长轮询约 15 秒；收到 408 就立刻接下一轮，中间不额外等待。 */
const RETRY_DELAY = 400

export function createWechatLogin({ getConfig, log, onAuthed }) {
  /**
   * phase:
   *   idle   没开始
   *   wait   二维码已就绪，等扫码
   *   scan   扫了，等手机上点确认
   *   done   拿到会话且校验通过，凭据已落盘
   *   error  出错（过期 / 取消 / 校验不过）
   */
  const state = {
    phase: 'idle',
    qr: '',
    qrUrl: '',
    note: '',
    error: '',
    startedAt: 0,
    expiresAt: 0,
    account: null,
    /** 这一轮登录实际挂上的邀请码（没配就是空串）。 */
    referral: '',
  }

  let ticket = null
  /** 每次 start/cancel 自增，让上一轮轮询自己退出。 */
  let session = 0
  let controller = null

  const view = () => ({
    phase: state.phase,
    qr: state.qr,
    qrUrl: state.qrUrl,
    note: state.note,
    error: state.error,
    startedAt: state.startedAt || null,
    expiresAt: state.expiresAt || null,
    secondsLeft: state.expiresAt ? Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000)) : 0,
    account: state.account,
    referral: state.referral,
  })

  const stopPolling = () => {
    if (controller) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
      controller = null
    }
  }

  const reset = (nextPhase = 'idle', note = '') => {
    session += 1
    stopPolling()
    state.phase = nextPhase
    state.note = note
    state.error = ''
    state.qr = ''
    state.qrUrl = ''
    state.startedAt = 0
    state.expiresAt = 0
    state.account = null
    state.referral = ''
    ticket = null
  }

  /** 二维码图片转 dataURL：面板是 web origin，直接引微信域名可能被拦。 */
  const fetchQrImage = async (url) => {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': getConfig().userAgent, referer: 'https://open.weixin.qq.com/' },
      })
      if (!response.ok) return ''
      const type = String(response.headers.get('content-type') || 'image/png').split(';')[0].trim()
      if (!type.startsWith('image/')) return ''
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length === 0 || buffer.length > 512 * 1024) return ''
      return `data:${type};base64,${buffer.toString('base64')}`
    } catch {
      return ''
    }
  }

  /**
   * 把邀请归因挂到这次登录上。
   *
   * 站点是在**微信回调那一发请求**上读 `lc_referral_context` cookie 决定归因的，
   * 而这条 cookie 只活 30 分钟、且 Path 限定在 /auth。二维码本身有效期 5 分钟，
   * 理论上申请时就种也够，但用户可能拖着不扫 —— 所以在真正回调前再种一次，
   * 保证它一定新鲜。
   *
   * 失败不阻断登录：老用户本来就不需要归因，别为了拉新把老用户挡在门外。
   */
  const attachReferral = async (cfg) => {
    const code = String(cfg.referralCode || '').trim()
    if (code === '' || !ticket) return
    try {
      const prepared = await prepareReferral(cfg, code)
      if (!prepared.ok || prepared.cookies.length === 0) {
        log(`邀请归因没挂上（${prepared.note || 'no cookie'}），继续登录`)
        return
      }
      const before = ticket.cookies
      ticket.cookies = mergeCookies(before, prepared.cookies)
      state.referral = prepared.code
      log(`本次登录已带邀请归因：${prepared.code}`)
    } catch (error) {
      log(`邀请归因请求出错，继续登录：${String((error && error.message) || error)}`)
    }
  }

  /** 拿到 code 之后：换会话 → 验一次 → 落盘。 */
  const accept = async (code, mine) => {
    const cfg = getConfig()
    state.note = '扫码成功，正在换取登录态…'
    if (session !== mine) return

    await attachReferral(cfg)
    if (session !== mine) return

    let result
    try {
      result = await finishWechatScan(cfg, ticket, code)
    } catch (error) {
      if (session !== mine) return
      state.phase = 'error'
      state.note = ''
      state.error = String((error && error.message) || error)
      return
    }
    if (session !== mine) return

    const probe = await fetchSession(cfg, result.sessionToken)
    if (session !== mine) return

    if (!probe.ok) {
      state.phase = 'error'
      state.note = ''
      state.error = `微信授权成功，但会话没通过校验：${probe.note || `HTTP ${probe.status}`}`
      log(`扫码拿到的会话未通过校验：${probe.note || probe.status}`)
      return
    }

    const saved = onAuthed({
      sessionToken: result.sessionToken,
      user: probe.user,
      source: 'wechat-qr',
    })
    state.phase = 'done'
    state.note = '登录成功'
    state.error = ''
    state.account = saved && saved.account ? saved.account : probe.user
    stopPolling()
    session += 1
    log(`扫码登录成功：${probe.user ? probe.user.name || probe.user.id : '未知账号'}`)
  }

  /** 一轮长轮询。408 是正常的"没人扫"，不是错误。 */
  const tick = async (mine) => {
    if (session !== mine) return
    if (state.expiresAt && Date.now() > state.expiresAt) {
      state.phase = 'error'
      state.note = ''
      state.error = '二维码已过期（5 分钟），点「刷新二维码」重新来一次。'
      return
    }

    controller = new AbortController()
    let result
    try {
      result = await pollWechatScan(getConfig(), ticket.uuid, controller.signal)
    } catch (error) {
      if (session !== mine) return
      // 主动取消会走到这里，此时 session 已经变了，上面的判断会拦掉。
      log(`扫码轮询异常，稍后重试：${String((error && error.message) || error)}`)
      if (session === mine) {
        setTimeout(() => tick(mine).catch(() => {}), 1500)
      }
      return
    }
    if (session !== mine) return

    if (result.status === SCAN_STATE.CONFIRMED && result.code) {
      await accept(result.code, mine)
      return
    }
    if (result.status === SCAN_STATE.CANCELLED) {
      state.phase = 'error'
      state.note = ''
      state.error = '你在手机上取消了这次登录。'
      return
    }
    if (result.status === SCAN_STATE.SCANNED) {
      state.phase = 'scan'
      state.note = '已扫码，请在手机上点「确认登录」'
    } else if (state.phase === 'scan') {
      // 微信偶尔在确认前后给 404，别把已经"扫了"的状态退回去。
    }

    if (session !== mine) return
    setTimeout(() => {
      tick(mine).catch((error) => log('扫码轮询异常：', error))
    }, RETRY_DELAY)
  }

  const start = async () => {
    reset('idle')
    const mine = session
    state.startedAt = Date.now()
    state.phase = 'wait'
    state.note = '正在申请二维码…'
    state.error = ''

    let scan
    try {
      scan = await startWechatScan(getConfig())
    } catch (error) {
      if (session !== mine) return view()
      state.phase = 'error'
      state.note = ''
      state.error = String((error && error.message) || error)
      return view()
    }
    if (session !== mine) return view()

    ticket = { state: scan.state, uuid: scan.uuid, cookies: scan.cookies }
    state.qrUrl = scan.qrUrl
    state.expiresAt = scan.expireAt
    state.note = '用微信扫一扫，扫码后按手机上的提示确认'

    const image = await fetchQrImage(scan.qrUrl)
    if (session !== mine) return view()
    state.qr = image

    log(`二维码已就绪（uuid=${scan.uuid}），300 秒内有效`)
    tick(mine).catch((error) => log('扫码轮询启动失败：', error))
    return view()
  }

  return {
    start,
    cancel: () => {
      reset('idle')
      return view()
    },
    view,
  }
}
