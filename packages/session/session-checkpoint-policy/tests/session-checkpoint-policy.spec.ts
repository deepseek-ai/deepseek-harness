import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { ToolCallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistence, { type SessionHandle, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import * as checkpointPolicy from '../src/index.ts'

const contexts: Context[] = []

// The policy only requires the service's presence; it flushes through
// `ctx.sessions`, so no handle is ever opened in these tests.
class TestPersistence extends SessionPersistence {
  create(): Promise<SessionHandle> { return Promise.reject(new Error('not used')) }
  open(): Promise<SessionHandle> { return Promise.reject(new Error('not used')) }
  flush(): Promise<void> { return Promise.resolve() }
  stat(): Promise<SessionPersistenceSnapshot | undefined> { return Promise.resolve(undefined) }
  list(): Promise<readonly SessionPersistenceSnapshot[]> { return Promise.resolve([]) }
}

class RecordingAdapter extends LlmAdapter {
  constructor(private readonly order: string[]) { super() }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.order.push('adapter')
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TestPersistence)
  await ctx.plugin(checkpointPolicy)
  return ctx
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('session-checkpoint-policy request boundary', () => {
  it('awaits the live session checkpoint before constructing the downstream model stream', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('request-checkpoint'))
    session.append('turn/start', { turn: 1 })
    const gate = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.on('session/flush', async () => {
      order.push('flush:start')
      await gate.promise
      order.push('flush:end')
    })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter(order))

    const pending = drain(ctx.llm.stream({
      provider: 'mock', model: 'mock', messages: [], sessionId: session.id,
    }))
    await Promise.resolve()
    expect(order).toEqual(['flush:start'])
    gate.resolve(undefined)
    await pending
    expect(order).toEqual(['flush:start', 'flush:end', 'adapter'])
  })

  it('delegates a request without a live session without checkpointing', async () => {
    const ctx = await setup()
    const order: string[] = []
    ctx.on('session/flush', () => { order.push('flush') })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter(order))
    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [] }))
    expect(order).toEqual(['adapter'])
  })

  it('delegates an already-detached session id without checkpointing', async () => {
    const ctx = await setup()
    const order: string[] = []
    ctx.on('session/flush', () => { order.push('flush') })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter(order))
    await drain(ctx.llm.stream({
      provider: 'mock', model: 'mock', messages: [], sessionId: SessionId('detached'),
    }))
    expect(order).toEqual(['adapter'])
  })

  it('does not dispatch the adapter when the checkpoint rejects', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('request-failure'))
    const order: string[] = []
    ctx.on('session/flush', () => Promise.reject(new Error('disk unavailable')))
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter(order))
    await expect(drain(ctx.llm.stream({
      provider: 'mock', model: 'mock', messages: [], sessionId: session.id,
    }))).rejects.toThrow('disk unavailable')
    expect(order).toEqual([])
  })
})

describe('session-checkpoint-policy tool and step boundaries', () => {
  it('awaits the checkpoint before a top-level tool body', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('tool-checkpoint'))
    const agent = { session } as Agent
    const gate = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.on('session/flush', async () => {
      order.push('flush:start')
      await gate.promise
      order.push('flush:end')
    })
    ctx.tools.register({
      name: 'write', description: 'side effect', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { order.push('tool'); return null },
    })

    const pending = ctx.tools.execute({
      callId: ToolCallId('write-1'), name: 'write', arguments: {}, agent,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    expect(order).toEqual(['flush:start'])
    gate.resolve(undefined)
    await expect(pending).resolves.toMatchObject({ isError: false })
    expect(order).toEqual(['flush:start', 'flush:end', 'tool'])
  })

  it('does not dispatch when cancellation lands during the tool checkpoint', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('tool-checkpoint-cancel'))
    const agent = { session } as Agent
    const controller = new AbortController()
    const gate = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.on('session/flush', async () => {
      order.push('flush:start')
      await gate.promise
      order.push('flush:end')
    })
    ctx.tools.register({
      name: 'write', description: 'side effect', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { order.push('tool'); return null },
    })

    const pending = ctx.tools.execute({
      callId: ToolCallId('write-cancelled'), name: 'write', arguments: {}, agent,
      signal: controller.signal,
    })
    await Promise.resolve()
    expect(order).toEqual(['flush:start'])
    controller.abort('cancelled during checkpoint')
    gate.resolve(undefined)

    await expect(pending).resolves.toEqual({
      content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
      isError: true,
      error: {
        message: 'tool call aborted before dispatch',
        info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
      },
    })
    expect(order).toEqual(['flush:start', 'flush:end'])
  })

  it('turns a rejected checkpoint into an error result without running the tool body', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('tool-failure'))
    const agent = { session } as Agent
    let ran = false
    ctx.on('session/flush', () => Promise.reject(new Error('disk unavailable')))
    ctx.tools.register({
      name: 'write', description: 'side effect', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { ran = true; return null },
    })
    const result = await ctx.tools.execute({
      callId: ToolCallId('write-2'), name: 'write', arguments: {}, agent,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: disk unavailable' }])
    expect(ran).toBe(false)
  })

  it('reuses the outer checkpoint for a nested tool dispatch', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('nested-tool'))
    const agent = { session } as Agent
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })
    ctx.tools.register({
      name: 'nested', description: 'nested', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => null,
    })
    await ctx.tools.execute({
      callId: ToolCallId('nested-1'), name: 'nested', arguments: {}, agent,
      parent: Symbol('outer') as never,
      signal: new AbortController().signal,
    })
    expect(flushes).toBe(0)
  })

  it('checkpoints during pre-step processing', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('post-step'))
    const agent = { session } as Agent
    const flushed: string[] = []
    ctx.on('session/flush', (current) => { flushed.push(current.id) })
    const signal = new AbortController().signal
    await agentEvents(ctx, agent).waterfall(
      'agent/pre-step', { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter', messages: [] }),
    )
    expect(flushed).toEqual([session.id])
  })
})

describe('session-checkpoint-policy lifecycle', () => {
  it('removes its wrappers when the owning fiber is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(TestPersistence)
    const session = ctx.sessions.create(SessionId('disposed-policy'))
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([]))
    const fiber = await ctx.plugin(checkpointPolicy)
    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: session.id }))
    expect(flushes).toBe(1)
    await fiber.dispose()
    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: session.id }))
    expect(flushes).toBe(1)
  })

  it('keeps the Loader-safe namespace plugin shape', () => {
    expect('default' in checkpointPolicy).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(checkpointPolicy) as Record<string, unknown>
    expect(unwrapped).toBe(checkpointPolicy)
    expect(unwrapped.name).toBe('session-checkpoint-policy')
    expect(unwrapped.inject).toEqual(['llm', 'sessionPersistence', 'sessions', 'tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
