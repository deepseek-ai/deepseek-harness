import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
/** A liveness failure states whether the runtime or only the agent loop went away, and what the server observed. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { HarnessSdkJsonRpcServer, type RuntimeProcessEvent } from '../src/server.ts'

const TIME = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`

/**
 * Real agent loop with one idle `main` Session; the system-prompt fiber is a dependency the loop requires.
 * The server observes the test's own root context as its runtime.
 */
async function setup(lastProcessEvent: () => RuntimeProcessEvent | undefined = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-disposal-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const systemPrompt = await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 5 }, () => textResponse('answer'))))
  const server = new HarnessSdkJsonRpcServer(ctx, {
    request: () => Promise.reject(new Error('the server must not request the client')),
    notify: () => {},
  }, {
    runtime: {
      unloading: () => ctx.fiber.state === FiberState.UNLOADING || ctx.fiber.state === FiberState.DISPOSED,
      lastProcessEvent,
    },
  })
  await server.initialize({ cwd: root, provider: 'mock', model: 'mock' })
  await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
  const main = ctx.agents.get(brandString<SessionId>('main'))!
  await main.whenIdle()
  return { ctx, server, main, systemPrompt }
}

describe('SDK liveness failure context', () => {
  it('names the first plugin unloading when the agent loop goes away while the runtime keeps running', async () => {
    const { ctx, server, systemPrompt } = await setup()

    await systemPrompt.dispose()

    await expect(server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'again' }] })).rejects.toThrow(new RegExp(
      `^session agent was disposed outside the server: main; the agent loop was unloaded at ${TIME} `
      + 'while the runtime keeps running; first plugin unloading at that time: "SystemPrompt"$',
    ))
    await server.shutdown()
    await ctx.fiber.dispose()
  })

  it.each([
    {
      label: 'the last process event observed before teardown',
      lastProcessEvent: () => ({ description: 'SIGTERM', at: new Date('2026-01-02T03:04:05.006Z') }),
      context: 'last process event before teardown: SIGTERM at 2026-01-02T03:04:05.006Z',
    },
    { label: 'that no process event was observed', lastProcessEvent: undefined, context: 'no process event was observed before teardown' },
  ])('reports $label when the runtime shuts down under a pending wait', async ({ lastProcessEvent, context }) => {
    const { ctx, server, main } = await setup(lastProcessEvent)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent.session.header.parentSession !== undefined) {
        entered.resolve(undefined)
        await release.promise
      }
      return next()
    })
    ctx.subagents.registerProvider({
      name: 'local-test', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
      prepareContinuable: () => Promise.resolve({}),
    })
    await ctx.subagents.startActivation({
      provider: 'local-test', label: 'running child', delivery: 'caller', signal: new AbortController().signal,
      parent: main, prompt: [{ type: 'text', text: 'work' }],
    })
    await entered.promise
    // The plugin entry shuts the server down from an effect of the same root.
    ctx.effect(() => () => server.shutdown(), 'test jsonrpc.serve')
    const waiting = server.wait({ sessionId: 'main' })
    const outcome = expect(waiting).rejects.toThrow(
      `session agent was disposed outside the server: main; the runtime is shutting down; ${context}`,
    )

    const agents = ctx.agents
    const disposing = ctx.fiber.dispose()
    // The wait is still joined to the child, so it reads the registry only after the root Agent has left.
    await vi.waitFor(() => { expect(agents.get(main.id)).toBeUndefined() })
    release.resolve(undefined)

    await outcome
    await disposing
  })
})
