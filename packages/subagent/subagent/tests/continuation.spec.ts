import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import type { ContentBlock, GenerateOptions, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId, createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, {
  SubagentError,
  SUBAGENT_DESCRIPTOR_VERSION,
} from '../src/index.ts'
import type { SubagentRunEndInfo, SubagentRunInfo } from '../src/index.ts'
import * as SubagentInvariant from '../src/invariant.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession } from './persistence-helpers.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

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

// Each persistence-backed temp root cleans up by closing its handle before
// removing the directory: Windows rmSync over a dir holding a still-open handle
// fails with EPERM.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0)) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'temp-root cleanup failed')
})

/** Boot the full continuable stack: loop, persistence, providers, and subagents. */
async function setupWith(
  adapter: LlmAdapter,
  options: { persistence?: boolean; sessionQuery?: boolean } = {},
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // The registry is a required injection of AgentLoop and SubagentRuntime
  // (both register projection units on activation).
  await ctx.plugin(SessionProjectionRegistry)
  let disposePersistence: (() => Promise<void>) | undefined
  let root: string | undefined
  if (options.persistence !== false) {
    root = mkdtempSync(join(tmpdir(), 'dsh-subagent-continuation-'))
    const persistedRoot = root
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
    disposePersistence = () => persistenceFiber.dispose()
    cleanups.push(async () => {
      await persistenceFiber.dispose()
      rmSync(persistedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.sessionQuery !== false) await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, disposePersistence, root }
}

async function setup(script: Script, options: { persistence?: boolean } = {}) {
  const adapter = new MockAdapter(script)
  const booted = await setupWith(adapter, options)
  return { ...booted, adapter }
}

const testSignal = new AbortController().signal

function startSpec(parent: Agent, provider = 'spawn', signal: AbortSignal = testSignal) {
  return {
    provider,
    label: 'child task',
    request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
    signal,
  }
}

function message(text: string) {
  return [{ type: 'text' as const, text }]
}

function hasUserText(events: readonly SessionEvent[], text: string): boolean {
  return events.some(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text === text))
}

/** Caller-supplied user message texts in log order (runtime-context snapshots excluded). */
function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'plugin'
    ? event.data.content.flatMap(block => block.type === 'text'
      && !block.text.startsWith('Your parent agent id is ')
      ? [block.text]
      : [])
    : [])
}

function queuePrompt(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  signal: AbortSignal = testSignal,
) {
  const manager = (ctx.subagents as unknown as {
    continuations?: {
      queuePrompt(
        parent: Agent,
        childId: SessionId,
        content: ContentBlock[],
        source: { kind: 'user' },
        signal: AbortSignal,
      ): Promise<string>
    }
  }).continuations
  if (manager === undefined) throw new Error('expected a bound continuation manager')
  return manager.queuePrompt(parent, childId, content, { kind: 'user' }, signal)
}

/**
 * Exercise manager-wide teardown through the package-private owner rather than
 * adding the irreversible operation to the public service contract.
 */
function drainManager(ctx: Context): Promise<void> {
  const manager = (ctx.subagents as unknown as {
    continuations?: { drain(): Promise<void> }
  }).continuations
  if (manager === undefined) throw new Error('expected a bound continuation manager')
  return manager.drain()
}

/** Wait until a child's Activation is gone, i.e. its handle finished disposal. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

/**
 * Keep the top-level test parent out of a scripted model corpus. Every child
 * settlement wakes its parent, so a suite that scripts only child responses
 * would otherwise spend them on the parent's own turns.
 */
function parkParent(ctx: Context, parent: Agent): void {
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    return { kind: 'reject' as const }
  })
}

/** Observe calls at the Agent cancellation boundary without a production event. */
function observeCancel(agent: Agent, callback: () => void): void {
  const cancel = agent.cancel.bind(agent)
  let observed = false
  vi.spyOn(agent, 'cancel').mockImplementation((cause, options) => {
    if (!observed) {
      observed = true
      callback()
    }
    cancel(cause, options)
  })
}

describe('SubagentRuntime.startContinuable', () => {
  it('returns both identities at inbox acceptance, without waiting for the turn or the log', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('first answer')])
    const enqueued: { id: MessageId; loggedYet: boolean }[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      // Acceptance is the boundary `startContinuable` resolves at, so observe
      // the log state exactly there rather than after later microtasks.
      enqueued.push({ id: message.id, loggedYet: hasUserText(agent.session.snapshotEvents(), 'child task') })
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))

    expect(started.childId).toMatch(/[0-9a-f-]{36}/)
    // The returned id is exactly the accepted inbox message's id, and nothing
    // was logged or requested to earn it.
    expect(enqueued).toEqual([{ id: started.messageId, loggedYet: false }])
    expect(adapter.requests).toEqual([])

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'child task')).toBe(true)
  })

  it('uses a caller-reserved child identity and rejects a duplicate reservation', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('reserved answer'), gate: release.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const reservedId = SessionId('00000000-0000-4000-8000-000000000123')

    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent),
      childId: reservedId,
    })
    expect(started.childId).toBe(reservedId)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    await expect(ctx.subagents.startContinuable({
      ...startSpec(parent),
      childId: reservedId,
    })).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })

    release.resolve(undefined)
    await waitNoActivation(ctx, reservedId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, reservedId)
    expect(loaded.meta.id).toBe(reservedId)

    await expect(ctx.subagents.startContinuable({
      ...startSpec(parent),
      childId: reservedId,
    })).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })
    expect(ctx.agents.get(reservedId)).toBeUndefined()
  })

  it('rejects without ids when the provider has no prepareContinuable capability', async () => {
    const { ctx, parent } = await setup([])
    const start = vi.fn(async () => { throw new Error('must not dispatch') })
    ctx.subagents.registerProvider({
      name: 'one-shot',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start,
    })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'one-shot')))
      .rejects.toThrow(/does not support continuable children/)
    expect(start).not.toHaveBeenCalled()
    // No child Agent and no session were created.
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects synchronously when persistence is not configured', async () => {
    const { ctx, parent } = await setup([textResponse('unused')], { persistence: false })
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toThrow(/require session persistence/)
  })

  it('publishes the reserved child id and appends the pre-turn descriptor', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const descriptorIndex = loaded.events.findIndex(event => event.type === 'subagent/descriptor')
    const turnStartIndex = loaded.events.findIndex(event => event.type === 'turn/start')
    expect(descriptorIndex).toBeGreaterThanOrEqual(0)
    expect(descriptorIndex).toBeLessThan(turnStartIndex)
    const descriptor = loaded.events[descriptorIndex] as SessionEvent<'subagent/descriptor'>
    expect(descriptor.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'child task',
      agentProvider: 'mock',
      agentModel: 'mock',
    })
    // Model-hidden: the descriptor never carries surface metadata.
    expect('surfaceOp' in descriptor).toBe(false)
    expect(loaded.meta.id).toBe(started.childId)
    expect(loaded.meta.parentSession).toBe(SessionId('parent'))
    expect(loaded.meta.origin).toBe('subagent')
  })

  it('persists a selected reasoning effort and reapplies it on cold resume', async () => {
    const effort = ReasoningEffortId('max')
    const adapter = new MockAdapter([
      textResponse('first answer'),
      textResponse('resumed answer'),
    ], {
      efforts: [{ id: effort, name: 'Max' }],
      defaultEffort: effort,
    })
    const { ctx, parent } = await setupWith(adapter)
    parkParent(ctx, parent)
    const childEfforts: Array<string | undefined> = []
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) childEfforts.push(agent.options.reasoningEffort)
    })

    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: {
        prompt: message('selected reasoning'),
        parent,
        agentOptions: { reasoningEffort: effort },
      },
    })
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.events.find(event => event.type === 'subagent/descriptor')?.data)
      .toMatchObject({ agentReasoningEffort: 'max' })

    await queuePrompt(ctx, parent, started.childId, message('resume selected reasoning'))
    await waitNoActivation(ctx, started.childId)
    expect(childEfforts).toEqual(['max', 'max'])
  })

  it('rolls the child back completely when the caller signal aborts before acceptance', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const controller = new AbortController()
    // Abort inside the child's creation window: setup runs before publication.
    ctx.on('agent/created', ({ agent: child }) => {
      if (child !== parent) controller.abort('caller gave up')
    })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'spawn', controller.signal)))
      .rejects.toThrow()
    // No Activation, no live child Agent, and no parent ownership remains.
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
  })

  it('rolls the child back when the signal aborts between publication and acceptance', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const controller = new AbortController()
    // `subagent/start` fires once the epoch is resident, before the prompt is
    // submitted, so cancelling here lands squarely in the handoff window.
    ctx.on('subagent/start', () => { controller.abort('caller gave up') })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'spawn', controller.signal)))
      .rejects.toThrow()

    // No resident child and no queued turn survive the abort.
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
  })

  it('rolls an unpublished Activation back when lifecycle publication fails', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', info => void ends.push(info))
    ctx.on('internal/dispatch', (_mode, eventName) => {
      if (eventName === 'subagent/start') throw new Error('start publication failed')
    }, { global: true })

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toThrow(/start publication failed/)

    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
    expect(ends).toEqual([])
    await expect(drainManager(ctx)).resolves.toBeUndefined()
  })

  it('rejects a continuable child that would exceed the configured depth cap', async () => {
    const { ctx, parent } = await setup([])
    await expect(ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: { prompt: message('deep'), parent, maxDepth: 0 },
    })).rejects.toThrow(/exceeds maxDepth 0/)
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects an invalid continuable depth cap before provider preparation', async () => {
    const { ctx, parent } = await setup([])
    await expect(ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: { prompt: message('deep'), parent, maxDepth: Number.NaN },
    })).rejects.toThrow(/non-negative safe integer/)
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('omits undeclared composition fields from the descriptor', async () => {
    const { ctx } = await setup([])
    // A routeless parent declares no provider/model, and this start declares no
    // persona or tool filter, so the descriptor records only what exists.
    const routeless = await ctx.agentLoop.create(SessionId('routeless'), {})
    const started = await ctx.subagents.startContinuable(startSpec(routeless))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const descriptor = child.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')

    expect(descriptor?.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'child task',
    })
    await drainManager(ctx)
  })

  it('records a declared tool filter in the descriptor', async () => {
    const { ctx } = await setup([])
    // Register one global tool so the filter names something real.
    ctx.tools.register(defineTool({
      name: 'noop',
      description: 'does nothing',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [{ type: 'text', text: 'noop' }],
      },
      execute: () => Promise.resolve({}),
    }))
    const routeless = await ctx.agentLoop.create(SessionId('routeless-filtered'), {})
    const started = await ctx.subagents.startContinuable({
      ...startSpec(routeless),
      request: { prompt: message('filtered work'), parent: routeless, toolFilter: { deny: ['noop'] } },
    })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })

    expect(child.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')?.data)
      .toEqual({
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: 'continuable',
        provider: 'spawn',
        label: 'child task',
        toolFilter: { deny: ['noop'] },
      })
    await drainManager(ctx)
  })

  it('cold-resumes without inventing a model route the descriptor never declared', async () => {
    const { ctx, root } = await setup([textResponse('first')])
    const routeless = await ctx.agentLoop.create(SessionId('routeless-resume'), {})
    const started = await ctx.subagents.startContinuable(startSpec(routeless))
    await waitNoActivation(ctx, started.childId)

    const fresh = new Context()
    await mountAgentLoopTestDependencies(fresh)
    await fresh.plugin(SessionProjectionRegistry)
    const freshPersistence = await fresh.plugin(JsonlSessionPersistence, { root: root! })
    // This context opened a second handle on the same root; register it so
    // afterEach closes it before removing the root (even on a failure path).
    cleanups.push(async () => { await freshPersistence.dispose() })
    await fresh.plugin(AgentLoop, { agents: [] })
    await fresh.plugin(TestSessionQuery)
    await fresh.plugin(SubagentRuntime)
    await fresh.plugin(SubagentSpawn, { providerName: 'spawn' })
    const freshParent = await fresh.agentLoop.create(SessionId('routeless-resume'), {})
    await queuePrompt(fresh, freshParent, started.childId, message('resume routeless'))

    const resumed = await vi.waitFor(() => {
      const found = fresh.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    expect(resumed.options.provider).toBeUndefined()
    expect(resumed.options.model).toBeUndefined()
    await drainManager(fresh)
  })

  it('continues turn numbering after an inherited fork prefix and pre-turn descriptor', async () => {
    const { ctx, parent } = await setup([
      textResponse('parent turn'),
      textResponse('forked child'),
    ])
    // Complete one parent turn so fork has a prefix to contribute.
    parent.followup(createUserMessage({ content: message('parent work'), source: { kind: 'user' } }))
    await parent.whenIdle()

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'fork'))
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const descriptorIndex = loaded.events.findIndex(event => event.type === 'subagent/descriptor')
    const childTurn = loaded.events.slice(descriptorIndex + 1)
      .find(event => event.type === 'turn/start')
    // The first child turn after the descriptor continues the inherited prefix
    // rather than restarting at 1, so the replayed child log stays balanced.
    expect(descriptorIndex).toBeGreaterThanOrEqual(0)
    expect(childTurn?.type === 'turn/start' && childTurn.data.turn).toBe(2)
    expect(loaded.meta.isSeeded).toBe(true)
    expect(loaded.inheritedEventCount).toBeGreaterThan(0)
  })

  it('records the declared persona in the descriptor and reapplies it on cold resume', async () => {
    const { ctx, parent } = await setup([textResponse('scoped'), textResponse('resumed')])
    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: {
        prompt: message('scoped work'),
        parent,
        persona: 'You are scoped.',
      },
    })
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const descriptor = loaded.events.find(event => event.type === 'subagent/descriptor')
    expect(descriptor?.data).toMatchObject({ persona: 'You are scoped.' })

    // Cold resume reconstructs the declared composition from that descriptor.
    await queuePrompt(ctx, parent, started.childId, message('resume it'))
    await waitNoActivation(ctx, started.childId)
    const resumed = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(resumed.events, 'resume it')).toBe(true)
  })
})

