/** Scoped Remote Event wiring and projection publishing for the browser question consumer. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InboxWireState } from '@deepseek-ai/dsh-agent/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PendingUserQuestion, UserQuestionProjectionView } from '@deepseek-ai/dsh-user-questions/types'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { PendingQuestion } from '../src/client/contract/slots.ts'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { apply, inject } from '../src/client/index.ts'
import { TimedQuestionWait } from '../../../interaction/user-questions/src/timed-wait.ts'

const SESSION_ID = 'session-question' as SessionId
const SESSION_SCOPE = Symbol('question-session-scope')
const CALL = ToolCallId('call-timed')
const QUESTIONS = [{ id: 'mode', question: 'Choose a mode' }] as const
const ANSWER = { answers: [{ id: 'mode', selected: ['Fast'] }] }
const PLAN_QUESTIONS: PendingQuestion['questions'] = [{
  id: 'plan',
  question: 'Approve this plan?',
  detail: '# Plan',
  options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review', approve: 'Approve' },
}]
/** One settled call as its tool call row reads it back. */
const RECORD = { questions: [...QUESTIONS], answers: [...ANSWER.answers] }
const CONTINUED: PendingUserQuestion = { callId: CALL, questions: [...QUESTIONS], state: 'continued' }
/** The projection value this consumer reads; it acts on the answerable half alone. */
const view = (active: readonly PendingUserQuestion[]): UserQuestionProjectionView => ({ active, settled: [] })
const emptyInbox = (): InboxWireState => ({ 'next-step': [], 'next-turn': [] })
const queuedInbox = (callId: ToolCallId): InboxWireState => ({
  'next-step': [{ source: { kind: 'user-question-reply', callId }, content: [] }],
  'next-turn': [],
})

type QuestionRequest = {
  questions: PendingQuestion['questions']
  signal?: AbortSignal
  wait?: { callId: ToolCallId; timed?: boolean }
}
type QuestionAnswer = typeof ANSWER
type QuestionNext = () => Promise<QuestionAnswer>
type QuestionListener = (
  this: Context,
  request: QuestionRequest,
  next: QuestionNext,
) => Promise<QuestionAnswer>
type RemoteBooleanResult = { ok: true; value: boolean } | { ok: false; error: { message: string } }

