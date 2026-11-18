import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, type LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  createScope, MutableSessionEventSource,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ISessions, SessionBinding, SessionEventLike, SessionFace, SessionListState, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import {
  ConversationEventRegistry, ConversationNodeAssembler, ConversationViewRegistry, UiConversation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationUpdateError } from '../src/client/conversation/assembler.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Node ids published by the incremental-failure recovery test view. */
    'recovery-probe': readonly string[]
  }
}

const SESSION_ID = 'resident' as SessionId

afterEach(() => { vi.unstubAllGlobals() })

function sessionSnapshot(): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    pendingSubmissions: [],
    running: false,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false, historyLoadStatus: 'idle', historyWasPartial: false,
    promptError: null,
    blank: true,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  }
}

function fakeSession(): SessionFace {
  const snapshot = createSnapshotStore(sessionSnapshot())
  return {
    sessionId: SESSION_ID,
    projections: { faceOf: () => createSnapshotStore<unknown>(undefined) },
    getSnapshot: () => snapshot.getSnapshot(),
    subscribe: listener => snapshot.subscribe(listener),
    beginSubmission: () => ({ requestId: 'test-req' as never, abandon: () => {} }),
    prompt: () => Promise.reject(new Error('unused fake Session operation')),
    readAttachment: () => Promise.reject(new Error('unused fake Session operation')),
    updateQueue: () => Promise.reject(new Error('unused fake Session operation')),
    cancel: () => Promise.reject(new Error('unused fake Session operation')),
    rename: () => Promise.reject(new Error('unused fake Session operation')),
    loadOlder: () => Promise.reject(new Error('unused fake Session operation')),
    consumeOlder: () => { throw new Error('unused fake Session operation') },
    loadThrough: () => Promise.reject(new Error('unused fake Session operation')),
    command: () => Promise.reject(new Error('unused fake Session operation')),
  }
}

function fakeSessions(ctx: Context): {
  sessions: ISessions
  binding: SessionBinding
  retained: SnapshotStore<boolean>
} {
  const scope = createScope(ctx, SESSION_ID)
  const retained = createSnapshotStore(true)
  const binding: SessionBinding = {
    sessionId: SESSION_ID,
    session: fakeSession(),
    eventSource: new MutableSessionEventSource(),
    ctx: scope.ctx,
  }
  const list = createSnapshotStore<SessionListState>({
    ids: [],
    byId: {},
    phase: 'ready',
    projectionsBySession: {},
  })
  const reference = {
    sessionId: SESSION_ID,
    binding,
    ready: Promise.resolve(binding),
    release: () => {},
    [Symbol.dispose]() {},
  }
  const sessions: ISessions = {
    list,
    searchResultLimit: 50,
    create: () => Promise.reject(new Error('unused fake Sessions operation')),
    retain: () => reference,
    using: async (_target, _options, operation) => await operation(reference),
    retainInfo: () => ({
      getSnapshot: () => ({
        referenceCount: 1, retainedBy: {}, ...(retained.getSnapshot() ? { retainedFacets: { conversation: 1 } } : {}),
      }),
      subscribe: listener => retained.subscribe(listener),
    }),
    subagentAddress: () => undefined,
    refreshProjections: () => Promise.reject(new Error('unused fake Sessions operation')),
    refresh: () => Promise.reject(new Error('unused fake Sessions operation')),
    search: () => Promise.reject(new Error('unused fake Sessions operation')),
    fork: () => Promise.reject(new Error('unused fake Sessions operation')),
    scope: id => id === SESSION_ID ? binding.ctx : undefined,
    scopeOf: candidate => candidate === binding.ctx ? SESSION_ID : undefined,
    sessionOf: candidate => candidate === binding.ctx ? binding.session : undefined,
    binding: id => id === SESSION_ID ? binding : undefined,
  }
  return { sessions, binding, retained }
}

function eventDefinition(kind: string): ConversationNodeDefinition<null> {
  return {
    kind,
    target: 'chat',
    match: () => null,
    start: () => null,
    update: context => context.state,
    buildViewNode: () => null,
  }
}

function viewDefinition(target: string): ConversationViewDefinition<ConversationViewNode, null> {
  return {
    target,
    create: () => ({
      empty: null,
      replace: () => null,
      apply: () => null,
    }),
  }
}

