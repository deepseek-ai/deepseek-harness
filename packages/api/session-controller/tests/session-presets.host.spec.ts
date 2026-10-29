/** Session creation, blank-Session reuse, and Agent preset identity through `session.create`. */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionTestRemote, testSessionPersistence } from './test-remote.ts'

/** Booted contexts and their temp roots, torn down after each test. */
const contexts: Context[] = []
const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

/** A stored Session the persistence double serves until an Agent resumes it. */
interface StoredSession {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

interface HarnessOptions {
  /** Declared presets; the first is the default. Omitted, no roster is composed. */
  readonly presets?: readonly string[]
  /** Stored Sessions keyed by id. */
  readonly stored?: ReadonlyMap<SessionId, StoredSession>
  /** Stored Sessions whose writer another owner holds. */
  readonly held?: ReadonlySet<SessionId>
  /** Stored Sessions another resume in this process publishes while this one waits for the writer. */
  readonly publishedByOtherResume?: ReadonlySet<SessionId>
  /** Stored Sessions whose storage fails to open for writing. */
  readonly unreadable?: ReadonlySet<SessionId>
  /** Events a resume finds beyond the stored log, as when another Host wrote after the observation. */
  readonly writtenSinceObservation?: ReadonlyMap<SessionId, readonly SessionEvent[]>
  /** Live Sessions whose preset switch the roster refuses as already started. */
  readonly locked?: ReadonlySet<SessionId>
  /** Declared presets whose activation failed. */
  readonly broken?: ReadonlySet<string>
  /** Requested presets whose resolution waits for the paired promise. */
  readonly resolving?: ReadonlyMap<string, Promise<void>>
  /** Workspace placement served to `workspaceId` requests. */
  readonly workspace?: { readonly members: readonly SessionId[]; readonly archived: readonly SessionId[] }
}

const WORKSPACE = 'workspace-1' as WorkspaceId

async function harness(options: HarnessOptions = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-')))
  tempDirs.push(cwd)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const preset = await ctx.sessionProjections.register(agentPresetProjectionDefinition)
  const presets = options.presets
  const selections: { sessionId: SessionId; agentPreset: string }[] = []
  const resumed: SessionId[] = []
  if (presets !== undefined) {
    const known = (id?: string): string => {
      const wanted = id ?? presets[0] ?? ''
      if (!presets.includes(wanted)) {
        throw new RemoteError('agent-preset/not-found', `Unknown agent preset: ${wanted}`, {
          agentPreset: wanted, available: [...presets],
        })
      }
      return wanted
    }
    const usable = (id?: string): string => {
      const wanted = known(id)
      if (options.broken?.has(wanted) === true) {
        throw new RemoteError('agent-preset/invalid', 'activation failed', { agentPreset: wanted, reason: 'activation failed' })
      }
      return wanted
    }
    ctx.provide('agentPresets', {
      defaultId: presets[0],
      presetForSession: (session: Session) => preset.stateOf(session),
      resolve: (id?: string) => Promise.resolve(id === undefined ? undefined : options.resolving?.get(id))
        .then(() => ({ id: known(id) })),
      mount: (_ctx: Context, id?: string) => Promise.resolve().then(() => ({ id: usable(id) })),
      select: async (agent: Agent, agentPreset: string) => {
        usable(agentPreset)
        if (options.locked?.has(agent.id) === true) {
          throw new RemoteError('agent-preset/locked', 'This session has already started', {
            sessionId: agent.id, agentPreset,
          })
        }
        selections.push({ sessionId: agent.id, agentPreset })
        agent.session.append('agent-preset/selected', { agentPreset })
        return agentPreset
      },
    } as never)
  }
  const stored = options.stored ?? new Map<SessionId, StoredSession>()
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([...stored.values()].map(record => record.header)),
    inspect: (id: SessionId) => {
      const record = stored.get(id)
      return Promise.resolve(record === undefined ? undefined : { meta: record.header, events: [...record.events] })
    },
  }) as never)
  const { members, archived } = options.workspace ?? { members: [], archived: [] }
  const workspace = { id: WORKSPACE, path: cwd, sessionIds: members, attachSession: () => Promise.resolve() }
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === WORKSPACE ? workspace : undefined,
    list: () => [workspace],
    archivedSessionIds: archived,
  } as never)

  /** Enter the Session for setup, then announce creation as the Agent factory does. */
  const publish = async (
    session: Session,
    setup: Parameters<AgentFactory['createAgent']>[1]['setup'],
  ): Promise<{ agent: Agent; dispose: () => Promise<void> }> => {
    const agent = stubAgent(session)
    ;(agent as { ctx?: Context }).ctx = ctx
    const detach = ctx.effect(() => ctx.sessions.enter(session))
    try {
      ctx.sessions.announce(session)
      const commit = await setup?.(ctx, agent)
      commit?.commit()
      const unregister = await ctx.agents.register(agent)
      return { agent, dispose: async () => { await unregister(); await detach() } }
    } catch (error) {
      await detach()
      throw error
    }
  }
  const factory: AgentFactory = {
    async createAgent(_ownerCtx, create) {
      const session = ctx.sessions.prepare(create.sessionId, create.meta === undefined ? {} : { meta: create.meta })
      return publish(session, create.setup)
    },
    async resume(_ownerCtx, resume) {
      const id = resume.resumeSessionId
      if (options.held?.has(id) === true) {
        throw Object.assign(new Error(`session "${id}" is written by another owner`), { name: 'SessionAlreadyOwnedError' })
      }
      const record = stored.get(id)
      if (record === undefined || options.unreadable?.has(id) === true) {
        throw new Error(`test persistence cannot open Session "${id}" for writing`)
      }
      if (options.publishedByOtherResume?.has(id) === true) {
        await publish(ctx.sessions.prepare(id, { meta: record.header, seed: [...record.events] }), undefined)
        throw Object.assign(new Error(`session "${id}" is written by this process`), { name: 'SessionAlreadyOwnedError' })
      }
      resumed.push(id)
      const session = ctx.sessions.prepare(id, {
        meta: record.header,
        seed: [...record.events, ...options.writtenSinceObservation?.get(id) ?? []],
      })
      return publish(session, resume.setup)
    },
  }
  ctx.agents.setFactory(factory)
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
  })
  const presetOf = (id: SessionId): string | null | undefined => {
    const session = ctx.sessions.get(id)
    return session === undefined ? undefined : preset.stateOf(session)
  }
  const selectedEvents = (id: SessionId): unknown[] => {
    const session = ctx.sessions.get(id)
    return session === undefined ? [] : session.snapshotEvents()
      .filter(event => event.type === 'agent-preset/selected')
      .map(event => event.data)
  }
  return { ctx, remote, cwd, selections, resumed, presetOf, selectedEvents }
}

