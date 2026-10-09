import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import LlmRuntime, { createUserMessage, isAgentLoopRequest, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  executeSessionTitleLlm,
  resolveSessionTitleLlmConfig,
  SESSION_TITLE_TIMEOUT_CODE,
} from '@deepseek-ai/dsh-session-title-llm'
import type { SessionTitleLlmConfig, SessionTitleLlmPreparedRequest } from '@deepseek-ai/dsh-session-title-llm'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[],
    private readonly onDispatch?: () => void,
    private readonly reasoningEfforts?: readonly string[],
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const efforts = this.reasoningEfforts
    const floor = efforts?.[0]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...efforts === undefined || floor === undefined
        ? {}
        : {
          reasoning: {
            efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
          },
        },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onDispatch?.()
    this.requests.push(options)
    yield * this.script
  }
}

class CooperativeAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('expected title request signal')
    await new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise exact AbortSignal.reason propagation
        reject(signal.reason)
      }
      if (signal.aborted) {
        rejectAbort()
        return
      }
      signal.addEventListener('abort', rejectAbort, { once: true })
    })
  }
}

class DelayedSuccessAdapter extends LlmAdapter {
  constructor(private readonly delayMs: number) {
    super()
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    await new Promise<void>(resolve => setTimeout(resolve, this.delayMs))
    yield * SCRIPT
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '  五个字标题  ' },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Execution controls only; title-length targets belong to each provider. */
const CONFIG = {
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
} as const

/** Leaves reasoning unselected, as a provider with no preference would. */
const NO_EFFORT_SELECTOR = (): ReasoningEffortId | undefined => undefined

/** Selects the route's least advertised effort, as both shipped providers do. */
const FLOOR_SELECTOR = (model: Readonly<LlmResolvedModelInfo>): ReasoningEffortId | undefined =>
  model.reasoning?.efforts[0]?.id

/** Selects the route's greatest effort, which the executor must not override. */
const CEILING_SELECTOR = (model: Readonly<LlmResolvedModelInfo>): ReasoningEffortId | undefined =>
  model.reasoning?.efforts.at(-1)?.id

const TITLE_PROVIDER = SessionTitleProviderId('test-title-provider')
let nextSession = 0

function request(
  ctx: Context,
  signal = new AbortController().signal,
  headerMaxTokens?: number,
): SessionTitleProviderRequest {
  const session = ctx.sessions.create(SessionId(`title-call-${++nextSession}`))
  session.append('turn/start', {
    turn: 1,
  })
  if (headerMaxTokens !== undefined) {
    session.append('request/header', {
      header: { config: { provider: 'current-route', model: 'current-model', maxTokens: headerMaxTokens } },
      reason: 'initial',
    })
  }
  const first = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first prompt' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const second = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '第二个问题' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return {
    session,
    messages: [
      { seq: first.seq, text: 'first prompt' },
      { seq: second.seq, text: '第二个问题' },
    ],
    route: { provider: 'current-route', model: 'current-model' },
    signal,
  }
}

function requestWithoutRoute(ctx: Context, signal = new AbortController().signal): SessionTitleProviderRequest {
  const routed = request(ctx, signal)
  return { session: routed.session, messages: routed.messages, signal }
}

/** Provider-prepared input attributing both fixture messages to one exact text. */
function prepared(
  providerRequest: SessionTitleProviderRequest,
  overrides: Partial<SessionTitleLlmPreparedRequest> = {},
): SessionTitleLlmPreparedRequest {
  return {
    system: 'Exact provider system prompt',
    input: 'Exact provider user input',
    messageSeqs: providerRequest.messages.map(message => message.seq),
    selectReasoningEffort: NO_EFFORT_SELECTOR,
    ...overrides,
  }
}

async function withScript(script: readonly StreamChunk[], reasoningEfforts?: readonly string[]): Promise<{
  ctx: Context
  adapter: RecordingAdapter
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter(script, undefined, reasoningEfforts)
  ctx.llm.registerAdapter(['current-route'], adapter)
  return { ctx, adapter }
}

