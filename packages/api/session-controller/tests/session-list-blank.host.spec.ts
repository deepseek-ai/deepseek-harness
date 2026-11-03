/**
 * The summary blank bit means "conversation not started" (no turn has run),
 * not "log empty": standalone plugin events — command lifecycle records,
 * plan/mode, permission knob events, session titles — never flip it, so running /plan or /goal on a
 * fresh session keeps it list-hidden and reusable, while the first accepted
 * prompt's turn/start clears it. The host/session-added frame shares the
 * same predicate function (covered by the workspace spec's frame assertion).
 * A resumed Session computes its own list metadata (blankness and last-prompt
 * recency) when it is published, independent of which other projections were
 * read before publication.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Side-effect type imports: the configuration-event SessionEventMap merges.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionSummary } from '../src/types.ts'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

const ownedContexts = new Set<Context>()
const ownedRoots = new Set<string>()
afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
  await Promise.all([...ownedRoots].map(root => rm(root, { recursive: true, force: true })))
  ownedRoots.clear()
})

async function harness(): Promise<{ ctx: Context; remote: TestSessionRemote; attach: (session: Session) => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  return {
    ctx,
    remote: await createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
    attach: async (session) => {
      await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    },
  }
}

/** Append the standalone (non-conversation) event family a fresh session can accumulate. */
function appendStandalone(session: Session): void {
  session.append('command/run', {
    commandId: CommandId('blank-cmd-1'), name: 'plan', args: '', source: { kind: 'user' },
  })
  session.append('plan/mode', { active: true })
  session.append('command/done', { commandId: CommandId('blank-cmd-1'), kind: 'success', text: 'Plan mode on.' })
  session.append('session/title', {
    title: 'standalone title', messageSeqs: [], source: { kind: 'fallback' },
  })
  // Permission configuration events from a /permission switch on a fresh session.
  session.append('permission/preset', { preset: 'danger-full-access' })
  session.append('sandbox/mode', { mode: 'danger-full-access' })
}

async function listBlank(remote: TestSessionRemote, id: string): Promise<boolean | undefined> {
  const result = await remote.list({})
  if (!result.ok) throw new Error('list failed')
  return result.value.items.find(item => item.sessionId === id)?.blank
}

describe('summary blank = conversation not started', () => {
  it('standalone events (command lifecycle, plan/mode, title) keep the session blank', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    expect(await listBlank(remote, session.id)).toBe(true)
    appendStandalone(session)
    expect(await listBlank(remote, session.id)).toBe(true)
  })

  it('the first turn clears blank', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    appendStandalone(session)
    session.append('turn/start', { turn: 0 })
    expect(await listBlank(remote, session.id)).toBe(false)
  })
})

/**
 * Mount the real AgentLoop over JSONL persistence without the projection
 * cache, whose creation checkpoint would otherwise compute every unit before
 * the Session Controller observes the published Session.
 */
async function resumeHarness(): Promise<{ ctx: Context; remote: TestSessionRemote; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-list-blank-'))
  ownedRoots.add(root)
  const ctx = new Context()
  ownedContexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  const remote = await createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: root })
  await mountAgentLoopTestHarness(ctx)
  return { ctx, remote, cwd: root }
}

/** Store one Session through persistence so a later resume seeds it from disk. */
async function storeSession(ctx: Context, id: SessionId, cwd: string, events: readonly SessionEvent[]): Promise<void> {
  const prepared = ctx.sessions.prepare(id, { meta: { cwd } })
  const handle = await ctx.sessionPersistence.create(prepared.header)
  await handle.append(events)
  await handle.close()
}

/** Configuration events a Session records at creation, before any prompt. */
const configurationEvents = [
  { type: 'permission/preset', seq: SessionSeq(0), time: 1, data: { preset: 'danger-full-access' } },
  { type: 'sandbox/mode', seq: SessionSeq(1), time: 2, data: { mode: 'danger-full-access' } },
  { type: 'approval/policy', seq: SessionSeq(2), time: 3, data: { policy: 'never' } },
] as SessionEvent[]

/** Resume one stored Session and collect the summaries published for it. */
async function resumeAndObserve(ctx: Context, remote: TestSessionRemote, id: SessionId): Promise<{
  added: SessionSummary[]
  listed: SessionSummary | undefined
}> {
  const added: SessionSummary[] = []
  ctx.on('api-session/added', (summary) => {
    if (summary.sessionId === id) added.push(summary)
  })
  await ctx.agents.resume({ resumeSessionId: id })
  const listed = await remote.list({})
  if (!listed.ok) throw new Error('list failed')
  return { added, listed: listed.value.items.find(item => item.sessionId === id) }
}

describe('resumed Session summaries', () => {
  it('publish a turnless resumed Session as blank', async () => {
    const { ctx, remote, cwd } = await resumeHarness()
    const id = 'session-resumed-blank' as SessionId
    await storeSession(ctx, id, cwd, configurationEvents)

    const { added, listed } = await resumeAndObserve(ctx, remote, id)

    expect(added.length).toBeGreaterThan(0)
    expect(added.map(summary => summary.blank)).toEqual(added.map(() => true))
    expect(listed?.blank).toBe(true)
  })

  it('publish a resumed conversation as non-blank', async () => {
    const { ctx, remote, cwd } = await resumeHarness()
    const id = 'session-resumed-conversation' as SessionId
    await storeSession(ctx, id, cwd, [
      ...configurationEvents,
      { type: 'turn/start', seq: SessionSeq(3), time: 4, data: { turn: 1 } },
      {
        type: 'user/message', seq: SessionSeq(4), time: 4,
        data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      { type: 'turn/end', seq: SessionSeq(5), time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])

    const { added, listed } = await resumeAndObserve(ctx, remote, id)

    expect(added.length).toBeGreaterThan(0)
    expect(added.map(summary => summary.blank)).toEqual(added.map(() => false))
    expect(listed?.blank).toBe(false)
  })

  it('publish a resumed conversation with its last prompt time from the first frame', async () => {
    const { ctx, remote, cwd } = await resumeHarness()
    const id = 'session-resumed-recency' as SessionId
    const promptAt = Date.now() + 60_000
    await storeSession(ctx, id, cwd, [
      ...configurationEvents,
      { type: 'turn/start', seq: SessionSeq(3), time: promptAt, data: { turn: 1 } },
      {
        type: 'user/message', seq: SessionSeq(4), time: promptAt,
        data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      { type: 'turn/end', seq: SessionSeq(5), time: promptAt + 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])

    const { added, listed } = await resumeAndObserve(ctx, remote, id)

    expect(added.length).toBeGreaterThan(0)
    expect(added.map(summary => [summary.updatedAt, summary.blank])).toEqual(added.map(() => [promptAt, false]))
    expect(Object.keys(added[0]?.projections?.values ?? {})).toContain('sessionListMetadata')
    expect(Object.keys(added[0]?.projections?.values ?? {})).toEqual(expect.arrayContaining([...ctx.sessionProjections.summaryKeys()]))
    expect(listed?.updatedAt).toBe(promptAt)
    expect(listed?.blank).toBe(false)
  })
})
