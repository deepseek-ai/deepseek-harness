import { createRequire } from 'node:module'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { Context } from '@deepseek-ai/cordis'
import { CordisInspectRegistryService } from '@deepseek-ai/dsh-cordis-host-runner'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as CordisInspectProviders from '../src/host.ts'
import * as CordisInspectTools from '../src/index.ts'
import { hostInspectProviders } from '../src/providers.ts'

/**
 * The Host inspect providers are one process-global set: the host entry
 * registers them beside the registry, and the per-session tool rows only read
 * them. Mounting several presets that carry `tool-cordis` over the shared
 * registry is covered by `apps/cli/tests/web-agent-presets.e2e.ts`.
 */

async function host(): Promise<Context> {
  const ctx = new Context()
  // The tool registry injects `systemPrompt`; nothing under test registers a prompt section.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(CordisInspectRegistryService, 10_000)
  return ctx
}

describe('the cordis-inspect-providers host entry', () => {
  it('registers the first-party Host providers and withdraws them on disposal', async () => {
    const ctx = await host()
    const fiber = ctx.plugin(CordisInspectProviders)
    await fiber

    expect(ctx.cordisInspect.list().map(provider => provider.id)).toEqual(['Service', 'Event', 'Config', 'Runtime', 'Tool'])

    await fiber.dispose()
    expect(ctx.cordisInspect.list()).toEqual([])
  })

  it('answers the Runtime version query with the running DSH version', async () => {
    const ctx = await host()
    await ctx.plugin(CordisInspectProviders)
    const agent = { ctx } as never
    const signal = new AbortController().signal
    expect(await ctx.cordisInspect.query('host', 'Runtime', 'getVersion', undefined, agent, signal)).toEqual({ version: (createRequire(import.meta.url)('@deepseek-ai/dsh-app-boot/package.json') as { version: string }).version })
    await ctx.fiber.dispose()
  })

  it('reports a missing Agent and an undeclared provider method with error codes', async () => {
    const ctx = await host()
    await ctx.plugin(CordisInspectProviders)
    await ctx.plugin(CordisInspectTools)
    const signal = new AbortController().signal
    const query = ctx.tools.get('cordis_inspect')
    await expect(query?.execute({ query: { platform: 'host', provider: 'Tool', method: 'listTools' } }, { signal } as never)).rejects.toMatchObject({
      name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE', message: 'Cordis inspection requires an Agent-backed session',
    })
    for (const provider of hostInspectProviders(ctx).filter(candidate => ['Service', 'Runtime', 'Tool'].includes(candidate.manifest.id))) {
      await expect(Promise.resolve().then(() => provider.query('undeclared', undefined, { agent: undefined as never, signal })))
        .rejects.toMatchObject({ name: 'InspectError', code: 'INSPECT_METHOD_NOT_FOUND' })
    }
    await ctx.fiber.dispose()
  })
})

describe('the cordis inspect tool', () => {
  it('declares discovery and valid queries parallel-safe', async () => {
    const ctx = await host()
    const fiber = ctx.plugin(CordisInspectTools)
    await fiber
    const tool = ctx.tools.get('cordis_inspect')
    expect(tool?.isConcurrencySafe?.({})).toBe(true)
    for (const platform of ['host', 'client']) {
      expect(tool?.isConcurrencySafe?.({ query: { platform, provider: 'Service', method: 'listService' } })).toBe(true)
    }
    expect(tool?.isConcurrencySafe?.({ query: {} })).toBe(false)
    await fiber.dispose()
  })
})
