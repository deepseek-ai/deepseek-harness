/** Awaited creation context shared by TypeScript and Python SDK snapshots. */
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'

export const name = 'serial-created-fixture'
export const inject = ['agents', 'sessions']

/** Install ordered creation listeners whose context must precede the first turn. */
export function apply(ctx, config = {}) {
  const checkedCancellation = new WeakSet()
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    if (checkedCancellation.has(agent)
      || (!config.checkRootCancellation && agent.session.header.origin !== 'subagent')) return next()
    checkedCancellation.add(agent)
    const pending = {
      id: randomUUID(), role: 'user',
      content: [{ type: 'text', text: 'Cancellation checkpoint probe.' }],
      source: { kind: `plugin:${name}` },
    }
    agent.inject(pending)
    const failure = new Error('fixture queue-clear refusal')
    const stopRejecting = ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const [session, event] = args
      if (session === agent.session && event.type === 'agent/inbox/spliced'
        && event.data.outcome === 'canceled' && (event.data.removedCount ?? 0) > 0) throw failure
    })
    let rejected = false
    try {
      try {
        agent.cancel({ kind: 'user' })
      } catch (error) {
        if (error !== failure) throw error
        rejected = true
      }
    } finally {
      stopRejecting()
    }
    if (!rejected || !signal.aborted) throw new Error('expected queue-clear rejection and activity cancellation')
    agent.inbox.remove(pending.id)
    for (const message of messages) {
      const ordinary = message.source.kind === 'user'
      agent.send(message, ordinary ? 'next-turn' : 'next-step', ordinary)
    }
    return next()
  })
  const ready = new WeakSet()
  ctx.on('agent/created', async ({ agent }) => {
    await setImmediate()
    let forkSummary = ''
    if (agent.session.header.origin !== 'subagent') {
      const fork = ctx.sessions.fork(agent.session)
      const nested = ctx.sessions.fork(fork)
      for (const independent of [fork, nested]) {
        if (independent.header.parentSession !== undefined || independent.header.origin !== undefined
          || !independent.header.isSeeded) throw new Error('ordinary fork retained a creator relationship')
      }
      ctx.sessions.create(undefined, {
        seed: agent.session.snapshotEvents(), inheritedEventCount: agent.session.seq,
        meta: { parentSession: agent.id, isSeeded: true },
      })
      forkSummary = ' Ordinary and nested forks are independent; historical fork metadata remains readable.'
    }
    agent.inject({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 'Serial agent creation completed.' + forkSummary }],
      source: { kind: `plugin:${name}` },
    })
    ready.add(agent)
  })
  ctx.on('agent/created', ({ agent }) => {
    if (!ready.has(agent)) throw new Error('creation listeners ran out of order')
  })
}
