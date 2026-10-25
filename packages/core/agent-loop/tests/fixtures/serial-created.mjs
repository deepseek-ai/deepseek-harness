/** Awaited creation context shared by TypeScript and Python SDK snapshots. */
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'

export const name = 'serial-created-fixture'
export const inject = ['agents', 'sessions']

/** Install ordered creation listeners whose context must precede the first turn. */
export function apply(ctx) {
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
