/** The Host entry declares the browser preview limits as synced Config and serves nothing itself. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import * as host from '../src/index.ts'
import { EXCEL_DEFAULTS, OFFICE_DEFAULTS } from '../src/defaults.ts'

it('resolves each limit object to the shared defaults and rejects out-of-range limits', () => {
  const config = host.Config({})
  expect(config.office.get()).toEqual(OFFICE_DEFAULTS)
  expect(config.excel.get()).toEqual(EXCEL_DEFAULTS)
  expect(OFFICE_DEFAULTS).toEqual({ maxCachedEntries: 8, maxCachedBytes: 64 * 1024 * 1024, maxPending: 8, maxReaders: 32 })
  expect(EXCEL_DEFAULTS).toEqual({ maxBytes: 16 * 1024 * 1024, maxCells: 250_000, timeoutMs: 15_000 })
  expect(host.Config({ office: { maxCachedEntries: 2 } }).office.get()).toEqual({ ...OFFICE_DEFAULTS, maxCachedEntries: 2 })
  for (const key of ['maxCachedEntries', 'maxCachedBytes', 'maxPending', 'maxReaders']) expect(() => host.Config({ office: { [key]: 0 } })).toThrow()
  for (const key of ['maxBytes', 'maxCells', 'timeoutMs']) expect(() => host.Config({ excel: { [key]: 0 } })).toThrow()
  expect(() => host.Config({ excel: { timeoutMs: 2_147_483_648 } })).toThrow()
})

it('activates without Host behavior', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const fiber = ctx.plugin(host, {})
  await fiber.await()
  await fiber.dispose()
})
