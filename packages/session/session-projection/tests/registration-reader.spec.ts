/** Retained readers follow Session events independently of registry participation. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
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
  it('binds typed host states to the exact Session without reading unrelated units', async () => {
    const { ctx, owner, session } = await setup()
    const unrelatedInit = vi.fn(() => 0)
    const unrelatedApply = vi.fn((state: number) => state)
    await ctx.sessionProjections.register({
      key: 'test/bound-unrelated', stateSchema: z.number(), stateVersion: 1,
      init: unrelatedInit, apply: unrelatedApply,
    })
    const countInit = vi.fn(definition.init)
    const countApply = vi.fn(definition.apply)
    const count = await owner.ctx.sessionProjections.register({ ...definition, init: countInit, apply: countApply })
    const hostInit = vi.fn((): { turn: number } | null => null)
    const hostApply = vi.fn((state: { turn: number } | null, event: Parameters<ProjectionDefinition<'test/reader', number>['apply']>[1]) => (
      event.type === 'turn/start' ? { turn: event.data.turn } : state
    ))
    const host = await owner.ctx.sessionProjections.register({
      key: 'test/bound-host', stateSchema: z.object({ turn: z.number() }).nullable(), stateVersion: 1,
      init: hostInit, apply: hostApply,
    })
    const initialized = { count: countInit.mock.calls.length, host: hostInit.mock.calls.length, unrelated: unrelatedInit.mock.calls.length }
    const applied = { count: countApply.mock.calls.length, host: hostApply.mock.calls.length, unrelated: unrelatedApply.mock.calls.length }
    const reader = { count: count.readerFor(session), host: host.readerFor(session) }
    expect({
      count: countInit.mock.calls.length, host: hostInit.mock.calls.length, unrelated: unrelatedInit.mock.calls.length,
    }).toEqual(initialized)
    expect({
      count: countApply.mock.calls.length, host: hostApply.mock.calls.length, unrelated: unrelatedApply.mock.calls.length,
    }).toEqual(applied)
    const initialCount = reader.count()
    expectTypeOf(initialCount).toEqualTypeOf<number>()
    expect(initialCount).toBe(0)
    const initialHost = reader.host()
    expectTypeOf(initialHost).toEqualTypeOf<{ turn: number } | null>()
    expect(initialHost).toBeNull()
    expect(unrelatedInit).toHaveBeenCalledTimes(initialized.unrelated)
    expect(unrelatedApply).toHaveBeenCalledTimes(applied.unrelated)

    const other = ctx.sessions.create()
    const otherReader = count.readerFor(other)
    other.append('turn/start', { turn: 1 })
    expect(otherReader()).toBe(1)
    expect(reader.count()).toBe(0)
    session.append('turn/start', { turn: 2 })
    expect(reader.count()).toBe(1)
    expect(reader.host()).toEqual({ turn: 2 })
    expect(reader.host()).toBe(host.stateOf(session))
    const read = reader.host
    expect(read()).toBe(host.stateOf(session))
  })

  it('retains the bound unit after owner disposal and version replacement', async () => {
    const { ctx, owner, session } = await setup()
    const original = await owner.ctx.sessionProjections.register(definition)
    const reader = original.readerFor(session)
    await owner.dispose()
    expect(ctx.sessionProjections.checkpoint(session)).toEqual({})
    const replacement = await ctx.sessionProjections.register({ ...definition, stateVersion: 2, apply: state => state + 10 })
    const changed = vi.fn()
    ctx.sessionProjections.onChanged(changed)
    session.append('turn/start', { turn: 1 })
    expect(reader()).toBe(1)
    expect(original.readerFor(session)()).toBe(1)
    expect(replacement.stateOf(session)).toBe(10)
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/reader': 10 })
    expect(changed).toHaveBeenCalledOnce()
    expect(ctx.sessionProjections.checkpoint(session)['test/reader']?.ver).toBe(2)
  })

  it('does not read during binding and preserves the original synchronous failure', async () => {
    const { owner, session } = await setup()
    const failure = new Error('host state cannot initialize')
    const init = vi.fn((): number => { throw failure })
    const broken = await owner.ctx.sessionProjections.register({
      key: 'test/bound-failure', stateSchema: z.number(), stateVersion: 1,
      init, apply: state => state,
    })
    const initialized = init.mock.calls.length
    const reader = broken.readerFor(session)
    expect(init).toHaveBeenCalledTimes(initialized)
    let caught: unknown
    try {
      reader()
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
  })

  it('preserves undefined state without substituting a value', async () => {
    const { owner, session } = await setup()
    const handle = await owner.ctx.sessionProjections.register({
      key: 'test/bound-undefined', stateSchema: z.number().optional(), stateVersion: 1,
      init: () => undefined,
      apply: (state, event) => event.type === 'turn/start' ? event.data.turn : state,
    })
    const read = handle.readerFor(session)
    expectTypeOf(read()).toEqualTypeOf<number | undefined>()
    expect(read()).toBeUndefined()
    session.append('turn/start', { turn: 1 })
    expect(read()).toBe(1)
  })

  it.each(['handle', 'fiber'] as const)('reads new events after %s disposal without rejoining snapshots or notifications', async (release) => {
    const { ctx, owner, session } = await setup()
    const apply = vi.fn(definition.apply)
    const handle = await owner.ctx.sessionProjections.register({ ...definition, apply })
    const read = handle.readerFor(session)
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
    expect(read()).toBe(2)
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
