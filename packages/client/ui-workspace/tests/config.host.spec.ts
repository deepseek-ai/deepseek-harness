import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { apply, Config } from '../src/index.ts'

describe('ui-workspace host', () => {
  it('keeps ten recent views by default and rejects a negative or fractional limit', () => {
    expect(Config({}).recentViewLimit?.get()).toBe(10)
    expect(Config({ recentViewLimit: 3 }).recentViewLimit?.get()).toBe(3)
    expect(Config({ recentViewLimit: 0 }).recentViewLimit?.get()).toBe(0)
    expect(() => Config({ recentViewLimit: -1 })).toThrow()
    expect(() => Config({ recentViewLimit: 1.5 })).toThrow()
  })

  it('loads as an inert Loader entry that only declares its synced Config', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    let received: Config | undefined
    const fiber = ctx.plugin({
      Config,
      apply: (_ctx: Context, config: Config) => { received = config; apply() },
    }, { recentViewLimit: 4 })
    await expect(fiber.await()).resolves.toBeDefined()
    expect(received?.recentViewLimit.get()).toBe(4)
  })
})
