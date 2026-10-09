import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import type { ContentBlock, GenerateOptions, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId, createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, {
  SubagentError,
  SUBAGENT_DESCRIPTOR_VERSION,
} from '../src/index.ts'
import type { SubagentRunEndInfo, SubagentRunInfo } from '../src/index.ts'
import type { SubagentPromptRequestId } from '../src/control-types.ts'
import * as activationResults from '../src/activation.ts'
import { requireLocalActivation } from '../src/activation.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession } from './persistence-helpers.ts'
import {
  managerState,
  subagentManager,
  dropActivation,
} from './manager-internals.ts'

const subagentConfigs = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()

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
  options: { persistence?: boolean; sessionQuery?: boolean; maxActiveSubagents?: number } = {},
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
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
  await mountWorkingDirectoryFixture(ctx)
  subagentConfigs.set(ctx, await liveConfig(ctx, SubagentRuntime,
    options.maxActiveSubagents === undefined ? {} : { maxActiveSubagents: options.maxActiveSubagents }))
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

function hasAssistantText(events: readonly SessionEvent[], text: string): boolean {
  return events.some(event => event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type === 'text' && block.text === text))
}

/** Caller-supplied user message texts in log order (runtime-context snapshots excluded). */
function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'runtime-context'
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
  return subagentManager(ctx).queuePrompt(parent, childId, content, { kind: 'user' }, signal)
}

function humanPrompt(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  text: string,
  delivery: 'queue' | 'steer',
) {
  return ctx.subagents.prompt({
    requestId: `request-${text}` as SubagentPromptRequestId,
    parentSessionId: parent.id,
    childSessionId: childId,
    mode: 'continuable',
    delivery,
    content: message(text),
  }, testSignal)
}

/**
 * Exercise manager-wide teardown through the package-private owner rather than
 * adding the irreversible operation to the public service contract.
 */
function drainManager(ctx: Context): Promise<void> {
  return subagentManager(ctx).drain()
}

/** Wait until a child's Activation is gone, i.e. its handle finished disposal. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

/** Wait until the settlement watcher has checked the child's current idle state. */
async function passSettlementCheck(ctx: Context, childId: SessionId): Promise<void> {
  const manager = childLocks(ctx)
  const release = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const barrier = manager.locks.run(childId, async () => {
    entered.resolve(undefined)
    await release.promise
  })
  await entered.promise
  release.resolve(undefined)
  await barrier
  await manager.locks.run(childId, () => Promise.resolve())
}

/** The manager's package-private lock, which orders every child decision. */
function childLocks(ctx: Context) {
  return managerState(ctx)
}

/**
 * Occupy one child's lock so a settlement watcher that already observed
 * quiescence waits behind the caller, which is the window where later Agent
 * activity or Inbox changes race disposal.
 * @returns the release callback and the held lock's completion.
 */
async function holdChildLock(
  ctx: Context,
  childId: SessionId,
): Promise<{ release: () => void; held: Promise<void> }> {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const held = childLocks(ctx).locks.run(childId, async () => {
    entered.resolve(undefined)
    await release.promise
  })
  await entered.promise
  return { release: () => { release.resolve(undefined) }, held }
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

describe('continuable activation capacity', () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid configured capacity %s', async (maxActiveSubagents) => {
    const ctx = new Context()
    try {
      await mountWorkingDirectoryFixture(ctx)
      await expect(ctx.plugin(SubagentRuntime, { maxActiveSubagents })).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('layers editable depth over composition and removes the section on disposal', async () => {
    const ctx = new Context()
    try {
      await mountWorkingDirectoryFixture(ctx)
      const live = await liveConfig(ctx, SubagentRuntime, { maxDepth: 4 })
      subagentConfigs.set(ctx, live)
      const fiber = live.fiber
      expect(ctx.subagents.resolveMaxDepth()).toBe(4)
      await subagentConfigs.get(ctx)!.update({ maxDepth: 0 })
      expect(ctx.subagents.resolveMaxDepth()).toBe(0)
      expect(ctx.subagents.resolveMaxDepth(2)).toBe(2)
      expect(ctx.subagents.resolveMaxDepth('provider-managed')).toBeUndefined()
      await expect(subagentConfigs.get(ctx)!.update({ maxDepth: -1 })).rejects.toThrow()
      await expect(subagentConfigs.get(ctx)!.update({ maxDepth: 1.5 })).rejects.toThrow()
      await expect(subagentConfigs.get(ctx)!.update({ maxActiveSubagents: 0 })).rejects.toThrow()
      expect(ctx.subagents.resolveMaxDepth()).toBe(0)
      await subagentConfigs.get(ctx)!.replace({ maxDepth: 4 })
      expect(ctx.subagents.resolveMaxDepth()).toBe(4)
      await fiber.dispose()
      expect(ctx.get('subagents')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies capacity edits to an existing root without stopping resident children', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter(Array.from({ length: 4 }, () => ({ chunks: textResponse('done'), gate: release.promise })))
    const { ctx, parent } = await setupWith(adapter, { maxActiveSubagents: 1 })
    parkParent(ctx, parent)
    try {
      const first = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      await subagentConfigs.get(ctx)!.update({ maxActiveSubagents: 2 })
      const second = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      await subagentConfigs.get(ctx)!.update({ maxActiveSubagents: 1 })
      expect(ctx.agents.get(first.childId)).toBeDefined()
      expect(ctx.agents.get(second.childId)).toBeDefined()
      await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      await subagentConfigs.get(ctx)!.update({ maxActiveSubagents: 3 })
      const third = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      release.resolve(undefined)
      await Promise.all([first, second, third].map(child => waitNoActivation(ctx, child.childId)))
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('defaults to eight live children and reuses capacity after settlement', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      ...Array.from({ length: 8 }, () => ({ chunks: textResponse('done'), gate: release.promise })),
      { chunks: textResponse('replacement') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    parkParent(ctx, parent)
    try {
      const started = await Promise.all(Array.from({ length: 8 }, () => ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })))
      await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      release.resolve(undefined)
      await Promise.all(started.map(child => waitNoActivation(ctx, child.childId)))
      const replacement = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      await waitNoActivation(ctx, replacement.childId)
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('shares slots across siblings, providers and nested children while isolating roots', async () => {
    const release = Promise.withResolvers<undefined>()
    const releaseParent = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent done'), gate: releaseParent.promise },
      ...Array.from({ length: 3 }, () => ({ chunks: textResponse('done'), gate: release.promise })),
    ])
    const { ctx, parent } = await setupWith(adapter, { maxActiveSubagents: 3 })
    const other = await ctx.agentLoop.create(SessionId('other-root'), { provider: 'mock', model: 'mock' })
    parkParent(ctx, parent)
    parkParent(ctx, other)
    try {
      const first = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      const child = ctx.agents.get(first.childId)!
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      const nested = await ctx.subagents.startActivation({ ...startSpec(child, 'fork'), delivery: 'parent' })
      const sibling = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      await expect(ctx.subagents.startActivation({ ...startSpec(ctx.agents.get(nested.childId)!), delivery: 'parent' }))
        .rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
        .rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      const independent = await ctx.subagents.startActivation({ ...startSpec(other), delivery: 'parent' })
      parkParent(ctx, child)
      releaseParent.resolve(undefined)
      await child.whenIdle()
      expect(managerState(ctx).resident.get(first.childId)).toBeDefined()
      await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
        .rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      release.resolve(undefined)
      await Promise.all([first, nested, sibling, independent].map(entry => waitNoActivation(ctx, entry.childId)))
    } finally {
      releaseParent.resolve(undefined)
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('reserves the last slot before asynchronous creation and returns it after failure', async () => {
    const { ctx, parent } = await setupWith(new MockAdapter([textResponse('replacement')]), { maxActiveSubagents: 1 })
    parkParent(ctx, parent)
    const agents = managerState(ctx).ownerCtx.agents
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const createSpy = vi.spyOn(agents, 'create').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      throw new Error('creation failed')
    })
    const starting = ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const rejected = expect(starting).rejects.toThrow('creation failed')
    try {
      await entered.promise
      await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      expect(createSpy).toHaveBeenCalledTimes(1)
      release.resolve(undefined)
      await rejected
      createSpy.mockRestore()
      const replacement = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      await waitNoActivation(ctx, replacement.childId)
    } finally {
      release.resolve(undefined)
      createSpy.mockRestore()
      await rejected
      await ctx.fiber.dispose()
    }
  })

  it('counts caller-awaited and parent-delivered runs against the same capacity', async () => {
    const release = Promise.withResolvers<undefined>()
    const releaseCaller = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent-delivered'), gate: release.promise },
      { chunks: textResponse('caller-awaited'), gate: releaseCaller.promise },
    ])
    const { ctx, parent } = await setupWith(adapter, { maxActiveSubagents: 1 })
    parkParent(ctx, parent)
    try {
      const child = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'caller' }))
        .rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      release.resolve(undefined)
      await waitNoActivation(ctx, child.childId)

      const caller = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'caller' })
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
      await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
        .rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      releaseCaller.resolve(undefined)
      expect((await caller.result).output).toEqual(message('caller-awaited'))
      await caller.dispose()
      await waitNoActivation(ctx, caller.childId)
    } finally {
      release.resolve(undefined)
      releaseCaller.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('checks cold resume but accepts messages to an already resident child at capacity', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first') },
      { chunks: textResponse('busy'), gate: release.promise },
      { chunks: textResponse('queued') },
      { chunks: textResponse('resumed') },
    ])
    const { ctx, parent } = await setupWith(adapter, { maxActiveSubagents: 1 })
    parkParent(ctx, parent)
    try {
      const old = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      await waitNoActivation(ctx, old.childId)
      const busy = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
      await expect(queuePrompt(ctx, parent, old.childId, message('resume'))).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      await queuePrompt(ctx, parent, busy.childId, message('queue at capacity'))
      release.resolve(undefined)
      await waitNoActivation(ctx, busy.childId)
      await queuePrompt(ctx, parent, old.childId, message('resume'))
      await waitNoActivation(ctx, old.childId)
      const loaded = await loadStoredSession(ctx.sessionPersistence, old.childId)
      expect(userTexts(loaded.events)).toEqual(['child task', 'resume'])
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it.each([false, true])('retains the slot through disposal, including cleanup failure: %s', async (failDisposal) => {
    const releaseRun = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('busy'), gate: releaseRun.promise },
      { chunks: textResponse('replacement') },
    ])
    const { ctx, parent } = await setupWith(adapter, { maxActiveSubagents: 1 })
    parkParent(ctx, parent)
    const entered = Promise.withResolvers<undefined>()
    const releaseDisposal = Promise.withResolvers<undefined>()
    try {
      const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      const activation = managerState(ctx).resident.get(started.childId)!
      const handle = requireLocalActivation(activation).handle
      const dispose = handle.dispose.bind(handle)
      handle.dispose = async () => {
        entered.resolve(undefined)
        await releaseDisposal.promise
        await dispose()
        if (failDisposal) throw new Error('cleanup report failed')
      }
      const drained = ctx.subagents.drainChildren(parent, [started.childId])
      const outcome = drained.catch((error: unknown) => error)
      releaseRun.resolve(undefined)
      await entered.promise
      await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
      releaseDisposal.resolve(undefined)
      expect(await outcome).toEqual(failDisposal ? expect.objectContaining({ code: 'ACTIVATION_TEARDOWN_FAILED' }) : undefined)
      const replacement = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      await waitNoActivation(ctx, replacement.childId)
    } finally {
      releaseRun.resolve(undefined)
      releaseDisposal.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })
})

