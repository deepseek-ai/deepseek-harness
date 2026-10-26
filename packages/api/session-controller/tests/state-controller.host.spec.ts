import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import type AgentRegistry from '@deepseek-ai/dsh-agent'
import type TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import type { PendingRemoteEventInfo } from '@deepseek-ai/dsh-api-gateway'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryController } from '../src/history/controller.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { StateController } from '../src/state/controller.ts'
import { StateListener } from '../src/state/listener.ts'
import type { SessionState, SessionRequestId } from '../src/types.ts'
import { installSessionReadTestServices } from './test-remote.ts'

const roots: Context[] = []
const aborters: AbortController[] = []
const operations: Promise<unknown>[] = []
function cancellation(): AbortController {
  const abort = new AbortController()
  aborters.push(abort)
  return abort
}
function tracked<T>(promise: Promise<T>): Promise<T> {
  operations.push(promise)
  void promise.catch(() => undefined)
  return promise
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
afterEach(async () => {
  for (const abort of aborters.splice(0)) abort.abort()
  await Promise.allSettled(operations.splice(0))
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  const session = ctx.sessions.create(SessionId('state-target'), { meta: { cwd: '/state-test' } })
  let agent: Agent | undefined
  const get = vi.fn(() => agent)
  const agents: Partial<AgentRegistry> = { get }
  ctx.provide('agents', agents as AgentRegistry)
  const pending: PendingRemoteEventInfo[] = []
  const pendingRead = vi.fn(() => pending)
  const gateway: Partial<TypertGatewayService> = { getPendingRemoteEvents: pendingRead }
  ctx.provide('typertGateway', gateway as TypertGatewayService)
  const history = new HistoryController(ctx)
  const output = vi.spyOn(history, 'assistantOutput').mockResolvedValue({ records: [], truncated: false })
  const controller = new StateController(ctx, history)
  const abort = cancellation()
  const request = { sessionId: session.id }
  const live = (status: Agent['status'] = 'running', idle = Promise.resolve(undefined)) => {
    const value = {
      id: session.id, session, status,
      inbox: createInboxStub(),
      whenIdle: vi.fn(() => idle),
    }
    const partial: Partial<Agent> = value
    agent = partial as Agent
    return value
  }
  const addPending = (event: string, id = session.id) => {
    pending.push({ event, agentId: brandString<PendingRemoteEventInfo['agentId']>(id) })
  }
  return {
    ctx, session, controller, history, output, abort, request, live, get, pending, pendingRead, addPending,
    setAgent: (value: Agent | undefined) => { agent = value },
  }
}
const emptyState: SessionState = { cursor: -1, active: false, running: false, queue: null, pendingInput: [] }

describe('StateController', () => {
  it('re-reads a state whose cold read turned live', async () => {
    const f = await fixture()
    const agent = f.live('running')
    // The first lookup misses; the Session is a live source by the time the cold read runs.
    let lookups = 0
    f.get.mockImplementation(() => (lookups++ === 0 ? undefined : agent as never))
    const state = await f.controller.state(f.request, new AbortController().signal)
    expect(state).toMatchObject({ active: true, running: true, queue: [] })
    expect(state.cursor).toBe(f.session.seq - 1)
    expect(lookups).toBeGreaterThan(1)
  })

  it('rejects a live state read whose Session records no cwd', async () => {
    const f = await fixture()
    const session = f.ctx.sessions.create(SessionId('no-cwd-live'))
    const partial: Partial<Agent> = {
      id: session.id, session, status: 'idle', inbox: createInboxStub(), whenIdle: vi.fn(() => Promise.resolve(undefined)),
    }
    f.setAgent(partial as Agent)
    await expect(f.controller.state({ sessionId: session.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('rejects a cold state read whose stored header records no cwd', async () => {
    const f = await fixture()
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: f.session.id, createdAt: 1, isSeeded: false,
    }
    const observation: SessionObservation = {
      source: 'prepared',
      header,
      inheritedEventCount: SessionLogOffset(0),
      events: [],
      cursor: -1,
      projections: { asOfSeq: -1, values: {} },
      retain: () => observation,
      [Symbol.dispose]: () => {},
    }
    vi.spyOn(f.history, 'usingObservation').mockImplementation(async (_request, _signal, callback) =>
      callback?.(observation))
    await expect(f.controller.state(f.request, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('reads cold state without projections and reports classified, deduplicated pending input', async () => {
    const f = await fixture()
    const read = vi.spyOn(f.history, 'usingObservation')
    f.addPending('approval/request')
    f.addPending('user-questions/request')
    f.addPending('fixture/request')
    f.addPending('approval/request')
    f.addPending('ignored', SessionId('other'))
    expect(await f.controller.state(f.request, f.abort.signal)).toEqual({ ...emptyState, pendingInput: ['approval', 'question', 'other'] })
    expect(read).toHaveBeenCalledWith({ sessionId: f.session.id, projection: false }, f.abort.signal, expect.any(Function))
  })

  it('preserves live queues, RPC identities and steering versus context placement', async () => {
    const f = await fixture()
    const queued = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
    const steering = createUserMessage({ content: [{ type: 'text', text: 'steer' }], source: { kind: 'user', rpcId: 'rpc' as SessionRequestId } })
    const context = createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'user-approval' } })
    const agent = f.live()
    agent.inbox.append('next-turn', queued)
    agent.inbox.append('next-step', steering)
    agent.inbox.append('next-step', context)
    expect(await f.controller.state(f.request, f.abort.signal)).toEqual({
      cursor: -1, active: true, running: true, pendingInput: [],
      queue: [
        { id: queued.id, placement: 'queued', content: queued.content },
        { id: steering.id, placement: 'steering', content: steering.content, rpcId: 'rpc' },
        { id: context.id, placement: 'context', content: context.content },
      ],
    })
  })

  it('rejects already cancelled state reads', async () => {
    const f = await fixture()
    f.abort.abort(new Error('cancelled'))
    await expect(f.controller.state(f.request, f.abort.signal)).rejects.toThrow('cancelled')
  })

  it('observes complete replacements and closes a pending read on cancellation', async () => {
    const f = await fixture()
    const states = f.controller.observeState(f.request, f.abort.signal)[Symbol.asyncIterator]()
    expect(await states.next()).toMatchObject({ value: emptyState })
    f.live()
    const next = tracked(states.next())
    f.session.append('turn/start', { turn: 1 })
    expect(await next).toMatchObject({ value: { active: true, running: true, cursor: 0 } })
    const end = tracked(states.next())
    f.abort.abort()
    expect(await end).toEqual({ done: true, value: undefined })
    await states.return?.()
  })

  it('returns inactive idle state and delegates the exact output window with caller signal', async () => {
    const f = await fixture()
    const result = await f.controller.wait({ ...f.request, afterSeq: 3, maxMessages: 2 }, f.abort.signal)
    expect(result).toEqual({ reason: 'idle', state: emptyState, output: { records: [], truncated: false } })
    expect(f.output).toHaveBeenCalledWith(f.session.id, 3, -1, 2, f.abort.signal)
  })

  it('stops immediately for pending input even while the Agent runs', async () => {
    const f = await fixture()
    f.live()
    f.addPending('approval/request')
    expect(await f.controller.wait(f.request, f.abort.signal)).toMatchObject({ reason: 'input-required' })
  })

  it('confirms an active idle Agent with whenIdle', async () => {
    const f = await fixture()
    const agent = f.live('idle')
    expect(await f.controller.wait(f.request, f.abort.signal)).toMatchObject({ reason: 'idle', state: { active: true } })
    expect(agent.whenIdle).toHaveBeenCalledOnce()
  })

  it('polls pending input after one second without Gateway notifications', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    f.live()
    const result = tracked(f.controller.wait(f.request, f.abort.signal))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.pendingRead).toHaveBeenCalledTimes(1)
    f.addPending('user-questions/request')
    await vi.advanceTimersByTimeAsync(999)
    expect(f.pendingRead).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ reason: 'input-required', state: { pendingInput: ['question'] } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the latest accepted state on timeout and still reads output with the caller signal', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    f.live()
    const result = tracked(f.controller.wait({ ...f.request, timeoutMs: 1500 }, f.abort.signal))
    await vi.advanceTimersByTimeAsync(1500)
    expect(await result).toMatchObject({ reason: 'timeout', state: { running: true } })
    expect(f.output).toHaveBeenCalledWith(f.session.id, -1, -1, 50, f.abort.signal)
    expect(f.abort.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('responds to a standard event before the polling tick and races idle against new state', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    const idle = deferred<undefined>()
    f.live('idle', idle.promise)
    const result = tracked(f.controller.wait(f.request, f.abort.signal))
    await vi.advanceTimersByTimeAsync(0)
    f.addPending('approval/request')
    f.session.append('turn/start', { turn: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(await result).toMatchObject({ reason: 'input-required', state: { cursor: 0 } })
    idle.resolve(undefined)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates cancellation while waiting and cleans periodic reads', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    f.live()
    const result = tracked(f.controller.wait(f.request, f.abort.signal))
    await vi.advanceTimersByTimeAsync(0)
    f.abort.abort(new Error('caller cancelled'))
    await expect(result).rejects.toThrow('caller cancelled')
    expect(f.output).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates an idle-driver failure without treating it as a deadline', async () => {
    const f = await fixture()
    const idle = deferred<undefined>()
    const agent = f.live('idle', idle.promise)
    agent.whenIdle.mockImplementation(() => Promise.reject(new Error('driver failed')))
    await expect(f.controller.wait(f.request, f.abort.signal)).rejects.toThrow('driver failed')
    idle.resolve(undefined)
  })

  it('propagates a structured read failure raised before the deadline', async () => {
    const f = await fixture()
    const failure = deferred<undefined>()
    vi.spyOn(StateListener.prototype, 'observeStates').mockImplementation(async function* () {
      await failure.promise
      throw new RemoteError('gateway/internal', 'persistent read failed', {})
    })
    const result = tracked(f.controller.wait({ ...f.request, timeoutMs: 5_000 }, f.abort.signal))
    failure.resolve(undefined)
    await expect(result).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('keeps a structured read failure raised after the deadline', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    let rejectRead!: (error: Error) => void
    vi.spyOn(StateListener.prototype, 'observeStates').mockImplementation(async function* () {
      await new Promise<void>((_resolve, reject) => { rejectRead = reject })
      yield* []
    })
    const result = tracked(f.controller.wait({ ...f.request, timeoutMs: 20 }, f.abort.signal))
    await vi.advanceTimersByTimeAsync(20)
    rejectRead(new RemoteError('gateway/internal', 'persistent read failed', {}))
    await expect(result).rejects.toMatchObject({ code: 'gateway/internal' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports timeout when its first cold read never yields a state', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation((_id, options) => new Promise((_resolve, reject) => {
      const abort = options?.signal
      abort?.addEventListener('abort', () => {
        const reason: unknown = abort.reason
        reject(Object.assign(new Error('session observation was aborted'), {
          code: 'SESSION_QUERY_ABORTED', cause: reason,
        }))
      }, { once: true })
    }))
    const result = tracked(f.controller.wait({ ...f.request, timeoutMs: 20 }, f.abort.signal))
    await vi.advanceTimersByTimeAsync(20)
    await expect(result).rejects.toMatchObject({ code: 'session/wait-timeout' })
    expect(f.output).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a state stream that ends before a stopping observation', async () => {
    const f = await fixture()
    vi.spyOn(StateListener.prototype, 'observeStates').mockImplementation(async function* () {})
    await expect(f.controller.wait(f.request, f.abort.signal)).rejects.toMatchObject({ code: 'session/observation-ended' })
  })

  it('settles an already-armed failed read when the preceding observation stops the wait', async () => {
    const f = await fixture()
    vi.spyOn(StateListener.prototype, 'observeStates').mockImplementation(async function* () {
      yield { state: emptyState, revision: 0 }
      throw new Error('next read failed')
    })
    expect(await f.controller.wait(f.request, f.abort.signal)).toMatchObject({ reason: 'idle' })
  })

  it('ignores a yielded state invalidated before wait accepts it', async () => {
    const f = await fixture()
    vi.spyOn(StateListener.prototype, 'observeStates').mockImplementation(async function* () {
      yield { state: { ...emptyState, running: true }, revision: 0 }
      yield { state: emptyState, revision: 1 }
    })
    vi.spyOn(StateListener.prototype, 'isCurrent').mockReturnValueOnce(false).mockReturnValue(true)
    expect(await f.controller.wait(f.request, f.abort.signal)).toMatchObject({ reason: 'idle', state: emptyState })
  })

  it('times out with the last accepted state, not a later invalidated sample', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    const accepted = { ...emptyState, running: true }
    const stale = { ...emptyState, running: true, cursor: 7 }
    const never = deferred<undefined>()
    vi.spyOn(StateListener.prototype, 'observeStates').mockImplementation(async function* () {
      yield { state: accepted, revision: 0 }
      yield { state: stale, revision: 0 }
      await never.promise
      yield* []
    })
    vi.spyOn(StateListener.prototype, 'isCurrent').mockReturnValueOnce(true).mockReturnValue(false)
    const result = tracked(f.controller.wait({ ...f.request, timeoutMs: 20 }, f.abort.signal))
    await vi.advanceTimersByTimeAsync(20)
    never.resolve(undefined)
    await expect(result).resolves.toMatchObject({ reason: 'timeout', state: { cursor: -1 } })
  })

  it.each(['missing-agent', 'different-session'] as const)('retries active state when its owner is %s', async (condition) => {
    const f = await fixture()
    const agent = f.live('idle')
    if (condition === 'missing-agent') f.setAgent(undefined)
    else Object.assign(agent, { session: f.ctx.sessions.create(SessionId('replacement')) })
    vi.spyOn(StateListener.prototype, 'observeStates').mockImplementation(async function* () {
      yield { state: { ...emptyState, active: true, queue: [] }, revision: 0 }
      yield { state: emptyState, revision: 0 }
    })
    expect(await f.controller.wait(f.request, f.abort.signal)).toMatchObject({ reason: 'idle', state: emptyState })
    expect(agent.whenIdle).not.toHaveBeenCalled()
  })

  it.each(['revision', 'agent', 'session'] as const)('rechecks %s after the idle promise settles', async (changed) => {
    const f = await fixture()
    const idle = deferred<undefined>()
    const entered = deferred<undefined>()
    const next = deferred<undefined>()
    const agent = f.live('idle', idle.promise)
    agent.whenIdle.mockImplementation(() => { entered.resolve(undefined); return idle.promise })
    vi.spyOn(StateListener.prototype, 'observeStates').mockImplementation(async function* () {
      yield { state: { ...emptyState, active: true, queue: [] }, revision: 0 }
      await next.promise
      yield { state: emptyState, revision: 0 }
    })
    const rechecked = deferred<undefined>()
    let checks = 0
    vi.spyOn(StateListener.prototype, 'isCurrent').mockImplementation(() => {
      checks++
      if (checks === 2) rechecked.resolve(undefined)
      return !(changed === 'revision' && checks === 2)
    })
    const result = tracked(f.controller.wait(f.request, f.abort.signal))
    try {
      await entered.promise
      if (changed === 'agent') f.setAgent(undefined)
      if (changed === 'session') Object.assign(agent, { session: f.ctx.sessions.create(SessionId('new-session')) })
      idle.resolve(undefined)
      await rechecked.promise
      next.resolve(undefined)
      expect(await result).toMatchObject({ reason: 'idle', state: emptyState })
    } finally {
      idle.resolve(undefined)
      next.resolve(undefined)
      f.abort.abort()
      await Promise.allSettled([result])
    }
  })

  it.each([
    { afterSeq: -2 }, { afterSeq: -0 }, { afterSeq: 1.5 },
    { maxMessages: 0 }, { maxMessages: 1.5 },
    { timeoutMs: 0 }, { timeoutMs: 2147483648 }, { timeoutMs: 1.5 },
  ])('rejects unsupported wait bounds %j', async (bounds) => {
    const f = await fixture()
    await expect(f.controller.wait({ ...f.request, ...bounds }, f.abort.signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })
})

describe('StateListener', () => {
  it('discards an async stale read and coalesces repeated invalidations', async () => {
    const f = await fixture()
    const first = deferred<SessionState>()
    const reading = deferred<undefined>()
    const read = vi.fn()
      .mockImplementationOnce(() => { reading.resolve(undefined); return first.promise })
      .mockResolvedValue({ ...emptyState, cursor: 1 })
    using listener = new StateListener(f.ctx, f.session.id, f.abort.signal, read)
    const states = listener.observeStates()
    const pending = tracked(states.next())
    await reading.promise
    f.session.append('turn/start', { turn: 1 })
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    first.resolve(emptyState)
    expect(await pending).toEqual({ done: false, value: { state: { ...emptyState, cursor: 1 }, revision: 2 } })
    expect(read).toHaveBeenCalledTimes(2)
    expect(listener.isCurrent(0)).toBe(false)
    expect(listener.isCurrent(2)).toBe(true)
    await states.return(undefined)
    expect(listener.isCurrent(2)).toBe(false)
  })

  it('ignores other Sessions and ends when its Context is disposed', async () => {
    const f = await fixture()
    const read = vi.fn(async () => emptyState)
    const listener = new StateListener(f.ctx, f.session.id, f.abort.signal, read)
    const states = listener.observeStates()
    await states.next()
    const pending = tracked(states.next())
    f.ctx.sessions.create(SessionId('unrelated'))
    expect(read).toHaveBeenCalledOnce()
    await f.ctx.fiber.dispose()
    expect(await pending).toEqual({ done: true, value: undefined })
    listener[Symbol.dispose]()
  })

  it('invalidates for each Agent lifecycle notification', async () => {
    const f = await fixture()
    f.live('idle')
    const agent = f.get()!
    using listener = new StateListener(f.ctx, f.session.id, f.abort.signal, async () => emptyState)
    const states = listener.observeStates()
    await states.next()
    for (const emit of [
      () => { f.ctx.emit('agent/status', { agent, status: 'running' }) },
      () => { f.ctx.emit('agent/created', { agent, source: 'startup' }) },
      () => { f.ctx.emit('agent/disposed', { agent }) },
    ]) {
      const pending = tracked(states.next())
      emit()
      expect(await pending).toMatchObject({ done: false, value: { state: emptyState } })
    }
    await states.return(undefined)
  })

  it('rejects cancelled construction and contains setup failure by removing abort listeners', async () => {
    const f = await fixture()
    f.abort.abort()
    expect(() => new StateListener(f.ctx, f.session.id, f.abort.signal, async () => emptyState)).toThrow()
    const abort = cancellation()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    vi.spyOn(f.ctx, 'on').mockImplementation(() => { throw new Error('registration failed') })
    expect(() => new StateListener(f.ctx, f.session.id, abort.signal, async () => emptyState)).toThrow('registration failed')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
