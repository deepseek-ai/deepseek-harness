/**
 * Real Messages round trips use the official root and require credentials.
 * System-update checks additionally require DEEPSEEK_IN_HISTORY_MODEL.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import LlmRuntime, { BlockAssembler, createSystemMessage, createToolResultMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as PluginPackageInventoryDeepSeek from '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionLogDeepSeek from '@deepseek-ai/dsh-session-log-deepseek'
import * as Messages from '../../src/index.ts'
import { DeepSeekFilesClient } from '../../src/common/files-api.ts'
import { MESSAGES_FILES_BETA } from '../../src/common/messages-api.ts'
import { assemble, options, user } from './helpers.ts'

const IN_HISTORY_MODEL = process.env.DEEPSEEK_IN_HISTORY_MODEL
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
async function boot(models?: Messages.Config['models']) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-messages-e2e-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Messages, {
    baseURL: Messages.MESSAGES_BASE_URL,
    maxTokens: 4096,
    ...models === undefined ? {} : { models },
  })
  return ctx
}
const tool = { name: 'lookup_value', description: 'Read the requested value. Always call this tool to obtain a value.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('DeepSeek Messages real API', () => {
  it.skipIf(!IN_HISTORY_MODEL).each([false, true])('updates system instructions during a conversation, in-history=%s', async (inHistory) => {
    const model = IN_HISTORY_MODEL as string
    // Each case owns the capability, even for a model with an in-history catalog default.
    const ctx = await boot([{ id: model, ...inHistory ? { systemPromptUpdate: 'in-history' as const } : {} }])
    const history: Message[] = [createSystemMessage('Reply to every user message with exactly PROMPT_FIRST.', 'test'), user('Answer now.')]
    const reply = async (expected: string) => {
      const saved = JSON.stringify(history)
      const response = await assemble(ctx.llm.stream(options({ model, messages: history, reasoningEffort: ReasoningEffortId('high') })), model)
      expect(response.assembler.finish.kind).toBe('stop')
      expect(response.message.content.filter(block => block.type === 'text').map(block => block.text).join('')).toContain(expected)
      expect(JSON.stringify(history)).toBe(saved)
      history.push(response.message)
    }
    await reply('PROMPT_FIRST')
    history.push(createSystemMessage('Reply to every user message with exactly PROMPT_SECOND.', 'test'), user('Answer again.'))
    await reply('PROMPT_SECOND')
    const withoutSystem = history.filter(message => message.role !== 'system')
    history.splice(0, history.length, createSystemMessage('', 'test'), ...withoutSystem, user('Reply with exactly PROMPT_CLEARED.'))
    await reply('PROMPT_CLEARED')
  })

  it('uploads, lists, retrieves, reuses, and replaces a deleted Files image across Messages requests', async () => {
    const ctx = await boot()
    await ctx.plugin(LocalAttachments)
    const fetchImpl = globalThis.fetch
    const uploads: string[] = []
    const bodies: string[] = []
    const files = new DeepSeekFilesClient({ baseURL: Messages.MESSAGES_BASE_URL, protocol: 'messages', apiKey: process.env.DEEPSEEK_API_KEY as string, fetch: fetchImpl })
    const ownedFiles = new Set<ReturnType<typeof Messages.DeepSeekFileId>>()
    cleanups.push(async () => {
      for (const id of ownedFiles) await files.delete(id)
    })
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const response = await fetchImpl(input, init)
      if (url === `${Messages.MESSAGES_BASE_URL}/v1/files` && init?.method === 'POST' && response.ok) {
        const file = await response.clone().json() as { id: string }
        uploads.push(file.id)
        ownedFiles.add(Messages.DeepSeekFileId(file.id))
      }
      if (url === `${Messages.MESSAGES_BASE_URL}/v1/messages`) {
        expect(new Headers(init?.headers).get('anthropic-beta')).toBe(MESSAGES_FILES_BETA)
        if (typeof init?.body !== 'string') throw new Error('expected a JSON Messages request')
        bodies.push(init.body)
      }
      return response
    })
    const attachment = await ctx.attachments.saveImage({ data: await readFile(new URL('fixtures/red.png', import.meta.url)), mediaType: 'image/png' })
    const message = user('What is the dominant color of this image? Reply with one English color word.')
    const request = options({
      model: 'deepseek-flash', reasoningEffort: ReasoningEffortId('off'),
      messages: [{ ...message, content: [...message.content, { type: 'image', attachment }] }],
    })
    for (let run = 0; run < 2; run++) {
      const result = await assemble(ctx.llm.stream(request), request.model)
      expect(result.assembler.finish.kind).toBe('stop')
      expect(result.message.content.filter(block => block.type === 'text').map(block => block.text).join('').toLowerCase()).toContain('red')
    }
    expect(uploads).toHaveLength(1)
    expect(bodies).toHaveLength(2)
    expect(bodies.every(body => body.includes(`"file_id":"${uploads[0]}"`) && !body.includes('"type":"base64"'))).toBe(true)
    const fileId = Messages.DeepSeekFileId(uploads[0]!)
    const retrieved = await files.retrieve(fileId)
    expect(retrieved).toMatchObject({ id: fileId, bytes: attachment.bytes, purpose: 'user_data' })
    expect(retrieved.expiresAt).toBeUndefined()
    let page = await files.list({ limit: 1_000 })
    const cursors = new Set<string>()
    while (!page.data.some(file => file.id === fileId) && page.hasMore) {
      expect(page.lastId).toBeDefined()
      const after = page.lastId!
      expect(cursors.has(after)).toBe(false)
      cursors.add(after)
      page = await files.list({ after, limit: 1_000 })
    }
    expect(page.data).toContainEqual(retrieved)
    await files.delete(fileId)
    ownedFiles.delete(fileId)
    const recovered = await assemble(ctx.llm.stream(request), request.model)
    expect(recovered.assembler.finish.kind).toBe('stop')
    expect(recovered.message.content.filter(block => block.type === 'text').map(block => block.text).join('').toLowerCase()).toContain('red')
    expect(uploads).toHaveLength(2)
    expect(uploads[1]).not.toBe(fileId)
    expect(bodies).toHaveLength(4)
    expect(bodies[2]).toContain(`"file_id":"${fileId}"`)
    expect(bodies[3]).toContain(`"file_id":"${uploads[1]}"`)
    expect(bodies[3]).not.toContain('"type":"base64"')
  })

  it.each([false, true])('submits Loader package inventory and records HTTP acceptance with session-log enabled=%s', async (enabled) => {
    const ctx = await boot()
    await ctx.plugin(Loader)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
    await ctx.plugin(SessionLogDeepSeek, enabled ? {} : { enabled: false })
    ctx.baseUrl = import.meta.url
    // Select the source module while Loader owns its active package entry.
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@deepseek-ai/dsh-plugin-package-inventory-deepseek') throw new Error(`unexpected Loader import: ${specifier}`)
        return PluginPackageInventoryDeepSeek
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: '@deepseek-ai/dsh-plugin-package-inventory-deepseek' })
    await ctx.loader.await()
    const packageIdentity = JSON.parse(await readFile(new URL('../../../plugin-package-inventory-deepseek/package.json', import.meta.url), 'utf8')) as { name: string; version: string }
    const session = ctx.sessions.create(SessionId(`real-messages-extensions-${randomUUID()}`))
    session.append('turn/start', { turn: 1 })
    const fetchImpl = globalThis.fetch
    let afterSeq: number = -1
    let throughSeq = 0
    let requests = 0
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== `${Messages.MESSAGES_BASE_URL}/v1/messages`) return fetchImpl(input, init)
      if (typeof init?.body !== 'string') throw new Error('expected a JSON Messages request')
      const body = JSON.parse(init.body) as Record<string, unknown>
      expect(body).toMatchObject({ dsh_plugin_packages: {
        version: 1, packages: [{ name: packageIdentity.name, version: packageIdentity.version }],
      } })
      if (enabled) {
        expect(body).toMatchObject({ dsh_session_log: {
          version: 1, sessionFormatVersion: session.header.version, session: { id: session.id },
          afterSeq, throughSeq,
          events: Array.from({ length: throughSeq - afterSeq }, (_, index) => ({ seq: afterSeq + index + 1 })),
        } })
      } else expect(body).not.toHaveProperty('dsh_session_log')
      expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(afterSeq)
      const response = await fetchImpl(input, init)
      expect(response.ok).toBe(true)
      expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(afterSeq)
      requests += 1
      return response
    })
    for (let run = 0; run < 2; run++) {
      afterSeq = SessionLogDeepSeek.acceptedThrough(session)
      throughSeq = Number(session.seq) - 1
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream(options({ sessionId: session.id, reasoningEffort: ReasoningEffortId('off'), messages: [user('Reply with exactly PONG.')] }))) {
        expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(enabled ? throughSeq : -1)
        assembler.push(chunk)
      }
      expect(assembler.finish.kind).toBe('stop')
      expect(assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')).toContain('PONG')
      expect(requests).toBe(run + 1)
      if (run === 0) session.append('step/start', { turn: 1, step: 1 })
    }
    expect(session.snapshotEvents().filter(event => event.type === 'session-log-deepseek/delivery-accepted')).toHaveLength(enabled ? 2 : 0)
  })

  it.each(['off', 'low', 'high', 'max'])('streams text with %s effort', async (effort) => {
    const ctx = await boot()
    const result = await assemble(ctx.llm.stream(options({ reasoningEffort: ReasoningEffortId(effort), temperature: 0, messages: [user('Reply with exactly PONG.')] })))
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
    expect(result.message.content.filter(block => block.type === 'text').map(block => block.text).join('')).toContain('PONG')
    expect(result.assembler.usage?.outputTokens).toBeGreaterThan(0)
    expect(result.message.source.replayState).toBeDefined()
  })

  it('replays a JSON-persisted thinking/tool turn and an error result before continuing', async () => {
    const ctx = await boot()
    const history: Message[] = [user('Use lookup_value with key secret. If the tool returns an error, report its exact error text and stop.')]
    const request = options({ messages: history, tools: [tool], reasoningEffort: ReasoningEffortId('high') })
    const first = await assemble(ctx.llm.stream(request))
    expect(first.assembler.finish.kind).toBe('tool-calls')
    const calls = first.message.content.filter(block => block.type === 'tool-call')
    expect(calls).toHaveLength(1)
    const restored = JSON.parse(JSON.stringify(first.message)) as Message
    history.push(restored)
    for (const call of calls) history.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'LOOKUP_DENIED_731' }], isError: true }))
    const second = await assemble(ctx.llm.stream({ ...request, messages: history }))
    expect(second.assembler.finish.kind).toBe('stop')
    expect(second.message.content.filter(block => block.type === 'text').map(block => block.text).join('')).toContain('LOOKUP_DENIED_731')
    history.push(second.message, user('Reply with exactly DONE.'))
    const third = await assemble(ctx.llm.stream({ ...request, messages: history }))
    expect(third.assembler.finish.kind).toBe('stop')
  })

  it('cancels an active stream without committing a successful response', async () => {
    const ctx = await boot()
    const controller = new AbortController()
    const stream = ctx.llm.stream(options({ signal: controller.signal, messages: [user('List the integers from one to one thousand, one per line.')] }))
    let cancelled = false
    let finish: unknown
    for await (const chunk of stream) {
      if (!cancelled && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) { cancelled = true; controller.abort() }
      if (chunk.type === 'finish') finish = chunk.reason
    }
    expect(cancelled).toBe(true)
    expect(finish).toMatchObject({ kind: 'aborted' })
  })

  it('continues a thinking/tool turn after degrading unusable persisted replay metadata', async () => {
    const ctx = await boot()
    const warnings: unknown[][] = []
    ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
    const history: Message[] = [user('Use lookup_value with key secret. Then reply with the exact tool result and stop.')]
    const request = options({ messages: history, tools: [tool], reasoningEffort: ReasoningEffortId('high') })
    const first = await assemble(ctx.llm.stream(request))
    expect(first.assembler.finish.kind).toBe('tool-calls')
    const calls = first.message.content.filter(block => block.type === 'tool-call')
    expect(calls).toHaveLength(1)
    const restored = JSON.parse(JSON.stringify(first.message)) as typeof first.message
    restored.source.replayState = { response: { kind: 'deepseek-messages', version: 2 }, blocks: [] }
    const saved = JSON.stringify(restored)
    history.push(restored, ...calls.map(call => createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'REPLAY_RECOVERED_731' }], isError: false })))
    const second = await assemble(ctx.llm.stream({ ...request, messages: history }))
    expect(second.assembler.finish.kind).toBe('stop')
    expect(second.message.content.filter(block => block.type === 'text').map(block => block.text).join('')).toContain('REPLAY_RECOVERED_731')
    expect(warnings).toEqual([[expect.stringContaining('unsupported kind or version')]])
    expect(JSON.stringify(restored)).toBe(saved)
  })
})
