import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { mountLocalActivations, startTestActivation as start } from '../../subagent/tests/local-activation.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context, symbols, type EffectMeta } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as spawn from '../src/index.ts'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent'
import { brandString } from '@deepseek-ai/dsh-brand'

type Script = ConstructorParameters<typeof MockAdapter>[0]

/**
 * Drives the REAL spawn backend end-to-end: a real agent loop + a scripted mock
 * MODEL (the only mocked boundary) + the real SubagentRuntime.
 * The parent is a real config agent; the spawn provider creates a real child
 * agent on the same context and we assert its output.
 */
async function setup(storage: 'jsonl' | 'sqlite', script: Script) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(storage, ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(brandString<SessionId>('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

function text(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
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
  it.each(['jsonl', 'sqlite'] as const)('%s: runs a fresh child to completion and returns its final assistant output', async (storage) => {
    // One model call for the child: a plain text answer.
    const { ctx, parent } = await setup(storage, [textResponse('child answer')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'do X' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('child answer')
    await run.dispose()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: emits subagent/start only after the fresh child is published', async (storage) => {
    const { ctx, parent } = await setup(storage, [textResponse('child answer')])
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

  it.each(['jsonl', 'sqlite'] as const)("%s: gives the child its OWN session (not the parent's), with parentSession lineage", async (storage) => {
    const { ctx, parent } = await setup(storage, [textResponse('hi')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await run.result
    const child = run.localAgent
    expect(child.session.header.id).not.toBe(parent.session.header.id)
    expect(child.session.header.parentSession).toBe(parent.session.header.id)
    await run.dispose()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: a fresh child does NOT inherit the parent conversation (its log starts empty before the prompt)', async (storage) => {
    // Drive the parent through one real turn so it has history, THEN spawn.
    const { ctx, parent } = await setup(storage, [textResponse('parent turn'), textResponse('child sees nothing')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent prompt' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const parentEventCount = parent.session.snapshotEvents().length
    expect(parentEventCount).toBeGreaterThan(0)

    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'child prompt' }], parent })
    await run.result
    const child = run.localAgent
    // The child's first user/message is its OWN prompt, not the parent's history.
    const firstUser = child.session.snapshotEvents().find(e => e.type === 'user/message')
    expect(firstUser).toBeDefined()
    await run.dispose()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: releases the child before delivering its result', async (storage) => {
    const { ctx, parent } = await setup(storage, [textResponse('x')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    expect(ctx.agents.get(run.id)).toBeDefined()
    await run.result
    expect(ctx.agents.get(run.id)).toBeUndefined()
    await run.dispose()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: stamps child depth = parent depth + 1 (via the merged AgentOptions field)', async (storage) => {
    const { ctx, parent } = await setup(storage, [textResponse('x')])
    expect(parent.options.subagentDepth).toBeUndefined()
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await run.result
    const child = run.localAgent
    expect(child.options.subagentDepth).toBe(1)
    await run.dispose()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: refuses to spawn past maxDepth (depthLimit capability)', async (storage) => {
    const { ctx, parent } = await setup(storage, [])
    // parent is depth 0, child would be depth 1 — cap at 0 forbids any child.
    await expect(start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent, maxDepth: 0 }))
      .rejects.toMatchObject({
        name: 'SubagentDepthError', code: 'DEPTH_EXCEEDED', message: 'subagent depth 1 exceeds maxDepth 0',
        attemptedDepth: 1, maxDepth: 0,
      })
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: maps a child that hit its token ceiling to stopReason "max-tokens"', async (storage) => {
    const { ctx, parent } = await setup(storage, [maxTokensResponse('cut off')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('max-tokens')
    await run.dispose()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: maps a child whose turn errored (script exhausted) to stopReason "error" with empty output', async (storage) => {
    // Empty script: the child's first model call throws "script exhausted", the
    // turn ends `error`, and there is no assistant/message → empty output.
    const { ctx, parent } = await setup(storage, [])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([])
    await run.dispose()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: rejects without publishing when the request signal is already aborted', async (storage) => {
    // An already-aborted signal emits no future event, so start must check it before listening and
    // settle aborted without running the child. The empty model script proves no turn occurs.
    const controller = new AbortController()
    controller.abort()
    const { ctx, parent } = await setup(storage, [])
    await expect(start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent, signal: controller.signal }))
      .rejects.toBe(controller.signal.reason)
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: same-tick cancellation rejects start and prevents child publication', async (storage) => {
    // Same-tick cancellation must win before async factory publication: no child may become
    // visible, `started` must not fulfill, and the empty script proves no model turn occurs.
    const { ctx, parent } = await setup(storage, [])
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
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

  it.each(['jsonl', 'sqlite'] as const)('%s: disposing a running child settles the activation as aborted', async (storage) => {
    // 'hang' makes the child's model stream one chunk then wait until aborted.
    const controller = new AbortController()
    const { ctx, parent } = await setup(storage, ['hang'])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent, signal: controller.signal })
    await new Promise(r => setTimeout(r, 30))
    await run.dispose()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await run.dispose()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: dispose cancels the child and reaches quiescence', async (storage) => {
    const { ctx, parent } = await setup(storage, ['hang'])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await new Promise(r => setTimeout(r, 30))
    await run.dispose()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: the provider supplies fresh local preparation for managed activations', async (storage) => {
    const { ctx, parent } = await setup(storage, [textResponse('x')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    expect('steer' in run).toBe(false)
    expect('resume' in run).toBe(false)
    await run.result
    // The spawn provider DOES advertise continuable creation, and — because a
    // spawned child starts fresh — contributes no seed.
    const provider = ctx.subagents.getProvider('spawn')!
    expect(typeof provider.prepareContinuable).toBe('function')
    const spec = await provider.prepareContinuable!({
      cwd: process.cwd(),
      sessionId: brandString<SessionId>('continuable-child'),
      parent,
      signal: new AbortController().signal,
    })
    expect(spec.seed).toBeUndefined()
    await run.dispose()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: inherits the parent cwd into the child session', async (storage) => {
    const { ctx } = await setup(storage, [textResponse('x')])
    // A parent WITH a cwd (config agents have none, so create one explicitly).
    const parentHandle = await ctx.agents.create({
      sessionId: brandString<SessionId>('cwd-parent-session'),
      meta: { cwd: '/tmp/parent-workspace' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'p' }], parent: parentHandle.agent })
    await run.result
    const child = run.localAgent
    expect(child.session.header.cwd).toBe('/tmp/parent-workspace')
    await run.dispose()
    await parentHandle.dispose()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: uses request.agentOptions.model when the parent has no model of its own', async (storage) => {
    const { ctx } = await setup(storage, [textResponse('explicit model child')])
    // A parent with NO model (its own turns would need one supplied per-request).
    const parentHandle = await ctx.agents.create({
      sessionId: brandString<SessionId>('modelless-parent-session'),
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

  it.each(['jsonl', 'sqlite'] as const)('%s: advertises every start-time capability', async (storage) => {
    const { ctx } = await setup(storage, [])
    const provider = ctx.subagents.getProvider('spawn')!
    expect(provider.capabilities).toEqual({
      agentOptions: true,
      agentPreset: true,
      outputSchema: true,
      depthLimit: true,
    })
  })

  it('unregisters the provider when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)

    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(spawn, { providerName: 'spawn' })
    expect(ctx.subagents.getProvider('spawn')).toBeDefined()
    await fiber.dispose()
    expect(ctx.subagents.getProvider('spawn')).toBeUndefined()
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: captures structured output through the shipped plugin (driver runtime, plugin wiring)', async (storage) => {
    const { ctx, parent } = await setup(storage, [
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

  it.each(['jsonl', 'sqlite'] as const)('%s: a backend unload does not revoke an accepted holder-owned run', async (storage) => {
    // Rebuild the stack by hand so we hold the backend's fiber.
    const ctx = new Context()
    const adapter = new MockAdapter(['hang'])
    await mountAgentLoopTestDependencies(ctx)
    await mountLocalActivations(storage, ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(brandString<SessionId>('parent'), { provider: 'mock', model: 'mock' })
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
    await run.dispose()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    await run.dispose()
  })

  it('a start racing an already-unloading backend cannot begin child creation', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(spawn, { providerName: 'spawn' })
    const parent = await ctx.agentLoop.create(brandString<SessionId>('parent'), { provider: 'mock', model: 'mock' })
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

  it.each(['jsonl', 'sqlite'] as const)('%s: spawning from a DISPOSING parent fails loud with no orphaned child (INACTIVE_EFFECT teaching error)', async (storage) => {
    const { ctx } = await setup(storage, [])
    // A handle-owned parent we can dispose (config agents dispose with the loop fiber).
    const parentHandle = await ctx.agents.create({
      sessionId: brandString<SessionId>('doomed-s'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await parentHandle.dispose()
    const before = ctx.agents.list().length
    const sessionsBefore = ctx.sessions.list().length
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    await expect(start(ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'do X' }],
      parent: parentHandle.agent,
    })).rejects.toThrow(/exact live parent agent/)
    expect(ctx.agents.list().length).toBe(before)
    expect(ctx.sessions.list()).toHaveLength(sessionsBefore)
    expect(published).toEqual([])
  })

  it.each(['jsonl', 'sqlite'] as const)('%s: parent disposal during the child setup transaction prevents every publication notification', async (storage) => {
    const { ctx } = await setup(storage, [])
    const parentHandle = await ctx.agents.create({
      sessionId: brandString<SessionId>('setup-race-parent-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
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
    await expect(starting).rejects.toThrow(/owner disposed during setup|inactive context|child lifecycle effect not found/)
    await parentHandle.dispose()

    expect(published).toEqual([])
  })
})
