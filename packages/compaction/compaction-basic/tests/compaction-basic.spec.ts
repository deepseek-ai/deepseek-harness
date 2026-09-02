import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import { frameSummary } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { CompactionId, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
} from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, { createUserMessage, ToolCallId, CONTEXT_WINDOW_EXCEEDED_CODE, createToolResultMessage, LlmAdapter , createMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmFailure,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { agentEvents, type Agent, type RequestErrorAction } from '@deepseek-ai/dsh-agent'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'

const SIGNAL = new AbortController().signal
const MODEL = 'test-model'

class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class RoutedContextAdapter extends LlmAdapter {
  constructor(private readonly windows: Readonly<Record<string, number>>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const contextWindow = this.windows[provider]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(contextWindow = 1_000): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  // The registry is a required injection of TokenMeter (its three
  // projection units register in the constructor); mount it synchronously.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL, 'actual', 'unlisted-provider'], new ContextAdapter(contextWindow))
  return ctx
}

function agent(session: Session, model?: string): Agent {
  return {
    session,
    options: model === undefined ? {} : { provider: model, model },
  } as Agent
}

/** Flatten every text fragment the summarizer received, recursing tool-result blocks. */
function summarizedText(input: SummarizationInput): string {
  const collect = (blocks: readonly ContentBlock[]): string =>
    blocks.map(block =>
      block.type === 'text' ? block.text
        : block.type === 'tool-result' ? collect(block.content)
          : '').join('\n')
  return input.messages.map(message => collect(message.content)).join('\n')
}

/** A minimal replayed prefix carrying one user message of the given text. */
function promptInput(text: string): SummarizationInput {
  return { messages: [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })] }
}