async function bootRegistries(): Promise<{
  ctx: Context
  uiConversation: UiConversation
  binding: SessionBinding
  retained: SnapshotStore<boolean>
  events: ConversationEventRegistry
  views: ConversationViewRegistry
}> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const { sessions, binding, retained } = fakeSessions(ctx)
  const uiConversation = new UiConversation(ctx, sessions)
  return {
    ctx,
    uiConversation,
    binding,
    retained,
    events: uiConversation.events,
    views: uiConversation.views,
  }
}

describe('Conversation registries', () => {
  it('publishes open turns without an active view and detaches when the Session scope ends', async () => {
    const { uiConversation, binding } = await bootRegistries()
    const conversation = uiConversation.binding(binding)
    const source = binding.eventSource as MutableSessionEventSource
    const openTurn = conversation.openTurn
    const published: (number | undefined)[] = []
    const listener = vi.fn(() => { published.push(openTurn.getSnapshot()) })
    const unsubscribe = openTurn.subscribe(listener)
    expect(openTurn.getSnapshot()).toBeUndefined()
    expect(conversation.snapshot.getSnapshot().activeTargets.size).toBe(0)
    source.append({ type: 'event', event: {
      type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 },
    } })
    expect(openTurn.getSnapshot()).toBe(1)
    source.append({ type: 'event', event: {
      type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 },
    } })
    expect(listener).toHaveBeenCalledOnce()
    source.append({ type: 'event', event: {
      type: 'turn/end', seq: SessionSeq(3), time: 3, data: { turn: 1, reason: { kind: 'completed' } },
    } })
    expect(openTurn.getSnapshot()).toBeUndefined()
    source.append({ type: 'event', event: {
      type: 'turn/start', seq: SessionSeq(4), time: 4, data: { turn: 2 },
    } })
    expect(openTurn.getSnapshot()).toBe(2)
    expect(published).toEqual([1, undefined, 2])
    expect(uiConversation.binding(binding).openTurn).toBe(openTurn)
    expect(conversation.snapshot.getSnapshot().activeTargets.size).toBe(0)
    unsubscribe()
    listener.mockClear()
    source.append({ type: 'event', event: {
      type: 'turn/end', seq: SessionSeq(5), time: 5, data: { turn: 2, reason: { kind: 'completed' } },
    } })
    expect(openTurn.getSnapshot()).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
    const unsubscribeAgain = openTurn.subscribe(listener)
    await binding.ctx.fiber.dispose()
    listener.mockClear()
    source.append({ type: 'event', event: {
      type: 'turn/start', seq: SessionSeq(6), time: 6, data: { turn: 3 },
    } })
    expect(listener).not.toHaveBeenCalled()
    expect(openTurn.getSnapshot()).toBeUndefined()
    unsubscribeAgain()
  })

  it('requires a loaded turn start and follows prepended history and replacement windows', async () => {
    const { uiConversation, binding } = await bootRegistries()
    const source = binding.eventSource as MutableSessionEventSource
    source.replace([{ type: 'event', event: {
      type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 7, step: 1 },
    } }], true)
    const openTurn = uiConversation.binding(binding).openTurn
    expect(openTurn.getSnapshot()).toBeUndefined()
    source.prepend([{ type: 'event', event: {
      type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 7 },
    } }], false)
    expect(openTurn.getSnapshot()).toBe(7)
    source.replace([{ type: 'event', event: {
      type: 'turn/end', seq: SessionSeq(3), time: 3, data: { turn: 7, reason: { kind: 'completed' } },
    } }], true)
    expect(openTurn.getSnapshot()).toBeUndefined()
    source.replace([{ type: 'event', event: {
      type: 'turn/start', seq: SessionSeq(4), time: 4, data: { turn: 8 },
    } }], false)
    expect(openTurn.getSnapshot()).toBe(8)
  })

  it('publishes the rebuilt window after an incremental update throws and keeps applying later events', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { errors.mockRestore() })
    const { uiConversation, binding, events, views } = await bootRegistries()
    const toggle: ConversationNodeDefinition<boolean> = {
      kind: 'toggle',
      target: 'recovery-probe',
      match: event => event.type === 'turn/start'
        ? { id: String(event.data.turn), role: 'start' }
        : event.type === 'turn/end' ? { id: String(event.data.turn), role: 'update' } : null,
      start: () => true,
      update: () => false,
      // Withdrawing a shown Node violates the incremental contract.
      buildViewNode: context => context.state === true
        ? { key: context.key, kind: 'toggle', id: context.id, target: 'recovery-probe', data: null }
        : null,
    }
    events.register(toggle)
    views.register({
      target: 'recovery-probe',
      create: () => {
        let keys: readonly string[] = []
        return {
          empty: keys,
          replace: ({ nodes }) => (keys = nodes.map(node => node.id)),
          apply: ({ upserts }) => (keys = [...new Set([...keys, ...upserts.map(node => node.id)])]),
        }
      },
    } satisfies ConversationViewDefinition<ConversationViewNode, readonly string[]>)
    await Promise.resolve()
    const conversation = uiConversation.binding(binding)
    conversation.activate('recovery-probe')
    const probe = conversation.target('recovery-probe')
    const published: (readonly string[] | undefined)[] = []
    const unsubscribe = conversation.snapshot.subscribe(() => { published.push(probe.getSnapshot()) })
    onTestFinished(unsubscribe)
    const source = binding.eventSource as MutableSessionEventSource

    source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } })
    source.append({ type: 'event', event: {
      type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } },
    } })
    expect(errors).toHaveBeenCalledOnce()
    const failure: unknown = errors.mock.calls[0]?.[1]
    expect(failure).toBeInstanceOf(ConversationUpdateError)
    expect((failure as ConversationUpdateError).rebuilt).toBe(true)
    expect(String((failure as ConversationUpdateError).cause)).toMatch(/withdrew materialized target "recovery-probe"/)

    source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(3), time: 3, data: { turn: 2 } } })
    expect(errors).toHaveBeenCalledOnce()
    expect(published).toEqual([['1'], [], ['2']])
  })

  it('reports both failures and publishes nothing when replacing the views after a failed update also fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { errors.mockRestore() })
    const { uiConversation, binding, events, views } = await bootRegistries()
    const broken: ConversationNodeDefinition<boolean> = {
      kind: 'broken',
      target: 'chat',
      match: event => event.type === 'turn/start'
        ? { id: String(event.data.turn), role: 'start' }
        : event.type === 'turn/end' ? { id: String(event.data.turn), role: 'update' } : null,
      start: () => true,
      update: () => false,
      buildViewNode: (context) => {
        if (context.state !== true) throw new Error('closed turn cannot render')
        return { key: context.key, kind: 'broken', id: context.id, target: 'chat', data: null }
      },
    }
    events.register(broken)
    views.register(viewDefinition('chat'))
    await Promise.resolve()
    const conversation = uiConversation.binding(binding)
    conversation.activate('chat')
    const listener = vi.fn()
    const unsubscribe = conversation.snapshot.subscribe(listener)
    onTestFinished(unsubscribe)
    const source = binding.eventSource as MutableSessionEventSource

    source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } })
    expect(listener).toHaveBeenCalledOnce()
    source.append({ type: 'event', event: {
      type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } },
    } })
    expect(errors).toHaveBeenCalledOnce()
    const failure: unknown = errors.mock.calls[0]?.[1]
    expect(failure).toBeInstanceOf(ConversationUpdateError)
    expect((failure as ConversationUpdateError).rebuilt).toBe(false)
    const cause = (failure as ConversationUpdateError).cause
    expect(cause).toBeInstanceOf(AggregateError)
    expect((cause as AggregateError).errors.map(error => (error as Error).message))
      .toEqual(['closed turn cannot render', 'closed turn cannot render'])
    expect(listener).toHaveBeenCalledOnce()
  })

  it('publishes frame-paced updates after three animation frames and lets immediate updates preempt them', async () => {
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrame++
      frames.set(nextFrame, callback)
      return nextFrame
    })
    const cancelFrame = vi.fn((frame: number) => { frames.delete(frame) })
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
    const { uiConversation, binding, events, views } = await bootRegistries()
    const definition: ConversationNodeDefinition<number> = {
      kind: 'frame-probe',
      target: 'chat',
      match: event => event.type === 'turn/start'
        ? { id: String(event.data.turn), role: 'start' }
        : event.type === 'assistant/live-chunk' || event.type === 'assistant/message'
          ? { id: String(event.data.turn), role: 'update' }
          : null,
      start: () => 0,
      update: context => context.state + 1,
      publication: match => match.event.type === 'assistant/live-chunk' ? 'animation-frame' : 'immediate',
      buildViewNode: context => ({
        key: context.key,
        kind: 'frame-probe',
        id: context.id,
        target: 'chat',
        data: context.state,
      }),
    }
    events.register(definition)
    views.register(viewDefinition('chat'))
    await Promise.resolve()
    const conversation = uiConversation.binding(binding)
    conversation.activate('chat')
    const listener = vi.fn()
    const unsubscribe = conversation.snapshot.subscribe(listener)
    const source = binding.eventSource as MutableSessionEventSource
    const append = (event: SessionEventLike): void => {
      source.append(event.type === 'assistant/live-chunk'
        ? { type: 'transient', event }
        : { type: 'event', event })
    }

    append({ seq: SessionSeq(1), time: 1, type: 'turn/start', data: { turn: 1 } })
    listener.mockClear()
    append({
      seq: SessionSeq(2),
      time: 2,
      type: 'assistant/live-chunk',
      data: {
        attemptId: brandString<LlmAttemptId>('frame-probe'),
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' },
      },
    })
    append({
      seq: SessionSeq(3),
      time: 3,
      type: 'assistant/live-chunk',
      data: {
        attemptId: brandString<LlmAttemptId>('frame-probe'),
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' },
      },
    })
    expect(requestFrame).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()

    const first = frames.get(1)
    if (first === undefined) throw new Error('first animation frame was not scheduled')
    frames.delete(1)
    first(0)
    expect(requestFrame).toHaveBeenCalledTimes(2)
    expect(listener).not.toHaveBeenCalled()

    const second = frames.get(2)
    if (second === undefined) throw new Error('second animation frame was not scheduled')
    frames.delete(2)
    second(16)
    expect(requestFrame).toHaveBeenCalledTimes(3)
    expect(listener).not.toHaveBeenCalled()

    const third = frames.get(3)
    if (third === undefined) throw new Error('third animation frame was not scheduled')
    frames.delete(3)
    third(32)
    expect(listener).toHaveBeenCalledOnce()

    append({
      seq: SessionSeq(4),
      time: 4,
      type: 'assistant/live-chunk',
      data: {
        attemptId: brandString<LlmAttemptId>('frame-probe'),
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'c' },
      },
    })
    source.settleAssistant(brandString<LlmAttemptId>('frame-probe'), {
      type: 'event',
      event: {
        seq: SessionSeq(5),
        time: 5,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [],
            source: { provider: 'test', model: 'test' },
          }),
          stream: [],
        },
        surfaceOp: 'append',
      },
    })
    expect(cancelFrame).toHaveBeenCalledWith(4)
    expect(frames).toHaveLength(0)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    await binding.ctx.fiber.dispose()
  })

  it('drops the fold when the conversation facet is released and folds the received window once on resume', async () => {
    const { uiConversation, binding, retained, events, views } = await bootRegistries()
    const match = vi.fn((event: SessionEventLike) => event.type === 'turn/start'
      ? { id: String(event.data.turn), role: 'start' as const }
      : event.type === 'turn/end' ? { id: String(event.data.turn), role: 'update' as const } : null)
    events.register({
      kind: 'turn-probe',
      target: 'chat',
      match,
      start: () => 'open',
      update: () => 'closed',
      buildViewNode: context => ({ key: context.key, kind: 'turn-probe', id: context.id, target: 'chat', data: context.state }),
    })
    const built: unknown[] = []
    const chatView: ConversationViewDefinition<ConversationViewNode, unknown[]> = {
      target: 'chat',
      create: () => ({
        empty: [],
        replace: ({ nodes }) => {
          const data = nodes.map(node => node.data)
          built.push(data)
          return data
        },
        apply: ({ upserts }) => upserts.map(node => node.data),
      }),
    }
    views.register(chatView)
    await Promise.resolve()
    const conversation = uiConversation.binding(binding)
    conversation.activate('chat')
    const source = binding.eventSource as MutableSessionEventSource
    source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } })
    const listener = vi.fn()
    const unsubscribe = conversation.snapshot.subscribe(listener)
    retained.set(false)
    // Releasing the facet drops the fold and publishes the empty result once.
    expect(listener).toHaveBeenCalledOnce()
    expect(conversation.openTurn.getSnapshot()).toBeUndefined()
    const released = conversation.snapshot.getSnapshot()
    listener.mockClear()
    match.mockClear()
    source.append({ type: 'event', event: {
      type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } },
    } })
    source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(3), time: 3, data: { turn: 2 } } })
    expect(match).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(conversation.snapshot.getSnapshot()).toBe(released)
    built.length = 0
    retained.set(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(built).toEqual([['closed', 'open']])
    expect(conversation.openTurn.getSnapshot()).toBe(2)
    source.append({ type: 'event', event: {
      type: 'turn/end', seq: SessionSeq(4), time: 4, data: { turn: 2, reason: { kind: 'completed' } },
    } })
    expect(conversation.openTurn.getSnapshot()).toBeUndefined()
    unsubscribe()
  })

  it('applies activations and registry changes made while not following once retention resumes', async () => {
    const { uiConversation, binding, retained, events, views } = await bootRegistries()
    retained.set(false)
    const source = binding.eventSource as MutableSessionEventSource
    source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } })
    const conversation = uiConversation.binding(binding)
    conversation.activate('chat')
    events.register(eventDefinition('message'))
    views.register(viewDefinition('chat'))
    await Promise.resolve()
    expect(conversation.snapshot.getSnapshot().activeTargets.size).toBe(0)
    expect(conversation.openTurn.getSnapshot()).toBeUndefined()
    retained.set(true)
    expect(conversation.openTurn.getSnapshot()).toBe(1)
    expect(conversation.snapshot.getSnapshot().views.get('chat')).toBeNull()
  })

  it('cancels a frame-paced update on release and publishes synchronously when retention resumes', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame) })
    const { uiConversation, binding, retained, events, views } = await bootRegistries()
    const chunkProbe: ConversationNodeDefinition<number> = {
      kind: 'chunk-probe',
      target: 'chat',
      match: event => event.type === 'assistant/live-chunk' ? { id: 'chunk', role: 'start' } : null,
      start: () => 1,
      update: context => context.state + 1,
      publication: () => 'animation-frame',
      buildViewNode: context => ({ key: context.key, kind: 'chunk-probe', id: context.id, target: 'chat', data: context.state }),
    }
    events.register(chunkProbe)
    views.register(viewDefinition('chat'))
    await Promise.resolve()
    const conversation = uiConversation.binding(binding)
    conversation.activate('chat')
    const listener = vi.fn()
    const unsubscribe = conversation.snapshot.subscribe(listener)
    ;(binding.eventSource as MutableSessionEventSource).append({ type: 'transient', event: {
      seq: SessionSeq(1), time: 1, type: 'assistant/live-chunk',
      data: { attemptId: brandString<LlmAttemptId>('chunk'), turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } },
    } })
    expect(frames.size).toBe(1)
    retained.set(false)
    expect(frames.size).toBe(0)
    listener.mockClear()
    retained.set(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
    unsubscribe()
  })

  it('leaves no subscription behind when the initial fold fails and folds afresh on the next resolution', async () => {
    const { uiConversation, binding, events, views } = await bootRegistries()
    let failing = true
    const match = vi.fn((event: SessionEventLike) => {
      if (failing) throw new Error('definition failed')
      return event.type === 'turn/start' ? { id: String(event.data.turn), role: 'start' as const } : null
    })
    events.register({
      kind: 'failing-probe', target: 'chat', match, start: () => null, update: context => context.state,
      buildViewNode: context => ({ key: context.key, kind: 'failing-probe', id: context.id, target: 'chat', data: null }),
    })
    views.register(viewDefinition('chat'))
    await Promise.resolve()
    const source = binding.eventSource as MutableSessionEventSource
    source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } })
    expect(() => uiConversation.binding(binding)).toThrow('definition failed')
    match.mockClear()
    source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(2), time: 2, data: { turn: 2 } } })
    expect(match).not.toHaveBeenCalled()
    failing = false
    const conversation = uiConversation.binding(binding)
    expect(match).toHaveBeenCalledTimes(2)
    expect(conversation.openTurn.getSnapshot()).toBe(2)
  })

  it('ignores a window change dispatched after an earlier listener released the facet', async () => {
    const { uiConversation, binding, retained, events, views } = await bootRegistries()
    const match = vi.fn(() => null)
    events.register(eventDefinition('message'))
    events.register({ ...eventDefinition('probe'), match })
    views.register(viewDefinition('chat'))
    await Promise.resolve()
    const source = binding.eventSource as MutableSessionEventSource
    const stopReleaser = source.subscribe(() => { retained.set(false) })
    const conversation = uiConversation.binding(binding)
    const listener = vi.fn()
    conversation.snapshot.subscribe(listener)
    match.mockClear()
    source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } })
    expect(match).not.toHaveBeenCalled()
    expect(conversation.openTurn.getSnapshot()).toBeUndefined()
    stopReleaser()
  })

  it('publishes one live chunk received while not following synchronously on resume', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame) })
    const { uiConversation, binding, retained, events, views } = await bootRegistries()
    const chunkProbe: ConversationNodeDefinition<number> = {
      kind: 'chunk-probe',
      target: 'chat',
      match: event => event.type === 'assistant/live-chunk' ? { id: 'chunk', role: 'start' } : null,
      start: () => 1,
      update: context => context.state + 1,
      publication: () => 'animation-frame',
      buildViewNode: context => ({ key: context.key, kind: 'chunk-probe', id: context.id, target: 'chat', data: context.state }),
    }
    events.register(chunkProbe)
    views.register(viewDefinition('chat'))
    await Promise.resolve()
    const conversation = uiConversation.binding(binding)
    conversation.activate('chat')
    retained.set(false)
    const listener = vi.fn()
    conversation.snapshot.subscribe(listener)
    ;(binding.eventSource as MutableSessionEventSource).append({ type: 'transient', event: {
      seq: SessionSeq(1), time: 1, type: 'assistant/live-chunk',
      data: { attemptId: brandString<LlmAttemptId>('chunk'), turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } },
    } })
    retained.set(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
  })

  it('folds the window once when a registry rebuild and a window gap wait for resumption', async () => {
    const { uiConversation, binding, retained, events, views } = await bootRegistries()
    const match = vi.fn(() => null)
    events.register({ ...eventDefinition('probe'), match })
    views.register(viewDefinition('chat'))
    await Promise.resolve()
    const conversation = uiConversation.binding(binding)
    const source = binding.eventSource as MutableSessionEventSource
    retained.set(false)
    for (let seq = 1; seq <= 3; seq++) {
      source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn: seq } } })
    }
    events.register(eventDefinition('late'))
    await Promise.resolve()
    match.mockClear()
    const listener = vi.fn()
    conversation.snapshot.subscribe(listener)
    retained.set(true)
    expect(match).toHaveBeenCalledTimes(3)
    expect(conversation.openTurn.getSnapshot()).toBe(3)
  })

  it('keeps following and keeps its activations after the resuming fold fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { errors.mockRestore() })
    const { uiConversation, binding, retained, events, views } = await bootRegistries()
    let failing = false
    events.register({ ...eventDefinition('probe'), match: () => {
      if (failing) throw new Error('resume failed')
      return null
    } })
    views.register(viewDefinition('chat'))
    await Promise.resolve()
    const conversation = uiConversation.binding(binding)
    retained.set(false)
    conversation.activate('chat')
    failing = true
    ;(binding.eventSource as MutableSessionEventSource).replace([{ type: 'event', event: {
      type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 },
    } }], false)
    retained.set(true)
    expect(errors).toHaveBeenCalled()
    failing = false
    ;(binding.eventSource as MutableSessionEventSource).append({ type: 'event', event: {
      type: 'turn/start', seq: SessionSeq(2), time: 2, data: { turn: 2 },
    } })
    expect(conversation.snapshot.getSnapshot().views.get('chat')).toBeNull()
    expect(conversation.openTurn.getSnapshot()).toBe(2)
  })

  it('rebuilds the whole window on the next change after a resuming fold fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { errors.mockRestore() })
    const { uiConversation, binding, retained, events, views } = await bootRegistries()
    let failTurn: number | undefined
    events.register({
      kind: 'turn-probe',
      target: 'recovery-probe',
      match: (event) => {
        if (event.type !== 'turn/start') return null
        if (event.data.turn === failTurn) {
          failTurn = undefined
          throw new Error('one-time failure')
        }
        return { id: String(event.data.turn), role: 'start' }
      },
      start: () => null,
      update: context => context.state,
      buildViewNode: context => ({ key: context.key, kind: 'turn-probe', id: context.id, target: 'recovery-probe', data: null }),
    })
    const idsView: ConversationViewDefinition<ConversationViewNode, readonly string[]> = {
      target: 'recovery-probe',
      create: () => {
        let ids: readonly string[] = []
        return {
          empty: [],
          replace: ({ nodes }) => (ids = nodes.map(node => node.id)),
          apply: ({ upserts }) => (ids = [...ids, ...upserts.map(node => node.id).filter(id => !ids.includes(id))]),
        }
      },
    }
    views.register(idsView)
    await Promise.resolve()
    const conversation = uiConversation.binding(binding)
    conversation.activate('recovery-probe')
    const source = binding.eventSource as MutableSessionEventSource
    const start = (turn: number): void => {
      source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(turn), time: turn, data: { turn } } })
    }
    start(1)
    retained.set(false)
    start(2)
    start(3)
    failTurn = 2
    retained.set(true)
    expect(errors).toHaveBeenCalled()
    start(4)
    expect(conversation.snapshot.getSnapshot().views.get('recovery-probe')).toEqual(['1', '2', '3', '4'])
  })

  it('reaches the same views on resume as when following every event', async () => {
    const turnProbe: ConversationNodeDefinition<string> = {
      kind: 'turn-probe',
      target: 'recovery-probe',
      match: event => event.type === 'turn/start'
        ? { id: String(event.data.turn), role: 'start' }
        : event.type === 'turn/end' ? { id: String(event.data.turn), role: 'update' } : null,
      start: () => 'open',
      update: () => 'closed',
      buildViewNode: context => ({ key: context.key, kind: 'turn-probe', id: `${context.id}:${context.state}`, target: 'recovery-probe', data: null }),
    }
    const idsView: ConversationViewDefinition<ConversationViewNode, readonly string[]> = {
      target: 'recovery-probe',
      create: () => {
        let ids: string[] = []
        return {
          empty: [],
          replace: ({ nodes }) => (ids = nodes.map(node => node.id)),
          apply: ({ upserts }) => {
            for (const node of upserts) {
              const key = node.id.split(':')[0]
              ids = [...ids.filter(id => id.split(':')[0] !== key), node.id]
            }
            return ids
          },
        }
      },
    }
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: SessionSeq(3), time: 3, data: { turn: 2 } },
    ]
    const run = async (followAll: boolean): Promise<unknown> => {
      const b = await bootRegistries()
      b.events.register(turnProbe)
      b.views.register(idsView)
      await Promise.resolve()
      const conversation = b.uiConversation.binding(b.binding)
      conversation.activate('recovery-probe')
      if (!followAll) b.retained.set(false)
      for (const event of events) (b.binding.eventSource as MutableSessionEventSource).append({ type: 'event', event })
      b.retained.set(true)
      return conversation.snapshot.getSnapshot().views.get('recovery-probe')
    }
    expect(await run(false)).toEqual(await run(true))
  })

  it('rejects duplicate Event Definitions and disposes an ordinary registration once', async () => {
    const { events } = await bootRegistries()
    const definition = eventDefinition('message')
    const dispose = events.register(definition)

    expect(events.entries()).toEqual([definition])
    expect(() => events.register(eventDefinition('message'))).toThrow(/already registered/)

    dispose()
    dispose()
    expect(events.entries()).toEqual([])
  })

  it('rejects a duplicate fallback and clears it through its idempotent disposer', async () => {
    const { events } = await bootRegistries()
    const fallback = eventDefinition('unknown')
    const dispose = events.registerFallback(fallback)

    expect(events.fallbackEntry()).toBe(fallback)
    expect(() => events.registerFallback(eventDefinition('other'))).toThrow(/already registered/)

    dispose()
    dispose()
    expect(events.fallbackEntry()).toBeUndefined()
  })

  it('rejects rendering Definitions that omit either target or builder', async () => {
    const { events } = await bootRegistries()
    const targetOnly: ConversationNodeDefinition<null> = {
      kind: 'target-only',
      target: 'chat',
      match: () => null,
      start: () => null,
      update: context => context.state,
    }
    const builderOnly: ConversationNodeDefinition<null> = {
      kind: 'builder-only',
      match: () => null,
      start: () => null,
      update: context => context.state,
      buildViewNode: () => null,
    }

    expect(() => events.register(targetOnly)).toThrow(/target and buildViewNode together/)
    expect(() => events.register(builderOnly)).toThrow(/target and buildViewNode together/)
  })

  it('rejects a State-only Definition as the unmatched-event fallback', async () => {
    const { events } = await bootRegistries()
    const fallback: ConversationNodeDefinition<null> = {
      kind: 'state-only-fallback',
      match: () => null,
      start: () => null,
      update: context => context.state,
    }

    expect(() => events.registerFallback(fallback))
      .toThrow('conversation fallback Definition must declare a target')
  })

  it('rejects duplicate view targets and disposes a view registration once', async () => {
    const { views } = await bootRegistries()
    const definition = viewDefinition('chat')
    const dispose = views.register(definition)

    expect(views.entries()).toEqual([definition])
    expect(() => views.register(viewDefinition('chat'))).toThrow(/already registered/)

    dispose()
    dispose()
    expect(views.entries()).toEqual([])
  })

  it('removes Event, fallback, and view contributions with their caller fiber', async () => {
    const { ctx, events, views } = await bootRegistries()
    const feature = ctx.inject(['uiConversation'], (featureCtx) => {
      featureCtx.uiConversation.events.register(eventDefinition('message'))
      featureCtx.uiConversation.events.registerFallback(eventDefinition('unknown'))
      featureCtx.uiConversation.views.register(viewDefinition('chat'))
    })
    await feature.await()

    expect(events.entries()).toHaveLength(1)
    expect(events.fallbackEntry()).toBeDefined()
    expect(events.forEvent('turn/start').size).toBe(1)
    expect(views.entries()).toHaveLength(1)

    await feature.dispose()
    expect(events.entries()).toEqual([])
    expect(events.fallbackEntry()).toBeUndefined()
    expect(events.forEvent('turn/start').size).toBe(0)
    expect(views.entries()).toEqual([])
  })

  it('coalesces one turn of registry changes into one rebuild per resident Conversation', async () => {
    const { uiConversation, binding, events, views } = await bootRegistries()
    uiConversation.binding(binding)
    const rebuild = vi.spyOn(ConversationNodeAssembler.prototype, 'rebuildRegistry')

    events.register(eventDefinition('message'))
    views.register(viewDefinition('chat'))
    events.register(eventDefinition('tool'))
    expect(rebuild).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(rebuild).toHaveBeenCalledOnce()

    views.register(viewDefinition('trajectory'))
    await Promise.resolve()
    expect(rebuild).toHaveBeenCalledTimes(2)
    rebuild.mockRestore()
  })

  it('activates each target on explicit selection or first use and never deactivates it', async () => {
    const { uiConversation, binding, views } = await bootRegistries()
    const chat = viewDefinition('chat')
    const trajectory = viewDefinition('trajectory')
    const createChat = vi.spyOn(chat, 'create')
    const createTrajectory = vi.spyOn(trajectory, 'create')
    views.register(chat)
    const disposeTrajectory = views.register(trajectory)
    await Promise.resolve()

    const conversation = uiConversation.binding(binding)
    const chatSource = conversation.target('chat')
    const trajectorySource = conversation.target('trajectory')
    expect(createChat).not.toHaveBeenCalled()
    expect(createTrajectory).not.toHaveBeenCalled()

    conversation.activate('chat')
    expect(createChat).toHaveBeenCalledOnce()

    const unsubscribeChat = chatSource.subscribe(vi.fn())
    const trajectoryListener = vi.fn()
    const unsubscribeTrajectory = trajectorySource.subscribe(trajectoryListener)
    unsubscribeChat()
    const unsubscribeTrajectoryAgain = trajectorySource.subscribe(vi.fn())
    unsubscribeTrajectoryAgain()
    expect(createChat).toHaveBeenCalledOnce()
    expect(createTrajectory).toHaveBeenCalledOnce()
    expect(trajectoryListener).toHaveBeenCalledOnce()

    disposeTrajectory()
    await Promise.resolve()
    expect(trajectorySource.getSnapshot()).toBeUndefined()
    expect(trajectoryListener).toHaveBeenCalledTimes(2)
    unsubscribeTrajectory()
  })
})
