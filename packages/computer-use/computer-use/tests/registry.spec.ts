import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import ComputerUseRegistry from '../src/index.ts'
import { ComputerUseProviderName } from '../src/brand.ts'

const MCP = ComputerUseProviderName('cua-driver-mcp')
const NATIVE = ComputerUseProviderName('cua-driver-native')

describe('computer-use provider registration', () => {
  it('rejects a second provider and permits registration after disposal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(ComputerUseRegistry)
      expect(ctx.computerUse.providerName).toBeUndefined()
      const dispose = ctx.computerUse.register(MCP)
      expect(ctx.computerUse.providerName).toBe(MCP)
      expect(() => ctx.computerUse.register(MCP)).toThrow('already registered')
      expect(() => ctx.computerUse.register(NATIVE)).toThrow('cua-driver-mcp')
      await dispose()
      expect(ctx.computerUse.providerName).toBeUndefined()
      const disposeNative = ctx.computerUse.register(NATIVE)
      await dispose()
      expect(ctx.computerUse.providerName).toBe(NATIVE)
      await disposeNative()
      expect(ctx.computerUse.providerName).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('releases a provider contribution when its plugin unloads', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(ComputerUseRegistry)
      const provider = ctx.plugin({
        name: 'test-computer-use-provider',
        inject: ['computerUse'],
        apply(ctx: Context) { ctx.computerUse.register(MCP) },
      })
      await provider
      expect(ctx.computerUse.providerName).toBe(MCP)
      await provider.dispose()
      expect(ctx.computerUse.providerName).toBeUndefined()
      ctx.computerUse.register(NATIVE)
      expect(ctx.computerUse.providerName).toBe(NATIVE)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
