/** HTTP lifecycle, routing and optional Cordis services under real composition. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, LoggerLevel, Service } from '@deepseek-ai/cordis'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createAssistantMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import FileSettings from '@deepseek-ai/dsh-settings-file'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { DeepSeekMessagesAdapter } from '../../src/protocols/messages/adapter.ts'
import { DeepSeekFileStore } from '../../src/common/file-store.ts'
import * as Messages from '../../src/index.ts'
import { adapter, assemble, chunks, MODEL, options, prepareExtensions, server, sse, textEvents, user } from './helpers.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
async function endpoint(...args: Parameters<typeof server>) {
  const instance = await server(...args)
  cleanup.push(() => instance.close())
  return instance
}
async function context() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-messages-test-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  return { ctx, home }
}

async function send(agent: Agent, text: string) {
  agent.followup(user(text))
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

describe('direct Messages HTTP', () => {
  it('continues without a diagnostic callback when replay metadata is unusable', async () => {
    const http = await endpoint()
    const message = createAssistantMessage({ content: [{ type: 'text', text: 'Remember 731.' }], source: {
      provider: 'deepseek-official', model: MODEL, replayState: { response: {}, blocks: [] },
    } })
    const response = await assemble(adapter({ baseURL: http.url }).stream(options({ messages: [user(), message, user()] })))
    expect(response.assembler.finish.kind).toBe('stop')
    expect(http.requests[0]?.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Remember 731.' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])
  })

  it('uses the Messages endpoint, authentication, attribution and final usage', async () => {
    const http = await endpoint()
    const llm = adapter({ baseURL: http.url })
    const response = await assemble(llm.stream(options({ model: 'deepseek-flash', sessionId: SessionId('session-test'), purpose: 'compaction' })), 'deepseek-flash')
    expect(response.message.content).toEqual([{ type: 'text', text: 'Hello 世界' }])
    expect(response.message.source).toMatchObject({
      model: 'deepseek-flash', replayState: { response: { model: 'deepseek-flash' } },
    })
    expect(http.requests[0]).toMatchObject({ path: '/anthropic/v1/messages', headers: {
      'x-api-key': 'test-key', 'anthropic-version': '2023-06-01',
      'user-agent': expect.stringContaining('deepseek-harness/') as string, 'x-deepseek-harness-user-id': 'test-user',
      'x-deepseek-harness-session-id': 'session-test', 'x-deepseek-harness-compact': '1',
    }, body: { thinking: { type: 'enabled' }, output_config: { effort: 'high' } } })
    expect(llm.providerInfo('deepseek-official')).toEqual({ id: 'deepseek-official', name: 'DeepSeek' })
    expect((await llm.listModels('deepseek-official')).map(model => model.id)).toEqual([
      'deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp',
    ])
    expect(await llm.resolveModel('deepseek-official', 'deepseek-flash')).toMatchObject({
      name: 'DeepSeek-V41-Flash', inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history',
    })
    expect(await llm.resolveModel('deepseek-official', MODEL)).toMatchObject({ id: MODEL })
    expect(llm.imageRequestPricing('deepseek-official', MODEL)).toBeDefined()
  })

  it.each([true, false])('maps non-2xx responses (JSON=%s)', async (json) => {
    const http = await endpoint((response) => { response.statusCode = 429; response.setHeader('retry-after', '3'); response.end(json ? JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }) : '<html>busy</html>') })
    await expect(chunks(adapter({ baseURL: http.url }).stream(options()))).rejects.toMatchObject({ code: 'RATE_LIMIT', failure: { status: 429, providerRetryAfterMs: 3000 } })
  })

  it('refuses redirects before credentials reach another origin or request extensions are accepted', async () => {
    const destination = await endpoint()
    const source = await endpoint((response) => {
      response.writeHead(307, { location: `${destination.url}/v1/messages` })
      response.end()
    })
    const accept = vi.fn(async () => {})
    const prepare = vi.fn(async () => ({ fields: {}, accept }))
    const files = new DeepSeekFileStore()
    const llm = new DeepSeekMessagesAdapter({
      connection: () => Messages.resolveAdapterOptions({ baseURL: source.url }),
      apiKey: () => Promise.resolve('test-key'), userId: () => 'test-user',
      attachments: () => undefined, imageAccess: () => undefined, files: () => files,
      prepareExtensions: prepare,
    })
    const error = await chunks(llm.stream(options())).catch((cause: unknown) => cause)
    expect(source.requests).toHaveLength(1)
    expect(source.requests[0]?.headers['x-api-key']).toBe('test-key')
    expect(destination.requests).toEqual([])
    expect(error).toMatchObject({ code: 'TRANSPORT' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(accept).not.toHaveBeenCalled()
  })

  it('freezes endpoint and defaults for a prepared call while the next call sees new settings', async () => {
    const first = await endpoint(), second = await endpoint()
    let config = Messages.resolveAdapterOptions({ baseURL: first.url, maxTokens: 10, models: [{ id: MODEL, systemPromptUpdate: 'in-history' }] })
    const files = new DeepSeekFileStore()
    const llm = new DeepSeekMessagesAdapter({ connection: () => config, apiKey: snapshot => Promise.resolve(snapshot.maxTokens === 10 ? 'first' : 'second'), userId: () => 'user', attachments: () => undefined, imageAccess: () => undefined, files: () => files, prepareExtensions })
    const prepared = await llm.prepareCall('deepseek-official', MODEL)
    config = Messages.resolveAdapterOptions({ baseURL: second.url, maxTokens: 20 })
    expect(prepared.model.systemPromptUpdate).toBe('in-history')
    expect((await llm.resolveModel('deepseek-official', MODEL)).systemPromptUpdate).toBeUndefined()
    await chunks(prepared.stream(options()))
    await chunks(llm.stream(options()))
    expect(first.requests[0]).toMatchObject({ headers: { 'x-api-key': 'first' }, body: { max_tokens: 10 } })
    expect(second.requests[0]).toMatchObject({ headers: { 'x-api-key': 'second' }, body: { max_tokens: 20 } })
  })

  it('aborts an open provider response when its consumer stops', async () => {
    let closed!: () => void
    const stopped = new Promise<void>((resolve) => { closed = resolve })
    const http = await endpoint((response) => {
      response.once('close', closed)
      response.write(sse(textEvents.slice(0, 3)))
    })
    const stream = adapter({ baseURL: http.url }).stream(options())[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: 'block-start' })
    await stream.return!()
    await stopped
  })

  it('distinguishes caller cancellation from idle timeout and transport failure', async () => {
    const http = await endpoint((response) =>{  response.flushHeaders() })
    await expect(chunks(adapter({ baseURL: http.url, streamIdleTimeoutMs: 30 }).stream(options()))).rejects.toMatchObject({ code: 'TIMEOUT' })
    const controller = new AbortController(); controller.abort()
    await expect(chunks(adapter({ baseURL: http.url }).stream(options({ signal: controller.signal })))).rejects.toMatchObject({ code: 'ABORTED' })
    vi.stubGlobal('fetch', async () => { throw new TypeError('network down') })
    await expect(chunks(adapter().stream(options()))).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('rejects a successful response with no readable body', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
    await expect(chunks(adapter().stream(options()))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })
})

describe('Cordis provider composition', () => {
  it('resolves an attachment service loaded after the adapter and maps its read-only path', async () => {
    const http = await endpoint()
    const { ctx, home } = await context()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Messages, { baseURL: http.url })
    const model = 'deepseek-v4-flash-vision-exp'
    const price = () => ctx.llm.imageRequestPricing('deepseek-official', model)!
    const dummy = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), width: 1, height: 1, bytes: 3, mediaType: 'image/png' as const }
    expect(price().priceImages([{ type: 'image', attachment: dummy }])[0]?.text).toBeDefined()
    await ctx.plugin(LocalAttachments, { dshHome: home })
    const attachment = await ctx.attachments.saveImage({ data: await readFile(new URL('fixtures/red.png', import.meta.url)), mediaType: 'image/png' })
    expect(price().priceImages([{ type: 'image', attachment }])[0]?.text).not.toContain('/mounted/image.png')
    class MappedFiles extends Service {
      constructor(context: Context) { super(context, 'fs') }
      processPathFromHostPath(_path: string) { return '/mounted/image.png' }
    }
    await ctx.plugin(MappedFiles)
    const message = user()
    await chunks(ctx.llm.stream(options({ model, messages: [{ ...message, content: [...message.content, { type: 'image', attachment }] }] })))
    expect(JSON.stringify(http.requests[0]?.body)).toContain('/mounted/image.png')
    expect(price().priceImages([{ type: 'image', attachment }])[0]?.text).toContain('/mounted/image.png')
  })

  async function boot(...args: Parameters<typeof server>) {
    const http = await endpoint(...args)
    const { ctx, home } = await context()
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: stored-key\n', { mode: 0o600 })
    await writeFile(join(home, 'settings.yaml'), '{}\n')
    const template = await readFile(new URL('fixtures/cordis.yml', import.meta.url), 'utf8')
    await writeFile(join(home, 'cordis.yml'), template.replaceAll('{{endpoint}}', JSON.stringify(http.url)).replaceAll('{{settings}}', JSON.stringify(join(home, 'settings.yaml'))).replaceAll('{{credentials}}', JSON.stringify(join(home, '.credentials.yaml'))))
    ctx.baseUrl = pathToFileURL(home).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-llm-deepseek', Messages],
      ['@deepseek-ai/dsh-credentials-local', LocalCredentials], ['@deepseek-ai/dsh-settings-file', FileSettings],
      ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-agent-loop', AgentLoop],
      ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
    ])
    // The importer supplies source modules while Loader still owns configuration and effects.
    for (const name of modules.keys()) {
      const directory = join(home, 'node_modules', name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '0.1.3-alpha.1', type: 'module' }))
    }
    ctx.loader.internal = { version: 'v2', async import(name: string) {
      if (!modules.has(name)) throw new Error(`unexpected module ${name}`)
      return modules.get(name)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(home, 'cordis.yml')).href } })
    await ctx.loader.await()
    return { ctx, http }
  }

  it.each([
    { model: MODEL, inHistory: false },
    { model: MODEL, inHistory: true },
    { model: 'deepseek-flash', inHistory: true },
  ])('updates, clears and restores prompts across continued and resumed sessions, model=$model in-history=$inHistory', async ({ model, inHistory }) => {
    const { ctx, http } = await boot()
    if (inHistory && model === MODEL) await ctx.settings.update(Messages.name, { models: [{ id: model, systemPromptUpdate: 'in-history' }] })
    let prompt = 'first prompt'
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({
      ...await next(), sections: [{ name: 'test', text: prompt, order: 0 }],
    }))
    const agentOptions = { provider: 'deepseek-official', model }
    const agent = await ctx.agentLoop.create(SessionId('prompt-update'), agentOptions)
    await send(agent, 'first')
    prompt = 'second prompt'
    await send(agent, 'second')
    const count = agent.session.snapshotEvents().filter(event => event.type === 'system/message').length
    await send(agent, 'unchanged')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(count)
    prompt = ''
    await send(agent, 'clear')
    const { agent: resumed } = await ctx.agents.create({ sessionId: SessionId('prompt-resume'), agentOptions,
      seed: [...agent.session.snapshotEvents()] })
    await send(resumed, 'resume cleared')
    prompt = 'restored prompt'
    await send(resumed, 'restore')
    expect(http.requests.map(request => request.body.system)).toEqual(inHistory
      ? ['first prompt', 'first prompt', 'first prompt', undefined, undefined, undefined]
      : ['first prompt', 'second prompt', 'second prompt', undefined, undefined, 'restored prompt'])
    for (const [index, request] of http.requests.entries()) {
      const messages = request.body.messages as { role: string; content: unknown[] }[]
      expect(messages.filter(message => message.role === 'assistant')).toHaveLength(index)
      expect(messages.filter(message => message.role === 'system').map(message => message.content)).toEqual(
        !inHistory ? [] : index === 1 || index === 2 ? [[{ type: 'text', text: 'second prompt' }]]
          : index === 5 ? [[{ type: 'text', text: 'restored prompt' }]] : [],
      )
      expect(JSON.stringify(messages.filter(message => message.role !== 'system'))).not.toMatch(/first prompt|second prompt|restored prompt/)
    }
    expect(resumed.session.requestContext()?.systemPromptUpdate).toBe(inHistory ? 'in-history' : undefined)
  })

  it.each([false, true])('continues and resumes Chat Completions sessions through Messages, in-history=%s', async (inHistory) => {
    let messagesProtocol = false
    const { ctx, http } = await boot(response => response.end(messagesProtocol ? sse(textEvents) : [
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('')))
    await ctx.settings.update('llm-deepseek', { protocol: 'chat-completions', baseURL: http.url, models: [{ id: MODEL, systemPromptUpdate: 'in-history' }] })
    let prompt = 'old prompt'
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({
      ...await next(), sections: [{ name: 'test', text: prompt, order: 0 }],
    }))
    const selection: ModelSelectionRef = { current: { provider: 'deepseek-official', model: MODEL }, assembled: undefined }
    const agent = await ctx.agentLoop.create(SessionId('protocol-switch'), selection.current)
    installModelSelection(agent.ctx, selection)
    await send(agent, 'first')
    prompt = 'current prompt'
    await send(agent, 'second')
    expect((http.requests[1]?.body.messages as { role: string }[]).filter(message => message.role === 'system')).toHaveLength(2)
    const seed = [...agent.session.snapshotEvents()]
    const saved = JSON.stringify(seed)
    messagesProtocol = true
    await ctx.settings.update(Messages.name, { protocol: 'messages', models: [{ id: MODEL, ...inHistory ? { systemPromptUpdate: 'in-history' } : {} }] })
    selection.current = { provider: 'deepseek-official', model: MODEL }
    await send(agent, 'switch')
    const { agent: resumed } = await ctx.agents.create({ sessionId: SessionId('switch-resume'), agentOptions: selection.current, seed })
    await send(resumed, 'resume')
    for (const request of http.requests.slice(2)) {
      expect(request.path).toBe('/anthropic/v1/messages')
      expect(request.body.system).toBe(inHistory ? 'old prompt' : 'current prompt')
      const messages = request.body.messages as { role: string }[]
      expect(messages.filter(message => message.role === 'assistant')).toHaveLength(2)
      expect(messages.filter(message => message.role === 'system')).toHaveLength(inHistory ? 1 : 0)
      expect(JSON.stringify(messages.filter(message => message.role !== 'system'))).not.toMatch(/old prompt|current prompt/)
    }
    expect(JSON.stringify(seed)).toBe(saved)
    expect(agent.session.deriveMessages().filter(message => message.role === 'system')).toHaveLength(inHistory ? 2 : 1)
    expect(resumed.session.deriveMessages().filter(message => message.role === 'system')).toHaveLength(inHistory ? 2 : 1)
  })

  it('maps multiple system snapshots on direct compaction calls to the latest prompt', async () => {
    const { ctx, http } = await boot()
    const history = [createSystemMessage('old', 'test'), user(),
      createAssistantMessage({ content: [{ type: 'text', text: 'OK' }], source: { provider: 'deepseek-official', model: MODEL } }),
      createSystemMessage('current', 'test'), user('summarize')]
    const saved = JSON.stringify(history)
    const response = await assemble(ctx.llm.stream(options({ messages: history, purpose: 'compaction' })))
    expect(response.assembler.finish.kind).toBe('stop')
    expect(http.requests[0]?.body.system).toBe('current')
    expect((http.requests[0]?.body.messages as { role: string }[]).map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(history)).toBe(saved)
  })

  it('continues a recorded tool turn with a warning when its native replay version is unknown', async () => {
    const { ctx, http } = await boot()
    const warnings: unknown[][] = []
    ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
    const fixture = await readFile(new URL('../../../../../snapshots/session/deepseek-messages-degraded-replay/session.v2.jsonl', import.meta.url), 'utf8')
    const records = fixture.trim().split('\n').map(line => JSON.parse(line) as { type: string; data: { message?: Message } })
    const assistant = records.find(record => record.type === 'assistant/message')!.data.message!
    if (assistant.source.kind === 'model') assistant.source.provider = 'deepseek-official'
    const result = records.find(record => record.type === 'tool/result')!.data.message!
    const saved = JSON.stringify([assistant, result])
    const response = await assemble(ctx.llm.stream(options({ messages: [user(), assistant, result] })))
    expect(response.assembler.finish.kind).toBe('stop')
    expect(warnings).toEqual([[`llm-deepseek: unusable Messages replay state on assistant history for route "deepseek-official/${MODEL}"; sending provider-neutral content (DeepSeek Messages replay: unsupported kind or version)`]])
    expect(http.requests).toHaveLength(1)
    expect(http.requests[0]?.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'The user wants me to run a simple bash command and then reply with "DONE".' },
        { type: 'tool_use', id: 'call_00_fkbBRJsUrGKd1pWVc4Gn8233', name: 'bash', input: { command: 'echo TERMINAL_OK', description: 'Echo TERMINAL_OK to verify terminal access' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_fkbBRJsUrGKd1pWVc4Gn8233', content: [{ type: 'text', text: 'TERMINAL_OK\n' }], is_error: false }] },
    ])
    expect(JSON.stringify([assistant, result])).toBe(saved)
  })

  it('loads one provider from YAML, rotates settings and credentials, then removes disposed registrations', async () => {
    const { ctx, http } = await boot()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek-official'])
    expect((await assemble(ctx.llm.stream(options()))).assembler.finish.kind).toBe('stop')
    expect(http.requests[0]?.headers['x-api-key']).toBe('stored-key')
    const second = await endpoint()
    await ctx.settings.update(Messages.name, { baseURL: second.url, maxTokens: 51, retryPolicy: { mode: 'always' } })
    await ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'rotated')
    await chunks(ctx.llm.stream(options()))
    expect(second.requests[0]).toMatchObject({ headers: { 'x-api-key': 'rotated' }, body: { max_tokens: 51 } })
    await ctx.settings.update(Messages.name, { models: [{ id: 'duplicate' }, { id: 'duplicate' }], baseURL: http.url })
    await chunks(ctx.llm.stream(options()))
    expect(second.requests).toHaveLength(2)
    expect(http.requests).toHaveLength(1)
    await ctx.settings.update(Messages.name, { models: [{ id: MODEL }], baseURL: http.url })
    await chunks(ctx.llm.stream(options()))
    expect(http.requests).toHaveLength(2)
    const llm = ctx.llm
    await ctx.fiber.dispose()
    expect(llm.listProviders()).toEqual([])
    expect(llm.listConfigurableProviders()).toEqual([])
  })

  it('uses environment credentials and reports missing or malformed keys without network access', async () => {
    const http = await endpoint()
    const { ctx } = await context()
    vi.stubEnv('DEEPSEEK_BASE_URL', http.url)
    vi.stubEnv('DEEPSEEK_API_KEY', 'env-key')
    await ctx.plugin(LlmRuntime)
    const fiber = ctx.plugin(Messages)
    await fiber
    await chunks(ctx.llm.stream(options()))
    expect(http.requests[0]?.headers['x-api-key']).toBe('env-key')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    expect((await assemble(ctx.llm.stream(options()))).assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    vi.stubEnv('DEEPSEEK_API_KEY', 'bad\nkey')
    expect((await assemble(ctx.llm.stream(options()))).assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } })
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })
})