describe('continuable image Queue prompts', () => {
  const imageBlock = {
    type: 'image' as const,
    attachment: {
      attachmentId: 'att-1' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1,
    },
  }

  it('refuses an image follow-up when the child model declines image input, leaving no partial message', async () => {
    const { ctx, parent } = await setup([textResponse('child work')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const resolve = vi.spyOn(ctx.llm, 'resolveModelInfo')
      .mockResolvedValue({ inputModalities: ['text'] } as never)

    await expect(queuePrompt(ctx, parent, started.childId, [
      { type: 'text' as const, text: 'see this' },
      imageBlock,
    ]))
      .rejects.toMatchObject({ code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })

    expect(resolve).toHaveBeenCalledWith('mock', 'mock', testSignal)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'see this')).toBe(false)
    await drainManager(ctx)
  })

  it('delivers an image follow-up to a resident child when its model accepts image input', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child work'), gate: releaseFirst.promise },
      { chunks: textResponse('image reply') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
    })
    vi.spyOn(ctx.llm, 'resolveModelInfo')
      .mockResolvedValue({ inputModalities: ['text', 'image'] } as never)

    await queuePrompt(ctx, parent, started.childId, [
      { type: 'text' as const, text: 'compare' },
      imageBlock,
    ])
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const delivered = loaded.events.find(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'image'))
    expect(delivered?.type === 'user/message' && delivered.data.content).toEqual([
      { type: 'text', text: 'compare' },
      imageBlock,
    ])
    await drainManager(ctx)
  })

  it('re-checks the disposal cutoff when a drain begins during a live image capability read', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child work'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const capability = Promise.withResolvers<{ inputModalities: string[] }>()
    const resolve = vi.spyOn(ctx.llm, 'resolveModelInfo').mockReturnValue(capability.promise as never)

    const delivery = queuePrompt(ctx, parent, started.childId, [imageBlock])
    delivery.catch(() => undefined)
    await vi.waitFor(() => { expect(resolve).toHaveBeenCalled() })
    releaseFirst.resolve(undefined)
    const draining = drainManager(ctx)
    capability.resolve({ inputModalities: ['text', 'image'] })

    await expect(delivery).rejects.toMatchObject({ code: 'DRAINING' })
    await draining
  })

  it('rejects a materialized image follow-up whose capability read raced a drain', async () => {
    const { ctx, parent } = await setup([textResponse('child work')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const capability = Promise.withResolvers<{ inputModalities: string[] }>()
    const resolve = vi.spyOn(ctx.llm, 'resolveModelInfo').mockReturnValue(capability.promise as never)

    const delivery = queuePrompt(ctx, parent, started.childId, [imageBlock])
    delivery.catch(() => undefined)
    await vi.waitFor(() => { expect(resolve).toHaveBeenCalled() })
    const draining = drainManager(ctx)
    capability.resolve({ inputModalities: ['text', 'image'] })

    await expect(delivery).rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
    await draining
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'image'))).toBe(false)
  })

  it('defers to the text-only projection when the descriptor declares no model route', async () => {
    const { ctx } = await setup([])
    const routeless = await ctx.agentLoop.create(SessionId('routeless-image'), {})
    const started = await ctx.subagents.startContinuable(startSpec(routeless))
    await waitNoActivation(ctx, started.childId)
    const resolve = vi.spyOn(ctx.llm, 'resolveModelInfo')

    // Acceptance is the success boundary: with no declared route there is no
    // model to refuse against, so the image message enters the child inbox.
    await queuePrompt(ctx, routeless, started.childId, [imageBlock])

    expect(resolve).not.toHaveBeenCalled()
    await drainManager(ctx)
  })
})

