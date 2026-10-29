import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { expect, it } from 'vitest'
import { Config, apply } from '../src/index.ts'

/** The Peer an index render speaks for; this listener reads no field of it. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

it('validates positive sequence timing and publishes it through the product page injection', async () => {
  expect(Config({}).stopSequenceMs).toBe(500)
  expect(Config({ stopSequenceMs: 2_147_483_646 }).stopSequenceMs).toBe(2_147_483_646)
  for (const stopSequenceMs of [0, -1, 1.5, 2_147_483_647, Infinity, NaN]) expect(() => Config({ stopSequenceMs })).toThrow()
  const ctx = new Context()
  try {
    apply(ctx, Config({ stopSequenceMs: 800 }))
    const table: IndexInjection[] = []
    await ctx.parallel('webserver/index-inject', table, PAGE_PEER)
    expect(table).toEqual([{ kind: 'global', name: '__DSH_SHORTCUTS_CONFIG__', value: { stopSequenceMs: 800 } }])
  } finally { await ctx.fiber.dispose() }
})
