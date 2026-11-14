import { listChildren } from '../src/list-children.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { loadStoredSession } from './persistence-helpers.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { bindSubagentActivation, managerState, subagentManager } from './manager-internals.ts'
import { requireLocalActivation } from '../src/activation.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

/** A model reply, or a turn that stays open until its Agent is cancelled. */
type Reply = StreamChunk[] | 'hang'

/** Routes each request to the reply queue of the task marker found in its history. */
class RoutedAdapter extends MockAdapter {
  readonly routed: GenerateOptions[] = []

  constructor(private readonly replies: Map<string, Reply[]>) {
    super([])
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.routed.push(options)
    const text = JSON.stringify(options.messages)
    const marker = [...this.replies.keys()].find(key => text.includes(`TASK:${key}`))
    const reply = marker === undefined ? undefined : this.replies.get(marker)?.shift()
    if (reply === undefined) throw new Error(`RoutedAdapter: no reply for ${marker ?? 'unknown agent'}`)
    if (reply !== 'hang') {
      yield* reply
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'working' }
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error('aborted')); return }
      options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }
}

const roots: string[] = []
const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Boot persistence, the Agent loop, one spawn provider, and the routed model. */
async function setup(replies: Record<string, Reply[]>, maxActiveSubagents = 16) {
  const ctx = new Context()
  disposers.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-siblings-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const adapter = new RoutedAdapter(new Map(Object.entries(replies)))
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(brandString<SessionId>('parent'), { provider: 'mock', model: 'mock' })
  ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject' } : next())
  return { ctx, parent, adapter }
}

const signal = new AbortController().signal

/** Start one caller-delivery child whose history carries `TASK:<marker>`. */
async function start(ctx: Context, parent: Agent, marker: string, description = 'shared responsibility'): Promise<SessionId> {
  const started = await ctx.subagents.startActivation({
    provider: 'spawn',
    label: description,
    prompt: [{ type: 'text', text: `TASK:${marker}` }], parent,
    signal,
    delivery: 'caller',
  })
  return started.childId
}

/** Start one caller-delivery child under a requested or default name and return its receipt. */
function startNamed(ctx: Context, parent: Agent, marker: string, name?: string, startSignal = signal) {
  return ctx.subagents.startActivation({
    provider: 'spawn',
    label: `task ${marker}`,
    ...name === undefined ? {} : { name },
    prompt: [{ type: 'text', text: `TASK:${marker}` }], parent,
    signal: startSignal,
    delivery: 'caller',
  })
}

/** Wait until a child's first model request is open. */
async function running(ctx: Context, id: SessionId): Promise<Agent> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)?.status).toBe('running') })
  return ctx.agents.get(id)!
}

