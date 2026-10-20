/** Legacy projection calls keep their effect ownership while new callers await retained readers. */
/* oxlint-disable typescript/no-deprecated -- exercise the public compatibility API. */
import { setImmediate } from 'node:timers/promises'
import { Context, FiberState } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/legacy': number
    'test/legacy-unread-wire': number
  }
}

const definition = {
  key: 'test/legacy',
  stateSchema: z.number(),
  stateVersion: 1,
  init: () => 0,
  apply: (state: number) => state + 1,
  wire: { viewSchema: z.number(), view: (state: number) => state },
} satisfies ProjectionDefinition<'test/legacy', number>

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warning.mockRestore() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, warning, session: ctx.sessions.create() }
}

/** Exercise calls emitted by plugins compiled against the old disposer return type. */
function legacyRegistration<T>(registration: Promise<T>): Promise<T> & (() => Promise<void>) {
  expect(registration).toBeTypeOf('function')
  return registration as Promise<T> & (() => Promise<void>)
}

describe('projection registration compatibility', () => {
  it('awaits modern registration, keeps Promise chaining, and never warns for handle cleanup', async () => {
    const { ctx, warning, session } = await setup()
    const settled = vi.fn()
    const owner = await ctx.plugin({
      inject: ['sessionProjections'],
      async apply(inner) {
        const registration = inner.sessionProjections.register(definition)
        expect(registration).not.toBeInstanceOf(Promise)
        expect(Promise.resolve(registration)).toBeInstanceOf(Promise)
        const handle = await registration.then(value => value).catch(() => { throw new Error('unexpected rejection') })
        expect(await registration.finally(settled)).toBe(handle)
        expect(handle.stateOf(session)).toBe(0)
        await handle.dispose()
        session.append('turn/start', { turn: 1 })
        expect(handle.stateOf(session)).toBe(1)
      },
    })
    expect(settled).toHaveBeenCalledOnce()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    await owner.dispose()
    expect(warning).not.toHaveBeenCalled()
  })

  it('lets an asynchronous plugin await registration later in its initialization', async () => {
    const { ctx, warning } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const owner = ctx.plugin({
      inject: ['sessionProjections'],
      async apply(inner) {
        const registration = inner.sessionProjections.register(definition)
        entered.resolve(undefined)
        await release.promise
        await registration
      },
    })
    await entered.promise
    release.resolve(undefined)
    await owner
    expect(warning).not.toHaveBeenCalled()
  })

  it('loads an unawaited legacy registration and warns once per key for keyed reads', async () => {
    const { ctx, warning, session } = await setup()
    const mount = () => ctx.plugin({
      inject: ['sessionProjections'],
      apply(inner) {
        void inner.sessionProjections.register(definition)
      },
    })
    const first = await mount()
    const second = await mount()
    session.append('turn/start', { turn: 1 })
    expect(ctx.sessionProjections.stateOf(session, 'test/legacy')).toBe(1)
    expect(ctx.sessionProjections.stateOf(session, 'test/legacy')).toBe(1)
    expect(ctx.sessionProjections.stateOf(session, 'test/missing-legacy')).toBeUndefined()
    expect(warning.mock.calls).toEqual([
      ['sessionProjections.stateOf(session, "test/legacy") is deprecated; read handle.stateOf(session) from an awaited registration, or use the owning domain service'],
      ['sessionProjections.stateOf(session, "test/missing-legacy") is deprecated; read handle.stateOf(session) from an awaited registration, or use the owning domain service'],
    ])
    await first.dispose()
    expect(ctx.sessionProjections.stateOf(session, 'test/legacy')).toBe(1)
    await second.dispose()
    expect(ctx.sessionProjections.stateOf(session, 'test/legacy')).toBeUndefined()
    expect(warning).toHaveBeenCalledTimes(2)
  })

  it('materializes every registered unit on a legacy keyed read without producing unrelated wire views', async () => {
    const { ctx, session } = await setup()
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const unrelatedView = vi.fn((state: number) => state)
    const hostInit = vi.fn(() => 0)
    await ctx.sessionProjections.register(definition)
    await ctx.sessionProjections.register({
      ...definition,
      key: 'test/legacy-unread-wire',
      wire: { viewSchema: z.number(), view: unrelatedView },
    })
    await ctx.sessionProjections.register({
      key: 'test/legacy-unread-host',
      stateSchema: definition.stateSchema,
      stateVersion: definition.stateVersion,
      init: hostInit,
      apply: definition.apply,
    })
    expect(ctx.sessionProjections.stateOf(session, 'test/missing-legacy')).toBeUndefined()
    expect(ctx.sessionProjections.cachedSnapshot(session)).toBeUndefined()
    expect(hostInit).not.toHaveBeenCalled()

    expect(ctx.sessionProjections.stateOf(session, 'test/legacy')).toBe(2)
    expect(unrelatedView).not.toHaveBeenCalled()
    expect(ctx.sessionProjections.cachedSnapshot(session)).toEqual({
      asOfSeq: 1,
      values: { 'test/legacy': 2, 'test/legacy-unread-wire': 2 },
    })
    expect(hostInit).toHaveBeenCalledOnce()
  })

  it('keeps callable early disposal idempotent without invalidating an awaited reader', async () => {
    const { ctx, warning, session } = await setup()
    const registration = legacyRegistration(ctx.sessionProjections.register(definition))
    const handle = await registration
    await registration()
    await registration()
    await handle.dispose()
    session.append('turn/start', { turn: 1 })
    expect(handle.stateOf(session)).toBe(1)
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    expect(warning).not.toHaveBeenCalled()
  })

  it('releases a registration called before the asynchronous handle handoff', async () => {
    const { ctx, warning, session } = await setup()
    const registration = legacyRegistration(ctx.sessionProjections.register(definition))
    await registration()
    const handle = await registration
    expect(handle.stateOf(session)).toBe(0)
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    expect(warning).not.toHaveBeenCalled()
  })

  it.each(['return', 'effect', 'generator'] as const)('unloads a legacy %s registration', async (style) => {
    const { ctx, warning, session } = await setup()
    const owner = await ctx.plugin({
      inject: ['sessionProjections'],
      apply(inner) {
        if (style === 'return') return legacyRegistration(inner.sessionProjections.register(definition))
        if (style === 'effect') return void inner.effect(() => legacyRegistration(inner.sessionProjections.register(definition)))
        inner.effect(function* () { yield legacyRegistration(inner.sessionProjections.register(definition)) })
      },
    })
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/legacy': 0 })
    await owner.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    expect(warning).not.toHaveBeenCalled()
  })

  it('rejects an async plugin that returns the legacy registration as a disposer', async () => {
    const { ctx, warning, session } = await setup()
    const errorLog = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { errorLog.mockRestore() })
    const owner = ctx.plugin({
      inject: ['sessionProjections'],
      async apply(inner) {
        // Compiled legacy callers see a disposer type; async return still assimilates its runtime then().
        return legacyRegistration(inner.sessionProjections.register(definition)) as () => Promise<void>
      },
    })
    await expect(owner.await()).rejects.toThrow('Invalid effect')
    expect(owner.state).toBe(FiberState.FAILED)
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    expect(errorLog).toHaveBeenCalledOnce()
    expect(warning).not.toHaveBeenCalled()
  })

  it('leaves an async generator yield owned by the plugin instead of the composed effect', async () => {
    const { ctx, session } = await setup()
    let disposeEffect!: () => Promise<void>
    const owner = await ctx.plugin({
      inject: ['sessionProjections'],
      apply(inner) {
        disposeEffect = inner.effect(async function* () {
          // Compiled legacy callers see a disposer type; the async yield still assimilates its runtime then().
          yield legacyRegistration(inner.sessionProjections.register(definition)) as () => Promise<void>
        })
      },
    })
    expect(owner.state).toBe(FiberState.ACTIVE)
    await expect(disposeEffect()).rejects.toThrow('Invalid effect')
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/legacy': 0 })
    await owner.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('transfers the original disposer into a composed effect and retains it until earlier cleanup settles', async () => {
    const { ctx, session } = await setup()
    const release = Promise.withResolvers<undefined>()
    const closing = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const owner = await ctx.plugin({
      inject: ['sessionProjections'],
      apply(inner) {
        inner.effect(function* () {
          yield legacyRegistration(inner.sessionProjections.register(definition))
          yield async () => {
            closing.resolve(undefined)
            await release.promise
          }
        })
      },
    })
    const disposed = owner.dispose()
    await closing.promise
    session.append('turn/start', { turn: 1 })
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/legacy': 1 })
    release.resolve(undefined)
    await disposed
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('preserves explicit rejection handling and returns a harmless legacy disposer for failed acquisition', async () => {
    const { ctx, warning, session } = await setup()
    const errorLog = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { errorLog.mockRestore() })
    const registration = legacyRegistration(ctx.sessionProjections.register({ ...definition, stateVersion: -1 }))
    await expect(registration.catch((error: unknown) => error)).resolves.toBeInstanceOf(Error)
    await registration()
    await setImmediate()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    expect(errorLog).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
  })

  it('logs an ignored legacy registration rejection and keeps the plugin active', async () => {
    const { ctx, session } = await setup()
    const reported = Promise.withResolvers<unknown>()
    const errorLog = vi.spyOn(ctx.logger, 'error').mockImplementation((error: unknown) => { reported.resolve(error) })
    onTestFinished(() => { errorLog.mockRestore() })
    const owner = await ctx.plugin({
      inject: ['sessionProjections'],
      apply(inner) {
        void inner.sessionProjections.register(definition)
        void inner.sessionProjections.register({ ...definition, stateVersion: 2 })
        inner.provide('legacy-failed-provider', {})
      },
    })
    const error = await reported.promise
    expect(String(error)).toContain('already registered at stateVersion 1')
    expect(errorLog).toHaveBeenCalledOnce()
    expect(owner.state).toBe(FiberState.ACTIVE)
    expect(ctx.get('legacy-failed-provider')).toBeDefined()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/legacy': 0 })
  })

  it('lets a modern plugin handle rejected registration and finish activation', async () => {
    const { ctx, warning, session } = await setup()
    const owner = await ctx.plugin({
      inject: ['sessionProjections'],
      async apply(inner) {
        const invalid = inner.sessionProjections.register({ ...definition, stateVersion: -1 })
        await expect(invalid.catch((error: unknown) => error)).resolves.toBeInstanceOf(Error)
        await inner.sessionProjections.register(definition)
      },
    })
    expect(owner.state).toBe(FiberState.ACTIVE)
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/legacy': 0 })
    expect(warning).not.toHaveBeenCalled()
  })

  it('warns again for a new registry instance without sharing warning state between applications', async () => {
    const { ctx, warning, session } = await setup()
    await ctx.sessionProjections.register(definition)
    expect(ctx.sessionProjections.stateOf(session, 'test/legacy')).toBe(0)
    expect(ctx.sessionProjections.stateOf(session, 'test/legacy')).toBe(0)
    expect(warning).toHaveBeenCalledOnce()
    const second = new Context()
    onTestFinished(async () => { await second.fiber.dispose() })
    const secondWarning = vi.spyOn(second.logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => { secondWarning.mockRestore() })
    await second.plugin(SessionProjectionRegistry)
    expect(second.sessionProjections.stateOf(session, 'test/legacy')).toBeUndefined()
    expect(secondWarning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledOnce()
  })

  it('drops an ignored rejection when its plugin unloads before handoff', async () => {
    const { ctx, warning, session } = await setup()
    const errorLog = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { errorLog.mockRestore() })
    const owner = ctx.plugin({
      inject: ['sessionProjections'],
      apply(inner) {
        void inner.sessionProjections.register(definition)
        void inner.fiber.dispose()
      },
    })
    await owner.await()
    await setImmediate()
    expect(owner.state).toBe(FiberState.DISPOSED)
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    expect(errorLog).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
  })

  it('keeps an observed registration owned when its plugin unloads before handoff', async () => {
    const { ctx, warning, session } = await setup()
    const owner = await ctx.plugin({ inject: ['sessionProjections'], apply() {} })
    const registration = owner.ctx.sessionProjections.register(definition)
    const rejection = expect(Promise.resolve(registration)).rejects.toThrow('inactive context')
    await owner.dispose()
    await rejection
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    expect(warning).not.toHaveBeenCalled()
  })

})
