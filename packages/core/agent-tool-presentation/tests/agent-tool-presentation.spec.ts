/**
 * The row an agent preset carries to pick its tool presentation. What it owes
 * its caller: the choice reaches THIS agent and no other, it unwinds with the
 * agent, and PTC selection waits for a runtime before replacing the
 * inherited executor.
 */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import ToolRuntime, { RUN_CODE_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, Config, inject, name } from '@deepseek-ai/dsh-agent-tool-presentation'

/** A runtime that never runs anything: presentation never dispatches. */
class StubRuntime extends PtcRuntime {
  resolve(request: import('@deepseek-ai/dsh-ptc-runtime').PtcRunRequest): import('@deepseek-ai/dsh-ptc-runtime').PtcRunSpec { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 } }

  readonly language = 'typescript'
  readonly isolation = 'stub'

  run(_request: PtcRunRequest): Promise<PtcRunResult> {
    return Promise.resolve({ logs: [] })
  }
}

/** A host plane with one tool, optionally carrying a PTC runtime. */
async function host(options: { runtime?: boolean } = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  if (options.runtime !== false) await ctx.plugin(StubRuntime)
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'Echo tool.',
    parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => Promise.resolve(args.value),
  }))
  return ctx
}

/** Mount the row under one agent's scope, as a preset subtree does. */
// oxlint-disable-next-line typescript/no-deprecated -- Exercise the supported compatibility plugin configuration.
async function mount(ctx: Context, config: Config, id = 'agent') {
  const agent = { id: SessionId(id) } as Agent
  let inner!: Context
  const fiber = ctx.plugin(Object.assign((host: Context) => {
    inner = createScope(host, agent).ctx
  }, { inject: ['tools', 'systemPrompt'] }))
  await fiber.await()
  const row = inner.plugin({ name, inject: [...inject], Config, apply }, config)
  await row.await()
  return { agent, fiber, row }
}

describe('the tool-presentation row', () => {
  it('rejects an unsupported presentation mode in configuration', () => {
    // oxlint-disable-next-line typescript/no-deprecated -- The compatibility schema must reject unsupported modes.
    expect(() => Config({ mode: 'both' } as never)).toThrow()
  })

  it('declares the services it uses without holding a PTC runtime hostage', () => {
    // Native execution does not require a program runtime.
    expect(inject).toEqual(['tools'])
  })

  it('gives its own agent PTC mode and leaves the rest native', async () => {
    const ctx = await host()
    const coded = await mount(ctx, { mode: 'ptc' }, 'coded')
    const plain = await mount(ctx, { mode: 'native' }, 'plain')

    const codedAssembly = await ctx.systemPrompt.assemble({ scope: coded.agent })
    const plainAssembly = await ctx.systemPrompt.assemble({ scope: plain.agent })

    expect(codedAssembly.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    expect(codedAssembly.sections.find(section => section.name === 'tools:sdk')?.text).toContain('echo')
    expect(plainAssembly.tools.map(tool => tool.name)).toEqual(['echo'])
  })

  it('rejects the selected scope after its provider unloads', async () => {
    const ctx = await host()
    const { agent, row } = await mount(ctx, { mode: 'ptc' })

    await row.dispose()

    await expect(ctx.systemPrompt.assemble({ scope: agent })).rejects.toThrow('selected tool executor is unavailable')
  })

  it('keeps the inherited executor while waiting for a PTC runtime', async () => {
    const ctx = await host({ runtime: false })

    const { agent, row } = await mount(ctx, { mode: 'ptc' })

    expect(row.ctx.get('ptcRuntime')).toBeUndefined()
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['echo'])
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
  })

  it('applies once the runtime arrives', async () => {
    const ctx = await host({ runtime: false })
    const { agent } = await mount(ctx, { mode: 'ptc' })

    await ctx.plugin(StubRuntime)

    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
  })

  it('requires a mode rather than defaulting one', () => {
    // An omitted value would mean the row was composed for nothing: a preset
    // without this row already gets the deployment default.
    // oxlint-disable-next-line typescript/no-deprecated -- The compatibility schema still requires an explicit mode.
    expect(() => Config({} as never)).toThrow()
  })
})
