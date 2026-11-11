/** Windows provider registration through the Loader without an interactive desktop. */
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, onTestFinished } from 'vitest'
import * as WindowsProvider from '../src/index.ts'

it.skipIf(process.platform !== 'win32')('loads the Windows provider and rejects a numeric window ID before native dispatch', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(SubprocessLocal)
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'windows-provider': WindowsProvider })
  await ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/provider.yml', import.meta.url).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'windows-provider')
  if (!entry?.fiber) throw new Error('Loader did not activate the Windows provider')
  await entry.fiber.await()
  const { agent } = await ctx.agents.create({ sessionId: SessionId('cua-windows-loader') })
  expect(ctx.tools.get('cua', agent)).toBeDefined()
  const prompt = await ctx.systemPrompt.assemble({ scope: agent })
  expect(prompt.sections.find(section => section.name === 'computer-use:dsh-cua')?.text).toContain('Windows:')
  const batch = await ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{
    type: 'tool-call', id: ToolCallId('invalid-window'), name: 'cua',
    arguments: JSON.stringify({ method: 'screenshot', params: { appHandle: 'app', windowId: 7 } }),
  }] })
  expect(batch.results[0]?.result.isError).toBe(true)
  expect(JSON.stringify(batch.results[0]?.result.content)).toContain('string')
  await entry.fiber.dispose()
  expect(ctx.tools.get('cua', agent)).toBeUndefined()
})
