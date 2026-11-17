/** Directory discovery and exact queries through one model-facing tool. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CordisInspectRegistryService } from '@deepseek-ai/dsh-cordis-host-runner'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as ToolCordis from '../src/index.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(CordisInspectRegistryService, 10_000)
  const fiber = await ctx.plugin(ToolCordis)
  const tool = ctx.tools.get('cordis_inspect')!
  const exec = { signal: new AbortController().signal } as ToolRunContext
  return { ctx, fiber, tool, exec }
}

it('lists providers without query and withdraws its single registration on disposal', async () => {
  const { ctx, fiber, tool, exec } = await fixture()
  expect(ctx.tools.schemas().map(row => row.name)).toEqual(['cordis_inspect'])
  const value = { providers: [] }
  expect(await tool.execute({}, exec)).toEqual(value)
  expect(tool.output.render({}, value)).toEqual([{ type: 'text', text: JSON.stringify(value, null, 2) }])
  expect(tool.presentCall?.({})).toMatchObject({ kind: 'read', title: 'List Cordis Inspect Providers' })
  await fiber.dispose()
  expect(ctx.tools.schemas()).toEqual([])
})

it.each(['host', 'client'])('forwards the %s query, Agent, and cancellation signal', async (platform) => {
  const { ctx, tool, exec } = await fixture()
  const agent = { ctx } as Agent
  const dispatch = vi.spyOn(ctx.cordisInspect, 'query').mockResolvedValue({ answer: 42 })
  const query = { platform, provider: 'Service', method: 'listService', input: { service: 'tools' } }
  expect(await tool.execute({ query }, { ...exec, agent })).toEqual({ platform, provider: 'Service', method: 'listService', data: { answer: 42 } })
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(platform, 'Service', 'listService', query.input, agent, exec.signal)
  expect(tool.presentCall?.({ query })).toMatchObject({ kind: 'read', title: `Query Cordis ${platform} Service.listService` })
})

it('requires an Agent for a query but not for discovery', async () => {
  const { tool, exec } = await fixture()
  await expect(tool.execute({ query: { platform: 'host', provider: 'Service', method: 'listService' } }, exec))
    .rejects.toThrow('Cordis inspection requires an Agent-backed session')
})

it.each([null, {}, { platform: 'host', provider: 'Service' }, { platform: 'other', provider: 'Service', method: 'listService' }])(
  'rejects a malformed query before dispatch: %j', async (query) => {
    const { ctx, tool, exec } = await fixture()
    const dispatch = vi.spyOn(ctx.cordisInspect, 'query')
    await expect(tool.execute({ query }, exec)).rejects.toThrow()
    expect(dispatch).not.toHaveBeenCalled()
  },
)
