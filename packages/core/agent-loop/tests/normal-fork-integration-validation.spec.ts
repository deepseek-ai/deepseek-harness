/** Fork creation stores the supplied seed without reading the parent through persistence. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'

async function fixture(cold: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fork-load-cancel-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(persistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const parent = cold ? Session.create(SessionId('parent')) : ctx.sessions.create(SessionId('parent'))
  const writer = await ctx.sessionPersistence.create(parent.header)
  parent.append('turn/start', { turn: 1 })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  if (cold) {
    await writer.append(parent.snapshotEvents())
    await writer.close()
  } else {
    await writer.flush()
  }
  const seed = buildForkSeed(parent.snapshotEvents(), SessionSeq(1))
  const options = {
    sessionId: SessionId('child'), inheritedEventCount: SessionLogOffset(2), meta: { isSeeded: true },
    seed, parentSource: { sessionId: parent.id, endSeq: SessionLogOffset(2) },
  }
  let caller = ctx
  await ctx.plugin(Object.assign((inner: Context) => { caller = inner }, { inject: ['agents'] }))
  return { ctx, parent, caller, options, seed }
}

it('stores a cold fork from the supplied history and persists the child before publishing it', async () => {
  const { ctx, parent, caller, options, seed } = await fixture(true)
  const open = vi.spyOn(ctx.sessionPersistence, 'open')
  onTestFinished(() => { open.mockRestore() })
  const child = await caller.agents.create(options)
  try {
    expect(open).not.toHaveBeenCalledWith(parent.id, expect.anything(), expect.anything())
    expect(child.agent.session.snapshotEvents()).toEqual(seed)
    const reader = await ctx.sessionPersistence.open(options.sessionId, 'read')
    try { expect((await reader.read()).events).toEqual(child.agent.session.snapshotEvents()) }
    finally { await reader.close() }
    expect(child.agent.session.inheritedEventCount).toBe(2)
  } finally { await child.dispose() }
})

it('creates from an empty cold prefix without fork metadata', async () => {
  const { ctx, parent, caller, options } = await fixture(true)
  const child = await caller.agents.create({
    sessionId: options.sessionId,
    seed: [], parentSource: { sessionId: parent.id, endSeq: SessionLogOffset(0) },
  })
  try {
    expect(child.agent.session.inheritedEventCount).toBe(0)
    expect(child.agent.session.header.isSeeded).toBe(false)
    const reader = await ctx.sessionPersistence.open(options.sessionId, 'read')
    try { expect((await reader.read()).events).toEqual(child.agent.session.snapshotEvents()) }
    finally { await reader.close() }
  } finally { await child.dispose() }
})

it('creates a fork from the supplied history when no persistence backend is mounted', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const parent = Session.create(SessionId('parent'))
  const detach = ctx.sessions.enter(parent)
  ctx.sessions.announce(parent)
  parent.append('turn/start', { turn: 1 })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const seed = buildForkSeed(parent.snapshotEvents(), SessionSeq(1))
  detach()
  const childId = SessionId('child')
  const child = await ctx.agents.create({
    sessionId: childId, inheritedEventCount: SessionLogOffset(2), meta: { isSeeded: true },
    seed, parentSource: { sessionId: parent.id, endSeq: SessionLogOffset(2) },
  })
  try {
    expect(child.agent.session.snapshotEvents()).toEqual(seed)
    expect(ctx.agents.get(childId)?.id).toBe(childId)
  } finally { await child.dispose() }
})
