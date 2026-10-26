/** Raw retention and candidate evaluation preserve the running plugin's config identity. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

function root(): Context {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

describe('Fiber configuration access', () => {
  it('keeps raw and running references unchanged while resolving valid or invalid candidates', async () => {
    const ctx = root()
    await ctx.plugin(Loader)
    const Config = z.object({ value: z.number().min(0).volatile() })
    const applied = vi.fn()
    ctx.loader.builtins.consumer = { Config, apply: applied }
    const raw = { value: { __jsExpr: '1 + 1' } }
    const id = await ctx.loader.create({ name: 'cordis:consumer', config: raw })
    const fiber = ctx.loader.resolve(id).fiber!
    await fiber.await()
    const running = applied.mock.calls[0]![1] as ReturnType<typeof Config>
    expect(fiber.rawConfig).toBe(raw)
    expect(fiber.effectiveConfig).toBe(running)
    const candidate = fiber.resolveConfig({ value: { __jsExpr: '2 + 2' } }) as ReturnType<typeof Config>
    expect(candidate.value.get()).toBe(4)
    expect(candidate.value).not.toBe(running.value)
    expect(() => fiber.resolveConfig({ value: -1 })).toThrow()
    expect(fiber.rawConfig).toBe(raw)
    expect(fiber.effectiveConfig).toBe(running)
    expect(running.value.get()).toBe(2)
    expect(applied).toHaveBeenCalledOnce()
  })

  it('uses the canonical fiber through registry wrappers and retains raw input without updating', async () => {
    const ctx = root()
    const initial = { value: 1 }
    const apply = vi.fn()
    const wrapper = ctx.plugin(apply, initial)
    await wrapper
    const fiber = wrapper.ctx.fiber
    const hook = vi.fn(function (this: Fiber, _config: unknown, next: () => unknown) {
      expect(this).toBe(fiber)
      return next()
    })
    fiber.ctx.on('internal/config', hook)
    const raw = { value: 2 }
    wrapper.rawConfig = raw
    expect(fiber.rawConfig).toBe(raw)
    expect(wrapper.effectiveConfig).toBe(initial)
    expect(wrapper.resolveConfig(raw)).toBe(raw)
    expect(hook).toHaveBeenCalledOnce()
    expect(fiber.effectiveConfig).toBe(initial)
    expect(apply).toHaveBeenCalledOnce()
    await wrapper.restart()
    expect(fiber.effectiveConfig).toBe(raw)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('publishes updates through registry wrappers to the canonical fiber', async () => {
    const ctx = root()
    const initial = { value: 1 }
    const apply = vi.fn()
    const wrapper = ctx.plugin(apply, initial)
    await wrapper
    const raw = { value: 2 }
    wrapper.update(raw)
    await wrapper.await()
    expect(apply).toHaveBeenLastCalledWith(wrapper.ctx, raw)
    expect(wrapper.rawConfig).toBe(raw)
    expect(wrapper.effectiveConfig).toBe(raw)
    expect(wrapper.ctx.fiber.rawConfig).toBe(raw)
    expect(wrapper.ctx.fiber.effectiveConfig).toBe(raw)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('retains a pending raw update until its injection is available', async () => {
    const ctx = root()
    ctx.provide('configAccessTest')
    const apply = vi.fn()
    const wrapper = ctx.plugin({ inject: ['configAccessTest'], apply }, { value: 1 })
    const raw = { value: 2 }
    wrapper.update(raw)
    expect(wrapper.rawConfig).toBe(raw)
    expect(wrapper.effectiveConfig).toBeUndefined()
    ctx.set('configAccessTest', {})
    await wrapper
    expect(wrapper.effectiveConfig).toBe(raw)
    expect(apply).toHaveBeenCalledOnce()
  })
})
