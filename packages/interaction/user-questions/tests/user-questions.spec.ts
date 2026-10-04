import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import UserQuestionService, {
  TIMED_WAIT_PARAMETER,
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { createToolResultMessage, createUserMessage, ToolCallId, type ToolSchema, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

interface QuestionAnswerer {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

function registerAnswerer(ctx: Context, answerer: QuestionAnswerer): () => void {
  return ctx.on('user-questions/request', request => answerer.ask(request))
}

function provider(answer = 'approved'): QuestionAnswerer & { seen: AskUserQuestionRequest[] } {
  const seen: AskUserQuestionRequest[] = []
  return {
    seen,
    async ask(request) {
      seen.push(request)
      return {
        answers: request.questions.map(question => ({ id: question.id, selected: [answer] })),
      }
    },
  }
}

function stubAgent(id: string, delegationDepth = 0): Agent {
  const agentId = id as Agent['id']
  return {
    id: agentId,
    session: { id: agentId, header: { delegationDepth } },
  } as unknown as Agent
}

describe('UserQuestionService', () => {
  it('delegates ask requests to the registered provider', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider('yes')
    registerAnswerer(ctx, p)
    const questions = [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'yes' }] }]

    const result = await ctx.userQuestions.ask({ questions })

    expect(result).toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
    expect(p.seen).toEqual([{ questions }])
  })

  it('rejects ask requests when no provider is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_PROVIDER' })
  })

  it('registers providers with HMR-safe disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider()
    const dispose = registerAnswerer(ctx, p)

    dispose()
    dispose()

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('delegates through composed answerers', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const delegated = vi.fn()
    ctx.on('user-questions/request', (_request, next) => {
      delegated()
      return next()
    })
    const p = provider('second')
    registerAnswerer(ctx, p)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'second' }] }],
    })).resolves.toEqual({ answers: [{ id: 'confirm', selected: ['second'] }] })
    expect(delegated).toHaveBeenCalledOnce()
  })

  it('fails before reaching the provider when the signal is already aborted', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [{ id: 'confirm', selected: ['too late'] }] })) }
    registerAnswerer(ctx, p)
    const controller = new AbortController()
    controller.abort()

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }], signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('normalizes an in-flight signal cancellation to ASK_ABORTED', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const pending = Promise.withResolvers<never>()
    registerAnswerer(ctx, { ask: () => pending.promise })
    const controller = new AbortController()
    const abortReason = new DOMException('This operation was aborted', 'AbortError')

    const answer = ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      signal: controller.signal,
    })
    controller.abort(abortReason)
    pending.reject(abortReason)

    await expect(answer).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'ASK_ABORTED',
      cause: abortReason,
    })
  })

  it('preserves a domain rejection when its provider also aborts the signal', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const controller = new AbortController()
    const cancelled = new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')
    registerAnswerer(ctx, {
      ask: () => {
        controller.abort()
        return Promise.reject(cancelled)
      },
    })

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      signal: controller.signal,
    })).rejects.toBe(cancelled)
  })

  it('restores a transported provider rejection to UserQuestionError', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const transported = Object.assign(new Error('the user cancelled ask_user_question'), {
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
    })
    registerAnswerer(ctx, { ask: () => Promise.reject(transported) })

    const rejection = await ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(rejection).toBeInstanceOf(UserQuestionError)
    expect(rejection).toMatchObject({
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
      cause: transported,
    })
  })

  it.each([
    ['an ordinary Error', new Error('provider failed')],
    ['a namesake Error without a string code', Object.assign(new Error('provider failed'), {
      name: 'UserQuestionError',
    })],
    ['a non-Error rejection', { name: 'UserQuestionError', code: 'ASK_CANCELLED' }],
  ])('preserves %s from the provider', async (_label, rejection) => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    registerAnswerer(ctx, { ask: vi.fn().mockRejectedValue(rejection) })

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    })).rejects.toBe(rejection)
  })

  it('rejects empty question batches before reaching the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)

    await expect(ctx.userQuestions.ask({ questions: [] }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'EMPTY_QUESTIONS' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a live runtime-owned agent before reaching the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)
    const root = stubAgent('root', 0)
    const child = stubAgent('child', 0)
    ctx.agents.enter(root, undefined)
    ctx.agents.enter(child, root)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: child,
    })).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'DELEGATED_CALLER',
      message: "human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result",
    })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('reaches the provider for a lineage-bearing session resumed as a runtime root', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = provider('yes')
    registerAnswerer(ctx, p)
    const agent = stubAgent('resumed-root', 1)
    ctx.agents.enter(agent, undefined)

    const result = await ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'yes' }] }],
      agent,
    })

    expect(result).toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
  })

  it('rejects a supplied agent when no live registry can attest it', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: stubAgent('unattested'),
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'CALLER_NOT_LIVE' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a stale agent object that reuses a live id', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)
    const live = stubAgent('same-id')
    ctx.agents.enter(live, undefined)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: stubAgent('same-id'),
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'CALLER_NOT_LIVE' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('restores a transported UserQuestionError to the public error class', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const transported = Object.assign(new Error('the user cancelled ask_user_question'), {
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
    })
    registerAnswerer(ctx, { ask: () => Promise.reject(transported) })

    const failure = await ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(UserQuestionError)
    expect(failure).toMatchObject({
      name: 'UserQuestionError', code: 'ASK_CANCELLED', cause: transported,
    })
  })

  it('preserves a provider rejection outside the UserQuestionError taxonomy', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const failure = new Error('provider failed')
    registerAnswerer(ctx, { ask: () => Promise.reject(failure) })

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    })).rejects.toBe(failure)
  })

  it('rejects an intent whose approve label names none of its own options', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)
    const question = { id: 'plan-review', question: 'Approve?', detail: '# Plan' }

    // A wrong label among offered options, and no options offered at all.
    for (const options of [[{ label: 'Approve' }], undefined]) {
      await expect(ctx.userQuestions.ask({
        questions: [{
          ...question,
          ...(options === undefined ? {} : { options }),
          intent: { kind: 'plan-review', approve: 'Ship it' },
        }],
      })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'BAD_INTENT' })
    }
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a plan-review intent on a question carrying no plan to review', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)

    // Detail IS the plan for this intent, so a UI honouring it would ask the
    // user to approve something they cannot see.
    await expect(ctx.userQuestions.ask({
      questions: [{
        id: 'plan-review', question: 'Approve?',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'BAD_INTENT' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('passes an intent through once its approve label names an offered option', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider('Approve')
    registerAnswerer(ctx, p)
    const intent = { kind: 'plan-review', approve: 'Approve' } as const

    const result = await ctx.userQuestions.ask({
      questions: [
        { id: 'plain', question: 'Proceed?', options: [{ label: 'Approve' }] },
        {
          id: 'plan-review', question: 'Approve?', detail: '# Plan',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent,
        },
      ],
    })

    expect(result.answers).toEqual([
      { id: 'plain', selected: ['Approve'] },
      { id: 'plan-review', selected: ['Approve'] },
    ])
    expect(p.seen[0]?.questions[1]?.intent).toEqual(intent)
  })
})

/** Rejection as the Client runtime ships it across the wire: a plain Error carrying the typed name and code. */
function wireRejection(code: string): Error {
  const error = new Error(`client rejected with ${code}`) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

interface LiveAgent extends Agent {
  steer: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
  inject: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
  queuedTurns: UserMessage[]
  queuedMessages: UserMessage[]
}

function liveAgent(id: string): LiveAgent {
  const queuedTurns: UserMessage[] = []
  const queuedMessages: UserMessage[] = []
  const steer = vi.fn<(message: UserMessage) => void>((message) => { queuedMessages.push(message) })
  const inject = vi.fn<(message: UserMessage) => void>()
  return Object.assign(stubAgent(id), {
    session: Session.create(SessionId(id)),
    inbox: { nextTurn: queuedTurns, nextStep: queuedMessages },
    steer,
    inject,
    queuedTurns,
    queuedMessages,
  })
}

async function timedContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(UserQuestionService)
  return ctx
}

const timedQuestions = [{ id: 'scope', question: 'Which scope?', options: [{ label: 'Tool only' }] }]
const timedCallId = ToolCallId('ask-timed')

function replyText(message: UserMessage): unknown {
  const block = message.content[0]
  if (block === undefined || block.type !== 'text') throw new Error('expected a text reply')
  return JSON.parse(block.text)
}

describe('askTimed', () => {
  it('keeps sibling waits independent and cancels the remaining wait when the service unloads', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const ctx = await timedContext()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const agent = liveAgent('timed-sibling-waits')
    ctx.agents.enter(agent, undefined)
    const service = ctx.userQuestions
    const laterCallId = ToolCallId('ask-later')
    const first = service.askTimed({ agent, questions: timedQuestions }, timedCallId, 1_000)
    const later = service.askTimed({ agent, questions: timedQuestions }, laterCallId, 2_000)
    const cancelled = expect(later).rejects.toMatchObject({ code: 'ASK_ABORTED' })

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(first).resolves.toEqual({ pending: true, callId: timedCallId })
    const claim = service.attachWait(agent, laterCallId, new AbortController().signal)[Symbol.asyncIterator]()
    expect(await claim.next()).toEqual({ done: false, value: { remainingMs: 1_000 } })
    const end = claim.next()

    await ctx.fiber.dispose()

    await cancelled
    expect(await end).toEqual({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires a forwarded request even when no Client ever responds or delegates', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const ctx = await timedContext()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const agent = liveAgent('timed-no-client')
    ctx.agents.enter(agent, undefined)
    const turn = new AbortController()
    let forwardedSignal: AbortSignal | undefined
    registerAnswerer(ctx, {
      ask: request => new Promise((_resolve, reject) => {
        forwardedSignal = request.signal
        request.signal?.addEventListener('abort', () => {
          reject(new Error('forwarded request aborted', { cause: request.signal?.reason }))
        }, { once: true })
      }),
    })
    const result = ctx.userQuestions.askTimed(
      { agent, questions: timedQuestions, signal: turn.signal }, timedCallId, 5_000,
    )
    expect(forwardedSignal).not.toBe(turn.signal)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(result).resolves.toEqual({ pending: true, callId: timedCallId })
    expect(forwardedSignal?.aborted).toBe(true)
    expect(turn.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a Client-claimed wait open and closes its stream when the answer settles', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const ctx = await timedContext()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const agent = liveAgent('timed-claimed')
    ctx.agents.enter(agent, undefined)
    const answer = Promise.withResolvers<AskUserQuestionAnswer>()
    registerAnswerer(ctx, { ask: () => answer.promise })
    let settled = false
    const result = ctx.userQuestions.askTimed({ agent, questions: timedQuestions }, timedCallId, 5_000)
      .finally(() => { settled = true })
    const stream = ctx.userQuestions.attachWait(agent, timedCallId, new AbortController().signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toEqual({ done: false, value: { remainingMs: 5_000 } })
    const end = stream.next()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false)
    await expect(ctx.userQuestions.askTimed({ agent, questions: timedQuestions }, timedCallId, 5_000))
      .rejects.toMatchObject({ code: 'DUPLICATE_WAIT' })
    const batch = { answers: [{ id: 'scope', selected: ['Tool only'] }] }
    answer.resolve(batch)
    await expect(result).resolves.toEqual(batch)
    expect(await end).toEqual({ done: true, value: undefined })
    expect(await ctx.userQuestions.attachWait(agent, timedCallId, new AbortController().signal)
      [Symbol.asyncIterator]().next()).toMatchObject({ done: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns the answer when a Client settles the request inside the window', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('timed-answered')
    ctx.agents.enter(agent, undefined)
    const seen: AskUserQuestionRequest[] = []
    registerAnswerer(ctx, {
      ask: async (request) => { seen.push(request); return { answers: [{ id: 'scope', selected: ['Tool only'] }] } },
    })
    const result = await ctx.userQuestions.askTimed({ agent, questions: timedQuestions }, timedCallId, 120_000)

    expect(result).toEqual({ answers: [{ id: 'scope', selected: ['Tool only'] }] })
    expect(seen[0]?.wait?.callId).toBe(timedCallId)
    expect(seen[0]?.wait?.timed).toBe(true)
    await ctx.fiber.dispose()
  })

  it('maps the Client deadline rejection to the pending result and rethrows any other code', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('timed-expired')
    ctx.agents.enter(agent, undefined)
    let code = 'ASK_TIMED_OUT'
    registerAnswerer(ctx, { ask: () => Promise.reject(wireRejection(code)) })

    await expect(ctx.userQuestions.askTimed({ agent, questions: timedQuestions }, timedCallId, 120_000))
      .resolves.toEqual({ pending: true, callId: timedCallId })
    code = 'ASK_CANCELLED'
    await expect(ctx.userQuestions.askTimed({ agent, questions: timedQuestions }, timedCallId, 120_000))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
    await ctx.fiber.dispose()
  })

  it('holds an unclaimed request until the deadline and then returns pending', async () => {
    vi.useFakeTimers()
    try {
      const ctx = await timedContext()
      const agent = liveAgent('timed-unclaimed')
      ctx.agents.enter(agent, undefined)
      let settled = false
      const result = ctx.userQuestions.askTimed({ agent, questions: timedQuestions }, timedCallId, 5_000)
        .finally(() => { settled = true })

      await vi.advanceTimersByTimeAsync(4_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(result).resolves.toEqual({ pending: true, callId: timedCallId })
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts the hold with the turn signal', async () => {
    vi.useFakeTimers()
    try {
      const ctx = await timedContext()
      const agent = liveAgent('timed-aborted-hold')
      ctx.agents.enter(agent, undefined)
      const controller = new AbortController()
      const result = ctx.userQuestions.askTimed(
        { agent, questions: timedQuestions, signal: controller.signal }, timedCallId, 5_000,
      )
      const rejection = expect(result).rejects.toMatchObject({ code: 'ASK_ABORTED' })

      await vi.advanceTimersByTimeAsync(1_000)
      controller.abort()

      await rejection
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rethrows a provider failure that is not a question error', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('timed-provider-crash')
    ctx.agents.enter(agent, undefined)
    registerAnswerer(ctx, { ask: () => Promise.reject(new TypeError('provider crashed')) })

    await expect(ctx.userQuestions.askTimed({ agent, questions: timedQuestions }, timedCallId, 120_000))
      .rejects.toThrow(TypeError)
    await ctx.fiber.dispose()
  })

  it('does not start the unclaimed hold when the turn ended while the request went unclaimed', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('timed-preaborted-hold')
    ctx.agents.enter(agent, undefined)
    const controller = new AbortController()
    registerAnswerer(ctx, {
      ask: () => {
        controller.abort(new Error('turn ended'))
        return Promise.reject(wireRejection('NO_PROVIDER'))
      },
    })

    await expect(ctx.userQuestions.askTimed(
      { agent, questions: timedQuestions, signal: controller.signal }, timedCallId, 5_000,
    )).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    await ctx.fiber.dispose()
  })

  it('rejects non-positive waits before dispatching', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('timed-invalid')
    ctx.agents.enter(agent, undefined)
    const ask = vi.fn(async () => ({ answers: [] }))
    registerAnswerer(ctx, { ask })

    await expect(ctx.userQuestions.askTimed({ agent, questions: timedQuestions }, timedCallId, 0))
      .rejects.toMatchObject({ code: 'BAD_TIMEOUT' })
    expect(ask).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

describe('late replies', () => {
  /** The timed tool's schema as the request header records it: the wait parameter is what marks the calls that follow as timed. */
  const timedToolSchema: ToolSchema = {
    name: 'ask_user_question',
    description: 'Ask brief questions.',
    parameters: { type: 'object', properties: { questions: { type: 'array' }, [TIMED_WAIT_PARAMETER]: { type: 'integer' } } },
  }

  function askInLog(agent: Agent, callId: ToolCallId, tools: ToolSchema[] = [timedToolSchema]): void {
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('request/header', {
      header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, tools },
      reason: 'initial',
    })
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId, name: 'ask_user_question',
      arguments: JSON.stringify({ questions: timedQuestions }),
    })
  }

  function continueInLog(agent: Agent, callId: ToolCallId): void {
    agent.session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId }) }], isError: false,
      }),
    }, { surfaceOp: 'append' })
  }

  it('steers an answer into a continued question and closes it once the reply is admitted', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('late-answer')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)
    continueInLog(agent, timedCallId)
    const batch = { answers: [{ id: 'scope', selected: ['Tool only'] }] }

    expect(ctx.userQuestions.answer(agent, timedCallId, batch)).toBe(true)

    expect(agent.steer).toHaveBeenCalledOnce()
    const steered = agent.steer.mock.calls[0]![0]
    expect(steered.source).toEqual({ kind: 'user-question-reply', callId: timedCallId, outcome: 'answered' })
    expect(replyText(steered)).toEqual({
      kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: timedCallId,
      questions: timedQuestions, answers: batch.answers,
    })
    agent.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [steered] })
    agent.session.append('user/message', steered, { surfaceOp: 'append' })
    expect(ctx.userQuestions.answer(agent, timedCallId, batch)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('accepts steers for different continued batches while both await the next step', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('late-out-of-order')
    const secondCallId = ToolCallId('another-timed-batch')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)
    continueInLog(agent, timedCallId)
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: secondCallId, name: 'ask_user_question',
      arguments: JSON.stringify({ questions: timedQuestions }),
    })
    continueInLog(agent, secondCallId)
    const batch = { answers: [{ id: 'scope', selected: ['Tool only'] }] }

    expect(ctx.userQuestions.answer(agent, secondCallId, batch)).toBe(true)
    expect(ctx.userQuestions.answer(agent, timedCallId, batch)).toBe(true)
    expect(agent.queuedMessages.map(message => message.source)).toEqual([
      { kind: 'user-question-reply', callId: secondCallId, outcome: 'answered' },
      { kind: 'user-question-reply', callId: timedCallId, outcome: 'answered' },
    ])
    expect(agent.queuedTurns).toEqual([])
    await ctx.fiber.dispose()
  })

  it('accepts one queued reply and permits retry when it is discarded', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('late-duplicate')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)
    continueInLog(agent, timedCallId)
    const batch = { answers: [{ id: 'scope', selected: ['Tool only'] }] }

    expect(ctx.userQuestions.answer(agent, timedCallId, batch)).toBe(true)
    expect(() => ctx.userQuestions.answer(agent, timedCallId, batch))
      .toThrow(expect.objectContaining({ code: 'REPLY_QUEUED' }))
    expect(agent.steer).toHaveBeenCalledTimes(1)

    const first = agent.steer.mock.calls[0]![0]
    agent.queuedMessages.shift()
    agentEvents(ctx, agent).emit('agent/inbox/discarded', { message: first })
    expect(ctx.userQuestions.answer(agent, timedCallId, batch)).toBe(true)
    expect(agent.steer).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('refuses a reply already present in the durable inbox', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('late-inbox')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)
    continueInLog(agent, timedCallId)
    const batch = { answers: [{ id: 'scope', selected: ['Tool only'] }] }
    const reply = createUserMessage({
      source: { kind: 'user-question-reply', callId: timedCallId, outcome: 'answered' },
      content: [{ type: 'text', text: 'queued reply' }],
    })
    agent.queuedMessages.push(reply)

    expect(() => ctx.userQuestions.answer(agent, timedCallId, batch))
      .toThrow(expect.objectContaining({ code: 'REPLY_QUEUED' }))
    agent.queuedMessages.shift()
    agent.queuedTurns.push(reply)
    expect(() => ctx.userQuestions.answer(agent, timedCallId, batch))
      .toThrow(expect.objectContaining({ code: 'REPLY_QUEUED' }))
    expect(agent.steer).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reserves a restored inbox reply while it is claimed for admission', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('late-restored-claim')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)
    continueInLog(agent, timedCallId)
    const batch = { answers: [{ id: 'scope', selected: ['Tool only'] }] }
    const reply = createUserMessage({
      source: { kind: 'user-question-reply', callId: timedCallId, outcome: 'answered' },
      content: [{ type: 'text', text: 'restored reply' }],
    })
    agent.queuedMessages.push(reply)
    expect(() => ctx.userQuestions.answer(agent, timedCallId, batch))
      .toThrow(expect.objectContaining({ code: 'REPLY_QUEUED' }))

    agent.queuedMessages.shift()
    agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: reply, turn: 1 })
    expect(() => ctx.userQuestions.answer(agent, timedCallId, batch))
      .toThrow(expect.objectContaining({ code: 'REPLY_QUEUED' }))

    // An unexpected second claim for the same call must not replace the first reservation.
    const otherReply = createUserMessage({
      source: { kind: 'user-question-reply', callId: timedCallId, outcome: 'answered' },
      content: [{ type: 'text', text: 'another restored reply' }],
    })
    agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: otherReply, turn: 2 })

    const ended = agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    ctx.emit('session/event', agent.session, ended)
    expect(ctx.userQuestions.answer(agent, timedCallId, batch)).toBe(true)
    await ctx.fiber.dispose()
  })

  it('keeps the reservation through unrelated inbox and Session events', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('late-unrelated')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)
    continueInLog(agent, timedCallId)
    const batch = { answers: [{ id: 'scope', selected: ['Tool only'] }] }
    const other = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'other' }] })
    const otherReply = createUserMessage({
      source: { kind: 'user-question-reply', callId: ToolCallId('other-call'), outcome: 'answered' },
      content: [{ type: 'text', text: 'other reply' }],
    })
    const events = agentEvents(ctx, agent)
    const otherSession = Session.create(SessionId('other-session'))
    const otherEnd = otherSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.emit('session/event', otherSession, otherEnd)
    events.emit('agent/inbox/claimed', { message: otherReply, turn: 1 })

    expect(ctx.userQuestions.answer(agent, timedCallId, batch)).toBe(true)
    events.emit('agent/inbox/claimed', { message: other, turn: 1 })
    events.emit('agent/inbox/claimed', { message: otherReply, turn: 1 })
    events.emit('agent/inbox/discarded', { message: other })
    events.emit('agent/inbox/discarded', { message: otherReply })
    for (const message of [other, otherReply]) {
      const event = agent.session.append('user/message', message, { surfaceOp: 'append' })
      ctx.emit('session/event', agent.session, event)
    }
    const stepEnd = agent.session.append('step/end', { turn: 1, step: 1 })
    ctx.emit('session/event', agent.session, stepEnd)
    const turnEnd = agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.emit('session/event', agent.session, turnEnd)

    expect(() => ctx.userQuestions.answer(agent, timedCallId, batch))
      .toThrow(expect.objectContaining({ code: 'REPLY_QUEUED' }))
    expect(agent.steer).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('permits retry when a claimed reply ends without admission', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('late-claimed')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)
    continueInLog(agent, timedCallId)
    const batch = { answers: [{ id: 'scope', selected: ['Tool only'] }] }

    expect(ctx.userQuestions.answer(agent, timedCallId, batch)).toBe(true)
    const first = agent.steer.mock.calls[0]![0]
    agent.queuedMessages.shift()
    agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: first, turn: 1 })
    expect(() => ctx.userQuestions.answer(agent, timedCallId, batch))
      .toThrow(expect.objectContaining({ code: 'REPLY_QUEUED' }))

    const ended = agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    ctx.emit('session/event', agent.session, ended)
    expect(ctx.userQuestions.answer(agent, timedCallId, batch)).toBe(true)
    expect(agent.steer).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('permits retry when steering a reply throws before it is queued', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('late-steer-error')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)
    continueInLog(agent, timedCallId)
    const batch = { answers: [{ id: 'scope', selected: ['Tool only'] }] }
    agent.steer.mockImplementationOnce(() => { throw new Error('steer failed') })

    expect(() => ctx.userQuestions.answer(agent, timedCallId, batch)).toThrow('steer failed')
    expect(ctx.userQuestions.answer(agent, timedCallId, batch)).toBe(true)
    expect(agent.steer).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('answers nothing when the composition carries no Session projections', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const agent = liveAgent('late-no-projections')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)
    continueInLog(agent, timedCallId)

    expect(ctx.userQuestions.answer(agent, timedCallId, { answers: [] })).toBe(false)
    expect(agent.steer).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('refuses an open question and an unknown call', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('late-open')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)

    expect(ctx.userQuestions.answer(agent, timedCallId, { answers: [] })).toBe(false)
    expect(ctx.userQuestions.answer(agent, ToolCallId('never-asked'), { answers: [] })).toBe(false)
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.inject).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('refuses a batch that does not name each question of the call exactly once', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('late-malformed')
    ctx.agents.enter(agent, undefined)
    askInLog(agent, timedCallId)
    continueInLog(agent, timedCallId)

    for (const answers of [
      [],
      [{ id: 'other', selected: ['Tool only'] }],
      [{ id: 'scope', selected: ['Tool only'] }, { id: 'scope', selected: [] }],
      [{ id: 'scope', selected: ['Tool only'] }, { id: 'other', selected: [] }],
    ]) {
      expect(() => ctx.userQuestions.answer(agent, timedCallId, { answers }))
        .toThrow(expect.objectContaining({ name: 'UserQuestionError', code: 'BAD_ANSWER' }))
    }
    expect(agent.steer).not.toHaveBeenCalled()
    // The question stays continued and takes a well-formed batch afterwards.
    expect(ctx.userQuestions.answer(agent, timedCallId, { answers: [{ id: 'scope', selected: [] }] })).toBe(true)
    await ctx.fiber.dispose()
  })

  it('never lists a call the blocking legacy tool made, even one the process never finished', async () => {
    const ctx = await timedContext()
    const agent = liveAgent('legacy-interrupted')
    ctx.agents.enter(agent, undefined)
    const legacySchema: ToolSchema = { ...timedToolSchema, parameters: { type: 'object', properties: { questions: { type: 'array' } } } }
    askInLog(agent, timedCallId, [legacySchema])
    agent.session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: timedCallId, content: [{ type: 'text', text: 'The tool call was interrupted after it was recorded.' }], isError: true,
      }),
      error: { name: 'SessionFormatError', code: TOOL_OUTCOME_UNKNOWN },
    }, { surfaceOp: 'append' })

    expect(ctx.sessionProjections.stateOf(agent.session, 'userQuestions')?.questions).toEqual({ active: [], settled: [] })
    expect(ctx.userQuestions.answer(agent, timedCallId, { answers: [{ id: 'scope', selected: [] }] })).toBe(false)
    expect(agent.steer).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
