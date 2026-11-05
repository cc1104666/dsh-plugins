/**
 * OpenAI 请求 → ima QA 请求的翻译层，以及 ima SSE → 增量回调的归一层。
 *
 * 两个关键设计：
 *
 * 1. **无状态**。ima 的多轮上下文存在服务端 session 里，而 DSH 每次发来的是
 *    完整 messages。为了不做会话映射（用户在网页上删会话、插件重启都会断），
 *    每次请求都：init_session（新会话）→ ask → 流结束 → del_session。
 *    历史由调用方拍平进 question 文本（下面 buildQuestion）。
 *
 * 2. **MESSAGE.Text 增量/快照自适应**。官方前端把每个 MESSAGE 事件 push 进
 *    渲染队列，看不出 Text 是增量还是全量快照 —— 所以这里做 diff：
 *    新文本以旧文本为前缀 → 快照模式（发 diff）；否则 → 增量模式（原样发）。
 *    THINKING 同样处理。
 */
import { randomUUID } from 'node:crypto'
import {
  initSession,
  delSession,
  qaStream,
  ROBOT_MAIN,
  QUESTION_INPUT,
} from './ima.js'

/** 历史拍平进 question 时每轮的标头。 */
const ROLE_LABEL = {
  system: '系统设定',
  user: '用户',
  assistant: '助手',
}

/** 把 OpenAI messages 拍成一段 question 文本。单轮就是原文，多轮加角色标头。 */
export function buildQuestion(messages) {
  const list = (messages || []).filter((item) => item && typeof item.content === 'string' && item.content !== '')
  if (list.length === 0) return ''
  if (list.length === 1) return list[0].content

  const lines = []
  for (const item of list) {
    const label = ROLE_LABEL[item.role] || item.role || '?'
    lines.push(`【${label}】`)
    lines.push(item.content)
    lines.push('')
  }
  return lines.join('\n').trim()
}

/** 组 QA 请求体（ima.js 里再做 snake_case）。enableEnhancement 默认关 —— 开着会全网搜索并往正文里插 [N](@ref) 引用。 */
export function buildQaPayload({ sessionId, question, model, clientId, enableEnhancement = false }) {
  return {
    sessionId: sessionId || '',
    robotType: ROBOT_MAIN,
    question,
    questionType: QUESTION_INPUT,
    clientId: clientId || randomUUID(),
    modelInfo: {
      modelId: model ? model.id : '',
      modelType: model ? model.modelType : 0,
      enableEnhancement,
      robotType: ROBOT_MAIN,
    },
  }
}

/** 从上游事件里抠出中文可读的失败原因。 */
export function explainEventError(item) {
  const data = item && item.data
  if (!data || typeof data !== 'object') return ''
  const code = data.Code !== undefined ? data.Code : data.code
  const msg = data.Msg || data.msg || data.Tips || ''
  if (code === 0 || (code === undefined && !msg)) return ''
  return `Code ${code}${msg ? `：${msg}` : ''}`
}

/**
 * 跑一轮完整对话（init → ask → del）。
 *
 * deps:
 *   getConfig()  运行期配置
 *   getAuth()    当前登录态（token 等）
 *   getDevice()  设备信息 {guid, q36}
 *   onDelta(text)         正文增量
 *   onReasoning(text)     思考增量
 *   onProgress(text)      阶段提示（深度搜索之类）
 *   signal                AbortSignal
 *
 * 返回 { ok, text, reasoning, error, code, finishReason, elapsed }
 */
