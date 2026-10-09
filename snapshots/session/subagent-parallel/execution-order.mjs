/** Keep two child activations resident while ordering their accepted ids and terminal notices. */
export const name = 'subagent-parallel-order'
export const inject = ['tools', 'agents', 'subagents']

/**
 * Install task-local barriers over real tool, Agent, and subagent lifecycle events.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario host context.
 */
export function apply(ctx) {
  const firstRecorded = Promise.withResolvers()
  const bothAccepted = Promise.withResolvers()
  const firstSettled = Promise.withResolvers()
  const children = []
  let parentId
  let overlapping = false
  const gates = [firstRecorded, bothAccepted, firstSettled]
  for (const gate of gates) void gate.promise.catch(() => undefined)
  ctx.effect(() => () => {
    for (const gate of gates) gate.reject(new Error('parallel subagent fixture disposed'))
  })

  const wait = async (gate, signal) => {
    signal.throwIfAborted()
    const cancelled = Promise.withResolvers()
    const abort = () => cancelled.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([gate.promise, cancelled.promise])
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (session.id !== parentId) return
    if (event.type === 'tool/result' && event.data.message.source.callId === 'call_parallel_alpha_1') {
      firstRecorded.resolve()
    }
    if (event.type !== 'subagent/catalog') return
    children.push(event.data.childId)
    if (children.length === 2) {
      overlapping = children.every(id => ctx.agents.get(id) !== undefined)
      bothAccepted.resolve()
    }
  })
  ctx.on('subagent/end', (info) => {
    if (info.id === children[0]) firstSettled.resolve()
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'subagent') return next()
    parentId = exec.agent.id
    const second = exec.callId === 'call_parallel_alpha_2'
    if (second) await wait(firstRecorded, exec.signal)
    const result = await next()
    if (second) {
      if (!overlapping) throw new Error('parallel fixture requires two simultaneous resident children')
      await ctx.subagents.waitForChildren(exec.agent)
    }
    return result
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    if (parentId === undefined || agent.session.header.parentSession !== parentId || turn !== 1 || step !== 1) return next()
    await wait(bothAccepted, signal)
    if (!overlapping) throw new Error('parallel fixture released before both children became resident')
    if (agent.id === children[1]) await wait(firstSettled, signal)
    return next()
  })
}