describe('direct-child Queue residency routing', () => {
  it('fails a cold follow-up when Session query is unavailable', async () => {
    const { ctx, parent } = await setupWith(new MockAdapter([]), {
      persistence: false,
      sessionQuery: false,
    })

    await expect(queuePrompt(ctx, parent, SessionId('cold-without-query'), message('continue')))
      .rejects.toMatchObject({ code: 'CONTINUATION_UNAVAILABLE' })
  })

  it('enqueues in the same Activation while it is running, preserving one inbox FIFO', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
      { chunks: textResponse('third') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)
    expect(child?.status).toBe('running')

    // Both messages queue behind the open turn, in call order.
    const firstMessage = await queuePrompt(ctx, parent, started.childId, message('first follow-up'))
    const secondMessage = await queuePrompt(ctx, parent, started.childId, message('second follow-up'))
    expect(firstMessage).not.toBe(secondMessage)
    // Still the same Activation: no second child Agent was created.
    expect(ctx.agents.get(started.childId)).toBe(child)

    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'first follow-up', 'second follow-up'])
  })

  it('cold-resumes a settled child into a new Activation', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const messageId = await queuePrompt(ctx, parent, started.childId, message('continue please'))
    expect(messageId).toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'continue please'])
    // One descriptor only: cold resume never re-seeds it.
    expect(loaded.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
  })

  it('cold-resumes after the initial provider unregisters', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SubagentInvariant)
    const disposeProvider = ctx.subagents.registerProvider({
      name: 'retired',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('one-shot start is not used') },
      prepareContinuable: () => Promise.resolve({}),
    })
    const starts: SubagentRunInfo[] = []
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/start', info => void starts.push(info))
    ctx.on('subagent/end', info => void ends.push(info))

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'retired'))
    await waitNoActivation(ctx, started.childId)
    disposeProvider()
    expect(ctx.subagents.getProvider('retired')).toBeUndefined()

    await expect(queuePrompt(ctx, parent, started.childId, message('continue without provider')))
      .resolves.toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(2) })

    expect(starts.map(info => info.provider)).toEqual(['retired', 'retired'])
    expect(ends.map(info => info.runId)).toEqual(starts.map(info => info.runId))
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'continue without provider'])
  })

  it('wakes a waiting Activation instead of cold-resuming it', async () => {
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      // The child delegates, then finishes its own turn while the grandchild runs.
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
      { chunks: textResponse('woken') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // The child starts its own continuable grandchild, then goes quiescent.
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(2) })
    await vi.waitFor(() => {
      expect(child.status).toBe('idle')
      expect(ctx.agents.get(started.childId)).toBe(child)
    }, { timeout: 5_000 })
    // Waiting retains the handle: the same Agent is still live.
    expect(ctx.agents.get(started.childId)).toBe(child)

    await queuePrompt(ctx, parent, started.childId, message('while waiting'))
    // Woken back to running on the SAME Activation.
    expect(ctx.agents.get(started.childId)).toBe(child)

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    // This child is itself a parent, so its grandchild's settlement notice is
    // an ordinary later user message in its log.
    expect(userTexts(loaded.events).slice(0, 2)).toEqual(['child task', 'while waiting'])
    expect(userTexts(loaded.events).slice(2).join('\n')).toContain('finished and will do no further work')
  })

  it('holds one ownership edge per child: a followup under an existing hold is a no-op re-hold', async () => {
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
      { chunks: textResponse('extra delivery') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // startContinuable held the child→grandchild ownership edge; a followup
    // from the same managed parent to the same child re-holds it as a no-op,
    // and its failure-path release must not drop the established edge.
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    const aborted = AbortSignal.abort(new Error('followup abandoned'))
    await expect(queuePrompt(ctx, child, grandchild.childId, message('while owned'), aborted))
      .rejects.toThrow('followup abandoned')
    // The edge survives the released duplicate hold: the grandchild delivery
    // still completes and settles normally.
    await expect(queuePrompt(ctx, child, grandchild.childId, message('after release')))
      .resolves.toBeTypeOf('string')

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('rejects a parent that is not the durable direct parent', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const stranger = await ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })

    await expect(queuePrompt(ctx, stranger, started.childId, message('mine now')))
      .rejects.toThrow(/belongs to another parent session/)
  })

  it('reports an unresumable child whose persisted log has no supported descriptor', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    // A one-shot child has durable identity but no supported continuation state.
    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot work',
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    await run.result
    await ctx.sessions.flush(run.localAgent!.session)
    const oneShotId = run.id
    await run.dispose()

    const rejection: unknown = await queuePrompt(ctx, parent, oneShotId, message('continue'))
      .catch((error: unknown) => error)
    expect(rejection).toMatchObject({
      code: 'NOT_RESUMABLE',
      message: `subagent "${oneShotId}" has no supported continuation state and cannot be resumed; choose a different target`,
    })
    expect(String(rejection)).not.toContain('send_message')
  })

  it('reports an unknown child id as unavailable', async () => {
    const { ctx, parent } = await setup([])
    await expect(queuePrompt(ctx, parent, SessionId('missing'), message('hello')))
      .rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
  })

  it('propagates cancellation while inspecting a cold child', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const inspectStarted = Promise.withResolvers<undefined>()
    const inspect = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation((_id, _access, options) => {
      return new Promise<never>((_resolve, reject) => {
        const signal = options?.signal
        if (signal === undefined) {
          reject(new Error('cold inspection must receive the followup signal'))
          return
        }
        inspectStarted.resolve(undefined)
        signal.addEventListener('abort', () => {
          reject(reason)
        }, { once: true })
      })
    })
    const controller = new AbortController()
    const reason = new Error('cold inspection cancelled')

    try {
      const delivery = queuePrompt(ctx, parent, started.childId, message('cancel me'), controller.signal)
      await inspectStarted.promise
      controller.abort(reason)
      await expect(delivery).rejects.toBe(reason)
    } finally {
      inspect.mockRestore()
    }
  })

  it('preserves a SubagentError raised while cold-materializing a child', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const failure = new SubagentError('materialization denied', 'UNAUTHORIZED')
    ctx.agents.resume = () => Promise.reject(failure)

    await expect(queuePrompt(ctx, parent, started.childId, message('continue')))
      .rejects.toBe(failure)
  })

  it('cold-resumes a delivery that lost the race with final disposal', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after the race')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Deliver in the same tick the settlement watcher opens its transaction:
    // exactly one side wins the cutoff. A delivery that loses awaits release and
    // cold-resumes rather than reaching a handle being torn down.
    const delivery = child.whenIdle().then(() =>
      queuePrompt(ctx, parent, started.childId, message('raced')))

    await expect(delivery).resolves.toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'raced')).toBe(true)
  })
})

describe('continuable child ownership', () => {
  it('keeps a parent Activation waiting until its child completes disposal', async () => {
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))

    await vi.waitFor(() => {
      expect(child.status).toBe('idle')
      expect(ctx.agents.get(started.childId)).toBe(child)
    }, { timeout: 5_000 })
    // Child-first: the parent handle is retained while the grandchild is live.
    expect(ctx.agents.get(started.childId)).toBe(child)
    expect(ctx.agents.get(grandchild.childId)).toBeDefined()

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('does not add a top-level parent to the waiting graph', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    // The top-level parent remains independently registered after its child settles.
    expect(ctx.agents.get(parent.id)).toBe(parent)
  })
})

