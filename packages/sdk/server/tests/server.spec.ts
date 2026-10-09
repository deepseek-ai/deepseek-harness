import { MESSAGES_RESPONSE } from './messages-response.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { randomUUID } from 'node:crypto'
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import SubagentRuntime, { SubagentRunId, type SubagentStartRequest, type SubagentRun, type SubagentResult, type SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '../src/index.ts'

class FakeTransport implements JsonRpcTransportPeer {
  notifications: { method: string; params?: Record<string, unknown> }[] = []

  async request(method: string, params: object): Promise<unknown> {
    throw new Error(`the SDK server should not call host JSON-RPC method ${method} with ${JSON.stringify(params)}`)
  }

  notify(method: string, params?: object): void {
    this.notifications.push(params === undefined ? { method } : { method, params: params as Record<string, unknown> })
  }
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

async function mockCompletionServer(): Promise<{ url: string; requests: unknown[]; headers: IncomingMessage['headers'][] }> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(MESSAGES_RESPONSE)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests, headers }
}

async function makeHarness(storageDir: string, workingDirectory = false) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory })
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: storageDir })
  await new Promise(resolve => setTimeout(resolve, 50))
  return ctx
}

/** Feed SDK lifecycle inputs without coupling protocol projection tests to activation admission. */
async function startLifecycleFixture(
  ctx: Context, providerName: string, request: SubagentStartRequest, local = false,
): Promise<SubagentRun> {
  const provider = ctx.subagents.getProvider(providerName)
  if (provider?.start === undefined) throw new Error('missing lifecycle fixture provider')
  const run = await provider.start({ ...request, cwd: request.cwd ?? process.cwd() })
  const identity = { runId: SubagentRunId(randomUUID()), provider: providerName, id: run.id, local }
  const carrier = scopeTarget(ctx.subagents, request.parent)
  ctx.emit(carrier, 'subagent/start', identity)
  void run.result.then(
    (result) => { ctx.emit(carrier, 'subagent/end', { ...identity, stopReason: result.stopReason, ...result.output.length > 0 ? { lastAssistantMessage: result.output } : {} }) },
    () => { ctx.emit(carrier, 'subagent/end', { ...identity, stopReason: 'error' }) },
  )
  return run
}

/** Settle a scoped lifecycle fixture after the requested registry change. */
async function settleSubagent(
  ctx: Context,
  parent: Agent,
  info: Omit<SubagentRunEndInfo, 'runId' | 'local'> & { localAgent?: Agent },
  beforeSettle?: () => Promise<void>,
): Promise<void> {
  const result = Promise.withResolvers<SubagentResult>()
  const disposeProvider = ctx.subagents.registerProvider({
    name: info.provider,
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    async start() {
      return {
        id: info.id,
        result: result.promise,
        dispose: () => Promise.resolve(),
      }
    },
  })
  try {
    const run = await startLifecycleFixture(ctx, info.provider, {
      parent,
      prompt: [],
      signal: new AbortController().signal,
    }, info.localAgent !== undefined)
    await beforeSettle?.()
    if (info.lastAssistantMessage === undefined) {
      result.reject(new Error('synthetic infrastructure failure'))
    } else {
      result.resolve({ output: info.lastAssistantMessage, stopReason: info.stopReason })
    }
    await run.result.then(() => undefined, () => undefined)
    await run.dispose()
  } finally {
    disposeProvider()
  }
}

