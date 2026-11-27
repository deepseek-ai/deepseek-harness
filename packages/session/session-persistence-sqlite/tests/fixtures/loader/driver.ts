#!/usr/bin/env node
/** Test driver that sends one turn through the Headless Loader composition with the SQLite provider. */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

function hasCompactStorage(value: object): value is { compactStorage(): Promise<unknown> } {
  return 'compactStorage' in value && typeof value.compactStorage === 'function'
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('event-rows driver requires a config path')

const boot = () => bootProductionProfile({
  binName: 'sqlite-event-rows-e2e',
  profile: 'headless',
  overlayPaths: [resolveConfigPath(configPath, undefined)],
})
const ctx = await boot()
const cold = process.env.DSH_TEST_COLD === '1'
let sessionId: string
let expected: unknown
try {
  ;({ sessionId } = await runFixtureTurn(ctx, { task: 'run the shell tool once' }))
  if (cold) {
    const persistence = ctx.get('sessionPersistence')
    assert(persistence)
    const reader = await persistence.open(SessionId(sessionId), 'read')
    try { expected = (await reader.read()).events } finally { await reader.close() }
  }
} finally {
  await ctx.fiber.dispose()
}

if (cold) {
  const clock = Date.now
  Date.now = () => clock() + 31 * 86_400_000
  try {
    const restarted = await boot()
    try {
      const persistence = restarted.get('sessionPersistence')
      assert(persistence)
      assert(await persistence.stat(SessionId(sessionId)))
      using db = new DatabaseSync('.sessions/.segments/sessions.sqlite', { readOnly: true })
      const archived = db.prepare('SELECT count(*) AS count FROM cold_segments')
      for (let attempt = 0; attempt < 100 && archived.get()?.count === 0; attempt++) await setTimeout(50)
      assert.equal(archived.get()?.count, 1)
      assert.equal(db.prepare('SELECT count(*) AS count FROM session_tools WHERE session_id = ?').get(sessionId)?.count, 1)
      assert(hasCompactStorage(persistence))
      const compacted = z.object({
        beforeBytes: z.number(),
        afterBytes: z.number(),
        checkpointPending: z.boolean(),
      }).parse(await persistence.compactStorage())
      assert.equal(compacted.checkpointPending, false)
      assert.equal(archived.get()?.count, 1)
      const reader = await persistence.open(SessionId(sessionId), 'read')
      try { assert.deepEqual((await reader.read()).events, expected) } finally { await reader.close() }
      assert.equal(archived.get()?.count, 0)
    } finally { await restarted.fiber.dispose() }
  } finally { Date.now = clock }
}
