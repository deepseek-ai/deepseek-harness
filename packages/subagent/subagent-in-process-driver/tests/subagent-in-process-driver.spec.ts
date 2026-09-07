import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import SubagentRuntime, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { maxTokensResponse, MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

async function setup(script: Script, parentOptions: Partial<AgentOptions> = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock', ...parentOptions })
  return { ctx, parent, adapter }
}

function request(parent: Agent, signal = new AbortController().signal) {
  return {
    label: 'child task',
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal,
    descriptor: snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'test',
      label: 'child task',
    }),
  }
}

function text(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('startInProcessRun', () => {
  it('returns only after publication, drives a fresh child, and disposes it', async () => {
    const { ctx, parent } = await setup([textResponse('driver answer')])
    const run = await startInProcessRun(request(parent), {})
    expect(ctx.agents.get(run.id)).toBeDefined()
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('driver answer')
    expect(ctx.agents.get(run.id)!.options.subagentDepth).toBe(1)
    await run.dispose()
    await run.dispose()
    expect(ctx.agents.get(run.id)).toBeUndefined()
  })

  it('uses explicit child model selectors when the parent has none and preserves its cwd', async () => {
    const { ctx } = await setup([textResponse('driver answer')])
    const parent = await ctx.agentLoop.create(SessionId('bare-parent'), {}, { cwd: '/workspace' })
    const run = await startInProcessRun({
      ...request(parent),
      agentOptions: { provider: 'mock', model: 'mock' },
    }, {})

    const child = ctx.agents.get(run.id)!
    expect(child.options).toMatchObject({ provider: 'mock', model: 'mock' })
    expect(child.session.header.cwd).toBe('/workspace')
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose()
  })

  it('reports a prompt a pre-step rejection discarded as refusal, not completion', async () => {
    const { ctx, parent } = await setup([])
    // A UserPromptSubmit deny or a policy plugin: the child claims its prompt,
    // the rejection discards it, and the turn closes `blocked` with no step.
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === parent) return next()
      return { kind: 'reject' as const }
    })

    const run = await startInProcessRun(request(parent), {})
    await expect(run.result).resolves.toMatchObject({ stopReason: 'refusal' })
    await run.dispose()
  })

  it('does not add a final durability checkpoint to a foreground run', async () => {
    const { ctx, parent } = await setup([textResponse('driver answer')])
    let flushes = 0
    ctx.on('session/flush', (session) => {
      if (session.header.parentSession === undefined) return
      flushes++
      throw new Error('disk full')
    })

    const run = await startInProcessRun(request(parent), {})
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(flushes).toBe(0)
    await run.dispose()
  })

  it('keeps published run and handle disposal failures on separate channels', async () => {
    const { ctx, parent } = await setup([])
    const runError = new Error('published run failed')
    const disposalError = new Error('published handle disposal failed')
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const parentWithFailedDisposal = {
      options: parent.options,
      session: parent.session,
      ctx: {
        get: () => undefined,
        agents: {
          create: async (options: Parameters<typeof ctx.agents.create>[0]) => {
            const handle = await ctx.agents.create(options)
            handle.agent.followup = () => { throw runError }
            return {
              ...handle,
              dispose: async () => {
                await handle.dispose()
                throw disposalError
              },
            }
          },
        },
      },
    } as unknown as Agent

    const run = await startInProcessRun(request(parentWithFailedDisposal), {})
    expect(ctx.agents.get(run.id)).toBeDefined()
    await expect(run.result).rejects.toBe(runError)
    await expect(run.dispose()).rejects.toBe(disposalError)
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })
  it('reports the turn outcome when later metadata is appended during flush', async () => {
    const { ctx, parent } = await setup([maxTokensResponse('partial answer')])
    let injected = false
    ctx.on('session/flush', (session) => {
      if (injected || session.header.parentSession === undefined) return
      const lastEnd = session.snapshotEvents().findLast(event => event.type === 'turn/end')
      if (lastEnd?.type !== 'turn/end' || lastEnd.data.reason.kind !== 'max-tokens') return
      injected = true
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'late metadata' }],
        source: { kind: 'plugin', plugin: 'late-metadata' },
      }), { surfaceOp: 'append' })
    })

    const run = await startInProcessRun(request(parent), {})
    const result = await run.result
    const child = ctx.agents.get(run.id)!

    expect(injected).toBe(false)
    expect(child.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'max-tokens' } } })
    expect(result.stopReason).toBe('max-tokens')
    await run.dispose()
  })

  it('keeps earlier streamed text when the final step appends an empty usage-only message', async () => {
    // A tool-only max-tokens step records an empty assistant/message for
    // usage. The result retains the preceding assistant output.
    const { ctx, parent } = await setup([
      toolCallResponse('t1', 'noop', {}, 'partial one'),
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: ToolCallId('t2'), name: 'noop', argumentsDelta: '{}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('t2'), name: 'noop', arguments: '{}' } },
        { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    ])
    const disposeNoop = ctx.tools.register(defineContentToolFixture({
      name: 'noop', description: 'probe', parameters: {},
      execute() { return Promise.resolve([{ type: 'text', text: 'noop result' }]) },
    }))
    const run = await startInProcessRun(request(parent), {})
    const result = await run.result
    expect(result.stopReason).toBe('max-tokens')
    expect(text(result.output)).toBe('partial one')
    await run.dispose()
    disposeNoop()
  })

  it('seeds a forked child but reads only the child-owned output', async () => {
    const { ctx, parent } = await setup([textResponse('parent answer'), textResponse('child answer')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent question' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const seed = parent.session.snapshotEvents()
    const run = await startInProcessRun(request(parent), { seed })
    const result = await run.result
    expect(text(result.output)).toBe('child answer')
    const child = ctx.agents.get(run.id)!
    expect(child.session.header.isSeeded).toBe(true)
    expect(child.session.inheritedEventCount).toBe(seed.length)
    expect(child.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    await run.dispose()
  })

  it('persists the child origin and depth in its session header', async () => {
    const { ctx, parent } = await setup([textResponse('child answer')])
    const run = await startInProcessRun(request(parent), {})
    await run.result
    // The recursion budget is durable session data, not only runtime options —
    // a depth that lived only in AgentOptions would reset to 0 on resume.
    expect(ctx.agents.get(run.id)!.session.header).toMatchObject({
      origin: 'subagent',
      delegationDepth: 1,
    })
    await run.dispose()
  })

  it('inherits the parent output-token cap and accepts an explicit child override', async () => {
    const { ctx, parent, adapter } = await setup(
      [textResponse('inherited'), textResponse('overridden')],
      { maxTokens: 111 },
    )
    const inherited = await startInProcessRun(request(parent), {})
    await inherited.result
    expect(adapter.requests[0]?.maxTokens).toBe(111)
    expect(ctx.agents.get(inherited.id)?.options.maxTokens).toBe(111)
    await inherited.dispose()

    const overridden = await startInProcessRun({
      ...request(parent),
      agentOptions: { maxTokens: 222 },
    }, {})
    await overridden.result
    expect(adapter.requests[1]?.maxTokens).toBe(222)
    expect(ctx.agents.get(overridden.id)?.options.maxTokens).toBe(222)
    await overridden.dispose()
  })

  it('counts a RESUMED child by its persisted header depth, not the absent runtime depth', async () => {
    // Resume rebuilds runtime options, so the durable header must keep this
    // depth-1 child from delegating as though it were top-level.
    const { ctx } = await setup([textResponse('unused')])
    const resumed = (await ctx.agents.create({
      sessionId: SessionId('resumed-child'),
      meta: { parentSession: SessionId('root'), delegationDepth: 1 },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: new AbortController().signal,
    })).agent
    await expect(startInProcessRun({ ...request(resumed), maxDepth: 1 }, {}))
      .rejects.toMatchObject({ name: 'SubagentDepthError', attemptedDepth: 2, maxDepth: 1 })
  })

  it('lets runtime options deepen but never lower the persisted depth', async () => {
    const { ctx } = await setup([textResponse('unused')])
    const parent = (await ctx.agents.create({
      sessionId: SessionId('deep-parent'),
      meta: { delegationDepth: 2 },
      agentOptions: { provider: 'mock', model: 'mock', subagentDepth: 1 },
      signal: new AbortController().signal,
    })).agent
    // Persisted 2 vs runtime 1: the child is depth 3, so maxDepth 2 rejects.
    await expect(startInProcessRun({ ...request(parent), maxDepth: 2 }, {}))
      .rejects.toMatchObject({ name: 'SubagentDepthError', attemptedDepth: 3, maxDepth: 2 })
  })

  it('rejects invalid and exceeded depth before publication', async () => {
    const { parent } = await setup([])
    await expect(startInProcessRun({ ...request(parent), maxDepth: -1 }, {}))
      .rejects.toThrow('non-negative safe integer')
    await expect(startInProcessRun({ ...request(parent), maxDepth: 0 }, {}))
      .rejects.toMatchObject({ name: 'SubagentDepthError' })
    for (const value of [Number.NaN, 1.5, -1, -0, Number.MAX_SAFE_INTEGER + 1]) {
      const malformed = { options: { subagentDepth: value }, session: { header: {} } } as unknown as Agent
      await expect(startInProcessRun(request(malformed), {}))
        .rejects.toThrow('agent subagentDepth must be a non-negative safe integer')
    }
    const maxParent = { options: { subagentDepth: Number.MAX_SAFE_INTEGER }, session: { header: {} } } as unknown as Agent
    await expect(startInProcessRun(request(maxParent), {})).rejects.toBeInstanceOf(RangeError)
  })

  it('rejects an already-aborted request without publishing a child', async () => {
    const { ctx, parent } = await setup([])
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const controller = new AbortController()
    controller.abort('too late')
    await expect(startInProcessRun(request(parent, controller.signal), {}))
      .rejects.toThrow('aborted before child publication')
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })

  it('stamps only the resolved depth when neither parent nor request declares a model route', async () => {
    // The one-shot analogue of the deleted resume coverage ("resumes without
    // inventing undeclared agent model options"): a bare parent with no request
    // agentOptions yields a child whose options carry ONLY the stamped depth —
    // no provider/model is fabricated, so the child's turn errors for want of a
    // route rather than silently adopting one.
    const { ctx } = await setup([])
    const parent = await ctx.agentLoop.create(SessionId('routeless-parent'), {})
    const run = await startInProcessRun(request(parent), {})
    const child = ctx.agents.get(run.id)!
    expect(child.options).toEqual({ subagentDepth: 1 })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    await run.dispose()
  })

  it('uses the request signal after publication and dispose as cancellation paths', async () => {
    const { parent, adapter } = await setup(['hang', 'hang'])
    const controller = new AbortController()
    const signalled = await startInProcessRun(request(parent, controller.signal), {})
    await new Promise(resolve => setTimeout(resolve, 30))
    controller.abort('stop child')
    // No step completed a message, so the text streamed before the abort is
    // the cancelled run's output.
    await expect(signalled.result).resolves.toEqual({
      output: [{ type: 'text', text: 'partial' }],
      stopReason: 'aborted',
    })
    expect(adapter.requests[0]?.signal?.reason).toEqual({ kind: 'parent' })
    const child = parent.ctx.agents.get(signalled.id)
    const turnEnd = child?.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'parent' } })
    await signalled.dispose()

    const disposed = await startInProcessRun(request(parent), {})
    await new Promise(resolve => setTimeout(resolve, 30))
    await disposed.dispose()
    await expect(disposed.result).resolves.toMatchObject({ stopReason: 'aborted' })
  })

  it('cleans a failed unpublished setup before rejecting', async () => {
    const { ctx, parent } = await setup([])
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    await expect(startInProcessRun({
      ...request(parent),
      toolFilter: { deny: ['unknown-tool'] },
    }, {})).rejects.toThrow('unknown global tool')
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })

  it('treats abort after factory publication as a cancelled run with an id', async () => {
    const { ctx, parent } = await setup([])
    const controller = new AbortController()
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const parentWithAbortAtHandoff = {
      options: parent.options,
      session: parent.session,
      ctx: {
        // The driver's synchronous inheritance capture probes both policy
        // services opportunistically; this stub composes neither.
        get: () => undefined,
        agents: {
          create: async (options: Parameters<typeof ctx.agents.create>[0]) => {
            const handle = await ctx.agents.create(options)
            // `create()` has detached its creation-only listener, but the
            // published run has not installed its live listener yet.
            controller.abort('handoff race')
            return handle
          },
        },
      },
    } as unknown as Agent
    const run = await startInProcessRun(request(parentWithAbortAtHandoff, controller.signal), {})
    expect(ctx.agents.get(run.id)).toBeDefined()
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
    await run.dispose()
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })
})
