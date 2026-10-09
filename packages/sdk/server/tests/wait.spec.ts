import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
/** SDK task completion retains live failures that have no durable terminal outcome. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime, { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

async function setup(beforeServer?: (ctx: Context) => void) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-wait-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 5 }, () => textResponse('answer'))))
  beforeServer?.(ctx)
  const server = new HarnessSdkJsonRpcServer(ctx, {
    request: () => Promise.reject(new Error('the server must not request the client')),
    notify: () => {},
  })
  await server.initialize({ cwd: root, provider: 'mock', model: 'mock' })
  return {
    ctx, server,
    dispose: async () => {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('SDK session/wait with parked child input', () => {
  it.each([1, 2])('finishes after interrupting a child at depth %s with unclaimed steering', async (depth) => {
    const { ctx, server, dispose } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let closeChildren: (() => Promise<void>) | undefined
    let completion: Promise<void> | undefined
    try {
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
      const parent = ctx.agents.get(SessionId('main'))!
      await parent.whenIdle()
      ctx.subagents.registerProvider({
        name: 'local-test', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
        prepareContinuable: () => Promise.resolve({}),
      })
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        if (agent.session.header.parentSession !== undefined) {
          entered.resolve(undefined)
          await release.promise
        }
        return next()
      })
      let owner = parent
      let child = parent
      for (let level = 0; level < depth; level++) {
        const started = await ctx.subagents.startActivation({
          provider: 'local-test', label: 'interruptible child', delivery: 'caller', signal: new AbortController().signal,
          request: { parent: owner, prompt: [{ type: 'text', text: 'work' }] },
        })
        closeChildren ??= () => started.dispose()
        child = ctx.agents.get(started.childId)!
        if (level + 1 < depth) owner = child
      }
      await entered.promise
      await ctx.subagents.sendMessage(owner, child.id, [{ type: 'text', text: 'parked correction' }], { signal: new AbortController().signal })
      const finished = vi.fn()
      const waiting = server.wait({ sessionId: 'main' }).then(finished)
      completion = waiting
      void waiting.catch(() => undefined)
      ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: parent })
      release.resolve(undefined)
      await child.whenIdle()
      await vi.waitFor(() => { expect(finished).toHaveBeenCalledOnce() })
      await waiting
      expect(child.inbox.nextStep.length + child.inbox.nextTurn.length).toBeGreaterThan(0)
      expect(ctx.agents.get(child.id)).toBe(child)
      await expect(ctx.subagents.waitForChildren(parent)).resolves.toBe(false)
    } finally {
      release.resolve(undefined)
      await closeChildren?.()
      await completion?.catch(() => undefined)
      await dispose()
    }
  })
})

describe('SDK session/wait failures', () => {
  it('keeps an unowned descendant failure separate from the SDK root outcome', async () => {
    const { ctx, server, dispose } = await setup()
    try {
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
      const parent = ctx.agents.get(SessionId('main'))!
      await parent.whenIdle()
      const failure = new Error('delegated work failed')
      const observed: unknown[] = []
      ctx.on('agent/error', ({ agent, error }) => {
        if (agent.session.header.parentSession === parent.id) observed.push(error)
      })
      ctx.on('agent/pre-step', ({ agent }, next) => {
        if (agent.session.header.parentSession === parent.id) throw failure
        return next()
      })
      ctx.subagents.registerProvider({
        name: 'local-test', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
        prepareContinuable: () => Promise.resolve({}),
      })
      const warnings = vi.spyOn(ctx.logger, 'warn')
      const child = await ctx.subagents.startActivation({
        provider: 'local-test', label: 'child failure', delivery: 'caller', signal: new AbortController().signal,
        request: { parent, prompt: [{ type: 'text', text: 'delegated task' }] },
      })
      await expect(child.result).resolves.toMatchObject({ stopReason: 'error' })
      expect(observed).toEqual([failure])
      await expect(server.wait({ sessionId: 'main' })).resolves.toEqual({})
      expect(warnings).not.toHaveBeenCalled()
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'continue parent' }] })
      await expect(server.wait({ sessionId: 'main' })).resolves.toEqual({})
    } finally {
      await dispose()
    }
  })

  it.each([
    ['turn/start', 'before'], ['turn/start', 'during'],
    ['turn/end', 'before'], ['turn/end', 'during'],
  ] as const)('rejects a later %s failure %s waiting and allows successful recovery', async (failedEvent, timing) => {
    const { ctx, server, dispose } = await setup()
    const children = Promise.withResolvers<boolean>()
    try {
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
      const parent = ctx.agents.get(SessionId('main'))!
      await parent.whenIdle()
      const failure = new Error(`summary ${failedEvent} unavailable`)
      let completion: ReturnType<typeof server.wait> | undefined
      if (timing === 'during') {
        const waiting = Promise.withResolvers<undefined>()
        vi.spyOn(ctx.subagents, 'waitForChildren').mockImplementationOnce(() => {
          waiting.resolve(undefined)
          return children.promise
        })
        completion = server.wait({ sessionId: 'main' })
        void completion.catch(() => undefined)
        await waiting.promise
      }
      const append = parent.session.append.bind(parent.session)
      const appendSpy = vi.spyOn(parent.session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
        if (type === failedEvent) throw failure
        return (append as (...args: never[]) => unknown)(type as never, ...rest)
      }) as never)
      try {
        parent.followup(createUserMessage({ content: [{ type: 'text', text: 'child result' }], source: { kind: 'user' } }))
        children.resolve(true)
        if (timing === 'before') {
          await parent.whenIdle()
          completion = server.wait({ sessionId: 'main' })
        }
        await expect(completion).rejects.toBe(failure)
      } finally {
        appendSpy.mockRestore()
      }
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'recover' }] })
      await expect(server.wait({ sessionId: 'main' })).resolves.toEqual({})
      expect(parent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind)
        .toBe('completed')
    } finally {
      children.resolve(true)
      await dispose()
    }
  })

  it('leaves a represented turn error in the durable outcome', async () => {
    const { ctx, server, dispose } = await setup()
    try {
      ctx.on('agent/pre-step', () => { throw new Error('represented failure') })
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'fail normally' }] })
      await expect(server.wait({ sessionId: 'main' })).resolves.toEqual({})
      const parent = ctx.agents.get(SessionId('main'))!
      expect(parent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
        .toMatchObject({ kind: 'error', error: { message: 'represented failure' } })
    } finally {
      await dispose()
    }
  })

  it.each([new Error('terminal publication failed'), undefined])('retains an error emitted during terminal publication (%s)', async (failure) => {
    let enabled = true
    const { ctx, server, dispose } = await setup((ctx) => {
      ctx.on('session/event', (session, event) => {
        if (!enabled || event.type !== 'turn/end') return
        const agent = ctx.agents.get(session.id)
        if (agent === undefined) throw new Error('missing fixture Agent')
        ctx.emit('agent/error', { agent, turn: event.data.turn, step: 0, error: failure })
      })
    })
    try {
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
      await ctx.agents.get(SessionId('main'))!.whenIdle()
      await expect(server.wait({ sessionId: 'main' })).rejects.toBe(failure)
      enabled = false
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'recover' }] })
      await expect(server.wait({ sessionId: 'main' })).resolves.toEqual({})
    } finally {
      await dispose()
    }
  })
})
