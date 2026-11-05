/** Keep the recorded background-child notice after the parent's first turn. */
export const name = 'subagent-spawn-settlement-order'
export const inject = ['tools', 'agents']

/**
 * Hold the child's first step until the parent has recorded its initial turn end.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario host context.
 */
export function apply(ctx) {
  const parentFinished = Promise.withResolvers()
  void parentFinished.promise.catch(() => undefined)
  let parentId
  ctx.effect(() => () => parentFinished.reject(new Error('subagent settlement fixture disposed')))
  ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'subagent') parentId = exec.agent.id
    return next()
  })
  ctx.on('session/event', (session, event) => {
    if (session.id === parentId && event.type === 'turn/end' && event.data.turn === 1) {
      parentFinished.resolve()
    }
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    if (parentId === undefined || agent.session.header.parentSession !== parentId || turn !== 1 || step !== 1) return next()
    signal.throwIfAborted()
    const cancelled = Promise.withResolvers()
    const abort = () => cancelled.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([parentFinished.promise, cancelled.promise])
      signal.throwIfAborted()
      return await next()
    } finally {
      signal.removeEventListener('abort', abort)
    }
  })
}
