/** Fork creation failures release unaccepted child Agents and their storage ownership. @module */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as fork from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startTestActivation } from '../../subagent/tests/local-activation.ts'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'

async function fixture(script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('parent reply'), textResponse('child reply')]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fork-source-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(persistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 1 })
  await ctx.plugin(fork, { providerName: 'fork' })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('source'), { provider: 'mock', model: 'mock' })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent history' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  await ctx.sessions.flush(parent.session)
  return { ctx, parent, adapter }
}

it('reuses capacity and releases write ownership after fork setup fails', async () => {
  const { ctx, parent } = await fixture()
  const failure = new Error('child setup failed')
  const childIds: SessionIdType[] = []
  // oxlint-disable-next-line typescript/unbound-method -- Called with the consumer-traced registry below.
  const create = AgentRegistry.prototype.create
  const created = vi.spyOn(ctx.agents, 'create').mockImplementation(async function (this: AgentRegistry, options) {
    childIds.push(options.sessionId)
    expect(options.parentSource).toMatchObject({ sessionId: parent.id })
    expect(options.seed).toEqual(parent.session.snapshotEvents().slice(0, options.parentSource?.endSeq))
    return create.call(this, { ...options, setup: async (childCtx, child) => {
      await options.setup?.(childCtx, child)
      throw failure
    } })
  })
  onTestFinished(() => { created.mockRestore() })
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(startTestActivation(ctx, 'fork', { parent, prompt: [{ type: 'text', text: 'child task' }] })).rejects.toBe(failure)
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
  }
  expect(created).toHaveBeenCalledTimes(2)
  for (const childId of childIds) {
    const stored = await ctx.sessionPersistence.open(childId, 'write')
    await stored.close()
  }
})

it('transfers delegated creation to its owner', async () => {
  const { ctx, parent } = await fixture()
  const created = vi.spyOn(ctx.agents, 'create')
  onTestFinished(() => { created.mockRestore() })
  const run = await startTestActivation(ctx, 'fork', { parent, prompt: [{ type: 'text', text: 'child task' }] })
  expect((await run.result).stopReason).toBe('completed')
  await run.dispose()
  expect(created).toHaveBeenCalledOnce()
  expect(created.mock.calls[0]?.[0].parentSource).toMatchObject({ sessionId: parent.id })
  expect(created.mock.calls[0]?.[0].seed).toHaveLength(created.mock.calls[0]?.[0].parentSource?.endSeq ?? -1)
  expect(ctx.agents.get(run.id)).toBeUndefined()
  const stored = await ctx.sessionPersistence.open(run.id, 'write')
  await stored.close()
})

it('takes the completed parent prefix from the live log without including its in-flight turn', async () => {
  const { ctx, parent, adapter } = await fixture([textResponse('parent reply'), 'hang', textResponse('child reply')])
  const selected = parent.session.snapshotEvents()
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent in-flight prompt' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
  const flushing = vi.spyOn(ctx.sessions, 'flush')
  const opening = vi.spyOn(ctx.sessionPersistence, 'open')
  const run = await startTestActivation(ctx, 'fork', { parent, prompt: [{ type: 'text', text: 'child task' }] })
  try {
    expect(flushing).not.toHaveBeenCalledWith(parent.session)
    expect(opening).not.toHaveBeenCalledWith(parent.id, expect.anything(), expect.anything())
    expect((await run.result).stopReason).toBe('completed')
    expect(run.localAgent.session.inheritedEventCount).toBe(selected.length)
    expect(run.localAgent.session.snapshotEvents().slice(0, selected.length)).toEqual(selected)
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('parent history')
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).not.toContain('parent in-flight prompt')
    const reader = await ctx.sessionPersistence.open(run.id, 'read')
    try { expect((await reader.read()).events.slice(0, selected.length)).toEqual(selected) } finally { await reader.close() }
  } finally {
    await run.dispose()
    flushing.mockRestore()
    opening.mockRestore()
    parent.cancel({ kind: 'user' })
    await parent.whenIdle()
  }
})

it('releases capacity when fork creation is canceled while child storage is pending', async () => {
  const { ctx, parent } = await fixture()
  const release = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  const creating = vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
    entered.resolve(undefined)
    await release.promise
    return create(header, options)
  })
  const controller = new AbortController()
  const reason = new Error('caller canceled fork')
  const starting = startTestActivation(ctx, 'fork', { parent, prompt: [{ type: 'text', text: 'canceled task' }], signal: controller.signal })
  const rejected = expect(starting).rejects.toBe(reason)
  try {
    await entered.promise
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
    controller.abort(reason)
    await rejected
    release.resolve(undefined)
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
    creating.mockRestore()
    const retried = await startTestActivation(ctx, 'fork', { parent, prompt: [{ type: 'text', text: 'retry task' }] })
    try { expect((await retried.result).stopReason).toBe('completed') } finally { await retried.dispose() }
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([starting, rejected])
    creating.mockRestore()
  }
})
