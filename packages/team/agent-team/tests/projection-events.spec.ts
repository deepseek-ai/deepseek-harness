import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { teamProjectionDefinition, teamProjectionView } from '../src/projection.ts'
import type { TeamProjectionState, TeamState } from '../src/projection.ts'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/types.ts'
import type { TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot } from '../src/types.ts'

const ROOT = SessionId('team-root')
const TEAM = TeamId(ROOT)
const CHILD = SessionId('child-a')

function event<T extends Extract<SessionEventType, `team/${string}`>>(type: T, data: SessionEventMap[T], seq: SessionSeq): SessionEvent<T> {
  return { type, data, seq, time: seq } as unknown as SessionEvent<T>
}

function project(rootId: SessionId, events: readonly SessionEvent[], inherited = 0): TeamProjectionState {
  let state = teamProjectionDefinition.init({
    version: SESSION_FORMAT_VERSION,
    id: rootId,
    createdAt: 0,
    isSeeded: inherited > 0,
  }, SessionLogOffset(inherited))
  for (const event of events) state = teamProjectionDefinition.apply(state, event)
  return state
}

function teamState(projected: TeamProjectionState): TeamState {
  if (projected.failure !== undefined) throw new Error(projected.failure)
  return projected
}

function projectTeam(rootId: SessionId, events: readonly SessionEvent[]): TeamState {
  return teamState(project(rootId, events))
}

function member(overrides: Partial<TeamMemberSnapshot> = {}): TeamMemberSnapshot {
  return {
    id: CHILD,
    name: 'worker-a',
    description: 'worker',
    provider: 'spawn',
    context: 'fresh',
    phase: 'provisioning',
    ...overrides,
  }
}

function task(overrides: Partial<TeamTaskSnapshot> = {}): TeamTaskSnapshot {
  return {
    id: TeamTaskId('task-1'),
    revision: 1,
    subject: 'subject',
    description: 'description',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ...overrides,
  }
}

/** One parent catalog fact for a continuable child. */
function catalog(childId: string, seq: number, description = `${childId} task`): SessionEvent<'subagent/catalog'> {
  return {
    type: 'subagent/catalog',
    seq: SessionSeq(seq),
    time: seq,
    data: { version: 0, childId: SessionId(childId), childCreatedAt: seq, mode: 'continuable', label: description },
  }
}

function message(overrides: Partial<TeamMessageSnapshot> = {}): TeamMessageSnapshot {
  return {
    id: TeamMessageId('message-1'),
    senderId: ROOT,
    senderName: 'lead',
    targetId: CHILD,
    content: [{ type: 'text', text: 'hello' }],
    ...overrides,
  }
}

