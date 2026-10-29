import { Context } from '@deepseek-ai/cordis'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime, { CommandDefinitionId, type CommandDefinition, type CommandInvocation } from '@deepseek-ai/dsh-commands'
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JsonRpcLineTransport, type JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

class UnusedModel extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('Command dispatch must not call the model')
  }
}

class TextModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(registry = true, peer?: JsonRpcTransportPeer) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  if (registry) await ctx.plugin(CommandRuntime)
  ctx.llm.registerAdapter(['mock'], new UnusedModel())
  const transport: JsonRpcTransportPeer = peer ?? {
    request: async () => { throw new Error('Unexpected runtime request') },
    notify: () => {},
  }
  const server = new HarnessSdkJsonRpcServer(ctx, transport)
  onTestFinished(async () => { await server.shutdown() })
  const initialize = () => server.initialize({ cwd: process.cwd(), provider: 'mock', model: 'mock' })
  const register = (handler: CommandDefinition['handler']) => {
    ctx.effect(() => ctx.commands.register({ name: 'compact', definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-compact'), description: 'Fixture command', handler }))
  }
  const command = async () => {
    const result = await server.query({ sessionId: SessionId('commands'), contentBlocks: [{ type: 'text', text: '/compact' }] })
    if (result.kind !== 'command') throw new Error('Fixture command was routed as a prompt')
    return result.execution
  }
  return { ctx, server, loop, initialize, register, command }
}

describe('SDK command dispatch', () => {
  it.each([' ', '\t\n', '\u3000'])('accepts leading whitespace through the query wire endpoint: %j', async (prefix) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind: 'success' as const }))
    h.register(handler)
    await expect(h.server.handleRequest('session/query', { sessionId: 'query-space', contentBlocks: [{ type: 'text', text: `${prefix}/compact` }] }))
      .resolves.toMatchObject({ kind: 'command', execution: { result: { kind: 'success' } } })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]![0].rawInput).toBe('')
  })

  it.each(['success', 'error'] as const)('returns the logged native %s without a model turn', async (kind) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind, text: 'native outcome' }))
    h.register(handler)
    const execution = await h.command()
    const agent = h.ctx.agents.get(SessionId('commands'))!
    expect(handler).toHaveBeenCalledOnce()
    const invocation = handler.mock.calls[0]![0]
    expect(invocation.agent.id).toBe(agent.id)
    expect(invocation.rawInput).toBe('')
    expect(invocation.attachments).toEqual([])
    expect(execution.result).toEqual({ kind, text: 'native outcome' })
    expect(agent.session.snapshotEvents().map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(agent.session.snapshotEvents().map(event => event.data)).toEqual([
      { commandId: execution.commandId, name: 'compact', args: '', source: { kind: 'user' } },
      { commandId: execution.commandId, kind, text: 'native outcome' },
    ])
  })

  it('rejects malformed content before creating a Session', async () => {
    const h = await setup()
    await h.initialize()
    const image = { type: 'image', data: 'AQ==', mimeType: 'image/png' }
    const invalid = [undefined, null, {}, 'image', [], [null], [1], [[]], [{}], [{ type: 1 }],
      [{ type: 'text' }], [{ type: 'text', text: 1 }], [{ type: 'text', text: 'go', extra: true }],
      [{ type: 'text', text: '' }], [{ type: 'text', text: '  ' }, { type: 'text', text: '\n' }],
      [{ type: 'image', mimeType: 'image/png' }], [{ type: 'image', attachment: null }],
      [{ type: 'image', attachment: [] }], [{ type: 'image', attachment: 'missing' }],
      [{ ...image, data: 1 }], [{ type: 'image', data: 'AQ==' }],
      [{ ...image, mimeType: 'image/svg+xml' }], [{ ...image, name: null }],
      [{ ...image, attachment: { attachmentId: 'other-session' } }]]
    for (const contentBlocks of invalid) {
      await expect(h.server.handleRequest('session/query', {
        sessionId: 'invalid-content', contentBlocks,
      })).rejects.toThrow(TypeError)
      expect(h.ctx.agents.list()).toEqual([])
    }
  })

  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])('leaves command attachment support to the native registry for %s', async (mimeType) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    h.register(handler)
    const response = await h.server.handleRequest('session/query', {
      sessionId: 'refused-image',
      contentBlocks: [{ type: 'text', text: '/compact' },
        { type: 'image', data: 'AQ==', mimeType, ...mimeType === 'image/png' ? {} : { name: 'example' } }],
    })
    expect(response).toMatchObject({ kind: 'command', execution: {
      result: { kind: 'error', text: '/compact does not accept attachments' },
    } })
    expect(handler).not.toHaveBeenCalled()
    expect(h.ctx.agents.get(SessionId('refused-image'))!.session.snapshotEvents().map(event => event.type))
      .toEqual(['command/run', 'command/done'])
  })

  it.each(['image-first', 'text-first'])('admits named images through the native command executor in %s order', async (order) => {
    const h = await setup()
    await h.initialize()
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId('image'), mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'diagram.png',
    }
    const saveImages = vi.fn<AttachmentStore['saveImages']>(async () => [ref])
    const store: Pick<AttachmentStore, 'saveImages'> = { saveImages }
    h.ctx.provide('attachments', store as AttachmentStore)
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind: 'success' as const }))
    h.ctx.effect(() => h.ctx.commands.register({
      name: 'plan', definitionId: CommandDefinitionId('@deepseek-ai/dsh-plan-mode'), description: 'Plan', input: { hint: 'Task', attachments: true }, handler,
    }))
    const attachments = [{ type: 'image', data: 'AQ==', mimeType: 'image/png', name: 'diagram.png' }]
    const text = { type: 'text', text: '/plan inspect' }
    const response = await h.server.handleRequest('session/query', {
      sessionId: 'images',
      contentBlocks: order === 'image-first' ? [...attachments, text] : [text, ...attachments],
    })
    expect(response).toMatchObject({ kind: 'command', execution: { result: { kind: 'success' } } })
    expect(saveImages).toHaveBeenCalledWith([{ data: Uint8Array.of(1), mediaType: 'image/png', name: 'diagram.png' }])
    expect(handler.mock.calls[0]![0]).toMatchObject({ rawInput: ' inspect', attachments: [{ type: 'image', attachment: ref }] })
  })

  it.each([
    { type: 'text', text: 'another command paragraph' },
    { type: 'text', text: '' },
    { type: 'image', attachment: { attachmentId: 'stored-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    { type: 'file', attachment: { attachmentId: 'stored-file', name: 'notes.txt', bytes: 1 } },
    { type: 'reasoning', text: 'earlier reasoning' },
  ])('rejects a recognized command with unsupported content %j without executing or falling back', async (extra) => {
    const h = await setup()
    await h.initialize()
    const saveImages = vi.fn<AttachmentStore['saveImages']>(async () => [])
    const store: Pick<AttachmentStore, 'saveImages'> = { saveImages }
    h.ctx.provide('attachments', store as AttachmentStore)
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    h.ctx.effect(() => h.ctx.commands.register({
      name: 'plan', definitionId: CommandDefinitionId('@deepseek-ai/dsh-plan-mode'), description: 'Plan', input: { hint: 'Task', attachments: true }, handler,
    }))
    await expect(h.server.handleRequest('session/query', {
      sessionId: 'refused-content', contentBlocks: [
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
        { type: 'text', text: '/plan off' }, extra,
      ],
    })).rejects.toThrow('Native SDK commands require one text block and optional encoded image blocks')
    expect(handler).not.toHaveBeenCalled()
    expect(saveImages).not.toHaveBeenCalled()
    expect(h.ctx.agents.get(SessionId('refused-content'))!.session.snapshotEvents()).toEqual([])
  })

  it('cancels a command whose image admission overlaps shutdown before invoking its handler', async () => {
    const h = await setup()
    await h.initialize()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    onTestFinished(() => { release.resolve([]) })
    const saveImages: AttachmentStore['saveImages'] = () => { entered.resolve(undefined); return release.promise }
    h.ctx.provide('attachments', { saveImages } as AttachmentStore)
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    h.ctx.effect(() => h.ctx.commands.register({
      name: 'plan', definitionId: CommandDefinitionId('@deepseek-ai/dsh-plan-mode'), description: 'Plan', input: { hint: 'Task', attachments: true }, handler,
    }))
    const request = h.server.query({ sessionId: SessionId('image-shutdown'),
      contentBlocks: [{ type: 'text', text: '/plan inspect' }, { type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    const rejected = expect(request).rejects.toThrow('shutting down')
    await entered.promise
    const shutdown = h.server.shutdown()
    release.resolve([{ attachmentId: AttachmentId('image'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }])
    await Promise.all([rejected, shutdown])
    expect(handler).not.toHaveBeenCalled()
    expect(h.ctx.agents.list()).toEqual([])
  })

  it.each([
    ['compact', '@deepseek-ai/dsh-command-compact', '/compact', '/压缩'],
    ['permission', '@deepseek-ai/dsh-permission-presets', '/permission read-only', '/权限 read-only'],
    ['plan', '@deepseek-ai/dsh-plan-mode', '/plan', '/计划'],
    ['goal', '@deepseek-ai/dsh-command-goal', '/goal', '/目标'],
  ])('accepts the %s English and Chinese aliases and delivers their lifecycle before resolution', async (name, definitionId, line, alias) => {
    const input = new PassThrough()
    const output = new PassThrough()
    const serverWire = new JsonRpcLineTransport(input, output)
    const client = new JsonRpcLineTransport(output, input)
    onTestFinished(async () => {
      serverWire.close()
      client.close()
      const closed = [once(input, 'close'), once(output, 'close')]
      input.destroy()
      output.destroy()
      await Promise.all(closed)
    })
    const h = await setup(true, serverWire)
    const received: { method: string; params: Record<string, unknown> }[] = []
    let receivedAtQueryResolution: typeof received = []
    client.onNotification((method, params) => { received.push({ method, params }) })
    serverWire.onRequest(async (method, params) => {
      const result = await h.server.handleRequest(method, params)
      if (method === 'session/query') receivedAtQueryResolution = [...received]
      return result
    })
    serverWire.start()
    client.start()
    await client.request('initialize', { cwd: process.cwd(), provider: 'mock', model: 'mock' })
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind: 'success' as const, text: 'native outcome' }))
    h.ctx.effect(() => h.ctx.commands.register({
      name, definitionId: CommandDefinitionId(definitionId), description: 'Fixture command', handler,
    }))
    const sessionId = SessionId('alias-command')
    await expect(client.request('session/query', { sessionId, contentBlocks: [{ type: 'text', text: line }] }))
      .resolves.toMatchObject({ kind: 'command', execution: { result: { kind: 'success', text: 'native outcome' } } })
    expect(handler).toHaveBeenCalledOnce()
    received.length = 0
    const result = await client.request('session/query', { sessionId, contentBlocks: [{ type: 'text', text: alias }] })
    expect(handler).toHaveBeenCalledTimes(2)
    const commandId = handler.mock.calls[1]![0].commandId
    expect(result).toMatchObject({ kind: 'command', execution: { commandId, result: { kind: 'success', text: 'native outcome' } } })
    expect(receivedAtQueryResolution.filter(item => item.method === 'session.event')).toMatchObject([
      { method: 'session.event', params: { sessionId, event: { type: 'command/run', data: { commandId, name } } } },
      { method: 'session.event', params: { sessionId, event: { type: 'command/done', data: { commandId, kind: 'success' } } } },
    ])
    expect(h.ctx.agents.get(sessionId)!.session.snapshotEvents().map(event => event.type))
      .toEqual(['command/run', 'command/done', 'command/run', 'command/done'])
  })

  it.each([
    ['compact', '@deepseek-ai/dsh-command-compact', '压缩', ''],
    ['permission', '@deepseek-ai/dsh-permission-presets', '权限', ' read-only'],
    ['plan', '@deepseek-ai/dsh-plan-mode', '计划', ' task'],
    ['goal', '@deepseek-ai/dsh-command-goal', '目标', ' task'],
  ])('dispatches the renamed %s definition through its registered name and aliases', async (name, id, alias, args) => {
    const h = await setup()
    await h.initialize()
    const registered = `renamed-${name}`
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind: 'success' as const }))
    h.ctx.effect(() => h.ctx.commands.register({
      name: registered, definitionId: CommandDefinitionId(id), description: 'Renamed builtin', handler,
    }))
    const sessionId = SessionId('renamed')
    for (const token of [name, alias, registered]) {
      await expect(h.server.handleRequest('session/query', {
        sessionId, contentBlocks: [{ type: 'text', text: `/${token}${args}` }],
      })).resolves.toMatchObject({ kind: 'command', execution: { result: { kind: 'success' } } })
    }
    expect(handler).toHaveBeenCalledTimes(3)
    expect(handler.mock.calls.map(([invocation]) => invocation.rawInput)).toEqual(Array.from({ length: 3 }, () => args))
    const events = h.ctx.agents.get(sessionId)!.session.snapshotEvents()
    expect(events.filter(event => event.type === 'command/run').map(event => event.data.name))
      .toEqual(Array.from({ length: 3 }, () => registered))
    expect(events.every(event => event.type === 'command/run' || event.type === 'command/done')).toBe(true)
  })

  it.each([
    ['compact', ''], ['permission', ' read-only'], ['plan', ' task'], ['goal', ' task'],
  ])('keeps an unrelated definition named %s outside native SDK dispatch', async (name, args) => {
    const h = await setup()
    const model = new TextModel()
    h.ctx.effect(() => h.ctx.llm.registerAdapter(['query-model'], model))
    await h.server.initialize({ cwd: process.cwd(), provider: 'query-model', model: 'model' })
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    h.ctx.effect(() => h.ctx.commands.register({
      name, definitionId: CommandDefinitionId(`example/${name}`), description: 'Unrelated command', handler,
    }))
    const sessionId = SessionId('unrelated')
    const line = `/${name}${args}`
    await expect(h.server.handleRequest('session/query', {
      sessionId, contentBlocks: [{ type: 'text', text: line }],
    })).resolves.toMatchObject({ kind: 'prompt' })
    await h.server.wait({ sessionId })
    expect(handler).not.toHaveBeenCalled()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]!.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === line))).toBe(true)
    expect(h.ctx.agents.get(sessionId)!.session.snapshotEvents().some(event => event.type === 'command/run')).toBe(false)
  })

  it('keeps a renamed permission command without a preset as ordinary input', async () => {
    const h = await setup()
    const model = new TextModel()
    h.ctx.effect(() => h.ctx.llm.registerAdapter(['query-model'], model))
    await h.server.initialize({ cwd: process.cwd(), provider: 'query-model', model: 'model' })
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    h.ctx.effect(() => h.ctx.commands.register({
      name: 'access', definitionId: CommandDefinitionId('@deepseek-ai/dsh-permission-presets'),
      description: 'Permission', handler,
    }))
    const sessionId = SessionId('empty-preset')
    await expect(h.server.query({ sessionId, contentBlocks: [{ type: 'text', text: '/access' }] }))
      .resolves.toMatchObject({ kind: 'prompt' })
    await h.server.wait({ sessionId })
    expect(handler).not.toHaveBeenCalled()
    expect(model.requests[0]!.messages.some(message => message.content.some(block => block.type === 'text' && block.text === '/access'))).toBe(true)
    expect(h.ctx.agents.get(sessionId)!.session.snapshotEvents().some(event => event.type === 'command/run')).toBe(false)
  })

  it('reports an execution unavailable after catalog resolution', async () => {
    const h = await setup()
    await h.initialize()
    h.register(() => ({ kind: 'success' }))
    vi.spyOn(h.ctx.commands, 'execute').mockResolvedValue(undefined)
    await expect(h.command()).rejects.toThrow('selected command is unavailable')
  })

  it('passes explicit permission input to the native handler', async () => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind: 'error' as const, text: 'native preset refusal' }))
    h.ctx.effect(() => h.ctx.commands.register({ name: 'permission', definitionId: CommandDefinitionId('@deepseek-ai/dsh-permission-presets'), description: 'Fixture permission', input: { hint: 'Preset' }, handler }))
    const sessionId = SessionId('permission')
    const line = '/permission  deployment-preset'
    const result = await h.server.query({ sessionId, contentBlocks: [{ type: 'text', text: line }] })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]![0].rawInput).toBe('  deployment-preset')
    const expected = { result: { kind: 'error', text: 'native preset refusal' } }
    expect(result).toMatchObject({ kind: 'command', execution: expected })
    expect(h.ctx.agents.get(sessionId)!.session.snapshotEvents().map(event => event.type))
      .toEqual(['command/run', 'command/done'])
  })

  it.each(['/plan', '/plan off', '/plan  explain the change'])('delegates %s without reconstructing model input', async (line) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind: 'success' as const, text: 'native plan result' }))
    h.ctx.effect(() => h.ctx.commands.register({ name: 'plan', definitionId: CommandDefinitionId('@deepseek-ai/dsh-plan-mode'), description: 'Plan', input: { hint: '[off|message]' }, handler }))
    const result = await h.server.query({ sessionId: SessionId('plan'), contentBlocks: [{ type: 'text', text: line }] })
    expect(result).toMatchObject({ kind: 'command', execution: { result: { kind: 'success', text: 'native plan result' } } })
    expect(handler.mock.calls[0]![0].rawInput).toBe(line.slice('/plan'.length))
    expect(h.ctx.agents.get(SessionId('plan'))!.session.snapshotEvents().map(event => event.type))
      .toEqual(['command/run', 'command/done'])
  })

  it.each([
    ['/plan\u3000Inspect\u3000the\nchange', 'plan', '@deepseek-ai/dsh-plan-mode', ' Inspect\u3000the\nchange'],
    ['/计划\u00a0\t设计\u00a0方案', 'plan', '@deepseek-ai/dsh-plan-mode', ' \t设计\u00a0方案'],
    ['/goal\u2003Finish\u3000the task', 'goal', '@deepseek-ai/dsh-command-goal', ' Finish\u3000the task'],
    ['/目标\u3000\u00a0完成任务', 'goal', '@deepseek-ai/dsh-command-goal', ' \u00a0完成任务'],
    ['/permission\u00a0read-only', 'permission', '@deepseek-ai/dsh-permission-presets', ' read-only'],
    ['/权限\u202f\tread-only', 'permission', '@deepseek-ai/dsh-permission-presets', ' \tread-only'],
  ])('executes Unicode-separated input %j through its native handler', async (line, name, definitionId, rawInput) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind: 'success' as const, text: 'native outcome' }))
    h.ctx.effect(() => h.ctx.commands.register({
      name, definitionId: CommandDefinitionId(definitionId), description: 'Fixture command', input: { hint: 'Input' }, handler,
    }))
    const sessionId = SessionId('unicode-command')
    const result = await h.server.query({ sessionId, contentBlocks: [{ type: 'text', text: line }] })
    expect(result).toMatchObject({ kind: 'command', execution: { result: { kind: 'success', text: 'native outcome' } } })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]![0].rawInput).toBe(rawInput)
    const events = h.ctx.agents.get(sessionId)!.session.snapshotEvents()
    expect(events.map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(events[0]?.data).toMatchObject({ name, args: rawInput })
    expect(events[1]?.data).toMatchObject({ kind: 'success', text: 'native outcome' })
  })

  it('passes arguments unchanged and propagates handler failures', async () => {
    const h = await setup()
    await h.initialize()
    h.ctx.effect(() => h.ctx.commands.register({
      name: 'plan', definitionId: CommandDefinitionId('@deepseek-ai/dsh-plan-mode'), description: 'Plan',
      handler: ({ rawInput }) => { throw new Error(`handler saw:${rawInput}`) },
    }))
    await expect(h.server.handleRequest('session/query', { sessionId: 'commands', contentBlocks: [{ type: 'text', text: '/plan  extra' }] }))
      .rejects.toThrow('handler saw:  extra')
    expect(h.ctx.agents.get(SessionId('commands'))!.session.snapshotEvents().at(-1)?.type).toBe('command/done')
  })

  it('rejects a disposed Agent retained by the SDK handle', async () => {
    const h = await setup()
    await h.initialize()
    h.register(() => ({ kind: 'success' }))
    await h.command()
    await h.loop.dispose()
    await expect(h.command()).rejects.toThrow('disposed outside the server')
  })

  it('cancels an in-flight command on shutdown and rejects later admission', async () => {
    const h = await setup()
    await h.initialize()
    const entered = Promise.withResolvers<undefined>()
    const cancelled = vi.fn()
    h.register(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { cancelled(); reject(new Error('fixture command aborted')) }, { once: true })
      entered.resolve(undefined)
    }))
    const execution = h.command()
    const rejected = expect(execution).rejects.toThrow('shutting down')
    await entered.promise
    await expect(h.server.getWorkingDirectory({ sessionId: 'commands' })).resolves.toHaveProperty('cwd')
    await h.server.shutdown()
    await rejected
    expect(cancelled).toHaveBeenCalledOnce()
    expect(h.ctx.agents.list()).toEqual([])
    await expect(h.command()).rejects.toThrow('shutting down')
  })

  it.each(['command', 'prompt'] as const)('does not execute %s while its Session is being created at shutdown', async (entry) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    h.register(handler)
    const created = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const create = h.ctx.agents.create.bind(h.ctx.agents)
    vi.spyOn(h.ctx.agents, 'create').mockImplementation(async (request) => {
      const handle = await create(request)
      created.resolve(undefined)
      await release.promise
      return handle
    })
    const execution = h.server.query({ sessionId: SessionId('commands'),
      contentBlocks: [{ type: 'text', text: entry === 'command' ? '/compact' : 'ordinary input' }],
    })
    const rejected = expect(execution).rejects.toThrow('shutting down')
    await created.promise
    const shutdown = h.server.shutdown()
    release.resolve(undefined)
    await Promise.all([rejected, shutdown])
    expect(handler).not.toHaveBeenCalled()
    expect(h.ctx.agents.list()).toEqual([])
  })
})

