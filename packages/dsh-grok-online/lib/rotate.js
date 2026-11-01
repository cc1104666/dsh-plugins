/**
 * 轮换：一次对话依次试多个出口，直到有一发成功。
 *
 * 为什么放在这一层而不是 relay 里：
 *   relay 只懂 OpenAI 协议，不该关心"从哪个 IP 出去"；upstream 只懂怎么跟
 *   grok.online 说话，也不该关心轮换。夹在中间的这一层拿到的输入是
 *   「按优先级排好的出口列表」，输出是「哪一发成功了」。
 *
 * 三条硬规矩（都是踩过的坑，不许省）：
 *   1. 只在**还没吐出任何字**的时候换出口。已经开始流了再换，用户会看到两段
 *      拼在一起的半截回答 —— 宁可报错。
 *   2. 只对跟 IP 有关的失败换出口：limit（这个 IP 用完了）、network、rate。
 *      model_locked / too_long 换多少 IP 都一样，换了就是白烧额度。
 *   3. 有预算上限（默认 10 次）。代理池写错 50 行时不至于一发请求打 50 个 429。
 */
import { chatWithBonus } from './upstream.js'
import { makeFetcher } from './proxy-agent.js'

/** 直连也算一个出口，方便"池子全挂了还能退回来"。 */
export const DIRECT_ROUTE = { id: 'direct', label: '直连', proxy: null, mode: 'sticky' }

/** 只有这几个 code 换出口有意义。 */
const ROTATE_CODES = new Set(['limit', 'network', 'rate'])

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function publicRoute(route) {
  return route
    ? { id: route.id, label: route.label, mode: route.mode, proxied: Boolean(route.proxy) }
    : { id: 'direct', label: '直连', mode: 'sticky', proxied: false }
}

/**
 * @param {object} config             store.config()
 * @param {object} payload            buildGrokPayload 的结果
 * @param {object} hooks              {signal, onDelta, onReasoning, onCredits, onBonus, noBonus}
 * @param {object} plan               {routes, onResult, makeFetch, maxAttempts, rerollSticky, rerollRotating, transportOptions}
 */
export async function chatWithRotation(config, payload, hooks = {}, plan = {}) {
  const routes = Array.isArray(plan.routes) && plan.routes.length > 0 ? plan.routes : [DIRECT_ROUTE]
  const onResult = typeof plan.onResult === 'function' ? plan.onResult : () => {}
  const rerollSticky = clampInt(plan.rerollSticky, 0, 3, 0)
  const rerollRotating = clampInt(plan.rerollRotating, 0, 3, 1)
  const transportOptions = plan.transportOptions || {}
  // 默认就是"有代理就开隧道，没代理走全局 fetch"；测试可以塞一个假的进来
  const makeRouteFetch =
    typeof plan.makeFetch === 'function'
      ? plan.makeFetch
      : (route, options) => (route.proxy ? makeFetcher(route.proxy, options) : undefined)
  let budget = clampInt(plan.maxAttempts, 1, 32, 10)
  let tried = 0
  let last = null

  for (const route of routes) {
    // 动态代理背后是一池 IP：同一个地址重开一次连接就是新出口，所以给它多一轮。
    const reroll = route.mode === 'rotating' ? rerollRotating : rerollSticky
    let fetcher
    let fetcherReady = false
    for (let round = 0; round <= reroll; round += 1) {
      if (budget <= 0) break
      budget -= 1
      tried += 1
      if (!fetcherReady) {
        fetcher = makeRouteFetch(route, transportOptions)
        fetcherReady = true
      }

      let emitted = false
      const forwarded = {
        ...hooks,
        onDelta: (delta, full) => {
          emitted = true
          if (hooks.onDelta) hooks.onDelta(delta, full)
        },
        onReasoning: (delta) => {
          emitted = true
          if (hooks.onReasoning) hooks.onReasoning(delta)
        },
        onCredits: (credits, bonus) => {
          if (hooks.onCredits) hooks.onCredits(credits, bonus, route)
        },
      }

      const result = await chatWithBonus(config, payload, forwarded, fetcher)
      last = result
      onResult(route, result, { attempt: tried, round, emitted })

      if (result.ok) {
        return { ...result, route: publicRoute(route), switches: tried - 1, attempts: tried }
      }
      if (result.aborted) {
        return { ...result, route: publicRoute(route), switches: tried - 1, attempts: tried }
      }
      if (emitted) {
        // 已经吐字了：换出口会拼出两段半截回答，直接把残局交给上层
        return { ...result, route: publicRoute(route), switches: tried - 1, attempts: tried, partial: true }
      }
      if (!ROTATE_CODES.has(String(result.code || ''))) {
        return { ...result, route: publicRoute(route), switches: tried - 1, attempts: tried }
      }
      // 换下一个出口（或对动态代理重开一次连接）
    }
  }

  return {
    ...(last || { ok: false, code: 'no_route', status: 0, message: '没有可用的出口' }),
    switches: Math.max(0, tried - 1),
    attempts: tried,
    exhausted: true,
  }
}
