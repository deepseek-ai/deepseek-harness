import { createRequire } from 'node:module'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { queryServiceApi } from '../src/api-catalog.ts'
import DynamicCordisRunnerService from '../src/index.ts'
import { hostInspectProviders } from '../src/inspect-providers.ts'

/**
 * The runner registers the first-party Host inspect providers once per
 * process beside its inspection registry. Several presets that mount
 * `tool-cordis` over the shared registry are covered by
 * `apps/cli/tests/web-agent-presets.e2e.ts`.
 */

async function host(): Promise<Context> {
  const ctx = new Context()
  // The tool registry injects `systemPrompt`; nothing under test registers a prompt section.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(NativeToolRegistry)
  return ctx
}

describe('the first-party Host inspect providers', () => {
  it('exposes Schedule submission, candidate text, and persistence acknowledgement', () => {
    const result = queryServiceApi('schedule')
    const acknowledgement: unknown = expect.stringContaining(
      'Resolves when the Session inbox and task receipt are both persisted, not when the model responds.',
    )
    expect(result).toHaveProperty('service.access.hardDependency', {
      inject: ['schedule'], expression: 'ctx.schedule',
    })
    expect(result).toHaveProperty('service.methods', expect.arrayContaining([expect.objectContaining({
      signature: 'async submit(id: ScheduleId, candidate: AutomationCandidate): Promise<void>',
      returns: acknowledgement,
    })]))
    const declaration: unknown = expect.stringMatching(/\breadonly text:\s*string;/)
    expect(result).toHaveProperty('referencedTypes', expect.arrayContaining([expect.objectContaining({
      name: 'AutomationCandidate', declaration,
    })]))
  })

  it('registers with the runner and withdraws on disposal', async () => {
    const ctx = await host()
    const fiber = ctx.plugin(DynamicCordisRunnerService, {})
    await fiber
    const registry = ctx.cordisInspect

    expect(registry.list().map(provider => provider.id)).toEqual(['Service', 'Event', 'Config', 'Runtime', 'Tool'])

    await fiber.dispose()
    expect(registry.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('answers the Runtime version query with the running DSH version', async () => {
    const ctx = await host()
    await ctx.plugin(DynamicCordisRunnerService, {})
    const agent = { ctx } as never
    const signal = new AbortController().signal
    expect(await ctx.cordisInspect.query('host', 'Runtime', 'getVersion', undefined, agent, signal)).toEqual({ version: (createRequire(import.meta.url)('@deepseek-ai/dsh-app-boot/package.json') as { version: string }).version })
    await ctx.fiber.dispose()
  })

  it('lists the tools an Agent can call directly from its root', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const tool = (name: string): ToolDefinition => defineTool({
      name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve(name),
    })
    ctx.tools.register(tool('read'))
    const program = tool('program')
    ctx.tools.setRoot({ register: () => () => {}, include: () => () => {}, get: name => name === 'program' ? program : undefined, getAll: () => [program] })
    const provider = hostInspectProviders(ctx).find(candidate => candidate.manifest.id === 'Tool')!
    const listed = await provider.query('listTools', undefined, { agent: undefined as never, signal: new AbortController().signal }) as { tools: { name: string }[] }
    // A root that binds tools in programs offers only its program entry.
    expect(listed.tools.map(entry => entry.name)).toEqual(['program'])
    await ctx.fiber.dispose()
  })

  it('reports an undeclared provider method with an error code', async () => {
    const ctx = await host()
    const signal = new AbortController().signal
    for (const provider of hostInspectProviders(ctx).filter(candidate => ['Service', 'Runtime', 'Tool'].includes(candidate.manifest.id))) {
      await expect(Promise.resolve().then(() => provider.query('undeclared', undefined, { agent: undefined as never, signal })))
        .rejects.toMatchObject({ name: 'InspectError', code: 'INSPECT_METHOD_NOT_FOUND' })
    }
    await ctx.fiber.dispose()
  })
})
