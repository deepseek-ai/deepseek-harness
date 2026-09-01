import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { createUserMessage, ToolCallId, isAgentLoopRequest, LlmAdapter  } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  generateSessionTitleWithLlm,
  resolveSessionTitleLlmConfig,
  SESSION_TITLE_TIMEOUT_CODE,
} from '@deepseek-ai/dsh-session-title-llm'
import type { SessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[],
    private readonly onDispatch?: () => void,
  ) {
    super()
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

const CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
} as const

const TITLE_PROVIDER = SessionTitleProviderId('test-title-provider')
let nextSession = 0

function request(ctx: Context, signal = new AbortController().signal): SessionTitleProviderRequest {
  const session = ctx.sessions.create(SessionId(`title-call-${++nextSession}`))
  session.append('turn/start', {
    turn: 1,
  })
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

async function withScript(script: readonly StreamChunk[]): Promise<{
  ctx: Context
  adapter: RecordingAdapter
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter(script)
  ctx.llm.registerAdapter(['current-route'], adapter)
  return { ctx, adapter }
}

describe('generateSessionTitleWithLlm', () => {
  it('uses the exact logged route, language targets, full framed input, and output token cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const providerRequest = request(ctx)
    let requestWasLoggedAtDispatch = false
    const adapter = new RecordingAdapter(SCRIPT, () => {
      requestWasLoggedAtDispatch = providerRequest.session.snapshotEvents()
        .some(event => event.type === 'session/title-llm-request')
    })
    ctx.llm.registerAdapter(['current-route'], adapter)

    const result = await generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      providerRequest.messages,
      TITLE_PROVIDER,
    )

    expect(result).toEqual({
      title: '五个字标题',
      messageSeqs: providerRequest.messages.map(message => message.seq),
      model: { provider: 'current-route', model: 'current-model' },
    })
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
    })
    expect(options.system).toContain('5 words')
    expect(options.system).toContain('10 CJK characters')
    const prompt = options.messages[0]?.content[0]
    expect(prompt?.type === 'text' && prompt.text).toContain('first prompt')
    expect(prompt?.type === 'text' && prompt.text).toContain('第二个问题')
    expect(providerRequest.session.snapshotEvents().findLast(event => event.type === 'session/title-llm-request')?.data)
      .toEqual({
        titleProvider: TITLE_PROVIDER,
        messageSeqs: providerRequest.messages.map(message => message.seq),
        route: { provider: 'current-route', model: 'current-model' },
        system: options.system,
        messages: options.messages,
        maxTokens: 32,
      })
  })

  it('uses paired explicit overrides and bounds the final framed input before model dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['explicit-route'], adapter)
    const oversized = request(ctx)
    const [selected] = oversized.messages
    if (selected === undefined) throw new Error('expected one selected message')
    const rawInputBytes = Buffer.byteLength(selected.text, 'utf8')
    const config = resolveSessionTitleLlmConfig({
      ...CONFIG,
      provider: 'explicit-route',
      model: 'explicit-model',
      maxInputBytes: rawInputBytes,
    })

    await expect(generateSessionTitleWithLlm(ctx, config, oversized, [selected], TITLE_PROVIDER))
      .rejects.toThrow(/input.*bytes.*maxInputBytes/i)
    expect(adapter.requests).toEqual([])
    expect(oversized.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(false)

    const withinLimit = resolveSessionTitleLlmConfig({ ...config, maxInputBytes: 1_000 })
    const within = request(ctx)
    await generateSessionTitleWithLlm(ctx, withinLimit, within, [within.messages[0]!], TITLE_PROVIDER)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'explicit-route',
      model: 'explicit-model',
    })
  })

  it('requires every deployment limit and a complete optional route pair', () => {
    expect(() => resolveSessionTitleLlmConfig(undefined as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig(null as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig('invalid' as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, extra: true } as SessionTitleLlmConfig))
      .toThrow(/unknown config key "extra"/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, targetWords: 0 }))
      .toThrow(/targetWords.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, targetWords: 1.5 }))
      .toThrow(/targetWords.*positive integer/)
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

  it('rejects an absent route, empty selection, and pre-aborted caller before model dispatch', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const config = resolveSessionTitleLlmConfig(CONFIG)
    const unrouted = requestWithoutRoute(ctx)
    await expect(generateSessionTitleWithLlm(ctx, config, unrouted, unrouted.messages, TITLE_PROVIDER))
      .rejects.toThrow(/no logged request route/)
    const empty = request(ctx)
    await expect(generateSessionTitleWithLlm(ctx, config, empty, [], TITLE_PROVIDER))
      .rejects.toThrow(/at least one source message/)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const aborted = request(ctx, controller.signal)
    await expect(generateSessionTitleWithLlm(ctx, config, aborted, aborted.messages, TITLE_PROVIDER))
      .rejects.toThrow('caller stopped')
    expect(adapter.requests).toEqual([])
  })

  it.each([
    [{ kind: 'error', failure: { message: 'provider failed', code: 'SERVER' } }, 'provider failed', 'SERVER'],
    [{ kind: 'aborted', failure: { message: 'provider aborted', code: 'ABORTED' } }, 'provider aborted', 'ABORTED'],
  ] satisfies Array<[FinishReason, string, string]>)('preserves %s terminal failure details', async (reason, message, code) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      providerRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toMatchObject({ message, code })
    expect(providerRequest.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(true)
  })

  it.each([
    [{ kind: 'max-tokens' }, /reached maxOutputTokens/],
    [{ kind: 'tool-calls' }, /unexpectedly requested a tool/],
    [{ kind: 'future-finish' } as never, /unsupported finish reason "future-finish"/],
  ] satisfies Array<[FinishReason, RegExp]>)('rejects the terminal finish reason %s', async (reason, error) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      providerRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toThrow(error)
  })

  it('rejects tool-call blocks and a successful response with no text', async () => {
    const toolScript: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('title-tool'), name: 'unexpected', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const tool = await withScript(toolScript)
    const toolRequest = request(tool.ctx)
    await expect(generateSessionTitleWithLlm(
      tool.ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      toolRequest,
      toolRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toThrow(/output must contain text only/)

    const reasoning = await withScript([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'no final title' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const reasoningRequest = request(reasoning.ctx)
    await expect(generateSessionTitleWithLlm(
      reasoning.ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      reasoningRequest,
      reasoningRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toThrow(/produced no text/)
  })

  it('aborts a cooperative model stream at the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['current-route'], new CooperativeAdapter())
      const providerRequest = request(ctx)
      const pending = generateSessionTitleWithLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        providerRequest,
        providerRequest.messages,
        TITLE_PROVIDER,
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
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['current-route'], new DelayedSuccessAdapter(20))
      const providerRequest = request(ctx)
      const pending = generateSessionTitleWithLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        providerRequest,
        providerRequest.messages,
        TITLE_PROVIDER,
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
})