function storedHeader(id: SessionId, cwd: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd, ...extra }
}

function modelSelection(seq: number): SessionEvent {
  return { type: 'model/selection', seq: SessionSeq(seq), time: 1, data: { provider: 'test', model: 'test-model' } }
}

function presetSelection(seq: number, agentPreset: string): SessionEvent {
  return { type: 'agent-preset/selected', seq: SessionSeq(seq), time: 1, data: { agentPreset } }
}

function completedTurn(seq: number): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(seq), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(seq + 1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('session.create Agent preset identity', () => {
  it('records the requested preset on the Session header', async () => {
    const { ctx, remote } = await harness({ presets: ['standard', 'minimal'] })

    const created = await remote.create({ sessionId: SessionId('s1'), agentPreset: 'minimal' })

    expect(created.ok).toBe(true)
    expect(ctx.sessions.get(SessionId('s1'))?.header.agentPreset).toBe('minimal')
  })

  it('records the roster default when the caller names no preset', async () => {
    const { ctx, remote } = await harness({ presets: ['standard', 'minimal'] })

    await remote.create({ sessionId: SessionId('s2') })

    expect(ctx.sessions.get(SessionId('s2'))?.header.agentPreset).toBe('standard')
  })

  it('rejects an unknown preset', async () => {
    const { remote } = await harness({ presets: ['standard'] })

    const response = await remote.create({ sessionId: SessionId('s3'), agentPreset: 'nope' })

    expect(response).toMatchObject({ ok: false, error: { code: 'agent-preset/not-found' } })
  })

  it('leaves the header preset-less when no roster is composed', async () => {
    const { ctx, remote } = await harness()

    await remote.create({ sessionId: SessionId('s6') })

    expect(ctx.sessions.get(SessionId('s6'))?.header.agentPreset).toBeUndefined()
  })
})

describe('session.create reuse of a live blank Session', () => {
  it('recomposes a blank Session under the default when the caller names no preset', async () => {
    const { remote, selections, presetOf } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' })

    const reused = await remote.create({ sessionId: SessionId('draft') })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'standard' } })
    expect(selections).toEqual([{ sessionId: 'draft', agentPreset: 'standard' }])
    expect(presetOf(SessionId('draft'))).toBe('standard')
  })

  it('recomposes a blank Session under the named preset', async () => {
    const { remote, selections } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('draft') })

    const reused = await remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'minimal' } })
    expect(selections).toEqual([{ sessionId: 'draft', agentPreset: 'minimal' }])
  })

  it('keeps a blank Session that already runs the requested preset', async () => {
    const { ctx, remote, selections } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('draft') })
    ctx.sessions.get(SessionId('draft'))?.append('agent-preset/selected', { agentPreset: 'minimal' })

    const reused = await remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'minimal' } })
    expect(selections).toEqual([])
  })

  it('validates the requested preset before touching the blank Session', async () => {
    const { remote, selections, presetOf } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' })

    const response = await remote.create({ sessionId: SessionId('draft'), agentPreset: 'deleted' })

    expect(response).toMatchObject({ ok: false, error: { code: 'agent-preset/not-found' } })
    expect(selections).toEqual([])
    expect(presetOf(SessionId('draft'))).toBe('minimal')
  })

  it('keeps the blank Session unchanged when the requested preset fails to activate', async () => {
    const { remote, selections, presetOf } = await harness({
      presets: ['standard', 'broken'],
      broken: new Set(['broken']),
    })
    await remote.create({ sessionId: SessionId('draft') })

    const response = await remote.create({ sessionId: SessionId('draft'), agentPreset: 'broken' })

    expect(response).toMatchObject({ ok: false, error: { code: 'agent-preset/invalid' } })
    expect(selections).toEqual([])
    expect(presetOf(SessionId('draft'))).toBe('standard')
  })

  it('creates a new Session instead of reusing one that has started', async () => {
    const { ctx, remote, selections, presetOf } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('talk'), agentPreset: 'minimal' })
    const talk = ctx.sessions.get(SessionId('talk'))
    talk?.append('turn/start', { turn: 1 })
    talk?.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const created = await remote.create({ sessionId: SessionId('talk') })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('talk')
    expect(created.value.agentPreset).toBe('standard')
    expect(selections).toEqual([])
    expect(presetOf(SessionId('talk'))).toBe('minimal')
  })

  it('creates a new Session when a turn starts before the preset switch', async () => {
    const { remote } = await harness({
      presets: ['standard', 'minimal'],
      locked: new Set([SessionId('racing')]),
    })
    await remote.create({ sessionId: SessionId('racing'), agentPreset: 'minimal' })

    const created = await remote.create({ sessionId: SessionId('racing') })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('racing')
  })

  it('serializes concurrent reuse of one Session in request order', async () => {
    const { remote, selections, presetOf } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('draft') })

    const [first, second] = await Promise.all([
      remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' }),
      remote.create({ sessionId: SessionId('draft') }),
    ])

    expect(first).toMatchObject({ ok: true, value: { sessionId: 'draft' } })
    expect(second).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'standard' } })
    expect(selections).toEqual([
      { sessionId: 'draft', agentPreset: 'minimal' },
      { sessionId: 'draft', agentPreset: 'standard' },
    ])
    expect(presetOf(SessionId('draft'))).toBe('standard')
  })

  it('claims one Session in arrival order when an earlier preset resolves later', async () => {
    const minimal = Promise.withResolvers<undefined>()
    const { remote, selections, presetOf } = await harness({
      presets: ['standard', 'minimal'], resolving: new Map([['minimal', minimal.promise]]),
    })
    await remote.create({ sessionId: SessionId('draft') })

    const first = remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' })
    const second = remote.create({ sessionId: SessionId('draft') })
    await new Promise(resolve => setTimeout(resolve, 0))
    minimal.resolve(undefined)

    expect(await first).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'minimal' } })
    expect(await second).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'standard' } })
    expect(selections).toEqual([
      { sessionId: 'draft', agentPreset: 'minimal' },
      { sessionId: 'draft', agentPreset: 'standard' },
    ])
    expect(presetOf(SessionId('draft'))).toBe('standard')
  })

  it('shares one creation between concurrent callers of a new identity', async () => {
    const { ctx, remote } = await harness({ presets: ['standard'] })

    const results = await Promise.all([
      remote.create({ sessionId: SessionId('fresh') }),
      remote.create({ sessionId: SessionId('fresh') }),
    ])

    expect(results).toMatchObject([
      { ok: true, value: { sessionId: 'fresh' } },
      { ok: true, value: { sessionId: 'fresh' } },
    ])
    expect(ctx.agents.list().map(agent => agent.id)).toEqual(['fresh'])
  })

  it('refuses a Session in another directory', async () => {
    const { ctx, remote } = await harness({ presets: ['standard'] })
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-elsewhere-')))
    tempDirs.push(elsewhere)
    await remote.create({ sessionId: SessionId('other'), cwd: elsewhere })

    const response = await remote.create({ sessionId: SessionId('other') })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'session/conflict', details: { sessionId: 'other', existingCwd: elsewhere } },
    })
    expect(ctx.agents.list().map(agent => agent.id)).toEqual(['other'])
  })

  it('refuses a Session in another directory before resolving the requested preset', async () => {
    const { remote } = await harness({ presets: ['standard'] })
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-elsewhere-')))
    tempDirs.push(elsewhere)
    await remote.create({ sessionId: SessionId('other'), cwd: elsewhere })

    const response = await remote.create({ sessionId: SessionId('other'), agentPreset: 'nope' })

    expect(response).toMatchObject({ ok: false, error: { code: 'session/conflict', details: { sessionId: 'other' } } })
  })

  it('leaves a subagent identity to subagent routing', async () => {
    const { ctx, remote, cwd } = await harness({ presets: ['standard'] })
    ctx.sessions.create(SessionId('child'), {
      meta: { cwd, parentSession: SessionId('parent'), origin: 'subagent' },
    })

    const response = await remote.create({ sessionId: SessionId('child') })

    expect(response).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
  })

  it('reuses a preset-less blank Session unchanged when no roster is composed', async () => {
    const { ctx, remote } = await harness()
    await remote.create({ sessionId: SessionId('s5') })

    const reused = await remote.create({ sessionId: SessionId('s5') })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 's5' } })
    expect(ctx.sessions.get(SessionId('s5'))?.header.agentPreset).toBeUndefined()
  })

  it('explains why a preset-less Session cannot be adopted under one', async () => {
    const { remote } = await harness()
    await remote.create({ sessionId: SessionId('s7') })

    const response = await remote.create({ sessionId: SessionId('s7'), agentPreset: 'standard' })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'agent-preset/conflict',
        details: {
          sessionId: 's7',
          requestedPreset: 'standard',
        },
      },
    })
    if (response.ok) throw new Error('unreachable')
    expect('existingPreset' in response.error.details).toBe(false)
    expect(response.error.message).toBe('the deployment composes no agent preset roster, so session "s7" cannot run preset "standard"')
  })
})