/** Wait until a child released its Activation. */
async function settled(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

/** Read a child's stored user messages after its Activation settles. */
async function storedUserMessages(ctx: Context, id: SessionId): Promise<SessionEvent<'user/message'>[]> {
  await settled(ctx, id)
  const stored = await loadStoredSession(ctx.sessionPersistence, id)
  return stored.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
}

/** Concatenate the text blocks of one message. */
function textOf(event: SessionEvent<'user/message'>): string {
  return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('subagent sibling messages', () => {
  it('keeps duplicate descriptions as display text and names siblings uniquely', async () => {
    const { ctx, parent } = await setup({ a: ['hang'], b: [textResponse('done'), textResponse('resumed')] })
    const a = await start(ctx, parent, 'a')
    const sender = await running(ctx, a)
    const b = await start(ctx, parent, 'b')
    await settled(ctx, b)
    expect(a).not.toBe(b)
    expect(await listChildren(ctx, parent.id)).toEqual([
      expect.objectContaining({ id: a, mode: 'continuable', label: 'shared responsibility', name: 'agent-1' }),
      expect.objectContaining({ id: b, mode: 'continuable', label: 'shared responsibility', name: 'agent-2' }),
    ])
    expect(parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog').map(event => event.data.version))
      .toEqual([3, 3])

    await ctx.subagents.sendMessage(sender, b, [{ type: 'text', text: 'hello' }], { signal })
    const delivered = (await storedUserMessages(ctx, b)).find(event => event.data.source.kind === 'agent-message')!
    expect(textOf(delivered)).toBe('Agent agent-1 sent a message: hello')
    expect(delivered.data.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: a })
    ctx.subagents.interrupt(a, { kind: 'ancestor', agent: parent })
    await settled(ctx, a)
  })

  it('keeps unrelated parents outside sibling delivery even when descriptions match', async () => {
    const { ctx, parent } = await setup({ a: ['hang'], b: [textResponse('done'), textResponse('reply')] })
    const other = await ctx.agentLoop.create(brandString<SessionId>('other-parent'), { provider: 'mock', model: 'mock' })
    const a = await start(ctx, parent, 'a')
    const sender = await running(ctx, a)
    const b = await start(ctx, other, 'b')
    await running(ctx, b)
    await expect(ctx.subagents.sendMessage(sender, b, [{ type: 'text', text: 'denied' }], { signal }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    ctx.subagents.interrupt(a, { kind: 'ancestor', agent: parent })
    ctx.subagents.interrupt(b, { kind: 'ancestor', agent: other })
    await Promise.all([settled(ctx, a), settled(ctx, b)])
  })
})


describe('tree-wide messages', () => {
  it('keeps ordinary forks independent and rejects stale callers or broken ancestry', async () => {
    const { ctx, parent } = await setup({})
    expect(ctx.subagents.rootOf(parent)).toBe(parent)
    expect(() => ctx.subagents.rootOf({ ...parent })).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))
    const source = ctx.sessions.create(brandString<SessionId>('fork-source'), { meta: { origin: 'subagent', parentSession: parent.id } })
    source.append('turn/start', { turn: 1 })
    source.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'spawn', label: 'source' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const fork = ctx.sessions.fork(source, undefined, brandString<SessionId>('ordinary-fork'))
    const caller = { ...parent, id: fork.id, session: fork }
    onTestFinished(ctx.agents.enter(caller))
    expect(ctx.subagents.rootOf(caller)).toBe(caller)
    for (const [id, parentSession] of [
      ['orphan', undefined], ['offline-parent', brandString<SessionId>('absent')], ['cycle', brandString<SessionId>('cycle')],
    ] as const) {
      const session = ctx.sessions.create(brandString<SessionId>(id), {
        meta: { origin: 'subagent', ...parentSession === undefined ? {} : { parentSession } },
      })
      const child = { ...parent, id: session.id, session }
      onTestFinished(ctx.agents.enter(child))
      expect(() => ctx.subagents.rootOf(child)).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))
    }
  })

  it('delivers across branches, to deeper descendants, and back to the Lead', async () => {
    const { ctx, parent } = await setup({ a: ['hang'], b: ['hang'], leaf: ['hang'] })
    const a = await start(ctx, parent, 'a')
    const sender = await running(ctx, a)
    const b = await start(ctx, parent, 'b')
    const branch = await running(ctx, b)
    const leafId = await start(ctx, branch, 'leaf')
    const leaf = await running(ctx, leafId)
    const received: Array<{ target: SessionId; sender: SessionId; text: string }> = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind === 'agent-message') received.push({
        target: agent.id, sender: message.source.senderSessionId,
        text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
      })
    })
    await ctx.subagents.sendMessage(sender, leafId, [{ type: 'text', text: 'cousin' }], { signal })
    await ctx.subagents.sendMessage(parent, leafId, [{ type: 'text', text: 'grandchild' }], { signal })
    await ctx.subagents.sendMessage(leaf, parent.id, [{ type: 'text', text: 'grandparent' }], { signal })
    expect(received).toEqual([
      { target: leafId, sender: a, text: 'Agent agent-1 sent a message: cousin' },
      { target: leafId, sender: parent.id, text: 'Agent lead sent a message: grandchild' },
      { target: parent.id, sender: leafId, text: 'Agent agent-2/agent-1 sent a message: grandparent' },
    ])
    expect(() => { ctx.subagents.interrupt(leafId, { kind: 'ancestor', agent: sender }) })
      .toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))
    await expect(ctx.subagents.sendMessage(sender, a, [], { signal })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('restores only the target within subagent tree capacity while its creator remains offline', async () => {
    const { ctx, parent, adapter } = await setup({
      a: ['hang'], branch: ['hang'], leaf: [textResponse('first'), textResponse('reply')],
    }, 2)
    const branchId = await start(ctx, parent, 'branch')
    const branch = await running(ctx, branchId)
    const leafId = await start(ctx, branch, 'leaf')
    await settled(ctx, leafId)
    ctx.subagents.interrupt(branchId, { kind: 'ancestor', agent: parent })
    await settled(ctx, branchId)
    const a = await start(ctx, parent, 'a')
    const sender = await running(ctx, a)
    const resumed: Array<{ id: SessionId; parent: SessionId | undefined }> = []
    ctx.on('agent/created', ({ agent }) => { resumed.push({ id: agent.id, parent: agent.session.header.parentSession }) })

    await ctx.subagents.sendMessage(sender, leafId, [{ type: 'text', text: 'cold cousin' }], { signal })

    const messages = await storedUserMessages(ctx, leafId)
    const delivered = messages.find(event => event.data.source.kind === 'agent-message')!
    expect(textOf(delivered)).toBe('Agent agent-2 sent a message: cold cousin')
    expect(delivered.data.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: a })
    await settled(ctx, branchId)
    expect(resumed).toEqual([{ id: leafId, parent: branchId }])
    expect(ctx.agents.get(branchId)).toBeUndefined()
    expect(adapter.routed.filter(request => request.sessionId === leafId)).toHaveLength(2)
    const branchMessages = await storedUserMessages(ctx, branchId)
    expect(branchMessages.some(event => textOf(event).includes('cold cousin'))).toBe(false)
  })

  it('rechecks the sender after asynchronous target discovery', async () => {
    const { ctx, parent } = await setup({ a: ['hang'], b: [textResponse('done'), textResponse('reply')] })
    const a = await start(ctx, parent, 'a')
    const sender = await running(ctx, a)
    const b = await start(ctx, parent, 'b')
    await settled(ctx, b)
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    let stale = false
    const get = ctx.agents.get.bind(ctx.agents)
    const registry = vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === a && stale ? undefined : get(id))
    const query = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const observation = await observe(...args)
      stale = true
      return observation
    })
    try {
      await expect(ctx.subagents.sendMessage(sender, b, [{ type: 'text', text: 'rejected' }], { signal }))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(ctx.agents.get(b)).toBeUndefined()
    } finally {
      registry.mockRestore()
      query.mockRestore()
    }
  })
  it('leaves the offline creator untouched when target history cannot be read', async () => {
    const { ctx, parent } = await setup({ branch: ['hang'], leaf: [textResponse('done')] })
    const branchId = await start(ctx, parent, 'branch')
    const branch = await running(ctx, branchId)
    const leafId = await start(ctx, branch, 'leaf')
    await settled(ctx, leafId)
    ctx.subagents.interrupt(branchId, { kind: 'ancestor', agent: parent })
    await settled(ctx, branchId)
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      if (args[0] === leafId) throw new Error('target storage unavailable')
      return observe(...args)
    })
    await expect(ctx.subagents.sendMessage(parent, leafId, [], { signal })).rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
    expect(ctx.agents.get(branchId)).toBeUndefined()
    expect(ctx.agents.get(leafId)).toBeUndefined()
  })

  it.each(['missing', 'cyclic'] as const)('rejects %s creation evidence before restoring a target', async (evidence) => {
    const { ctx, parent } = await setup({ branch: ['hang'], leaf: [textResponse('done')] })
    const branchId = await start(ctx, parent, 'branch')
    const branch = await running(ctx, branchId)
    const leafId = await start(ctx, branch, 'leaf')
    await settled(ctx, leafId)
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const query = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const result = await observe(...args)
      return args[0] !== branchId ? result : {
        ...result,
        ...evidence === 'cyclic'
          ? { header: { ...result.header, parentSession: leafId } }
          : { projections: { ...result.projections!, values: { ...result.projections!.values, subagentCatalog: [] } } },
      }
    })
    try {
      await expect(ctx.subagents.sendMessage(parent, leafId, [{ type: 'text', text: 'rejected' }], { signal }))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(ctx.agents.get(leafId)).toBeUndefined()
    } finally {
      query.mockRestore()
    }
  })

  it('rejects a replaced root after asynchronous target discovery', async () => {
    const { ctx, parent } = await setup({ a: ['hang'], b: [textResponse('done'), textResponse('reply')] })
    const a = await start(ctx, parent, 'a')
    const sender = await running(ctx, a)
    const b = await start(ctx, parent, 'b')
    await settled(ctx, b)
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    let replaced = false
    const replacement = new Proxy(parent, {})
    const get = ctx.agents.get.bind(ctx.agents)
    const registry = vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === parent.id && replaced ? replacement : get(id))
    const query = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const observation = await observe(...args)
      replaced = true
      return observation
    })
    try {
      await expect(ctx.subagents.sendMessage(sender, b, [{ type: 'text', text: 'rejected' }], { signal }))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(ctx.agents.get(b)).toBeUndefined()
    } finally {
      registry.mockRestore()
      query.mockRestore()
    }
  })

  it.each([false, true])('restores the target while its creator is still closing (cleanup failure=%s)', async (failCleanup) => {
    const { ctx, parent } = await setup({ branch: ['hang'], leaf: [textResponse('first'), textResponse('reply')] })
    const branchId = await start(ctx, parent, 'branch')
    const branch = await running(ctx, branchId)
    const leafId = await start(ctx, branch, 'leaf')
    await settled(ctx, leafId)
    const activation = managerState(ctx).resident.get(branchId)!
    const handle = requireLocalActivation(activation).handle
    const dispose = handle.dispose.bind(handle)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    handle.dispose = async () => {
      entered.resolve(undefined)
      await release.promise
      await dispose()
      if (failCleanup) throw new Error('cleanup report failed')
    }
    const drained = subagentManager(ctx)['dispose'](activation).catch((error: unknown) => error)
    let delivery: Promise<unknown> | undefined
    try {
      await entered.promise
      delivery = ctx.subagents.sendMessage(parent, leafId, [{ type: 'text', text: 'after close' }], { signal })
      await delivery
      expect(ctx.agents.get(branchId)).toBe(branch)
      release.resolve(undefined)
      const messages = await storedUserMessages(ctx, leafId)
      expect(messages.some(message => textOf(message) === 'Agent lead sent a message: after close')).toBe(true)
      await settled(ctx, branchId)
    } finally {
      release.resolve(undefined)
      await drained
      await delivery
    }
  })
})