export async function chatOnce(deps, { messages, model, sessionId = '', keepSession = false }) {
  const startedAt = Date.now()
  const question = buildQuestion(messages)
  if (question === '') {
    return { ok: false, code: 'empty', error: '没有可发送的内容' }
  }

  let session = sessionId
  let createdHere = false
  if (!session) {
    try {
      session = await initSession(deps.getConfig(), deps.getAuth(), deps.getDevice())
      createdHere = true
    } catch (error) {
      return { ok: false, code: 'init', error: String((error && error.message) || error) }
    }
  }

  const cfg = deps.getConfig()
  const payload = buildQaPayload({
    sessionId: session,
    question,
    model,
    enableEnhancement: cfg.enableEnhancement === true,
  })
  let text = ''
  let reasoning = ''
  let completed = null
  let streamError = ''

  /**
   * MESSAGE.Text 是增量还是全量快照，前端产物里看不出区别，两种实现都合理 —— 所以做自适应：
   *
   *   - 新文本以「到目前为止的全部文本」为前缀 → 快照模式，发 diff；
   *   - 不是前缀 → 增量模式，原样发，累计值跟着加长；
   *   - 快照模式下突然来了个不是前缀的 → 退回增量模式。
   *
   * 这个状态机是自纠错的：就算第一次判断错了，最终累计文本也和上游一致，
   * 最多中间有一两个 chunk 的切分方式不同。
   */
  const makeDiffer = (emit) => {
    let acc = ''
    let mode = null
    return (incoming) => {
      if (incoming === '' || incoming === undefined || incoming === null) return
      if (mode === null) {
        mode = 'delta'
        acc = incoming
        emit(incoming)
        return
      }
      if (incoming.startsWith(acc) && incoming.length > acc.length) {
        // 更像「全量快照」：整个替换，只发多出来的部分
        mode = 'snapshot'
        const delta = incoming.slice(acc.length)
        acc = incoming
        if (delta) emit(delta)
        return
      }
      if (mode === 'snapshot' && acc.startsWith(incoming)) {
        return // 比已有的还旧（重放），跳过
      }
      mode = 'delta'
      acc += incoming
      emit(incoming)
    }
  }

  const emitText = makeDiffer((delta) => {
    text += delta
    if (deps.onDelta) deps.onDelta(delta)
  })
  const emitReasoning = makeDiffer((delta) => {
    reasoning += delta
    if (deps.onReasoning) deps.onReasoning(delta)
  })

  const result = await qaStream(deps.getConfig(), deps.getAuth(), deps.getDevice(), payload, {
    signal: deps.signal,
    onEvent: (item) => {
      const data = item.data
      if (item.event === 'MESSAGE') {
        if (data && typeof data === 'object' && typeof data.Text === 'string') {
          emitText(data.Text)
        } else if (typeof data === 'string' && data !== '') {
          emitText(data)
        }
      } else if (item.event === 'THINKING') {
        // 实测形状：{Message: 增量, Status: 1=思考中/2=结束, Tips: 阶段提示}
        let piece = ''
        if (typeof data === 'string') piece = data
        else if (data && typeof data === 'object') {
          piece = String(data.Message ?? data.Text ?? data.text ?? '')
        }
        if (piece) emitReasoning(piece)
      } else if (item.event === 'PROGRESSING') {
        let tip = ''
        if (data && typeof data === 'object') tip = String(data.processingTips || data.Tips || data.stage || '')
        else if (typeof data === 'string') tip = data
        if (tip && deps.onProgress) deps.onProgress(tip)
      } else if (item.event === 'COMPLETED') {
        completed = data
        const why = explainEventError(item)
        if (why) streamError = why
      }
    },
  })

  if (createdHere && !keepSession) {
    delSession(deps.getConfig(), deps.getAuth(), deps.getDevice(), session).catch(() => {})
  }

  if (!result.ok) {
    const hint =
      result.status === 401
        ? '登录态失效（401），回面板重新扫码'
        : result.status === 429
          ? '触发限流（429），稍后再试'
          : `HTTP ${result.status}${result.funcRet ? `（Trpc-Func-Ret ${result.funcRet}）` : ''}`
    return {
      ok: false,
      code: `http_${result.status}`,
      error: `${hint}${result.errorText ? `：${result.errorText.slice(0, 120)}` : ''}`,
      text,
      reasoning,
      elapsed: Date.now() - startedAt,
    }
  }

  if (streamError) {
    return { ok: false, code: 'completed_error', error: streamError, text, reasoning, elapsed: Date.now() - startedAt }
  }

  const finishReason = completed && typeof completed === 'object' && completed.Code === 0 ? 'stop' : 'stop'
  return {
    ok: true,
    text,
    reasoning,
    finishReason,
    elapsed: Date.now() - startedAt,
  }
}
