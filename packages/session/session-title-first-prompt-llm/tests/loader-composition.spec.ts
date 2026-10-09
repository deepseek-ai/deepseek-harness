import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as providerPlugin from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import { anthropicTextEvents, closeMockServers, mockServer } from '../../../llm/llm-pi-ai/tests/mock-server.ts'

let root: string | undefined
let context: Context | undefined

class LoaderAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'Loader composed title' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

/**
 * Boot the title service and the first-prompt provider through the Loader.
 * @param providerConfig - the provider's config lines after its target fields.
 * @param entries - complete further `cordis.yml` entries, as lines.
 * @param entryModules - the modules those entries import.
 * @returns the composed context.
 */
async function loadComposition(
  providerConfig: readonly string[],
  entries: readonly string[] = [],
  entryModules: ReadonlyMap<string, unknown> = new Map(),
): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-title-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-session-title'",
    '  config:',
    '    fallbackMaxWords: 5',
    '    fallbackMaxBytes: 40',
    '    maxTitleBytes: 80',
    "- name: '@deepseek-ai/dsh-session-title-first-prompt-llm'",
    '  config:',
    '    targetWords: 5',
    '    targetCjkCharacters: 10',
    ...providerConfig.map(line => `    ${line}`),
    ...entries,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-title', SessionTitleService],
    ['@deepseek-ai/dsh-session-title-first-prompt-llm', providerPlugin],
    ...entryModules,
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/**
 * Open a fresh session's first turn: one eligible prompt, then its logged main request.
 * @param ctx - the composed context.
 * @param id - the new session id.
 * @param config - the main request's logged call config.
 * @returns the session and the prompt's seq.
 */
async function promptThenRequest(
  ctx: Context,
  id: string,
  config: LlmCallConfig,
): Promise<{ session: Session; messageSeq: SessionSeq }> {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', {
    turn: 1,
  })
  const message = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Compose a title through Loader' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  await new Promise(resolve => setTimeout(resolve, 0))
  session.append('request/header', {
    header: { config },
    reason: 'initial',
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  return { session, messageSeq: message.seq }
}

describe('session-title Loader composition', () => {
  it('loads the service and one model provider with required deployment policy', async () => {
    const ctx = await loadComposition([
      'maxInputBytes: 1000',
      'maxOutputTokens: 32',
      'timeoutMs: 1000',
      "provider: 'title-route'",
      "model: 'title-model'",
    ])
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const adapter = new LoaderAdapter()
    ctx.llm.registerAdapter(['title-route'], adapter)
    const { session, messageSeq } = await promptThenRequest(ctx, 'loader-title', {
      provider: 'main-route',
      model: 'main-model',
    })

    expect(adapter.requests[0]).toMatchObject({ provider: 'title-route', model: 'title-model' })
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'Loader composed title',
      messageSeqs: [messageSeq],
      source: {
        kind: 'provider',
        provider: 'session-title-first-prompt-llm',
        model: { provider: 'title-route', model: 'title-model' },
      },
    })
  })

  it('titles a session on an inherited pi-ai route that cannot stop reasoning', async () => {
    vi.stubEnv('PI_TITLE_KEY', 'test-key')
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await loadComposition([
      'maxInputBytes: 4096',
      'maxOutputTokens: 64',
      'timeoutMs: 60000',
    ], [
      "- name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      gateway:',
      '        apiKeyEnv: PI_TITLE_KEY',
      '        api: anthropic-messages',
      `        baseURL: ${server.url}`,
      '        reasoning: max',
      '        models:',
      '          - id: adaptive-model',
      '            reasoningEfforts: { low: low, high: high, max: max }',
      '            compat:',
      '              forceAdaptiveThinking: true',
    ], new Map([['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi]]))

    const { session, messageSeq } = await promptThenRequest(ctx, 'pi-ai-title', {
      provider: 'gateway',
      model: 'adaptive-model',
      reasoningEffort: ReasoningEffortId('max'),
    })
    await vi.waitFor(() => {
      expect(ctx.sessionTitle.get(session)?.source.kind).toBe('provider')
    }, { timeout: 10_000 })

    // The title request inherits the route but not its effort, so the
    // output cap holds the visible title instead of max-effort thinking.
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      model: 'adaptive-model',
      max_tokens: 64,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    })
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'hello',
      messageSeqs: [messageSeq],
      source: {
        kind: 'provider',
        provider: 'session-title-first-prompt-llm',
        model: { provider: 'gateway', model: 'adaptive-model' },
      },
    })
  })
})
