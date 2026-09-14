/** Awaited creation context shared by TypeScript and Python SDK snapshots. */
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'

export const name = 'serial-created-fixture'
export const inject = ['agents']

/** Install ordered creation listeners whose context must precede the first turn. */
export function apply(ctx) {
  const ready = new WeakSet()
  ctx.on('agent/created', async ({ agent }) => {
    await setImmediate()
    agent.inject({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 'Serial agent creation completed.' }],
      source: { kind: 'plugin', plugin: name },
    })
    ready.add(agent)
  })
  ctx.on('agent/created', ({ agent }) => {
    if (!ready.has(agent)) throw new Error('creation listeners ran out of order')
  })
}
