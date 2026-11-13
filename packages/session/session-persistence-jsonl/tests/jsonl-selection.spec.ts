/** Shipped JSONL selection for hosts without node:sqlite. @module */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SqliteLogs } from '@deepseek-ai/dsh-session-persistence-sqlite/src/sqlite.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import * as persistence from '../src/index.ts'

it('stores and reads Sessions through JSONL without initializing SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-selection-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) }
  })
  const start = vi.spyOn(SqliteLogs.prototype, 'start').mockRejectedValue(new Error('SQLite unavailable'))
  await ctx.plugin(persistence, { root, storage: 'jsonl', compression: 'none' })
  expect(await ctx.sessionPersistence.list()).toEqual([])
  const header = meta('jsonl-selected')
  await using writer = await ctx.sessionPersistence.create(header)
  await writer.append(oneTurnLog())
  await writer.flush()
  await using reader = await ctx.sessionPersistence.open(header.id, 'read')
  expect((await reader.read()).events).toEqual(oneTurnLog())
  expect((await readdir(root, { recursive: true })).some(path => path.endsWith('.jsonl'))).toBe(true)
  expect(start).not.toHaveBeenCalled()
})
