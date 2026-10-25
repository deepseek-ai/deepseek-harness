import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { type SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import SubagentRuntime from '../src/index.ts'
import { establishCatalogChild } from '../src/catalog.ts'
import { snapshotSubagentDescriptor } from '../src/descriptor.ts'
import { loadStoredSession, seedStoredSession } from './persistence-helpers.ts'
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
  let storage = persistent ? await ctx.plugin(JsonlSessionPersistence, { root: directory }) : undefined
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  await liveConfig(ctx, SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const parent = await ctx.agentLoop.create(brandString<SessionId>('model-selection-parent'), { provider: 'mock', model: 'initial' })
  return {
    ctx, parent, disposeStorage: () => storage?.dispose(),
    mountStorage: async () => { storage = await ctx.plugin(JsonlSessionPersistence, { root: directory }) },
  }
}

async function seedColdChild(ctx: Context, parent: Agent) {
  const childId = brandString<SessionId>('cold-model-selection')
  const descriptor = snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'cold child' })
  const header = { ...parent.session.header, id: childId, origin: 'subagent' as const, parentSession: parent.id }
  await seedStoredSession(ctx.sessionPersistence, header, [
    { type: 'subagent/descriptor', data: descriptor, seq: SessionSeq(0), time: Date.now() },
    { type: 'model/selection', data: { provider: 'mock', model: 'initial' }, seq: SessionSeq(1), time: Date.now() },
  ])
  establishCatalogChild(parent.session, header, descriptor, 'cold-child')
  return childId
}

it('confirms a cold selection when provider teardown drains its writer before append returns to the caller', async () => {
  const { ctx, parent, disposeStorage } = await harness()
  const childId = await seedColdChild(ctx, parent)
  const appended = Promise.withResolvers<undefined>()
  const releaseAppend = Promise.withResolvers<undefined>()
  const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
  const opened = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === childId && args[1] === 'write') {
      const append = handle.append.bind(handle)
      vi.spyOn(handle, 'append').mockImplementation(async (...appendArgs) => {
        await append(...appendArgs)
        appended.resolve(undefined)
        await releaseAppend.promise
      })
    }
    return handle
  })
  const selection = { provider: 'mock', model: 'selected' }
  const selecting = ctx.subagents.selectModel(childId, selection, { kind: 'user' }, new AbortController().signal)
  const outcome = selecting.then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await appended.promise
    await disposeStorage()
    releaseAppend.resolve(undefined)
    expect(await outcome).toEqual({ value: selection })
    expect(ctx.agents.get(childId)).toBeUndefined()
  } finally {
    releaseAppend.resolve(undefined)
    await outcome
    opened.mockRestore()
  }
})

it('reports a failed cold close barrier and releases its write ownership', async () => {
  const { ctx, parent } = await harness()
  const childId = await seedColdChild(ctx, parent)
  const failure = new Error('cold selection durability failed')
  const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
  const opened = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === childId && args[1] === 'write') {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close()
        throw failure
      })
    }
    return handle
  })
  try {
    await expect(ctx.subagents.selectModel(
      childId, { provider: 'mock', model: 'selected' }, { kind: 'user' }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PERSISTENCE_UNCONFIRMED', cause: failure })
  } finally {
    opened.mockRestore()
  }
  await using writer = await ctx.sessionPersistence.open(childId, 'write')
  const { events } = await writer.read()
  expect(events.at(-1)).toMatchObject({ type: 'model/selection', data: { provider: 'mock', model: 'selected' } })
  expect(ctx.agents.get(childId)).toBeUndefined()
})

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