/** `absent` seeds a projection face that has published nothing yet. */
async function bench(
  declare = true,
  durable: readonly PendingUserQuestion[] | 'absent' = [],
  remainingMs = 60_000,
  initialInbox: InboxWireState = emptyInbox(),
) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  if (declare) {
    slots.register(
      {
        name: 'root',
        children: {
          'conversation.composer': { kind: 'chain', scope: 'session' },
          'conversation.chat.node': { kind: 'keyed', scope: 'session' },
        },
      } as never,
      () => null,
    )
  }
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const agent = ctx.extend({ [SESSION_SCOPE]: SESSION_ID })
  const scopeOf = vi.fn((candidate: Context) => (
    candidate as Context & { [SESSION_SCOPE]?: SessionId }
  )[SESSION_SCOPE])
  const projection = createSnapshotStore<UserQuestionProjectionView | undefined>(durable === 'absent' ? undefined : view(durable))
  const inbox = createSnapshotStore<InboxWireState | undefined>(initialInbox)
  const list = createSnapshotStore({
    ids: [SESSION_ID],
    byId: { [SESSION_ID]: { id: SESSION_ID } },
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  const binding = vi.fn((sessionId: SessionId) => sessionId === SESSION_ID
    ? ({ sessionId: SESSION_ID, session: { projections: { faceOf: (name: string) => name === 'inbox' ? inbox : projection } } })
    : undefined)
  ctx.provide('sessions', { scopeOf, list, binding } as never)
  const pending = new Map<PendingQuestion, () => Promise<void>>()
  const registerPendingInteraction = vi.fn((_precedence: (value: PendingQuestion) => number) => (
    value: PendingQuestion,
    delegate: () => Promise<void>,
  ) => {
    _precedence(value)
    pending.set(value, delegate)
    return () => { pending.delete(value) }
  })
  ctx.provide('uiSession', { registerPendingInteraction } as never)
  const registerNode = vi.fn((_definition: { kind: string }) => () => {})
  ctx.provide('uiConversation', { events: { register: registerNode } } as never)
  let listener: QuestionListener | undefined
  const on = vi.fn((event: string, value: QuestionListener) => {
    expect(event).toBe('user-questions/request')
    listener = value
    return () => { listener = undefined }
  })
  const remoteQuestions = {
    attachWait: vi.fn((_sessionId: SessionId, _callId: ToolCallId, signal: AbortSignal) => {
      const ended = Promise.withResolvers<IteratorResult<{ remainingMs: number }>>()
      const dispose = (): void => {
        signal.removeEventListener('abort', dispose)
        ended.resolve({ done: true, value: undefined })
      }
      signal.addEventListener('abort', dispose, { once: true })
      let first = true
      return {
        dispose, send: () => {}, end: () => {},
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (!first) return ended.promise
            first = false
            return Promise.resolve({ done: false as const, value: { remainingMs } })
          },
        }),
      }
    }),
    answer: vi.fn(async (
      _sessionId: SessionId, _callId: string, _answer: QuestionAnswer,
    ): Promise<RemoteBooleanResult> => ({ ok: true, value: true })),
  }
  ctx.provide('remote.userQuestions', remoteQuestions as never)
  ctx.provide('remote', { $on: on, userQuestions: remoteQuestions } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const invoke = (
    owner: Context,
    request: QuestionRequest,
    next: QuestionNext,
  ): Promise<QuestionAnswer> => {
    if (listener === undefined) throw new Error('question listener was not installed')
    return listener.call(owner, request, next)
  }
  return {
    ctx,
    slots,
    locale,
    agent,
    scopeOf,
    pending: { getSnapshot: () => [...pending.keys()] },
    /** The answer-panel provider this plugin fills for the tool call row. */
    panels: () => ctx.get('userQuestionPanels'),
    registerPendingInteraction,
    registerNode,
    on,
    fiber,
    list,
    binding,
    projection,
    inbox,
    remoteQuestions,
    invoke,
    async releasePending() {
      const delegates = [...pending.values()]
      pending.clear()
      await Promise.allSettled(delegates.map(delegate => delegate()))
    },
  }
}

const timed = (): QuestionRequest => ({
  questions: QUESTIONS,
  wait: { callId: CALL, timed: true },
})

