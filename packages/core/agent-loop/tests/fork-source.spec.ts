/** Fork creation stores the supplied history; a sharing backend persists the parent prefix first. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as sqlitePersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import { storedEvents, tailSegment } from '../../../session/session-persistence-sqlite/tests/fixtures/store.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'

async function fixture(storage: 'sqlite' | 'jsonl' = 'sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-fork-source-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(storage === 'sqlite' ? sqlitePersistence : persistence, { root, compression: 'none' })
  await mountAgentLoopTestHarness(ctx)
  return { ctx, root }
}

it.each(['sqlite', 'jsonl'] as const)('stores a prepared open-prefix seed without changing its marker or repair order (%s)', async (storage) => {
  const { ctx } = await fixture(storage)
  const parent = ctx.sessions.create(SessionId('parent'))
  const writer = await ctx.sessionPersistence.create(parent.header)
  onTestFinished(() => writer.close())
  parent.append('turn/start', { turn: 1 })
  const seed = buildForkSeed(parent.snapshotEvents(), SessionSeq(0))
  const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
  const open = vi.spyOn(ctx.sessionPersistence, 'open')
  onTestFinished(() => { stat.mockRestore(); open.mockRestore() })
  const child = await ctx.agents.create({
    sessionId: SessionId('child'), inheritedEventCount: SessionLogOffset(1),
    meta: { isSeeded: true }, seed, parentSource: { sessionId: parent.id, endSeq: SessionLogOffset(1) },
  })
  expect(stat).not.toHaveBeenCalledWith(parent.id)
  expect(open).not.toHaveBeenCalledWith(parent.id, expect.anything(), expect.anything())
  expect(child.agent.session.snapshotEvents()).toEqual(seed)
  expect(seed).toMatchObject([
    { type: 'turn/start', seq: 0 }, { type: 'session/end-seed', seq: 1, data: { inherited: true } },
    { type: 'turn/end', seq: 2, data: { reason: { kind: 'forked' } } },
  ])
  await child.dispose()
  const reader = await ctx.sessionPersistence.open(child.agent.id, 'read')
  try { expect((await reader.read()).events).toEqual(seed) } finally { await reader.close() }
})

it('continues a JSONL child from its creation history while the parent keeps writing', async () => {
  const { ctx } = await fixture('jsonl')
  const parent = ctx.sessions.create(SessionId('parent'))
  const writer = await ctx.sessionPersistence.create(parent.header)
  onTestFinished(() => writer.close())
  parent.append('turn/start', { turn: 1 })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const seed = buildForkSeed(parent.snapshotEvents(), SessionSeq(1))
  const child = await ctx.agents.create({
    sessionId: SessionId('child'), inheritedEventCount: SessionLogOffset(2), meta: { isSeeded: true },
    seed, parentSource: { sessionId: parent.id, endSeq: SessionLogOffset(2) },
  })
  parent.append('turn/start', { turn: 2 })
  parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  child.agent.session.append('turn/start', { turn: 2 })
  child.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await ctx.sessions.flush(parent)
  await ctx.sessions.flush(child.agent.session)
  await child.dispose()
  const reader = await ctx.sessionPersistence.open(child.agent.id, 'read')
  try {
    const events = (await reader.read()).events
    expect(events).toEqual(child.agent.session.snapshotEvents())
    expect(events.slice(0, seed.length)).toEqual(seed)
    expect(events.slice(seed.length)).toMatchObject([
      { type: 'turn/start', seq: 3 }, { type: 'turn/end', seq: 4 },
    ])
    expect(events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
  } finally { await reader.close() }
})

it.each([0, 1, 2, 4])('flushes the selected prefix with initial durable count %s before later parent writes', async (persistedCount) => {
  const { ctx, root } = await fixture()
  const parent = ctx.sessions.create(SessionId('parent'))
  const writer = await ctx.sessionPersistence.create(parent.header)
  onTestFinished(() => writer.close())
  parent.append('turn/start', { turn: 1 })
  if (persistedCount === 1) await writer.flush()
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  if (persistedCount === 2) await writer.flush()
  const prefix = parent.snapshotEvents()
  parent.append('turn/start', { turn: 2 })
  parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  if (persistedCount === 4) await writer.flush()
  const seed = buildForkSeed(prefix, SessionSeq(1))
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  const creating = vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
    expect(options?.parentSource).toMatchObject({ sessionId: parent.id, endSeq: prefix.length, events: seed })
    expect((await ctx.sessionPersistence.stat(parent.id))?.eventCount ?? 0).toBe(persistedCount)
    const childWriter = await create(header, options)
    // The sharing backend drained the parent writer before referencing its prefix.
    expect((await ctx.sessionPersistence.stat(parent.id))?.eventCount).toBe(4)
    expect((await childWriter.read()).events).toEqual(seed)
    parent.append('turn/start', { turn: 3 })
    parent.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await ctx.sessions.flush(parent)
    return childWriter
  })
  onTestFinished(() => { creating.mockRestore() })
  const child = await ctx.agents.create({ sessionId: SessionId('child'), inheritedEventCount: SessionLogOffset(2),
    meta: { isSeeded: true }, seed, parentSource: { sessionId: parent.id, endSeq: SessionLogOffset(2) } })
  expect(child.agent.session.inheritedEventCount).toBe(2)
  expect(child.agent.session.snapshotEvents().slice(0, 2)).toEqual(prefix)
  await child.dispose()
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  try {
    const tail = db.prepare('SELECT parent_end_seq, base_seq FROM segments WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?)').get(child.agent.id)
    expect(tail).toMatchObject({ parent_end_seq: prefix.length, base_seq: prefix.length })
    expect(storedEvents(db, tailSegment(db, child.agent.id))).toMatchObject([
      { type: 'session/end-seed', seq: 2, data: { inherited: true } },
    ])
    expect((await ctx.sessionPersistence.stat(parent.id))?.eventCount).toBe(6)
  } finally { db.close() }
  const reader = await ctx.sessionPersistence.open(child.agent.id, 'read')
  try { expect((await reader.read()).events).toEqual(child.agent.session.snapshotEvents()) } finally { await reader.close() }
})
