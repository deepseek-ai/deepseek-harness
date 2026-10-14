import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import SessionTitleService, { type SessionTitleProvider } from '@deepseek-ai/dsh-session-title'
import * as providerPlugin from '@deepseek-ai/dsh-session-title-first-prompt-llm'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[] = FIRST_TITLE_SCRIPT,
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
        : { reasoning: { efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })) } },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script
  }
}

const FIRST_TITLE_SCRIPT: StreamChunk[] = [
  { type: 'text-delta', index: 0, text: 'First-message model title' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const TITLE_CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } as const
const LLM_CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
  provider: 'title-route',
  model: 'title-model',
} as const

/** Exact first-prompt system instruction pinned here so a shared prompt cannot change it silently. */
const SYSTEM = [
  'Create a concise title for an AI coding-assistant session from the supplied human messages.',
  'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
  'Use the language of the messages.',
  'Aim for about 5 words in non-CJK languages or 10 CJK characters.',
  'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
].join('\n')

interface Harness {
  ctx: Context
  adapter: RecordingAdapter
}

async function harness(
  script: readonly StreamChunk[] = FIRST_TITLE_SCRIPT,
  reasoningEfforts?: readonly string[],
): Promise<Harness> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(SessionTitleService, TITLE_CONFIG)
  const adapter = new RecordingAdapter(script, reasoningEfforts)
  ctx.llm.registerAdapter(['title-route'], adapter)
  await ctx.plugin(providerPlugin, LLM_CONFIG)
  return { ctx, adapter }
}