describe('apply', () => {
  it('delegates an expired foreground wait and releases its claim stream', async () => {
    const b = await bench()
    const dispose = vi.fn()
    b.remoteQuestions.attachWait.mockImplementationOnce(() => ({
      dispose, send: () => {}, end: () => {},
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }))
    try {
      const next = vi.fn(async () => ANSWER)

      await expect(b.invoke(b.agent, timed(), next)).resolves.toBe(ANSWER)

      expect(next).toHaveBeenCalledOnce()
      expect(dispose).toHaveBeenCalledOnce()
      expect(b.remoteQuestions.attachWait.mock.calls[0]![2].aborted).toBe(true)
      expect(b.pending.getSnapshot()[0]?.snapshot()).toMatchObject({ channel: 'none', countdown: undefined })
      b.projection.set(view([]))
      expect(b.pending.getSnapshot()).toEqual([])
    } finally {
      await b.fiber.dispose()
    }
  })

  it('does not attach a cancelled claim after its first frame', async () => {
    const b = await bench(true, [CONTINUED])
    const controller = new AbortController()
    b.remoteQuestions.attachWait.mockImplementationOnce(() => ({
      dispose: vi.fn(), send: () => {}, end: () => {},
      [Symbol.asyncIterator]: () => ({
        next: () => {
          controller.abort()
          return Promise.resolve({ done: false as const, value: { remainingMs: 60_000 } })
        },
      }),
    }))
    try {
      await expect(b.invoke(b.agent, { ...timed(), signal: controller.signal }, async () => ANSWER))
        .rejects.toMatchObject({ code: 'ASK_ABORTED' })
      const card = b.pending.getSnapshot()[0]!
      expect(card.snapshot()).toMatchObject({ state: 'continued', channel: 'rpc' })
      await card.answer(ANSWER)
      expect(b.remoteQuestions.answer).toHaveBeenCalledOnce()
    } finally {
      await b.fiber.dispose()
    }
  })

  it('keeps a timed card during a Session update before the claim first frame', async () => {
    const b = await bench()
    const opening = Promise.withResolvers<IteratorResult<{ remainingMs: number }>>()
    const ended = Promise.withResolvers<IteratorResult<{ remainingMs: number }>>()
    b.remoteQuestions.attachWait.mockImplementationOnce(() => {
      let reads = 0
      return {
        dispose: () => { ended.resolve({ done: true, value: undefined }) },
        send: () => {}, end: () => {},
        [Symbol.asyncIterator]: () => ({ next: () => ++reads === 1 ? opening.promise : ended.promise }),
      }
    })
    try {
      const result = b.invoke(b.agent, timed(), async () => ANSWER)
      const card = b.pending.getSnapshot()[0]!
      b.list.set({ ...b.list.getSnapshot() })
      expect(b.pending.getSnapshot()).toContain(card)
      expect(card.snapshot().closed).toBe(false)

      opening.resolve({ done: false, value: { remainingMs: 60_000 } })
      await vi.waitFor(() => { expect(card.snapshot().channel).toBe('waterfall') })
      await card.answer(ANSWER)
      await expect(result).resolves.toEqual(ANSWER)
    } finally {
      opening.resolve({ done: true, value: undefined })
      await b.fiber.dispose()
    }
  })

  it('attaches an indefinite request before publishing control back to the caller', async () => {
    const b = await bench()
    try {
      const result = b.invoke(b.agent, { questions: QUESTIONS }, async () => ANSWER)
      expect(b.pending.getSnapshot()[0]?.snapshot().channel).toBe('waterfall')
      await b.pending.getSnapshot()[0]!.answer(ANSWER)
      await expect(result).resolves.toEqual(ANSWER)
    } finally {
      await b.fiber.dispose()
    }
  })

  it('keeps a claim until the Host accepts an answer submitted after Take time', async () => {
    const b = await bench()
    vi.useFakeTimers()
    const wait = new TimedQuestionWait(Date.now() + 5_000, undefined, new Error('unclaimed timeout'))
    const claimed = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const dispose = vi.fn(() => { released.resolve(undefined) })
    b.remoteQuestions.attachWait.mockImplementationOnce((_sessionId, _callId, signal) => {
      const iterator = wait.attach(signal)[Symbol.asyncIterator]()
      let reads = 0
      return {
        dispose, send: () => {}, end: () => {},
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const result = iterator.next()
            if (++reads === 2) claimed.resolve(undefined)
            return result
          },
        }),
      }
    })
    try {
      const result = b.invoke(b.agent, timed(), async () => ANSWER)
      await claimed.promise
      const pending = b.pending.getSnapshot()[0]!
      pending.takeTime()
      await vi.advanceTimersByTimeAsync(6_000)
      await pending.answer(ANSWER)
      await expect(result).resolves.toEqual(ANSWER)

      // The event carrier sends the answer only after its Client listener returns.
      // Keep delivery withheld while the original deadline is already past.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(wait.signal.aborted).toBe(false)
      expect(dispose).not.toHaveBeenCalled()

      wait.close(new Error('Host accepted the answer'))
      await released.promise
      expect(dispose).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      wait.close(new Error('test ended'))
      await b.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'remote', 'remote.userQuestions', 'uiSession', 'slots', 'locale', 'uiConversation'])
  })

  it('installs the Remote Event listener and delegates an unscoped request', async () => {
    const b = await bench(false)
    const next = vi.fn(async () => ANSWER)

    await expect(b.invoke(b.ctx, { questions: QUESTIONS }, next)).resolves.toBe(ANSWER)

    expect(b.on).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledOnce()
    expect(b.slots.entries('conversation.composer')).toHaveLength(0)
    expect(b.pending.getSnapshot()).toEqual([])
  })

  it('registers the late-reply conversation node with the conversation runtime', async () => {
    const b = await bench()

    expect(b.registerNode).toHaveBeenCalledOnce()
    expect(b.registerNode.mock.calls[0]![0]).toMatchObject({ kind: 'user-question-reply', target: 'chat' })
    expect(b.slots.entries('conversation.chat.node').map(entry => entry.options.key)).toEqual(['question-reply'])
  })

  it('follows only bound Sessions and drops a projection subscription with its Session', async () => {
    const b = await bench(true, 'absent')
    const other = 'session-unbound' as SessionId
    expect(b.pending.getSnapshot()).toEqual([])

    b.list.set({ ...b.list.getSnapshot(), ids: [SESSION_ID, other], byId: { [SESSION_ID]: { id: SESSION_ID }, [other]: { id: other } } })
    expect(b.binding).toHaveBeenCalledWith(other)
    b.projection.set(view([CONTINUED]))
    expect(b.pending.getSnapshot().map(card => card.key)).toEqual([`question:${SESSION_ID}:${CALL}`])

    // Unbinding the Session removes its cards and stops following its projection.
    b.list.set({ ...b.list.getSnapshot(), ids: [other], byId: { [other]: { id: other } } })
    expect(b.pending.getSnapshot()).toEqual([])
    b.projection.set(view([{ ...CONTINUED, callId: ToolCallId('call-after-unbind') }]))
    expect(b.pending.getSnapshot()).toEqual([])
  })

  it('projects a scoped request through one stable composer and returns its answer', async () => {
    const b = await bench()
    const next = vi.fn(async () => ANSWER)
    const result = b.invoke(b.agent, { questions: QUESTIONS }, next)
    await Promise.resolve()

    const entry = b.slots.entries('conversation.composer')[0]!
    expect(entry.component).toBe(QuestionComposer)
    expect(entry.locale).toBe('question')
    const store = entry.store as ReturnType<typeof createQuestionDraftStore>
    expect(store.create(SESSION_ID).getSnapshot()).toEqual({ progressByRequest: {} })
    const pending = b.pending.getSnapshot()[0]!
    const face = (entry.inject as () => { keyedHooks: { questionCard: (key: string) => PendingQuestion | undefined } })()
    expect(face.keyedHooks.questionCard(pending.key)).toBe(pending)
    expect(face.keyedHooks.questionCard('question:missing')).toBeUndefined()
    const select = entry.select as (
      owner: { pendingInteraction: PendingQuestion | undefined },
    ) => PendingQuestion | null
    expect(select({ pendingInteraction: undefined })).toBeNull()
    expect(select({ pendingInteraction: pending })).toBe(pending)
    expect(pending).toMatchObject({ kind: 'question', sessionId: SESSION_ID, questions: QUESTIONS, callId: undefined })
    expect(pending.snapshot()).toEqual({
      state: 'open', waitState: 'counting', countdown: undefined,
      channel: 'waterfall', closed: false,
    })

    await pending.answer(ANSWER)
    await expect(result).resolves.toBe(ANSWER)
    expect(next).not.toHaveBeenCalled()
    expect(b.pending.getSnapshot()).toEqual([])
    expect(b.slots.entries('conversation.composer')).toHaveLength(1)
  })

  it('a request the Host never named ends with ASK_CANCELLED when the user closes its panel', async () => {
    const b = await bench()
    const result = b.invoke(b.agent, { questions: QUESTIONS }, async () => ANSWER)
    await Promise.resolve()
    const pending = b.pending.getSnapshot()[0]!
    expect(pending.dismissal).toBe('cancel')
    const rejection = expect(result).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
      message: 'the user cancelled ask_user_question',
    })

    await pending.dismiss()
    await rejection
    expect(b.pending.getSnapshot()).toEqual([])
  })

  it('removes an aborted blocking request while preserving the stable composer', async () => {
    const b = await bench()
    const controller = new AbortController()
    const result = b.invoke(b.agent, { questions: QUESTIONS, signal: controller.signal }, async () => ANSWER)
    await Promise.resolve()
    expect(b.pending.getSnapshot()).toHaveLength(1)

    controller.abort()

    await expect(result).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(b.pending.getSnapshot()).toEqual([])
    expect(b.slots.entries('conversation.composer')).toHaveLength(1)
  })

  it('delegates an active request when its interaction domain unloads, and settles the release only once the listener has handed it on', async () => {
    const b = await bench()
    const handedOn = Promise.withResolvers<typeof ANSWER>()
    const next = vi.fn(() => handedOn.promise)
    const result = b.invoke(b.agent, { questions: QUESTIONS }, next)
    await Promise.resolve()
    expect(b.pending.getSnapshot()).toHaveLength(1)

    let released = false
    const release = b.releasePending().then(() => { released = true })
    await Promise.resolve()
    await Promise.resolve()
    // The registry's release awaits the listener's `next()`, exactly as the
    // blocking question always did, so a plugin teardown never resolves ahead
    // of the request it is handing back.
    expect(next).toHaveBeenCalledOnce()
    expect(released).toBe(false)

    handedOn.resolve(ANSWER)
    await release

    expect(released).toBe(true)
    await expect(result).resolves.toBe(ANSWER)
    expect(b.pending.getSnapshot()).toEqual([])
  })

  it('keys a timed request by Session and call and settles it with ASK_TIMED_OUT at the local deadline', async () => {
    const b = await bench()
    const result = b.invoke(b.agent, timed(), async () => ANSWER)
    await Promise.resolve()
    const pending = b.pending.getSnapshot()[0]!
    expect(pending.key).toBe(`question:${SESSION_ID}:${CALL}`)
    expect(pending.dismissal).toBe('hide')
    expect(pending.snapshot()).toMatchObject({
      state: 'open', waitState: 'counting', channel: 'waterfall', closed: false,
    })
    // The card owns the countdown, so it reads the deadline down from now.
    expect(pending.snapshot().countdown).toEqual({ remainingMs: expect.any(Number) as number, running: true })
    expect(pending.snapshot().countdown!.remainingMs).toBeGreaterThan(55_000)
    const rejection = expect(result).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_TIMED_OUT' })

    pending.timeout()

    await rejection
    expect(b.pending.getSnapshot()).toEqual([pending])
    expect(pending.snapshot()).toEqual({
      state: 'open', waitState: 'counting', countdown: undefined,
      channel: 'none', closed: false,
    })
    await expect(pending.answer(ANSWER)).rejects.toThrow(/no channel/)
  })

  it('anchors a Host-measured remaining wait to the Client clock', async () => {
    const b = await bench(true, [], 2_000)
    const request = timed()
    const result = b.invoke(b.agent, request, async () => ANSWER)
    await Promise.resolve()
    const pending = b.pending.getSnapshot()[0]!
    expect(pending.snapshot().countdown!.remainingMs).toBeLessThanOrEqual(2_000)
    expect(pending.snapshot().countdown!.remainingMs).toBeGreaterThan(1_000)
    pending.timeout()
    await expect(result).rejects.toMatchObject({ code: 'ASK_TIMED_OUT' })
  })

  it('a card-keyed request without a deadline waits with no countdown', async () => {
    const b = await bench()
    // Nothing settles an indefinite wait, so the request stays pending past this test.
    void b.invoke(b.agent, { questions: QUESTIONS, wait: { callId: CALL } }, async () => ANSWER)
    await Promise.resolve()

    const pending = b.pending.getSnapshot()[0]!
    expect(pending.key).toBe(`question:${SESSION_ID}:${CALL}`)
    expect(pending.dismissal).toBe('hide')
    expect(pending.snapshot()).toEqual({
      state: 'open', waitState: 'counting', countdown: undefined,
      channel: 'waterfall', closed: false,
    })
  })

  it('closing a card-keyed panel only leaves the seat, and the panel provider brings it back', async () => {
    const b = await bench()
    const next = vi.fn(async () => ANSWER)
    const result = b.invoke(b.agent, timed(), next)
    await Promise.resolve()
    const pending = b.pending.getSnapshot()[0]!

    await pending.dismiss()

    // Nothing settled: the tool call still waits, and its countdown still runs.
    expect(b.pending.getSnapshot()).toEqual([])
    expect(next).not.toHaveBeenCalled()
    expect(pending.snapshot()).toMatchObject({ channel: 'waterfall', closed: false })

    expect(b.panels()?.reveal(SESSION_ID, CALL)).toBe(true)
    expect(b.pending.getSnapshot()).toEqual([pending])

    await pending.answer(ANSWER)
    await expect(result).resolves.toBe(ANSWER)
  })

  it('reveals nothing for a call this Client holds no card for', async () => {
    const b = await bench()
    expect(b.panels()?.reveal(SESSION_ID, 'call-unknown')).toBe(false)
    expect(b.pending.getSnapshot()).toEqual([])
  })

  it('builds a read-only card from a settled call record and drops it when closed', async () => {
    const b = await bench()

    expect(b.panels()?.review(SESSION_ID, CALL, RECORD)).toBe(true)
    const card = b.pending.getSnapshot()[0]!
    expect(card.key).toBe(`question:${SESSION_ID}:${CALL}`)
    expect(card.review).toEqual(RECORD.answers)
    expect(card.liveKeys()).toEqual([card.key])
    // No channel and no countdown: the call settled, so nothing is answerable.
    expect(card.snapshot()).toEqual({
      state: 'open', waitState: 'counting', countdown: undefined,
      channel: 'none', closed: false,
    })
    await expect(card.answer(ANSWER)).rejects.toThrow(/no channel accepts an answer yet/)

    // The projection never lists a settled call; the sweep must leave it alone.
    b.projection.set(view([]))
    expect(b.pending.getSnapshot()).toEqual([card])

    await card.dismiss()
    expect(b.pending.getSnapshot()).toEqual([])
    expect(card.snapshot().closed).toBe(true)

    // The row builds another card from the same record.
    expect(b.panels()?.review(SESSION_ID, CALL, RECORD)).toBe(true)
    expect(b.pending.getSnapshot()[0]).not.toBe(card)
  })

  it('a review of a call that still holds a live card shows the live one', async () => {
    const b = await bench()
    const result = b.invoke(b.agent, timed(), async () => ANSWER)
    await Promise.resolve()
    const card = b.pending.getSnapshot()[0]!

    expect(b.panels()?.review(SESSION_ID, CALL, RECORD)).toBe(true)

    expect(b.pending.getSnapshot()).toEqual([card])
    expect(card.review).toBeUndefined()
    expect(card.snapshot().channel).toBe('waterfall')
    await card.answer(ANSWER)
    await expect(result).resolves.toBe(ANSWER)
  })

  it('withdraws the panel provider with the plugin lifetime', async () => {
    const b = await bench()
    expect(b.panels()).toBeDefined()

    await b.fiber.dispose()

    expect(b.panels()).toBeUndefined()
  })

  it('keeps a timed card through a cancelled delivery until the projection closes it', async () => {
    const b = await bench()
    const controller = new AbortController()
    const result = b.invoke(b.agent, { ...timed(), signal: controller.signal }, async () => ANSWER)
    await Promise.resolve()
    const pending = b.pending.getSnapshot()[0]!

    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(b.pending.getSnapshot()).toEqual([pending])
    expect(pending.snapshot().channel).toBe('none')

    b.projection.set(view([CONTINUED]))
    expect(b.pending.getSnapshot()).toEqual([pending])
    expect(pending.snapshot()).toMatchObject({ state: 'continued', channel: 'rpc' })

    b.projection.set(view([]))
    expect(b.pending.getSnapshot()).toEqual([])
    expect(pending.snapshot().closed).toBe(true)
  })

  it('creates a continued card from the projection and answers it through the Remote path', async () => {
    const b = await bench()

    b.projection.set(view([CONTINUED, { callId: ToolCallId('call-other'), questions: [...QUESTIONS], state: 'continued' }]))
    const cards = b.pending.getSnapshot()
    expect(cards.map(card => card.key)).toEqual([
      `question:${SESSION_ID}:${CALL}`, `question:${SESSION_ID}:call-other`,
    ])
    const card = cards[0]!
    expect(card.snapshot()).toMatchObject({ state: 'continued', channel: 'rpc' })
    expect(card.liveKeys()).toEqual(cards.map(item => item.key))

    await card.answer(ANSWER)
    expect(b.remoteQuestions.answer).toHaveBeenCalledWith(SESSION_ID, CALL, ANSWER)

    b.remoteQuestions.answer.mockResolvedValueOnce({ ok: true, value: false })
    await expect(card.answer(ANSWER)).rejects.toThrow(/no longer answerable/)
    b.remoteQuestions.answer.mockResolvedValueOnce({ ok: false, error: { message: 'offline' } })
    await expect(card.answer(ANSWER)).rejects.toThrow('offline')
  })

  it('queues an older answer while a later question is waiting', async () => {
    const currentCall = ToolCallId('call-current')
    const b = await bench(true, [CONTINUED, { ...CONTINUED, callId: currentCall, state: 'open' }])
    const current = b.invoke(b.agent, { ...timed(), wait: { callId: currentCall, timed: true } }, async () => ANSWER)
    await vi.waitFor(() => {
      expect(b.pending.getSnapshot().find(card => card.callId === currentCall)?.snapshot().channel).toBe('waterfall')
    })

    const currentCard = b.pending.getSnapshot().find(card => card.callId === currentCall)!
    const earlier = b.pending.getSnapshot().find(card => card.callId === CALL)!
    expect(earlier.snapshot()).toMatchObject({ state: 'continued', channel: 'rpc' })
    await earlier.answer(ANSWER)
    expect(b.remoteQuestions.answer).toHaveBeenCalledWith(SESSION_ID, CALL, ANSWER)
    expect(currentCard.snapshot().channel).toBe('waterfall')

    currentCard.timeout()
    await expect(current).rejects.toMatchObject({ code: 'ASK_TIMED_OUT' })
  })

  it('does not reopen a queued older answer after a browser reconnect', async () => {
    const currentCall = ToolCallId('call-current')
    const active = [CONTINUED, { ...CONTINUED, callId: currentCall, state: 'open' as const }]
    const b = await bench(true, active)
    try {
      const current = b.invoke(b.agent, { ...timed(), wait: { callId: currentCall, timed: true } }, async () => ANSWER)
      await vi.waitFor(() => {
        expect(b.pending.getSnapshot().find(card => card.callId === currentCall)?.snapshot().channel).toBe('waterfall')
      })
      const oldCard = b.pending.getSnapshot()[0]!
      b.inbox.set(queuedInbox(CALL))

      expect(oldCard.snapshot().closed).toBe(true)
      expect(b.pending.getSnapshot().map(card => card.callId)).toEqual([currentCall])
      expect(b.panels()?.reveal(SESSION_ID, CALL)).toBe(false)

      b.inbox.set(emptyInbox())
      expect(b.pending.getSnapshot().find(card => card.callId === CALL)?.snapshot())
        .toMatchObject({ state: 'continued', channel: 'rpc' })
      b.pending.getSnapshot().find(card => card.callId === currentCall)?.timeout()
      await expect(current).rejects.toMatchObject({ code: 'ASK_TIMED_OUT' })
    } finally {
      await b.fiber.dispose()
    }

    const reconnected = await bench(true, active, 60_000, queuedInbox(CALL))
    try {
      expect(reconnected.pending.getSnapshot()).toEqual([])
      expect(reconnected.panels()?.reveal(SESSION_ID, CALL)).toBe(false)
    } finally {
      await reconnected.fiber.dispose()
    }
  })

  it('ignores unrelated inbox entries and recognizes a next-turn reply', async () => {
    const otherCall = ToolCallId('call-other')
    const b = await bench(true, [CONTINUED, { ...CONTINUED, callId: otherCall }])
    try {
      b.inbox.set(undefined)
      expect(b.pending.getSnapshot().map(card => card.callId)).toEqual([CALL, otherCall])

      b.inbox.set({
        'next-step': [null, { source: null }, { source: { kind: 'other', callId: CALL } },
          { source: { kind: 'user-question-reply', callId: 42 } }],
        'next-turn': [{ source: { kind: 'user-question-reply', callId: otherCall } }],
      })
      expect(b.pending.getSnapshot().map(card => card.callId)).toEqual([CALL])
      expect(b.panels()?.reveal(SESSION_ID, otherCall)).toBe(false)
    } finally {
      await b.fiber.dispose()
    }
  })

  it('publishes a plan-review request ahead of plain questions', async () => {
    const b = await bench()
    const result = b.invoke(b.agent, { questions: PLAN_QUESTIONS }, async () => ANSWER)
    await Promise.resolve()

    const pending = b.pending.getSnapshot()[0]!
    expect(pending.kind).toBe('plan-review')
    const precedence = b.registerPendingInteraction.mock.calls[0]![0]
    expect(precedence(pending)).toBe(2)
    expect(precedence(new PendingQuestion(SESSION_ID, QUESTIONS))).toBe(1)

    await pending.answer(ANSWER)
    await expect(result).resolves.toBe(ANSWER)
  })

  it('closing a continued panel keeps the question answerable from its tool call', async () => {
    const b = await bench()
    b.projection.set(view([CONTINUED]))
    const card = b.pending.getSnapshot()[0]!

    await card.dismiss()

    // No Remote call and no projection change: the dismissal is Client-local.
    expect(b.remoteQuestions.answer).not.toHaveBeenCalled()
    expect(b.pending.getSnapshot()).toEqual([])
    expect(card.snapshot()).toMatchObject({ state: 'continued', channel: 'rpc', closed: false })

    expect(b.panels()?.reveal(SESSION_ID, CALL)).toBe(true)
    expect(b.pending.getSnapshot()).toEqual([card])
  })

  it('ignores open rows and lets a re-delivered request attach to a projection-created card', async () => {
    const b = await bench(true, [{ ...CONTINUED, state: 'open' }])
    expect(b.pending.getSnapshot()).toEqual([])

    b.projection.set(view([CONTINUED]))
    const card = b.pending.getSnapshot()[0]!
    const result = b.invoke(b.agent, timed(), async () => ANSWER)
    await Promise.resolve()

    expect(b.pending.getSnapshot()).toEqual([card])
    expect(card.snapshot()).toMatchObject({ state: 'continued', channel: 'waterfall' })
    await card.answer(ANSWER)
    await expect(result).resolves.toBe(ANSWER)
    expect(b.remoteQuestions.answer).not.toHaveBeenCalled()
    expect(b.pending.getSnapshot()).toEqual([card])

    b.projection.set(view([]))
    expect(b.pending.getSnapshot()).toEqual([])
  })

  it('stops following the projection with the plugin lifetime', async () => {
    const b = await bench(true, [CONTINUED])
    const card = b.pending.getSnapshot()[0]!
    expect(b.slots.entries('conversation.composer')).toHaveLength(1)

    await b.fiber.dispose()

    // Teardown drops every card, hidden ones included: a hidden card is not in
    // the pending-interaction registry, so nothing else would end its request.
    expect(b.slots.entries('conversation.composer')).toHaveLength(0)
    expect(b.pending.getSnapshot()).toEqual([])
    expect(card.snapshot().closed).toBe(true)

    b.projection.set(view([CONTINUED, { callId: ToolCallId('call-after-dispose'), questions: [...QUESTIONS], state: 'continued' }]))
    expect(b.pending.getSnapshot()).toEqual([])
  })
})
