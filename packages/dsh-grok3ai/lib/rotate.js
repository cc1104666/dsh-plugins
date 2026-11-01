/**
 * 轮换：一次对话依次试多个「入口」，直到有一发成功。
 *
 * 一个入口 = 一个 Space + 一条出口（出口可以是直连）。
 * 换出口和换 Space 是两件事：
 *   - 换出口：同一个 Space 换个 IP 重来（HF 匿名限流是按 IP 记的）；
 *   - 换 Space：等于换模型，**不在这一层做** —— 用户选了 MiniMax，就不该在背后
 *     悄悄用 Llama 答，那会变成"回答和模型名对不上"。
 *
 * 三条硬规矩（和 dsh-grok-online 一致，都是踩过的坑）：
 *   1. 已经吐字就不换，否则会拼出两段半截回答；
 *   2. 只对"换一下可能有用"的失败换：busy / network / rate / timeout；
 *      space_error（Space 自己后端的锅）和 http 4xx 换多少出口都一样；
 *   3. 有预算上限，防止代理池写错时一发请求打十几个连接。
 */
import { runSpace } from './gradio.js'
import { makeFetcher } from './proxy-agent.js'

export const DIRECT_ROUTE = { id: 'direct', label: '直连', proxy: null, mode: 'sticky' }

const ROTATE_CODES = new Set(['busy', 'network', 'rate', 'timeout', 'empty'])

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function publicRoute(route) {
  return route
    ? { id: route.id, label: route.label, mode: route.mode, space: route.space ? route.space.id : '', proxied: Boolean(route.proxy) }
    : { id: 'direct', label: '直连', mode: 'sticky', space: '', proxied: false }
}

/**
 * @param {object} config   store.config()
 * @param {{prompt:string, opts:object}} request
 * @param {object} hooks    {signal, onDelta(delta), onEvent?, timeout}
 * @param {object} plan     {routes, onResult, maxAttempts, rerollSticky, rerollRotating, transportOptions, makeFetch}
 */
export async function runWithRotation(config, request, hooks = {}, plan = {}) {
  const routes = Array.isArray(plan.routes) && plan.routes.length > 0 ? plan.routes : [DIRECT_ROUTE]
  const onResult = typeof plan.onResult === 'function' ? plan.onResult : () => {}
  const rerollSticky = clampInt(plan.rerollSticky, 0, 3, 0)
  const rerollRotating = clampInt(plan.rerollRotating, 0, 3, 2)
  const transportOptions = plan.transportOptions || {}
  const timeout = Number(plan.timeout) > 0 ? Number(plan.timeout) : 180000
  const makeRouteFetch =
    typeof plan.makeFetch === 'function'
      ? plan.makeFetch
      : (route, options) => (route.proxy ? makeFetcher(route.proxy, options) : undefined)

  let budget = clampInt(plan.maxAttempts, 1, 24, 6)
  let tried = 0
  let last = null

  for (const route of routes) {
    if (!route || !route.space) continue
    const reroll = route.mode === 'rotating' ? rerollRotating : rerollSticky
    let fetcher
    let ready = false
    for (let round = 0; round <= reroll; round += 1) {
      if (budget <= 0) break
      budget -= 1
      tried += 1
      if (!ready) {
        fetcher = makeRouteFetch(route, transportOptions)
        ready = true
      }

      let emitted = false
      const forwarded = {
        signal: hooks.signal,
        timeout,
        onEvent: hooks.onEvent,
        onDelta: (delta, full) => {
          emitted = true
          if (hooks.onDelta) hooks.onDelta(delta, full)
        },
      }

      const result = await runSpace(route.space, request.prompt, request.opts, forwarded, fetcher || fetch)
      last = result
      onResult(route, result, { attempt: tried, round, emitted })

      if (result.ok) {
        return { ...result, route: publicRoute(route), switches: tried - 1, attempts: tried }
      }
      if (hooks.signal && hooks.signal.aborted) {
        return { ...result, route: publicRoute(route), switches: tried - 1, attempts: tried, aborted: true }
      }
      if (emitted) {
        return { ...result, route: publicRoute(route), switches: tried - 1, attempts: tried, partial: true }
      }
      if (!ROTATE_CODES.has(String(result.code || ''))) {
        return { ...result, route: publicRoute(route), switches: tried - 1, attempts: tried }
      }
    }
  }

  return {
    ...(last || { ok: false, code: 'no_route', status: 0, message: '没有可用的入口' }),
    switches: Math.max(0, tried - 1),
    attempts: tried,
    exhausted: true,
  }
}
