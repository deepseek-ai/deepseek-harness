/** Test-only app booting the legacy plugin through a real Cordis Loader file. */
import { boot } from '@deepseek-ai/dsh-app-boot'
import type {} from './legacy-plugin.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('projection compatibility fixture requires a config path')

const ctx = await boot('projection-compatibility', configPath)
const warnings: string[] = []
ctx.logger.exporter({
  levels: { default: 2 },
  export: ({ type, args }) => { if (type === 'warn') warnings.push(String(args[0])) },
})
try {
  const session = ctx.sessions.create()
  const legacy = ctx.get('legacyProjectionFixture')
  if (legacy === undefined) throw new Error('legacy projection fixture did not activate')
  session.append('turn/start', { turn: 1 })
  const first = legacy.read(session)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const second = legacy.read(session)
  const values = ctx.sessionProjections.snapshot(session).values
  await legacy.release()
  await legacy.release()
  const released = legacy.read(session) ?? null
  console.log(JSON.stringify({ first, second, values, released, warnings }))
} finally {
  await ctx.fiber.dispose()
}
