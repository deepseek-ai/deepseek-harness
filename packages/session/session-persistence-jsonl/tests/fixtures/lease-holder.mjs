/**
 * Two-process lock e2e holder: creates one session over the given root,
 * materializes two events, prints `holding`, and keeps its kernel write lock
 * until the parent SIGKILLs this process (a crash: release never runs).
 * Runs the built package under plain Node.
 */

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, sessionId] = process.argv.slice(2)
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
const handle = await ctx.sessionPersistence.create({
  version: SESSION_FORMAT_VERSION,
  id: sessionId,
  createdAt: 1000,
  cwd: '/work',
  isSeeded: false,
})
await handle.append([
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
])
process.stdout.write('holding\n')
// Keep the descriptor (and with it the kernel lock) until killed; never close.
setInterval(() => {}, 1000)
