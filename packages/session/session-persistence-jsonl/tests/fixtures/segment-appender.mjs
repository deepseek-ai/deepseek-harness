/**
 * Segment contention e2e writer: creates one SQLite-backed Session over the given root, prints
 * `ready`, waits for one line on stdin, then commits the requested number of single-event
 * appends, closes, and exits. Runs the built package under plain Node.
 */

import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, sessionId, countText] = process.argv.slice(2)
const count = Number(countText)
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root, storage: 'sqlite', compression: 'none' })
const handle = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1000, isSeeded: false })
process.stdout.write('ready\n')
await once(process.stdin, 'data')
for (let seq = 0; seq < count; seq++) {
  const event = seq % 2 === 0
    ? { type: 'turn/start', seq, time: seq, data: { turn: seq / 2 + 1 } }
    : { type: 'turn/end', seq, time: seq, data: { turn: (seq + 1) / 2, reason: { kind: 'completed' } } }
  await handle.append([event])
}
await handle.close()
await ctx.fiber.dispose()
process.stdout.write('done\n')
