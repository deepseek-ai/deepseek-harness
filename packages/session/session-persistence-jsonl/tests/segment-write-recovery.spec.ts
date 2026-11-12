/** First-write lease failures and cancellation through published Session events. @module */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { SessionWriteLease } from '../src/lease.ts'
import { sessionDir } from '../src/format.ts'

async function fixture(_sqlite: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-write-recovery-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(plugin, { root, compression: 'none' })
  return { ctx, root }
}

it.each([false, true])('retains a published event when its first lease fails, SQLite=%s', async (sqlite) => {
  const { ctx } = await fixture(sqlite)
  const reported = Promise.withResolvers<undefined>()
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => { reported.resolve(undefined) })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => { reported.resolve(undefined) })
  const acquire = vi.spyOn(SessionWriteLease, 'acquire')
    .mockRejectedValueOnce(Object.assign(new Error('lease temporarily unavailable'), { code: 'EACCES' }))
  onTestFinished(() => { acquire.mockRestore(); error.mockRestore(); warn.mockRestore() })
  const session = ctx.sessions.create(SessionId('lease-retry'))
  const writer = await ctx.sessionPersistence.create(session.header)
  session.append('turn/start', { turn: 1 })
  await reported.promise
  expect(acquire).toHaveBeenCalledOnce()
  await expect(ctx.sessions.flush(session)).resolves.toBe(true)
  await writer.close()
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  try { expect((await reader.read()).events.map(event => event.seq)).toEqual([0]) }
  finally { await reader.close() }
})

it.each([false, true])('does not acquire a first lease for a pre-cancelled flush, SQLite=%s', async (sqlite) => {
  const { ctx, root } = await fixture(sqlite)
  const session = ctx.sessions.create(SessionId('cancelled-flush'))
  const writer = await ctx.sessionPersistence.create(session.header)
  const controller = new AbortController(), reason = new Error('cancel before checkpoint')
  controller.abort(reason)
  const acquire = vi.spyOn(SessionWriteLease, 'acquire')
  try {
    await expect(writer.flush({ signal: controller.signal })).rejects.toBe(reason)
    expect(acquire).not.toHaveBeenCalled()
    await expect(stat(sessionDir(root, undefined, session.id))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { acquire.mockRestore(); await writer.close() }
})
