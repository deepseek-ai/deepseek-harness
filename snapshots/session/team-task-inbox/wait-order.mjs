/** Order task commits around real waits without adding inbox input. */
export const name = 'team-task-wait-order'
export const inject = ['tools', 'subagents', 'sessionPersistence']

/**
 * Keep past commits before the first wait and completion inside the second wait.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario host context.
 */
export function apply(ctx) {
  const claimed = Promise.withResolvers()
  const waiting = Promise.withResolvers()
  const read = Promise.withResolvers()
  const gates = [claimed, waiting, read]
  for (const gate of gates) void gate.promise.catch(() => undefined)
  ctx.effect(() => () => {
    for (const gate of gates) gate.reject(new Error('task-wait scenario disposed'))
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

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.callId === 'complete-task') await wait(waiting, exec.signal)
    if (exec.name === 'wait_agent' && exec.agent.inbox.nextStep.length !== 0) {
      throw new Error('task-wait scenario requires an empty inbox before waiting')
    }
    const pending = next()
    if (exec.callId === 'wait-current-change') waiting.resolve()
    const result = await pending
    if (exec.callId === 'claim-task') claimed.resolve()
    if (exec.callId === 'run-worker') await wait(claimed, exec.signal)
    if (exec.name === 'wait_agent') {
      if (exec.agent.inbox.nextStep.length !== 0) throw new Error('task change inserted inbox input')
      const stored = await ctx.sessionPersistence.open(exec.agent.id, 'read')
      try {
        const tasks = (await stored.read()).events.filter(event => event.type === 'team/task')
        const expected = exec.callId === 'wait-current-change' ? 3 : 2
        if (tasks.at(-1)?.data.task.revision !== expected) {
          throw new Error(`wait returned before task revision ${expected} was persisted`)
        }
      } finally {
        await stored.close()
      }
    }
    if (exec.callId === 'read-board') {
      read.resolve()
      await ctx.subagents.waitForTreeWork(exec.agent)
    }
    return result
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    if (agent.session.header.origin === 'subagent' && turn === 1 && step === 4) await wait(read, signal)
    return next()
  })
}