describe('Agent Teams projection events', () => {
  it('keeps mode and tasks together through explicit selections and legacy task events', () => {
    const initial = project(ROOT, [])
    expect(teamProjectionView(initial)).toEqual({ enabled: false, tasks: [] })
    const legacy = teamProjectionDefinition.apply(initial, event('team/task', {
      version: 2, teamId: TEAM, task: task(),
    }, SessionSeq(0)))
    expect(teamProjectionView(legacy).enabled).toBe(true)
    const off = teamProjectionDefinition.apply(legacy, event('team/mode', { enabled: false }, SessionSeq(1)))
    expect(off.tasks).toBe(legacy.tasks)
    expect(teamProjectionView(off)).toMatchObject({ enabled: false, tasks: [{ id: 'task-1' }] })
    const completed = teamProjectionDefinition.apply(off, event('team/task', {
      version: 2, teamId: TEAM, task: task({ revision: 2, status: 'completed' }),
    }, SessionSeq(2)))
    expect(teamProjectionView(completed)).toMatchObject({ enabled: false, tasks: [{ status: 'completed' }] })
    const on = teamProjectionDefinition.apply(completed, event('team/mode', { enabled: true }, SessionSeq(3)))
    expect(on.tasks).toBe(completed.tasks)
    expect(teamProjectionView(on)).toMatchObject({ enabled: true, tasks: [{ status: 'completed' }] })
    expect(teamProjectionView(on)).toBe(teamProjectionView(on))
    const failed = teamProjectionDefinition.apply(on, JSON.parse('{"type":"team/mode","seq":4,"data":{"enabled":"yes"}}') as SessionEvent)
    expect(teamProjectionView(failed)).toMatchObject({ enabled: true, failure: 'persisted Agent Teams team/mode payload is invalid' })
    expect(failed.tasks).toBe(on.tasks)
    expect(() => teamProjectionDefinition.stateSchema.parse({ ...on, enabled: 'yes' })).toThrow()
  })

  it('starts a fork with Team disabled and applies only its own mode selection', () => {
    const inherited = event('team/mode', { enabled: true }, SessionSeq(0))
    const fork = project(SessionId('fork'), [inherited], 1)
    expect(teamProjectionView(fork)).toEqual({ enabled: false, tasks: [] })
    const restored = teamProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(fork)))
    const enabled = teamProjectionDefinition.apply(restored, event('team/mode', { enabled: true }, SessionSeq(1)))
    expect(teamProjectionView(enabled).enabled).toBe(true)
  })

  it('rebuilds version-4 checkpoints with the saved mode and historical tasks', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.sessionProjections.register(teamProjectionDefinition)
    const savedTask = event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0))
    const oldState = { ...project(ROOT, []), tasks: [task()], nextTaskNumber: 2 }
    for (const records of [[savedTask], [savedTask, event('team/mode', { enabled: false }, SessionSeq(1))]]) {
      const restored = ctx.sessionProjections.restore(
        { agentTeam: { ver: 4, seq: records.at(-1)!.seq, val: oldState } },
        records,
        SessionLogOffset(0),
        { version: SESSION_FORMAT_VERSION, id: ROOT, createdAt: 0, isSeeded: false },
        SessionLogOffset(0),
      )
      const state = teamProjectionDefinition.stateSchema.parse(restored.checkpoint['agentTeam']!.val)
      expect(teamProjectionView(state)).toMatchObject({ enabled: records.length === 1, tasks: [{ id: 'task-1' }] })
    }
  })

  it('rebuilds a version-5 fork checkpoint without inheriting its mode', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.sessionProjections.register(teamProjectionDefinition)
    const forkId = SessionId('fork')
    const records = [event('team/mode', { enabled: true }, SessionSeq(0))]
    const restored = ctx.sessionProjections.restore(
      { agentTeam: { ver: 5, seq: SessionSeq(0), val: {
        enabled: true, id: TeamId(forkId), members: [], tasks: [], messages: [], delivered: [], nextTaskNumber: 1,
      } } },
      records, SessionLogOffset(0),
      { version: SESSION_FORMAT_VERSION, id: forkId, createdAt: 0, isSeeded: true },
      SessionLogOffset(1),
    )
    const state = teamProjectionDefinition.stateSchema.parse(restored.checkpoint['agentTeam']!.val)
    expect(teamProjectionView(state)).toEqual({ enabled: false, tasks: [] })
  })

  it('restores a malformed mode record as a visible failure without aborting Session recovery', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.sessionProjections.register(teamProjectionDefinition)
    const records = [
      event('team/mode', { enabled: true }, SessionSeq(0)),
      JSON.parse('{"type":"team/mode","seq":1,"time":1,"data":{"enabled":"yes"}}') as SessionEvent,
    ]
    const restored = ctx.sessionProjections.restore({}, records, SessionLogOffset(0),
      { version: SESSION_FORMAT_VERSION, id: ROOT, createdAt: 0, isSeeded: false }, SessionLogOffset(0))
    const state = teamProjectionDefinition.stateSchema.parse(restored.checkpoint['agentTeam']!.val)
    expect(teamProjectionView(state)).toEqual({ enabled: true, tasks: [], failure: 'persisted Agent Teams team/mode payload is invalid' })
    const disabled = teamProjectionDefinition.apply(state, event('team/mode', { enabled: false }, SessionSeq(2)))
    expect(teamProjectionView(disabled)).toMatchObject({ enabled: false, failure: state.failure })
    const invalidAgain = teamProjectionDefinition.apply(disabled, records[1]!)
    expect(invalidAgain.failure).toBe(state.failure)
  })

  it('allows disabling tools after a task-board failure without discarding its error', () => {
    const failed = project(ROOT, [
      event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0)),
      event('team/task', { version: 2, teamId: TEAM, task: task({ revision: 3 }) }, SessionSeq(1)),
    ])
    const off = teamProjectionDefinition.apply(failed, event('team/mode', { enabled: false }, SessionSeq(2)))
    expect(off.failure).toBe(failed.failure)
    expect(off.tasks).toBe(failed.tasks)
    expect(teamProjectionView(off).enabled).toBe(false)
    expect(teamProjectionView(off).failure).toContain('not contiguous')
  })

  it('enforces task revision continuity', () => {
    const first = event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0))
    expect(() => projectTeam(ROOT, [event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ revision: 2 }),
    }, SessionSeq(0))])).toThrow(/begin at revision 1/)
    expect(() => projectTeam(ROOT, [first, event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ revision: 3 }),
    }, SessionSeq(1))])).toThrow(/revision is not contiguous/)
  })

  it('rejects every invalid persisted task dependency relation', () => {
    const first = event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0))
    const second = event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({
        id: TeamTaskId('task-2'),
        blockedBy: [TeamTaskId('task-1')],
      }),
    }, SessionSeq(1))
    const invalid: Array<{ records: SessionEvent[]; message: RegExp }> = [
      {
        records: [event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ blockedBy: [TeamTaskId('missing')] }),
        }, SessionSeq(0))],
        message: /blocker task "missing" .* is missing or deleted/,
      },
      {
        records: [event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ blockedBy: [TeamTaskId('task-1')] }),
        }, SessionSeq(0))],
        message: /cannot block itself/,
      },
      {
        records: [first, event('team/task', {
          ...second.data,
          task: { ...second.data.task, blockedBy: [TeamTaskId('task-1'), TeamTaskId('task-1')] },
        }, SessionSeq(1))],
        message: /repeats blocker/,
      },
      {
        records: [first, second, event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ revision: 2, blockedBy: [TeamTaskId('task-2')] }),
        }, SessionSeq(2))],
        message: /dependency cycle/,
      },
      {
        records: [first, second, event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ revision: 2, status: 'deleted' }),
        }, SessionSeq(2))],
        message: /blocker task "task-1" .* is missing or deleted/,
      },
    ]

    for (const { records, message: expected } of invalid) {
      expect(() => projectTeam(ROOT, records)).toThrow(expected)
    }
  })

  it('leaves numeric allocation unchanged for a branded nonstandard task id', () => {
    const state = projectTeam(ROOT, [event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ id: TeamTaskId('external-task') }),
    }, SessionSeq(0))])
    expect(state.nextTaskNumber).toBe(1)
  })

  it('rejects a persisted numeric task id outside the safe integer range', () => {
    expect(() => projectTeam(ROOT, [event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ id: TeamTaskId('task-9007199254740992') }),
    }, SessionSeq(0))])).toThrow(/persisted Agent Teams team\/task payload is invalid/)
  })

  it.each([
    { version: 2, teamId: TEAM, task: { ...task(), blockedBy: [42] } },
    { version: 2, teamId: 42, task: task() },
    { version: 2, teamId: TEAM, task: task(), unexpected: true },
  ])('rejects malformed task payloads: %j', (data) => {
    const record = JSON.parse(JSON.stringify({ type: 'team/task', seq: 0, time: 0, data })) as SessionEvent
    expect(() => projectTeam(ROOT, [record])).toThrow(/team\/task payload is invalid/)
  })

  it('ignores retired roster and mailbox payloads without retaining or rewriting them', () => {
    const state = project(ROOT, [event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0))])
    const view = teamProjectionView(state)
    for (const type of ['team/member', 'team/message/queued', 'team/message/delivered']) {
      for (const data of [null, { version: 1, teamId: TEAM }, { version: 2, teamId: TEAM }]) {
        const record = JSON.parse(JSON.stringify({ type, seq: 1, time: 1, data })) as SessionEvent
        const before = JSON.stringify(record)
        expect(teamProjectionDefinition.apply(state, record)).toBe(state)
        expect(teamProjectionView(state)).toBe(view)
        expect(JSON.stringify(record)).toBe(before)
      }
    }
    expect(Object.keys(teamProjectionDefinition.stateSchema.parse(state)).sort()).toEqual([
      'enabled', 'id', 'inheritedEventCount', 'nextTaskNumber', 'tasks',
    ])
  })

  it('rebuilds version-6 state without historical mailbox failures and restores current checkpoint suffixes', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.sessionProjections.register(teamProjectionDefinition)
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: ROOT, createdAt: 0, isSeeded: false }
    const records = [
      event('team/member', { version: 2, teamId: TEAM, member: member({ phase: 'active' }) }, SessionSeq(0)),
      event('team/message/delivered', { version: 2, teamId: TEAM, messageId: TeamMessageId('message-1'), targetId: CHILD }, SessionSeq(1)),
      event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(2)),
      event('team/mode', { enabled: false }, SessionSeq(3)),
      event('team/message/queued', { version: 2, teamId: TEAM, message: message() }, SessionSeq(4)),
      event('team/task', { version: 2, teamId: TEAM, task: task({ revision: 2, status: 'completed' }) }, SessionSeq(5)),
    ]
    const oldState = {
      ...project(ROOT, []), members: [member()], messages: [message()], delivered: [],
      failure: 'teammate "worker-a" must begin provisioning',
    }
    const full = ctx.sessionProjections.restore({}, records, SessionLogOffset(0), header, SessionLogOffset(0))
    const rebuilt = ctx.sessionProjections.restore(
      { agentTeam: { ver: 6, seq: SessionSeq(3), val: oldState } },
      records, SessionLogOffset(0), header, SessionLogOffset(0),
    )
    expect(rebuilt).toEqual(full)
    const prefix = ctx.sessionProjections.restore({}, records.slice(0, 4), SessionLogOffset(0), header, SessionLogOffset(0))
    const suffix = ctx.sessionProjections.restore(prefix.checkpoint, records.slice(4), SessionLogOffset(4), header, SessionLogOffset(0))
    expect(suffix).toEqual(full)
    const state = teamProjectionDefinition.stateSchema.parse(full.checkpoint['agentTeam']!.val)
    expect(state).toEqual({
      id: TEAM, inheritedEventCount: 0, enabled: false, nextTaskNumber: 2,
      tasks: [task({ revision: 2, status: 'completed' })],
    })
    expect(full.checkpoint['agentTeam']!.ver).toBe(7)
    expect(teamProjectionView(state)).toMatchObject({ enabled: false, tasks: [{ status: 'completed' }] })
  })

  it('records unsupported event versions without applying them', () => {
    const invalid = event('team/task', {
      version: 1 as 2,
      teamId: TEAM,
      task: task(),
    }, SessionSeq(0))
    const later = event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task(),
    }, SessionSeq(1))
    const state = project(ROOT, [invalid, later])
    expect(state.failure).toMatch(/unsupported Agent Teams event version 1/)
    expect(state.tasks).toEqual([])
  })

  it('isolates unsupported inherited Team records from the current Team', () => {
    const inherited = event('team/task', {
      version: 1 as 2,
      teamId: TeamId('ancestor'),
      task: task(),
    }, SessionSeq(0))
    const projected = project(ROOT, [inherited])
    expect(projected.failure).toBeUndefined()
    expect(teamState(projected).tasks).toEqual([])
  })

  it('ignores malformed current-version records inherited from another Team', () => {
    const inherited = {
      ...event('team/task', {
        version: 2,
        teamId: TeamId('ancestor'),
        task: task(),
      }, SessionSeq(0)),
      data: {
        version: 2,
        teamId: TeamId('ancestor'),
        task: { ...task(), subject: 42 },
      },
    } as unknown as SessionEvent
    expect(projectTeam(ROOT, [inherited]).tasks).toEqual([])
  })

  it('leaves subagent catalog events to their owning projection', () => {
    const state = project(ROOT, [])
    const next = teamProjectionDefinition.apply(state, catalog('child', 0))
    expect(next).toBe(state)
    expect(teamProjectionView(next)).toEqual({ enabled: false, tasks: [] })
  })

  describe('copy-on-write state and client view', () => {
    const memberEvent = event('team/member', { version: 2, teamId: TEAM, member: member() }, SessionSeq(0))
    const taskEvent = event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(1))
    const queuedEvent = event('team/message/queued', { version: 2, teamId: TEAM, message: message() }, SessionSeq(2))
    const deliveredEvent = event('team/message/delivered', {
      version: 2, teamId: TEAM, messageId: TeamMessageId('message-1'), targetId: CHILD,
    }, SessionSeq(3))

    it('keeps unrelated events unchanged and replaces tasks without mutating prior state', () => {
      const initial = project(ROOT, [])
      expect(teamProjectionDefinition.apply(initial, catalog('child', 0))).toBe(initial)
      const withTask = teamProjectionDefinition.apply(initial, taskEvent)
      expect(withTask).not.toBe(initial)
      expect(withTask.tasks).not.toBe(initial.tasks)
      expect(initial.tasks).toEqual([])
      for (const record of [memberEvent, queuedEvent, deliveredEvent]) {
        expect(teamProjectionDefinition.apply(withTask, record)).toBe(withTask)
      }
    })

    it('enters failure through a new state that keeps the last valid collections', () => {
      const valid = project(ROOT, [memberEvent, taskEvent])
      const failed = teamProjectionDefinition.apply(valid, event('team/task', {
        version: 1 as 2, teamId: TEAM, task: task(),
      }, SessionSeq(2)))
      expect(failed).not.toBe(valid)
      expect(valid.failure).toBeUndefined()
      expect(failed.failure).toMatch(/unsupported Agent Teams event version 1/)
      expect(failed.tasks).toBe(valid.tasks)
      expect(teamProjectionDefinition.apply(failed, queuedEvent)).toBe(failed)
    })

    it('views non-deleted derived tasks and reuses the view across historical records', () => {
      const activeMember = event('team/member', { version: 2, teamId: TEAM, member: member({ phase: 'active' }) }, SessionSeq(1))
      const claimed = event('team/task', {
        version: 2, teamId: TEAM, task: task({ revision: 2, status: 'in_progress', ownerId: CHILD, writeScopes: ['src'] }),
      }, SessionSeq(2))
      const blocked = event('team/task', {
        version: 2, teamId: TEAM, task: task({ id: TeamTaskId('task-2'), blockedBy: [TeamTaskId('task-1')], writeScopes: ['src/web'] }),
      }, SessionSeq(3))
      const leadOwned = event('team/task', {
        version: 2, teamId: TEAM, task: task({ id: TeamTaskId('task-3'), revision: 1, status: 'in_progress', ownerId: ROOT }),
      }, SessionSeq(4))
      const deleted = event('team/task', {
        version: 2, teamId: TEAM, task: task({ id: TeamTaskId('task-3'), revision: 2, status: 'deleted', ownerId: ROOT }),
      }, SessionSeq(5))
      const state = project(ROOT, [memberEvent, activeMember, taskEvent, claimed, blocked, leadOwned, deleted])
      const view = teamProjectionView(state)
      expect(teamProjectionDefinition.wire.viewSchema.parse(view)).toEqual(view)
      expect(view).toEqual({
        enabled: true,
        tasks: [
          {
            id: 'task-1', revision: 2, subject: 'subject', description: 'description', status: 'in_progress',
            blockedBy: [], writeScopes: ['src'], ownerId: CHILD, ready: false, writeScopeWarnings: [],
          },
          {
            id: 'task-2', revision: 1, subject: 'subject', description: 'description', status: 'pending',
            blockedBy: ['task-1'], writeScopes: ['src/web'], ready: false, writeScopeWarnings: ['write scopes overlap with task-1'],
          },
        ],
      })
      expect(view).not.toHaveProperty('failure')
      expect(teamProjectionView(state)).toBe(view)

      const withMail = teamProjectionDefinition.apply(state, { ...queuedEvent, seq: SessionSeq(6) })
      expect(teamProjectionView(withMail)).toBe(view)
      const withMember = teamProjectionDefinition.apply(withMail, event('team/member', {
        version: 2, teamId: TEAM, member: member({ id: SessionId('child-b'), name: 'worker-b' }),
      }, SessionSeq(7)))
      expect(teamProjectionView(withMember)).toBe(view)
      expect(withMember).toBe(state)
    })

    it('publishes the failure with the last valid tasks', () => {
      const state = project(ROOT, [memberEvent, taskEvent, event('team/task', {
        version: 1 as 2, teamId: TEAM, task: task(),
      }, SessionSeq(2))])
      const view = teamProjectionView(state)
      expect(view.failure).toMatch(/unsupported Agent Teams event version 1/)
      expect(view).not.toHaveProperty('members')
      expect(view.tasks).toHaveLength(1)
      expect(teamProjectionDefinition.wire.viewSchema.parse(view)).toEqual(view)
    })

    it('drives live agentTeam publications per Session through the projection registry', async () => {
      const ctx = new Context()
      onTestFinished(() => ctx.fiber.dispose())
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.sessionProjections.register(teamProjectionDefinition)
      const published: Array<{ session: SessionId; key: string; value: unknown }> = []
      ctx.sessionProjections.onChanged((session, key, value) => {
        published.push({ session: session.id, key, value })
      })
      const lead = ctx.sessions.create(ROOT)
      const other = ctx.sessions.create(SessionId('other-root'))
      expect(ctx.sessionProjections.snapshot(lead).values['agentTeam']).toEqual({
        enabled: false,
        tasks: [],
      })

      lead.append('team/task', taskEvent.data)
      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({
        session: ROOT,
        key: 'agentTeam',
        value: { tasks: [{ id: 'task-1', ready: true }] },
      })

      lead.append('team/message/queued', queuedEvent.data)
      lead.append('turn/start', { turn: 1 })
      expect(published).toHaveLength(1)

      other.append('team/task', { version: 2, teamId: TeamId(other.id), task: task() })
      expect(published).toHaveLength(2)
      expect(published[1]).toMatchObject({
        session: other.id,
        value: { tasks: [{ id: 'task-1' }] },
      })
      expect(ctx.sessionProjections.snapshot(lead).values['agentTeam']).toMatchObject({
        tasks: [{ id: 'task-1' }],
      })
    })
  })
})