describe('agent names', () => {
  it('records requested and default names and rejects duplicates and invalid names before startup', async () => {
    const { ctx, parent, adapter } = await setup({ a: ['hang'], b: ['hang'] })
    const reviewer = await startNamed(ctx, parent, 'a', 'reviewer')
    const unnamed = await startNamed(ctx, parent, 'b')
    expect([reviewer.name, unnamed.name]).toEqual(['reviewer', 'agent-1'])
    for (const name of ['reviewer', 'agent-1']) {
      await expect(startNamed(ctx, parent, 'c', name)).rejects.toMatchObject({ code: 'DUPLICATE_AGENT_NAME' })
    }
    for (const name of ['lead', 'Reviewer', '1st', 'a'.repeat(33), 'review/er', '']) {
      await expect(startNamed(ctx, parent, 'c', name)).rejects.toMatchObject({ code: 'INVALID_AGENT_NAME' })
    }
    expect(adapter.routed.some(request => JSON.stringify(request.messages).includes('TASK:c'))).toBe(false)
    expect((await listChildren(ctx, parent.id)).map(entry => 'name' in entry ? entry.name : undefined))
      .toEqual(['reviewer', 'agent-1'])
    for (const started of [reviewer, unnamed]) {
      ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
      await settled(ctx, started.childId)
    }
  })

  it('holds a requested name across concurrent startup and releases it when startup fails', async () => {
    const { ctx, parent } = await setup({ a: ['hang'], b: ['hang'], c: ['hang'] })
    const first = startNamed(ctx, parent, 'a', 'worker')
    const concurrent = startNamed(ctx, parent, 'c')
    await expect(startNamed(ctx, parent, 'b', 'worker')).rejects.toMatchObject({ code: 'DUPLICATE_AGENT_NAME' })
    const started = await first
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    await expect(startNamed(ctx, parent, 'b', 'helper', aborted.signal)).rejects.toThrow('cancelled')
    const retried = await startNamed(ctx, parent, 'b', 'helper')
    const sibling = await concurrent
    expect([started.name, sibling.name, retried.name]).toEqual(['worker', 'agent-1', 'helper'])
    for (const child of [started, retried, sibling]) {
      ctx.subagents.interrupt(child.childId, { kind: 'ancestor', agent: parent })
      await settled(ctx, child.childId)
    }
  })

  it('names nested members by path and resolves names without granting authority', async () => {
    const { ctx, parent } = await setup({ branch: ['hang'], leaf: ['hang'] })
    const branch = await startNamed(ctx, parent, 'branch', 'reviewer')
    const branchAgent = await running(ctx, branch.childId)
    const leaf = await startNamed(ctx, branchAgent, 'leaf', 'checker')
    const leafAgent = await running(ctx, leaf.childId)
    expect(leaf.name).toBe('reviewer/checker')
    expect(ctx.subagents.namesOf(parent)).toEqual({ self: 'lead' })
    expect(ctx.subagents.namesOf(branchAgent)).toEqual({ self: 'reviewer', parent: 'lead' })
    expect(ctx.subagents.namesOf(leafAgent)).toEqual({ self: 'reviewer/checker', parent: 'reviewer' })
    const resolve = (name: string) => ctx.subagents.resolveName(leafAgent, name, signal)
    expect(await Promise.all(['lead', 'reviewer', 'reviewer/checker', 'missing', 'Not a name', leaf.childId].map(resolve)))
      .toEqual([parent.id, branch.childId, leaf.childId, 'missing', 'Not a name', leaf.childId])
    // A slash-separated address is never a Session id, so an unmatched path fails instead of reaching member lookup.
    await expect(resolve('reviewer/missing')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    await expect(resolve('reviewer/checker/deeper')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    expect((await ctx.subagents.listDescendants(parent.id, signal)).map(entry => entry.path))
      .toEqual(['reviewer', 'reviewer/checker'])
    ctx.subagents.interrupt(branch.childId, { kind: 'ancestor', agent: parent })
    ctx.subagents.interrupt(leaf.childId, { kind: 'ancestor', agent: parent })
    await settled(ctx, branch.childId)
    await settled(ctx, leaf.childId)
  })

  it('restores a cold member\'s path from the catalogs along its creation chain', async () => {
    const { ctx, parent } = await setup({ branch: ['hang'], leaf: [textResponse('first'), 'hang'] })
    const branch = await startNamed(ctx, parent, 'branch', 'reviewer')
    const branchAgent = await running(ctx, branch.childId)
    const leaf = await startNamed(ctx, branchAgent, 'leaf', 'checker')
    await settled(ctx, leaf.childId)
    ctx.subagents.interrupt(branch.childId, { kind: 'ancestor', agent: parent })
    await settled(ctx, branch.childId)

    await ctx.subagents.sendMessage(parent, leaf.childId, [{ type: 'text', text: 'resume' }], { signal })
    const resumed = await running(ctx, leaf.childId)
    expect(ctx.subagents.namesOf(resumed)).toEqual({ self: 'reviewer/checker', parent: 'reviewer' })
    ctx.subagents.interrupt(leaf.childId, { kind: 'ancestor', agent: parent })
    await settled(ctx, leaf.childId)
  })

  it('addresses members below an unnamed historical creator by Session id', async () => {
    const { ctx, parent } = await setup({ legacy: ['hang'], leaf: ['hang'] })
    const legacy = await ctx.agentLoop.create(brandString<SessionId>('legacy-child'), { provider: 'mock', model: 'mock' })
    bindSubagentActivation(ctx, legacy, parent)
    expect(ctx.subagents.namesOf(legacy)).toEqual({ self: 'legacy-child', parent: 'lead' })
    const leaf = await startNamed(ctx, legacy, 'leaf', 'checker')
    const leafAgent = await running(ctx, leaf.childId)
    expect(leaf.name).toBe(leaf.childId)
    expect(ctx.subagents.namesOf(leafAgent)).toEqual({ self: leaf.childId, parent: 'legacy-child' })
    ctx.subagents.interrupt(leaf.childId, { kind: 'ancestor', agent: parent })
    await settled(ctx, leaf.childId)
  })
})