describe('executeSessionTitleLlm', () => {
  it('dispatches the prepared system and input, logs attribution, and forwards the provider reasoning selector', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const providerRequest = request(ctx)
    let requestWasLoggedAtDispatch = false
    const adapter = new RecordingAdapter(SCRIPT, () => {
      requestWasLoggedAtDispatch = providerRequest.session.snapshotEvents()
        .some(event => event.type === 'session/title-llm-request')
    }, ['off', 'low', 'high', 'max'])
    ctx.llm.registerAdapter(['current-route'], adapter)
    const preparedRequest = prepared(providerRequest, {
      system: 'Provider-owned system instruction',
      input: 'Provider-owned user payload with 第二个问题',
      selectReasoningEffort: FLOOR_SELECTOR,
    })

    const result = await executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      TITLE_PROVIDER,
      preparedRequest,
    )

    expect(result.blocks).toEqual([{ type: 'text', text: '  五个字标题  ' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.model).toEqual({ provider: 'current-route', model: 'current-model' })
    expect(requestWasLoggedAtDispatch).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    const options = adapter.requests[0]!
    expect(Object.isFrozen(options)).toBe(true)
    expect(Object.isFrozen(options.messages)).toBe(true)
    expect(isAgentLoopRequest(options)).toBe(false)
    expect(options).toMatchObject({
      provider: 'current-route',
      model: 'current-model',
      maxTokens: 32,
      sessionId: providerRequest.session.id,
      purpose: 'session-title',
      reasoningEffort: ReasoningEffortId('off'),
    })
    expect(options.system).toBe(preparedRequest.system)
    const prompt = options.messages[0]?.content[0]
    expect(prompt?.type === 'text' && prompt.text).toBe(preparedRequest.input)
    expect(providerRequest.session.snapshotEvents().findLast(event => event.type === 'session/title-llm-request')?.data)
      .toEqual({
        titleProvider: TITLE_PROVIDER,
        messageSeqs: preparedRequest.messageSeqs,
        route: { provider: 'current-route', model: 'current-model' },
        system: preparedRequest.system,
        messages: options.messages,
        maxTokens: 32,
        reasoningEffort: ReasoningEffortId('off'),
      })
  })

  it('forwards a different valid reasoning selector instead of choosing one itself', async () => {
    const { ctx, adapter } = await withScript(SCRIPT, ['off', 'low', 'high', 'max'])
    const providerRequest = request(ctx)

    await executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest, { selectReasoningEffort: CEILING_SELECTOR }),
    )

    const options = adapter.requests[0]!
    const logged = providerRequest.session.snapshotEvents()
      .findLast(event => event.type === 'session/title-llm-request')?.data
    expect(options.maxTokens).toBe(32)
    expect(logged?.maxTokens).toBe(32)
    expect(options.reasoningEffort).toBe(ReasoningEffortId('max'))
    expect(logged?.reasoningEffort).toBe(ReasoningEffortId('max'))
  })

  it('keeps the title output cap independent of a smaller conversation cap', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const providerRequest = request(ctx, undefined, 8)

    await expect(executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest),
    )).resolves.toMatchObject({ model: { provider: 'current-route', model: 'current-model' } })

    expect(adapter.requests[0]?.maxTokens).toBe(32)
    expect(providerRequest.session.snapshotEvents()
      .findLast(event => event.type === 'session/title-llm-request')?.data.maxTokens).toBe(32)
  })

  it('enforces the exact multibyte input byte limit before logging or dispatch', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const providerRequest = request(ctx)
    const input = '标题输入："番茄"'
    const inputBytes = Buffer.byteLength(input, 'utf8')
    expect(inputBytes).toBeGreaterThan(input.length)

    await expect(executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig({ ...CONFIG, maxInputBytes: inputBytes - 1 }),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest, { input }),
    )).rejects.toThrow(/input.*bytes.*maxInputBytes/i)
    expect(adapter.requests).toHaveLength(0)
    expect(providerRequest.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(false)

    const result = await executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig({ ...CONFIG, maxInputBytes: inputBytes }),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest, { input }),
    )
    expect(result.blocks).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
  })

  it('keeps the configured output cap when the session request recorded a larger one', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const providerRequest = request(ctx, undefined, 4_096)

    await expect(executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest),
    )).resolves.toBeDefined()

    expect(adapter.requests[0]?.maxTokens).toBe(32)
  })

  it('rejects an unregistered route before recording or dispatching a title request', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const requests: GenerateOptions[] = []
    ctx.on('llm/stream', (options: GenerateOptions) => {
      requests.push(options)
      return (async function* (): AsyncIterable<StreamChunk> { yield * SCRIPT })()
    })
    const providerRequest = request(ctx)

    await expect(executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest),
    )).rejects.toMatchObject({ code: 'NO_ADAPTER' })

    expect(requests).toEqual([])
    expect(providerRequest.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(false)
  })

  it('sends no effort when the provider reasoning selector leaves it unset', async () => {
    const { ctx, adapter } = await withScript(SCRIPT, ['off', 'low'])
    const providerRequest = request(ctx)

    await expect(executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest),
    )).resolves.toBeDefined()

    expect(adapter.requests[0]).not.toHaveProperty('reasoningEffort')
  })

  it('uses paired explicit overrides and bounds the final input before model dispatch', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['explicit-route'], adapter)
    const oversized = request(ctx)
    const rawInputBytes = Buffer.byteLength('x'.repeat(20), 'utf8')
    const config = resolveSessionTitleLlmConfig({
      ...CONFIG,
      provider: 'explicit-route',
      model: 'explicit-model',
      maxInputBytes: rawInputBytes,
    })

    await expect(executeSessionTitleLlm(ctx, config, oversized, TITLE_PROVIDER, prepared(oversized, { input: 'x'.repeat(21) })))
      .rejects.toThrow(/input.*bytes.*maxInputBytes/i)
    expect(adapter.requests).toEqual([])
    expect(oversized.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(false)

    const withinLimit = resolveSessionTitleLlmConfig({ ...config, maxInputBytes: 1_000 })
    const within = request(ctx)
    await executeSessionTitleLlm(ctx, withinLimit, within, TITLE_PROVIDER, prepared(within, { input: 'x'.repeat(21) }))
    expect(adapter.requests[0]).toMatchObject({
      provider: 'explicit-route',
      model: 'explicit-model',
    })
  })

  it('requires every execution limit and a complete optional route pair', () => {
    expect(() => resolveSessionTitleLlmConfig(undefined as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig(null as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig('invalid' as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, extra: true } as SessionTitleLlmConfig))
      .toThrow(/unknown config key "extra"/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, maxInputBytes: 0 }))
      .toThrow(/maxInputBytes.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, maxOutputTokens: 1.5 }))
      .toThrow(/maxOutputTokens.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 0 }))
      .toThrow(/timeoutMs.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'only-provider' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, model: 'only-model' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: '', model: 'model' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'provider', model: '' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 1, model: 'model' } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'provider', model: 1 } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/timeoutMs must not exceed/)
    expect(() => resolveSessionTitleLlmConfig(CONFIG)).not.toThrow()
  })

  it('rejects an absent route, empty attribution, and pre-aborted caller before model dispatch', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const config = resolveSessionTitleLlmConfig(CONFIG)
    const unrouted = requestWithoutRoute(ctx)
    await expect(executeSessionTitleLlm(ctx, config, unrouted, TITLE_PROVIDER, prepared(unrouted)))
      .rejects.toThrow(/no logged request route/)
    const empty = request(ctx)
    await expect(executeSessionTitleLlm(ctx, config, empty, TITLE_PROVIDER, prepared(empty, { messageSeqs: [] })))
      .rejects.toThrow(/at least one source message/)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const aborted = request(ctx, controller.signal)
    await expect(executeSessionTitleLlm(ctx, config, aborted, TITLE_PROVIDER, prepared(aborted)))
      .rejects.toThrow('caller stopped')
    expect(adapter.requests).toEqual([])
  })

  it.each([
    [{ kind: 'error', failure: { message: 'provider failed', code: 'SERVER' } }, 'provider failed', 'SERVER'],
    [{ kind: 'aborted', failure: { message: 'provider aborted', code: 'ABORTED' } }, 'provider aborted', 'ABORTED'],
  ] satisfies Array<[FinishReason, string, string]>)('preserves %s terminal failure details', async (reason, message, code) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest),
    )).rejects.toMatchObject({ message, code })
    expect(providerRequest.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(true)
  })

  it('returns a max-tokens terminal finish for provider interpretation', async () => {
    const { ctx } = await withScript([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial title' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const providerRequest = request(ctx)

    const result = await executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest),
    )

    expect(result.finish).toEqual({ kind: 'max-tokens' })
    expect(result.blocks).toEqual([{ type: 'text', text: 'partial title' }])
  })

  it('returns a tool-calls terminal finish and its assembled blocks for provider interpretation', async () => {
    const { ctx } = await withScript([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'text beside a tool call' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: ToolCallId('title-tool'), name: 'unexpected', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const providerRequest = request(ctx)

    const result = await executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest),
    )

    expect(result.finish).toEqual({ kind: 'tool-calls' })
    expect(result.blocks).toEqual([
      { type: 'text', text: 'text beside a tool call' },
      { type: 'tool-call', id: 'title-tool', name: 'unexpected', arguments: '{}' },
    ])
  })

  it('aborts a cooperative model stream at the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      onTestFinished(() => ctx.fiber.dispose())
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['current-route'], new CooperativeAdapter())
      const providerRequest = request(ctx)
      const pending = executeSessionTitleLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        providerRequest,
        TITLE_PROVIDER,
        prepared(providerRequest),
      )
      const rejected = expect(pending).rejects.toMatchObject({
        code: SESSION_TITLE_TIMEOUT_CODE,
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a successful stream that completes after the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      onTestFinished(() => ctx.fiber.dispose())
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['current-route'], new DelayedSuccessAdapter(20))
      const providerRequest = request(ctx)
      const pending = executeSessionTitleLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        providerRequest,
        TITLE_PROVIDER,
        prepared(providerRequest),
      )
      const rejected = expect(pending).rejects.toMatchObject({
        code: SESSION_TITLE_TIMEOUT_CODE,
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(20)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates caller cancellation through the composed request signal', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['current-route'], new CooperativeAdapter())
    const controller = new AbortController()
    const providerRequest = request(ctx, controller.signal)
    const pending = executeSessionTitleLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      TITLE_PROVIDER,
      prepared(providerRequest),
    )
    const rejected = expect(pending).rejects.toThrow('caller stopped')
    controller.abort(new Error('caller stopped'))
    await rejected
  })
})
