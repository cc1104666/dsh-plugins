/**
 * 微信扫码登录 ima —— 全程在宿主端跑，不弹浏览器、不用复制 cookie。
 *
 * 链路（与官方登录页 iframe 一致，全部免预鉴权）：
 *   1. GET open.weixin.qq.com/connect/qrconnect?appid=..&scope=snsapi_login&login_type=jssdk
 *      → 页面里带 connect/qrcode/<uuid>
 *   2. 二维码图片 = https://open.weixin.qq.com/connect/qrcode/<uuid>
 *   3. 长轮询 lp.open.weixin.qq.com/connect/l/qrconnect?uuid=…
 *      → wx_errcode=408 超时（继续轮）/ 405 已扫待确认 / 403 取消 / 0 成功带 wx_code
 *   4. POST {siteBase}/cgi-bin/login {account_type:2, code, auth_appid, client_info}
 *      → token / refreshToken / userId（存 auth.json）
 *
 * 与 lightvela 的差异：ima 不需要回调页 —— 拿到 wx_code 直接打自己的 /cgi-bin/login。
 */
import { startWechatScan, pollWechatScan, loginWithWxCode, fetchQrImage, SCAN_STATE } from './ima.js'

/** 微信单轮长轮询约 25 秒；收到超时就立刻接下一轮，中间不额外等待。 */
const RETRY_DELAY = 400

export function createWechatLogin({ getConfig, getDevice, log, onAuthed }) {
  /**
   * phase:
   *   idle   没开始
   *   wait   二维码已就绪，等扫码
   *   scan   扫了，等手机上点确认
   *   done   拿到登录态且校验通过，凭据已落盘
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
    ticket = null
  }

  /** 拿到 code 之后：换登录态 → 落盘。 */
  const accept = async (code, mine) => {
    const cfg = getConfig()
    state.note = '扫码成功，正在换取 ima 登录态…'
    if (session !== mine) return

    let account
    try {
      account = await loginWithWxCode(cfg, code, getDevice())
    } catch (error) {
      if (session !== mine) return
      state.phase = 'error'
      state.note = ''
      state.error = String((error && error.message) || error)
      return
    }
    if (session !== mine) return

    const saved = onAuthed({ ...account, source: 'wechat-qr' })
    state.phase = 'done'
    state.note = '登录成功'
    state.error = ''
    state.account = saved || account
    stopPolling()
    session += 1
    log(`扫码登录成功：${account.nickName || account.userId || '未知账号'}`)
  }

  /** 一轮长轮询。超时是正常的"没人扫"，不是错误。 */
  const tick = async (mine) => {
    if (session !== mine) return
    if (state.expiresAt && Date.now() > state.expiresAt) {
      state.phase = 'error'
      state.note = ''
      state.error = '二维码已过期（5 分钟），点「重新生成」再来一次。'
      return
    }

    controller = new AbortController()
    let result
    try {
      result = await pollWechatScan(getConfig(), ticket.uuid, controller.signal)
    } catch (error) {
      if (session !== mine) return
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

    ticket = { uuid: scan.uuid, state: scan.state }
    state.qrUrl = scan.qrUrl
    state.expiresAt = scan.expireAt
    state.note = '用微信扫一扫，扫码后按手机上的提示确认'

    const image = await fetchQrImage(getConfig(), scan.qrUrl)
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
