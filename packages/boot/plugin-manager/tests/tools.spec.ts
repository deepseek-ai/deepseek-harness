/** Agent controls use the same manager methods as the Web and bound inventory reads. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { expect, it, onTestFinished, vi } from 'vitest'
import type PluginManager from '../src/index.ts'
import * as tool from '../src/tools.ts'

function resultText(result: Awaited<ReturnType<ToolRuntime['execute']>>): string {
  if (typeof result.value !== 'string') throw new Error('Expected a serialized manager result')
  return result.value
}

async function fixture(mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'danger-full-access', approval?: 'ask' | 'never') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const manager = {
    listPlugins: vi.fn(async () => Array.from({ length: 30 }, (_, i) => ({ entryId: `include:${i}`, enabled: true }))),
    listBundles: vi.fn(async () => [{ name: 'bundle', enabled: true }]),
    setPluginEnabled: vi.fn(async () => ({ changed: true, application: 'applied' })),
    setBundleEnabled: vi.fn(async () => ({ changed: true, application: 'applied' })),
    installBundle: vi.fn(async () => ({ changed: true, application: 'restart-required' })),
    removeBundle: vi.fn(async () => ({ changed: false, application: 'failed' })),
    listVersionExemptions: vi.fn(() => ({ exemptions: { 'example@1.2.3': ['0.1.7-alpha.1'] }, warnings: [] })),
    setVersionExemption: vi.fn(async () => ({ changed: true, application: 'applied' })),
  }
  ctx.provide('pluginManager', manager as unknown as PluginManager)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode })
  if (approval !== undefined) await ctx.plugin(ApprovalService, { policy: approval })
  const fiber = await ctx.plugin(tool)
  const call = (args: unknown, agent?: Agent, signal = new AbortController().signal) => ctx.tools.execute({ name: 'plugin_manager', arguments: args,
    ...agent === undefined ? {} : { agent },
    callId: ToolCallId('manager-call'), signal })
  return { ctx, manager, call, fiber }
}

it.each(['read-only', 'workspace-write'] as const)('denies every management action in %s before accessing the manager', async (mode) => {
  const { call, manager } = await fixture(mode)
  for (const action of ['list_plugins', 'list_bundles', 'set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'list_version_exemptions', 'set_version_exemption']) {
    const result = await call({ action, target: 'bundle', enabled: true })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires approval, but no approval service is composed')
  }
  for (const method of Object.values(manager)) expect(method).not.toHaveBeenCalled()
})

it('preserves selected bundle load errors in the agent list result', async () => {
  const { manager, call } = await fixture()
  const bundles = [{
    name: 'bundle', enabled: true,
    error: { code: 'operation-error', diagnostic: 'bundle patch is unreadable' }, rows: [], overrides: [],
  }]
  manager.listBundles.mockResolvedValue(bundles)
  expect(JSON.parse(resultText(await call({ action: 'list_bundles' })))).toMatchInlineSnapshot(`
    {
      "entries": [
        {
          "enabled": true,
          "error": {
            "code": "operation-error",
            "diagnostic": "bundle patch is unreadable",
          },
          "name": "bundle",
          "overrides": [],
          "rows": [],
        },
      ],
      "nextOffset": null,
      "total": 1,
    }
  `)
})

it('checks the calling session on each execution, including after permission is revoked', async () => {
  const { call, manager } = await fixture()
  const id = SessionId('manager-permissions')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
  const agent = { session } as unknown as Agent
  setSandboxMode(session, 'workspace-write')
  expect((await call({ action: 'list_plugins' }, agent)).isError).toBe(true)
  expect(manager.listPlugins).not.toHaveBeenCalled()
  setSandboxMode(session, 'danger-full-access')
  expect((await call({ action: 'list_plugins' }, agent)).isError).toBe(false)
  setSandboxMode(session, 'read-only')
  expect((await call({ action: 'list_plugins' }, agent)).isError).toBe(true)
  expect(manager.listPlugins).toHaveBeenCalledTimes(1)
})

function activeAgent(): Agent {
  const id = SessionId('manager-approval')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
  session.append('turn/start', { turn: 1 })
  return { session } as unknown as Agent
}

it.each(['read-only', 'workspace-write'] as const)('approves each action once in %s without changing session permissions', async (mode) => {
  const { ctx, call, manager } = await fixture(mode, 'ask')
  const agent = activeAgent()
  const prompted = vi.fn(async () => 'allowed-once' as const)
  const dispose = ctx.on('approval/request', prompted)
  for (const action of ['list_plugins', 'list_bundles', 'set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'list_version_exemptions', 'set_version_exemption']) {
    expect((await call({ action, target: 'bundle@1.0.0', enabled: true, runtimeVersion: '0.1.7-alpha.1', acceptRisk: true }, agent)).isError).toBe(false)
  }
  expect(prompted).toHaveBeenCalledTimes(8)
  for (const method of Object.values(manager)) expect(method).toHaveBeenCalledTimes(1)
  expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe(mode)
  const audit = agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
  expect(audit).toHaveLength(16)
  expect(audit[0]).toMatchObject({ type: 'approval/asked', data: {
    toolName: 'plugin_manager', callId: 'manager-call',
  } })
  const request = audit[0]
  if (request?.type !== 'approval/asked') throw new Error('Expected an approval request')
  expect(request.data.reason).toContain('"action":"list_plugins"')
  expect(audit[1]).toMatchObject({ type: 'approval/decided', data: { outcome: 'allowed-once' } })
  dispose()
  expect((await call({ action: 'list_plugins' }, agent)).isError).toBe(true)
  expect(manager.listPlugins).toHaveBeenCalledTimes(1)
})

it.each(['rejected', 'cancelled', 'unavailable'] as const)('does not mutate the profile when approval is %s', async (outcome) => {
  const { ctx, call, manager } = await fixture('workspace-write', 'ask')
  ctx.on('approval/request', async () => outcome)
  const agent = activeAgent()
  expect((await call({ action: 'install_bundle', target: 'bundle' }, agent)).isError).toBe(true)
  expect(manager.installBundle).not.toHaveBeenCalled()
  expect(agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')
    .map(event => event.data.outcome)).toEqual([outcome])
})

it('rejects never policy without prompting and keeps full-access calls prompt-free', async () => {
  const { ctx, call, manager } = await fixture('workspace-write', 'never')
  const prompted = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', prompted, { prepend: true })
  const agent = activeAgent()
  expect((await call({ action: 'set_plugin', target: 'include:demo', enabled: true }, agent)).isError).toBe(true)
  expect(manager.setPluginEnabled).not.toHaveBeenCalled()
  setSandboxMode(agent.session, 'danger-full-access')
  expect((await call({ action: 'set_plugin', target: 'include:demo', enabled: true }, agent)).isError).toBe(false)
  expect(manager.setPluginEnabled).toHaveBeenCalledTimes(1)
  expect(prompted).not.toHaveBeenCalled()
})

it('cancels an approval wait before any manager operation', async () => {
  const { ctx, call, manager } = await fixture('workspace-write', 'ask')
  const asked = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<ApprovalOutcome>()
  ctx.on('approval/request', () => { asked.resolve(undefined); return answer.promise })
  const controller = new AbortController()
  const result = call({ action: 'install_bundle', target: 'bundle' }, activeAgent(), controller.signal)
  await asked.promise
  expect(manager.installBundle).not.toHaveBeenCalled()
  controller.abort()
  answer.resolve('allowed-once')
  expect((await result).isError).toBe(true)
  expect(manager.installBundle).not.toHaveBeenCalled()
})

it('does not apply a grant when the call was cancelled before dispatch', async () => {
  const { ctx, call, manager } = await fixture('workspace-write', 'ask')
  const controller = new AbortController()
  vi.spyOn(ctx.approval, 'request').mockImplementation(async () => {
    controller.abort()
    return 'allowed-once'
  })
  expect((await call({ action: 'install_bundle', target: 'bundle' }, activeAgent(), controller.signal)).isError).toBe(true)
  expect(manager.installBundle).not.toHaveBeenCalled()
})

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

it('keeps UI translation metadata out of model-facing plugin and bundle lists', async () => {
  const { call, manager } = await fixture()
  const meta = { title: { en: 'Plugin', zh: '插件' }, error: 'UI-only diagnostic' }
  manager.listPlugins.mockImplementationOnce(async () => [{ entryId: 'include:plugin', enabled: true, meta }])
  expect(JSON.parse(resultText(await call({ action: 'list_plugins' })))).toEqual({
    entries: [{ entryId: 'include:plugin', enabled: true }], total: 1, nextOffset: null,
  })
  manager.listBundles.mockImplementationOnce(async () => [{
    name: 'bundle', enabled: true, meta, rows: [{ rowId: 'plugin', moduleName: 'plugin', meta }],
  }])
  expect(JSON.parse(resultText(await call({ action: 'list_bundles' })))).toEqual({
    entries: [{ name: 'bundle', enabled: true, rows: [{ rowId: 'plugin', moduleName: 'plugin' }] }], total: 1, nextOffset: null,
  })
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
  await call({ action: 'install_bundle', target: 'bundle', registry: 'https://registry.npmmirror.com/' })
  expect(manager.installBundle).toHaveBeenLastCalledWith('bundle', { registry: 'https://registry.npmmirror.com/' })
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
  { action: 'set_version_exemption', enabled: true, runtimeVersion: '1.0.0' },
  { action: 'set_version_exemption', target: 'plugin@1.0.0', enabled: true },
  { action: 'set_version_exemption', target: 'plugin@1.0.0', runtimeVersion: '1.0.0' },
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
