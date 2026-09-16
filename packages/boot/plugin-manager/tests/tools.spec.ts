/** Agent controls use the same manager methods as the Web and bound inventory reads. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import type PluginManager from '../src/index.ts'
import * as tool from '../src/tools.ts'

function resultText(result: Awaited<ReturnType<ToolRuntime['execute']>>): string {
  if (typeof result.value !== 'string') throw new Error('Expected a serialized manager result')
  return result.value
}

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const manager = {
    listPlugins: vi.fn(async () => Array.from({ length: 30 }, (_, i) => ({ entryId: `include:${i}`, enabled: true }))),
    listBundles: vi.fn(async () => [{ name: 'bundle', enabled: true }]),
    setPluginEnabled: vi.fn(async () => ({ changed: true, application: 'applied' })),
    setBundleEnabled: vi.fn(async () => ({ changed: true, application: 'applied' })),
    installBundle: vi.fn(async () => ({ changed: true, application: 'restart-required' })),
    removeBundle: vi.fn(async () => ({ changed: false, application: 'failed' })),
  }
  ctx.provide('pluginManager', manager as unknown as PluginManager)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(tool)
  const call = (args: unknown) => ctx.tools.execute({ name: 'plugin_manager', arguments: args,
    callId: ToolCallId('manager-call'), signal: new AbortController().signal })
  return { ctx, manager, call, fiber }
}

it('paginates inventories with an explicit continuation and total', async () => {
  const { call } = await fixture()
  const first = await call({ action: 'list_plugins' })
  expect(first.isError).toBe(false)
  expect(JSON.stringify(first.content)).toContain('nextOffset')
  expect(JSON.parse(resultText(first))).toMatchObject({ nextOffset: 25, total: 30 })
  const last = await call({ action: 'list_plugins', offset: 25, limit: 10 })
  expect(JSON.parse(resultText(last))).toMatchObject({ nextOffset: null, total: 30 })
  expect(resultText(await call({ action: 'list_bundles' }))).toContain('"name":"bundle"')
})

it('forwards all mutation actions and renders the returned outcome', async () => {
  const { call, manager } = await fixture()
  await call({ action: 'set_plugin', target: 'include:1', enabled: false })
  expect(manager.setPluginEnabled).toHaveBeenCalledWith('include:1', false)
  await call({ action: 'set_bundle', target: 'bundle', enabled: true })
  expect(manager.setBundleEnabled).toHaveBeenCalledWith('bundle', true)
  await call({ action: 'install_bundle', target: 'bundle' })
  expect(manager.installBundle).toHaveBeenLastCalledWith('bundle', {})
  await call({ action: 'install_bundle', target: 'bundle', enabled: false })
  expect(manager.installBundle).toHaveBeenLastCalledWith('bundle', { enabled: false })
  await call({ action: 'install_bundle', target: 'bundle', approvedBuilds: ['native'] })
  expect(manager.installBundle).toHaveBeenLastCalledWith('bundle', { approvedBuilds: ['native'] })
  expect(resultText(await call({ action: 'remove_bundle', target: 'bundle' }))).toContain('"application":"failed"')
  expect(manager.removeBundle).toHaveBeenCalledWith('bundle')
})

it.each([
  { action: 'unknown_action' },
  { action: 'list_plugins', offset: -1 },
  { action: 'list_plugins', offset: 0.5 },
  { action: 'list_bundles', limit: 101 },
  { action: 'list_bundles', limit: 0 },
  { action: 'list_bundles', limit: 1.5 },
  { action: 'set_plugin', enabled: true },
  { action: 'set_bundle', target: 'bundle' },
  { action: 'install_bundle' }, { action: 'remove_bundle' },
])('rejects incomplete or unbounded tool inputs: %j', async (args) => {
  const { call } = await fixture()
  expect((await call(args)).isError).toBe(true)
})

it('presents reads and changes distinctly and disposes its registration', async () => {
  const { ctx, fiber } = await fixture()
  const definition = ctx.tools.get('plugin_manager')!
  expect(definition.presentCall?.({ action: 'list_plugins' })).toMatchObject({ kind: 'read' })
  expect(definition.presentCall?.({ action: 'remove_bundle', target: 'bundle' })).toMatchObject({ kind: 'other' })
  await fiber.dispose()
  expect(ctx.tools.get('plugin_manager')).toBeUndefined()
})
