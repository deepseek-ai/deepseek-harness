import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import SubagentRuntime from '../src/index.ts'
import { loadStoredSession } from './persistence-helpers.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

async function harness(persistent = true) {
  const ctx = new Context()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-selection-lifecycle-'))
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
  await mountAgentLoopTestDependencies(ctx)
  if (persistent) await ctx.plugin(JsonlSessionPersistence, { root: directory })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  await liveConfig(ctx, SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const parent = await ctx.agentLoop.create(brandString<SessionId>('model-selection-parent'), { provider: 'mock', model: 'initial' })
  return {
    ctx, parent,
    mountStorage: async () => { await ctx.plugin(JsonlSessionPersistence, { root: directory }) },
  }
}

it('rejects a volatile child selection even when a non-persistence flush listener participates', async () => {
  const { ctx, parent } = await harness(false)
  const flushHint = vi.fn()
  ctx.on('session/flush', flushHint)
  const target = await ctx.subagents.startActivation({
    provider: 'spawn', label: 'volatile child', parent,
    prompt: [{ type: 'text', text: 'work' }], delivery: 'caller', signal: new AbortController().signal,
  })
  try {
    await expect(ctx.subagents.selectModel(
      target.childId, { provider: 'mock', model: 'selected' }, { kind: 'user' }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' })
    expect(ctx.agents.get(target.childId)?.model.current()).toEqual({ provider: 'mock', model: 'initial' })
  } finally {
    await target.dispose()
  }
})

it('reports unconfirmed persistence for a child created before the backend was mounted', async () => {
  const { ctx, parent, mountStorage } = await harness(false)
  ctx.on('session/flush', () => undefined)
  const target = await ctx.subagents.startActivation({
    provider: 'spawn', label: 'volatile child', parent,
    prompt: [{ type: 'text', text: 'work' }], delivery: 'caller', signal: new AbortController().signal,
  })
  try {
    await mountStorage()
    const selected = { provider: 'mock', model: 'selected' }
    await expect(ctx.subagents.selectModel(
      target.childId, selected, { kind: 'user' }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PERSISTENCE_UNCONFIRMED' })
    expect(ctx.agents.get(target.childId)?.model.current()).toEqual(selected)
    await expect(loadStoredSession(ctx.sessionPersistence, target.childId)).rejects.toMatchObject({ name: 'SessionPersistenceNotFoundError' })
  } finally {
    await target.dispose()
  }
})
