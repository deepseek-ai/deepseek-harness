import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import BrowserUseRegistry from '../src/index.ts'
import { BrowserUseProviderName } from '../src/brand.ts'

const MCP = BrowserUseProviderName('playwright-mcp')
const NATIVE = BrowserUseProviderName('stagehand')

describe('browser-use provider registration', () => {
  it('rejects a second provider and permits registration after disposal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(BrowserUseRegistry)
      expect(ctx.browserUse.providerName).toBeUndefined()
      const dispose = ctx.browserUse.register(MCP)
      expect(ctx.browserUse.providerName).toBe(MCP)
      expect(() => ctx.browserUse.register(MCP)).toThrow('already registered')
      expect(() => ctx.browserUse.register(NATIVE)).toThrow('playwright-mcp')
      await dispose()
      expect(ctx.browserUse.providerName).toBeUndefined()
      const disposeNative = ctx.browserUse.register(NATIVE)
      await dispose()
      expect(ctx.browserUse.providerName).toBe(NATIVE)
      await disposeNative()
      expect(ctx.browserUse.providerName).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('releases a provider contribution when its plugin unloads', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(BrowserUseRegistry)
      const provider = ctx.plugin({
        name: 'test-browser-use-provider',
        inject: ['browserUse'],
        apply(ctx: Context) { ctx.browserUse.register(MCP) },
      })
      await provider
      expect(ctx.browserUse.providerName).toBe(MCP)
      await provider.dispose()
      expect(ctx.browserUse.providerName).toBeUndefined()
      ctx.browserUse.register(NATIVE)
      expect(ctx.browserUse.providerName).toBe(NATIVE)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
