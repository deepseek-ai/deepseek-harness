import { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventListener, ListenerBuffer, ProjectionListener, eventItem } from '../src/history/listener.ts'
import { SessionAssistantStreamsListener } from '../src/history/assistant-stream.ts'
import type { SessionFollowFrame, SessionEventEntry } from '../src/types.ts'
import { installSessionReadTestServices } from './test-remote.ts'

const roots: Context[] = []
const aborts: AbortController[] = []
function cancellation() {
  const abort = new AbortController()
  aborts.push(abort)
  return abort
}
afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})
async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  const session = ctx.sessions.create(SessionId('listener-target'), { meta: { cwd: '/listeners' } })
  const abort = cancellation()
  const partial: Partial<Agent> = { id: session.id, session }
  const agent = partial as Agent
  const emit = (frame: AssistantStreamFrame) => { ctx.emit('agent/assistant-stream', { agent, frame }) }
  return { ctx, session, abort, emit, agent }
}
const start = (revision = 1): AssistantStreamFrame => ({ type: 'start', attemptId: LlmAttemptId('attempt'), revision, turn: 1, step: 1 })

describe('ListenerBuffer', () => {
  it('orders heterogeneous inputs lazily, supports prepend, and admits only one consumer', async () => {
    const { ctx, abort } = await fixture()
    using buffer = new ListenerBuffer<string>(ctx, abort.signal)
    const convert = vi.fn((value: number) => [`n:${value}`])
    const numbers = buffer.createInput(convert)
    const words = buffer.createInput<string>(value => [value])
    numbers.append(2)
    words.prepend('first')
    expect(convert).not.toHaveBeenCalled()
    const values = buffer.items()[Symbol.asyncIterator]()
    expect(await values.next()).toEqual({ done: false, value: 'first' })
    expect(await values.next()).toEqual({ done: false, value: 'n:2' })
    await expect(buffer.items()[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'gateway/internal' })
    const waiting = values.next()
    numbers.append(3)
    expect(await waiting).toMatchObject({ value: 'n:3' })
    await values.return?.()
    const action = vi.fn()
    buffer.capture(action)
    numbers.append(4)
    words.prepend('closed')
    expect(action).not.toHaveBeenCalled()
    buffer.own(action)
    expect(action).toHaveBeenCalledOnce()
    expect(() => buffer.createInput<string>(value => [value])).toThrow('closed')
  })

  it('propagates captured failure both before and during transformation', async () => {
    const { ctx, abort } = await fixture()
    using first = new ListenerBuffer<number>(ctx, abort.signal)
    first.capture(() => { throw new Error('captured') })
    await expect(first.items()[Symbol.asyncIterator]().next()).rejects.toThrow('captured')
    using second = new ListenerBuffer<number>(ctx, abort.signal)
    const input = second.createInput<number>(function* (value) {
      second.capture(() => { throw new Error('transform failure') })
      yield value
    })
    input.append(1)
    await expect(second.items()[Symbol.asyncIterator]().next()).rejects.toThrow('transform failure')
  })

  it('does not emit after transformation closes its own buffer', async () => {
    const { ctx, abort } = await fixture()
    using buffer = new ListenerBuffer<number>(ctx, abort.signal)
    buffer.createInput<number>(function* (value) { buffer[Symbol.dispose](); yield value }).append(1)
    expect(await buffer.items()[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
  })

  it('releases abort registration when effect installation fails', async () => {
    const { ctx, abort } = await fixture()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    vi.spyOn(ctx, 'effect').mockImplementation(() => { throw new Error('effect failure') })
    expect(() => new ListenerBuffer(ctx, abort.signal)).toThrow('effect failure')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

describe('EventListener', () => {
  it('starts at the first notification without acquiring a snapshot', async () => {
    const { ctx, session, abort } = await fixture()
    using listener = new EventListener(ctx, session.id, abort.signal)
    const event = session.append('turn/start', { turn: 1 })
    const values = listener.events()[Symbol.asyncIterator]()
    expect(await values.next()).toMatchObject({ value: { type: 'event', event } })
    abort.abort()
    expect(await values.next()).toMatchObject({ done: true })
  })

  it('subscribes before an empty Session is created and follows its first later event', async () => {
    const { ctx, abort } = await fixture()
    const id = SessionId('created-after-bind')
    using listener = new EventListener(ctx, id, abort.signal)
    const session = ctx.sessions.create(id)
    const values = listener.events()[Symbol.asyncIterator]()
    const waiting = values.next()
    const event = session.append('turn/start', { turn: 1 })
    expect(await waiting).toMatchObject({ value: { event } })
    await values.return?.()
  })

  it('filters buffered events through a supplied cursor', async () => {
    const { ctx, session, abort } = await fixture()
    using listener = new EventListener(ctx, session.id, abort.signal)
    session.append('turn/start', { turn: 1 })
    const event = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    listener.setCursor(0)
    const values = listener.events()[Symbol.asyncIterator]()
    expect(await values.next()).toMatchObject({ value: { event } })
    await values.return?.()
  })

  it('leaves an external buffer open and drops notifications after listener disposal', async () => {
    const { ctx, session, abort } = await fixture()
    using queue = new ListenerBuffer<SessionEventEntry>(ctx, abort.signal)
    const listener = new EventListener(ctx, session.id, abort.signal, queue)
    session.append('turn/start', { turn: 1 })
    await expect(listener.events()[Symbol.asyncIterator]().next()).rejects.toThrow('externally owned')
    listener[Symbol.dispose]()
    const values = queue.items()[Symbol.asyncIterator]()
    const next = values.next()
    abort.abort()
    expect(await next).toMatchObject({ done: true })
  })

  it('stops within a creation batch when its binding is disposed', async () => {
    const { ctx, session, abort } = await fixture()
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    using queue = new ListenerBuffer<SessionEventEntry>(ctx, abort.signal)
    const listener = new EventListener(ctx, session.id, abort.signal, queue)
    listener.setCursor(-1)
    ctx.emit('session/created', session)
    const values = queue.items()[Symbol.asyncIterator]()
    expect(await values.next()).toMatchObject({ value: { event: { seq: 0 } } })
    listener[Symbol.dispose]()
    const waiting = values.next()
    abort.abort()
    expect(await waiting).toMatchObject({ done: true })
  })

  it('cleans a partially installed registration when a later one fails', async () => {
    const { ctx, session, abort } = await fixture()
    const on = ctx.on.bind(ctx)
    let count = 0
    vi.spyOn(ctx, 'on').mockImplementation((...args) => {
      if (++count === 2) throw new Error('registration failure')
      return on(...args)
    })
    expect(() => new EventListener(ctx, session.id, abort.signal)).toThrow('registration failure')
  })

  it('handles raw events and rejects a noncontiguous supplied creation prefix', async () => {
    const { session } = await fixture()
    const event = session.append('turn/start', { turn: 1 })
    expect(eventItem({ type: 'event', session, event })).toEqual({ events: [event], next: 1 })
    expect(eventItem({ type: 'created', session, end: 0 })).toEqual({ events: [], next: undefined })
    vi.spyOn(session, 'snapshotEvents').mockReturnValue([{ ...event, seq: SessionSeq(1) }])
    expect(() => eventItem({ type: 'created', session, end: 2 }, 0)).toThrow('skipped seq')
    expect(eventItem({ type: 'created', session, end: 2 })).toMatchObject({ next: 2 })
  })
})

describe('ProjectionListener', () => {
  it('emits sparse changes only for the selected Session', async () => {
    const { ctx, session, abort } = await fixture()
    let receive!: Parameters<typeof ctx.sessionProjections.onChanged>[0]
    const dispose = vi.fn()
    vi.spyOn(ctx.sessionProjections, 'onChanged').mockImplementation((listener) => { receive = listener; return dispose })
    using listener = new ProjectionListener(ctx, session.id, abort.signal)
    const other = ctx.sessions.create(SessionId('other'))
    receive(other, 'subagent', null, SessionSeq(0))
    receive(session, 'subagent', null, SessionSeq(1))
    const changes = listener.changes()[Symbol.asyncIterator]()
    expect(await changes.next()).toMatchObject({ value: { type: 'projection', key: 'subagent', value: null, seq: 1 } })
    abort.abort()
    expect(await changes.next()).toMatchObject({ done: true })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('releases its buffer when projection subscription fails', async () => {
    const { ctx, session, abort } = await fixture()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    vi.spyOn(ctx.sessionProjections, 'onChanged').mockImplementation(() => { throw new Error('projection subscribe failed') })
    expect(() => new ProjectionListener(ctx, session.id, abort.signal)).toThrow('projection subscribe failed')
    expect(remove).toHaveBeenCalled()
  })
})

describe('AssistantStreamListener', () => {
  it('cuts baseline-covered arrivals and clears reconnect state on Agent disposal', async () => {
    const { ctx, session, abort, emit, agent } = await fixture()
    const streams = new SessionAssistantStreamsListener(ctx)
    using queue = new ListenerBuffer<SessionFollowFrame>(ctx, abort.signal)
    using listener = streams.bind(session.id, abort.signal, queue)
    expect(listener.snapshot()).toEqual({ baseline: { revision: 0 }, ordinal: 0 })
    emit(start())
    expect(listener.snapshot()).toMatchObject({ baseline: { revision: 1 }, ordinal: 1 })
    listener.setOrdinalCut(1)
    const frames = queue.items()[Symbol.asyncIterator]()
    const end: AssistantStreamFrame = { type: 'end', attemptId: LlmAttemptId('attempt'), revision: 2, index: 0, outcome: { kind: 'abandoned' } }
    emit(end)
    expect(await frames.next()).toMatchObject({ value: { type: 'assistant-stream', frame: end } })
    ctx.emit('agent/disposed', { agent })
    expect(listener.snapshot()).toEqual({ baseline: { revision: 0 }, ordinal: 2 })
    abort.abort()
    expect(await frames.next()).toMatchObject({ done: true })
  })

  it('records the durable cursor for an attempt started after a committed event', async () => {
    const { ctx, session, abort, emit } = await fixture()
    session.append('turn/start', { turn: 1 })
    const streams = new SessionAssistantStreamsListener(ctx)
    using queue = new ListenerBuffer<SessionFollowFrame>(ctx, abort.signal)
    using listener = streams.bind(session.id, abort.signal, queue)
    emit(start())
    listener.setOrdinalCut(0)
    const frames = queue.items()[Symbol.asyncIterator]()
    expect(await frames.next()).toMatchObject({ value: { frame: { type: 'start', startedAfterSeq: 0 } } })
    await frames.return?.()
  })

  it('leaves queue ownership intact and drops notifications after unbinding', async () => {
    const { ctx, session, abort, emit } = await fixture()
    const streams = new SessionAssistantStreamsListener(ctx)
    using queue = new ListenerBuffer<SessionFollowFrame>(ctx, abort.signal)
    const listener = streams.bind(session.id, abort.signal, queue)
    emit(start())
    listener[Symbol.dispose]()
    const next = queue.items()[Symbol.asyncIterator]().next()
    abort.abort()
    expect(await next).toMatchObject({ done: true })
  })

  it('propagates registration failure without closing the shared queue', async () => {
    const { ctx, session, abort } = await fixture()
    const streams = new SessionAssistantStreamsListener(ctx)
    using queue = new ListenerBuffer<SessionFollowFrame>(ctx, abort.signal)
    vi.spyOn(ctx, 'on').mockImplementation(() => { throw new Error('assistant subscribe failed') })
    expect(() => streams.bind(session.id, abort.signal, queue)).toThrow('assistant subscribe failed')
    // The failed binding leaves the shared queue usable for the rest of the connection.
    const input = queue.createInput<SessionFollowFrame>(value => [value])
    const event = session.append('turn/start', { turn: 1 })
    input.append({ type: 'event', event })
    await expect(queue.items()[Symbol.asyncIterator]().next()).resolves.toMatchObject({ value: { type: 'event', event } })
  })
})
