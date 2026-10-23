/** Independent spawn presets and compatibility of persisted child compositions. */
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, { SUBAGENT_DESCRIPTOR_VERSION, snapshotSubagentDescriptor } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession } from './persistence-helpers.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/activation-presets')
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** Real preset mounts, Agent lifecycle, and persistence with a scripted model. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-continuation-presets-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(fixtures).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  const presets = await ctx.plugin(AgentPresets, { default: 'coding' })
  const unregister = new Map<string, () => Promise<void>>()
  for (const [id, tool] of [['coding', 'preset_only'], ['reviewing', 'reviewing_only']] as const) {
    unregister.set(id, await ctx.agentPresets.register({
      id,
      plugins: [{ name: pathToFileURL(join(fixtures, 'plugins/preset-tool.js')).href, config: { tool } }],
    }))
  }
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const spawn = await ctx.plugin(SubagentSpawn, { providerName: 'separate' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  const adapter = new MockAdapter([textResponse('done'), textResponse('continued'), textResponse('done again')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('parent'),
    meta: { agentPreset: 'coding' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'coding') },
  })
  return { ctx, parent: handle.agent, adapter, spawn, presets, unregister }
}

/** Settlement messages must not consume responses scripted for the child. */
function parkParent(ctx: Context, parent: Agent): void {
  ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject' } : next())
}

function startSpec(parent: Agent, agentPreset?: string, provider = 'separate') {
  return {
    provider,
    label: 'preset work',
    delivery: 'parent' as const,
    request: {
      parent,
      prompt: [{ type: 'text' as const, text: 'work' }],
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
    signal: new AbortController().signal,
  }
}

async function settled(ctx: Context, childId: SessionId) {
  await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() })
  return loadStoredSession(ctx.sessionPersistence, childId)
}

function continueChild(ctx: Context, parent: Agent, childId: SessionId) {
  return queueHostSubagentPrompt(
    ctx.subagents, parent, childId,
    [{ type: 'text', text: 'continue' }], { kind: 'user' }, new AbortController().signal,
  )
}

describe('child preset start validation', () => {
  it('rejects an explicit same-as-parent preset before starting a fork', async () => {
    const { ctx, parent, adapter } = await setup()
    const beforeSessions = ctx.sessions.list().length
    const beforeEvents = parent.session.snapshotEvents()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('subagent/start', () => void published.push('subagent/start'))
    const spec = startSpec(parent, 'coding', 'fork')

    const starting = ctx.subagents.startActivation(spec)

    await expect(starting).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'subagent provider "fork" does not support independent agent preset selection',
    })
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
    expect(parent.session.snapshotEvents()).toEqual(beforeEvents)
    expect(published).toEqual([])
    expect(adapter.requests).toEqual([])
  })

  it('rolls back an independent spawn when the preset service has unloaded', async () => {
    const { ctx, parent, adapter, presets } = await setup()
    await presets.dispose()
    expect(ctx.get('agentPresets')).toBeUndefined()
    const beforeSessions = ctx.sessions.list().length
    const beforeEvents = parent.session.snapshotEvents()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('session/disposed', () => void published.push('session/disposed'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('subagent/start', () => void published.push('subagent/start'))
    const spec = startSpec(parent, 'reviewing')

    await expect(ctx.subagents.startActivation(spec)).rejects.toMatchObject({
      code: 'PRESET_UNAVAILABLE',
      message: 'selecting a child agent preset requires the agent-presets service',
    })
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
    expect(parent.session.snapshotEvents()).toEqual(beforeEvents)
    expect(published).toEqual(['session/created', 'session/disposed'])
    expect(adapter.requests).toEqual([])
  })
})

