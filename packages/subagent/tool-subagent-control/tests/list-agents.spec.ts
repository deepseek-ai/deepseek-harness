import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'
import { parkParent } from './park-parent.ts'
import { TestSessionQuery } from './test-session-query.ts'

/** One scripted response that may wait on a caller-released gate before streaming. */
interface GatedEntry {
  chunks: StreamChunk[]
  gate?: Promise<undefined>
}

/** Adapter whose entries can hold a model call open until the test releases it. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const testToolSignal = new AbortController().signal

const roots: string[] = []
const contexts = new Set<Context>()
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setupWith(adapter: MockAdapter | GatedAdapter) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-list-agents-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(tool)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  parkParent(ctx, parent)
  return { ctx, parent, adapter }
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  return setupWith(new MockAdapter(script))
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: unknown,
  signal: AbortSignal = testToolSignal,
) {
  return executeToolFixture(ctx, {
    signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

/** Wait until a continuable child released its current Activation. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

describe('list_agents', () => {
  it('lists a settled caller-delivery local child by name', async () => {
    const { ctx, parent } = await setup([textResponse('private result')])
    const started = await ctx.subagents.startActivation({
      delivery: 'caller', provider: 'spawn', label: 'workflow child',
      prompt: [{ type: 'text', text: 'child task' }], parent,
      signal: testToolSignal,
    })
    await started.result
    await started.dispose()

    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('lead [inactive] — root agent\nagent-1 [inactive] — workflow child')
    expect(result.isError ? undefined : result.value).toEqual([
      { name: 'lead', status: 'inactive', description: 'root agent' },
      { name: 'agent-1', status: 'inactive', description: 'workflow child' },
    ])
  })

  it('omits external leaves without diagnostics', async () => {
    const { ctx, parent } = await setup([])
    parent.session.append('subagent/catalog', {
      version: 2, childId: SessionId('external-child'), childCreatedAt: 1,
      mode: 'external', label: 'external child',
    })
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('lead [inactive] — root agent')
  })

  it('registers list_agents once, globally, without parameters', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'list_agents')
    expect(schemas).toHaveLength(1)
    const parameters = schemas[0]!.parameters as {
      properties?: Record<string, { enum?: string[]; description?: string }>
      required?: string[]
    }
    expect(Object.keys(parameters.properties ?? {})).toEqual([])
    expect(parameters.required ?? []).toEqual([])
    expect(schemas[0]?.description).toContain('You can message any other agent in the subagent tree')
    expect(ctx.tools.get('list_agents')?.isConcurrencySafe?.({})).toBe(true)
  })

  it('renders the Lead when the tree has no children', async () => {
    const { ctx, parent } = await setup([])
    await ctx.sessions.flush(parent.session)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('lead [inactive] — root agent')
  })

  it('renders direct children in array order with registry statuses', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startActivation({ delivery: 'parent',
      provider: 'spawn',
      label: 'real child',
      prompt: [{ type: 'text', text: 'child task' }], parent,
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    // Pin the render deterministically past the service: the tool is a thin
    // adapter, so its fixed text forms are what this test pins. Status comes
    // from the live Agent registry, stubbed per candidate id.
    const entries = [
      {
        id: SessionId('one-shot-child'),
        createdAt: 1,
        label: 'finished once',
        mode: 'one-shot',
      },
      {
        id: started.childId,
        createdAt: 2,
        label: 'real child',
        mode: 'continuable',
      },
      {
        id: SessionId('running-child'),
        createdAt: 3,
        label: 'still working',
        mode: 'continuable',
        name: 'runner',
      },
      {
        id: SessionId('waiting-child'),
        createdAt: 4,
        label: 'waiting on descendants',
        mode: 'continuable',
      },
    ] satisfies SubagentCatalogEntry[]
    ctx.subagents.listDescendants = () => Promise.resolve(entries.map(entry => ({
      ...entry, kind: 'child' as const, activity: 'inactive' as const, hasChildren: false,
      parentId: parent.id, depth: 1, ...'name' in entry ? { path: entry.name } : {},
    })))
    const agents = new Map<string, {
      status: 'running' | 'idle'
    }>([
      ['running-child', { status: 'running' }],
      ['waiting-child', { status: 'idle' }],
    ])
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === parent.id ? parent : agents.get(id) as never)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'lead [inactive] — root agent\n'
      + `${started.childId} [inactive] — real child\n`
      + 'runner [running] — still working\n'
      + 'waiting-child [inactive] — waiting on descendants',
    )
  })

  it('always lists descendants and forwards the caller id and cancellation signal', async () => {
    const { ctx, parent } = await setup([])
    const signal = new AbortController().signal
    const listDescendants = vi.spyOn(ctx.subagents, 'listDescendants').mockResolvedValue([])

    const result = await callTool(ctx, 'list_agents', {}, parent, signal)

    expect(result.isError).toBe(false)
    expect(listDescendants).toHaveBeenCalledWith(parent.id, signal)
  })

  it('reports an unreadable historical branch alongside a settled continuable child', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    parent.session.append('subagent/catalog', {
      version: 1, childId: SessionId('historical-one-shot'), childCreatedAt: 1,
      mode: 'one-shot', label: 'finished once',
    })
    const started = await ctx.subagents.startActivation({ delivery: 'parent',
      provider: 'spawn',
      label: 'summarize the doc',
      prompt: [{ type: 'text', text: 'child task' }], parent,
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'lead [inactive] — root agent\n'
      + 'historical-one-shot [unavailable]\n'
      + 'agent-1 [inactive] — summarize the doc',
    )
  })

  it('describes inactive as turn availability and pins the status vocabulary', async () => {
    const { ctx } = await setup([])
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'list_agents')
    // Completion reaches the parent through its notice; listing is discovery,
    // so its inactive status must not send the model looking for a result.
    expect(schema?.description).toContain('While you remain active, you will be notified when a direct child finishes')
    expect(schema?.description).toContain('inactive means no turn is executing')
    // The enum is the closed vocabulary the model renders, so pin it rather than
    // scanning prose that legitimately reads "not to poll for completion".
    expect(ctx.tools.get('list_agents')?.output.schema.items?.properties?.status?.enum)
      .toEqual(['running', 'inactive', 'corrupt', 'unsupported', 'unavailable'])
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'list_agents', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('unregisters with its plugin fiber (HMR safety)', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(schema => schema.name === 'list_agents')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'list_agents')).toBe(false)
  })

  it('has the namespace-plugin export shape', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-control')
    expect(tool.inject).toEqual(['tools', 'subagents', 'agents', 'systemPrompt'])
    expect(typeof tool.apply).toBe('function')
  })

  it('walks the complete descendant tree in pre-order with full names', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ delivery: 'parent',
      provider: 'spawn',
      label: 'waiting branch',
      prompt: [{ type: 'text', text: 'branch work' }], parent,
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startActivation({ delivery: 'parent',
      provider: 'spawn',
      label: 'nested leaf',
      prompt: [{ type: 'text', text: 'leaf work' }], parent: child,
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    // The creation tree remains discoverable after the intermediate instance finishes.
    releaseChild.resolve(undefined)
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId)).toBeUndefined()
    }, { timeout: 5_000 })

    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'lead [inactive] — root agent\n'
      + 'agent-1 [inactive] — waiting branch\n'
      + 'agent-1/agent-1 [running] — nested leaf',
    )

    expect(text(await callTool(ctx, 'list_agents', {}, ctx.agents.get(grandchild.childId)))).toBe(text(result))

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('omits one-shot intermediates from descendants output while surfacing what they own', async () => {
    const { ctx, parent } = await setup([])
    // Deterministic service rows: a one-shot intermediate owning a continuable
    // leaf, plus a positioned diagnostic. The tool filters only the one-shot.
    ctx.subagents.listDescendants = () => Promise.resolve([
      {
        kind: 'child',
        id: SessionId('one-shot-mid'),
        label: 'one-shot intermediate',
        mode: 'one-shot',
        activity: 'inactive',
        hasChildren: true,
        parentId: parent.id,
        depth: 1,
      },
      {
        kind: 'child',
        id: SessionId('deep-leaf'),
        label: 'deep leaf',
        mode: 'continuable',
        activity: 'inactive',
        hasChildren: false,
        parentId: SessionId('one-shot-mid'),
        depth: 2,
      },
      {
        kind: 'diagnostic',
        id: SessionId('broken-node'),
        reason: 'unavailable',
        parentId: parent.id,
        depth: 1,
      },
    ])
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'lead [inactive] — root agent\n'
      + 'deep-leaf [inactive] — deep leaf\n'
      + 'broken-node [unavailable]',
    )
  })

  it('shows the same complete subagent tree from the root and each branch', async () => {
    const release = Promise.withResolvers<undefined>()
    const releaseDelta = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('alpha'), gate: release.promise },
      { chunks: textResponse('beta') },
      { chunks: textResponse('gamma') },
      { chunks: textResponse('delta'), gate: releaseDelta.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const start = async (label: string) => (await ctx.subagents.startActivation({
      delivery: 'caller', provider: 'spawn', label,
      prompt: [{ type: 'text', text: label }], parent, signal: testToolSignal,
    })).childId
    const alpha = await start('alpha task')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const beta = await start('beta task')
    await waitNoActivation(ctx, beta)
    const gamma = await start('gamma task')
    await waitNoActivation(ctx, gamma)
    const delta = await start('delta task')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(4) })

    const expected = [
      'lead [inactive] — root agent',
      'agent-1 [running] — alpha task',
      'agent-2 [inactive] — beta task',
      'agent-3 [inactive] — gamma task',
      'agent-4 [running] — delta task',
    ].join('\n')
    for (const caller of [parent, ctx.agents.get(alpha), ctx.agents.get(delta)]) {
      const result = await callTool(ctx, 'list_agents', {}, caller)
      expect(result.isError).toBe(false)
      expect(text(result)).toBe(expected)
    }

    release.resolve(undefined)
    releaseDelta.resolve(undefined)
    await waitNoActivation(ctx, alpha)
    await waitNoActivation(ctx, delta)
  })
})
