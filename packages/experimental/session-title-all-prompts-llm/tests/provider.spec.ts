import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import SessionTitleService, {
  SessionTitleProviderId,
  type SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'
import * as providerPlugin from '@deepseek-ai/dsh-session-title-all-prompts-llm'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[] = ALL_TITLE_SCRIPT,
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

const ALL_TITLE_SCRIPT: StreamChunk[] = [
  { type: 'text-delta', index: 0, text: 'All messages model title' },
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
const INHERITED_LLM_CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
} as const

const SYSTEM_BASE = [
  'Create a concise title for an AI coding-assistant session from the supplied human messages.',
  'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
  'Use the language of the messages.',
  'Aim for about 5 words in non-CJK languages or 10 CJK characters.',
  'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
].join('\n')
const SYSTEM_WITH_TITLE = `${SYSTEM_BASE}\n${[
  'An existing title is supplied as currentTitle. If it still accurately describes the main topic or task, return it exactly unchanged.',
  'Follow-up questions, additional details within the same topic, acknowledgements such as "thanks", and requests to continue do not by themselves justify a title change.',
  'Do not reword, polish, shorten, or replace synonyms in an adequate title. Keeping its exact wording takes priority over the target length.',
  'Change the title only when the messages materially change or expand the main topic or task so that the existing title is no longer accurate.',
].join('\n')}`

interface Harness {
  ctx: Context
  adapter: RecordingAdapter
}

async function harness(
  config: typeof LLM_CONFIG | typeof INHERITED_LLM_CONFIG = LLM_CONFIG,
  script: readonly StreamChunk[] = ALL_TITLE_SCRIPT,
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
  await ctx.plugin(providerPlugin, config)
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

function initialInput(messages: readonly SessionTitleUserMessage[]): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

function revisionInput(currentTitle: string, messages: readonly SessionTitleUserMessage[]): string {
  return `Update the session title from this JSON object:\n${JSON.stringify({ currentTitle, messages })}`
}

describe('all-messages LLM title provider', () => {
  it('anchors currentTitle only for an accepted provider title and keeps initial generation otherwise', async () => {
    const { ctx, adapter } = await harness()

    const fallbackSession = ctx.sessions.create(SessionId('all-source-fallback'))
    const fallbackMessage = appendHumanPrompt(fallbackSession, '阳台种番茄和罗勒')
    await ctx.sessionTitle.refresh(fallbackSession)
    const fallbackOptions = adapter.requests.at(-1)!
    expect(textOf(fallbackOptions)).toBe(initialInput([
      { seq: fallbackMessage.seq, text: '阳台种番茄和罗勒' },
    ]))
    expect(fallbackOptions.system).toBe(SYSTEM_BASE)

    const userSession = ctx.sessions.create(SessionId('all-source-user'))
    const userMessage = appendHumanPrompt(userSession, '阳台种番茄和罗勒')
    ctx.sessionTitle.rename(userSession, '用户标题')
    await ctx.sessionTitle.refresh(userSession)
    const userOptions = adapter.requests.at(-1)!
    expect(textOf(userOptions)).toBe(initialInput([{ seq: userMessage.seq, text: '阳台种番茄和罗勒' }]))
    expect(userOptions.system).toBe(SYSTEM_BASE)

    await ctx.sessionTitle.refresh(fallbackSession)
    const revisionOptions = adapter.requests.at(-1)!
    expect(textOf(revisionOptions)).toBe(revisionInput('All messages model title', [
      { seq: fallbackMessage.seq, text: '阳台种番茄和罗勒' },
    ]))
    expect(revisionOptions.system).toBe(SYSTEM_WITH_TITLE)

    const foreignSession = ctx.sessions.create(SessionId('all-source-foreign'))
    const foreignMessage = appendHumanPrompt(foreignSession, '阳台种番茄和罗勒')
    foreignSession.append('session/title', {
      title: '前一个提供方标题',
      messageSeqs: [foreignMessage.seq],
      source: { kind: 'provider', provider: SessionTitleProviderId('previous-provider') },
    })
    await ctx.sessionTitle.refresh(foreignSession)
    const foreignOptions = adapter.requests.at(-1)!
    expect(textOf(foreignOptions)).toBe(revisionInput('前一个提供方标题', [
      { seq: foreignMessage.seq, text: '阳台种番茄和罗勒' },
    ]))
    expect(foreignOptions.system).toBe(SYSTEM_WITH_TITLE)
  })

  it('includes seeded history and the latest prompt while inheriting the logged request route', async () => {
    const seeded = Session.create(SessionId('seed-source'))
    seeded.append('turn/start', { turn: 1 })
    const inherited = seeded.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'inherited prompt' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    seeded.append('session/title', {
      title: 'Inherited fallback', messageSeqs: [inherited.seq], source: { kind: 'fallback' },
    })
    seeded.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const { ctx, adapter } = await harness(INHERITED_LLM_CONFIG)
    const session = ctx.sessions.create(SessionId('all-plugin'), {
      seed: seeded.snapshotEvents(),
      inheritedEventCount: seeded.seq,
      meta: { parentSession: seeded.id, isSeeded: true },
    })
    session.append('turn/start', { turn: 2 })
    const latest = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'latest prompt' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await settle()
    session.append('request/header', {
      header: { config: { provider: 'title-route', model: 'title-model' } }, reason: 'resume',
    })
    await settle()

    expect(adapter.requests[0]).toMatchObject({ provider: 'title-route', model: 'title-model' })
    const options = adapter.requests[0]!
    expect(textOf(options)).toBe(initialInput([
      { seq: inherited.seq, text: 'inherited prompt' },
      { seq: latest.seq, text: 'latest prompt' },
    ]))
    expect(options.system).toBe(SYSTEM_BASE)
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'All messages model title',
      messageSeqs: [inherited.seq, latest.seq],
      source: { kind: 'provider', provider: providerPlugin.name },
    })
  })

  it('takes the initial-generation path when no fallback is derivable and no title exists', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    // A one-byte fallback cap cannot derive a title from the multibyte message,
    // so the service supplies no currentTitle to the provider.
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 1, maxTitleBytes: 80 })
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['title-route'], adapter)
    await ctx.plugin(providerPlugin, LLM_CONFIG)
    const session = ctx.sessions.create(SessionId('absent-current-title'))
    const message = appendHumanPrompt(session, '番')

    await ctx.sessionTitle.refresh(session)

    expect(textOf(adapter.requests[0])).toBe(initialInput([{ seq: message.seq, text: '番' }]))
    expect(adapter.requests[0]?.system).toBe(SYSTEM_BASE)
  })

  it('selects the route least supported reasoning effort for its own model calls', async () => {
    const { ctx, adapter } = await harness(LLM_CONFIG, ALL_TITLE_SCRIPT, ['low', 'high'])
    const session = ctx.sessions.create(SessionId('all-floor-effort'))
    appendHumanPrompt(session, 'first prompt')

    await ctx.sessionTitle.refresh(session)

    expect(adapter.requests[0]?.reasoningEffort).toBe(ReasoningEffortId('low'))
  })

  it.each([
    [['**Continuing Previous', ' Session**\n\nthe only message is "continue".'], 'Continuing Previous Session'],
    [['\n  *Greeting*  \n'], 'Greeting'],
    [['**a** and **b**\nnote'], '**a** and **b**'],
    [['Fix *args* handling'], 'Fix *args* handling'],
    [['*args'], '*args'],
  ])('takes the title from the first non-empty output line %j', async (deltas, title) => {
    const { ctx } = await harness(LLM_CONFIG, [
      { type: 'block-start', index: 0, blockType: 'text' },
      ...deltas.map((text): StreamChunk => ({ type: 'text-delta', index: 0, text })),
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const session = ctx.sessions.create(SessionId(`all-parse-${title}`))
    appendHumanPrompt(session, 'first prompt')

    await ctx.sessionTitle.refresh(session)

    expect(ctx.sessionTitle.get(session)?.title).toBe(title)
  })

  it('rejects tool-calls and max-tokens termination even when the blocks contain only text', async () => {
    const toolCalls = await harness(LLM_CONFIG, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Title from text' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const toolCallsSession = toolCalls.ctx.sessions.create(SessionId('all-tool-calls-finish'))
    appendHumanPrompt(toolCallsSession, 'first prompt')
    await expect(toolCalls.ctx.sessionTitle.refresh(toolCallsSession)).rejects.toThrow(/output must contain text only/)

    const maxTokens = await harness(LLM_CONFIG, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Partial title' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const maxTokensSession = maxTokens.ctx.sessions.create(SessionId('all-max-tokens-finish'))
    appendHumanPrompt(maxTokensSession, 'first prompt')
    await expect(maxTokens.ctx.sessionTitle.refresh(maxTokensSession)).rejects.toThrow(/reached maxOutputTokens/)
  })

  it('rejects tool-call blocks and a successful response with no text', async () => {
    const tool = await harness(LLM_CONFIG, [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('title-tool'), name: 'unexpected', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const toolSession = tool.ctx.sessions.create(SessionId('all-tool'))
    appendHumanPrompt(toolSession, 'first prompt')
    await expect(tool.ctx.sessionTitle.refresh(toolSession)).rejects.toThrow(/output must contain text only/)

    const reasoning = await harness(LLM_CONFIG, [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'no final title' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const reasoningSession = reasoning.ctx.sessions.create(SessionId('all-reasoning'))
    appendHumanPrompt(reasoningSession, 'first prompt')
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

  it('preserves an accepted title unchanged when the model returns it verbatim', async () => {
    const { ctx, adapter } = await harness(LLM_CONFIG, [
      { type: 'text-delta', index: 0, text: '阳台种番茄与罗勒' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const session = ctx.sessions.create(SessionId('all-stability'))
    const first = appendHumanPrompt(session, '我想在阳台种番茄和罗勒，请给入门建议。')
    await ctx.sessionTitle.refresh(session)
    expect(ctx.sessionTitle.get(session)?.title).toBe('阳台种番茄与罗勒')

    const second = appendHumanPrompt(session, '花盆要多大？')
    const accepted = await ctx.sessionTitle.refresh(session)

    expect(accepted).toMatchObject({
      title: '阳台种番茄与罗勒',
      messageSeqs: [first.seq, second.seq],
      source: { kind: 'provider', provider: providerPlugin.name },
    })
    expect(adapter.requests.at(-1)?.system).toBe(SYSTEM_WITH_TITLE)
    expect(textOf(adapter.requests.at(-1))).toContain('"currentTitle":"阳台种番茄与罗勒"')
  })
})