describe('continuable child presets', () => {
  it('records an independent selection before its descriptor and sends only the selected preset tools', async () => {
    const { ctx, parent, adapter } = await setup()
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation(startSpec(parent, 'reviewing'))
    const stored = await settled(ctx, started.childId)

    expect(stored.meta.agentPreset).toBe('reviewing')
    const own = stored.events.slice(stored.inheritedEventCount)
    const selected = own.findIndex(event => event.type === 'agent-preset/selected')
    const descriptor = own.findIndex(event => event.type === 'subagent/descriptor')
    expect(selected).toBeGreaterThanOrEqual(0)
    expect(selected).toBeLessThan(descriptor)
    expect(descriptor).toBeLessThan(own.findIndex(event => event.type === 'turn/start'))
    expect(own[descriptor]?.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'separate',
      label: 'preset work',
      agentProvider: 'mock',
      agentModel: 'mock',
    })
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['reviewing_only'])
    expect(ctx.tools.schemas(parent).map(tool => tool.name)).toEqual(['preset_only'])
  })

  it('restores an explicit same-as-parent selection after the parent switches and the provider unloads', async () => {
    const { ctx, parent, adapter, spawn } = await setup()
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation(startSpec(parent, 'coding'))
    await settled(ctx, started.childId)
    await ctx.agentPresets.recompose(parent.ctx, 'reviewing')
    await spawn.dispose()
    expect(ctx.subagents.getProvider('separate')).toBeUndefined()

    await continueChild(ctx, parent, started.childId)
    const stored = await settled(ctx, started.childId)
    expect(adapter.requests.map(request => request.tools?.map(tool => tool.name)))
      .toEqual([['preset_only'], ['preset_only']])
    expect(stored.events.filter(event => event.type === 'agent-preset/selected')).toHaveLength(1)
    expect(stored.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    expect(ctx.tools.schemas(parent).map(tool => tool.name)).toEqual(['reviewing_only'])
  })

  it('restores the latest projected selection when it differs from the creation header', async () => {
    const { ctx, parent, adapter } = await setup()
    parkParent(ctx, parent)
    const stopSelecting = ctx.on('agent/created', async ({ agent, source }) => {
      if (source === 'startup' && agent.session.header.parentSession === parent.id) {
        await ctx.agentPresets.select(agent, 'reviewing')
      }
    })
    const started = await ctx.subagents.startActivation(startSpec(parent, 'coding'))
    const created = await settled(ctx, started.childId)
    stopSelecting()
    expect(created.meta.agentPreset).toBe('coding')
    expect(created.events.flatMap(event => event.type === 'agent-preset/selected' ? [event.data.agentPreset] : []))
      .toEqual(['coding', 'reviewing'])

    await continueChild(ctx, parent, started.childId)
    await settled(ctx, started.childId)
    expect(adapter.requests.map(request => request.tools?.map(tool => tool.name)))
      .toEqual([['reviewing_only'], ['reviewing_only']])
  })

  it.each([undefined, 'coding'])('restores historical children with header preset %s through the current parent', async (agentPreset) => {
    const { ctx, parent, adapter } = await setup()
    parkParent(ctx, parent)
    const childId = SessionId('historical-child')
    const historical = await ctx.agents.create({
      sessionId: childId,
      parentAgent: parent,
      meta: {
        parentSession: parent.id,
        origin: 'subagent',
        delegationDepth: 1,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      },
      setup: (childCtx, child) => {
        child.session.append('subagent/descriptor', snapshotSubagentDescriptor({
          mode: 'continuable', provider: 'separate', label: 'historical',
          agentProvider: 'mock', agentModel: 'mock', persona: 'Historical child persona.',
          toolFilter: { deny: ['reviewing_only'] },
        }))
        ctx.agentPresets.composeFrom(childCtx, parent.ctx)
      },
    })
    await historical.dispose()
    await ctx.agentPresets.recompose(parent.ctx, 'reviewing')

    await continueChild(ctx, parent, childId)
    const stored = await settled(ctx, childId)
    expect(stored.meta.agentPreset).toBe(agentPreset)
    expect(stored.events.some(event => event.type === 'agent-preset/selected')).toBe(false)
    expect((adapter.requests[0]?.tools ?? []).map(tool => tool.name)).toEqual([])
    expect(JSON.stringify(adapter.requests[0]?.messages.filter(message => message.role === 'system')))
      .toContain('Historical child persona.')
  })

  it('keeps an empty-history fork on the parent composition when its own selection follows the descriptor', async () => {
    const { ctx, parent, adapter } = await setup()
    parkParent(ctx, parent)
    const stopSelecting = ctx.on('agent/created', async ({ agent, source }) => {
      if (source === 'startup' && agent.session.header.parentSession === parent.id) {
        await ctx.agentPresets.select(agent, 'reviewing')
      }
    })
    const started = await ctx.subagents.startActivation(startSpec(parent, undefined, 'fork'))
    const created = await settled(ctx, started.childId)
    stopSelecting()
    expect(created.meta.isSeeded).toBe(false)
    expect(created.inheritedEventCount).toBe(0)
    expect(created.events.findIndex(event => event.type === 'agent-preset/selected'))
      .toBeGreaterThan(created.events.findIndex(event => event.type === 'subagent/descriptor'))

    await continueChild(ctx, parent, started.childId)
    await settled(ctx, started.childId)
    expect(adapter.requests.map(request => request.tools?.map(tool => tool.name)))
      .toEqual([['reviewing_only'], ['preset_only']])
  })

  it('ignores inherited selections when resuming a fork whose parent still owns a retired preset generation', async () => {
    const { ctx, parent, adapter, unregister } = await setup()
    await ctx.agentPresets.select(parent, 'reviewing')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent work' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation(startSpec(parent, undefined, 'fork'))
    const created = await settled(ctx, started.childId)
    expect(created.events.slice(0, created.inheritedEventCount).some(event => event.type === 'agent-preset/selected')).toBe(true)
    expect(created.events.slice(created.inheritedEventCount).some(event => event.type === 'agent-preset/selected')).toBe(false)
    await unregister.get('reviewing')!()

    await continueChild(ctx, parent, started.childId)
    await settled(ctx, started.childId)
    expect(adapter.requests.map(request => request.tools?.map(tool => tool.name)))
      .toEqual([['reviewing_only'], ['reviewing_only'], ['reviewing_only']])
  })

  it.each(['missing', 'broken'] as const)('refuses an independent cold resume when its preset is %s', async (failure) => {
    const { ctx, parent, adapter, unregister } = await setup()
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation(startSpec(parent, 'reviewing'))
    const created = await settled(ctx, started.childId)
    await unregister.get('reviewing')!()
    if (failure === 'broken') {
      await ctx.agentPresets.register({ id: 'reviewing', plugins: [{ name: 'cordis:missing-plugin' }] })
    }

    await expect(continueChild(ctx, parent, started.childId)).rejects.toMatchObject({
      code: 'NOT_RESUMABLE',
      cause: { code: failure === 'missing' ? 'agent-preset/not-found' : 'agent-preset/invalid' },
    })
    const stored = await settled(ctx, started.childId)
    expect(adapter.requests).toHaveLength(1)
    expect(stored.events.slice(0, created.events.length)).toEqual(created.events)
    expect(stored.events.slice(created.events.length)).toMatchObject([{ type: 'session/end-seed', data: {} }])
    expect(ctx.tools.schemas(parent).map(tool => tool.name)).toEqual(['preset_only'])
  })

  it('refuses independent restoration when the preset projection is unavailable', async () => {
    const { ctx, parent, adapter, presets } = await setup()
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation(startSpec(parent, 'reviewing'))
    await settled(ctx, started.childId)
    await presets.dispose()

    await expect(continueChild(ctx, parent, started.childId)).rejects.toMatchObject({
      code: 'NOT_RESUMABLE',
      message: `subagent "${started.childId}" has no agent preset projection for restoration`,
    })
    expect(ctx.agents.get(started.childId)).toBeUndefined()
    expect(adapter.requests).toHaveLength(1)
  })
})
