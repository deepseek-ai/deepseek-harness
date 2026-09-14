/** Hold the advanced workflow child's first step until its parent records membership. */
export const name = 'python-snapshot-workflow-order'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-local host context.
 * @param {{ parentSessionId: string, prompt: string }} config - Exact advanced scenario identities.
 */
export function apply(ctx, config) {
  const started = new Set()
  const pending = new Map()
  let disposed = false

  ctx.effect(() => async () => {
    disposed = true
    const waits = [...pending.values()]
    for (const wait of waits) wait.reject(new Error('workflow snapshot barrier disposed'))
    await Promise.allSettled(waits.map(wait => wait.done))
    started.clear()
  })
  ctx.on('session/event', (session, event) => {
    if (disposed || session.id !== config.parentSessionId || event.type !== 'tool-workflow/agent-start') return
    started.add(event.data.childId)
    pending.get(event.data.childId)?.resolve()
  })
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    if (agent.session.header.parentSession !== config.parentSessionId || turn !== 1 || step !== 1
      || !messages.some(message => message.content.some(block => block.type === 'text' && block.text === config.prompt))) {
      return next()
    }
    signal.throwIfAborted()
    if (disposed) throw new Error('workflow snapshot barrier disposed')
    if (!started.has(agent.id)) {
      const wait = Promise.withResolvers()
      const abort = () => { wait.reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      wait.done = wait.promise.finally(() => {
        signal.removeEventListener('abort', abort)
        pending.delete(agent.id)
      })
      pending.set(agent.id, wait)
      await wait.done
    }
    signal.throwIfAborted()
    if (disposed) throw new Error('workflow snapshot barrier disposed')
    return next()
  })
}