describe('continuable durability and teardown', () => {
  it('settles despite the persistence backend being disposed mid-run', async () => {
    const releaseResponse = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('unconfirmed answer'), gate: releaseResponse.promise },
    ])
    const { ctx, parent, disposePersistence } = await setupWith(adapter)
    const warnings: string[] = []
    ctx.logger.warn = (message: string) => { warnings.push(message) }

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    // Tear down the whole backend under the child's open write path: its
    // teardown closes the handle (draining what was buffered) and detaches
    // the durability listeners, so the final flush finds no participant and
    // never pins the Activation.
    await disposePersistence!()
    releaseResponse.resolve(undefined)

    await waitNoActivation(ctx, started.childId)
    expect(warnings.join('\n')).not.toContain('final session flush')
  })

  it('logs a failed final flush after every listener settles without failing the Activation', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const warnings: string[] = []
    const ends: SubagentRunEndInfo[] = []
    let peerFlushed = false
    ctx.logger.warn = (message: string) => { warnings.push(message) }
    ctx.on('subagent/end', info => void ends.push(info))
    ctx.on('session/flush', (session) => {
      if (session.header.parentSession !== undefined) throw new Error('disk full')
    })
    ctx.on('session/flush', (session) => {
      if (session.header.parentSession !== undefined) peerFlushed = true
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    expect(peerFlushed).toBe(true)
    expect(warnings.some(warning => warning.includes('best-effort final session flush failed'))).toBe(true)
    expect(ends.at(-1)?.stopReason).toBe('completed')
  })

  it('logs a teardown failure reached through normal settlement', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const warnings: string[] = []
    ctx.logger.warn = (message: string) => { warnings.push(message) }

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('normal settlement cleanup failed')
    }

    hold.resolve(undefined)

    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => {
      expect(warnings.some(warning => warning.includes('normal settlement cleanup failed'))).toBe(true)
    }, { timeout: 5_000 })
  })

  it('disposes every live Activation forest child-first on manager teardown', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(ctx.agents.get(grandchild.childId)).toBeDefined() })

    const disposals: SessionId[] = []
    ctx.on('agent/disposed', ({ agent }) => { disposals.push(agent.id) })
    const drained = drainManager(ctx)
    // Let the held model call observe its cancellation so quiescence can settle.
    hold.resolve(undefined)
    await drained

    // Child-first: the grandchild's disposal precedes its parent's.
    expect(disposals.indexOf(grandchild.childId)).toBeGreaterThanOrEqual(0)
    expect(disposals.indexOf(grandchild.childId))
      .toBeLessThan(disposals.indexOf(started.childId))
    // Durable sessions survive process-local teardown.
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.meta.id).toBe(started.childId)
  })

  it('drains one parent forest without disabling a sibling parent forest', async () => {
    const releaseTarget = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const releaseSibling = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('target child'), gate: releaseTarget.promise },
      { chunks: textResponse('sibling child'), gate: releaseSibling.promise },
      { chunks: textResponse('target grandchild'), gate: releaseGrandchild.promise },
      { chunks: textResponse('sibling follow-up') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const siblingParent = await ctx.agentLoop.create(
      SessionId('sibling-parent'),
      { provider: 'mock', model: 'mock' },
    )
    const target = await ctx.subagents.startContinuable(startSpec(parent))
    const sibling = await ctx.subagents.startContinuable(startSpec(siblingParent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const targetChild = ctx.agents.get(target.childId)!
    const siblingChild = ctx.agents.get(sibling.childId)!
    const grandchild = await ctx.subagents.startContinuable(startSpec(targetChild))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    const cancellations: SessionId[] = []
    observeCancel(targetChild, () => { cancellations.push(targetChild.id) })
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    observeCancel(grandchildAgent, () => { cancellations.push(grandchildAgent.id) })

    const drained = ctx.subagents.drainContinuableDescendants([parent])
    const convergedDrain = ctx.subagents.drainContinuableDescendants([parent])

    // The scoped cutoff stops only the selected forest. The sibling child stays
    // resident and can accept later work while target cleanup is still blocked.
    expect(cancellations).toEqual([target.childId, grandchild.childId])
    expect(ctx.agents.get(target.childId)).toBe(targetChild)
    expect(ctx.agents.get(grandchild.childId)).toBeDefined()
    expect(ctx.agents.get(sibling.childId)).toBe(siblingChild)
    await expect(queuePrompt(ctx, siblingParent, sibling.childId, message('still live')))
      .resolves.toBeTypeOf('string')
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await expect(queuePrompt(ctx, parent, target.childId, message('too late')))
      .rejects.toMatchObject({ code: 'DRAINING' })

    releaseTarget.resolve(undefined)
    releaseGrandchild.resolve(undefined)
    await Promise.all([drained, convergedDrain])
    expect(ctx.agents.get(target.childId)).toBeUndefined()
    expect(ctx.agents.get(grandchild.childId)).toBeUndefined()
    expect(ctx.agents.get(sibling.childId)).toBe(siblingChild)
    // The exact root remains closed until its host disposes it, even after all
    // current descendants are gone.
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })

    releaseSibling.resolve(undefined)
    await waitNoActivation(ctx, sibling.childId)
  })

  it('retains a continuable root while draining only its descendants', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const cancellations: SessionId[] = []
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    observeCancel(grandchildAgent, () => { cancellations.push(grandchildAgent.id) })

    const drained = ctx.subagents.drainContinuableDescendants([child])

    expect(cancellations).toEqual([grandchild.childId])
    expect(ctx.agents.get(started.childId)).toBe(child)
    releaseGrandchild.resolve(undefined)
    await drained
    expect(ctx.agents.get(grandchild.childId)).toBeUndefined()
    expect(ctx.agents.get(started.childId)).toBe(child)
    await expect(ctx.subagents.startContinuable(startSpec(child)))
      .rejects.toMatchObject({ code: 'DRAINING' })

    releaseChild.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('releases only selected direct children', async () => {
    const releaseTarget = Promise.withResolvers<undefined>()
    const releaseSibling = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('target'), gate: releaseTarget.promise },
      { chunks: textResponse('sibling'), gate: releaseSibling.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const target = await ctx.subagents.startContinuable(startSpec(parent))
    const sibling = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const targetAgent = ctx.agents.get(target.childId)!
    const siblingAgent = ctx.agents.get(sibling.childId)!
    const grandchild = await ctx.subagents.startContinuable(startSpec(targetAgent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    const cancel = vi.spyOn(targetAgent, 'cancel')

    // A repeated id folds to one teardown and an absent target is an accepted no-op.
    const drained = ctx.subagents.drainContinuableChildren(
      parent,
      [target.childId, target.childId, SessionId('never-materialized')],
    )

    expect(cancel).toHaveBeenCalledWith({ kind: 'parent' })
    expect(ctx.agents.get(sibling.childId)).toBe(siblingAgent)
    releaseTarget.resolve(undefined)
    releaseGrandchild.resolve(undefined)
    await drained
    expect(ctx.agents.get(target.childId)).toBeUndefined()
    expect(ctx.agents.get(grandchild.childId)).toBeUndefined()
    expect(ctx.agents.get(sibling.childId)).toBe(siblingAgent)
    releaseSibling.resolve(undefined)
    await waitNoActivation(ctx, sibling.childId)
  })

  it('ignores a selected direct child that is not resident', async () => {
    const { ctx, parent } = await setup([])

    await expect(ctx.subagents.drainContinuableChildren(parent, [SessionId('settled-child')]))
      .resolves.toBeUndefined()
  })

  it('reports selected-child disposal failures after releasing the child', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('target'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const target = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const activation = manager.activations.get(target.childId)!
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('selected cleanup failed')
    }

    const drained = ctx.subagents.drainContinuableChildren(parent, [target.childId])
    hold.resolve(undefined)

    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    expect(ctx.agents.get(target.childId)).toBeUndefined()
  })

  it('rejects selected-child teardown through another live parent', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('target'), gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const other = await ctx.agentLoop.create(SessionId('other-parent'), { provider: 'mock', model: 'mock' })
    const target = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    await expect(ctx.subagents.drainContinuableChildren(other, [target.childId]))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(ctx.agents.get(target.childId)).toBeDefined()

    release.resolve(undefined)
    await waitNoActivation(ctx, target.childId)
  })

  it('rejects selected-child teardown through a stale parent identity', async () => {
    const { ctx, parent } = await setup([])
    const stale = { ...parent, id: parent.id } as unknown as Agent

    await expect(ctx.subagents.drainContinuableChildren(stale, []))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('finds scoped descendants after an intermediate one-shot Agent leaves the registry', async () => {
    const releaseIntermediate = Promise.withResolvers<undefined>()
    const releaseDescendant = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('one-shot'), gate: releaseIntermediate.promise },
      { chunks: textResponse('continuable descendant'), gate: releaseDescendant.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot task',
      prompt: message('one-shot task'),
      parent,
      signal: testSignal,
    })
    const intermediate = run.localAgent
    expect(intermediate).toBeDefined()
    if (intermediate === undefined) throw new Error('spawn must publish a local Agent')
    const descendant = await ctx.subagents.startContinuable(startSpec(intermediate))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })

    const intermediateId = intermediate.id
    const disposingIntermediate = run.dispose()
    releaseIntermediate.resolve(undefined)
    await disposingIntermediate
    expect(ctx.agents.get(intermediateId)).toBeUndefined()
    expect(ctx.agents.get(descendant.childId)).toBeDefined()
    const cancellations: SessionId[] = []
    const descendantAgent = ctx.agents.get(descendant.childId)!
    observeCancel(descendantAgent, () => { cancellations.push(descendantAgent.id) })

    const drained = ctx.subagents.drainContinuableDescendants([parent])

    expect(cancellations).toEqual([descendant.childId])
    releaseDescendant.resolve(undefined)
    await drained
    expect(ctx.agents.get(descendant.childId)).toBeUndefined()
  })

  it('awaits and rolls back an admitted materialization below a scoped root', async () => {
    const { ctx, parent } = await setup([])
    const manager = (ctx.subagents as unknown as {
      continuations: { ownerCtx: Context }
    }).continuations
    const agents = manager.ownerCtx.agents
    const create = agents.create.bind(agents)
    const published = Promise.withResolvers<SessionId>()
    const releaseMaterialization = Promise.withResolvers<undefined>()
    const createSpy = vi.spyOn(agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      published.resolve(handle.agent.id)
      await releaseMaterialization.promise
      return handle
    })

    try {
      const starting = ctx.subagents.startContinuable(startSpec(parent))
      const childId = await published.promise
      let drainResolved = false
      const drained = ctx.subagents.drainContinuableDescendants([parent]).then(() => {
        drainResolved = true
      })
      await Promise.resolve()
      expect(drainResolved).toBe(false)

      releaseMaterialization.resolve(undefined)
      await expect(starting).rejects.toMatchObject({ code: 'DRAINING' })
      await drained
      expect(ctx.agents.get(childId)).toBeUndefined()
    } finally {
      createSpy.mockRestore()
    }
  })

  it('ignores a stale scoped root without disabling its live same-id Agent', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const stale = { ...parent, id: parent.id } as unknown as Agent

    await ctx.subagents.drainContinuableDescendants([stale])
    const started = await ctx.subagents.startContinuable(startSpec(parent))

    await waitNoActivation(ctx, started.childId)
  })

  it('reports a scoped teardown failure after releasing the selected branch', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('target child'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('scoped child reap failed')
    }

    const drained = ctx.subagents.drainContinuableDescendants([parent])
    hold.resolve(undefined)

    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('rejects new materialization and delivery once draining begins', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await drainManager(ctx)

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await expect(queuePrompt(ctx, parent, started.childId, message('too late')))
      .rejects.toMatchObject({ code: 'DRAINING' })
  })

  it('rejects an initial prompt when drain starts after materialization', async () => {
    const { ctx, parent } = await setup([])
    const drains: Promise<void>[] = []
    const accepted: MessageId[] = []
    ctx.on('subagent/start', () => { drains.push(drainManager(ctx)) })
    ctx.on('agent/inbox/inserted', ({ message }) => { accepted.push(message.id) })

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await Promise.all(drains)

    expect(accepted).toEqual([])
    expect(ctx.agents.list()).toEqual([parent])
  })

  it('waits for a published materialization to finish rollback before drain resolves', async () => {
    const { ctx, parent } = await setup([])
    const order: string[] = []
    const drains: Promise<void>[] = []
    ctx.on('agent/created', ({ agent: child }) => {
      if (child === parent) return
      const draining = drainManager(ctx).then(() => { order.push('drain') })
      drains.push(draining)
    })
    ctx.on('agent/disposed', ({ agent: child }) => {
      if (child !== parent) order.push('disposed')
    })

    // `agent/created` runs after registry publication but before materialize()
    // receives the handle and installs the Activation.
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await Promise.all(drains)

    expect(order).toEqual(['disposed', 'drain'])
    expect(ctx.agents.list()).toEqual([parent])
  })

  it('admits a live follow-up before a later drain can begin disposal', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const order: string[] = []
    child.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.content.some(block => block.type === 'text' && block.text === 'before drain')) {
        order.push('enqueue')
      }
    })
    observeCancel(child, () => { order.push('cancel') })

    const delivery = queuePrompt(ctx, parent, started.childId, message('before drain'))
    // Let the child-lock operation reach the live admission cutoff. Admission
    // and inbox submission must then complete in one synchronous span.
    await Promise.resolve()
    const drained = drainManager(ctx)
    hold.resolve(undefined)

    await expect(delivery).resolves.toBeTypeOf('string')
    await drained
    expect(order).toEqual(['enqueue', 'cancel'])
  })

  it('has no automatic replay for an accepted but unlogged message', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('first'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    // Accepted into the inbox, but this queued turn never opens.
    await queuePrompt(ctx, parent, started.childId, message('never logged'))

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    // Only what actually reached the log is reconstructable.
    expect(hasUserText(loaded.events, 'never logged')).toBe(false)
  })
})

