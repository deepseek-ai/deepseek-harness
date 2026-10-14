/** Prompt stability of the harness checkout and Web GUI URL across processes, checkouts, and ports. */

import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  createUserMessage, LlmAdapter,
  type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk, type SystemPromptUpdate,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as HarnessDevContext from '../src/index.ts'

const SOURCE_PROMPT = 'The runtime context names the DeepSeek Harness implementation checkout. The checkout location and current working directory are separate values and may differ; never infer the working directory from the checkout path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.'
const WEB_GUIDANCE = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
  + 'The browser provides no implicit DOM, route, or screenshot context. '
  + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
  + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
  + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  + 'Starting another server does not update this GUI. '
  + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
  + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
const WEB_PROMPT = `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. ${WEB_GUIDANCE}`

/** The value-bearing paragraphs earlier releases rendered. */
const LEGACY_SOURCE = 'The DeepSeek Harness implementation checkout is at /old/checkout/. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.'
// Frozen as earlier releases rendered it, independent of the current guidance.
const LEGACY_WEB = 'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:3100. '
  + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
  + 'The browser provides no implicit DOM, route, or screenshot context. '
  + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
  + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
  + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  + 'Starting another server does not update this GUI. '
  + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
  + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'

/** Records every request and answers each with one short text reply. */
class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly systemPromptUpdate: SystemPromptUpdate | undefined) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      ...this.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: this.systemPromptUpdate },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const ROUTE = { provider: 'route', model: 'model' }

/** The Web GUI service with a port the test can move, as restarted processes see it. */
function provideWebServices(ctx: Context): { port: number } {
  const listener = { port: 4567 }
  ctx.provide('webApp', {
    getAdvertisedUrl: () => `http://127.0.0.1:${String(listener.port)}`,
  } satisfies Context['webApp'])
  return listener
}

