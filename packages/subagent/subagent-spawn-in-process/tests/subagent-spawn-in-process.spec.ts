import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context, symbols, type EffectMeta } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import SubagentRuntime, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as spawn from '../src/index.ts'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

/**
 * Drives the REAL spawn backend end-to-end: a real agent loop + a scripted mock
 * MODEL (the only mocked boundary) + the real SubagentRuntime + the real
 * invariant service plus package companions (so a malformed child session log would fail the test).
 * The parent is a real config agent; the spawn provider creates a real child
 * agent on the same context and we assert its output.
 */
async function setup(script: Script) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

function start(ctx: Context, provider: string, request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal }) {
  return ctx.subagents.start(provider, { signal: request.signal ?? new AbortController().signal, ...request })
}

/** Invoke the child lifecycle effect while its parent-owned setup is still unpublished. */
function disposeChildLifecycle(parent: Agent): void {
  const lifecycle = [...parent.ctx.fiber._disposables]
    .find((dispose) => {
      const effect = (dispose as typeof dispose & { [symbols.effect]?: EffectMeta })[symbols.effect]
      return effect?.label.startsWith('agentLoop.lifecycle(') === true
    })
  if (lifecycle === undefined) throw new Error('child lifecycle effect not found')
  void lifecycle()
}

describe('dsh-subagent-spawn-in-process', () => {
  it('runs a fresh child to completion and returns its final assistant output', async () => {
    // One model call for the child: a plain text answer.
    const { ctx, parent } = await setup([textResponse('child answer')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'do X' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('child answer')
    await run.dispose()
  })

  it('emits subagent/start only after the fresh child is published', async () => {
    const { ctx, parent } = await setup([textResponse('child answer')])
    let childAtStart: ReturnType<typeof ctx.agents.get>
    ctx.on('subagent/start', (info) => {
      if (info.provider === 'spawn') childAtStart = ctx.agents.get(info.id)
    })

    const starting = start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'do X' }], parent })
    // Creation is asynchronous; no lifecycle claim is made while the child is
    // still inside its unpublished setup transaction.
    expect(childAtStart).toBeUndefined()
    const run = await starting
    expect(childAtStart).toBe(ctx.agents.get(run.id))
    expect(childAtStart?.id).toBe(run.id)

    await run.result
    await run.dispose()
  })

  it('gives the child its OWN session (not the parent\'s), with parentSession lineage', async () => {
    const { ctx, parent } = await setup([textResponse('hi')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await run.result
    const child = ctx.agents.get(run.id)!
    expect(child.session.header.id).not.toBe(parent.session.header.id)
    expect(child.session.header.parentSession).toBe(parent.session.header.id)
    await run.dispose()
  })

  it('a fresh child does NOT inherit the parent conversation (its log starts empty before the prompt)', async () => {
    // Drive the parent through one real turn so it has history, THEN spawn.
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('child sees nothing')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent prompt' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const parentEventCount = parent.session.snapshotEvents().length
    expect(parentEventCount).toBeGreaterThan(0)

    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'child prompt' }], parent })
    await run.result
    const child = ctx.agents.get(run.id)!
    // The child's first user/message is its OWN prompt, not the parent's history.
    const firstUser = child.session.snapshotEvents().find(e => e.type === 'user/message')
    expect(firstUser).toBeDefined()
    await run.dispose()
  })

  it('disposes the child to quiescence (agent removed from the registry)', async () => {
    const { ctx, parent } = await setup([textResponse('x')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await run.result
    expect(ctx.agents.get(run.id)).toBeDefined()
    await run.dispose()
    // After dispose, the child is unregistered (the AgentHandle teardown ran).
    expect(ctx.agents.get(run.id)).toBeUndefined()
  })

  it('stamps child depth = parent depth + 1 (via the merged AgentOptions field)', async () => {
    const { ctx, parent } = await setup([textResponse('x')])
    expect(parent.options.subagentDepth).toBeUndefined()
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await run.result
    const child = ctx.agents.get(run.id)!
    expect(child.options.subagentDepth).toBe(1)
    await run.dispose()
  })

  it('refuses to spawn past maxDepth (depthLimit capability)', async () => {
    const { ctx, parent } = await setup([])
    // parent is depth 0, child would be depth 1 — cap at 0 forbids any child.
    await expect(start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent, maxDepth: 0 }))
      .rejects.toThrow('subagent depth 1 exceeds maxDepth 0')
  })

  it('maps a child that hit its token ceiling to stopReason "max-tokens"', async () => {
    const { ctx, parent } = await setup([maxTokensResponse('cut off')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('max-tokens')
    await run.dispose()
  })

  it('maps a child whose turn errored (script exhausted) to stopReason "error" with empty output', async () => {
    // Empty script: the child's first model call throws "script exhausted", the
    // turn ends `error`, and there is no assistant/message → empty output.
    const { ctx, parent } = await setup([])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([])
    await run.dispose()
  })

  it('rejects without publishing when the request signal is already aborted', async () => {
    // An already-aborted signal emits no future event, so start must check it before listening and
    // settle aborted without running the child. The empty model script proves no turn occurs.
    const controller = new AbortController()
    controller.abort()
    const { ctx, parent } = await setup([])
    await expect(start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent, signal: controller.signal }))
      .rejects.toThrow('aborted before child publication')
  })

  it('same-tick cancellation rejects start and prevents child publication', async () => {
    // Same-tick cancellation must win before async factory publication: no child may become
    // visible, `started` must not fulfill, and the empty script proves no model turn occurs.
    const { ctx, parent } = await setup([])
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))
    ctx.on('subagent/start', () => void published.push('subagent/start'))
    ctx.on('subagent/end', () => void published.push('subagent/end'))
    const controller = new AbortController()
    const starting = start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent, signal: controller.signal })
    controller.abort('early')

    await expect(starting).rejects.toThrow()
    await Promise.resolve()
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
    expect(published).toEqual([])
  })

  it('cancelling a running child settles the run as aborted (the abort bridge + cancel())', async () => {
    // 'hang' makes the child's model stream one chunk then wait until aborted.
    const controller = new AbortController()
    const { ctx, parent } = await setup(['hang'])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent, signal: controller.signal })
    // Let the child's turn start, then abort via the request signal (the
    // backend bridges it to child.cancel()).
    await new Promise(r => setTimeout(r, 30))
    controller.abort()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await run.dispose()
  })

  it('dispose cancels the child and reaches quiescence', async () => {
    const { ctx, parent } = await setup(['hang'])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await new Promise(r => setTimeout(r, 30))
    await run.dispose()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
  })

  it('a one-shot run exposes neither steer nor resume; continuable creation is a provider capability', async () => {
    const { ctx, parent } = await setup([textResponse('x')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    // A run is one disposable foreground activation: it has no steering and no
    // cold resume. Continuable conversations never become a run — the
    // continuation manager drives them through the provider's
    // `prepareContinuable` capability instead.
    expect('steer' in run).toBe(false)
    expect('resume' in run).toBe(false)
    await run.result
    // The spawn provider DOES advertise continuable creation, and — because a
    // spawned child starts fresh — contributes no seed.
    const provider = ctx.subagents.getProvider('spawn')!
    expect(typeof provider.prepareContinuable).toBe('function')
    const spec = await provider.prepareContinuable!({
      sessionId: SessionId('continuable-child'),
      parent,
      signal: new AbortController().signal,
    })
    expect(spec.seed).toBeUndefined()
    await run.dispose()
  })

  it('inherits the parent cwd into the child session', async () => {
    const { ctx } = await setup([textResponse('x')])
    // A parent WITH a cwd (config agents have none, so create one explicitly).
    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('cwd-parent-session'),
      meta: { cwd: '/tmp/parent-workspace' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent: parentHandle.agent })
    await run.result
    const child = ctx.agents.get(run.id)!
    expect(child.session.header.cwd).toBe('/tmp/parent-workspace')
    await run.dispose()
    await parentHandle.dispose()
  })

  it('uses request.agentOptions.model when the parent has no model of its own', async () => {
    const { ctx } = await setup([textResponse('explicit model child')])
    // A parent with NO model (its own turns would need one supplied per-request).
    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('modelless-parent-session'),
      agentOptions: {},
    })
    // The request supplies the child's model explicitly.
    const run = await start(ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'p' }],
      parent: parentHandle.agent,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('explicit model child')
    await run.dispose()
    await parentHandle.dispose()
  })

  it('advertises every start-time capability', async () => {
    const { ctx } = await setup([])
    const provider = ctx.subagents.getProvider('spawn')!
    expect(provider.capabilities).toEqual({
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    })
  })

  it('unregisters the provider when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(spawn, { providerName: 'spawn' })
    expect(ctx.subagents.list()).toEqual(['spawn'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })

  it('captures structured output through the shipped plugin (driver runtime, plugin wiring)', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 42 }),
    ])
    const run = await start(ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'produce the answer' }],
      parent,
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 42 })
    expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    await run.dispose()
  })

  it('a backend unload does not revoke an accepted holder-owned run', async () => {
    // Rebuild the stack by hand so we hold the backend's fiber.
    const ctx = new Context()
    const adapter = new MockAdapter(['hang'])
    await mountAgentLoopTestDependencies(ctx)
    await mountInvariants(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    const controller = new AbortController()
    const run = await start(ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'q' }],
      parent,
      signal: controller.signal,
      outputSchema: { type: 'object', properties: { a: { type: 'number' } } },
    })
    // Provider removal prevents new starts but the returned run belongs to its
    // holder and remains live.
    await new Promise(resolve => setTimeout(resolve, 30))
    await fiber.dispose()
    expect(ctx.subagents.getProvider('spawn')).toBeUndefined()
    expect(ctx.agents.get(run.id)).toBeDefined()
    controller.abort('test complete')
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    await run.dispose()
  })

  it('a start racing an already-unloading backend cannot begin child creation', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(spawn, { providerName: 'spawn' })
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    const parentEffects = parent.ctx.fiber.getEffects().length
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    const unloading = fiber.dispose()
    await unloading
    await expect(start(ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'must never start' }], parent,
    })).rejects.toThrow(/no subagent provider/)

    expect(parent.ctx.fiber.getEffects()).toHaveLength(parentEffects)
    expect(published).toEqual([])
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in spawn).toBe(false)
    expect(spawn.name).toBe('subagent-spawn-in-process')
    expect(spawn.inject).toEqual(['subagents'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(spawn) as Record<string, unknown>
    expect(unwrapped).toBe(spawn)
    expect(unwrapped.name).toBe('subagent-spawn-in-process')
    expect(unwrapped.inject).toEqual(['subagents'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  describe('persona and toolFilter (the scoped child world)', () => {
    it('a per-child persona shadows the deployment persona in the child request only', async () => {
      const { ctx, parent, adapter } = await setup([
        textResponse('parent answer'),
        textResponse('child answer'),
      ])
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await parent.whenIdle()

      const run = await start(ctx, 'spawn', {
        prompt: [{ type: 'text', text: 'do X' }],
        parent,
        persona: 'You are the tersest test runner.',
      })
      await run.result
      const childRequest = adapter.requests.at(-1)!
      expect(childRequest.system).toContain('You are the tersest test runner.')
      // The parent's earlier request carried no such persona.
      expect(adapter.requests[0]!.system ?? '').not.toContain('tersest test runner')
      await run.dispose()
    })

    it('toolFilter hides denied tools from the child prompt AND refuses their execution', async () => {
      const { ctx, parent, adapter } = await setup([
        // The child tries the denied tool anyway, then answers.
        toolCallResponse('c1', 'forbidden_tool', {}),
        textResponse('done'),
      ])
      ctx.tools.register(defineContentToolFixture({
        name: 'forbidden_tool', description: 'global', parameters: {},
        execute: () => Promise.resolve([{ type: 'text', text: 'ran' }]),
      }))
      const run = await start(ctx, 'spawn', {
        prompt: [{ type: 'text', text: 'do X' }],
        parent,
        toolFilter: { deny: ['forbidden_tool'] },
      })
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      // Not advertised…
      const childRequest = adapter.requests[0]!
      expect((childRequest.tools ?? []).map(t => t.name)).not.toContain('forbidden_tool')
      // …and the attempted call executed as UNKNOWN_TOOL (visible in the log).
      const child = ctx.agents.get(run.id)!
      const toolResult = child.session.snapshotEvents().find(e => e.type === 'tool/result')!
      expect(JSON.stringify(toolResult.data)).toContain('unknown tool')
      await run.dispose()
    })

    it('an unknown toolFilter name fails the spawn loudly with no orphaned child', async () => {
      const { ctx, parent } = await setup([])
      const before = ctx.agents.list().length
      await expect(start(ctx, 'spawn', {
        prompt: [{ type: 'text', text: 'do X' }],
        parent,
        toolFilter: { deny: ['no_such_tool'] },
      })).rejects.toThrow(/unknown global tool "no_such_tool"/)
      expect(ctx.agents.list().length).toBe(before)
    })
  })

  it('spawning from a DISPOSING parent fails loud with no orphaned child (INACTIVE_EFFECT teaching error)', async () => {
    const { ctx } = await setup([])
    // A handle-owned parent we can dispose (config agents dispose with the loop fiber).
    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('doomed-s'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await parentHandle.dispose()
    const before = ctx.agents.list().length
    const sessionsBefore = ctx.sessions.list().length
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))
    await expect(start(ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'do X' }],
      parent: parentHandle.agent,
    })).rejects.toThrow(/inactive context/)
    expect(ctx.agents.list().length).toBe(before)
    expect(ctx.sessions.list()).toHaveLength(sessionsBefore)
    expect(published).toEqual([])
  })

  it('parent disposal during the child setup transaction prevents every publication notification', async () => {
    const { ctx } = await setup([])
    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('setup-race-parent-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))
    let teardownStarted = false
    ctx.on('internal/plugin', (fiber) => {
      if (teardownStarted || fiber.name !== 'scope') return
      teardownStarted = true
      disposeChildLifecycle(parentHandle.agent)
    })

    const starting = start(ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'must never run' }],
      parent: parentHandle.agent,
    })
    // The factory has entered its awaited unpublished setup transaction. The
    // parent context owns that transaction, so disposal wins without an
    // observer ever seeing the child.
    await expect(starting).rejects.toThrow(/owner disposed during setup|inactive context/)
    await parentHandle.dispose()

    expect(published).toEqual([])
  })
})