describe('continuable review regressions', () => {
  it('rechecks exact parent liveness after cold-resume materialization', async () => {
    const { ctx } = await setup([textResponse('first')])
    const parentId = SessionId('replaceable-parent')
    const originalParent = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(originalParent.agent))
    await waitNoActivation(ctx, started.childId)

    const manager = (ctx.subagents as unknown as {
      continuations: { ownerCtx: Context }
    }).continuations
    const ownerAgents = manager.ownerCtx.agents
    const originalResume = ownerAgents.resume.bind(ownerAgents)
    const resumed = Promise.withResolvers<undefined>()
    const releaseResume = Promise.withResolvers<undefined>()
    const resumeSpy = vi.spyOn(ownerAgents, 'resume').mockImplementation(async (options) => {
      const handle = await originalResume(options)
      resumed.resolve(undefined)
      await releaseResume.promise
      return handle
    })

    const delivery = queuePrompt(
      ctx,
      originalParent.agent,
      started.childId,
      message('must not cross parent replacement'),
    )
    await resumed.promise
    await originalParent.dispose()
    // The durable store still holds the parent, so a same-id replacement is a
    // resume of the persisted session — a distinct exact Agent identity.
    // Called through the unmocked bound original: the spy above must keep
    // gating only the child's in-flight cold resume.
    const replacement = await originalResume({
      resumeSessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    releaseResume.resolve(undefined)

    await expect(delivery).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    resumeSpy.mockRestore()
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'must not cross parent replacement')).toBe(false)
    await replacement.dispose()
  })

  it('clears the accepted reservation when Agent.followup throws', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, { accepted: Set<MessageId> }>
      }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    const realFollowup = child.followup.bind(child)
    child.followup = () => {
      throw new Error('synthetic inbox failure')
    }

    await expect(queuePrompt(ctx, parent, started.childId, message('throws')))
      .rejects.toThrow(/synthetic inbox failure/)
    expect(activation.accepted.size).toBe(0)

    child.followup = realFollowup
    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained
  })

  it('reports the child\'s own terminal reason, not teardown success', async () => {
    // The child hits its token ceiling; teardown still succeeds.
    const { ctx, parent } = await setupWith(new MockAdapter([
      [{ type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'partial' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
        { type: 'finish', reason: { kind: 'max-tokens' } }],
    ]))
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    // Deriving this from disposal success would report the failure as completed.
    expect(ends[0]!.stopReason).toBe('max-tokens')
  })

  it('rejects a live delivery whose caller signal aborted before admission', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const before = child.session.snapshotEvents().length

    const controller = new AbortController()
    controller.abort('caller gave up')
    await expect(queuePrompt(ctx, parent, started.childId, message('cancelled'), controller.signal))
      .rejects.toThrow()

    // Nothing was enqueued, so no later turn can carry it.
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'cancelled')).toBe(false)
    expect(before).toBeGreaterThan(0)
  })

  it('reports this epoch\'s own output, captured while the child was still live', async () => {
    const { ctx, parent } = await setup([textResponse('first answer'), textResponse('second answer')])
    parkParent(ctx, parent)
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    // Handle disposal unregisters the child, so the edge's content must have
    // been captured before that — an after-the-fact lookup would find nothing.
    expect(ends[0]!.lastAssistantMessage).toEqual([{ type: 'text', text: 'first answer' }])

    // A cold resume is a new epoch: it must report its OWN answer, never the
    // previous epoch's, which the replayed transcript still contains.
    await queuePrompt(ctx, parent, started.childId, message('again'))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(2) })
    expect(ends[1]!.lastAssistantMessage).toEqual([{ type: 'text', text: 'second answer' }])
  })

  it('keeps the epoch\'s earlier text past a final empty usage-only message', async () => {
    // A tool-only max-tokens step records an empty assistant/message for
    // usage. The terminal event retains the previous assistant content,
    // including its tool call but not the intervening tool result.
    const { ctx, parent } = await setup([
      toolCallResponse('t1', 'noop', {}, 'partial one'),
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: ToolCallId('t2'), name: 'noop', argumentsDelta: '{}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('t2'), name: 'noop', arguments: '{}' } },
        { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    ])
    ctx.tools.register(defineTool({
      name: 'noop',
      description: 'does nothing',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [{ type: 'text', text: 'noop' }],
      },
      execute: () => Promise.resolve({}),
    }))
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(ends[0]!.stopReason).toBe('max-tokens')
    expect(ends[0]!.lastAssistantMessage).toEqual([
      { type: 'text', text: 'partial one' },
      { type: 'tool-call', id: 't1', name: 'noop', arguments: '{}' },
    ])
  })

  it('reports a resumed epoch that opened no turn without the previous answer', async () => {
    const { ctx, parent } = await setup([textResponse('first answer')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })
    // Block the resumed prompt so this epoch produces nothing of its own.
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === parent) return next()
      return { kind: 'reject' }
    })
    await queuePrompt(ctx, parent, started.childId, message('again'))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    // Reading the whole session would resurrect 'first answer' here. The
    // rejection discarded the claimed follow-up, so the epoch reads as refused.
    expect(ends[0]!.lastAssistantMessage).toBeUndefined()
    expect(ends[0]!.stopReason).toBe('refusal')
  })

  it('reports handle-disposal failure on the terminal edge', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const activation = await vi.waitFor(() => {
      const found = manager.activations.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('scoped cleanup failed')
    }

    await expect(drainManager(ctx)).rejects.toThrow()
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    // Emitting before disposal would have reported this failed epoch as success.
    expect(ends[0]!.stopReason).toBe('error')
  })

  it('reports a pre-disposal teardown failure on the terminal edge', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', info => void ends.push(info))

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, { observer: { capture: (child: Agent) => void } }>
      }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    activation.observer.capture = () => { throw new Error('capture failed') }

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(ends[0]!.stopReason).toBe('error')
  })

  it('preserves independent pre-disposal and handle-disposal failures', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, {
          handle: { dispose: () => Promise<void> }
          observer: { capture: (child: Agent) => void }
        }>
      }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.observer.capture = () => { throw new Error('capture failed') }
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('scoped cleanup failed')
    }

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    const failure = await drained.catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    expect(String(failure)).toContain('capture failed')
    expect(String(failure)).toContain('scoped cleanup failed')
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('cancels a running turn before the best-effort final flush', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('slow'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const order: string[] = []
    ctx.on('session/flush', (session) => {
      if (session.header.parentSession !== undefined) order.push('flush')
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    observeCancel(child, () => { order.push('cancel') })

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained

    // Flushing a still-running turn cannot cover the events cancellation adds.
    expect(order.indexOf('cancel')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('cancel')).toBeLessThan(order.lastIndexOf('flush'))
  })

  it('releases an accepted message that is discarded instead of run', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    // Queue a turn, then cancel so it is discarded rather than dequeued. The
    // Activation must still reach settlement instead of waiting on that id.
    await queuePrompt(ctx, parent, started.childId, message('discarded'))

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'discarded')).toBe(false)
  })

  it('settles after a delivery discarded inside its own admission window', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!

    // Cancel from the synchronous enqueue observer: the discard fires after the
    // id is recorded but before `queuePrompt()` returns.
    const off = child.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.content.some(block => block.type === 'text' && block.text === 'doomed')) {
        child.cancel({ kind: 'user' })
      }
    })
    await queuePrompt(ctx, parent, started.childId, message('doomed'))
    off()

    releaseFirst.resolve(undefined)
    // Retaining the discarded id would pin residency at `running` forever, so
    // reaching no-Activation without an explicit drain is the assertion.
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'doomed')).toBe(false)
  })

  it('releases older ids discarded during a later admission window', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, { accepted: Set<MessageId> }>
      }
    }).continuations
    const activation = manager.activations.get(started.childId)!

    await queuePrompt(ctx, parent, started.childId, message('queued'))
    expect(activation.accepted.size).toBe(1)
    const off = child.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.content.some(block => block.type === 'text' && block.text === 'doomed')) {
        child.cancel({ kind: 'user' })
      }
    })
    await queuePrompt(ctx, parent, started.childId, message('doomed'))
    off()

    expect(activation.accepted.size).toBe(0)
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('reports a prompt a pre-step rejection discarded as refusal', async () => {
    const { ctx, parent } = await setup([])
    parkParent(ctx, parent)
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })
    // A UserPromptSubmit deny or a policy plugin: the child claims its prompt,
    // the rejection discards it, and no step ever runs.
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === parent) return next()
      return { kind: 'reject' }
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    // The parent would otherwise believe a vetoed delivery was done and never
    // resend it — the one failure the settlement promise says cannot happen.
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(ends[0]!.stopReason).toBe('refusal')
  })

  it('retains the Activation while an accepted message is still in the inbox', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const registeredAtEnqueue: boolean[] = []
    // A synchronous inbox observer runs before the admitting microtask, the
    // exact window where `Agent.status` is still idle.
    ctx.on('agent/inbox/inserted', ({ agent }) => {
      if (agent.session.header.parentSession !== undefined) {
        registeredAtEnqueue.push(ctx.agents.get(agent.id) === agent)
      }
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)
    await queuePrompt(ctx, parent, started.childId, message('queued'))

    expect(registeredAtEnqueue.length).toBeGreaterThan(0)
    expect(registeredAtEnqueue).not.toContain(false)
    expect(ctx.agents.get(started.childId)).toBe(child)
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    // Two child turns; the third request is the parent's own turn on the
    // settlement notice.
    expect(adapter.requests.filter(request => request.sessionId === started.childId)).toHaveLength(2)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'queued')).toBe(true)
  })
})

/** Every settlement notice this agent received, in order, as flat text. */
function settlementNotices(agent: Agent): { sender: string; text: string; summary: string }[] {
  const logged = agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data] : [])
  return [...logged, ...agent.inbox.nextStep, ...agent.inbox.nextTurn].flatMap((message) => {
    if (message.source.kind !== 'subagent-settled') return []
    return [{
      sender: message.source.senderSessionId,
      summary: message.source.summary,
      text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
    }]
  })
}

