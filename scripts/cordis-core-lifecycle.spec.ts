/** Cordis rc.11 updates retain dependency ownership and publish only current configuration. */
import type { Awaitable } from '@deepseek-ai/cosmokit'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

declare module '@deepseek-ai/cordis' {
  interface Context {
    rc11Service: { alive: boolean }
    rc11View: string
    rc11Private: boolean
  }
}

function root() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

function barrier() {
  const gate = Promise.withResolvers<undefined>()
  onTestFinished(() => { gate.resolve(undefined) })
  return gate
}

describe('Cordis rc.11 lifecycle', () => {
  it.each([false, true])('awaits the latest update while loading (inject: %s)', async (inject) => {
    const ctx = root()
    ctx.provide('rc11Dependency', 1)
    const started = barrier()
    const release = barrier()
    const applied: number[] = []
    const disposed: number[] = []
    const fiber = await ctx.plugin({ inject: inject ? ['rc11Dependency'] : [], async apply(owner: Context, config: { value: number }) {
      applied.push(config.value)
      if (config.value === 1) { started.resolve(undefined); await release.promise }
      owner.effect(() => () => { disposed.push(config.value) })
    } }, { value: 0 })
    const first = fiber.update({ value: 1 })
    await started.promise
    const second = fiber.update({ value: 2 })
    const third = fiber.update({ value: 3 })
    release.resolve(undefined)
    await Promise.all([first, second, third])
    expect(applied).toEqual([0, 1, 3])
    expect(disposed).toEqual([0, 1])
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(fiber.effectiveConfig).toEqual({ value: 3 })
    await fiber.dispose()
    expect(disposed).toEqual([0, 1, 3])
  })

  it('cleans up a superseded activation failure and accepts the latest update', async () => {
    const ctx = root()
    const started = barrier()
    const release = barrier()
    const cleanup = vi.fn()
    const fiber = ctx.plugin(async (owner, config: number) => {
      owner.effect(() => cleanup)
      if (config !== 1) return
      started.resolve(undefined)
      await release.promise
      throw new Error('superseded activation')
    }, 1)
    await started.promise
    const updating = fiber.update(2)
    release.resolve(undefined)
    await updating
    expect(cleanup).toHaveBeenCalledOnce()
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(fiber.effectiveConfig).toBe(2)
  })

  it.each(['dispose', 'restart'] as const)('retains isolated providers through dependent teardown on %s', async (action) => {
    const ctx = root()
    const realm = ctx.isolate('rc11Service')
    const disposing = barrier()
    const release = barrier()
    const events: string[] = []
    const provider = await ctx.plugin((owner) => {
      const service = { alive: true }
      owner.isolate('rc11Service', realm[Context.isolate].rc11Service).provide('rc11Service', service)
      owner.effect(() => () => { events.push('provider'); service.alive = false })
    })
    const consumer = await realm.inject(['rc11Service'], (owner) => {
      return async () => {
        disposing.resolve(undefined)
        await release.promise
        expect(owner.rc11Service.alive).toBe(true)
        events.push('consumer')
      }
    })
    const task = provider[action]()
    await disposing.promise
    expect(events).toEqual([])
    release.resolve(undefined)
    await task
    await consumer.await()
    expect(events).toEqual(['consumer', 'provider'])
  })

  it('separates own isolated provisions from the committed injection', async () => {
    const ctx = root()
    ctx.provide('rc11View', 'outer')
    await ctx.inject(['rc11View'], async (owner) => {
      const isolated = owner.isolate('rc11View')
      const withdraw = isolated.reflect.provide('rc11View', 'inner')
      expect(owner.rc11View).toBe('outer')
      expect(isolated.rc11View).toBe('inner')
      await isolated.plugin((child) => { expect(child.rc11View).toBe('inner') })
      await withdraw()
      expect(owner.rc11View).toBe('outer')
      expect(isolated.rc11View).toBe('outer')
    })
    await ctx.plugin((owner) => {
      owner.isolate('rc11Private').provide('rc11Private', true)
      expect(() => owner.rc11Private).toThrow('without inject')
    })
  })

  it('publishes successful retained-instance updates and ignores stale or rejected completions', async () => {
    const ctx = root()
    const old = barrier()
    const failed = Promise.withResolvers<undefined>()
    const values: unknown[] = []
    const fiber = await ctx.plugin((owner, config: number) => {
      values.push(config)
      owner.on('internal/update', (config: number) => {
        if (config === 1) return old.promise
        if (config === 3) return failed.promise
      })
    }, 0)
    const first = fiber.update(1)
    expect(fiber.effectiveConfig).toBe(0)
    await fiber.update(2)
    old.resolve(undefined)
    await first
    expect(fiber.effectiveConfig).toBe(2)
    const third = fiber.update(3)
    const rejected = expect(third).rejects.toThrow('update rejected')
    failed.reject(new Error('update rejected'))
    await rejected
    expect(fiber.rawConfig).toBe(3)
    expect(fiber.effectiveConfig).toBe(2)
    expect(values).toEqual([0])
  })

  it.each(['raw retention', 'restart', 'dispose'] as const)('does not publish an old update after %s', async (action) => {
    const ctx = root()
    const release = barrier()
    const configs: object[] = []
    const fiber = await ctx.plugin((owner, config: object) => {
      configs.push(config)
      owner.on('internal/update', () => release.promise)
    }, { value: 0 })
    const old = fiber.update({ value: 1 })
    if (action === 'raw retention') fiber.rawConfig = { value: 2 }
    if (action === 'restart') await fiber.restart()
    if (action === 'dispose') await fiber.dispose()
    release.resolve(undefined)
    await old
    expect(fiber.effectiveConfig).toBe(configs.at(-1))
  })

  it('keeps the restarted config identity when a listener delegates', async () => {
    const ctx = root()
    const applied: unknown[] = []
    const fiber = await ctx.plugin((owner, config) => {
      applied.push(config)
      owner.on('internal/update', (_config, next): Awaitable<void> => next())
    }, {})
    fiber.ctx.on('internal/config', (_fiber, next: () => object) => ({ ...next() }))
    await fiber.update({ value: 1 })
    expect(fiber.effectiveConfig).toBe(applied.at(-1))
  })

  it('supports symbol events and rejects repeated waterfall delegation', async () => {
    const ctx = root()
    const name = Symbol('rc11-event')
    const callback = vi.fn()
    ctx.on(name, callback)
    ctx.emit(name, 1)
    expect(callback).toHaveBeenCalledWith(1)
    const waterfall = Symbol('rc11-waterfall')
    ctx.on(waterfall, (next: () => number) => { next(); return next() })
    expect(() => { ctx.waterfall(waterfall, () => 1) }).toThrow('next() called multiple times')
  })
})
