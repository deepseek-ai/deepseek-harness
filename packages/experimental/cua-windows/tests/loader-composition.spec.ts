/** Windows provider registration through the Loader without an interactive desktop. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import type { NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as WindowsProvider from '../src/index.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const native = vi.hoisted(() => ({ request: vi.fn<NativeClient['request']>() }))
vi.mock('@deepseek-ai/dsh-cua/native-client', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-cua/native-client')>(),
  NativeClient: class {
    disposed = false
    request = native.request
    async dispose() { this.disposed = true }
  },
}))

it.skipIf(process.platform !== 'win32')('loads the Windows provider, rejects invalid input, and forwards application searches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cua-windows-loader-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
  })
  const configPath = join(directory, 'provider.yml')
  await writeFile(configPath, await readFile(new URL('./fixtures/provider.yml', import.meta.url)))
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(SubprocessLocal)
  ctx.baseUrl = `${pathToFileURL(directory).href}/`
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'windows-provider': WindowsProvider })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'windows-provider')
  if (!entry?.fiber) throw new Error('Loader did not activate the Windows provider')
  await entry.fiber.await()
  const { agent } = await ctx.agents.create({ sessionId: brandString<SessionId>('cua-windows-loader') })
  expect(ctx.tools.get('cua', agent)).toBeDefined()
  const prompt = await ctx.systemPrompt.assemble({ scope: agent })
  const promptText = prompt.sections.find(section => section.name === 'computer-use:dsh-cua')?.text
  if (promptText === undefined) throw new Error('Windows CUA prompt section is missing')
  expect(promptText).toContain('Windows:')
  expect(promptText).not.toContain('useSystemInput')
  expect(promptText).toContain('a system reminder lists any remaining keys and mouse buttons')
  const toggleMouse = promptText.split('\n').find(line => line.startsWith('- toggleMouse('))
  expect(toggleMouse).toContain("toggleMouse(mouseButton: 'left' | 'right' | 'middle', direction: 'down' | 'up') -> ActionResult")
  expect(toggleMouse).toContain("Send 'up' to release a held button immediately.")
  expect(toggleMouse).toContain('press or release the specified mouse button at the current pointer position without moving it.')
  expect(toggleMouse).not.toContain('Not implemented')
  expect(`${promptText}\n`).toBe(await readFile(new URL('./fixtures/provider-prompt.expected.md', import.meta.url), 'utf8'))
  expect(JSON.stringify(ctx.tools.get('cua', agent)!.parameters)).not.toContain('useSystemInput')
  const batch = await ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{
    type: 'tool-call', id: brandString<ToolCallId>('invalid-window'), name: 'cua',
    arguments: JSON.stringify({ method: 'screenshot', params: { appHandle: 'app', windowId: 7 } }),
  }, {
    type: 'tool-call', id: brandString<ToolCallId>('unsupported-pointer'), name: 'cua',
    arguments: JSON.stringify({ method: 'drag', params: { appHandle: 'app', windowId: '7', fromX: 1, fromY: 1,
      toX: 2, toY: 2, useSystemInput: true } }),
  }] })
  expect(batch.results[1]?.result.isError).toBe(true)
  expect(JSON.stringify(batch.results[1]?.result.content)).toContain('useSystemInput')
  expect(batch.results[0]?.result.isError).toBe(true)
  expect(JSON.stringify(batch.results[0]?.result.content)).toContain('string')
  const apps = [
    { id: 'Fixture.Editor!App', displayName: 'Editor One', identity: null, isRunning: false },
    { id: 'C:\\Tools\\Editor.exe', displayName: 'Editor Two', identity: null, isRunning: true },
  ]
  native.request.mockResolvedValueOnce([apps[0]!, { ...apps[1]!, pid: 4120 }])
  const callId = brandString<ToolCallId>('find-apps')
  const found = await ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{
    type: 'tool-call', id: callId, name: 'cua',
    arguments: JSON.stringify({ method: 'findApps', params: { query: 'Editor' } }),
  }] })
  expect(found.results).toHaveLength(1)
  expect(found.results[0]!.result.isError).toBe(false)
  expect(found.results[0]!.result.value).toEqual(apps)
  expect(native.request).toHaveBeenCalledExactlyOnceWith('findApps',
    { query: 'Editor', maxAppMatches: 20 }, expect.any(AbortSignal), callId)
  for (const query of ['', null]) {
    native.request.mockResolvedValueOnce(apps)
    const allCallId = brandString<ToolCallId>(query === null ? 'all-apps-null' : 'all-apps-empty')
    const all = await ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{
      type: 'tool-call', id: allCallId, name: 'cua', arguments: JSON.stringify({ method: 'findApps', params: { query } }),
    }] })
    expect(all.results[0]!.result.isError).toBe(false)
    expect(all.results[0]!.result.value).toEqual(apps)
    expect(native.request).toHaveBeenLastCalledWith('findApps', { query, maxAppMatches: 20 }, expect.any(AbortSignal), allCallId)
  }
  const requestsBeforeLaunch = native.request.mock.calls.length
  const deniedLaunch = await ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{
    type: 'tool-call', id: brandString<ToolCallId>('launch-without-consent'), name: 'cua',
    arguments: JSON.stringify({ method: 'launchApp', params: { appHandle: 'unselected-app' } }),
  }] })
  expect(deniedLaunch.results[0]!.result.isError).toBe(true)
  expect(JSON.stringify(deniedLaunch.results[0]!.result.content)).toContain('APP_ACCESS_REQUIRED')
  expect(native.request).toHaveBeenCalledTimes(requestsBeforeLaunch)
  await entry.fiber.dispose()
  expect(ctx.tools.get('cua', agent)).toBeUndefined()
})