describe('continuable adjacent-Agent delivery', () => {
  it('rejects a stale sender before resolving either adjacent target', async () => {
    const { ctx, parent } = await setup([])
    const stale = { ...parent, id: parent.id } as unknown as Agent

    await expect(ctx.subagents.sendMessage(stale, SessionId('target'), message('stale'), {
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('explains that a host-owned child Session is not a resident continuable child', async () => {
    const { ctx, parent } = await setup([])
    const childId = SessionId('host-owned-child')
    const handle = await ctx.agents.create({
      sessionId: childId,
      meta: { parentSession: parent.id, origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    await expect(ctx.subagents.sendMessage(handle.agent, parent.id, message('cannot report'), {
      signal: testSignal,
    })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: `agent "${childId}" is not a resident continuable child and cannot send to parent "${parent.id}"`,
    })

    await handle.dispose()
  })

  it('steers an idle direct parent and preserves sender attribution', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child answer'), gate: releaseChild.promise },
      { chunks: textResponse('parent report ack') },
      { chunks: textResponse('parent settlement ack') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === started.childId)).toHaveLength(1)
    })
    const child = ctx.agents.get(started.childId)
    expect(child).toBeDefined()

    const messageId = await ctx.subagents.sendMessage(child!, parent.id, message('an explicit message'), {
      signal: testSignal,
    })

    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === parent.id)).toHaveLength(1)
    })
    const delivered = parent.session.snapshotEvents().flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'agent-message' ? [event.data] : [])[0]
    expect(delivered?.id).toBe(messageId)
    expect(delivered?.source).toMatchObject({
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: started.childId,
    })
    expect(delivered?.content).toEqual([
      { type: 'text', text: `Agent ${started.childId} sent a message:` },
      { type: 'text', text: 'an explicit message' },
    ])

    releaseChild.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === parent.id)).toHaveLength(2)
    })
  })

  it('rejects child-to-parent delivery when the direct parent is not live', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child answer'), gate: releaseChild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const get = ctx.agents.get.bind(ctx.agents)
    const getSpy = vi.spyOn(ctx.agents, 'get').mockImplementation(id => (
      id === parent.id ? undefined : get(id)
    ))

    await expect(ctx.subagents.sendMessage(child, parent.id, message('cannot arrive'), {
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE' })

    getSpy.mockRestore()
    releaseChild.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('translates direct-parent Steer rejection into an availability error', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child answer'), gate: releaseChild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const rejection = new Error('parent closed admission')
    vi.spyOn(parent, 'steer').mockImplementation(() => { throw rejection })

    await expect(ctx.subagents.sendMessage(child, parent.id, message('cannot arrive'), {
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE', cause: rejection })

    releaseChild.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })
})

describe('continuable settlement delivery', () => {
  it('tells the parent what the child finished with, without being asked', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    const notice = settlementNotices(parent)[0]!
    expect(notice.sender).toBe(started.childId)
    expect(notice.text).toBe(
      `Background subagent ${started.childId} finished and will do no further work unless you send it more.`
      + '\nIts closing message:\nthe answer',
    )
    // The collapsed row states the outcome without the child's content.
    expect(notice.summary).toBe(
      `Background subagent ${started.childId} finished and will do no further work unless you send it more.`,
    )
  })

  it('delivers settlement even when the child already sent a message', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    await ctx.subagents.sendMessage(child, parent.id, message('an explicit message'), {
      signal: testSignal,
    })
    await waitNoActivation(ctx, started.childId)

    // The contract is unconditional precisely so the parent-side tool
    // description can promise it; bookkeeping "did it report?" would make the
    // promise conditional on a channel this manager does not own.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
  })

  it('delivers the terminal reason when the child never had a chance to report', async () => {
    const { ctx, parent } = await setup([maxTokensResponse('half an ans'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} ran out of room before it finished.`
      + '\nIts closing message:\nhalf an ans',
    )
  })

  it('tells the parent a policy-rejected delivery was declined, not finished', async () => {
    const { ctx, parent } = await setup([textResponse('parent ack')])
    // A pre-step rejection on the child — a UserPromptSubmit deny, a policy
    // plugin — discards the claimed prompt without running it.
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === parent) return next()
      return { kind: 'reject' }
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} declined the task.`
      + '\nIt left no closing message.',
    )
  })

  it('reports a turn that failed before reaching its first step', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('the answer'), gate: releaseFirst.promise },
      { chunks: textResponse('parent ack') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    // The shipped durability checkpoint (`dsh-session-checkpoint-policy`) is
    // fail-closed at the step boundary, so a rejected write ends the turn after
    // it claimed its messages and before it entered a step.
    ctx.on('agent/pre-step', async ({ agent: subject, turn }, next) => {
      if (subject.session.header.parentSession === undefined || turn < 2) return next()
      throw new Error('ENOSPC: no space left on device')
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await queuePrompt(ctx, parent, started.childId, message('second task'))
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    // The parent must not be told the child finished: the delivery it is still
    // waiting on was claimed out of the inbox and then swallowed by the failure.
    const child = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(child.events, 'second task')).toBe(false)
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} failed before it finished.`
      + '\nIts closing message:\nthe answer',
    )
  })

  it('reports accepted work cut short before its first step as stopped', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const releaseCheckpoint = Promise.withResolvers<undefined>()
    const atCheckpoint = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('the answer'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    // A step-boundary participant — the shipped durability checkpoint, a hook,
    // prompt assembly — holding the child's second turn open before its first
    // step, which is where teardown cancellation then catches it.
    ctx.on('agent/pre-step', async ({ agent: subject, turn }, next) => {
      if (subject.session.header.parentSession === undefined || turn < 2) return next()
      atCheckpoint.resolve(undefined)
      await releaseCheckpoint.promise
      return next()
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    // Queued while turn 1 still runs, so turn 2 opens and claims it without a
    // second model call: the Activation is mid-turn when the drain cancels it.
    await queuePrompt(ctx, parent, started.childId, message('second task'))
    releaseFirst.resolve(undefined)
    await atCheckpoint.promise
    const drained = drainManager(ctx)
    releaseCheckpoint.resolve(undefined)
    await drained

    // Turn 2 leaves a balanced no-step `aborted` end, so the log alone would
    // answer with turn 1's clean completion and tell the parent its still-unrun
    // task had finished.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIts closing message:\nthe answer',
    )
  })

  it('reports a child stopped before it ever reached the model as stopped', async () => {
    const releaseCheckpoint = Promise.withResolvers<undefined>()
    const atCheckpoint = Promise.withResolvers<undefined>()
    const { ctx, parent } = await setupWith(new GatedAdapter([]))
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject.session.header.parentSession === undefined) return next()
      atCheckpoint.resolve(undefined)
      await releaseCheckpoint.promise
      return next()
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await atCheckpoint.promise
    const drained = drainManager(ctx)
    releaseCheckpoint.resolve(undefined)
    await drained

    // This epoch closed no stepped turn at all, which on its own reads as "had
    // nothing to report"; only the interruption distinguishes it from a child
    // that genuinely finished with no output.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIt left no closing message.',
    )
  })

  it('reports a child an ancestor interrupted before its first step as stopped', async () => {
    const atCheckpoint = Promise.withResolvers<undefined>()
    const releaseCheckpoint = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('parent ack') }])
    const { ctx, parent } = await setupWith(adapter)
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject.session.header.parentSession === undefined) return next()
      atCheckpoint.resolve(undefined)
      await releaseCheckpoint.promise
      return next()
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await atCheckpoint.promise
    // The shipped interrupt path: nothing about it runs inside this manager, so
    // no pre-cancel sample could see it — the child's own log has to say so.
    ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
    releaseCheckpoint.resolve(undefined)
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIt left no closing message.',
    )
  })

  it('reports accepted work cancelled before any turn could open as stopped', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const releaseMaintenance = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('the answer'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    // A descendant keeps the child resident once its own turn closes, so the
    // maintenance phase below is reachable without racing settlement.
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(ctx.agents.get(grandchild.childId)).toBeDefined() })
    releaseChild.resolve(undefined)
    await vi.waitFor(() => { expect(child.status).toBe('idle') })

    // Context maintenance folds into `idle` and defers waking work, so this
    // delivery is accepted with no turn to claim it.
    const maintaining = child.runMaintenance(async () => { await releaseMaintenance.promise })
    await queuePrompt(ctx, parent, started.childId, message('never runs'))
    const drained = drainManager(ctx)
    releaseMaintenance.resolve(undefined)
    releaseGrandchild.resolve(undefined)
    await maintaining
    await drained

    // Turn 1 closed cleanly and no later turn opened, so the cancelled queue is
    // the only record that this epoch was cut short.
    expect(hasUserText(child.session.snapshotEvents(), 'never runs')).toBe(false)
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIts closing message:\nthe answer',
    )
  })

  it('withholds an outcome the harness could not durably release', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose(): Promise<void> } }> }
    }).continuations
    const activation = await vi.waitFor(() => {
      const live = manager.activations.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    const dispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await dispose()
      throw new Error('scope unwind failed')
    }

    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} failed before it finished.\nIt left no closing message.`,
    )
  })

  it('gives an idle parent one ordinary turn on the notice', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const turnStarts: number[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === parent.id && event.type === 'turn/start') turnStarts.push(event.data.turn)
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === parent.id)).toHaveLength(1)
    })
    expect(turnStarts).toEqual([1])
  })

  it('batches simultaneous notices into one step of a busy parent', async () => {
    const releaseChildren = Promise.withResolvers<undefined>()
    const releaseParent = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent works'), gate: releaseParent.promise },
      { chunks: textResponse('first child'), gate: releaseChildren.promise },
      { chunks: textResponse('second child'), gate: releaseChildren.promise },
      { chunks: textResponse('parent reacts') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    // Open a parent turn first, so both notices arrive while it is running.
    parent.followup(createUserMessage({ content: message('start working'), source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(parent.status).toBe('running') })

    const first = await ctx.subagents.startContinuable(startSpec(parent))
    const second = await ctx.subagents.startContinuable(startSpec(parent))
    releaseChildren.resolve(undefined)
    await waitNoActivation(ctx, first.childId)
    await waitNoActivation(ctx, second.childId)

    // Both notices are waiting for the same step boundary, not two turns.
    expect(parent.inbox.nextStep).toHaveLength(2)
    expect(parent.inbox.nextTurn).toHaveLength(0)
    const turnStarts: number[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === parent.id && event.type === 'turn/start') turnStarts.push(event.data.turn)
    })
    releaseParent.resolve(undefined)
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(2) })
    expect(turnStarts).toEqual([])
    // Both children released together, so which settles first is not ordered.
    expect(new Set(settlementNotices(parent).map(entry => entry.sender)))
      .toEqual(new Set([first.childId, second.childId]))
  })

  it('holds a maintaining parent live until it can read the notice', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const releaseSecond = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('outer') },
      { chunks: textResponse('first inner'), gate: releaseFirst.promise },
      { chunks: textResponse('second inner'), gate: releaseSecond.promise },
      { chunks: textResponse('outer reacts') },
      { chunks: textResponse('root reacts') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const outer = await ctx.subagents.startContinuable(startSpec(parent))
    const middle = await vi.waitFor(() => {
      const live = ctx.agents.get(outer.childId)
      expect(live).toBeDefined()
      return live!
    })
    const first = await ctx.subagents.startContinuable(startSpec(middle))
    const second = await ctx.subagents.startContinuable(startSpec(middle))
    await vi.waitFor(() => { expect(middle.status).toBe('idle') })

    // `Agent.status` folds maintenance into `idle`, and a waking send behind it
    // only arms a deferred wake. The first child's release moves the middle
    // Activation's settlement watcher onto its quiescence race; the second one
    // then arrives at exactly the point where an unaccounted delivery would be
    // judged quiet, settled, and cancelled — clearing the inbox it sits in.
    const maintaining = Promise.withResolvers<undefined>()
    const maintenance = middle.runMaintenance(async () => { await maintaining.promise })
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, first.childId)
    releaseSecond.resolve(undefined)
    await waitNoActivation(ctx, second.childId)
    expect(ctx.agents.get(outer.childId)).toBe(middle)

    maintaining.resolve(undefined)
    await maintenance
    await vi.waitFor(() => { expect(settlementNotices(middle)).toHaveLength(2) })
    expect(settlementNotices(middle).map(entry => entry.sender))
      .toEqual([first.childId, second.childId])
    await waitNoActivation(ctx, outer.childId)
  })

  it('delivers before releasing the ownership that lets the parent settle', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('outer') },
      { chunks: textResponse('inner'), gate: releaseChild.promise },
      { chunks: textResponse('outer reacts') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const outer = await ctx.subagents.startContinuable(startSpec(parent))
    const middle = await vi.waitFor(() => {
      const live = ctx.agents.get(outer.childId)
      expect(live).toBeDefined()
      return live!
    })
    const inner = await ctx.subagents.startContinuable(startSpec(middle))
    await vi.waitFor(() => { expect(middle.status).toBe('idle') })

    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { ownedChildren: Set<SessionId> }> }
    }).continuations
    let ownedAtDelivery: SessionId[] | undefined
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent !== middle || message.source.kind !== 'subagent-settled') return
      ownedAtDelivery = [...manager.activations.get(middle.id)!.ownedChildren]
    })

    releaseChild.resolve(undefined)
    await waitNoActivation(ctx, inner.childId)
    // Still owned at delivery: the parent is structurally unable to settle in
    // the window the notice crosses, rather than winning a race against it.
    expect(ownedAtDelivery).toEqual([inner.childId])
    await waitNoActivation(ctx, outer.childId)
  })

  it('does not wake a parent whose own teardown already began', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained

    // Delivered and durably logged, but no turn: waking a parent the host is
    // about to dispose spends a model request nothing reads. What happens to the
    // message when that parent is disposed next is pinned by the test below.
    expect(settlementNotices(parent)).toHaveLength(1)
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIt left no closing message.',
    )
    expect(parent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced')).toBe(true)
    expect(parent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    expect(parent.status).toBe('idle')
  })

  it('does not wake a parent below a scoped teardown root', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = ctx.subagents.drainContinuableDescendants([parent])
    hold.resolve(undefined)
    await drained

    expect(settlementNotices(parent)).toHaveLength(1)
    expect(parent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('records but cannot deliver a teardown notice once the parent is disposed too', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx } = await setupWith(adapter)
    const parentId = SessionId('closing-parent')
    const host = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = ctx.subagents.drainContinuableDescendants([host.agent])
    hold.resolve(undefined)
    await drained
    expect(settlementNotices(host.agent)).toHaveLength(1)

    // Disposal is a `keepInbox: false` cancel, so it durably cancels the notice
    // it never claimed. Teardown delivery therefore reaches a parent that is
    // still resident — a resumed one reads the log, not a pending message — and
    // no wording anywhere may promise otherwise.
    await host.dispose()
    const resumed = await ctx.agents.resume({
      resumeSessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(settlementNotices(resumed.agent)).toEqual([])
    await resumed.dispose()
    // The account is still in the durable log: delivered, then cancelled unread.
    const persisted = await loadStoredSession(ctx.sessionPersistence, parentId)
    expect(persisted.events.flatMap(event => event.type === 'agent/inbox/spliced'
      ? [{ inserted: event.data.inserted.length, removed: event.data.removedCount ?? 0 }]
      : [])).toEqual([{ inserted: 1, removed: 0 }, { inserted: 0, removed: 1 }])
  })

  it('drops the notice without disturbing teardown when the parent is gone', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: releaseChild.promise }])
    const { ctx } = await setupWith(adapter)
    const warnings: string[] = []
    ctx.logger.warn = (text: string) => { warnings.push(text) }
    const host = await ctx.agents.create({
      sessionId: SessionId('disposable-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    releaseChild.resolve(undefined)
    await host.dispose()
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(warnings).toEqual([])
  })

  it('logs a rejected notice instead of failing the child\'s teardown', async () => {
    const { ctx, parent } = await setup([textResponse('the answer')])
    const warnings: string[] = []
    ctx.logger.warn = (text: string) => { warnings.push(text) }
    vi.spyOn(parent, 'followup').mockImplementation(() => {
      throw new Error('parent closed during delivery')
    })
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(ends[0]!.stopReason).toBe('completed')
    expect(warnings.some(warning => warning.includes('settlement notice was not delivered'))).toBe(true)
  })

  it('stays silent about a child the caller was told does not exist', async () => {
    const { ctx, parent } = await setup([])
    const drains: Promise<void>[] = []
    ctx.on('subagent/start', () => { drains.push(drainManager(ctx)) })

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await Promise.all(drains)
    expect(settlementNotices(parent)).toEqual([])
  })
})