describe('session.create reuse of a stored blank Session', () => {
  it('resumes a blank Session whose recorded preset is no longer declared under the default', async () => {
    const draft = SessionId('stale-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, resumed, presetOf, selectedEvents } = await harness({
      presets: ['standard', 'minimal'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'liangshen' }), events: [modelSelection(0)] }]]),
    })

    const reused = await remote.create({ sessionId: draft, cwd })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'stale-draft', agentPreset: 'standard' } })
    expect(resumed).toEqual(['stale-draft'])
    expect(presetOf(draft)).toBe('standard')
    expect(selectedEvents(draft)).toEqual([{ agentPreset: 'standard' }])
  })

  it('resumes a blank Session under the default even when its previous choice is still declared', async () => {
    const draft = SessionId('picked-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, presetOf, selectedEvents } = await harness({
      presets: ['standard', 'minimal'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'standard' }), events: [presetSelection(0, 'minimal')] }]]),
    })

    const reused = await remote.create({ sessionId: draft, cwd })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'picked-draft', agentPreset: 'standard' } })
    expect(presetOf(draft)).toBe('standard')
    expect(selectedEvents(draft)).toEqual([{ agentPreset: 'minimal' }, { agentPreset: 'standard' }])
  })

  it('resumes a blank Session under its recorded preset when the caller names it', async () => {
    const draft = SessionId('restored-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, presetOf, selectedEvents } = await harness({
      presets: ['standard', 'minimal'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'standard' }), events: [presetSelection(0, 'minimal')] }]]),
    })

    const reused = await remote.create({ sessionId: draft, cwd, agentPreset: 'minimal' })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'restored-draft', agentPreset: 'minimal' } })
    expect(presetOf(draft)).toBe('minimal')
    expect(selectedEvents(draft)).toEqual([{ agentPreset: 'minimal' }])
  })

  it('rejects a named preset that is no longer declared without resuming the Session', async () => {
    const draft = SessionId('stale-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { ctx, remote, resumed } = await harness({
      presets: ['standard'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'liangshen' }), events: [modelSelection(0)] }]]),
    })

    const response = await remote.create({ sessionId: draft, cwd, agentPreset: 'liangshen' })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent-preset/not-found', details: { agentPreset: 'liangshen', available: ['standard'] } },
    })
    expect(resumed).toEqual([])
    expect(ctx.agents.list()).toEqual([])
  })

  it('creates a new Session instead of resuming one that has started', async () => {
    const talk = SessionId('stored-talk')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, resumed } = await harness({
      presets: ['standard'],
      stored: new Map([[talk, { header: storedHeader(talk, cwd, { agentPreset: 'liangshen' }), events: completedTurn(0) }]]),
    })

    const created = await remote.create({ sessionId: talk, cwd })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('stored-talk')
    expect(created.value.agentPreset).toBe('standard')
    expect(resumed).toEqual([])
  })

  it('creates a new Session when another owner holds the blank Session', async () => {
    const draft = SessionId('held-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { ctx, remote } = await harness({
      presets: ['standard'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'standard' }), events: [modelSelection(0)] }]]),
      held: new Set([draft]),
    })

    const created = await remote.create({ sessionId: draft, cwd })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('held-draft')
    expect(ctx.sessions.get(draft)).toBeUndefined()
  })

  it('reuses the Agent another resume published while holding the writer', async () => {
    const draft = SessionId('contended-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, selections, presetOf } = await harness({
      presets: ['standard', 'minimal'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'minimal' }), events: [modelSelection(0)] }]]),
      publishedByOtherResume: new Set([draft]),
    })

    const reused = await remote.create({ sessionId: draft, cwd })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'contended-draft', agentPreset: 'standard' } })
    expect(selections).toEqual([{ sessionId: 'contended-draft', agentPreset: 'standard' }])
    expect(presetOf(draft)).toBe('standard')
  })

  it('reports an unreadable Session instead of creating another one', async () => {
    const { ctx, remote } = await harness({ presets: ['standard'] })
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('storage offline'))

    const response = await remote.create({ sessionId: SessionId('unreadable') })

    expect(response).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    expect(ctx.agents.list()).toEqual([])
  })

  it('reports a storage failure instead of creating another Session', async () => {
    const draft = SessionId('unreadable-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { ctx, remote } = await harness({
      presets: ['standard'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'standard' }), events: [modelSelection(0)] }]]),
      unreadable: new Set([draft]),
    })

    const response = await remote.create({ sessionId: draft, cwd })

    expect(response).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    expect(ctx.agents.list()).toEqual([])
  })

  it('creates a new Session when the blank Session started after it was observed', async () => {
    const draft = SessionId('overtaken-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { ctx, remote, resumed } = await harness({
      presets: ['standard', 'minimal'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'minimal' }), events: [modelSelection(0)] }]]),
      writtenSinceObservation: new Map([[draft, completedTurn(1)]]),
    })

    const created = await remote.create({ sessionId: draft, cwd })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('overtaken-draft')
    expect(resumed).toEqual(['overtaken-draft'])
    expect(ctx.sessions.get(draft)).toBeUndefined()
  })

  it('refuses a stored Session in another directory', async () => {
    const other = SessionId('stored-other')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, resumed } = await harness({
      presets: ['standard'],
      stored: new Map([[other, { header: storedHeader(other, '/elsewhere'), events: [modelSelection(0)] }]]),
    })

    const response = await remote.create({ sessionId: other, cwd })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'session/conflict', details: { sessionId: 'stored-other', existingCwd: '/elsewhere' } },
    })
    expect(resumed).toEqual([])
  })

  it('leaves a stored subagent identity to subagent routing', async () => {
    const child = SessionId('stored-child')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, resumed } = await harness({
      presets: ['standard'],
      stored: new Map([[child, {
        header: storedHeader(child, cwd, { parentSession: SessionId('parent'), origin: 'subagent' }),
        events: [modelSelection(0)],
      }]]),
    })

    const response = await remote.create({ sessionId: child, cwd })

    expect(response).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    expect(resumed).toEqual([])
  })
})

describe('session.create Workspace placement', () => {
  it('reuses a blank member of the requested Workspace', async () => {
    const draft = SessionId('member-draft')
    const { remote } = await harness({ presets: ['standard'], workspace: { members: [draft], archived: [] } })
    await remote.create({ sessionId: draft })

    const reused = await remote.create({ sessionId: draft, workspaceId: WORKSPACE })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'member-draft' } })
  })

  it.each([
    { name: 'outside the Workspace', members: [], archived: [] },
    { name: 'archived', members: [SessionId('placed-draft')], archived: [SessionId('placed-draft')] },
  ])('creates a new Session instead of reusing a blank Session $name', async ({ members, archived }) => {
    const draft = SessionId('placed-draft')
    const { remote, selections, presetOf } = await harness({ presets: ['standard', 'minimal'], workspace: { members, archived } })
    await remote.create({ sessionId: draft, agentPreset: 'minimal' })

    const created = await remote.create({ sessionId: draft, workspaceId: WORKSPACE })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('placed-draft')
    expect(selections).toEqual([])
    expect(presetOf(draft)).toBe('minimal')
  })
})
