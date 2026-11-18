/** Remote fork failures release any Agent created during setup. @module */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import * as persistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SqliteSessionHandle } from '../../../session/session-persistence-sqlite/src/sqlite.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createSessionTestRemote } from './test-remote.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-fork-source-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(persistence, { root, compression: 'none' })
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('parent reply')]))
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  const parent = await harness.create(SessionId('source'), { provider: 'mock', model: 'mock' })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent history' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  await ctx.sessions.flush(parent.session)
  const remote = await createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: tmpdir() })
  return { ctx, parent, remote, root }
}

it('releases child storage when the creation setup fails', async () => {
  const { ctx, parent, remote } = await fixture()
  const failure = new Error('child setup failed')
  let childId: SessionIdType | undefined
  // oxlint-disable-next-line typescript/unbound-method -- Called with the consumer-traced registry below.
  const create = AgentRegistry.prototype.create
  const created = vi.spyOn(ctx.agents, 'create').mockImplementation(async function (this: AgentRegistry, options) {
    childId = options.sessionId
    expect(options.parentSource).toEqual({ sessionId: parent.id, endSeq: parent.session.seq })
    expect(options.seed).toEqual([...parent.session.snapshotEvents(), expect.objectContaining({ type: 'session/end-seed', seq: parent.session.seq })])
    return create.call(this, { ...options, setup: () => { throw failure } })
  })
  onTestFinished(() => { created.mockRestore() })
  const result = await remote.fork({ sessionId: parent.id })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Expected failed Remote fork')
  expect(result.error.code).toBe('gateway/internal')
  expect(result.error.message).toContain(failure.message)
  expect(created).toHaveBeenCalledOnce()
  expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
  if (childId === undefined) throw new Error('Expected fork identity')
  const stored = await ctx.sessionPersistence.open(childId, 'write')
  await stored.close()
})

it('publishes the identity requested from the creation factory', async () => {
  const { ctx, parent, remote } = await fixture()
  const created = vi.spyOn(ctx.agents, 'create')
  onTestFinished(() => { created.mockRestore() })
  const result = await remote.fork({ sessionId: parent.id })
  if (!result.ok) throw result.error
  expect(result.value.sessionId).toBe(created.mock.calls[0]?.[0].sessionId)
  expect(ctx.agents.get(result.value.sessionId)?.id).toBe(result.value.sessionId)
  expect(created).toHaveBeenCalledOnce()
})

it('waits for parent durability and retains the selected cut while the parent continues', async () => {
  const { ctx, parent, remote, root } = await fixture()
  parent.session.append('session/title', { title: 'selected title', messageSeqs: [], source: { kind: 'user' } })
  const selected = parent.session.snapshotEvents()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- Called with the handle receiver below.
  const flush = SqliteSessionHandle.prototype.flush
  const flushing = vi.spyOn(SqliteSessionHandle.prototype, 'flush').mockImplementation(async function (this: SqliteSessionHandle, options) {
    if (this.id === parent.id) {
      entered.resolve(undefined)
      await release.promise
    }
    return flush.call(this, options)
  })
  const forked = remote.fork({ sessionId: parent.id })
  try {
    await entered.promise
    // The sharing backend drains the parent writer before the child row commits or publishes.
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
    expect(await ctx.sessionPersistence.list()).toHaveLength(1)
    parent.session.append('session/title', { title: 'later title', messageSeqs: [], source: { kind: 'user' } })
    release.resolve(undefined)
    const result = await forked
    if (!result.ok) throw result.error
    const child = ctx.sessions.get(result.value.sessionId)!
    expect(child.snapshotEvents().slice(0, selected.length)).toEqual(selected)
    expect(child.snapshotEvents()).toHaveLength(selected.length + 1)
    expect(child.snapshotEvents().at(-1)).toMatchObject({ type: 'session/end-seed', seq: selected.length })
    const reader = await ctx.sessionPersistence.open(child.id, 'read')
    try { expect((await reader.read()).events).toEqual(child.snapshotEvents()) } finally { await reader.close() }
    const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
    try {
      expect(db.prepare('SELECT base_seq FROM segments WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?)').get(child.id))
        .toEqual({ base_seq: selected.length })
    } finally { db.close() }
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([forked])
    flushing.mockRestore()
  }
})

it('does not publish a child after a parent flush failure and allows a later fork', async () => {
  const { ctx, parent, remote } = await fixture()
  const failure = new Error('parent write failed')
  parent.session.append('session/title', { title: 'unflushed title', messageSeqs: [], source: { kind: 'user' } })
  const flushing = vi.spyOn(SqliteSessionHandle.prototype, 'flush').mockImplementation(async function (this: SqliteSessionHandle) {
    if (this.id === parent.id) throw failure
  })
  const creating = vi.spyOn(ctx.sessionPersistence, 'create')
  try {
    const result = await remote.fork({ sessionId: parent.id })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected failed Remote fork')
    expect(result.error.code).toBe('gateway/internal')
    expect(result.error.message).toContain(failure.message)
    expect(creating).toHaveBeenCalledOnce()
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
    expect((await ctx.sessionPersistence.list()).map(entry => entry.header.id)).toEqual([parent.id])
    flushing.mockRestore()
    const retried = await remote.fork({ sessionId: parent.id })
    if (!retried.ok) throw retried.error
    expect(ctx.agents.get(retried.value.sessionId)).toBeDefined()
    expect(creating).toHaveBeenCalledTimes(2)
  } finally {
    flushing.mockRestore()
    creating.mockRestore()
  }
})

it('keeps cold read repairs in the child segment when the parent continues before creation', async () => {
  const { ctx, remote, root } = await fixture()
  const parent = Session.create(SessionId('cold-parent'))
  parent.append('turn/start', { turn: 1 })
  const writer = await ctx.sessionPersistence.create(parent.header)
  try { await writer.append(parent.snapshotEvents()) } finally { await writer.close() }
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  const creating = vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
    expect(options?.parentSource).toMatchObject({ sessionId: parent.id, endSeq: 1 })
    expect(options?.parentSource?.events).toMatchObject([
      { type: 'turn/start', seq: 0 },
      { type: 'turn/end', seq: 1, data: { reason: { kind: 'interrupted' } } },
      { type: 'session/end-seed', seq: 2, data: { inherited: true } },
    ])
    const parentWriter = await ctx.sessionPersistence.open(parent.id, 'write')
    try {
      await parentWriter.append([{ type: 'turn/end', seq: SessionSeq(1), time: 2,
        data: { turn: 1, reason: { kind: 'completed' } } }])
    } finally { await parentWriter.close() }
    return create(header, options)
  })
  onTestFinished(() => { creating.mockRestore() })
  const result = await remote.fork({ sessionId: parent.id })
  if (!result.ok) throw result.error
  const child = ctx.sessions.get(result.value.sessionId)
  expect(child?.snapshotEvents()).toMatchObject([
    { type: 'turn/start', seq: 0 },
    { type: 'turn/end', seq: 1, data: { reason: { kind: 'interrupted' } } },
    { type: 'session/end-seed', seq: 2, data: { inherited: true } },
  ])
  const reader = await ctx.sessionPersistence.open(result.value.sessionId, 'read')
  try { expect((await reader.read()).events).toEqual(child?.snapshotEvents()) } finally { await reader.close() }
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  try {
    expect(db.prepare('SELECT base_seq FROM segments WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?)').get(result.value.sessionId))
      .toEqual({ base_seq: 1 })
  } finally { db.close() }
})
