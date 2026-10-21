/** Retained readers follow Session events independently of registry participation. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/reader': number
  }
}

const definition = {
  key: 'test/reader',
  stateSchema: z.number(),
  stateVersion: 1,
  init: () => 0,
  apply: (state: number) => state + 1,
  wire: { viewSchema: z.number(), view: (state: number) => state },
} satisfies ProjectionDefinition<'test/reader', number>

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const owner = await ctx.plugin(Object.assign(function registrationOwner() {}, { inject: ['sessionProjections'] }))
  const session = ctx.sessions.create()
  return { ctx, owner, session }
}

describe('retained projection readers', () => {
  it.each(['handle', 'fiber'] as const)('reads new events after %s disposal without rejoining snapshots or notifications', async (release) => {
    const { ctx, owner, session } = await setup()
    const apply = vi.fn(definition.apply)
    const handle = await owner.ctx.sessionProjections.register({ ...definition, apply })
    const changed = vi.fn()
    ctx.sessionProjections.onChanged(changed)
    expect(handle.stateOf(session)).toBe(0)
    session.append('turn/start', { turn: 1 })
    expect(handle.stateOf(session)).toBe(1)
    expect(changed).toHaveBeenCalledOnce()
    if (release === 'handle') await handle.dispose()
    else await owner.dispose()
    session.append('turn/start', { turn: 2 })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(handle.stateOf(session)).toBe(2)
    expect(apply).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenCalledOnce()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    expect(ctx.sessionProjections.checkpoint(session)).toEqual({})
    const later = ctx.sessions.create()
    later.append('turn/start', { turn: 1 })
    expect(handle.stateOf(later)).toBe(1)
  })

  it('keeps the original unit when the same key is registered with a new version', async () => {
    const { ctx, owner, session } = await setup()
    const original = await owner.ctx.sessionProjections.register(definition)
    expect(original.stateOf(session)).toBe(0)
    await original.dispose()
    const replacement = await ctx.sessionProjections.register({ ...definition, stateVersion: 2, apply: state => state + 10 })
    session.append('turn/start', { turn: 1 })
    expect(original.stateOf(session)).toBe(1)
    expect(replacement.stateOf(session)).toBe(10)
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/reader': 10 })
  })

  it('reads only the selected unit without materializing unrelated registrations', async () => {
    const { ctx, owner, session } = await setup()
    const unrelatedInit = vi.fn(() => 0)
    await ctx.sessionProjections.register({
      key: 'test/unrelated-reader', stateSchema: z.number(), stateVersion: 1,
      init: unrelatedInit, apply: state => state,
    })
    const handle = await owner.ctx.sessionProjections.register(definition)
    expect(handle.stateOf(session)).toBe(0)
    expect(unrelatedInit).not.toHaveBeenCalled()
  })

  it('rejects initialization when the owner unloads before the handle is returned', async () => {
    const { ctx, owner, session } = await setup()
    const registration = owner.ctx.sessionProjections.register(definition)
    const rejected = expect(Promise.resolve(registration)).rejects.toThrow()
    await owner.dispose()
    await rejected
    expect(ctx.sessionProjections.checkpoint(session)).toEqual({})
  })

  it.each(['twice', 'owner-unload'] as const)('releases one reference once under %s disposal', async (release) => {
    const { ctx, owner, session } = await setup()
    const retained = await ctx.sessionProjections.register(definition)
    const handle = await owner.ctx.sessionProjections.register(definition)
    if (release === 'twice') {
      await expect(handle.dispose()).resolves.toBeUndefined()
      await expect(handle.dispose()).resolves.toBeUndefined()
    } else {
      await Promise.all([owner.dispose(), expect(handle.dispose()).resolves.toBeUndefined()])
      await expect(handle.dispose()).resolves.toBeUndefined()
    }
    session.append('turn/start', { turn: 1 })
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/reader': 1 })
    expect(handle.stateOf(session)).toBe(1)
    await retained.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

})