describe('HarnessSdkJsonRpcServer', () => {
  it('waits only for an existing SDK-owned session and includes a child-triggered root turn', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-wait-'))
    const ctx = await makeHarness(storageDir)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    class Adapter extends LlmAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({ provider, id: model, name: model })
      }
      async * stream(): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'answer' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new Adapter())
    try {
      await expect(server.handleRequest('session/wait', { sessionId: 'missing' })).rejects.toThrow('not initialized')
      await server.initialize({ cwd: storageDir, provider: 'mock', model: 'mock' })
      await expect(server.handleRequest('session/wait', {})).rejects.toThrow('sessionId string')
      await expect(server.handleRequest('session/wait', { sessionId: 'missing' })).rejects.toThrow('unknown SDK session')
      expect(ctx.agents.get(SessionId('missing'))).toBeUndefined()
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'delegate' }] })
      const parent = ctx.agents.get(SessionId('main'))!
      const observed = Promise.withResolvers<undefined>()
      const children = Promise.withResolvers<boolean>()
      vi.spyOn(ctx.subagents, 'waitForChildren')
        .mockImplementationOnce(() => { observed.resolve(undefined); return children.promise })
        .mockResolvedValue(false)
      let settled = false
      const waiting = server.handleRequest('session/wait', { sessionId: 'main' }).then((result) => { settled = true; return result })
      await observed.promise
      expect(settled).toBe(false)
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'child result' }], source: { kind: 'user' } }))
      children.resolve(true)
      await expect(waiting).resolves.toEqual({})
      expect(transport.notifications.filter(notification => notification.method === 'session.event'
        && notification.params?.sessionId === 'main'
        && (notification.params.event as SessionEvent).type === 'turn/end')).toHaveLength(2)
      await server.shutdown()
      await expect(server.handleRequest('session/wait', { sessionId: 'main' })).rejects.toThrow('unknown SDK session')
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('changes effective directories through RPC while preserving Session origins and replayable context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-directory-'))
    const child = join(root, 'child')
    await mkdir(child)
    const ctx = await makeHarness(join(root, 'sessions'), true)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('directory observed')]))
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    try {
      await expect(server.handleRequest('session/working-directory/get', { sessionId: 'a' }))
        .rejects.toThrow('SDK server is not initialized')
      await expect(server.handleRequest('session/working-directory/set', { sessionId: 'a', path: child }))
        .rejects.toThrow('SDK server is not initialized')
      expect(ctx.agents.list()).toEqual([])
      await server.initialize({ cwd: root, provider: 'mock', model: 'mock' })
      await expect(server.handleRequest('session/working-directory/get', { sessionId: 'a' })).resolves.toEqual({ cwd: root })
      const selected = await realpath(child)
      await expect(server.handleRequest('session/working-directory/set', { sessionId: 'a', path: 'child' })).resolves.toEqual({ cwd: selected })
      await expect(server.handleRequest('session/working-directory/get', { sessionId: 'b' })).resolves.toEqual({ cwd: root })
      const agent = ctx.agents.get(SessionId('a'))!
      expect(agent.session.header.cwd).toBe(root)
      await server.prompt({ sessionId: 'a', contentBlocks: [{ type: 'text', text: 'where' }] })
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().some(event => event.type === 'user/message'
        && event.data.content.some(block => block.type === 'text'
          && block.text.includes(JSON.stringify(selected))))).toBe(true)
      await expect(server.handleRequest('session/working-directory/get', {})).rejects.toThrow('sessionId')
      await expect(server.handleRequest('session/working-directory/set', { sessionId: 'a', path: 3 })).rejects.toThrow('path string')
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('creates a harness agent and calls the configured OpenAI-compatible endpoint', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      const init = await server.handleRequest('initialize', {
        cwd: storageDir,
        provider: 'deepseek-official',
        model: 'dsagent-model',
        reasoningEffort: 'max',
        maxTokens: 321,
      }) as { serverInfo: { name: string } }
      expect(init.serverInfo.name).toBe('deepseek-harness-sdk-runtime')

      const receipt = await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'fix it' }],
      })
      expect((receipt as { messageId?: unknown }).messageId).toBeTypeOf('string')

      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      const body = llmServer.requests[0] as {
        model: string
        messages: { role: string }[]
        system?: string
        output_config?: { effort: string }
        max_tokens?: number
      }
      expect(body.model).toBe('dsagent-model')
      expect(body.output_config).toEqual({ effort: 'max' })
      expect(body.max_tokens).toBe(321)
      expect(body.system).toBeTypeOf('string')
      expect(body.messages[0]?.role).toBe('user')
      expect(body.messages.at(-1)?.role).toBe('user')
      expect(llmServer.headers[0]?.['x-api-key']).toBe('test-key')
      expect(transport.notifications.some(n => n.method === 'session.event')).toBe(true)
      await vi.waitFor(() => {
        expect(transport.notifications.findLast(n => n.method === 'session.status')).toEqual({
          method: 'session.status',
          params: { sessionId: 'main', status: 'idle' },
        })
      })

      await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'again' }],
      })
      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(2) })

      const orphanHandle = await ctx.agents.create({
        sessionId: SessionId('orphan-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'dsagent-model' },
      })
      orphanHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'outside the sdk session map' }], source: { kind: 'user' } }))
      await orphanHandle.agent.whenIdle()
      await orphanHandle.dispose()
      expect(llmServer.requests).toHaveLength(3)

      await server.handleRequest('shutdown', undefined)
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('queues overlapping prompts for one session without blocking other sessions', async () => {
    const mainFollowup = vi.fn<Agent['followup']>()
    const mainAgent = ({
      id: SessionId('main'),
      followup: mainFollowup,
    } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const otherFollowup = vi.fn<Agent['followup']>()
    const otherAgent = ({
      id: SessionId('other'),
      followup: otherFollowup,
    } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const mainHandle = { agent: mainAgent, dispose: vi.fn(() => Promise.resolve()) }
    const otherHandle = { agent: otherAgent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn(async (options: { sessionId: SessionId }) =>
      String(options.sessionId) === 'main' ? mainHandle : otherHandle)
    const liveAgents = new Map<string, Agent>([['main', mainAgent], ['other', otherAgent]])
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create, get: (id: SessionId) => liveAgents.get(String(id)) },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    ;(server as unknown as { initialized: boolean }).initialized = true
    const prompt = (sessionId: string, text: string) => server.prompt({
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })

    expect((await prompt('main', 'first')).messageId).toBeTypeOf('string')
    expect((await prompt('main', 'overlap')).messageId).toBeTypeOf('string')
    expect((await prompt('other', 'independent')).messageId).toBeTypeOf('string')

    expect(mainFollowup).toHaveBeenCalledTimes(2)
    expect(otherFollowup).toHaveBeenCalledOnce()
    await server.shutdown()
    expect(mainHandle.dispose).toHaveBeenCalledOnce()
    expect(otherHandle.dispose).toHaveBeenCalledOnce()
  })

  it('admits inline SDK images before the user message enters the session', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({ id: SessionId('image'), followup } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const ref = {
      attachmentId: 'sha256:image',
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const saveImages = vi.fn(async () => [ref])
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(async () => handle), get: () => agent },
      get: (name: string) => name === 'attachments' ? { saveImages } : undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    ;(server as unknown as { initialized: boolean }).initialized = true

    await server.prompt({
      sessionId: 'image',
      contentBlocks: [
        { type: 'text', text: 'inspect' },
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      ],
    })

    expect(saveImages).toHaveBeenCalledWith([{ data: Uint8Array.of(1), mediaType: 'image/png' }])
    expect(followup.mock.calls[0]?.[0].content).toEqual([
      { type: 'text', text: 'inspect' },
      { type: 'image', attachment: ref },
    ])
    await server.shutdown()
  })

  it('rejects inline SDK images when the composition has no attachment store', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({ id: SessionId('image'), followup } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(async () => handle), get: () => agent },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    ;(server as unknown as { initialized: boolean }).initialized = true

    await expect(server.prompt({
      sessionId: 'image',
      contentBlocks: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })).rejects.toThrow('SDK image prompt requires an attachment store')
    expect(followup).not.toHaveBeenCalled()
    await server.shutdown()
  })

  it('rechecks agent liveness after asynchronous image admission', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({ id: SessionId('image-race'), followup } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const admitted = Promise.withResolvers<Array<{
      attachmentId: string
      mediaType: string
      bytes: number
    }>>()
    const saveImages = vi.fn(() => admitted.promise)
    let live = true
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: {
        create: vi.fn(async () => handle),
        get: () => live ? agent : undefined,
      },
      get: (name: string) => name === 'attachments' ? { saveImages } : undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    ;(server as unknown as { initialized: boolean }).initialized = true

    const prompting = server.prompt({
      sessionId: 'image-race',
      contentBlocks: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    live = false
    admitted.resolve([{ attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 1 }])

    await expect(prompting).rejects.toThrow('session agent was disposed outside the server: image-race')
    expect(followup).not.toHaveBeenCalled()
    await server.shutdown()
  })

  it('rejects a prompt for a session whose agent was disposed outside the server', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({
      id: SessionId('zombie'),
      followup,
      whenIdle: vi.fn(() => Promise.resolve()),
    } satisfies Pick<Agent, 'id' | 'followup' | 'whenIdle'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    // The registry drops the agent after creation, modelling an agent-loop-only
    // reload that leaves the server's SessionRecord pointing at a detached agent.
    let live = true
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: {
        create: vi.fn(async () => handle),
        get: (id: SessionId) => (live && String(id) === 'zombie' ? agent : undefined),
      },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    ;(server as unknown as { initialized: boolean }).initialized = true
    const prompt = (text: string) => server.prompt({
      sessionId: 'zombie',
      contentBlocks: [{ type: 'text', text }],
    })

    expect((await prompt('while live')).messageId).toBeTypeOf('string')
    live = false
    await expect(prompt('after detach')).rejects.toThrow('session agent was disposed outside the server: zombie')
    // The detached agent was never driven by the rejected prompt.
    expect(followup).toHaveBeenCalledOnce()
    await server.shutdown()
  })

  it('forwards whole-agent status without attributing a turn outcome', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const session = ctx.sessions.create(SessionId('message-outcome'))
    const agent = ({
      id: SessionId('message-outcome'),
      session,
    } satisfies Pick<Agent, 'id' | 'session'>) as Agent

    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/status', { agent, status: 'idle' })

    expect(transport.notifications.filter(notification => notification.method === 'session.status'))
      .toEqual([
        { method: 'session.status', params: { sessionId: 'message-outcome', status: 'running' } },
        { method: 'session.status', params: { sessionId: 'message-outcome', status: 'idle' } },
      ])
    await server.shutdown()
    await ctx.fiber.dispose()
  })

  it('notifies the host when a child session is created with parent lineage', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      ctx.sessions.create(SessionId('root-session'), {
        meta: { cwd: storageDir },
      })
      ctx.sessions.create(SessionId('child-session'), {
        meta: { cwd: storageDir, parentSession: SessionId('main') },
      })

      expect(transport.notifications).toContainEqual({
        method: 'subagent.started',
        params: {
          parentSessionId: 'main',
          childSessionId: 'child-session',
        },
      })

      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('creates an SDK session without an optional system prompt', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-no-system-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'plain-model' })
      await server.prompt({
        sessionId: 'plain',
        contentBlocks: [{ type: 'text', text: 'hello' }],
      })

      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('notifies the host when a subagent run settles', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-end-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('main'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      // A custom in-process provider may own its child at the provider/root
      // scope while preserving durable parent lineage.
      const handle = await ctx.agents.create({
        sessionId: SessionId('child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('main') },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      expect(ctx.agents.roots()).toContain(handle.agent)
      const parentlessHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('parentless-child-session'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: parentHandle.agent,
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'spawn',
        id: SessionId('child-session'),
        localAgent: handle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'child done' }],
      }, () => handle.dispose())
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'spawn',
        id: SessionId('parentless-child-session'),
        localAgent: parentlessHandle.agent,
        stopReason: 'error',
      }, () => parentlessHandle.dispose())

      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'child-session',
          parentSessionId: 'main',
          childSessionId: 'child-session',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'child done' }],
        },
      })
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'parentless-child-session',
          parentSessionId: 'main',
          childSessionId: 'parentless-child-session',
          status: 'error',
          stopReason: 'error',
        },
      })

      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('ignores a remote run id that collides with a local child of the same parent', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-remote-collision-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('collision-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const collidingChild = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('remote-run-id'),
        meta: { cwd: storageDir, parentSession: SessionId('collision-parent') },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: parentHandle.agent,
      })

      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'remote',
        id: SessionId('remote-run-id'),
        stopReason: 'completed',
        lastAssistantMessage: [],
      })

      expect(transport.notifications.some(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.agentId === 'remote-run-id',
      )).toBe(false)

      await collidingChild.dispose()
      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('retains locality across continuation runs on one live child', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-continuation-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('continuation-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const childHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('continuation-child'),
        meta: { cwd: storageDir, parentSession: SessionId('continuation-parent') },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: parentHandle.agent,
      })

      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'continuation',
        id: SessionId('continuation-child'),
        localAgent: childHandle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'first' }],
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'continuation',
        id: SessionId('continuation-child'),
        localAgent: childHandle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'second' }],
      }, () => childHandle.dispose())

      expect(transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'continuation-child',
      )).toHaveLength(2)

      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('correlates reused local ids by parent scope when runs settle out of order', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-reuse-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const oldParent = await ctx.agents.create({
        sessionId: SessionId('old-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const oldChild = await oldParent.agent.ctx.agents.create({
        sessionId: SessionId('reused-child'),
        meta: { cwd: storageDir, parentSession: SessionId('old-parent') },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: oldParent.agent,
      })
      const first = Promise.withResolvers<SubagentResult>()
      const sameLifetime = Promise.withResolvers<SubagentResult>()
      const replacement = Promise.withResolvers<SubagentResult>()
      const results = [first.promise, sameLifetime.promise, replacement.promise]
      let starts = 0
      const disposeProvider = ctx.subagents.registerProvider({
        name: 'reused',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start() {
          const result = results[starts]
          starts += 1
          if (result === undefined) throw new Error('unexpected fourth reused-id run')
          return Promise.resolve({ id: SessionId('reused-child'), result, dispose: () => Promise.resolve() })
        },
      })

      const firstRun = await startLifecycleFixture(ctx, 'reused', {
        parent: oldParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      }, true)
      const sameLifetimeRun = await startLifecycleFixture(ctx, 'reused', {
        parent: oldParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      }, true)
      sameLifetime.resolve({ output: [{ type: 'text', text: 'same lifetime' }], stopReason: 'completed' })
      await sameLifetimeRun.result
      await oldChild.dispose()
      const newParent = await ctx.agents.create({
        sessionId: SessionId('new-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const newChild = await newParent.agent.ctx.agents.create({
        sessionId: SessionId('reused-child'),
        meta: { cwd: storageDir, parentSession: SessionId('new-parent') },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: newParent.agent,
      })
      const secondRun = await startLifecycleFixture(ctx, 'reused', {
        parent: newParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      }, true)

      replacement.resolve({ output: [{ type: 'text', text: 'new lifetime' }], stopReason: 'completed' })
      await secondRun.result
      first.resolve({ output: [{ type: 'text', text: 'old lifetime' }], stopReason: 'completed' })
      await firstRun.result
      await Promise.resolve()

      const finished = transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'reused-child',
      )
      expect(finished.map(notification => notification.params?.lastAssistantMessage)).toEqual([
        [{ type: 'text', text: 'same lifetime' }],
        [{ type: 'text', text: 'new lifetime' }],
        [{ type: 'text', text: 'old lifetime' }],
      ])
      expect(finished.map(notification => notification.params?.parentSessionId)).toEqual([
        'old-parent',
        'new-parent',
        'old-parent',
      ])

      await firstRun.dispose()
      await sameLifetimeRun.dispose()
      await secondRun.dispose()
      disposeProvider()
      await newChild.dispose()
      await oldParent.dispose()
      await newParent.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('keeps locality bound to the accepted run across provider re-registration', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-provider-reuse-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parent = await ctx.agents.create({
        sessionId: SessionId('provider-reuse-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const child = await parent.agent.ctx.agents.create({
        sessionId: SessionId('provider-reuse-child'),
        meta: { cwd: storageDir, parentSession: SessionId('provider-reuse-parent') },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: parent.agent,
      })
      const localResult = Promise.withResolvers<SubagentResult>()
      const remoteResult = Promise.withResolvers<SubagentResult>()
      const unregisterLocal = ctx.subagents.registerProvider({
        name: 'reused-provider',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start: () => Promise.resolve({
          id: SessionId('provider-reuse-child'),
          result: localResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      const localRun = await startLifecycleFixture(ctx, 'reused-provider', {
        parent: parent.agent,
        prompt: [],
        signal: new AbortController().signal,
      }, true)
      unregisterLocal()

      const unregisterRemote = ctx.subagents.registerProvider({
        name: 'reused-provider',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start: () => Promise.resolve({
          id: SessionId('provider-reuse-child'),
          result: remoteResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      const remoteRun = await startLifecycleFixture(ctx, 'reused-provider', {
        parent: parent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })

      remoteResult.resolve({ output: [{ type: 'text', text: 'remote' }], stopReason: 'completed' })
      await remoteRun.result
      await Promise.resolve()
      expect(transport.notifications.some(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.lastAssistantMessage !== undefined,
      )).toBe(false)

      await child.dispose()
      localResult.resolve({ output: [{ type: 'text', text: 'local' }], stopReason: 'completed' })
      await localRun.result
      await Promise.resolve()
      expect(transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'provider-reuse-child',
      )).toEqual([{
        method: 'subagent.finished',
        params: {
          provider: 'reused-provider',
          agentId: 'provider-reuse-child',
          parentSessionId: 'provider-reuse-parent',
          childSessionId: 'provider-reuse-child',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'local' }],
        },
      }])

      await localRun.dispose()
      await remoteRun.dispose()
      unregisterRemote()
      await parent.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('uses the recorded local flag when start was missed and ignores remote runs', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-fallback-'))
    const ctx = await makeHarness(storageDir)
    let parentHandle: AgentHandle | undefined
    let handle: AgentHandle | undefined
    let failedHandle: AgentHandle | undefined
    try {
      parentHandle = await ctx.agents.create({
        sessionId: SessionId('fallback-parent'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      handle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('fallback-child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('fallback-parent') },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
        parentAgent: parentHandle.agent,
      })
      const fallbackChild = handle.agent
      failedHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('failed-child-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
        parentAgent: parentHandle.agent,
      })
      const missedStartResult = Promise.withResolvers<SubagentResult>()
      const disposeMissedStartProvider = ctx.subagents.registerProvider({
        name: 'fork',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: true,
        start: () => Promise.resolve({
          id: SessionId('fallback-child-session'),
          result: missedStartResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      // Start before the server subscribes. The terminal payload still carries
      // this run's exact local child without reconstructing it from ids.
      const missedStartRun = await startLifecycleFixture(ctx, 'fork', {
        parent: parentHandle.agent,
        prompt: [],
        signal: new AbortController().signal,
      }, true)
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: true })

      missedStartResult.resolve({ output: [], stopReason: 'max-tokens' })
      await missedStartRun.result
      await Promise.resolve()
      await missedStartRun.dispose()
      disposeMissedStartProvider()
      // The server also missed this agent's creation but sees the exact child
      // on the run lifecycle payload.
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork-live-fallback',
        id: SessionId('fallback-child-session'),
        localAgent: fallbackChild,
        stopReason: 'completed',
        lastAssistantMessage: [],
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork',
        id: SessionId('failed-child-session'),
        localAgent: failedHandle.agent,
        stopReason: 'error',
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork',
        id: SessionId('missing-child-agent'),
        stopReason: 'error',
      })

      // A result without output omits lastAssistantMessage from the wire; it
      // never sends `[]`.
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'fork',
          agentId: 'fallback-child-session',
          parentSessionId: 'fallback-parent',
          childSessionId: 'fallback-child-session',
          status: 'ok',
          stopReason: 'max-tokens',
        },
      })
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'fork',
          agentId: 'failed-child-session',
          parentSessionId: 'fallback-parent',
          childSessionId: 'failed-child-session',
          status: 'error',
          stopReason: 'error',
        },
      })
      expect(transport.notifications.some(n =>
        n.method === 'subagent.finished'
        && n.params?.agentId === 'missing-child-agent',
      )).toBe(false)

      await server.shutdown()
    } finally {
      await handle?.dispose()
      await failedHandle?.dispose()
      await parentHandle?.dispose()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('does not re-register an LLM adapter whose provider already has an owner', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-existing-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      const inspect = server as unknown as { hasAdapterFor(provider: string): boolean }

      expect(inspect.hasAdapterFor('deepseek-official')).toBe(true)
      expect(inspect.hasAdapterFor('missing-provider')).toBe(false)
      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'preinstalled-model' })

      expect(ctx.get('llm')?.listProviders().filter(provider => provider.id === 'deepseek-official')).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects a missing non-DeepSeek provider when an LLM service already exists', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-new-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await expect(server.initialize({ cwd: storageDir, provider: 'private', model: 'new-model' }))
        .rejects.toThrow('no adapter registered for provider "private"')

      expect(ctx.get('llm')?.listProviders()).toEqual([
        { id: 'deepseek-official', name: 'DeepSeek' },
      ])
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid initialize maxTokens %s at the wire boundary',
    async (maxTokens) => {
      const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-invalid-max-tokens-'))
      const ctx = await makeHarness(storageDir)
      try {
        const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
        await expect(server.initialize({
          cwd: storageDir,
          provider: 'deepseek-official',
          model: 'model',
          maxTokens,
        })).rejects.toThrow('initialize maxTokens must be a positive safe integer')
        await server.shutdown()
      } finally {
        await ctx.fiber.dispose()
        await rm(storageDir, { recursive: true, force: true })
      }
    },
  )

  it('rejects malformed initialize reasoningEffort values at the wire boundary', async () => {
    const ctx = new Context()
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    try {
      for (const reasoningEffort of ['', 42]) {
        await expect(server.handleRequest('initialize', {
          cwd: '.',
          provider: 'deepseek-official',
          model: 'model',
          reasoningEffort,
        })).rejects.toThrow('initialize reasoningEffort must be a non-empty string')
      }
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an unavailable exact model during initialize', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-invalid-route-'))
    const ctx = await makeHarness(storageDir)
    class RejectingAdapter extends LlmAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.reject(new Error(`model unavailable: ${provider}/${model}`))
      }

      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new Error('unreachable')
      }
    }
    const disposeAdapter = ctx.llm.registerAdapter(['private'], new RejectingAdapter())
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      await expect(server.initialize({ cwd: storageDir, provider: 'private', model: 'missing' }))
        .rejects.toThrow('model unavailable: private/missing')
      await expect(server.prompt({
        sessionId: 'invalid-route',
        contentBlocks: [{ type: 'text', text: 'must not run' }],
      })).rejects.toThrow('SDK server is not initialized')
      expect((server as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      await server.shutdown()
    } finally {
      disposeAdapter()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects prompts while exact-route initialization is pending', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-pending-route-'))
    const ctx = await makeHarness(storageDir)
    const resolution = Promise.withResolvers<LlmResolvedModelInfo>()
    const resolvedModel = { provider: 'private', id: 'selected', name: 'Selected' }
    let resolveModelCalled = false
    class PendingAdapter extends LlmAdapter {
      override resolveModel(): Promise<LlmResolvedModelInfo> {
        resolveModelCalled = true
        return resolution.promise
      }

      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new Error('unreachable')
      }
    }
    const disposeAdapter = ctx.llm.registerAdapter(['private'], new PendingAdapter())
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      const initialization = server.initialize({ cwd: storageDir, provider: 'private', model: 'selected' })
      await vi.waitFor(() => { expect(resolveModelCalled).toBe(true) })

      await expect(server.prompt({
        sessionId: 'too-early',
        contentBlocks: [{ type: 'text', text: 'must not run' }],
      })).rejects.toThrow('SDK server is not initialized')
      expect((server as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)

      resolution.resolve(resolvedModel)
      await initialization
      await server.shutdown()
    } finally {
      resolution.resolve(resolvedModel)
      disposeAdapter()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects an unsupported reasoning effort during initialize', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-unsupported-reasoning-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      await expect(server.handleRequest('initialize', {
        cwd: storageDir,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'impossible',
      })).rejects.toThrow('does not support reasoning effort "impossible"')
      expect((server as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('reports no adapter when the LLM service is absent', async () => {
    const ctx = new Context()
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
        hasAdapterFor(model: string): boolean
        shutdown(): Promise<Record<string, never>>
      }

      expect(server.hasAdapterFor('missing-model')).toBe(false)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects unknown JSON-RPC runtime methods', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-unknown-'))
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await expect(server.handleRequest('does/not/exist', {}))
        .rejects
        .toThrow('unknown DeepSeek Harness SDK runtime method: does/not/exist')

      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('coalesces concurrent session creation and retries a failed creation', async () => {
    let resolveShared: ((handle: AgentHandle) => void) | undefined
    const sharedCreation = new Promise<AgentHandle>((resolve) => { resolveShared = resolve })
    const sharedHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const retryHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockReturnValueOnce(sharedCreation)
      .mockRejectedValueOnce(new Error('creation failed'))
      .mockResolvedValueOnce(retryHandle)
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create, get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      getOrCreateSession(sessionId: string): Promise<{ handle: AgentHandle }>
      shutdown(): Promise<Record<string, never>>
    }

    const first = server.getOrCreateSession('shared')
    const second = server.getOrCreateSession('shared')
    expect(create).toHaveBeenCalledTimes(1)
    resolveShared?.(sharedHandle)
    const [firstRecord, secondRecord] = await Promise.all([first, second])
    expect(firstRecord).toBe(secondRecord)

    await expect(server.getOrCreateSession('retry')).rejects.toThrow('creation failed')
    await expect(server.getOrCreateSession('retry')).resolves.toMatchObject({ handle: retryHandle })
    expect(create).toHaveBeenCalledTimes(3)

    await server.shutdown()
    expect(sharedHandle.dispose).toHaveBeenCalledOnce()
    expect(retryHandle.dispose).toHaveBeenCalledOnce()
    await expect(server.getOrCreateSession('after-shutdown')).rejects.toThrow('SDK server is shutting down')
  })

  it('resolves a relative cwd before creating the session', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('answer')], {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
    }))
    const create = vi.spyOn(ctx.agents, 'create')
    const resolveCallConfig = vi.spyOn(ctx.llm, 'resolveCallConfig')
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    try {
      await server.initialize({ cwd: '.', provider: 'mock', model: 'model', reasoningEffort: ReasoningEffortId('high'), maxTokens: 123 })
      await server.prompt({ sessionId: 'relative', contentBlocks: [{ type: 'text', text: 'test relative cwd' }] })
      await server.wait({ sessionId: 'relative' })

      expect(resolveCallConfig).toHaveBeenCalledWith({
        provider: 'mock',
        model: 'model',
        reasoningEffort: ReasoningEffortId('high'),
        maxTokens: 123,
      })
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        meta: { cwd: process.cwd() },
        agentOptions: {
          provider: 'mock',
          model: 'model',
          reasoningEffort: ReasoningEffortId('high'),
          maxTokens: 123,
        },
      }))
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
    }
  })

  it('settles every teardown and aggregates multiple failures', async () => {
    const firstDispose = vi.fn(() => { throw new Error('first teardown failed') })
    const secondDispose = vi.fn(() => Promise.reject(new Error('second teardown failed')))
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(), get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      sessions: Map<string, { handle: AgentHandle; lastTurnEnd: undefined; activePrompt: boolean }>
      shutdown(): Promise<Record<string, never>>
    }
    server.sessions.set('first', { handle: { agent: {} as Agent, dispose: firstDispose }, lastTurnEnd: undefined, activePrompt: false })
    server.sessions.set('second', { handle: { agent: {} as Agent, dispose: secondDispose }, lastTurnEnd: undefined, activePrompt: false })

    await expect(server.shutdown()).rejects.toThrow('SDK server teardown failed')
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('continues teardown after a subscription disposer fails', async () => {
    let subscription = 0
    const disposed: number[] = []
    const listenerFailure = new Error('listener teardown failed')
    const on = vi.fn(() => {
      const id = ++subscription
      return () => {
        disposed.push(id)
        if (id === subscription) throw listenerFailure
      }
    })
    const ctx = {
      on,
      agents: { create: vi.fn(), get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

    await expect(server.shutdown()).rejects.toBe(listenerFailure)
    expect(disposed.toSorted()).toEqual(Array.from({ length: subscription }, (_, index) => index + 1))
  })
})