describe('continuable lifecycle observation', () => {
  it('emits one paired start/end per residency epoch', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    parkParent(ctx, parent)
    const starts: SubagentRunInfo[] = []
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/start', (info) => { starts.push(info) })
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })

    // A cold resume is a NEW epoch with its own pair.
    await queuePrompt(ctx, parent, started.childId, message('again'))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(2) })

    expect(starts).toHaveLength(2)
    expect(starts.map(info => info.id)).toEqual([started.childId, started.childId])
    expect(starts.map(info => info.provider)).toEqual(['spawn', 'spawn'])
    // Each end pairs its own start's runId.
    expect(ends.map(info => info.runId)).toEqual(starts.map(info => info.runId))
    // Both epochs ran their own scripted response; neither exhausted the corpus.
    expect(ends.map(info => info.stopReason)).toEqual(['completed', 'completed'])
  })
})

describe('continuable public API', () => {
  it('exposes no host authority, residency query, cancellation, steering, or report operation', async () => {
    const { ctx } = await setup([])
    const subagents: Record<string, unknown> = ctx.subagents as unknown as Record<string, unknown>
    for (const absent of [
      'activationState',
      'cancel',
      'kill',
      'report',
      'resume',
      'steer',
      'steerContinuable',
      'userAuthority',
    ]) {
      expect(subagents[absent]).toBeUndefined()
    }
    // No steering tool and no report tool are registered by this seam.
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).not.toContain('report')
    expect(names).not.toContain('steer_subagent')
  })

  it('keeps one-shot runs free of a steering capability', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot work',
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    expect('steer' in run).toBe(false)
    await run.result
    await run.dispose()
  })

  it('reports a caller-signal abort before acceptance without delivering', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const controller = new AbortController()
    controller.abort('caller gave up')
    await expect(queuePrompt(ctx, parent, started.childId, message('aborted'), controller.signal))
      .rejects.toThrow()

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'aborted')).toBe(false)
  })

  it('does not cancel an accepted turn when the caller signal aborts afterwards', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    const controller = new AbortController()
    await queuePrompt(ctx, parent, started.childId, message('survives'), controller.signal)
    // After acceptance the manager owns the Activation independently.
    controller.abort('caller gave up')

    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'survives')).toBe(true)
  })
})

