import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createAssistantMessage, LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
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

const SESSION_ID = 'resident' as SessionId

afterEach(() => { vi.unstubAllGlobals() })

function sessionSnapshot(): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    queue: [],
    pendingSubmissions: [],
    running: false,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
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
    loadThrough: () => Promise.reject(new Error('unused fake Session operation')),
    command: () => Promise.reject(new Error('unused fake Session operation')),
  }
}

function fakeSessions(ctx: Context): { sessions: ISessions; binding: SessionBinding } {
  const scope = createScope(ctx, SESSION_ID)
  const binding: SessionBinding = {
    sessionId: SESSION_ID,
    session: fakeSession(),
    eventSource: new MutableSessionEventSource(),
    ctx: scope.ctx,
  }
  const list = createSnapshotStore<SessionListState>({
    ids: [],
    byId: {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  const sessions = {
    list,
    searchResultLimit: 50,
    create: () => Promise.reject(new Error('unused fake Sessions operation')),
    open: () => {},
    openSubagent: () => {},
    subagentAddress: () => undefined,
    setSubagentCatalogOpen: () => {},
    refreshSubagents: () => Promise.reject(new Error('unused fake Sessions operation')),
    clear: () => {},
    refresh: () => Promise.reject(new Error('unused fake Sessions operation')),
    search: () => Promise.reject(new Error('unused fake Sessions operation')),
    fork: () => Promise.reject(new Error('unused fake Sessions operation')),
    scope: id => id === SESSION_ID ? binding.ctx : undefined,
    scopeOf: candidate => candidate === binding.ctx ? SESSION_ID : undefined,
    sessionOf: candidate => candidate === binding.ctx ? binding.session : undefined,
    binding: id => id === SESSION_ID ? binding : undefined,
  } satisfies ISessions
  return { sessions, binding }
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
  events: ConversationEventRegistry
  views: ConversationViewRegistry
}> {
  const ctx = new Context()
  const { sessions, binding } = fakeSessions(ctx)
  const uiConversation = new UiConversation(ctx, sessions)
  return {
    ctx,
    uiConversation,
    binding,
    events: uiConversation.events,
    views: uiConversation.views,
  }
}

describe('Conversation registries', () => {
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
        attemptId: LlmAttemptId('frame-probe'),
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' },
      },
    })
    append({
      seq: SessionSeq(3),
      time: 3,
      type: 'assistant/live-chunk',
      data: {
        attemptId: LlmAttemptId('frame-probe'),
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
        attemptId: LlmAttemptId('frame-probe'),
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'c' },
      },
    })
    source.settleAssistant(LlmAttemptId('frame-probe'), {
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
    expect(views.entries()).toHaveLength(1)

    await feature.dispose()
    expect(events.entries()).toEqual([])
    expect(events.fallbackEntry()).toBeUndefined()
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
