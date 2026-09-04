/** Raw Session journal transport and message-aligned pagination coverage. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import { LlmAttemptId, ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionHistoryController } from '@deepseek-ai/dsh-api-session-controller/src/history.ts'
import type { SessionFollowFrame, SessionPage, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSessionTestRemote, installSessionReadTestServices } from './test-remote.ts'

/** Append a production-shaped human prompt to the session surface. */
function appendUserText(session: Session, text: string): SessionEvent {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Append a production-shaped assistant message to the session surface. */
function appendAssistantText(session: Session, text: string, step: number): SessionEvent {
  return session.append('assistant/message', {
    turn: 1,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
    stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [text] }],
  }, { surfaceOp: 'append' })
}

/**
 * Append a plugin-owned log-only event. The host proxy is projection-only, so it
 * declares no compaction vocabulary; the cast writes the real event shape without
 * depending on the owning package.
 */
function appendExtension(session: Session, type: string, data: unknown): SessionEvent {
  return (session.append as unknown as (type: string, data: unknown) => SessionEvent)(type, data)
}

async function harness(): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  return { ctx }
}

/** Drain one Session follow until `count` event frames arrive. */
async function collect(
  iterable: AsyncIterable<SessionFollowFrame>,
  count: number,
  abort: AbortController,
): Promise<SessionFollowFrame[]> {
  const frames: SessionFollowFrame[] = []
  for await (const frame of iterable) {
    frames.push(frame)
    if (frames.filter(candidate => candidate.type === 'event').length >= count) abort.abort()
  }
  return frames
}

