/**
 * Session-summary key set: `summaryKeys()` derives the keys a summary read may
 * carry from the live registrations (a registered wire key whose unit did not
 * declare `summary: false`), and the existing key-taking read faces serve
 * exactly that set. The complete faces stay complete: `viewCheckpoint` and
 * `cachedSnapshot` serve every wire key when called without a key subset.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type {
  ProjectionCheckpoint,
  ProjectionDefinition,
} from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/summary-kept': { text: string } | null
    'test/summary-excluded': SessionProjectionSummaryExcluded<number>
    'test/summary-excluded-nullable': SessionProjectionSummaryExcluded<string[]> | null
  }
}

const keptUnit = () => ({
  key: 'test/summary-kept',
  stateSchema: z.union([z.object({ text: z.string() }), z.null()]),
  init: () => null,
  apply: (state: { text: string } | null, event) => (event.type === 'turn/start'
    ? { text: `turn-${String(event.data.turn)}` }
    : state),
  wire: {
    viewSchema: z.union([z.object({ text: z.string() }), z.null()]),
    view: state => state,
  },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/summary-kept', { text: string } | null>

const excludedUnit = () => ({
  key: 'test/summary-excluded',
  stateSchema: z.number().int().nonnegative(),
  init: () => 0,
  apply: (state: number) => state + 1,
  wire: { viewSchema: z.number().int().nonnegative(), view: state => state, summary: false },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/summary-excluded', number>

const excludedNullableUnit = () => ({
  key: 'test/summary-excluded-nullable',
  stateSchema: z.array(z.string()).nullable(),
  init: () => null,
  apply: (state: string[] | null, event) => (event.type === 'turn/start'
    ? [`turn-${String(event.data.turn)}`]
    : state),
  wire: { viewSchema: z.array(z.string()).nullable(), view: state => state, summary: false },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/summary-excluded-nullable', string[] | null>

async function mount(): Promise<{ ctx: Context; registry: SessionProjectionRegistry }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, registry: ctx.sessionProjections }
}

describe('session projection summary keys', () => {
  it('derives the summary set from the registered units and their marks', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(keptUnit())
      await registry.register(excludedUnit())
      await registry.register(excludedNullableUnit())
      const keys = registry.summaryKeys()
      expect([...keys]).toEqual(['test/summary-kept'])
      expect(keys.has('test/summary-excluded')).toBe(false)
      // The set is stable while the key table is unchanged.
      expect(registry.summaryKeys()).toBe(keys)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a second registration of one key with a different summary membership', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(keptUnit())
      await expect(Promise.resolve(registry.register({
        ...keptUnit(),
        wire: { ...keptUnit().wire, summary: false },
      }))).rejects.toThrow(/test\/summary-kept.*already registered with summary=true/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rebuilds the summary set only when a registration or its disposal changes the key table', async () => {
    const { ctx, registry } = await mount()
    try {
      const empty = registry.summaryKeys()
      expect([...empty]).toEqual([])
      const fiber = await ctx.plugin(Object.assign(async (hostCtx: Context) => {
        await hostCtx.sessionProjections.register(keptUnit())
      }, { inject: ['sessionProjections'] }))
      const registered = registry.summaryKeys()
      expect(registered).not.toBe(empty)
      expect([...registered]).toEqual(['test/summary-kept'])
      expect(registry.summaryKeys()).toBe(registered)
      await fiber.dispose()
      const disposed = registry.summaryKeys()
      expect(disposed).not.toBe(registered)
      expect([...disposed]).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves a summary-shaped block through the key-taking checkpoint face', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(keptUnit())
      await registry.register(excludedUnit())
      await registry.register(excludedNullableUnit())
      const checkpoint: ProjectionCheckpoint = {
        'test/summary-kept': { ver: 1, seq: SessionSeq(3), val: { text: 'kept' } },
        'test/summary-excluded': { ver: 1, seq: SessionSeq(4), val: 7 },
        'test/summary-excluded-nullable': { ver: 1, seq: SessionSeq(5), val: ['a'] },
      }

      expect(registry.viewCheckpoint(checkpoint, registry.summaryKeys())).toEqual({
        'test/summary-kept': { text: 'kept' },
      })
      // Without the key subset the complete face still serves the marked keys.
      expect(registry.viewCheckpoint(checkpoint)).toEqual({
        'test/summary-kept': { text: 'kept' },
        'test/summary-excluded': 7,
        'test/summary-excluded-nullable': ['a'],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves cached summary cells through the key-taking cached face', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(keptUnit())
      await registry.register(excludedUnit())
      const session = ctx.sessions.create(SessionId('summary-cached'), { meta: { cwd: '/workspace' } })
      session.append('turn/start', { turn: 1 })

      // The derived set is passed as a set: no key-list copy inside the read.
      expect(registry.cachedSnapshot(session, registry.summaryKeys())?.values).toEqual({
        'test/summary-kept': { text: 'turn-1' },
      })
      expect(registry.cachedSnapshot(session)?.values).toEqual({
        'test/summary-kept': { text: 'turn-1' },
        'test/summary-excluded': 1,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports an empty summary set while the complete face still serves only marked units', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(excludedUnit())
      await registry.register(excludedNullableUnit())
      const session = ctx.sessions.create(SessionId('summary-empty'), { meta: { cwd: '/workspace' } })
      session.append('turn/start', { turn: 1 })

      expect([...registry.summaryKeys()]).toEqual([])
      expect(registry.cachedSnapshot(session, [])).toBeUndefined()
      expect(registry.cachedSnapshot(session)?.values).toEqual({
        'test/summary-excluded': 1,
        'test/summary-excluded-nullable': ['turn-1'],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the marked nullable entry nullable through the mark', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(excludedNullableUnit())
      const before = ctx.sessions.create(SessionId('summary-nullable'), { meta: { cwd: '/workspace' } })
      expect(registry.snapshot(before).values['test/summary-excluded-nullable']).toBeNull()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drops an unmaterialized cell and a version-mismatched checkpoint row', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(keptUnit())
      const session = ctx.sessions.create(SessionId('summary-unmaterialized'), { meta: { cwd: '/workspace' } })
      expect(registry.cachedSnapshot(session, registry.summaryKeys())?.values).toEqual({
        'test/summary-kept': null,
      })
      const checkpoint: ProjectionCheckpoint = {
        'test/summary-kept': { ver: 2, seq: SessionSeq(1), val: { text: 'stale' } },
      }
      expect(registry.viewCheckpoint(checkpoint, registry.summaryKeys())).toEqual({})
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