/** Closed two-message turns followed by one open turn for durable compaction events. */
function conversation(turns = 4, text = 'fixture '.repeat(40).trim()): Session {
  const session = Session.create(SessionId(`conversation-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: {
          kind: 'model',
          ...{ provider: MODEL, model: MODEL },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', {
    turn: turns + 1,
  })
  return session
}

function toolConversation(): Session {
  const session = Session.create(SessionId('tools'))
  for (let turn = 1; turn <= 3; turn += 1) {
    const callId = ToolCallId(`call-${turn}`)
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `request ${turn} `.repeat(300) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `calling ${turn} `.repeat(300) },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
        ],
        source: {
          kind: 'model',
          ...{ provider: MODEL, model: MODEL },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `result ${turn} `.repeat(300) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4 })
  return session
}

/** One closed routed tool step followed by an open turn for rewrite events. */
function oversizedToolResult(chars = 3_000, withCompactablePrompt = false): Session {
  const session = Session.create(SessionId(`oversized-tool-${chars}`))
  const callId = ToolCallId('oversized')
  session.append('turn/start', { turn: 1 })
  if (withCompactablePrompt) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'older history '.repeat(200) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: {
        kind: 'model',
        ...{ provider: MODEL, model: MODEL },
      },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'X'.repeat(chars) }],
      isError: false,
    }),
    meta: { presentation: 'preserved' },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  return session
}

class TestCompactionEngine extends BasicCompactionEngine {
  summary: ContentBlock[] = [{ type: 'text', text: 'small checkpoint' }]
  rawOutput: ContentBlock[] | undefined
  usage: TokenUsage | undefined
  summaryProvider = 'summary-provider'
  summaryModel = 'summary-model'
  error: unknown
  mutateDuringSummary: (() => void) | undefined
  calls: Array<{ input: SummarizationInput; signal: AbortSignal | undefined }> = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    signal?: AbortSignal,
  ): Promise<{
    summary: ContentBlock[]
    rawOutput?: ContentBlock[]
    provider: string
    model: string
    maxTokens?: number
    usage?: TokenUsage
  }> {
    this.calls.push({ input, signal })
    this.mutateDuringSummary?.()
    if (this.error !== undefined) throw this.error
    return {
      summary: this.summary,
      ...this.rawOutput === undefined ? {} : { rawOutput: this.rawOutput },
      provider: this.summaryProvider,
      model: this.summaryModel,
      maxTokens: 123,
      ...this.usage === undefined ? {} : { usage: this.usage },
    }
  }
}

function service(
  config: BasicCompactionConfig = { auto: false },
  ctx = createContext(),
): TestCompactionEngine {
  return new TestCompactionEngine(ctx, config)
}

async function compactIfNeeded(
  compact: BasicCompactionEngine,
  session: Session,
  trigger: 'pressure' | 'context-overflow' = 'pressure',
  model: string | undefined = MODEL,
): Promise<CompactionResult | null> {
  return compact.compactIfNeeded(agent(session, model), trigger, SIGNAL)
}

describe('compact configuration and defaults', () => {
  it('uses low-friction service-wide defaults', () => {
    const resolved = resolveConfig({})

    expect(resolved).toEqual({
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      summarizationProvider: '',
      summarizationModel: '',
      maxTokens: 8192,
      compactionRetries: 1,
      maxOverflowRetries: 1,
      modelPolicies: [],
      auto: true,
    })
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('resolves threshold and retention overrides independently', () => {
    const thresholdOnly = resolveConfig({
      thresholdRatio: 0.5,
    })
    expect(thresholdOnly).toMatchObject({
      thresholdRatio: 0.5,
      retainRatio: 0.16,
    })

    const retentionOnly = resolveConfig({
      retainTokens: 70,
    })
    expect(retentionOnly).toMatchObject({
      thresholdRatio: 0.8,
      retainTokens: 70,
    })
    expect(retentionOnly).not.toHaveProperty('retainRatio')
  })

  it('merges exact provider/model policy overrides and scales ratios per model', () => {
    const config = resolveConfig({
      thresholdRatio: 0.8,
      retainRatio: 0.1,
      modelPolicies: [{
        provider: 'small-provider',
        model: 'shared-id',
        thresholdRatio: 0.5,
        retainTokens: 120,
      }],
    })
    const small = resolveTargetPolicy(config, {
      provider: 'small-provider',
      model: 'shared-id',
    })
    const otherProvider = resolveTargetPolicy(config, {
      provider: 'large-provider',
      model: 'shared-id',
    })

    expect(resolveCompactSpec(small, 1_000)).toMatchObject({
      thresholdTokens: 500,
      retainTokens: 120,
    })
    expect(resolveCompactSpec(otherProvider, 2_000)).toMatchObject({
      thresholdTokens: 1_600,
      retainTokens: 200,
    })

    const ratioOverride = resolveTargetPolicy(resolveConfig({
      retainTokens: 200,
      modelPolicies: [{
        provider: 'ratio-provider',
        model: 'ratio-model',
        thresholdRatio: 0.6,
        retainRatio: 0.2,
        summarizationProvider: 'summary-provider',
        summarizationModel: 'summary-model',
        maxTokens: 512,
        compactionRetries: 2,
        maxOverflowRetries: 3,
      }],
    }), { provider: 'ratio-provider', model: 'ratio-model' })
    expect(resolveCompactSpec(ratioOverride, 2_000)).toMatchObject({
      thresholdTokens: 1_200,
      retainTokens: 400,
      summarizationProvider: 'summary-provider',
      summarizationModel: 'summary-model',
      maxTokens: 512,
      compactionRetries: 2,
      maxOverflowRetries: 3,
    })
  })

  it('inherits, clears, and replaces the summarization target as a pair', () => {
    const config = resolveConfig({
      summarizationProvider: 'default-provider',
      summarizationModel: 'default-model',
      modelPolicies: [
        { provider: 'inherit-provider', model: MODEL },
        {
          provider: 'clear-provider',
          model: MODEL,
          summarizationProvider: '',
          summarizationModel: '',
        },
        {
          provider: 'replace-provider',
          model: MODEL,
          summarizationProvider: 'replacement-provider',
          summarizationModel: 'replacement-model',
        },
      ],
    })

    expect(resolveTargetPolicy(config, { provider: 'inherit-provider', model: MODEL }))
      .toMatchObject({
        summarizationProvider: 'default-provider',
        summarizationModel: 'default-model',
      })
    expect(resolveTargetPolicy(config, { provider: 'clear-provider', model: MODEL }))
      .toMatchObject({ summarizationProvider: '', summarizationModel: '' })
    expect(resolveTargetPolicy(config, { provider: 'replace-provider', model: MODEL }))
      .toMatchObject({
        summarizationProvider: 'replacement-provider',
        summarizationModel: 'replacement-model',
      })
  })

  it('validates common values and pressure-policy invariants', () => {
    const bad = [
      [{ maxTokens: 0 }, /maxTokens/],
      [{ compactionRetries: -1 }, /compactionRetries/],
      [{ maxOverflowRetries: -1 }, /maxOverflowRetries/],
      [{ auto: 'yes' }, /auto must be a boolean/],
      [{ summarizationProvider: 1 }, /summarizationProvider must be a string/],
      [{ summarizationModel: 1 }, /summarizationModel must be a string/],
      [{ summarizationProvider: MODEL }, /must be set together/],
      [{ summarizationModel: MODEL }, /must be set together/],
      [{ summarizationProvider: '' }, /must be set together/],
      [{ summarizationModel: '' }, /must be set together/],
      [{ thresholdRatio: 0 }, /number in \(0, 1\]/],
      [{ thresholdRatio: 1.1 }, /number in \(0, 1\]/],
      [{ retainRatio: 0.9 }, /retainRatio \(0.9\) must be less than the resolved thresholdRatio \(0.8\)/],
      [{ thresholdRatio: 0.1 }, /retainRatio \(0.16\) must be less than the resolved thresholdRatio \(0.1\)/],
      [{ retainTokens: -1 }, /non-negative integer/],
      [{ retainRatio: 0.2, retainTokens: 100 }, /mutually exclusive/],
      [{ modelPolicies: {} }, /modelPolicies must be an array/],
      [{ modelPolicies: [1] }, /modelPolicies\[0\] must be an object/],
      [{ modelPolicies: [null] }, /modelPolicies\[0\] must be an object/],
      [{ modelPolicies: [[]] }, /modelPolicies\[0\] must be an object/],
      [{ modelPolicies: [{ provider: 1, model: MODEL }] }, /provider must be a non-empty string/],
      [{ modelPolicies: [{ provider: '', model: MODEL }] }, /provider must be a non-empty string/],
      [{ modelPolicies: [{ provider: MODEL, model: 1 }] }, /model must be a non-empty string/],
      [{ modelPolicies: [{ provider: MODEL, model: '' }] }, /model must be a non-empty string/],
      [{ modelPolicies: [{ provider: MODEL, model: MODEL, summarizationProvider: 1 }] }, /summarizationProvider must be a string/],
      [{
        summarizationProvider: 'default-provider',
        summarizationModel: 'default-model',
        modelPolicies: [{ provider: MODEL, model: MODEL, summarizationModel: '' }],
      }, /modelPolicies\[0\].*must be set together/],
      [{
        summarizationProvider: 'default-provider',
        summarizationModel: 'default-model',
        modelPolicies: [{ provider: MODEL, model: MODEL, summarizationProvider: '' }],
      }, /modelPolicies\[0\].*must be set together/],
      [{ modelPolicies: [{ provider: MODEL, model: MODEL, retainRatio: 0.2, retainTokens: 100 }] }, /mutually exclusive/],
      [
        { modelPolicies: [{ provider: MODEL, model: MODEL, thresholdRatio: 0.1 }] },
        /modelPolicies\[0\]: retainRatio \(0.16\).*thresholdRatio \(0.1\)/,
      ],
      [
        { modelPolicies: [{ provider: MODEL, model: MODEL, retainRatio: 0.9 }] },
        /modelPolicies\[0\]: retainRatio \(0.9\).*thresholdRatio \(0.8\)/,
      ],
      [{ modelPolicies: [{ provider: MODEL, model: MODEL }, { provider: MODEL, model: MODEL }] }, /duplicate model policy/],
      [{ models: { [MODEL]: { retainTokens: 10 } } }, /BasicCompactionConfig: unknown key "models"/],
      [{ thresholdRato: 0.5 }, /BasicCompactionConfig: unknown key "thresholdRato"/],
    ] as Array<[unknown, RegExp]>

    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as BasicCompactionConfig)).toThrow(pattern)
    }

    const invalidPressure = resolveTargetPolicy(resolveConfig({
      thresholdRatio: 0.5,
      retainTokens: 500,
    }), { provider: MODEL, model: MODEL })
    expect(() => resolveCompactSpec(invalidPressure, 1_000)).toThrow(/less than threshold/)
    expect(() => resolveCompactSpec(invalidPressure, 1.5)).toThrow(/positive integer/)
    expect(() => resolveCompactSpec(invalidPressure, 0)).toThrow(/positive integer/)
  })

})

describe('pressure measurement and retention', () => {
  const compactConfig: BasicCompactionConfig = {
    auto: false,
    thresholdRatio: 0.5,
    retainTokens: 180,
  }

  it('skips when no durable routed model exists instead of using AgentOptions fallback', async () => {
    const compact = service(compactConfig)
    const session = Session.create(SessionId('headerless'))
    session.append('turn/start', { turn: 1 })
    await expect(compact.compactIfNeeded(agent(session, MODEL), 'pressure', SIGNAL))
      .resolves.toBeNull()
    expect(compact.calls).toHaveLength(0)
  })

  it('meters an unlisted model when its provider adapter supplies context metadata', async () => {
    const compact = service(compactConfig)
    const session = conversation()
    session.append('request/header', {
      header: { config: { provider: 'unlisted-provider', model: 'unlisted-model' } },
      reason: 'resume',
    })
    await expect(compactIfNeeded(compact, session))
      .resolves.not.toBeNull()
  })

  it('forwards turn cancellation to proactive model metadata resolution', async () => {
    const ctx = createContext()
    const resolveModelInfo = vi.spyOn(ctx.llm, 'resolveModelInfo')
    const compact = service(compactConfig, ctx)
    const session = conversation()
    const signal = new AbortController().signal

    await expect(compact.compactIfNeeded(agent(session, MODEL), 'pressure', signal))
      .resolves.not.toBeNull()
    expect(resolveModelInfo).toHaveBeenCalledWith(MODEL, MODEL, signal)
  })

  it('re-resolves capacity after a same-model-id provider switch in one session', async () => {
    const ctx = new Context()
    void new LlmRuntime(ctx)
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    ctx.llm.registerAdapter(['large', 'small'], new RoutedContextAdapter({
      large: 10_000,
      small: 1_000,
    }))
    const compact = service({
      auto: false,
      thresholdRatio: 0.5,
      retainRatio: 0.1,
    }, ctx)
    const session = conversation(4)
    session.append('request/header', {
      header: { config: { provider: 'large', model: 'shared-id' } },
      reason: 'resume',
    })
    await expect(compactIfNeeded(compact, session)).resolves.toBeNull()

    session.append('request/header', {
      header: { config: { provider: 'small', model: 'shared-id' } },
      reason: 'change',
    })
    await expect(compactIfNeeded(compact, session)).resolves.not.toBeNull()
  })

  it('requires capacity only for proactive pressure, not provider-confirmed overflow', async () => {
    const ctx = new Context()
    void new LlmRuntime(ctx)
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    ctx.llm.registerAdapter(['unknown-context'], new ContextAdapter(1_000))
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation((provider, model) => Promise.resolve({
      provider,
      id: model,
      name: model,
    }))
    const compact = service(compactConfig, ctx)
    const session = conversation(4)
    session.append('request/header', {
      header: { config: { provider: 'unknown-context', model: 'model' } },
      reason: 'resume',
    })

    await expect(compactIfNeeded(compact, session, 'pressure'))
      .rejects.toThrow(/no context capacity for unknown-context\/model/)
    await expect(compactIfNeeded(compact, session, 'context-overflow'))
      .resolves.not.toBeNull()
  })

  it('declines forced overflow when the whole surface is one indivisible tool pair', async () => {
    const compact = service(compactConfig)
    const session = Session.create(SessionId('single-tool-pair'))
    const callId = ToolCallId('single-call')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL } },
      reason: 'initial',
    })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
        source: {
          kind: 'model',
          ...{ provider: MODEL, model: MODEL },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    const generation = session.surface.replaceGeneration

    await expect(compactIfNeeded(compact, session, 'context-overflow')).resolves.toBeNull()
    expect(session.surface.replaceGeneration).toBe(generation)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('does nothing below threshold and compacts a priced head above threshold', async () => {
    const compact = service(compactConfig)
    expect(await compactIfNeeded(compact, conversation(2))).toBeNull()

    const session = conversation(4)
    const result = await compactIfNeeded(compact, session)
    expect(result).not.toBeNull()
    expect(result?.shadowedSeqs.length).toBeGreaterThan(2)
    expect(session.surface.nodes.length).toBeLessThan(8)
  })

  it('counts the durable routed request envelope without putting it on the surface', async () => {
    const compact = service({
      auto: false,
      thresholdRatio: 0.9,
      retainTokens: 50,
    })
    const session = conversation(2, 'x'.repeat(600))
    expect(await compactIfNeeded(compact, session)).toBeNull()

    session.append('request/header', {
      header: {
        config: { provider: MODEL, model: MODEL },
        system: 's'.repeat(2_000),
      },
      reason: 'resume',
    })
    const result = await compactIfNeeded(compact, session)
    expect(result).not.toBeNull()
  })

  it('uses the latest logged request envelope without an AgentOptions override', async () => {
    const ctx = createContext()
    const compact = service({
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 180,
    }, ctx)
    const session = conversation(4)
    session.append('request/header', {
      header: { config: { provider: 'actual', model: 'actual' } },
      reason: 'initial',
    })
    const measure = vi.spyOn(ctx.tokenMeter, 'measure')

    const result = await compactIfNeeded(compact, session, 'pressure', 'fallback')
    expect(result).not.toBeNull()
    expect(session.requestHeader()?.config.model).toBe('actual')
    expect(measure.mock.calls[0]).toEqual([session])
  })

  it('declines when envelope pressure is high but the surface has no compactable range', async () => {
    const compact = service(compactConfig)
    const empty = Session.create(SessionId('empty'))
    empty.append('turn/start', { turn: 1 })
    empty.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL }, system: 'x'.repeat(100_000) },
      reason: 'initial',
    })
    expect(await compactIfNeeded(compact, empty)).toBeNull()

    const retained = conversation(1)
    retained.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL }, system: 'x'.repeat(100_000) },
      reason: 'resume',
    })
    expect(await compactIfNeeded(compact, retained)).toBeNull()
  })

  it('uses one unified measurement for each pressure-and-retention decision', async () => {
    const ctx = createContext()
    const compact = service(compactConfig, ctx)
    const measure = vi.spyOn(ctx.tokenMeter, 'measure')
    const stop = new Error('stop after first decision')
    vi.spyOn(compact, 'compactRegion').mockRejectedValueOnce(stop)

    await expect(compactIfNeeded(compact, conversation(4))).rejects.toBe(stop)
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('bounds retries when a shrinking checkpoint remains above threshold', async () => {
    const compact = service({
      auto: false,
      compactionRetries: 0,
      thresholdRatio: 0.3,
      retainTokens: 180,
    })
    compact.summary = Array.from({ length: 7 }, (_, index) => ({
      type: 'text',
      text: `summary ${index}`,
    }))

    await expect(compactIfNeeded(compact, conversation(4)))
      .rejects.toThrow(/still above threshold after 1 compaction attempts/)
  })

  it('rounds a retention cut head-ward to preserve tool-call/result pairing', async () => {
    const compact = service({
      auto: false,
      thresholdRatio: 0.8,
      retainTokens: 80,
    }, createContext(4_000))
    const session = toolConversation()
    const result = await compactIfNeeded(compact, session)
    expect(result).not.toBeNull()

    const messages = session.deriveMessages()
    const calls = new Set<string>()
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'tool-call') calls.add(block.id)
        if (block.type === 'tool-result') expect(calls.has(block.toolCallId)).toBe(true)
      }
    }
  })

  it('rejects a priced surface that is not the current positional surface', () => {
    const ctx = createContext()
    const session = conversation(2)
    const priced = ctx.tokenMeter.measure(session)
    expect(() => selectCompactableRange(session, {
      ...priced,
      nodes: priced.nodes.slice(1),
    }, 1)).toThrow(/does not match/)
  })

  it('declines when rounding a cut would consume the only tool pair', () => {
    const ctx = createContext()
    const session = Session.create(SessionId('one-tool-pair'))
    const callId = ToolCallId('only')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
        source: {
          kind: 'model',
          ...{ provider: MODEL, model: MODEL },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })

    const priced = ctx.tokenMeter.measure(session)
    expect(selectCompactableRange(session, priced, 1)).toBeNull()
  })
})

describe('optional model-free tool-result pruning', () => {
  const pruneConfig = { thresholdChars: 100, headChars: 20, tailChars: 10 }

  it('does not prune a below-pressure session opportunistically', async () => {
    const ctx = createContext(10_000)
    const prune = new ToolResultPruner(ctx, pruneConfig)
    const compact = new TestCompactionEngine(ctx, {
      auto: false,
      thresholdRatio: 0.8,
      retainTokens: 100,
    })
    const session = oversizedToolResult()
    const pruneSession = vi.spyOn(prune, 'pruneSession')

    expect(await compactIfNeeded(compact, session)).toBeNull()
    expect(pruneSession).not.toHaveBeenCalled()
    expect(compact.calls).toHaveLength(0)
    expect(session.surface.replaceGeneration).toBe(0)
  })

  it('skips LLM summarization when pruning alone clears pressure', async () => {
    const ctx = createContext(1_000)
    void new ToolResultPruner(ctx, pruneConfig)
    const compact = new TestCompactionEngine(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    })
    const session = oversizedToolResult()

    expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThanOrEqual(500)
    expect(await compactIfNeeded(compact, session)).toBeNull()
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(500)
    expect(compact.calls).toHaveLength(0)
    expect(session.surface.replaceGeneration).toBe(1)
  })

  it('summarizes the pruned surface when pruning is insufficient', async () => {
    const ctx = createContext(2_000)
    void new ToolResultPruner(ctx, pruneConfig)
    const compact = new TestCompactionEngine(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    })
    const session = toolConversation()

    expect(await compactIfNeeded(compact, session)).not.toBeNull()
    expect(compact.calls).toHaveLength(1)
    expect(summarizedText(compact.calls[0]!.input)).toContain('tool result middle pruned')
    expect(summarizedText(compact.calls[0]!.input)).not.toContain('result 1 '.repeat(300))
  })

  it('retains the original compaction-basic behavior without the optional plugin', async () => {
    const ctx = createContext(2_000)
    const compact = new TestCompactionEngine(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    })
    const session = oversizedToolResult(3_000, true)

    expect(await compactIfNeeded(compact, session)).not.toBeNull()
    expect(compact.calls).toHaveLength(1)
    const original = session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(original?.type === 'tool/result' && original.data.message.content[0].content[0])
      .toEqual({ type: 'text', text: 'X'.repeat(3_000) })
    expect(session.snapshotEvents().filter(event =>
      event.type === 'tool/result' && event.surfaceOp !== 'append')).toHaveLength(0)
  })
})

describe('compaction region transaction', () => {
  it('lands a framed, replayable checkpoint with exact source seqs and token price', async () => {
    const compact = service()
    compact.rawOutput = [
      { type: 'reasoning', text: 'private compact thought' },
      ...compact.summary,
    ]
    compact.usage = { inputTokens: 40, outputTokens: 5 }
    const session = conversation(3)
    const before = [...session.surface.nodes]
    const result = await compact.compactRegion(
      before[0]!,
      before[3]!,
      agent(session, MODEL),
      SIGNAL,
    )

    expect(result.shadowedSeqs).toEqual(before.slice(0, 4))
    expect(result.shadowedTokenCount).toBeGreaterThan(0)
    expect(compact.calls[0]).toMatchObject({ signal: SIGNAL })
    expect(summarizedText(compact.calls[0]!.input)).toContain('fixture user 1')
    const summary = session.snapshotEvents().findLast(event => event.type === 'compaction/summary')
    expect(summary?.data).toMatchObject({
      shadowedSeqs: result.shadowedSeqs,
      shadowedTokenCount: result.shadowedTokenCount,
      provider: 'summary-provider',
      model: 'summary-model',
      maxTokens: 123,
      rawOutput: compact.rawOutput,
      usage: compact.usage,
    })
    expect(summary?.data).not.toHaveProperty('llmStreamCall')
    const head = session.deriveMessages()[0]!
    expect(head.content[0]?.type).toBe('text')
    expect(head.content[0]?.type === 'text' ? head.content[0].text : '').toContain('<compacted-summary>')
    expect(head.content.at(-1)).toEqual({ type: 'text', text: '</compacted-summary>' })

    const replay = Session.create(SessionId('replay'), session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('replays the latest routed header so the summarizer reuses the cache', async () => {
    const compact = service()
    const session = conversation(3)
    const tools = [{ name: 'do_thing', description: 'd', parameters: { type: 'object' } }]
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL }, system: 'CONVERSATION SYSTEM', tools },
      reason: 'resume',
    })
    const nodes = session.surface.nodes
    await compact.compactRegion(nodes[0]!, nodes[1]!, agent(session, MODEL), SIGNAL)

    const { input } = compact.calls[0]!
    expect(input.system).toBe('CONVERSATION SYSTEM')
    expect(input.tools).toEqual(tools)
    expect(summarizedText(input)).toContain('fixture user 1')
  })

  it.each([
    ['start missing', 9_001, undefined, /start seq 9001 not found/],
    ['end missing', undefined, 9_002, /end seq 9002 not found/],
  ])('rejects %s', async (_label, startOverride, endOverride, pattern) => {
    const compact = service()
    const session = conversation(2)
    const nodes = session.surface.nodes
    await expect(compact.compactRegion(
      startOverride === undefined ? nodes[0]! : SessionSeq(startOverride),
      endOverride === undefined ? nodes[1]! : SessionSeq(endOverride),
      agent(session, MODEL),
    )).rejects.toThrow(pattern)
  })

  it('rejects reversed and tool-unbalanced positional boundaries', async () => {
    const compact = service()
    const plain = conversation(2)
    const nodes = plain.surface.nodes
    await expect(compact.compactRegion(
      nodes[2]!,
      nodes[1]!,
      agent(plain, MODEL),
    )).rejects.toThrow(/is after end/)

    const tools = toolConversation()
    const toolNodes = tools.surface.nodes
    await expect(compact.compactRegion(
      toolNodes[2]!,
      toolNodes[4]!,
      agent(tools, MODEL),
    )).rejects.toThrow(/start seq .* not a balanced boundary/)
    await expect(compact.compactRegion(
      toolNodes[0]!,
      toolNodes[1]!,
      agent(tools, MODEL),
    )).rejects.toThrow(/end seq .* not a balanced boundary/)
  })

  it('requires an open turn and an idle compaction bracket', async () => {
    const compact = service()
    const closed = conversation(1)
    closed.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const nodes = closed.surface.nodes
    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[1]!,
      agent(closed, MODEL),
    )).rejects.toThrow(/no open turn/)

    const locked = conversation(1)
    locked.append('compaction/start', {
      compactionId: CompactionId('locked-compaction'),
      turn: 2,
    })
    const lockedNodes = locked.surface.nodes
    await expect(compact.compactRegion(
      lockedNodes[0]!,
      lockedNodes[1]!,
      agent(locked, MODEL),
    )).rejects.toThrow(/already in progress/)
  })

  it('rejects a session with no turn boundary at all', async () => {
    const compact = service()
    const session = Session.create(SessionId('turnless'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'orphan' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const node = session.surface.nodes[0]!

    await expect(compact.compactRegion(
      node,
      node,
      agent(session, MODEL),
    )).rejects.toThrow(/no open turn/)
  })

  it('rejects a meter snapshot that changed before summarization began', async () => {
    const ctx = createContext()
    const meter = ctx.tokenMeter
    const original = meter.measure.bind(meter)
    vi.spyOn(meter, 'measure').mockImplementationOnce((session) => {
      const measurement = original(session)
      return { ...measurement, nodes: measurement.nodes.slice(1) }
    })
    const compact = service({ auto: false }, ctx)
    const session = conversation(2)
    const nodes = session.surface.nodes

    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[2]!,
      agent(session, MODEL),
    )).rejects.toThrow(/selected surface changed/)
  })

  it('records summarizer failures without mutating the surface', async () => {
    const compact = service()
    compact.error = new Error('summary unavailable')
    const session = conversation(2)
    const before = session.surface.nodes

    await expect(compact.compactRegion(
      before[0]!,
      before[2]!,
      agent(session, MODEL),
    )).rejects.toThrow('summary unavailable')
    expect(session.surface.nodes).toEqual(before)
    expect(session.snapshotEvents().findLast(event => event.type === 'compaction/end')?.data)
      .toMatchObject({ error: 'summary unavailable' })
  })

  it('stringifies non-Error failures in the durable end bracket', async () => {
    const compact = service()
    compact.error = 'plain failure'
    const session = conversation(2)
    const nodes = session.surface.nodes
    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[2]!,
      agent(session, MODEL),
    )).rejects.toBe('plain failure')
    expect(session.snapshotEvents().findLast(event => event.type === 'compaction/end')?.data)
      .toMatchObject({ error: 'plain failure' })
  })

  it('tolerates concurrent log-only appends while the selected surface is stable', async () => {
    const compact = service()
    const session = conversation(2)
    compact.mutateDuringSummary = () => {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'change',
      })
    }
    const nodes = session.surface.nodes

    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[2]!,
      agent(session, MODEL),
    )).resolves.toMatchObject({ shadowedSeqs: nodes.slice(0, 3) })
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
  })

  it('rejects concurrent surface appends before committing the replacement', async () => {
    const compact = service()
    const session = conversation(2)
    compact.mutateDuringSummary = () => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'concurrent surface mutation' }],
        source: { kind: 'plugin', plugin: 'test' },
      }), { surfaceOp: 'append' })
    }
    const nodes = session.surface.nodes

    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[2]!,
      agent(session, MODEL),
    )).rejects.toThrow(/session surface changed/)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
  })

  it('rejects a non-shrinking framed summary under the conversation meter', async () => {
    const compact = service()
    compact.summary = Array.from({ length: 100 }, (_, index) => ({
      type: 'text',
      text: `verbose ${index}`,
    }))
    const session = conversation(2)
    const nodes = session.surface.nodes

    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[2]!,
      agent(session, MODEL),
    )).rejects.toThrow(/summary is not smaller/)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
  })

  it('lets a model-independent custom summarizer compact without a conversation model', async () => {
    const compact = service()
    const session = Session.create(SessionId('model-less-region'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'history '.repeat(100) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer '.repeat(100) }],
        source: {
          kind: 'model',
          ...{ provider: 'historical', model: 'historical' },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    const nodes = session.surface.nodes
    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[1]!,
      agent(session),
    )).resolves.toMatchObject({ shadowedSeqs: [nodes[0]!, nodes[1]!] })
  })
})

class ScriptedAdapter extends LlmAdapter {
  lastOptions: GenerateOptions | undefined
  usage: TokenUsage | undefined

  constructor(
    private readonly blocks: readonly ContentBlock[],
    private readonly finish: (StreamChunk & { type: 'finish' })['reason'] = { kind: 'stop' },
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    for (const [index, block] of this.blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      if (block.type === 'text') {
        yield { type: 'text-delta', index, text: block.text }
      } else if (block.type === 'reasoning') {
        yield { type: 'reasoning-delta', index, text: block.text }
      } else {
        yield { type: 'block-end', index, block }
      }
    }
    if (this.usage !== undefined) yield { type: 'usage', usage: this.usage }
    yield { type: 'finish', reason: this.finish }
  }
}

class ExposedCompactionEngine extends BasicCompactionEngine {
  runSummarize(
    input: SummarizationInput,
    owner: Agent,
    signal?: AbortSignal,
  ): Promise<{
    summary: ContentBlock[]
    rawOutput?: ContentBlock[]
    provider: string
    model: string
    maxTokens?: number
    usage?: TokenUsage
  }> {
    return this.summarize(input, owner, signal)
  }
}

async function summarizerHarness(
  blocks: readonly ContentBlock[],
  finish?: (StreamChunk & { type: 'finish' })['reason'],
  model = MODEL,
  config: BasicCompactionConfig = { auto: false },
): Promise<{ ctx: Context; adapter: ScriptedAdapter; compact: ExposedCompactionEngine }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  void new TokenMeter(ctx)
  const adapter = new ScriptedAdapter(blocks, finish)
  ctx.llm.registerAdapter([model], adapter)
  const compact = new ExposedCompactionEngine(ctx, config)
  return { ctx, adapter, compact }
}

describe('default one-shot summarizer', () => {
  it('requires complete raw output when a subclass marks one local LLM stream call', () => {
    expectTypeOf<{
      summary: ContentBlock[]
      llmStreamCall: true
      provider: string
      model: string
    }>().not.toExtend<SummaryResult>()
  })

  it('uses configured model/default cap, forwards cancellation, and keeps only safe text', async () => {
    const { adapter, compact } = await summarizerHarness([
      { type: 'reasoning', text: 'private' },
      { type: 'text', text: 'public summary' },
      { type: 'tool-call', id: ToolCallId('unexpected'), name: 'x', arguments: '{}' },
    ], undefined, MODEL, {
      auto: false,
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 321,
    })
    const session = conversation(1)
    adapter.usage = { inputTokens: 12, outputTokens: 3 }
    const output = await compact.runSummarize(promptInput('transcript'), agent(session, 'fallback'), SIGNAL)

    expect(output).toEqual({
      summary: [{ type: 'text', text: 'public summary' }],
      rawOutput: [
        { type: 'reasoning', text: 'private' },
        { type: 'text', text: 'public summary' },
        { type: 'tool-call', id: ToolCallId('unexpected'), name: 'x', arguments: '{}' },
      ],
      llmStreamCall: true,
      provider: MODEL,
      model: MODEL,
      maxTokens: 321,
      usage: adapter.usage,
    })
    expect(adapter.lastOptions).toMatchObject({
      provider: MODEL,
      model: MODEL,
      maxTokens: 321,
      signal: SIGNAL,
      sessionId: session.id,
      purpose: 'compaction',
    })
    const instruction = adapter.lastOptions?.messages.at(-1)?.content[0]
    expect(instruction?.type === 'text' ? instruction.text : '').toContain('## Primary Request and Intent')
  })

  it('replays the conversation prefix and appends the instruction as the final message', async () => {
    const { adapter, compact } = await summarizerHarness([{ type: 'text', text: 'summary' }])
    const tools = [{ name: 'do_thing', description: 'd', parameters: { type: 'object' } }]
    const prefix: Message = createUserMessage({
      content: [
        { type: 'text', text: 'earlier turn' },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await compact.runSummarize({
      system: 'REPLAYED SYSTEM',
      tools,
      messages: [prefix],
    }, agent(conversation(1), MODEL))

    expect(adapter.lastOptions?.system).toBe('REPLAYED SYSTEM')
    expect(adapter.lastOptions?.tools).toEqual(tools)
    const messages = adapter.lastOptions?.messages ?? []
    expect(messages[0]).toEqual(prefix)
    const last = messages.at(-1)?.content[0]
    const lastText = last?.type === 'text' ? last.text : ''
    expect(lastText).toContain('Write concise English engineering prose.')
    expect(lastText).toContain('numeric values, function signatures, and syntax fragments.')
    expect(lastText).toContain('## Primary Request and Intent')
  })

  it('applies the routed model policy without changing the replayed prefix', async () => {
    const { ctx, compact } = await summarizerHarness(
      [{ type: 'text', text: 'unused default summary' }],
      undefined,
      MODEL,
      {
        auto: false,
        maxTokens: 111,
        modelPolicies: [{
          provider: MODEL,
          model: MODEL,
          summarizationProvider: 'policy-summary',
          summarizationModel: 'policy-summary',
          maxTokens: 222,
        }],
      },
    )
    const policyAdapter = new ScriptedAdapter([{ type: 'text', text: 'policy summary' }])
    ctx.llm.registerAdapter(['policy-summary'], policyAdapter)
    const prefix: Message = createUserMessage({
      content: [{ type: 'text', text: 'warm prefix' }],
      source: { kind: 'plugin', plugin: 'test' },
    })

    const output = await compact.runSummarize({
      system: 'WARM SYSTEM',
      messages: [prefix],
    }, agent(conversation(1), 'fallback'))

    expect(output).toMatchObject({
      provider: 'policy-summary',
      model: 'policy-summary',
      maxTokens: 222,
    })
    expect(policyAdapter.lastOptions).toMatchObject({
      provider: 'policy-summary',
      model: 'policy-summary',
      maxTokens: 222,
      system: 'WARM SYSTEM',
    })
    expect(policyAdapter.lastOptions?.messages[0]).toEqual(prefix)
  })

  it('resolves the latest routed provider/model before the AgentOptions pair', async () => {
    const { adapter, compact } = await summarizerHarness([{ type: 'text', text: 'summary' }], undefined, 'routed')
    const session = conversation(1)
    session.append('request/header', {
      header: { config: { provider: 'routed', model: 'routed' } },
      reason: 'initial',
    })
    const output = await compact.runSummarize(promptInput('history'), agent(session, 'fallback'))
    expect(output.provider).toBe('routed')
    expect(output.model).toBe('routed')
    expect(adapter.lastOptions?.provider).toBe('routed')
    expect(adapter.lastOptions?.model).toBe('routed')
  })

  it('records the model actually dispatched after one-shot stream routing', async () => {
    const { ctx, compact } = await summarizerHarness([{ type: 'text', text: 'unused' }])
    const routedAdapter = new ScriptedAdapter([{ type: 'text', text: 'routed summary' }])
    ctx.llm.registerAdapter(['routed-summary-provider'], routedAdapter)
    ctx.on('llm/stream', (options, next) => {
      options.provider = 'routed-summary-provider'
      options.model = 'routed-summary-model'
      return next()
    })

    const session = conversation(3, 'large history '.repeat(500))
    const nodes = session.surface.nodes
    await compact.compactRegion(nodes[0]!, nodes[3]!, agent(session, MODEL), SIGNAL)
    expect(session.snapshotEvents().findLast(event => event.type === 'compaction/summary')?.data).toMatchObject({
      summary: [{ type: 'text', text: 'routed summary' }],
      llmStreamCall: true,
      provider: 'routed-summary-provider',
      model: 'routed-summary-model',
    })
    expect(routedAdapter.lastOptions?.provider).toBe('routed-summary-provider')
    expect(routedAdapter.lastOptions?.model).toBe('routed-summary-model')
  })

  it('fails clearly when no complete summarization target can be resolved', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    void new TokenMeter(ctx)
    const compact = new ExposedCompactionEngine(ctx, { auto: false })
    await expect(compact.runSummarize(promptInput('history'), agent(Session.create(SessionId('model-less')))))
      .rejects.toThrow(/no provider\/model available for summarization/)
  })

  it('uses a complete AgentOptions target when no durable route exists', async () => {
    const { adapter, compact } = await summarizerHarness([{ type: 'text', text: 'summary' }])
    const session = Session.create(SessionId('headerless-summary'))

    await expect(compact.runSummarize(promptInput('history'), agent(session, MODEL))).resolves.toMatchObject({
      provider: MODEL,
      model: MODEL,
    })
    expect(adapter.lastOptions).toMatchObject({ provider: MODEL, model: MODEL })
  })

  it.each([
    { provider: '', model: MODEL },
    { provider: MODEL },
    { provider: MODEL, model: '' },
  ])('rejects incomplete AgentOptions target %#', async (options) => {
    const { compact } = await summarizerHarness([{ type: 'text', text: 'unused' }])
    const owner = {
      session: Session.create(SessionId(`incomplete-${String(options.model)}`)),
      options,
    } as Agent
    await expect(compact.runSummarize(promptInput('history'), owner))
      .rejects.toThrow(/no provider\/model available for summarization/)
  })

  it.each([
    [{ kind: 'error', failure: { message: 'provider failed', code: 'PROVIDER' } }, 'PROVIDER', /provider failed/],
    [{ kind: 'error', failure: { message: 'opaque', code: 'UNKNOWN' } }, 'UNKNOWN', /opaque/],
    [{ kind: 'aborted', failure: { message: 'summarization aborted', code: 'ABORTED' } }, 'ABORTED', /aborted/],
    [{ kind: 'max-tokens' }, 'MAX_TOKENS', /token cap/],
  ] as Array<[(StreamChunk & { type: 'finish' })['reason'], string | undefined, RegExp]>) (
    'rejects terminal finish %#',
    async (finish, code, pattern) => {
      const { compact } = await summarizerHarness([], finish)
      let thrown: unknown
      try {
        await compact.runSummarize(promptInput('history'), agent(conversation(1), MODEL))
      } catch (error: unknown) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(pattern)
      expect((thrown as Error & { code?: string }).code).toBe(code)
    },
  )

  it('rejects empty or reasoning-only successful output', async () => {
    const { compact } = await summarizerHarness([{ type: 'reasoning', text: 'private' }])
    await expect(compact.runSummarize(promptInput('history'), agent(conversation(1), MODEL)))
      .rejects.toThrow(/no text summary content/)
  })

  it('rejects image summary output instead of silently dropping it', async () => {
    const { compact } = await summarizerHarness([
      {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
        },
      },
      { type: 'text', text: 'partial summary' },
    ])
    await expect(compact.runSummarize(promptInput('history'), agent(conversation(1), MODEL)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('rejects image summary output nested in a tool result', async () => {
    const { compact } = await summarizerHarness([{
      type: 'tool-result',
      toolCallId: ToolCallId('summary-tool'),
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
        },
      }],
    }])
    await expect(compact.runSummarize(promptInput('history'), agent(conversation(1), MODEL)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})

describe('automatic listener and loader composition', () => {
  function preStep(ctx: Context, owner: Agent, signal = SIGNAL) {
    return agentEvents(ctx, owner).waterfall(
      'agent/pre-step', { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
  }

  function recover(
    ctx: Context,
    owner: Agent,
    error: Error & { code?: string },
    signal = SIGNAL,
    next: () => Promise<RequestErrorAction> = () => Promise.resolve(undefined),
  ): Promise<boolean> {
    const failure: LlmFailure = { message: error.message, code: error.code ?? 'UNKNOWN' }
    const turn = owner.session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn ?? 1
    return agentEvents(ctx, owner).waterfall(
      'agent/request-error',
      { turn, step: 1, provider: 'test', failure, retryPolicy: undefined, signal },
      next,
    ).then(action => action?.kind === 'retry')
  }

  function overflow(message = 'provider overflow'): Error & { code: string } {
    return Object.assign(new Error(message), { code: CONTEXT_WINDOW_EXCEEDED_CODE })
  }

  it('compacts before a step above threshold using the durable routed model and remains idle below it', async () => {
    const ctx = createContext()
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const pressured = conversation(4)
    await preStep(ctx, agent(pressured, 'unconfigured-agent-fallback'))
    expect(pressured.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)

    const small = conversation(1)
    await preStep(ctx, agent(small, MODEL))
    expect(small.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(compact.calls).toHaveLength(1)
  })

  it('skips pre-step pressure when the step signal is already aborted', async () => {
    const ctx = createContext()
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const pressured = conversation(4)
    const compactIfNeeded = vi.spyOn(compact, 'compactIfNeeded')

    await expect(preStep(ctx, agent(pressured, MODEL), AbortSignal.abort('step aborted')))
      .resolves.toEqual({ kind: 'enter', messages: [] })

    expect(compactIfNeeded).not.toHaveBeenCalled()
    expect(pressured.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('warns and continues after operational failures, including non-Errors', async () => {
    const ctx = createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    compact.error = 'temporary failure'
    const session = conversation(4)

    await expect(preStep(ctx, agent(session, MODEL))).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(warnings).toContainEqual(expect.stringContaining('temporary failure'))
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
  })

  it('warns once per routed target when proactive pressure has no context metadata', async () => {
    const ctx = createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation((provider, model) => Promise.resolve({
      provider,
      id: model,
      name: model,
    }))
    void new TestCompactionEngine(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const session = conversation(4)

    await preStep(ctx, agent(session, MODEL))
    await preStep(ctx, agent(session, MODEL))

    expect(warnings).toEqual([
      expect.stringContaining(`no context capacity for ${MODEL}/${MODEL}`),
    ])
  })

  it('warns once per routed target when absolute retention exceeds its resolved threshold', async () => {
    const ctx = createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    void new TestCompactionEngine(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 500,
    })
    const session = conversation(4)

    await preStep(ctx, agent(session, MODEL))
    await preStep(ctx, agent(session, MODEL))

    expect(warnings).toEqual([
      expect.stringContaining('retainTokens (500) must be less than threshold tokens 500'),
    ])
  })

  it('force-compacts below normal pressure for canonical overflow and retries only after replacement', async () => {
    const ctx = createContext(10_000)
    void new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    const session = conversation(3)
    const beforeGeneration = session.surface.replaceGeneration
    const retainedSeq = session.surface.nodes.at(-1)!
    const threshold = 10_000
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(threshold)
    const decision = await recover(ctx, agent(session, 'unconfigured-agent-fallback'), overflow())

    expect(decision).toBe(true)
    expect(session.surface.replaceGeneration).toBe(beforeGeneration + 1)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
    expect(session.surface.nodes).toContain(retainedSeq)
  })

  it('authorizes overflow retry when pruning alone advances an indivisible surface', async () => {
    const ctx = createContext(10_000)
    void new ToolResultPruner(ctx, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    const session = oversizedToolResult()

    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(true)
    expect(session.surface.replaceGeneration).toBe(1)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
    expect(compact.calls).toHaveLength(0)
  })

  it('continues overflow recovery with summarization on the pruned surface', async () => {
    const ctx = createContext(10_000)
    void new ToolResultPruner(ctx, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    const session = toolConversation()

    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(true)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
    expect(compact.calls).toHaveLength(1)
    expect(summarizedText(compact.calls[0]!.input)).toContain('tool result middle pruned')
  })

  it('retries from a durable prune when later overflow summarization throws', async () => {
    const ctx = createContext(10_000)
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    void new ToolResultPruner(ctx, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    compact.error = new Error('summary unavailable after prune')
    const session = oversizedToolResult(3_000, true)

    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(true)
    expect(session.surface.replaceGeneration).toBe(1)
    expect(session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(2)
    expect(session.snapshotEvents().findLast(event => event.type === 'compaction/end')?.data)
      .toMatchObject({ error: 'summary unavailable after prune' })
    expect(warnings).toContainEqual(expect.stringContaining('retrying from the replacement surface'))
  })

  it('lets cancellation win when summary throws after a durable prune', async () => {
    const ctx = createContext(10_000)
    const controller = new AbortController()
    void new ToolResultPruner(ctx, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    compact.mutateDuringSummary = () => { controller.abort('cancelled during summary') }
    compact.error = new Error('summary cancelled after prune')
    const session = oversizedToolResult(3_000, true)

    expect(await recover(ctx, agent(session, MODEL), overflow(), controller.signal)).toBe(false)
    expect(session.surface.replaceGeneration).toBe(1)
  })

  it('preserves the newest whole tool-call/result pair during forced overflow compaction', async () => {
    const ctx = createContext()
    void new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 90,
    })
    const session = toolConversation()
    const newestAssistant = session.surface.nodes.at(-2)!
    const newestResult = session.surface.nodes.at(-1)!

    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(true)
    const currentAssistant = session.surface.nodes.find(node => node === newestAssistant)
    const currentResult = session.surface.nodes.find(node => node === newestResult)
    expect(currentAssistant).toBeDefined()
    expect(currentResult).toBeDefined()
    expect(toolPairingBalancedBefore(session, currentAssistant!)).toBe(true)
    expect(toolPairingBalancedAfter(session, currentResult!)).toBe(true)
  })

  it('does not retry when a backend reports success without replacing the surface', async () => {
    const ctx = createContext()
    const compact = new TestCompactionEngine(ctx)
    const session = conversation(2)
    const fakeResult: CompactionResult = {
      compactionId: CompactionId('fake-compaction'),
      startSeq: SessionSeq(1),
      summarySeq: SessionSeq(2),
      endSeq: SessionSeq(3),
      summary: [{ type: 'text', text: 'fake' }],
      shadowedRange: { start: SessionSeq(1), end: SessionSeq(2) },
      shadowedSeqs: [SessionSeq(1), SessionSeq(2)],
      shadowedTokenCount: 10,
    }
    vi.spyOn(compact, 'compactIfNeeded').mockResolvedValue(fakeResult)

    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(false)
    expect(session.surface.replaceGeneration).toBe(0)
  })

  it('delegates downstream exactly once when no replacement is available', async () => {
    const ctx = createContext()
    const compact = new TestCompactionEngine(ctx)
    vi.spyOn(compact, 'compactIfNeeded').mockResolvedValue(null)
    const downstream = new Error('downstream recovery failed')
    let calls = 0

    await expect(recover(
      ctx,
      agent(conversation(2), MODEL),
      overflow(),
      SIGNAL,
      () => {
        calls += 1
        return Promise.reject(downstream)
      },
    )).rejects.toBe(downstream)
    expect(calls).toBe(1)
  })

  it('preserves the original provider error when recovery throws', async () => {
    const ctx = createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const compact = new TestCompactionEngine(ctx)
    compact.error = new Error('summary unavailable')
    const original = overflow('original provider overflow')

    expect(await recover(ctx, agent(conversation(3), MODEL), original)).toBe(false)
    expect(original).toMatchObject({
      message: 'original provider overflow',
      code: CONTEXT_WINDOW_EXCEEDED_CODE,
    })
    expect(warnings).toContainEqual(expect.stringContaining('preserving the original request error'))
  })

  it('delegates once when overflow recovery throws a non-Error value', async () => {
    const ctx = createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const compact = new TestCompactionEngine(ctx)
    compact.error = 'non-error recovery failure'
    const session = conversation(3)
    const generation = session.surface.replaceGeneration
    const original = overflow('original provider failure')
    let delegations = 0

    const decision = await recover(ctx, agent(session, MODEL), original, SIGNAL, () => {
      delegations += 1
      return Promise.resolve(undefined)
    })

    expect(decision).toBe(false)
    expect(delegations).toBe(1)
    expect(session.surface.replaceGeneration).toBe(generation)
    expect(original).toMatchObject({
      message: 'original provider failure',
      code: CONTEXT_WINDOW_EXCEEDED_CODE,
    })
    expect(warnings).toContainEqual(expect.stringContaining('non-error recovery failure'))
  })

  it('recovers an overflow for an unlisted routed model', async () => {
    const ctx = createContext()
    void new TestCompactionEngine(ctx)
    const session = conversation(2)
    session.append('request/header', {
      header: { config: { provider: 'unknown-routed-provider', model: 'unknown-routed-model' } },
      reason: 'resume',
    })
    expect(await recover(ctx, agent(session, MODEL), overflow('unlisted-model overflow')))
      .toBe(true)
  })

  it('delegates canonical overflow when no durable routed target exists', async () => {
    const ctx = createContext()
    void new TestCompactionEngine(ctx)
    const session = Session.create(SessionId('headerless-overflow'))
    session.append('turn/start', {
      turn: 1,
    })

    await expect(recover(ctx, agent(session, MODEL), overflow())).resolves.toBe(false)
  })

  it('honors retry caps and ignores non-context failures', async () => {
    const ctx = createContext()
    const compact = new TestCompactionEngine(ctx, { maxOverflowRetries: 1 })
    const compactSpy = vi.spyOn(compact, 'compactIfNeeded')
    const owner = agent(conversation(3), MODEL)
    expect(await recover(ctx, owner, Object.assign(new Error('rate limit'), { code: 'RATE_LIMIT' })))
      .toBe(false)
    expect(await recover(ctx, owner, overflow())).toBe(true)
    compactSpy.mockClear()
    expect(await recover(ctx, owner, overflow())).toBe(false)
    expect(compactSpy).not.toHaveBeenCalled()
  })

  it('applies the routed model override to the overflow retry cap', async () => {
    const ctx = createContext()
    const compact = new TestCompactionEngine(ctx, {
      maxOverflowRetries: 2,
      modelPolicies: [{
        provider: MODEL,
        model: MODEL,
        maxOverflowRetries: 1,
      }],
    })
    const compactSpy = vi.spyOn(compact, 'compactIfNeeded')
    const owner = agent(conversation(3), MODEL)

    expect(await recover(ctx, owner, overflow())).toBe(true)
    compactSpy.mockClear()
    expect(await recover(ctx, owner, overflow())).toBe(false)
    expect(compactSpy).not.toHaveBeenCalled()
  })

  it('does not retry when cancellation lands during an awaited compaction', async () => {
    const ctx = createContext()
    const compact = new TestCompactionEngine(ctx)
    const controller = new AbortController()
    compact.mutateDuringSummary = () => { controller.abort('cancelled during summary') }
    const session = conversation(3)
    const generation = session.surface.replaceGeneration

    expect(await recover(ctx, agent(session, MODEL), overflow(), controller.signal)).toBe(false)
    expect(session.surface.replaceGeneration).toBe(generation + 1)
  })

  it('maxOverflowRetries:0 disables recovery without disabling post-step pressure', async () => {
    const ctx = createContext()
    void new TestCompactionEngine(ctx, {
      maxOverflowRetries: 0,
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const session = conversation(4)
    await preStep(ctx, agent(session, MODEL))
    const summaries = session.snapshotEvents().filter(event => event.type === 'compaction/summary').length
    expect(summaries).toBe(1)
    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(false)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(summaries)
  })

  it('auto:false installs neither automatic listener', async () => {
    const ctx = createContext()
    void new TestCompactionEngine(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const session = conversation(4)
    await preStep(ctx, agent(session, MODEL))
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(false)
  })

  it('loads and disposes the real zero-config service stack', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meterFiber = await ctx.plugin(TokenMeter)
    const compactFiber = await ctx.plugin(BasicCompactionEngine, { auto: false })

    expect(ctx.get('compaction')).toBeInstanceOf(BasicCompactionEngine)
    await compactFiber.dispose()
    expect(ctx.get('compaction')).toBeUndefined()
    await meterFiber.dispose()
    expect(ctx.get('tokenMeter')).toBeUndefined()
  })

  it('removes its automatic listener with the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TokenMeter)
    const fiber = await ctx.plugin(TestCompactionEngine, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    await fiber.dispose()

    const session = conversation(4)
    await preStep(ctx, agent(session, MODEL))
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(false)
  })
})

describe('route-priced image pressure', () => {
  const IMAGE_VISUAL_TOKENS = 300
  const IMAGE_HANDLE_TEXT = 'request preview'

  class PricedContextAdapter extends ContextAdapter {
    override imageRequestPricing(): { priceImages: (images: readonly unknown[]) => Array<{ visualTokens: number; text: string }> } {
      return {
        priceImages: images => images.map(() => ({
          visualTokens: IMAGE_VISUAL_TOKENS,
          text: IMAGE_HANDLE_TEXT,
        })),
      }
    }
  }

  function pricedContext(contextWindow = 1_000): Context {
    const ctx = new Context()
    void new LlmRuntime(ctx)
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    ctx.llm.registerAdapter([MODEL], new PricedContextAdapter(contextWindow))
    return ctx
  }

  /** Closed short-text turns whose user messages each carry one image. */
  function imageConversation(turns = 4): Session {
    const session = Session.create(SessionId(`image-dense-${turns}`))
    for (let turn = 1; turn <= turns; turn += 1) {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [
          { type: 'text', text: `image turn ${turn}` },
          {
            type: 'image',
            attachment: {
              attachmentId: AttachmentId(`sha256:${String(turn).repeat(8)}`),
              mediaType: 'image/png',
              bytes: 2048,
              width: 800,
              height: 800,
              name: `shot-${turn}`,
            },
          },
        ],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn, step: 1 })
      if (turn === 1) {
        session.append('request/header', {
          header: { config: { provider: MODEL, model: MODEL } },
          reason: 'initial',
        })
      }
      session.append('assistant/message', {
        turn,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: `ok ${turn}` }],
          source: {
            kind: 'model',
            ...{ provider: MODEL, model: MODEL },
          },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    session.append('turn/start', { turn: turns + 1 })
    return session
  }

  it('selects an image-dense range only when the routed price counts visual tokens', () => {
    const session = imageConversation()
    const routed = pricedContext().tokenMeter.measure(session)
    const neutral = createContext().tokenMeter.measure(session)

    expect(routed.surfaceTokens).toBeGreaterThan(neutral.surfaceTokens + 4 * IMAGE_VISUAL_TOKENS - 200)
    expect(routed.nodes.map(node => node.seq)).toEqual(neutral.nodes.map(node => node.seq))
    expect(routed.nodes.map(node => node.heuristicTokens)).toEqual(neutral.nodes.map(node => node.tokens))

    // The same verbatim tail budget retains almost everything under the
    // neutral heuristic but forces a cut once visual tokens are counted.
    expect(selectCompactableRange(session, neutral, 350)).toBeNull()
    const range = selectCompactableRange(session, routed, 350)
    expect(range).not.toBeNull()
  })

  it('accepts a summary larger than the span heuristic when the route price shrinks', async () => {
    // A single short image message prices below a framed summary under the
    // fixed heuristic but far above it under the route: the shrink comparison
    // must ask whether the replacement lowers route pressure.
    const ctx = pricedContext(1_000)
    const session = imageConversation(1)
    const before = ctx.tokenMeter.measure(session)
    const imageNode = before.nodes[0]!
    const compact = new TestCompactionEngine(ctx, { auto: false })
    compact.summary = [{
      type: 'text',
      text: 'summary text sized between the heuristic and route prices of the shadowed image message, '
        + 'long enough that the fixed heuristic alone would reject it as not smaller '
        + 'while the route-priced comparison accepts the pressure reduction.',
    }]
    const framed = ctx.tokenMeter.estimateMessage(createUserMessage({
      content: frameSummary(compact.summary),
      source: { kind: 'plugin', plugin: 'test' },
    }))
    expect(framed).toBeGreaterThan(imageNode.heuristicTokens)
    expect(framed).toBeLessThan(imageNode.tokens)

    const result = await compact.compactRegion(imageNode.seq, imageNode.seq, agent(session), SIGNAL)
    expect(result.shadowedSeqs).toEqual([imageNode.seq])
    expect(result.shadowedTokenCount).toBe(imageNode.heuristicTokens)
  })

  it('triggers pressure compaction from routed visual tokens and logs heuristic shadow prices', async () => {
    const ctx = pricedContext(1_000)
    const session = imageConversation()
    const before = ctx.tokenMeter.measure(session)
    const compact = new TestCompactionEngine(ctx, {
      auto: false,
      thresholdRatio: 0.8,
      retainTokens: 350,
    })

    // The same history stays below the 800-token threshold without pricing.
    const neutralResult = await compactIfNeeded(service({
      auto: false,
      thresholdRatio: 0.8,
      retainTokens: 350,
    }), session)
    expect(neutralResult).toBeNull()

    const result = await compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)
    expect(result).not.toBeNull()
    const summaryEvent = session.snapshotEvents().find(event => event.type === 'compaction/summary')
    expect(summaryEvent).toBeDefined()
    const shadowedHeuristic = before.nodes
      .filter(node => result?.shadowedSeqs.includes(node.seq))
      .reduce((total, node) => total + node.heuristicTokens, 0)
    expect(summaryEvent?.data.shadowedTokenCount).toBe(shadowedHeuristic)
  })
})