/** Open follow and wait until its cursor is fixed before appending fixtures. */
async function openFollow(
  history: SessionHistoryController,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<AsyncIterable<SessionFollowFrame>> {
  const iterator = history.follow({
    address: { kind: 'session', sessionId },
  }, signal)[Symbol.asyncIterator]()
  await expect(iterator.next()).resolves.toMatchObject({
    done: false,
    value: { type: 'snapshot' },
  })
  return { [Symbol.asyncIterator]: () => iterator }
}

/** Abort one follow and await both its iterator and owning Context teardown. */
async function disposeFollow(
  ctx: Context,
  iterator: AsyncIterator<SessionFollowFrame>,
  abort: AbortController,
): Promise<void> {
  abort.abort()
  await iterator.return?.()
  await ctx.fiber.dispose()
}

/** Read scalar v2 page records for assertions over the logical journal. */
function pageEvents(page: SessionPage): SessionWireEvent[] {
  return page.records.map(record => record.event)
}

describe('Session history raw journal', () => {
  it('opens an empty opted-in Assistant baseline before any live attempt exists', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', assistantStream: { revision: 0 } },
    })
    abort.abort()
    await iterator.next()
    await ctx.fiber.dispose()
  })

  it('filters foreign and opening-baseline frames buffered during the source observation', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const originalObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return originalObserve(...args)
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()
    const opening = iterator.next()
    await entered.promise

    const attemptId = LlmAttemptId('buffered-opening-attempt')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'start', attemptId, revision: 1, turn: 1, step: 1 },
    })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId, revision: 2, index: 0,
        time: 2, chunk: { type: 'text-delta', index: 0, text: 'buffered' },
      },
    })
    const foreign = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    ctx.emit('agent/assistant-stream', {
      agent: { id: foreign.id, session: foreign, status: 'running', ctx } as Agent,
      frame: {
        type: 'start', attemptId: LlmAttemptId('foreign-attempt'), revision: 1, turn: 1, step: 1,
      },
    })
    release.resolve(undefined)
    await expect(opening).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', assistantStream: { revision: 2 } },
    })

    const next = iterator.next()
    const durable = session.append('turn/start', { turn: 1 })
    await expect(next).resolves.toEqual({ done: false, value: { type: 'event', event: durable } })
    abort.abort()
    await iterator.next()
    observe.mockRestore()
    await ctx.fiber.dispose()
  })

  it('opens an opted-in assistant baseline and preserves mixed live FIFO order', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId('live-follow-attempt')
    const emit = (frame: AssistantStreamFrame): void => {
      ctx.emit('agent/assistant-stream', { agent, frame })
    }
    emit({
      type: 'start', attemptId, revision: 1,
      turn: 1, step: 1,
    })
    const firstChunk = { type: 'text-delta', index: 0, text: 'a' } as const
    emit({
      type: 'chunk', attemptId, revision: 2, index: 0,
      time: 1, chunk: firstChunk,
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: 'snapshot',
        assistantStream: {
          revision: 2,
          activeAttempt: {
            attemptId,
            startedAfterSeq: -1,
            turn: 1,
            step: 1,
            nextIndex: 1,
            stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] }],
          },
        },
      },
    })
    const nextFrame: AssistantStreamFrame = {
      type: 'chunk', attemptId, revision: 3, index: 1,
      time: 2, chunk: { type: 'text-delta', index: 0, text: 'b' },
    }
    emit(nextFrame)
    const message = appendAssistantText(session, 'ab', 1)
    const endFrame: AssistantStreamFrame = {
      type: 'end', attemptId, revision: 4, index: 2,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: message.seq },
    }
    emit(endFrame)

    await expect(iterator.next()).resolves.toEqual({
      done: false, value: { type: 'assistant-stream', frame: nextFrame },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: false, value: { type: 'event', event: message },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: false, value: { type: 'assistant-stream', frame: endFrame },
    })
    abort.abort()
    await iterator.next()
    await ctx.fiber.dispose()
  })

  it('forwards revision one when the attached Agent lifecycle restarts after opening', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId(`${session.id}:1`)
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })
    const oldChunk = { type: 'text-delta', index: 0, text: 'old' } as const
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId, revision: 2, index: 0,
        time: 101, chunk: oldChunk,
      },
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: {
            revision: 2,
            activeAttempt: {
              attemptId,
              startedAfterSeq: -1,
              turn: 1,
              step: 1,
              nextIndex: 1,
              stream: [{ type: 'text-chunks', time0: 101, index: 0, dt: [], texts: ['old'] }],
            },
          },
        },
      })

      ctx.emit('agent/disposed', { agent })
      const replacementAgent = { id: session.id, session, status: 'running', ctx } as Agent
      const replacement: AssistantStreamFrame = {
        type: 'start', attemptId, revision: 1,
        turn: 2, step: 1,
      }
      ctx.emit('agent/assistant-stream', { agent: replacementAgent, frame: replacement })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'assistant-stream', frame: { ...replacement, startedAfterSeq: -1 } },
      })
    } finally {
      await disposeFollow(ctx, iterator, abort)
    }
  })

  it('publishes an empty replacement baseline after an Agent frame revision gap', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId('revision-gap-attempt')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })
    const chunk = { type: 'text-delta', index: 0, text: 'after gap' } as const
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId, revision: 3, index: 0,
        time: 101, chunk,
      },
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: { revision: 3 },
        },
      })
    } finally {
      await disposeFollow(ctx, iterator, abort)
    }
  })

  it('drops active attempts when an Agent chunk index is not dense', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId('dense-index-attempt')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })
    const chunk = { type: 'text-delta', index: 0, text: 'out of order' } as const
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId, revision: 2, index: 1,
        time: 101, chunk,
      },
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: { revision: 2 },
        },
      })
    } finally {
      await disposeFollow(ctx, iterator, abort)
    }
  })

  it('reuses an unchanged Assistant baseline across follow openings', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId('cached-baseline-attempt')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })

    const firstAbort = new AbortController()
    const firstIterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, firstAbort.signal)[Symbol.asyncIterator]()
    const secondAbort = new AbortController()
    const secondIterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, secondAbort.signal)[Symbol.asyncIterator]()
    try {
      const first = await firstIterator.next()
      if (first.done || first.value.type !== 'snapshot') throw new Error('first follow did not open')
      const baseline = first.value.assistantStream
      expect(baseline).toMatchObject({ revision: 1, activeAttempt: { attemptId } })
      const second = await secondIterator.next()
      if (second.done || second.value.type !== 'snapshot') throw new Error('second follow did not open')
      expect(second.value.assistantStream).toEqual(baseline)
    } finally {
      firstAbort.abort()
      secondAbort.abort()
      await firstIterator.return?.()
      await secondIterator.return?.()
      await ctx.fiber.dispose()
    }
  })

  it('opens an empty Assistant baseline before the target Agent emits frames', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: { revision: 0 },
        },
      })
    } finally {
      await disposeFollow(ctx, iterator, abort)
    }
  })

  it('filters Assistant frames from another Session out of the target follow', async () => {
    const { ctx } = await harness()
    const target = ctx.sessions.create(undefined, { meta: { cwd: '/target' } })
    const other = ctx.sessions.create(undefined, { meta: { cwd: '/other' } })
    const otherAgent = { id: other.id, session: other, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: target.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'snapshot' },
      })

      ctx.emit('agent/assistant-stream', {
        agent: otherAgent,
        frame: {
          type: 'start', attemptId: LlmAttemptId('other-session-attempt'),
          revision: 1, turn: 1, step: 1,
        },
      })
      const targetEvent = target.append('turn/start', { turn: 1 })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'event', event: targetEvent },
      })
    } finally {
      await disposeFollow(ctx, iterator, abort)
    }
  })

  it('does not replay a buffered Assistant frame already represented by the opening baseline', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const observationStarted = Promise.withResolvers<undefined>()
    const releaseObservation = Promise.withResolvers<undefined>()
    const originalObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (sessionId, options) => {
      observationStarted.resolve(undefined)
      await releaseObservation.promise
      return await originalObserve(sessionId, options)
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      const opening = iterator.next()
      await observationStarted.promise
      const frame: AssistantStreamFrame = {
        type: 'start', attemptId: LlmAttemptId('opening-cut-attempt'),
        revision: 1, turn: 1, step: 1,
      }
      ctx.emit('agent/assistant-stream', { agent, frame })
      releaseObservation.resolve(undefined)
      await expect(opening).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: { revision: 1, activeAttempt: { attemptId: frame.attemptId } },
        },
      })

      const durable = session.append('turn/start', { turn: 1 })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'event', event: durable },
      })
    } finally {
      releaseObservation.resolve(undefined)
      observe.mockRestore()
      abort.abort()
      await iterator.return?.()
      await ctx.fiber.dispose()
    }
  })

  it('does not release an old-lifecycle frame after the opening baseline resets to revision one', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId(`${session.id}:1`)
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })
    const observationStarted = Promise.withResolvers<undefined>()
    const releaseObservation = Promise.withResolvers<undefined>()
    const originalObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (sessionId, options) => {
      observationStarted.resolve(undefined)
      await releaseObservation.promise
      return await originalObserve(sessionId, options)
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      const opening = iterator.next()
      await observationStarted.promise
      const oldChunk = { type: 'text-delta', index: 0, text: 'old lifecycle' } as const
      ctx.emit('agent/assistant-stream', {
        agent,
        frame: {
          type: 'chunk', attemptId, revision: 2, index: 0,
          time: 101, chunk: oldChunk,
        },
      })
      ctx.emit('agent/assistant-stream', {
        agent,
        frame: {
          type: 'start', attemptId, revision: 1,
          turn: 2, step: 1,
        },
      })
      releaseObservation.resolve(undefined)
      await expect(opening).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: {
            revision: 1,
            activeAttempt: {
              attemptId, startedAfterSeq: -1,
              turn: 2, step: 1, nextIndex: 0, stream: [],
            },
          },
        },
      })

      const durable = session.append('turn/start', { turn: 2 })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'event', event: durable },
      })
    } finally {
      releaseObservation.resolve(undefined)
      observe.mockRestore()
      abort.abort()
      await iterator.return?.()
      await ctx.fiber.dispose()
    }
  })

  it('keeps assistant frames out of a durable-only follower', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
    }, abort.signal)[Symbol.asyncIterator]()
    const opening = await iterator.next()
    expect(opening.value).not.toHaveProperty('assistantStream')
    const attemptId = LlmAttemptId('durable-only-attempt')

    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })
    const durable = session.append('turn/start', { turn: 1 })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'end', attemptId, revision: 2, index: 0, outcome: { kind: 'abandoned' },
      },
    })
    const next = session.append('turn/end', {
      turn: 1, reason: { kind: 'completed' },
    })

    await expect(iterator.next()).resolves.toEqual({
      done: false, value: { type: 'event', event: durable },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: false, value: { type: 'event', event: next },
    })
    abort.abort()
    await iterator.next()
    await ctx.fiber.dispose()
  })


  it('follows raw tool events and preserves result metadata without a Tools service', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const stream = await openFollow(history, session.id, abort.signal)
    const collected = collect(stream, 2, abort)
    const call = session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('raw-call'), name: 'custom', arguments: '{malformed',
    })
    const result = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('raw-call'),
        content: [{ type: 'text', text: 'raw output' }],
        isError: false,
      }),
      meta: { nested: { count: 2 }, paths: ['a.ts', 'b.ts'] },
    }, { surfaceOp: 'append' })

    const frames = await collected
    expect(frames).toEqual([
      { type: 'event', event: call },
      { type: 'event', event: result },
    ])
    expect((frames[1] as Extract<SessionFollowFrame, { type: 'event' }>).event.data)
      .toMatchObject({ meta: { nested: { count: 2 }, paths: ['a.ts', 'b.ts'] } })
  })

  it('follows live results without rescanning Session history', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const stream = await openFollow(history, session.id, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()

    session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('live-fast'), name: 'term', arguments: '{"cmd":"pwd"}',
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'tool/call', data: { callId: 'live-fast' } } },
    })

    const events = vi.spyOn(session, 'snapshotEvents').mockImplementation(() => {
      throw new Error('live result rescanned Session history')
    })
    try {
      session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('live-fast'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      await expect(iterator.next()).resolves.toMatchObject({
        value: { type: 'event', event: { type: 'tool/result', data: { message: { source: { callId: 'live-fast' } } } } },
      })
    } finally {
      events.mockRestore()
      abort.abort()
      await iterator.next()
      await ctx.fiber.dispose()
    }
  })

  it('serves raw call and result entries without parsing tool arguments', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const start = session.append('turn/start', { turn: 1 })
    const call = session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('history-call'), name: 'custom', arguments: '{broken',
    })
    const result = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('history-call'),
        content: [{ type: 'text', text: 'failed raw output' }],
        isError: true,
      }),
      meta: { persisted: true, count: 3 },
    }, { surfaceOp: 'append' })

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: session.seq - 1,
    })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.records).toEqual([
      { type: 'event', event: start },
      { type: 'event', event: call },
      { type: 'event', event: result },
    ])
  })

  it('counts only append-origin messages toward maxMessages and keeps each compaction summary with its replacement', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    const first = appendUserText(session, 'first prompt')
    appendAssistantText(session, 'first reply', 1)
    const third = appendUserText(session, 'second prompt')
    appendAssistantText(session, 'second reply', 2)
    const shadowed = [...session.surface.nodes]
    const shadowedStart = shadowed[0]
    const shadowedEnd = shadowed.at(-1)
    if (shadowedStart === undefined || shadowedEnd === undefined) {
      throw new Error('expected a non-empty surface')
    }
    // A compaction transaction: a log-only summary record immediately followed by the
    // replacement that shadows the range.
    const summary = appendExtension(session, 'compaction/summary', {
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: shadowed[0], end: shadowed.at(-1) },
      shadowedSeqs: shadowed,
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '<context_checkpoint>summary</context_checkpoint>' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), {
      surfaceOp: { op: 'replace', start: shadowedStart, end: shadowedEnd },
      sourceEventSeqs: [...shadowed, summary.seq],
    })

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: session.seq - 1,
      maxMessages: 2,
    })
    if (!response.ok) throw new Error('unreachable')
    const page = pageEvents(response.value)
    // Two append-origin messages fill the page even though a replacement copy of
    // the same event type sits in the window: the copy is model-only.
    const messages = page.filter(event => event.type === 'user/message' || event.type === 'assistant/message')
    expect(messages.map(event => event.seq)).toEqual([third.seq, third.seq + 1, third.seq + 3])
    expect(page.some(event => event.seq === first.seq)).toBe(false)
    expect(response.value.hasMore).toBe(true)
    // The range stays contiguous, so the checkpoint's summary record is readable on
    // the same page as the checkpoint itself.
    const summaryIndex = page.findIndex(event => event.seq === summary.seq)
    expect(summaryIndex).toBeGreaterThan(-1)
    expect(page[summaryIndex + 1]?.seq).toBe(summary.seq + 1)
    expect(page.map(event => event.seq)).toEqual(page.map((_event, index) => third.seq + index))
  })

  it('paginates a message with a large embedded stream without expanding physical records', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const texts = Array.from({ length: 128 }, () => 'x')
    const message = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(texts.length) }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
      stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: texts.slice(1).map(() => 0), texts }],
    }, { surfaceOp: 'append' })

    const scalarMin = Math.min
    const min = vi.spyOn(Math, 'min').mockImplementation((...values) => {
      if (values.length > 2) throw new RangeError('variadic minimum rejected by regression harness')
      return scalarMin(...values)
    })
    try {
      const response = await remote.page({
        address: { kind: 'session', sessionId: session.id },
        throughSeq: message.seq,
        maxMessages: 1,
      })
      if (!response.ok) throw new Error('unreachable')
      expect(pageEvents(response.value).map(event => event.seq)).toEqual([message.seq])
      expect(response.value.records).toEqual([{ type: 'event', event: message }])
      expect(response.value.hasMore).toBe(true)
    } finally {
      min.mockRestore()
    }
  })

  it('keeps an earlier declared source on the same message-aligned page', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const source = session.append('request/context', { provider: 'p', model: 'm' })
    const laterSource = session.append('request/context', { provider: 'p', model: 'm' })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'with source' }], source: { kind: 'user' },
    }), { sourceEventSeqs: [source.seq, laterSource.seq], surfaceOp: 'append' })

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: message.seq,
      maxMessages: 1,
    })
    if (!response.ok) throw new Error('unreachable')
    expect(pageEvents(response.value).map(event => event.seq)).toEqual([source.seq, laterSource.seq, message.seq])
    expect(response.value.hasMore).toBe(false)
    await ctx.fiber.dispose()
  })

  it('keeps compact reasoning and tool-call runs nested in one attempt event', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const callId = ToolCallId('packed-call')
    const attempt = session.append('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [
        { type: 'reasoning-chunks', time0: 1, index: 0, dt: [1, 1], texts: ['r0', 'r1', 'r2'] },
        { type: 'tool-call-chunks', time0: 4, index: 1, id: callId, dt: [1, 1], args: ['a0', 'a1', 'a2'] },
      ],
    })

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: session.seq - 1,
    })
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.records).toEqual([{ type: 'event', event: attempt }])
    await ctx.fiber.dispose()
  })

  it('follows a result after turn/end without reading the addressed Session log', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const stream = await openFollow(history, session.id, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()

    session.append('turn/start', { turn: 1 })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'turn/start' } },
    })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c-late'), name: 'term', arguments: '{"cmd":"tail"}' })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'tool/call' } },
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'turn/end' } },
    })
    const events = vi.spyOn(session, 'snapshotEvents').mockImplementation(() => {
      throw new Error('live result rescanned Session history')
    })
    try {
      const result = session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('c-late'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'event', event: result },
      })
    } finally {
      events.mockRestore()
      abort.abort()
      await iterator.next()
      await ctx.fiber.dispose()
    }
  })
})