describe('SubagentRuntime.startActivation', () => {
  it('returns both identities at inbox acceptance, without waiting for the turn or the log', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('first answer')])
    const enqueued: { id: MessageId; loggedYet: boolean }[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      // Acceptance is the boundary `startActivation` resolves at, so observe
      // the log state exactly there rather than after later microtasks.
      enqueued.push({ id: message.id, loggedYet: hasUserText(agent.session.snapshotEvents(), 'child task') })
    })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })

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

    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
      ...startSpec(parent),
      childId: reservedId,
    })
    expect(started.childId).toBe(reservedId)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    await expect(ctx.subagents.startActivation({
      delivery: 'parent',
      ...startSpec(parent),
      childId: reservedId,
    })).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })

    release.resolve(undefined)
    await waitNoActivation(ctx, reservedId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, reservedId)
    expect(loaded.meta.id).toBe(reservedId)

    await expect(ctx.subagents.startActivation({
      delivery: 'parent',
      ...startSpec(parent),
      childId: reservedId,
    })).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })
    expect(ctx.agents.get(reservedId)).toBeUndefined()
  })

  it('rejects reserved child ids for an external backend before dispatch', async () => {
    const { ctx, parent } = await setup([])
    const start = vi.fn(async () => { throw new Error('must not dispatch') })
    ctx.subagents.registerProvider({
      name: 'one-shot',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start,
    })

    await expect(ctx.subagents.startActivation({ ...startSpec(parent, 'one-shot'), delivery: 'parent', childId: SessionId('reserved-external') }))
      .rejects.toThrow(/reserved child ids require a local backend/)
    expect(start).not.toHaveBeenCalled()
    // No child Agent and no session were created.
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects synchronously when persistence is not configured', async () => {
    const { ctx, parent } = await setup([textResponse('unused')], { persistence: false })
    await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
      .rejects.toThrow(/require session persistence/)
  })

  it('publishes the reserved child id and appends the pre-turn descriptor', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
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

    await expect(ctx.subagents.startActivation({ ...startSpec(parent, 'spawn', controller.signal), delivery: 'parent' }))
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

    await expect(ctx.subagents.startActivation({ ...startSpec(parent, 'spawn', controller.signal), delivery: 'parent' }))
      .rejects.toThrow()

    // No resident child and no queued turn survive the abort.
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
  })

  it.each(['parent', 'caller'] as const)('releases the %s-delivery activation when its catalog append fails', async (delivery) => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const childId = SessionId('00000000-0000-4000-8000-000000000321')
    const catalogFailure = new Error('catalog append failed')
    const cleanupFailure = new Error('activation disposal also failed')
    const appendCatalog = parent.session.append.bind(parent.session) as (
      type: 'subagent/catalog',
      data: SessionEventMap['subagent/catalog'],
    ) => SessionEvent<'subagent/catalog'>
    vi.spyOn(parent.session, 'append').mockImplementation(((type: string, data: unknown) => {
      if (type === 'subagent/catalog') {
        const activation = managerState(ctx).resident.get(childId)
        if (activation === undefined) throw new Error('expected live Activation')
        const handle = requireLocalActivation(activation).handle
        const dispose = handle.dispose.bind(handle)
        vi.spyOn(handle, 'dispose').mockImplementation(async () => {
          await dispose()
          throw cleanupFailure
        })
        throw catalogFailure
      }
      return appendCatalog('subagent/catalog', data as SessionEventMap['subagent/catalog'])
    }) as typeof parent.session.append)

    await expect(ctx.subagents.startActivation({
      delivery,
      ...startSpec(parent),
      childId,
    })).rejects.toBe(catalogFailure)

    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() })
    expect(parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog')).toEqual([])
  })

  it('preserves prompt admission failure when Activation disposal also fails', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const childId = SessionId('00000000-0000-4000-8000-000000000322')
    const admissionFailure = new Error('prompt admission failed')
    const cleanupFailure = new Error('activation disposal also failed')
    const controller = new AbortController()
    const warnings: string[] = []
    ctx.logger.warn = (message: string) => { warnings.push(message) }
    ctx.on('subagent/start', () => {
      const activation = managerState(ctx).resident.get(childId)
      if (activation === undefined) throw new Error('expected live Activation')
      const handle = requireLocalActivation(activation).handle
      const dispose = handle.dispose.bind(handle)
      vi.spyOn(handle, 'dispose').mockImplementation(async () => {
        await dispose()
        throw cleanupFailure
      })
      controller.abort(admissionFailure)
    })

    await expect(ctx.subagents.startActivation({
      delivery: 'parent',
      ...startSpec(parent, 'spawn', controller.signal),
      childId,
    })).rejects.toBe(admissionFailure)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() })
    expect(warnings.some(warning => warning.startsWith(
      'subagent continuation: disposal after admission or catalog append failure also failed:',
    ))).toBe(true)
  })

  it('rolls an unpublished Activation back when lifecycle publication fails', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', info => void ends.push(info))
    ctx.on('internal/dispatch', (_mode, eventName) => {
      if (eventName === 'subagent/start') throw new Error('start publication failed')
    }, { global: true })

    await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
      .rejects.toThrow(/start publication failed/)

    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
    expect(ends).toEqual([])
    await expect(drainManager(ctx)).resolves.toBeUndefined()
  })

  it('rejects a continuable child that would exceed the configured depth cap', async () => {
    const { ctx, parent } = await setup([])
    await expect(ctx.subagents.startActivation({
      delivery: 'parent',
      ...startSpec(parent),
      request: { prompt: message('deep'), parent, maxDepth: 0 },
    })).rejects.toThrow(/exceeds maxDepth 0/)
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects an invalid continuable depth cap before provider preparation', async () => {
    const { ctx, parent } = await setup([])
    await expect(ctx.subagents.startActivation({
      delivery: 'parent',
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
    const started = await ctx.subagents.startActivation({ ...startSpec(routeless), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
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
    const started = await ctx.subagents.startActivation({ ...startSpec(routeless), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)
    // End the first lifecycle so its write leases release before the fresh
    // context re-creates the parent identity and cold-resumes the child.
    await ctx.fiber.dispose()

    const fresh = new Context()
    await mountAgentLoopTestDependencies(fresh)
    const freshPersistence = await fresh.plugin(JsonlSessionPersistence, { root: root! })
    // This context opened a second handle on the same root; register it so
    // afterEach closes it before removing the root (even on a failure path).
    cleanups.push(async () => { await freshPersistence.dispose() })
    await fresh.plugin(AgentLoop, { agents: [] })
    await fresh.plugin(TestSessionQuery)
    await mountWorkingDirectoryFixture(fresh)
    await fresh.plugin(SubagentRuntime)
    await fresh.plugin(SubagentSpawn, { providerName: 'spawn' })
    // The disposed lifecycle drained the parent's log durably, so the fresh
    // context resumes that identity instead of re-creating it.
    const freshParent = (await fresh.agents.resume({ resumeSessionId: SessionId('routeless-resume'), agentOptions: {} })).agent
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent, 'fork'), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const capability = Promise.withResolvers<{ inputModalities: string[] }>()
    const readingCapability = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(() => {
      readingCapability.resolve(undefined)
      return capability.promise as never
    })

    const delivery = queuePrompt(ctx, parent, started.childId, [imageBlock])
    try {
      await Promise.race([readingCapability.promise, delivery])
      releaseFirst.resolve(undefined)
      const draining = drainManager(ctx)
      capability.resolve({ inputModalities: ['text', 'image'] })

      await expect(delivery).rejects.toMatchObject({ code: 'DRAINING' })
      await draining
    } finally {
      releaseFirst.resolve(undefined)
      capability.resolve({ inputModalities: ['text', 'image'] })
      await Promise.allSettled([delivery, drainManager(ctx)])
    }
  })

  it('rejects a materialized image follow-up whose capability read raced a drain', async () => {
    const { ctx, parent } = await setup([textResponse('child work')])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)
    const capability = Promise.withResolvers<{ inputModalities: string[] }>()
    const readingCapability = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(() => {
      readingCapability.resolve(undefined)
      return capability.promise as never
    })

    const delivery = queuePrompt(ctx, parent, started.childId, [imageBlock])
    try {
      await Promise.race([readingCapability.promise, delivery])
      const draining = drainManager(ctx)
      capability.resolve({ inputModalities: ['text', 'image'] })

      await expect(delivery).rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
      await draining
    } finally {
      capability.resolve({ inputModalities: ['text', 'image'] })
      await Promise.allSettled([delivery, drainManager(ctx)])
    }
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'image'))).toBe(false)
  })

  it('defers to the text-only projection when the descriptor declares no model route', async () => {
    const { ctx } = await setup([])
    const routeless = await ctx.agentLoop.create(SessionId('routeless-image'), {})
    const started = await ctx.subagents.startActivation({ ...startSpec(routeless), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent, 'retired'), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // The child starts its own continuable grandchild, then goes quiescent.
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // startActivation held the child→grandchild ownership edge; a followup
    // from the same managed parent to the same child re-holds it as a no-op,
    // and its failure-path release must not drop the established edge.
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)
    const stranger = await ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })

    await expect(queuePrompt(ctx, stranger, started.childId, message('mine now')))
      .rejects.toThrow(/belongs to another parent session/)
  })

  it('reports an unresumable child whose persisted log has no supported descriptor', async () => {
    const { ctx, parent } = await setup([])
    const childId = SessionId('child-without-descriptor')
    const child = await ctx.agents.create({
      sessionId: childId,
      meta: { origin: 'subagent', parentSession: parent.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await ctx.sessions.flush(child.agent.session)
    await child.dispose()

    const rejection: unknown = await queuePrompt(ctx, parent, childId, message('continue'))
      .catch((error: unknown) => error)
    expect(rejection).toMatchObject({
      code: 'NOT_RESUMABLE',
      message: `subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`,
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)
    const failure = new SubagentError('materialization denied', 'UNAUTHORIZED')
    ctx.agents.resume = () => Promise.reject(failure)

    await expect(queuePrompt(ctx, parent, started.childId, message('continue')))
      .rejects.toBe(failure)
  })

  it('cold-resumes a delivery that lost the race with final disposal', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after the race')])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

describe('continuable human steering delivery', () => {
  it('places resident steering in nextStep with its durable identity and source', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: release.promise },
      { chunks: textResponse('steered') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!

    const receipt = await humanPrompt(ctx, parent, started.childId, 'resident steer', 'steer')
    expect(child.inbox.nextStep).toContainEqual(expect.objectContaining({
      id: receipt.messageId,
      content: message('resident steer'),
      source: { kind: 'user', rpcId: 'request-resident steer' },
    }))

    release.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('cold-resumes steering into nextStep instead of inventing another queue', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('steered')])
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)

    const receipt = await humanPrompt(ctx, parent, started.childId, 'cold steer', 'steer')
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.target === 'next-step'
      && event.data.inserted.some(message => message.id === receipt.messageId))).toBe(true)
    expect(hasUserText(loaded.events, 'cold steer')).toBe(true)
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    expect(ctx.agents.roots()).toEqual([parent])
    expect(ctx.agents.isOwnedBy(child.id, parent)).toBe(true)
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })

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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)
    // The top-level parent remains independently registered after its child settles.
    expect(ctx.agents.get(parent.id)).toBe(parent)
  })
})