/** A production AgentLoop with this plugin mounted. */
async function promptLoop(systemPromptUpdate: SystemPromptUpdate | undefined) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const listener = provideWebServices(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new RecordingAdapter(systemPromptUpdate)
  ctx.llm.registerAdapter([ROUTE.provider], adapter)
  await ctx.plugin(HarnessDevContext)
  const harness = await mountAgentLoopTestHarness(ctx)
  /** Resume the Session's complete log under a new Agent, as a restarted process does. */
  const resume = async (session: Session, id: string): Promise<Agent> => (await ctx.agents.create({
    sessionId: SessionId(id), agentOptions: ROUTE, seed: [...session.snapshotEvents()],
  })).agent
  /** One turn under an earlier release: the given paragraphs and no value contexts. */
  const earlierSession = async (source = LEGACY_SOURCE, web = LEGACY_WEB): Promise<Agent> => {
    const earlierRelease = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return {
        ...assembly,
        sections: assembly.sections.map(section => section.name === 'harness:source' ? { ...section, text: source }
          : section.name === 'app:web-surface' ? { ...section, text: web } : section),
        contexts: assembly.contexts.filter(entry => entry.name !== 'harness:source' && entry.name !== 'app:web-surface'),
      }
    })
    const agent = await harness.create(SessionId('earlier'), ROUTE)
    await send(agent, 'before the upgrade')
    earlierRelease()
    return agent
  }
  return { ctx, listener, adapter, harness, resume, earlierSession }
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Every committed system prompt version in event order; a cleared version is `''`. */
function systemPrompts(session: Session): string[] {
  return session.snapshotEvents().flatMap(event => event.type === 'system/message'
    ? [event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')]
    : [])
}

function latestRuntimeContext(session: Session): string | undefined {
  const event = session.snapshotEvents().findLast(entry => entry.type === 'user/message'
    && entry.data.source.kind === 'runtime-context')
  const block = event?.type === 'user/message' ? event.data.content[0] : undefined
  return block?.type === 'text' ? block.text : undefined
}

function requestSystemPrompts(request: GenerateOptions | undefined): string[] {
  return (request?.messages ?? []).filter(message => message.role === 'system')
    .flatMap(message => message.content.map(block => block.type === 'text' ? block.text : ''))
}

describe('harness-dev-context', () => {
  it('registers value-free sections and reports the checkout and Web GUI URL as runtime context', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    provideWebServices(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const fiber = ctx.plugin(HarnessDevContext)
    await fiber
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.filter(entry => entry.name === 'harness:source' || entry.name === 'app:web-surface')
      .map(entry => entry.text)).toEqual([SOURCE_PROMPT, WEB_PROMPT])
    expect(renderPrompt(assembly)).not.toContain('127.0.0.1')
    expect(renderContextSnapshot(assembly).split('\n\n').slice(1)).toEqual([
      expect.stringMatching(/^Current DeepSeek Harness implementation checkout: ".+"\.$/u),
      'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:4567".',
    ])

    await fiber.dispose()
    const disposed = await ctx.systemPrompt.assemble()
    expect(disposed.sections.some(entry => entry.name === 'harness:source' || entry.name === 'app:web-surface')).toBe(false)
    expect(disposed.contexts).toEqual([])
  })

  it.each([
    { route: 'replace-only', systemPromptUpdate: undefined },
    { route: 'in-history', systemPromptUpdate: 'in-history' as const },
  ])('resumes an earlier-format Session on other ports without rewriting its system prompt ($route)', async ({ systemPromptUpdate }) => {
    const h = await promptLoop(systemPromptUpdate)
    const original = await h.earlierSession()
    const logged = systemPrompts(original.session)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(LEGACY_SOURCE)
    expect(logged[0]).toContain(LEGACY_WEB)

    let session = original.session
    for (const port of [4568, 4569]) {
      h.listener.port = port
      const resumed = await h.resume(session, `earlier-on-${String(port)}`)
      await send(resumed, `after the upgrade on ${String(port)}`)
      expect(systemPrompts(resumed.session)).toEqual(logged)
      expect(requestSystemPrompts(h.adapter.requests.at(-1))).toEqual(logged)
      expect(latestRuntimeContext(resumed.session))
        .toContain(`Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:${String(port)}".`)
      expect(latestRuntimeContext(resumed.session)).toContain('Current DeepSeek Harness implementation checkout: "')
      session = resumed.session
    }
  })

  it('keeps earlier paragraphs after a series consolidation empties a later prompt version', async () => {
    const h = await promptLoop('in-history')
    const resumed = await h.resume((await h.earlierSession()).session, 'earlier-consolidated')
    const [earlier] = systemPrompts(resumed.session)
    const update = h.ctx.systemPrompt.section({ name: 'test:update', order: 0, text: 'Updated instruction.' })
    await send(resumed, 'append the update')
    expect(systemPrompts(resumed.session)).toHaveLength(2)
    update()
    h.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind === 'enter' ? { ...decision, startsRequestSeries: true } : decision
    })
    // The head already matches, so consolidation logs only the emptied later version.
    await send(resumed, 'start a new series')
    expect(systemPrompts(resumed.session)).toEqual([earlier, expect.stringContaining('Updated instruction.'), ''])
    await send(resumed, 'continue the series')
    expect(systemPrompts(resumed.session)).toHaveLength(3)
    expect(requestSystemPrompts(h.adapter.requests.at(-1))).toEqual([earlier])
  })

  it.each([
    { variant: 'a paragraph without the fixed ending', source: 'The DeepSeek Harness implementation checkout is at /old/checkout/.' },
    { variant: 'a paragraph broken across lines', source: LEGACY_SOURCE.replace('/old/checkout/', '/old/\ncheckout/') },
  ])('replaces text that only resembles an earlier paragraph: $variant', async ({ source }) => {
    const h = await promptLoop(undefined)
    const original = await h.earlierSession(source, WEB_PROMPT)
    const resumed = await h.resume(original.session, 'resembling')
    await send(resumed, 'after the upgrade')
    const current = systemPrompts(resumed.session).at(-1)
    expect(current).toContain(SOURCE_PROMPT)
    expect(current).not.toContain('/old/')
  })

  it('keeps a new Session system prompt free of process values across ports', async () => {
    const h = await promptLoop(undefined)
    const agent = await h.harness.create(SessionId('fresh'), ROUTE)
    await send(agent, 'first')
    const logged = systemPrompts(agent.session)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(SOURCE_PROMPT)
    expect(logged[0]).toContain(WEB_PROMPT)
    expect(logged[0]).not.toContain('127.0.0.1')
    expect(latestRuntimeContext(agent.session)).toContain('Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:4567".')

    h.listener.port = 4568
    const resumed = await h.resume(agent.session, 'fresh-on-4568')
    await send(resumed, 'second')
    expect(systemPrompts(resumed.session)).toEqual(logged)
    expect(latestRuntimeContext(resumed.session)).toContain('Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:4568".')
  })
})