describe('SDK query dispatch', () => {
  it.each([undefined, {}, { sessionId: '', contentBlocks: [{ type: 'text', text: 'go' }] },
    { sessionId: 'q', text: 'go' },
    { sessionId: 'q', contentBlocks: [{ type: 'text', text: 'go' }], delivery: 'queue' },
    { sessionId: 'q', contentBlocks: [{ type: 'text', text: 'go' }], permission: 'full' },
    { sessionId: 'q', contentBlocks: [{ type: 'text', text: 'go' }], attachments: [] },
  ])('rejects invalid query fields %j', async (params) => {
    const h = await setup()
    await h.initialize()
    await expect(h.server.handleRequest('session/query', params)).rejects.toThrow('session/query requires only')
    expect(h.ctx.agents.list()).toEqual([])
  })

  it.each(['/compact', '/permission read-only'])('preserves %s without a command registry and requires a live initialized server', async (text) => {
    const h = await setup(false)
    const params = { sessionId: SessionId('q'), contentBlocks: [{ type: 'text' as const, text }] }
    await expect(h.server.query(params)).rejects.toThrow('not initialized')
    const model = new TextModel()
    h.ctx.effect(() => h.ctx.llm.registerAdapter(['query-model'], model))
    await h.server.initialize({ cwd: process.cwd(), provider: 'query-model', model: 'model' })
    await expect(h.server.query(params)).resolves.toMatchObject({ kind: 'prompt' })
    await h.server.wait({ sessionId: 'q' })
    expect(model.requests).toHaveLength(1)
    await h.server.shutdown()
    await expect(h.server.query(params)).rejects.toThrow('shutting down')
  })

  it('returns the native command result without creating a prompt', async () => {
    const h = await setup()
    await h.initialize()
    h.register(() => ({ kind: 'error', text: 'native refusal' }))
    const response = await h.server.handleRequest('session/query', {
      sessionId: 'q', contentBlocks: [{ type: 'text', text: ' \n/compact\t ' }],
    })
    expect(response).toMatchObject({ kind: 'command', execution: { result: { kind: 'error', text: 'native refusal' } } })
    expect(h.ctx.agents.get(SessionId('q'))!.session.snapshotEvents().map(event => event.type))
      .toEqual(['command/run', 'command/done'])
  })

  it.each(['ordinary text', '/unknown', ' \n/compact extra\t '])('preserves unclaimed query text %j', async (text) => {
    const h = await setup()
    h.register(() => { throw new Error('Must not execute a command') })
    const model = new TextModel()
    h.ctx.effect(() => h.ctx.llm.registerAdapter(['query-model'], model))
    await h.server.initialize({ cwd: process.cwd(), provider: 'query-model', model: 'model' })
    expect(await h.server.query({ sessionId: SessionId('q'), contentBlocks: [{ type: 'text', text }] })).toMatchObject({ kind: 'prompt' })
    await h.server.wait({ sessionId: 'q' })
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]!.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === text))).toBe(true)
    expect(h.ctx.agents.get(SessionId('q'))!.session.snapshotEvents().some(event => event.type === 'command/run')).toBe(false)
  })

  it('queues ordinary mixed blocks in their original order', async () => {
    const h = await setup()
    await h.initialize()
    h.register(() => ({ kind: 'success' }))
    await h.command()
    const agent = h.ctx.agents.get(SessionId('commands'))!
    const steer = vi.spyOn(agent, 'steer').mockImplementation(() => {})
    const queued = vi.spyOn(agent, 'followup').mockImplementation(() => {})
    const refs: ImageAttachmentRef[] = [
      { attachmentId: AttachmentId('first'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      { attachmentId: AttachmentId('second'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    ]
    const saveImages = vi.fn<AttachmentStore['saveImages']>(async () => refs)
    const store: Pick<AttachmentStore, 'saveImages'> = { saveImages }
    h.ctx.provide('attachments', store as AttachmentStore)
    const contentBlocks = [
      { type: 'text', text: 'Keep the original ordering.' },
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      { type: 'text', text: '/compact' },
      { type: 'image', attachment: refs[0] },
      { type: 'image', data: 'Ag==', mimeType: 'image/png' },
      { type: 'file', attachment: { attachmentId: 'saved-file', name: 'notes.txt', bytes: 1 } },
      { type: 'reasoning', text: 'existing content' },
    ]
    expect(await h.server.handleRequest('session/query', {
      sessionId: 'commands', contentBlocks,
    })).toMatchObject({ kind: 'prompt' })
    expect(saveImages).toHaveBeenCalledWith([
      { data: Uint8Array.of(1), mediaType: 'image/png' }, { data: Uint8Array.of(2), mediaType: 'image/png' },
    ])
    const admitted = [contentBlocks[0], { type: 'image', attachment: refs[0] }, contentBlocks[2], contentBlocks[3],
      { type: 'image', attachment: refs[1] }, contentBlocks[5], contentBlocks[6]]
    expect(queued).toHaveBeenCalledWith(expect.objectContaining({ content: admitted }))
    expect(steer).not.toHaveBeenCalled()
    expect(agent.session.snapshotEvents().map(event => event.type)).toEqual(['command/run', 'command/done'])
  })

  it.each(['/feedback inspect', '/model', '/file', '/export', '/permission', ' \n/权限\t '])('preserves existing prompt behavior for unimplemented input %s', async (text) => {
    const h = await setup()
    const model = new TextModel()
    h.ctx.effect(() => h.ctx.llm.registerAdapter(['query-model'], model))
    await h.server.initialize({ cwd: process.cwd(), provider: 'query-model', model: 'model' })
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    h.ctx.effect(() => h.ctx.commands.register({ name: 'feedback', description: 'Feedback', input: { hint: 'Task' }, handler }))
    h.ctx.effect(() => h.ctx.commands.register({ name: 'permission', definitionId: CommandDefinitionId('@deepseek-ai/dsh-permission-presets'), description: 'Permission', input: { hint: 'Preset' }, handler }))
    await expect(h.server.query({ sessionId: SessionId('q'), contentBlocks: [{ type: 'text', text }] })).resolves.toMatchObject({ kind: 'prompt' })
    await h.server.wait({ sessionId: 'q' })
    expect(handler).not.toHaveBeenCalled()
    expect(model.requests[0]!.messages.some(message => message.content.some(block => block.type === 'text' && block.text === text))).toBe(true)
    expect(h.ctx.agents.get(SessionId('q'))!.session.snapshotEvents().some(event => event.type === 'command/run')).toBe(false)
  })
})
