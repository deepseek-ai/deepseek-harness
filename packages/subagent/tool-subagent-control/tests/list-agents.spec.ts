import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/list-agents.ts'
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
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setupWith(adapter: MockAdapter | GatedAdapter) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-list-agents-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(tool)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  parkParent(ctx, parent)
  return { ctx, parent, adapter }
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  return setupWith(new MockAdapter(script))
}

function text(result: { content: { type: string; text?: string }[] }): string {
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
  return ctx.tools.execute({
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

describe('dsh-tool-subagent-control/list-agents', () => {
  it('registers list_agents once, globally, with only the optional scope parameter', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'list_agents')
    expect(schemas).toHaveLength(1)
    const parameters = schemas[0]!.parameters as {
      properties?: Record<string, { enum?: string[] }>
      required?: string[]
    }
    expect(Object.keys(parameters.properties ?? {})).toEqual(['scope'])
    expect(parameters.properties?.scope?.enum).toEqual(['children', 'descendants'])
    expect(parameters.required ?? []).toEqual([])
    expect(schemas[0]!.description).toContain('send_message')
    expect(schemas[0]!.description).toContain('steers a running child at its nearest step boundary')
    expect(schemas[0]!.description).not.toContain('send_message` starts a new turn')
    expect(schemas[0]!.description).toContain('interrupt_agent')
  })

  it('renders the empty result as (no subagents)', async () => {
    const { ctx, parent } = await setup([])
    await ctx.sessions.flush(parent.session)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('(no subagents)')
  })

  it('renders children and diagnostics in array order with registry-derived statuses', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'real child',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    // Pin the render deterministically past the service: the tool is a thin
    // adapter, so its fixed text forms are what this test pins. Status comes
    // from the live Agent registry, stubbed per candidate id.
    const entries: SubagentListEntry[] = [
      {
        kind: 'child',
        id: SessionId('one-shot-child'),
        label: 'finished once',
        mode: 'one-shot',
        activity: 'inactive',
        hasChildren: false,
      },
      {
        kind: 'child',
        id: started.childId,
        label: 'real child',
        mode: 'continuable',
        activity: 'inactive',
        hasChildren: false,
      },
      {
        kind: 'child',
        id: SessionId('running-child'),
        label: 'still working',
        mode: 'continuable',
        activity: 'running',
        hasChildren: true,
      },
      {
        kind: 'child',
        id: SessionId('waiting-child'),
        label: 'waiting on descendants',
        mode: 'continuable',
        activity: 'running',
        hasChildren: true,
      },
      { kind: 'diagnostic', id: SessionId('broken-child'), reason: 'corrupt' },
    ]
    ctx.subagents.listChildren = () => Promise.resolve(entries)
    const agents = new Map<string, { status: 'running' | 'idle' }>([
      ['running-child', { status: 'running' }],
      ['waiting-child', { status: 'idle' }],
    ])
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => agents.get(id) as never)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    // `ready` is the resumable counterpart to a live `running` record, not a
    // claim that the child's conversation ended with a result to collect.
    expect(text(result)).toBe(
      `${started.childId} [ready] — real child\n`
      + 'running-child [running] — still working\n'
      + 'waiting-child [idle] — waiting on descendants\n'
      + 'broken-child [diagnostic: corrupt]',
    )
  })

  it('resolves omitted scope to children and forwards the tool cancellation signal', async () => {
    const { ctx, parent } = await setup([])
    const signal = new AbortController().signal
    const listChildren = vi.spyOn(ctx.subagents, 'listChildren').mockResolvedValue([])

    const result = await callTool(ctx, 'list_agents', {}, parent, signal)

    expect(result.isError).toBe(false)
    expect(listChildren).toHaveBeenCalledWith(parent.id, signal)
  })

  it('lists a real settled continuable child and omits a real one-shot sibling', async () => {
    const { ctx, parent } = await setup([textResponse('once'), textResponse('done')])
    const oneShot = await ctx.subagents.start('spawn', {
      label: 'finished once',
      prompt: [{ type: 'text', text: 'one-shot task' }],
      parent,
      signal: new AbortController().signal,
    })
    await oneShot.result
    await oneShot.dispose()
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'summarize the doc',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`${started.childId} [ready] — summarize the doc`)
  })

  it('describes ready as resumable and pins the status vocabulary', async () => {
    const { ctx } = await setup([])
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'list_agents')
    // Completion reaches the parent through its notice; listing is discovery,
    // so its inactive status must not send the model looking for a result.
    expect(schema?.description).toContain('you are told when one finishes')
    expect(schema?.description).toContain('resumable, not terminal')
    // The enum is the closed vocabulary the model renders, so pin it rather than
    // scanning prose that legitimately reads "not to poll for completion".
    const variants = ctx.tools.get('list_agents')?.output.schema.items?.oneOf ?? []
    const child = variants.find(variant => variant.properties?.kind?.enum?.includes('child'))
    expect(child?.properties?.status?.enum).toEqual(['running', 'idle', 'ready'])
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'list_agents', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('unregisters with its plugin fiber (HMR safety)', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(schema => schema.name === 'list_agents')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'list_agents')).toBe(false)
  })

  it('has the namespace-plugin export shape', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-list-agents')
    expect(tool.inject).toEqual(['tools', 'subagents', 'agents'])
    expect(typeof tool.apply).toBe('function')
  })

  it('walks the complete descendant tree in pre-order with parent and depth annotations', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'waiting branch',
      request: { prompt: [{ type: 'text', text: 'branch work' }], parent },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'nested leaf',
      request: { prompt: [{ type: 'text', text: 'leaf work' }], parent: child },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    // The branch finishes its own turn but stays resident waiting on the
    // grandchild it owns: the live-registry `idle` status.
    releaseChild.resolve(undefined)
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId)?.status).toBe('idle')
    }, { timeout: 5_000 })

    const result = await callTool(ctx, 'list_agents', { scope: 'descendants' }, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      `${started.childId} [idle] parent=${parent.id} depth=1 — waiting branch\n`
      + `${grandchild.childId} [running] parent=${started.childId} depth=2 — nested leaf`,
    )

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
    const result = await callTool(ctx, 'list_agents', { scope: 'descendants' }, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'deep-leaf [ready] parent=one-shot-mid depth=2 — deep leaf\n'
      + `broken-node [diagnostic: unavailable] parent=${parent.id} depth=1`,
    )
  })

  it('preserves explicit descendants scope and forwards the tool cancellation signal', async () => {
    const { ctx, parent } = await setup([])
    const signal = new AbortController().signal
    const listDescendants = vi.spyOn(ctx.subagents, 'listDescendants').mockResolvedValue([])

    const result = await callTool(ctx, 'list_agents', { scope: 'descendants' }, parent, signal)

    expect(result.isError).toBe(false)
    expect(listDescendants).toHaveBeenCalledWith(parent.id, signal)
  })
})