function appendHumanPrompt(session: Session, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function textOf(options: GenerateOptions | undefined): string {
  const content = options?.messages[0]?.content[0]
  if (content?.type !== 'text') throw new Error('expected a title input text block')
  return content.text
}

describe('first-prompt LLM title provider', () => {
  it('registers itself and always selects only the first eligible human message, including refresh', async () => {
    const { ctx, adapter } = await harness()
    const session = ctx.sessions.create(SessionId('first-plugin'))
    session.append('turn/start', { turn: 1 })
    const first = appendHumanPrompt(session, 'first input')
    await settle()
    session.append('request/header', {
      header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial',
    })
    await settle()
    appendHumanPrompt(session, 'second input must be ignored')
    await settle()

    await ctx.sessionTitle.refresh(session)

    expect(adapter.requests).toHaveLength(2)
    for (const options of adapter.requests) {
      const text = textOf(options)
      expect(text).toBe(`Generate the session title from this JSON array of human messages:\n${JSON.stringify([
        { seq: first.seq, text: 'first input' },
      ])}`)
      expect(text).not.toContain('currentTitle')
      expect(options.system).toBe(SYSTEM)
      expect(options.system).not.toContain('return it exactly unchanged')
    }
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'First-message model title',
      messageSeqs: [first.seq],
      source: { kind: 'provider', provider: providerPlugin.name, model: { provider: 'title-route', model: 'title-model' } },
    })
  })

  it('frames the first message as data and logs the exact system and input', async () => {
    const { ctx, adapter } = await harness()
    const session = ctx.sessions.create(SessionId('first-logging'))
    const first = appendHumanPrompt(session, 'Room "quote" and 番茄')

    await ctx.sessionTitle.refresh(session)

    const options = adapter.requests[0]!
    const prompt = options.messages[0]?.content[0]
    expect(prompt?.type === 'text' && prompt.text).toBe(
      `Generate the session title from this JSON array of human messages:\n${JSON.stringify([
        { seq: first.seq, text: 'Room "quote" and 番茄' },
      ])}`,
    )
    expect(options.system).toBe(SYSTEM)
    expect(session.snapshotEvents().findLast(event => event.type === 'session/title-llm-request')?.data)
      .toEqual({
        titleProvider: providerPlugin.name,
        messageSeqs: [first.seq],
        route: { provider: 'title-route', model: 'title-model' },
        system: SYSTEM,
        messages: options.messages,
        maxTokens: 32,
      })
  })

  it('selects the route least supported reasoning effort for its own model calls', async () => {
    const { ctx, adapter } = await harness(FIRST_TITLE_SCRIPT, ['low', 'high'])
    const session = ctx.sessions.create(SessionId('first-floor-effort'))
    appendHumanPrompt(session, 'first input')

    await ctx.sessionTitle.refresh(session)

    expect(adapter.requests[0]?.reasoningEffort).toBe(ReasoningEffortId('low'))
  })

  it.each([
    [['**Continuing Previous', ' Session**\n\nThe only message is "continue".'], 'Continuing Previous Session'],
    [['\n  *Greeting*  \n'], 'Greeting'],
    [['**a** and **b**\nnote'], '**a** and **b**'],
    [['Use **bold** for emphasis'], 'Use **bold** for emphasis'],
    [['Fix *args* handling'], 'Fix *args* handling'],
    [['*args'], '*args'],
    [['****'], '****'],
  ])('takes the title from the first non-empty output line %j', async (deltas, title) => {
    const { ctx } = await harness([
      { type: 'block-start', index: 0, blockType: 'text' },
      ...deltas.map((text): StreamChunk => ({ type: 'text-delta', index: 0, text })),
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const session = ctx.sessions.create(SessionId(`first-parse-${title}`))
    appendHumanPrompt(session, 'first input')

    await ctx.sessionTitle.refresh(session)

    expect(ctx.sessionTitle.get(session)?.title).toBe(title)
  })

  it('rejects tool-calls and max-tokens termination even when the blocks contain only text', async () => {
    const toolCalls = await harness([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Title from text' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const toolCallsSession = toolCalls.ctx.sessions.create(SessionId('first-tool-calls-finish'))
    appendHumanPrompt(toolCallsSession, 'first input')
    await expect(toolCalls.ctx.sessionTitle.refresh(toolCallsSession)).rejects.toThrow(/output must contain text only/)

    const maxTokens = await harness([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Partial title' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const maxTokensSession = maxTokens.ctx.sessions.create(SessionId('first-max-tokens-finish'))
    appendHumanPrompt(maxTokensSession, 'first input')
    await expect(maxTokens.ctx.sessionTitle.refresh(maxTokensSession)).rejects.toThrow(/reached maxOutputTokens/)
  })

  it('rejects tool-call blocks and a successful response with no text', async () => {
    const tool = await harness([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('title-tool'), name: 'unexpected', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const toolSession = tool.ctx.sessions.create(SessionId('first-tool'))
    appendHumanPrompt(toolSession, 'first input')
    await expect(tool.ctx.sessionTitle.refresh(toolSession)).rejects.toThrow(/output must contain text only/)

    const reasoning = await harness([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'no final title' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const reasoningSession = reasoning.ctx.sessions.create(SessionId('first-reasoning'))
    appendHumanPrompt(reasoningSession, 'first input')
    await expect(reasoning.ctx.sessionTitle.refresh(reasoningSession)).rejects.toThrow(/produced no text/)
  })

  it('requires positive target settings and rejects unknown configuration keys', () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    expect(() => { providerPlugin.apply(ctx, { ...LLM_CONFIG, targetWords: 0 }) })
      .toThrow(/targetWords.*positive integer/)
    expect(() => { providerPlugin.apply(ctx, { ...LLM_CONFIG, targetCjkCharacters: 1.5 }) })
      .toThrow(/targetCjkCharacters.*positive integer/)
    expect(() => { providerPlugin.apply(ctx, { ...LLM_CONFIG, extra: true } as never) })
      .toThrow(/unknown config key "extra"/)
  })

  it('rejects an impossible empty provider request at its own boundary', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    // Delegate to the real registration while capturing it, to reach the guard
    // the service never produces.
    let registered: SessionTitleProvider | undefined
    const register = ctx.sessionTitle.register.bind(ctx.sessionTitle)
    ctx.sessionTitle.register = (provider) => {
      registered = provider
      return register(provider)
    }
    await ctx.plugin(providerPlugin, LLM_CONFIG)
    await expect(registered!.generate({
      session: Session.create(SessionId('empty-first-provider')),
      messages: [],
      signal: new AbortController().signal,
    })).rejects.toThrow(/requires one human message/)
  })
})