describe('continuable durability and teardown', () => {
  it('rechecks direct Agent inbox work accepted during the final flush', async () => {
    const releaseFirstTurn = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first answer'), gate: releaseFirstTurn.promise },
      { chunks: textResponse('late answer') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    parkParent(ctx, parent)
    const flushing = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    let childFlushes = 0
    ctx.on('session/flush', async (session) => {
      if (session.header.parentSession === undefined) return
      childFlushes++
      if (childFlushes !== 1) return
      flushing.resolve(undefined)
      await releaseFlush.promise
    })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = ctx.agents.get(started.childId)!
    const cancelSpy = vi.spyOn(child, 'cancel')
    releaseFirstTurn.resolve(undefined)
    await flushing.promise
    expect(cancelSpy).not.toHaveBeenCalled()
    child.followup(createUserMessage({ content: message('accepted during flush'), source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(2)
      expect(hasAssistantText(child.session.snapshotEvents(), 'late answer')).toBe(true)
    })
    await child.whenIdle()
    expect(cancelSpy).not.toHaveBeenCalled()
    releaseFlush.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    expect(childFlushes).toBe(2)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'accepted during flush')).toBe(true)
    expect(hasAssistantText(loaded.events, 'late answer')).toBe(true)
  })

  it('retries after Session-only work completes during the final flush', async () => {
    const releaseFirstTurn = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('answer'), gate: releaseFirstTurn.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    parkParent(ctx, parent)
    const flushing = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    let childFlushes = 0
    ctx.on('session/flush', async (session) => {
      if (session.header.parentSession === undefined) return
      childFlushes++
      if (childFlushes !== 1) return
      flushing.resolve(undefined)
      await releaseFlush.promise
    })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = ctx.agents.get(started.childId)!
    releaseFirstTurn.resolve(undefined)
    await flushing.promise
    child.session.append('user/message', createUserMessage({
      content: message('detached result'),
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    releaseFlush.resolve(undefined)

    await waitNoActivation(ctx, started.childId)
    expect(childFlushes).toBe(2)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'detached result')).toBe(true)
  })

  it('keeps a child acquired during the final flush before settling', async () => {
    const releaseFirstTurn = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child answer'), gate: releaseFirstTurn.promise },
      { chunks: textResponse('grandchild answer'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    parkParent(ctx, parent)
    const flushing = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    let heldFinalFlush = false
    ctx.on('session/flush', async (session) => {
      if (session.header.parentSession !== parent.id || heldFinalFlush) return
      heldFinalFlush = true
      flushing.resolve(undefined)
      await releaseFlush.promise
    })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = ctx.agents.get(started.childId)!
    releaseFirstTurn.resolve(undefined)
    await flushing.promise
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })

    releaseFlush.resolve(undefined)
    await passSettlementCheck(ctx, started.childId)
    expect(ctx.agents.get(started.childId)).toBe(child)

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('lets explicit disposal win while the natural final flush is pending', async () => {
    const releaseFirstTurn = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('answer'), gate: releaseFirstTurn.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    parkParent(ctx, parent)
    const flushing = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    let heldFinalFlush = false
    ctx.on('session/flush', async (session) => {
      if (session.header.parentSession !== parent.id || heldFinalFlush) return
      heldFinalFlush = true
      flushing.resolve(undefined)
      await releaseFlush.promise
    })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    releaseFirstTurn.resolve(undefined)
    await flushing.promise
    const drained = drainManager(ctx)
    await drained

    releaseFlush.resolve(undefined)
    await passSettlementCheck(ctx, started.childId)
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('rechecks maintenance that claims the Agent during the final flush', async () => {
    const releaseFirstTurn = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: releaseFirstTurn.promise }])
    const { ctx, parent } = await setupWith(adapter)
    parkParent(ctx, parent)
    const flushing = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    let heldFinalFlush = false
    ctx.on('session/flush', async (session) => {
      if (session.header.parentSession === undefined || heldFinalFlush) return
      heldFinalFlush = true
      flushing.resolve(undefined)
      await releaseFlush.promise
    })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = ctx.agents.get(started.childId)!
    const cancelSpy = vi.spyOn(child, 'cancel')
    releaseFirstTurn.resolve(undefined)
    await flushing.promise
    expect(cancelSpy).not.toHaveBeenCalled()
    const releaseMaintenance = Promise.withResolvers<undefined>()
    let maintenanceSignal: AbortSignal | undefined
    const maintenance = child.runMaintenance(async (signal) => {
      maintenanceSignal = signal
      await releaseMaintenance.promise
    })
    const runMaintenance = child.runMaintenance.bind(child)
    const settlementClaimAttempted = Promise.withResolvers<undefined>()
    vi.spyOn(child, 'runMaintenance').mockImplementation((task) => {
      settlementClaimAttempted.resolve(undefined)
      return runMaintenance(task)
    })

    releaseFlush.resolve(undefined)
    await settlementClaimAttempted.promise
    expect(maintenanceSignal?.aborted).toBe(false)
    expect(ctx.agents.get(started.childId)).toBe(child)

    releaseMaintenance.resolve(undefined)
    await maintenance
    await waitNoActivation(ctx, started.childId)
  })

  it('settles despite the persistence backend being disposed mid-run', async () => {
    const releaseResponse = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('unconfirmed answer'), gate: releaseResponse.promise },
    ])
    const { ctx, parent, disposePersistence } = await setupWith(adapter)
    const warnings: string[] = []
    ctx.logger.warn = (message: string) => { warnings.push(message) }

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const activation = managerState(ctx).resident.get(started.childId)!
    const handle = requireLocalActivation(activation).handle
    const realDispose = handle.dispose.bind(handle)
    handle.dispose = async () => {
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })
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
    const target = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const sibling = await ctx.subagents.startActivation({ ...startSpec(siblingParent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const targetChild = ctx.agents.get(target.childId)!
    const siblingChild = ctx.agents.get(sibling.childId)!
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(targetChild), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    const cancellations: SessionId[] = []
    observeCancel(targetChild, () => { cancellations.push(targetChild.id) })
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    observeCancel(grandchildAgent, () => { cancellations.push(grandchildAgent.id) })

    const drained = ctx.subagents.drainDescendants([parent])
    const convergedDrain = ctx.subagents.drainDescendants([parent])

    // The scoped cutoff stops only the selected forest. The sibling child stays
    // resident and can accept later work while target cleanup is still blocked.
    expect(cancellations).toEqual([target.childId, grandchild.childId])
    expect(ctx.agents.get(target.childId)).toBe(targetChild)
    expect(ctx.agents.get(grandchild.childId)).toBeDefined()
    expect(ctx.agents.get(sibling.childId)).toBe(siblingChild)
    await expect(queuePrompt(ctx, siblingParent, sibling.childId, message('still live')))
      .resolves.toBeTypeOf('string')
    await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
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
    await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const cancellations: SessionId[] = []
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    observeCancel(grandchildAgent, () => { cancellations.push(grandchildAgent.id) })

    const drained = ctx.subagents.drainDescendants([child])

    expect(cancellations).toEqual([grandchild.childId])
    expect(ctx.agents.get(started.childId)).toBe(child)
    releaseGrandchild.resolve(undefined)
    await drained
    expect(ctx.agents.get(grandchild.childId)).toBeUndefined()
    expect(ctx.agents.get(started.childId)).toBe(child)
    await expect(ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' }))
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
    const target = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const sibling = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const targetAgent = ctx.agents.get(target.childId)!
    const siblingAgent = ctx.agents.get(sibling.childId)!
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(targetAgent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    const cancel = vi.spyOn(targetAgent, 'cancel')

    // A repeated id folds to one teardown and an absent target is an accepted no-op.
    const drained = ctx.subagents.drainChildren(
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

    await expect(ctx.subagents.drainChildren(parent, [SessionId('settled-child')]))
      .resolves.toBeUndefined()
  })

  it('reports selected-child disposal failures after releasing the child', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('target'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const target = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const activation = managerState(ctx).resident.get(target.childId)!
    const handle = requireLocalActivation(activation).handle
    const realDispose = handle.dispose.bind(handle)
    handle.dispose = async () => {
      await realDispose()
      throw new Error('selected cleanup failed')
    }

    const drained = ctx.subagents.drainChildren(parent, [target.childId])
    hold.resolve(undefined)

    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    expect(ctx.agents.get(target.childId)).toBeUndefined()
  })

  it('rejects selected-child teardown through another live parent', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('target'), gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const other = await ctx.agentLoop.create(SessionId('other-parent'), { provider: 'mock', model: 'mock' })
    const target = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    await expect(ctx.subagents.drainChildren(other, [target.childId]))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(ctx.agents.get(target.childId)).toBeDefined()

    release.resolve(undefined)
    await waitNoActivation(ctx, target.childId)
  })

  it('rejects selected-child teardown through a stale parent identity', async () => {
    const { ctx, parent } = await setup([])
    const stale = { ...parent, id: parent.id } as Agent

    await expect(ctx.subagents.drainChildren(stale, []))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('finds scoped descendants after an intermediate host Agent leaves the registry', async () => {
    const releaseIntermediate = Promise.withResolvers<undefined>()
    const releaseDescendant = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('host task'), gate: releaseIntermediate.promise },
      { chunks: textResponse('continuable descendant'), gate: releaseDescendant.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('intermediate-host-agent'),
        meta: { origin: 'subagent', parentSession: parent.id },
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const intermediate = handle.agent
      intermediate.followup(createUserMessage({ content: message('host task'), source: { kind: 'user' } }))
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      const descendant = await ctx.subagents.startActivation({ ...startSpec(intermediate), delivery: 'parent' })
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })

      const intermediateId = intermediate.id
      const disposingIntermediate = handle.dispose()
      releaseIntermediate.resolve(undefined)
      await disposingIntermediate
      expect(ctx.agents.get(intermediateId)).toBeUndefined()
      expect(ctx.agents.get(descendant.childId)).toBeDefined()
      const cancellations: SessionId[] = []
      const descendantAgent = ctx.agents.get(descendant.childId)!
      observeCancel(descendantAgent, () => { cancellations.push(descendantAgent.id) })

      const drained = ctx.subagents.drainDescendants([parent])

      expect(cancellations).toEqual([descendant.childId])
      releaseDescendant.resolve(undefined)
      await drained
      expect(ctx.agents.get(descendant.childId)).toBeUndefined()
    } finally {
      releaseIntermediate.resolve(undefined)
      releaseDescendant.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('awaits and rolls back an admitted materialization below a scoped root', async () => {
    const { ctx, parent } = await setup([])
    const agents = managerState(ctx).ownerCtx.agents
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
      const starting = ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
      const childId = await published.promise
      let drainResolved = false
      const drained = ctx.subagents.drainDescendants([parent]).then(() => {
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
    const stale = { ...parent, id: parent.id } as Agent

    await ctx.subagents.drainDescendants([stale])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })

    await waitNoActivation(ctx, started.childId)
  })

  it('reports a scoped teardown failure after releasing the selected branch', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('target child'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const activation = managerState(ctx).resident.get(started.childId)!
    const handle = requireLocalActivation(activation).handle
    const realDispose = handle.dispose.bind(handle)
    handle.dispose = async () => {
      await realDispose()
      throw new Error('scoped child reap failed')
    }

    const drained = ctx.subagents.drainDescendants([parent])
    hold.resolve(undefined)

    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('rejects new materialization and delivery once draining begins', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)

    await drainManager(ctx)

    await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
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

    await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
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
    await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await Promise.all(drains)

    expect(order).toEqual(['disposed', 'drain'])
    expect(ctx.agents.list()).toEqual([parent])
  })

  it('admits a live follow-up before a later drain can begin disposal', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(originalParent.agent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)

    const ownerAgents = managerState(ctx).ownerCtx.agents
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

  it('accepts a later delivery after Agent.followup throws', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const realFollowup = child.followup.bind(child)
    child.followup = () => {
      throw new Error('synthetic inbox failure')
    }

    await expect(queuePrompt(ctx, parent, started.childId, message('throws')))
      .rejects.toThrow(/synthetic inbox failure/)

    child.followup = realFollowup
    const accepted = await queuePrompt(ctx, parent, started.childId, message('accepted later'))
    expect(child.inbox.nextTurn.some(candidate => candidate.id === accepted)).toBe(true)
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    // Deriving this from disposal success would report the failure as completed.
    expect(ends[0]!.stopReason).toBe('max-tokens')
  })

  it.each(['turn/start', 'turn/end'] as const)('settles a local child whose first %s append fails', async (failedEvent) => {
    const { ctx, parent, adapter } = await setup([textResponse('child answer')])
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })
    ctx.on('subagent/start', ({ id }) => {
      const child = ctx.agents.get(id)!
      const append = child.session.append.bind(child.session)
      const spy = vi.spyOn(child.session, 'append')
      spy.mockImplementation(((type: string, ...rest: never[]) => {
        if (type === failedEvent) {
          spy.mockRestore()
          throw new Error(`first ${failedEvent} unavailable`)
        }
        return (append as (...args: never[]) => unknown)(type as never, ...rest)
      }) as never)
    })
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'caller' })
    try {
      let settled = false
      const result = started.result.then((value) => { settled = true; return value })
      await vi.waitFor(() => { expect(settled).toBe(true) })
      await expect(result).resolves.toMatchObject({ stopReason: 'error' })
      expect(ends).toHaveLength(1)
      expect(ends[0]!.stopReason).toBe('error')
      expect(adapter.requests).toHaveLength(failedEvent === 'turn/start' ? 0 : 1)
      expect(ctx.agents.get(started.childId)).toBeUndefined()
    } finally {
      await started.dispose()
      await ctx.fiber.dispose()
    }
  })

  it.each(['turn/start', 'turn/end'] as const)('accepts recovery after a local %s append failure', async (failedEvent) => {
    const { ctx, parent } = await setup(failedEvent === 'turn/start'
      ? [textResponse('recovered')]
      : [textResponse('first answer'), textResponse('recovered')])
    let failed = false
    ctx.on('subagent/start', ({ id }) => {
      const child = ctx.agents.get(id)!
      const append = child.session.append.bind(child.session)
      const spy = vi.spyOn(child.session, 'append')
      spy.mockImplementation(((type: string, ...rest: never[]) => {
        if (type === failedEvent) {
          spy.mockRestore()
          failed = true
          throw new Error('transient local append failure')
        }
        return (append as (...args: never[]) => unknown)(type as never, ...rest)
      }) as never)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (agent === parent || status !== 'idle' || !failed) return
      failed = false
      agent.cancel({ kind: 'hook', reason: 'replace failed task with its retry' })
      agent.followup(createUserMessage({ content: message('retry'), source: { kind: 'user' } }))
    })
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'caller' })
    try {
      await expect(started.result).resolves.toMatchObject({
        stopReason: 'completed', output: [{ type: 'text', text: 'recovered' }],
      })
    } finally {
      await started.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('retains a local failure emitted during an earlier terminal notification', async () => {
    const { ctx, parent } = await setup([textResponse('child answer')])
    ctx.on('session/event', (session, event) => {
      if (session === parent.session || event.type !== 'turn/end') return
      const child = ctx.agents.get(session.id)!
      agentEvents(ctx, child).emit('agent/error', {
        turn: event.data.turn, step: 0, error: new Error('terminal observer failure'),
      })
    }, { prepend: true })
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'caller' })
    try {
      await expect(started.result).resolves.toMatchObject({ stopReason: 'error' })
    } finally {
      await started.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('ignores another Agent failure delivered to a local activation observer', async () => {
    const { ctx, parent } = await setup([textResponse('child answer')])
    ctx.on('subagent/start', ({ id }) => {
      const child = ctx.agents.get(id)!
      child.ctx.emit('agent/error', { agent: parent, turn: 0, step: 0, error: new Error('unrelated failure') })
    })
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'caller' })
    try {
      await expect(started.result).resolves.toMatchObject({ stopReason: 'completed' })
    } finally {
      await started.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects a live delivery whose caller signal aborted before admission', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

  it('delivers a local result after handle cleanup and parent notifications', async () => {
    const turn = Promise.withResolvers<undefined>()
    const cleaning = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: turn.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const followup = vi.spyOn(parent, 'followup')
    const steer = vi.spyOn(parent, 'steer')
    const ended = vi.fn()
    ctx.on('subagent/end', ended)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const activation = managerState(ctx).resident.get(started.childId)!
    const handle = requireLocalActivation(activation).handle
    const realDispose = handle.dispose.bind(handle)
    handle.dispose = async () => {
      cleaning.resolve(undefined)
      await cleanup.promise
      await realDispose()
    }
    const observed = vi.fn()
    void started.result.then(observed, observed)
    const waiting = ctx.subagents.waitForChildren(parent)
    turn.resolve(undefined)
    try {
      await cleaning.promise
      expect(observed).not.toHaveBeenCalled()
      expect(ended).not.toHaveBeenCalled()
      expect(followup).not.toHaveBeenCalled()
      expect(steer).not.toHaveBeenCalled()
    } finally {
      cleanup.resolve(undefined)
      await started.dispose()
    }
    await expect(started.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(ended).toHaveBeenCalledTimes(1)
    expect(followup.mock.calls.length + steer.mock.calls.length).toBe(1)
    expect(managerState(ctx).resident.get(started.childId)).toBeUndefined()
    await expect(waiting).resolves.toBe(true)
  })

  it('reports handle-disposal failure on the terminal edge', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const activation = await vi.waitFor(() => {
      const found = managerState(ctx).resident.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const handle = requireLocalActivation(activation).handle
    const realDispose = handle.dispose.bind(handle)
    handle.dispose = async () => {
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

    await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const capture = vi.spyOn(activationResults, 'captureLocalResult').mockImplementationOnce(() => { throw new Error('capture failed') })

    try {
      const drained = drainManager(ctx)
      hold.resolve(undefined)
      await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
      await vi.waitFor(() => { expect(ends).toHaveLength(1) })
      expect(ends[0]!.stopReason).toBe('error')
    } finally {
      capture.mockRestore()
      hold.resolve(undefined)
    }
  })

  it('releases a naturally settled Activation when terminal capture fails', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', info => void ends.push(info))

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = ctx.agents.get(started.childId)!
    const flushing = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === child.session) {
        flushing.resolve(undefined)
        await releaseFlush.promise
      }
      return flush(session)
    })
    const failure = new Error('capture failed')
    const result = started.result.catch((error: unknown) => error)
    const resultObserved = vi.spyOn(started.result, 'catch')
    const capture = vi.spyOn(activationResults, 'captureLocalResult').mockImplementationOnce(() => {
      throw failure
    })
    let waiting: Promise<boolean> | undefined

    try {
      hold.resolve(undefined)
      await flushing.promise
      waiting = ctx.subagents.waitForChildren(parent)
      await vi.waitFor(() => { expect(resultObserved).toHaveBeenCalled() })
      releaseFlush.resolve(undefined)
      await expect(waiting).resolves.toBe(true)
      await expect(result).resolves.toBe(failure)
      await waitNoActivation(ctx, started.childId)
      await vi.waitFor(() => { expect(ends).toHaveLength(1) })
      expect(ends[0]!.stopReason).toBe('error')
    } finally {
      capture.mockRestore()
      hold.resolve(undefined)
      releaseFlush.resolve(undefined)
      await waiting
      await started.result.catch(() => undefined)
      resultObserved.mockRestore()
      flushSpy.mockRestore()
    }
  })

  it('preserves independent pre-disposal and handle-disposal failures', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const activation = managerState(ctx).resident.get(started.childId)!
    const handle = requireLocalActivation(activation).handle
    const realDispose = handle.dispose.bind(handle)
    const capture = vi.spyOn(activationResults, 'captureLocalResult').mockImplementationOnce(() => { throw new Error('capture failed') })
    handle.dispose = async () => {
      await realDispose()
      throw new Error('scoped cleanup failed')
    }

    try {
      const drained = drainManager(ctx)
      hold.resolve(undefined)
      const failure = await drained.catch((error: unknown) => error)

      expect(failure).toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
      expect(String(failure)).toContain('capture failed')
      expect(String(failure)).toContain('scoped cleanup failed')
      expect(ctx.agents.get(started.childId)).toBeUndefined()
    } finally {
      capture.mockRestore()
      hold.resolve(undefined)
    }
  })

  it('cancels a running turn before the best-effort final flush', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('slow'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const order: string[] = []
    ctx.on('session/flush', (session) => {
      if (session.header.parentSession !== undefined) order.push('flush')
    })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

  it('settles after removing the last message from an idle parked Inbox', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const messageId = await queuePrompt(ctx, parent, started.childId, message('queued'))
    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    release.resolve(undefined)
    await child.whenIdle()
    await passSettlementCheck(ctx, started.childId)
    expect(child.inbox.remove(messageId)).toBe(true)
    await waitNoActivation(ctx, started.childId)
  })

  it('shares disposal when explicit close overtakes a queued idle settlement', async () => {
    const turn = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: turn.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'caller' })
    const activation = managerState(ctx).resident.get(started.childId)!
    const child = ctx.agents.get(started.childId)!
    const handle = requireLocalActivation(activation).handle
    const disposed = vi.spyOn(handle, 'dispose')
    const ended = vi.fn()
    ctx.on('subagent/end', ended)
    const lock = await holdChildLock(ctx, started.childId)
    try {
      turn.resolve(undefined)
      await child.whenIdle()
      await started.dispose()
    } finally {
      lock.release()
      await lock.held
    }
    await passSettlementCheck(ctx, started.childId)
    await expect(started.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledTimes(1)
    expect(managerState(ctx).resident.get(started.childId)).toBeUndefined()
  })

  it('keeps a maintenance task that claimed the idle phase after whenIdle resolved', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    // Held while the child still runs, so the watcher observes idle and then
    // waits here with its settlement decision already outstanding.
    const lock = await holdChildLock(ctx, started.childId)
    release.resolve(undefined)
    await child.whenIdle()
    const finishMaintenance = Promise.withResolvers<undefined>()
    let maintenanceSignal: AbortSignal | undefined
    const maintenance = child.runMaintenance(async (signal) => {
      maintenanceSignal = signal
      await finishMaintenance.promise
    })
    lock.release()
    await lock.held
    await passSettlementCheck(ctx, started.childId)
    expect(maintenanceSignal?.aborted).toBe(false)
    expect(ctx.agents.get(started.childId) !== undefined).toBe(true)
    finishMaintenance.resolve(undefined)
    await maintenance
    await waitNoActivation(ctx, started.childId)
  })

  it('settles when maintenance finishes after losing the idle phase', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const lock = await holdChildLock(ctx, started.childId)
    release.resolve(undefined)
    await child.whenIdle()
    const finishMaintenance = Promise.withResolvers<undefined>()
    const maintenance = child.runMaintenance(async () => { await finishMaintenance.promise })
    lock.release()
    // Let the queued settlement check observe maintenance, then finish it
    // before that check's caller receives the false result.
    queueMicrotask(() => {
      queueMicrotask(() => { finishMaintenance.resolve(undefined) })
    })
    await lock.held
    await maintenance
    await waitNoActivation(ctx, started.childId)
  })

  it.each([
    { label: 'plugin', source: { kind: 'tool-jobs' as const } },
    { label: 'non-plugin', source: { kind: 'team-message', teamId: 't-1' } as never },
  ])('keeps an idle child resident while its Inbox holds $label injected context', async ({ source }) => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const lock = await holdChildLock(ctx, started.childId)
    release.resolve(undefined)
    await child.whenIdle()
    const context = createUserMessage({ content: message('parked context'), source })
    child.inject(context)
    expect(child.inbox.nextStep).toHaveLength(1)
    lock.release()
    await lock.held
    await passSettlementCheck(ctx, started.childId)
    expect(ctx.agents.get(started.childId) !== undefined).toBe(true)
    expect(child.inbox.remove(context.id)).toBe(true)
    await waitNoActivation(ctx, started.childId)
  })

  it('keeps an idle child resident while plugin-sourced steering stays unclaimed', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    // A cordis-host-runner failure report: `steer()` from a plugin still wakes
    // a handle, so residency must survive until that turn claims the message.
    const steered = createUserMessage({
      content: message('Cordis Host handler failed'),
      source: { kind: 'cordis-host-runner' },
    })
    child.steer(steered)
    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    release.resolve(undefined)
    await child.whenIdle()
    await passSettlementCheck(ctx, started.childId)
    expect(ctx.agents.get(started.childId) !== undefined).toBe(true)
    expect(child.inbox.remove(steered.id)).toBe(true)
    await waitNoActivation(ctx, started.childId)
  })

  it('keeps an idle child resident while an interrupted turn leaves human steering parked', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    await humanPrompt(ctx, parent, started.childId, 'steered', 'steer')
    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    release.resolve(undefined)
    await child.whenIdle()
    const parked = child.inbox.nextStep[0]!
    await passSettlementCheck(ctx, started.childId)
    expect(ctx.agents.get(started.childId) !== undefined).toBe(true)
    expect(child.inbox.remove(parked.id)).toBe(true)
    await waitNoActivation(ctx, started.childId)
  })

  it('settles after a delivery discarded inside its own admission window', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!

    // Cancel from the synchronous enqueue observer, before `queuePrompt()`
    // returns from Agent.followup().
    const off = child.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.content.some(block => block.type === 'text' && block.text === 'doomed')) {
        child.cancel({ kind: 'user' })
      }
    })
    await queuePrompt(ctx, parent, started.childId, message('doomed'))
    off()

    releaseFirst.resolve(undefined)
    // The discarded delivery leaves no phantom activity that pins residency.
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'doomed')).toBe(false)
  })

  it('settles after a later delivery discards older queued work', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!

    await queuePrompt(ctx, parent, started.childId, message('queued'))
    const off = child.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.content.some(block => block.type === 'text' && block.text === 'doomed')) {
        child.cancel({ kind: 'user' })
      }
    })
    await queuePrompt(ctx, parent, started.childId, message('doomed'))
    off()

    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(loaded.events, 'queued')).toBe(false)
    expect(hasUserText(loaded.events, 'doomed')).toBe(false)
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const stale = { ...parent, id: parent.id } as Agent

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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
      { type: 'text', text: `Agent ${started.childId} sent a message: ` },
      { type: 'text', text: 'an explicit message' },
    ])

    releaseChild.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === parent.id)).toHaveLength(2)
    })
  })

  it.each(['absent', 'replaced'] as const)('rejects child-to-parent delivery when the direct parent is %s', async (state) => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child answer'), gate: releaseChild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const get = ctx.agents.get.bind(ctx.agents)
    const getSpy = vi.spyOn(ctx.agents, 'get').mockImplementation(id => (
      id === parent.id ? state === 'absent' ? undefined : { ...parent } : get(id)
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
  it('includes the child answer when messaging is available', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    await ctx.plugin(SubagentControl)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    const notice = settlementNotices(parent)[0]!
    expect(notice.sender).toBe(started.childId)
    expect(notice.text).toBe(
      `Background subagent ${started.childId} finished and will do no further work unless you send it more.\nIts closing message:\nthe answer`,
    )
    // The collapsed row states the outcome without the child's content.
    expect(notice.summary).toBe(
      `Background subagent ${started.childId} finished and will do no further work unless you send it more.`,
    )
  })

  it('delivers settlement even when the child already sent a message', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} ran out of room before it finished.\nIts closing message:\nhalf an ans`,
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} declined the task.\nIt left no closing message.`,
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await queuePrompt(ctx, parent, started.childId, message('second task'))
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    // The parent must not be told the child finished: the delivery it is still
    // waiting on was claimed out of the inbox and then swallowed by the failure.
    const child = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(hasUserText(child.events, 'second task')).toBe(false)
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} failed before it finished.\nIts closing message:\nthe answer`,
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
      `Background subagent ${started.childId} was stopped before it finished.\nIts closing message:\nthe answer`,
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await atCheckpoint.promise
    const drained = drainManager(ctx)
    releaseCheckpoint.resolve(undefined)
    await drained

    // This epoch closed no stepped turn at all, which on its own reads as "had
    // nothing to report"; only the interruption distinguishes it from a child
    // that genuinely finished with no output.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.\nIt left no closing message.`,
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await atCheckpoint.promise
    // The shipped interrupt path: nothing about it runs inside this manager, so
    // no pre-cancel sample could see it — the child's own log has to say so.
    ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
    releaseCheckpoint.resolve(undefined)
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.\nIt left no closing message.`,
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    // A descendant keeps the child resident once its own turn closes, so the
    // maintenance phase below is reachable without racing settlement.
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })
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
      `Background subagent ${started.childId} was stopped before it finished.\nIts closing message:\nthe answer`,
    )
  })

  it('delivers the captured answer when local handle cleanup fails', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const activation = await vi.waitFor(() => {
      const live = managerState(ctx).resident.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    const handle = requireLocalActivation(activation).handle
    const dispose = handle.dispose.bind(handle)
    handle.dispose = async () => {
      await dispose()
      throw new Error('scope unwind failed')
    }

    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} finished and will do no further work unless you send it more.\nIts closing message:\nthe answer`,
    )
    await expect(started.result).resolves.toMatchObject({ stopReason: 'completed' })
    await expect(started.dispose()).rejects.toThrow('scope unwind failed')
  })

  it('gives an idle parent one ordinary turn on the notice', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const turnStarts: number[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === parent.id && event.type === 'turn/start') turnStarts.push(event.data.turn)
    })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

    const first = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const second = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const outer = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const middle = await vi.waitFor(() => {
      const live = ctx.agents.get(outer.childId)
      expect(live).toBeDefined()
      return live!
    })
    const first = await ctx.subagents.startActivation({ ...startSpec(middle), delivery: 'parent' })
    const second = await ctx.subagents.startActivation({ ...startSpec(middle), delivery: 'parent' })
    await vi.waitFor(() => { expect(middle.status).toBe('idle') })

    // `whenIdle()` follows maintenance and the deferred wake it releases, so
    // neither settlement notice can be mistaken for completed idle work.
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
    const outer = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const middle = await vi.waitFor(() => {
      const live = ctx.agents.get(outer.childId)
      expect(live).toBeDefined()
      return live!
    })
    const inner = await ctx.subagents.startActivation({ ...startSpec(middle), delivery: 'parent' })
    await vi.waitFor(() => { expect(middle.status).toBe('idle') })

    let ownedAtDelivery: SessionId[] | undefined
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent !== middle || message.source.kind !== 'subagent-settled') return
      ownedAtDelivery = [...managerState(ctx).resident.get(middle.id)!.ownedChildren]
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained

    // Delivered and durably logged, but no turn: waking a parent the host is
    // about to dispose spends a model request nothing reads. What happens to the
    // message when that parent is disposed next is pinned by the test below.
    expect(settlementNotices(parent)).toHaveLength(1)
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.\nIt left no closing message.`,
    )
    expect(parent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced')).toBe(true)
    expect(parent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    expect(parent.status).toBe('idle')
  })

  it('does not wake a parent below a scoped teardown root', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = ctx.subagents.drainDescendants([parent])
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
    const started = await ctx.subagents.startActivation({ ...startSpec(host.agent), delivery: 'parent' })
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = ctx.subagents.drainDescendants([host.agent])
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
    const started = await ctx.subagents.startActivation({ ...startSpec(host.agent), delivery: 'parent' })
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(ends[0]!.stopReason).toBe('completed')
    expect(warnings.some(warning => warning.includes('settlement notice was not delivered'))).toBe(true)
  })

  it('stays silent about a child the caller was told does not exist', async () => {
    const { ctx, parent } = await setup([])
    const drains: Promise<void>[] = []
    ctx.on('subagent/start', () => { drains.push(drainManager(ctx)) })

    await expect(ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' }))
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

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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

  it('catalogs caller-awaited local work without a notice and permits cold continuation', async () => {
    const { ctx, parent } = await setup([textResponse('first answer'), textResponse('second answer')])
    parkParent(ctx, parent)
    const run = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'caller' })
    expect('steer' in run).toBe(false)
    expect((await run.result).output).toEqual(message('first answer'))
    await run.dispose()
    await waitNoActivation(ctx, run.childId)
    expect(settlementNotices(parent)).toEqual([])
    expect(await ctx.subagents.listChildren(parent.id)).toMatchObject([
      { id: run.childId, mode: 'continuable' },
    ])
    expect(userTexts((await loadStoredSession(ctx.sessionPersistence, run.childId)).events))
      .toEqual(['child task'])

    await queuePrompt(ctx, parent, run.childId, message('continue'))
    await waitNoActivation(ctx, run.childId)
    const stored = await loadStoredSession(ctx.sessionPersistence, run.childId)
    expect(userTexts(stored.events)).toEqual(['child task', 'continue'])
    expect(stored.events.some(event => event.type === 'assistant/message' && JSON.stringify(event).includes('second answer'))).toBe(true)
  })

  it('reports a caller-signal abort before acceptance without delivering', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Drop the Activation without disposing the Agent, leaving the id live but
    // unmanaged. Materialization must not adopt it.
    dropActivation(ctx, started.childId)

    await expect(queuePrompt(ctx, parent, started.childId, message('hello')))
      .rejects.toThrow(SubagentError)
    expect(ctx.agents.get(started.childId)).toBe(child)
    hold.resolve(undefined)
  })

  it('rejects a parent that is no longer the live registry entry', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // A stale parent reference: same id, not the exact live entry.
    const stale = { ...parent, id: parent.id } as Agent

    await expect(queuePrompt(ctx, stale, started.childId, message('stale')))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    void child
  })

  it('rejects establishing a child under a parent whose disposal already began', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })

    // Begin the parent Activation's teardown, then try to give it a child.
    const drained = drainManager(ctx)
    await expect(ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' }))
      .rejects.toMatchObject({ code: 'DRAINING' })
    hold.resolve(undefined)
    await drained
  })

  it.each([1, 2])('disposes a local activation only after pending startup at depth %s rolls back', async (depth) => {
    const { ctx, parent } = await setup(Array.from({ length: depth }, () => 'hang' as const))
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'caller' })
    const child = ctx.agents.get(started.childId)!
    const entered = Promise.withResolvers<AbortSignal>()
    const releaseStartup = Promise.withResolvers<undefined>()
    const cleaning = Promise.withResolvers<undefined>()
    const releaseCleanup = Promise.withResolvers<undefined>()
    let starting: Promise<unknown> | undefined
    let disposal: Promise<void> | undefined
    try {
      let owner = child
      for (let level = 1; level < depth; level++) {
        const nested = await ctx.subagents.startActivation({ ...startSpec(owner), delivery: 'caller' })
        owner = ctx.agents.get(nested.childId)!
      }
      ctx.subagents.registerProvider({
        name: 'external', inheritsParentContext: false,
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        start: async ({ signal }) => {
          entered.resolve(signal)
          await releaseStartup.promise
          return {
            id: SessionId('pending-descendant'),
            result: Promise.resolve({ output: [], stopReason: 'completed' }),
            dispose: async () => { cleaning.resolve(undefined); await releaseCleanup.promise },
          }
        },
      })
      starting = ctx.subagents.startActivation({ ...startSpec(owner, 'external'), delivery: 'caller' })
        .catch((error: unknown) => error)
      const signal = await entered.promise
      disposal = started.dispose()
      const disposed = vi.fn()
      void disposal.then(disposed, disposed)
      expect(signal.aborted).toBe(true)
      await expect(ctx.subagents.startActivation({ ...startSpec(child), delivery: 'caller' }))
        .rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
      releaseStartup.resolve(undefined)
      await cleaning.promise
      expect(disposed).not.toHaveBeenCalled()
      expect(ctx.agents.get(child.id)).toBe(child)
      releaseCleanup.resolve(undefined)
      await disposal
      await expect(starting).resolves.toMatchObject({ name: 'AbortError' })
      expect(ctx.agents.get(child.id)).toBeUndefined()
      expect(ctx.agents.get(owner.id)).toBeUndefined()
      expect(ctx.agents.get(parent.id)).toBe(parent)
      await expect(ctx.subagents.waitForChildren(parent)).resolves.toBe(false)
    } finally {
      releaseStartup.resolve(undefined)
      releaseCleanup.resolve(undefined)
      await Promise.allSettled([starting, disposal, started.dispose()])
      await ctx.fiber.dispose()
    }
  })

  it('reports a failing branch after every branch settles, without pinning the rest', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })
    await vi.waitFor(() => { expect(ctx.agents.get(grandchild.childId)).toBeDefined() })
    // Make the grandchild's own handle disposal reject: scope teardown failure
    // propagates, unlike a contained `agent/disposed` listener throw.
    const branch = managerState(ctx).resident.get(grandchild.childId)!
    const handle = requireLocalActivation(branch).handle
    const realDispose = handle.dispose.bind(handle)
    handle.dispose = async () => {
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
    const outer = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(outer.childId)
      expect(found).toBeDefined()
      return found!
    })
    // The would-be parent's disposal is already open at the entry hold, so the
    // establishment rejects before any grandchild resource exists.
    const before = new Set(ctx.agents.list().map(agent => agent.id))
    const disposal = outer.dispose()

    try {
      await expect(ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' }))
        .rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
      await vi.waitFor(() => {
        expect(ctx.agents.list().map(agent => agent.id).filter(id => !before.has(id))).toEqual([])
      })
    } finally {
      hold.resolve(undefined)
      await disposal
    }
  })

  it.each(['agent/created', 'subagent/start'] as const)('rejects child admission when parent disposal begins at %s', async (event) => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent child'), gate: hold.promise },
      { chunks: textResponse('unused') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const outer = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(outer.childId)
      expect(found).toBeDefined()
      return found!
    })
    const before = new Set(ctx.agents.list().map(agent => agent.id))
    let disposal: Promise<void> | undefined
    const detach = ctx.on(event, () => { disposal = outer.dispose() })

    try {
      await expect(ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' }))
        .rejects.toMatchObject(event === 'agent/created' ? { name: 'AbortError' } : { code: 'ACTIVATION_CLOSING' })
      await vi.waitFor(() => {
        expect(ctx.agents.list().map(agent => agent.id).filter(id => !before.has(id))).toEqual([])
      })
    } finally {
      detach()
      hold.resolve(undefined)
      await disposal
    }
  })

  it('releases the parent hold when a cold delivery fails, so the parent can settle', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done'), gate: release.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
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
    const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-continuation-'))
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
    cleanups.push(async () => {
      await persistenceFiber.dispose()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    const serviceFiber = await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    // Manager unload uses the same drain, so no child outlives its runtime.
    const disposal = serviceFiber.dispose()
    hold.resolve(undefined)
    await disposal
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })
})

describe('SubagentRuntime.interrupt', () => {
  it('aborts the current turn durably, parks accepted follow-ups, and settles after direct Agent followup', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
      { chunks: textResponse('third') },
      { chunks: textResponse('fourth') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    await passSettlementCheck(ctx, started.childId)
    // Parked, not resumed: no second model request follows the abort, the
    // accepted follow-ups stay pending, and the same Activation stays resident.
    expect(adapter.requests).toHaveLength(1)
    expect(child.inbox.nextTurn).toHaveLength(2)
    expect(child.status).toBe('idle')
    expect(ctx.agents.get(started.childId)).toBe(child)

    // A host can wake a resident child through Agent directly; the parked items
    // still run before the new message in the existing FIFO order.
    child.followup(createUserMessage({ content: message('waking D'), source: { kind: 'user' } }))
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
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
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startActivation({ ...startSpec(child), delivery: 'parent' })
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
    const targetStart = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const target = ctx.agents.get(targetStart.childId)!
    const siblingStart = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const sibling = ctx.agents.get(siblingStart.childId)!
    const stranger = await ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })
    const stale = { ...parent, id: parent.id } as Agent
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

  it('accepts absent ids and interrupts caller-awaited local activations', async () => {
    const release = Promise.withResolvers<undefined>()
    const { ctx, parent } = await setupWith(new GatedAdapter([
      { chunks: textResponse('unfinished'), gate: release.promise },
    ]))
    ctx.subagents.interrupt(SessionId('missing'), { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(SessionId('missing'), { kind: 'ancestor', agent: parent })

    try {
      const run = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'caller' })
      const child = ctx.agents.get(run.childId)!
      const cancelSpy = vi.spyOn(child, 'cancel')
      ctx.subagents.interrupt(run.childId, { kind: 'user', parentSessionId: parent.id })
      ctx.subagents.interrupt(run.childId, { kind: 'ancestor', agent: parent })
      expect(cancelSpy).toHaveBeenNthCalledWith(1, { kind: 'user' }, { keepInbox: true })
      expect(cancelSpy).toHaveBeenNthCalledWith(2, { kind: 'parent' }, { keepInbox: true })
      release.resolve(undefined)
      expect((await run.result).stopReason).toBe('aborted')
      await run.dispose()
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('accepts an interrupt after natural completion', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)
    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
  })

  it('accepts an interrupt that lost the race with disposal without signalling twice', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const cancelSpy = vi.spyOn(child, 'cancel')

    // Scoped teardown opens the disposal transaction synchronously and issues
    // its own whole-Activation cancel before this call returns.
    const drained = ctx.subagents.drainDescendants([parent])
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    // Interrupt after the cutoff: accepted no-op, no second signal, no waiting.
    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    hold.resolve(undefined)
    await drained
  })
})
