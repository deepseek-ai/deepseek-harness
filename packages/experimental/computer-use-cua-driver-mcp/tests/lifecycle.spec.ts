/** The external MCP process is replaced by barriers to pin disposal ordering. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const fake = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  configurations: [] as unknown[],
}))

vi.mock('@deepseek-ai/dsh-mcp-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client')>()
  return {
    ...original,
    async apply(ctx: Context, config: unknown) {
      fake.configurations.push(config)
      ctx.effect(() => () => fake.close())
      await fake.start()
    },
  }
})

import * as Provider from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  fake.configurations.length = 0
  vi.resetAllMocks()
})

async function context(): Promise<Context> {
  fake.start.mockResolvedValue(undefined)
  fake.close.mockResolvedValue(undefined)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ComputerUse)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('installed Cua Driver ownership', () => {
  it('reserves before initial discovery and rejects a second provider before it starts', async () => {
    const ctx = await context()
    const ready: PromiseWithResolvers<void> = Promise.withResolvers()
    fake.start.mockReturnValueOnce(ready.promise)
    const first = ctx.plugin(Provider, {})
    try {
      await vi.waitFor(() => { expect(fake.start).toHaveBeenCalledTimes(1) })
      expect(ctx.computerUse.providerName).toBe('cua-driver-mcp')
      await expect(ctx.plugin(Provider, {})).rejects.toThrow('already registered')
      expect(fake.start).toHaveBeenCalledTimes(1)
      expect(() => ctx.computerUse.register(ComputerUseProviderName('another-driver'))).toThrow('already registered')
    } finally {
      ready.resolve()
      await first
    }
    expect(fake.configurations[0]).toMatchObject({
      transport: 'stdio', serverName: 'cua-driver-mcp', command: 'cua-driver', args: ['mcp'],
      failOnStartupError: true, toolCallTimeoutMs: 60_000,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    })
  })

  it('retains the reservation until child teardown completes, then permits reload', async () => {
    const ctx = await context()
    const childClosed: PromiseWithResolvers<void> = Promise.withResolvers()
    const first = await ctx.plugin(Provider, {})
    fake.close.mockReturnValueOnce(childClosed.promise)
    const closing = first.dispose()
    try {
      await vi.waitFor(() => { expect(fake.close).toHaveBeenCalledTimes(1) })
      expect(ctx.computerUse.providerName).toBe('cua-driver-mcp')
      await expect(ctx.plugin(Provider, {})).rejects.toThrow('already registered')
    } finally {
      childClosed.resolve()
      await closing
    }
    expect(ctx.computerUse.providerName).toBeUndefined()
    const replacement = await ctx.plugin(Provider, { command: '/configured/driver', args: ['mcp', '--verbose'], toolCallTimeoutMs: 1234, reconnect: { enabled: false } })
    expect(fake.configurations[1]).toMatchObject({
      command: '/configured/driver', args: ['mcp', '--verbose'], toolCallTimeoutMs: 1234,
      reconnect: { enabled: false },
    })
    await replacement.dispose()
    expect(ctx.computerUse.providerName).toBeUndefined()
  })

  it('rolls back a failed activation only after its child closes', async () => {
    const ctx = await context()
    const childClosed: PromiseWithResolvers<void> = Promise.withResolvers()
    fake.start.mockRejectedValueOnce(new Error('driver unavailable'))
    fake.close.mockReturnValueOnce(childClosed.promise)
    const failure = Promise.resolve(ctx.plugin(Provider, {})).then(
      () => { throw new Error('activation unexpectedly succeeded') },
      (error: unknown) => error,
    )
    try {
      await vi.waitFor(() => { expect(fake.close).toHaveBeenCalledTimes(1) })
      expect(ctx.computerUse.providerName).toBe('cua-driver-mcp')
    } finally {
      childClosed.resolve()
    }
    expect(await failure).toEqual(new Error('driver unavailable'))
    expect(ctx.computerUse.providerName).toBeUndefined()
    await ctx.plugin(Provider, {})
    expect(ctx.computerUse.providerName).toBe('cua-driver-mcp')
  })

  it('rejects invalid executable and connection options before acquiring a driver', async () => {
    const ctx = await context()
    for (const config of [{ command: '' }, { command: '  ' }, { toolCallTimeoutMs: 0 }, { reconnect: { maxAttempts: 0 } }]) {
      await expect(ctx.plugin(Provider, config)).rejects.toThrow()
    }
    expect(fake.start).not.toHaveBeenCalled()
    expect(ctx.computerUse.providerName).toBeUndefined()
  })
})