describe('continuable errors', () => {
  it('rejects a duplicate Activation at the agent registry collision boundary', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Drop the Activation without disposing the Agent, leaving the id live but
    // unmanaged. Materialization must not adopt it.
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, unknown> }
    }).continuations
    manager.activations.delete(started.childId)

    await expect(queuePrompt(ctx, parent, started.childId, message('hello')))
      .rejects.toThrow(SubagentError)
    expect(ctx.agents.get(started.childId)).toBe(child)
    hold.resolve(undefined)
  })

  it('rejects a parent that is no longer the live registry entry', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // A stale parent reference: same id, not the exact live entry.
    const stale = { ...parent, id: parent.id } as unknown as Agent

    await expect(queuePrompt(ctx, stale, started.childId, message('stale')))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    void child
  })

  it('rejects establishing a child under a parent whose disposal already began', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })

    // Begin the parent Activation's teardown, then try to give it a child.
    const drained = drainManager(ctx)
    await expect(ctx.subagents.startContinuable(startSpec(child)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    hold.resolve(undefined)
    await drained
  })

  it('reports a failing branch after every branch settles, without pinning the rest', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(ctx.agents.get(grandchild.childId)).toBeDefined() })
    // Make the grandchild's own handle disposal reject: scope teardown failure
    // propagates, unlike a contained `agent/disposed` listener throw.
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const branch = manager.activations.get(grandchild.childId)!
    const realDispose = branch.handle.dispose.bind(branch.handle)
    branch.handle.dispose = async () => {
      await realDispose()
      throw new Error('grandchild reap failed')
    }

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    // The other branch still released, and durable sessions survive.
    expect(ctx.agents.get(started.childId)).toBeUndefined()
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.meta.id).toBe(started.childId)
  })

  it('rejects a new child at admission when the parent disposal transaction is already open', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent child'), gate: hold.promise },
      { chunks: textResponse('unused') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const outer = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(outer.childId)
      expect(found).toBeDefined()
      return found!
    })
    // The would-be parent's disposal is already open at the entry hold, so the
    // establishment rejects before any grandchild resource exists.
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { disposal: Promise<void> | undefined }> }
    }).continuations
    const before = new Set(ctx.agents.list().map(agent => agent.id))
    manager.activations.get(outer.childId)!.disposal = Promise.resolve()

    await expect(ctx.subagents.startContinuable(startSpec(child)))
      .rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id).filter(id => !before.has(id))).toEqual([])
    })
    hold.resolve(undefined)
  })

  it('rolls the transfer back when the parent begins disposal during materialization', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent child'), gate: hold.promise },
      { chunks: textResponse('unused') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const outer = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(outer.childId)
      expect(found).toBeDefined()
      return found!
    })
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, { disposal: Promise<void> | undefined }>
        ownerCtx: Context
      }
    }).continuations
    const ownerAgents = manager.ownerCtx.agents
    const before = new Set(ctx.agents.list().map(agent => agent.id))
    // Open the would-be parent's disposal only once the grandchild's Agent is
    // being created: the entry hold has already passed, so the post-transfer
    // ownership registration must reject and roll the transfer back with no
    // Activation and no live Agent left behind.
    const originalCreate = ownerAgents.create.bind(ownerAgents)
    const createSpy = vi.spyOn(ownerAgents, 'create').mockImplementation((options) => {
      manager.activations.get(outer.childId)!.disposal = Promise.resolve()
      createSpy.mockRestore()
      return originalCreate(options)
    })

    await expect(ctx.subagents.startContinuable(startSpec(child)))
      .rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id).filter(id => !before.has(id))).toEqual([])
    })
    hold.resolve(undefined)
  })

  it('releases the parent hold when a cold delivery fails, so the parent can settle', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done'), gate: release.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })

    // The failed delivery to a missing child must give back the hold it put on
    // the delivering parent; a leaked hold would pin the parent in `waiting`.
    await expect(queuePrompt(ctx, child, SessionId('no-such-child'), message('hello')))
      .rejects.toMatchObject({ code: 'NOT_RESUMABLE' })

    release.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('follows up on an already-owned running grandchild without a duplicate hold', async () => {
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
      { chunks: textResponse('follow-up answer') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(2) })

    // The delivering parent already owns this running child, so the entry hold
    // is a no-op and the delivery is accepted as ordinary inbox work.
    const accepted = await queuePrompt(ctx, child, grandchild.childId, message('one more'))
    expect(accepted).toBeTypeOf('string')

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('reapplies the descriptor model route and reasoning effort on cold resume', async () => {
    const effort = ReasoningEffortId('high')
    const adapter = new MockAdapter([textResponse('first'), textResponse('resumed')], {
      efforts: [{ id: effort, name: 'High' }],
      defaultEffort: effort,
    })
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: {
        prompt: message('routed work'),
        parent,
        agentOptions: { provider: 'mock', model: 'child-model', reasoningEffort: effort },
      },
    })
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.events.find(event => event.type === 'subagent/descriptor')?.data)
      .toMatchObject({
        agentProvider: 'mock',
        agentModel: 'child-model',
        agentReasoningEffort: 'high',
      })

    // The resumed Activation runs on the declared route, not the parent's.
    await queuePrompt(ctx, parent, started.childId, message('again'))
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId)?.options).toMatchObject({
        model: 'child-model',
        reasoningEffort: 'high',
      })
    })
    await waitNoActivation(ctx, started.childId)
    const resumed = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(resumed.events.flatMap(event => event.type === 'request/header'
      ? [event.data.header.config.reasoningEffort]
      : [])).toEqual([effort, effort])
  })

  it('unloading the manager drains its live activations', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child'), gate: hold.promise }])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-continuation-'))
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
    cleanups.push(async () => {
      await persistenceFiber.dispose()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    const serviceFiber = await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    // Manager unload uses the same drain, so no child outlives its runtime.
    const disposal = serviceFiber.dispose()
    hold.resolve(undefined)
    await disposal
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })
})

describe('SubagentRuntime.interrupt', () => {
  it('aborts the current turn durably, parks accepted follow-ups, and resumes them only on a waking send', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
      { chunks: textResponse('third') },
      { chunks: textResponse('fourth') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    await queuePrompt(ctx, parent, started.childId, message('parked B'))
    await queuePrompt(ctx, parent, started.childId, message('parked C'))
    const cancelSpy = vi.spyOn(child, 'cancel')

    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })

    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    // Cancellation is cooperative: the held model call observes it on release.
    releaseFirst.resolve(undefined)
    await child.whenIdle()
    // Parked, not resumed: no second model request follows the abort, the
    // accepted follow-ups stay pending, and the same Activation stays resident.
    expect(adapter.requests).toHaveLength(1)
    expect(child.inbox.nextTurn).toHaveLength(2)
    expect(child.status).toBe('idle')
    expect(ctx.agents.get(started.childId)).toBe(child)

    // Only an explicit waking send restores the driver; the parked items then
    // run before it in the existing FIFO order.
    await queuePrompt(ctx, parent, started.childId, message('waking D'))
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'parked B', 'parked C', 'waking D'])
    const turnEnds = loaded.events
      .filter(event => event.type === 'turn/end')
      .map(event => (event).data.reason.kind)
    expect(turnEnds).toEqual(['aborted', 'completed', 'completed', 'completed'])
  })

  it('interrupts only the target while its resident descendant keeps running', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    const childCancel = vi.spyOn(child, 'cancel')
    const grandchildCancel = vi.spyOn(grandchildAgent, 'cancel')

    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })

    expect(childCancel).toHaveBeenCalledTimes(1)
    releaseChild.resolve(undefined)
    await child.whenIdle()
    // The target parks as a waiting owner; the published descendant was never
    // signalled and keeps its own turn open.
    expect(grandchildCancel).not.toHaveBeenCalled()
    expect(ctx.agents.get(started.childId)).toBe(child)
    expect(ctx.agents.get(grandchild.childId)).toBe(grandchildAgent)

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, grandchild.childId)
    const turnEnds = loaded.events
      .filter(event => event.type === 'turn/end')
      .map(event => (event).data.reason.kind)
    expect(turnEnds).toEqual(['completed'])
  })

  it('authorizes the human address against the live target\'s durable direct parent', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const cancelSpy = vi.spyOn(child, 'cancel')

    expect(() => { ctx.subagents.interrupt(started.childId, {
      kind: 'user',
      parentSessionId: SessionId('stranger'),
    }) }).toThrow(/belongs to another parent session/)
    expect(cancelSpy).not.toHaveBeenCalled()

    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    expect(cancelSpy).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    hold.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('lets a deep exact live ancestor interrupt its descendant with the parent cause', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    const childCancel = vi.spyOn(child, 'cancel')
    const grandchildCancel = vi.spyOn(grandchildAgent, 'cancel')

    // Deep ancestor: the top-level parent interrupts the grandchild.
    ctx.subagents.interrupt(grandchild.childId, { kind: 'ancestor', agent: parent })
    expect(grandchildCancel).toHaveBeenCalledWith({ kind: 'parent' }, { keepInbox: true })
    // Direct ancestor: the same authority kind covers the immediate parent.
    ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
    expect(childCancel).toHaveBeenCalledWith({ kind: 'parent' }, { keepInbox: true })

    releaseChild.resolve(undefined)
    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('rejects self, sibling, stale, and unrelated ancestor callers without touching the target', async () => {
    const releaseA = Promise.withResolvers<undefined>()
    const releaseB = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('a'), gate: releaseA.promise },
      { chunks: textResponse('b'), gate: releaseB.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const targetStart = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const target = ctx.agents.get(targetStart.childId)!
    const siblingStart = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const sibling = ctx.agents.get(siblingStart.childId)!
    const stranger = await ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })
    const stale = { ...parent, id: parent.id } as unknown as Agent
    const cancelSpy = vi.spyOn(target, 'cancel')

    expect(() => { ctx.subagents.interrupt(targetStart.childId, { kind: 'ancestor', agent: target }) })
      .toThrow(/cannot interrupt itself/)
    expect(() => { ctx.subagents.interrupt(targetStart.childId, { kind: 'ancestor', agent: sibling }) })
      .toThrow(/not a live descendant/)
    expect(() => { ctx.subagents.interrupt(targetStart.childId, { kind: 'ancestor', agent: stranger }) })
      .toThrow(/not a live descendant/)
    expect(() => { ctx.subagents.interrupt(targetStart.childId, { kind: 'ancestor', agent: stale }) })
      .toThrow(/exact live ancestor/)
    // A stale caller is rejected before target lookup, even for an absent id.
    expect(() => { ctx.subagents.interrupt(SessionId('missing'), { kind: 'ancestor', agent: stale }) })
      .toThrow(/exact live ancestor/)
    expect(cancelSpy).not.toHaveBeenCalled()

    releaseA.resolve(undefined)
    releaseB.resolve(undefined)
    await waitNoActivation(ctx, targetStart.childId)
    await waitNoActivation(ctx, siblingStart.childId)
  })

  it('accepts absent and one-shot ids as no-ops without touching the one-shot Agent', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    ctx.subagents.interrupt(SessionId('missing'), { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(SessionId('missing'), { kind: 'ancestor', agent: parent })

    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot work',
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    const oneShot = run.localAgent!
    const cancelSpy = vi.spyOn(oneShot, 'cancel')
    ctx.subagents.interrupt(run.id, { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(run.id, { kind: 'ancestor', agent: parent })
    expect(cancelSpy).not.toHaveBeenCalled()
    await run.result
    await run.dispose()
  })

  it('accepts an interrupt after natural completion', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
  })

  it('accepts an interrupt that lost the race with disposal without signalling twice', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const cancelSpy = vi.spyOn(child, 'cancel')

    // Scoped teardown opens the disposal transaction synchronously and issues
    // its own whole-Activation cancel before this call returns.
    const drained = ctx.subagents.drainContinuableDescendants([parent])
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    // Interrupt after the cutoff: accepted no-op, no second signal, no waiting.
    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    hold.resolve(undefined)
    await drained
  })
})
