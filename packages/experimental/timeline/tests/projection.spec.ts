import { Context } from '@deepseek-ai/cordis'
import Sessions, {
  appendPluginRecord,
  pluginRecordOf,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import { createProjection, foldRecord, registerProjection } from '../src/projection.ts'
import { annotationSchema, failureRecordSchema, reportSchema, treeSchema } from '../src/records.ts'
import { reportRanges } from '../src/periods.ts'
import { HISTORY_MS, MAX_ANNOTATIONS, MINUTE_MS } from '../src/policy.ts'

describe('durable plugin projection', () => {
  it('rejects invalid records at replay and preserves the tree selected by the last valid call', () => {
    const projection = createProjection()
    const header = Session.create(SessionId('record-owners')).header
    const initial = projection.init(header, SessionLogOffset(0))
    const base = { version: 1, sessionId: header.id }
    const tree = treeSchema.parse({ id: 'plan', title: 'Plan', description: '', tasks: [], createdAt: 1 })
    const withTree = foldRecord(initial, { type: 'plugin:timeline/tree', data: { ...base, callId: 'start', tree } })
    const note = { id: 'note-0000000000000001', target: { kind: 'tree', tree: tree.id }, text: 'What remains?', createdAt: 1, reply: null } as const
    const annotation = { ...base, annotation: note }
    const withNote = foldRecord(withTree, { type: 'plugin:timeline/annotation', data: annotation })
    const selection = { ...base, callId: 'start', treeId: tree.id }
    const selected = foldRecord(withNote, { type: 'plugin:timeline/select', data: selection })
    expect(selected.calls).toEqual([{ id: 'start', tree: tree.id }])
    expect(projection.wire.view(selected)).toBe(selected.view)
    const reply = { ...base, id: note.id, text: 'Check recovery.', createdAt: 2 }
    const answered = foldRecord(selected, { type: 'plugin:timeline/reply', data: reply })
    expect(answered.view.annotations[0]?.reply?.text).toBe(reply.text)

    for (const type of ['import', 'import-ready', 'remove', 'annotation', 'delivery', 'reply', 'select', 'report', 'failure'])
      expect(foldRecord(answered, { type: `plugin:timeline/${type}`, data: null })).toBe(answered)
    for (const record of [
      { type: 'remove', data: { ...base, treeId: 'missing' } },
      { type: 'select', data: { ...selection, treeId: 'missing' } },
      { type: 'annotation', data: annotation },
      { type: 'annotation', data: { ...annotation, annotation: { ...note, id: 'note-0000000000000002', target: { kind: 'tree', tree: 'missing' } } } },
      { type: 'annotation', data: { ...annotation, annotation: { ...note, id: 'note-0000000000000003', reply: { text: 'Answer', createdAt: 2 } } } },
      { type: 'annotation', data: { ...annotation, annotation: {
        ...note, id: 'note-0000000000000004', control: { action: 'pause', delivery: 'accepted', outcome: null },
      } } },
      { type: 'delivery', data: { ...base, id: note.id, delivery: 'accepted' } },
      { type: 'reply', data: reply },
      { type: 'priority', data: { ...base, treeId: tree.id, taskId: 'missing', priority: 'P0', createdAt: 2 } },
      { type: 'import', data: { ...base, callId: 'import', tree, annotations: [note] } },
    ]) expect(foldRecord(answered, { ...record, type: `plugin:timeline/${record.type}` })).toBe(answered)
    const full = { ...answered, view: { ...answered.view, annotations: Array.from({ length: MAX_ANNOTATIONS }, (_, index) => annotationSchema.parse({ ...note, id: `note-${index.toString(16).padStart(16, '0')}` })) } }
    const newNote = { ...note, id: 'note-000000000000ffff' }
    const imported = foldRecord(initial, {
      type: 'plugin:timeline/import',
      data: { ...base, callId: 'legacy', tree, annotations: [note] },
    })
    expect(imported.view).toMatchObject({ activeTreeId: tree.id, trees: [tree], annotations: [note] })
    expect(foldRecord(initial, {
      type: 'plugin:timeline/import-ready', data: { ...base, callId: 'unprepared' },
    })).toBe(initial)
    expect(foldRecord(full, { type: 'plugin:timeline/import', data: { ...base, callId: 'import', tree, annotations: [newNote] } })).toBe(full)
    expect(foldRecord(full, { type: 'plugin:timeline/annotation', data: { ...base, annotation: newNote } })).toBe(full)
  })
  it('replays owned turn brackets, including recovery, without inheriting parent work or downtime', () => {
    const projection = createProjection()
    const header = { ...Session.create(SessionId('timing')).header, createdAt: 10000 }
    let state = projection.init(header, SessionLogOffset(2))
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 0 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 1000, data: { turn: 0, reason: { kind: 'forked' } } },
      { type: 'turn/start', seq: SessionSeq(2), time: 20000, data: { turn: 1 } },
      {
        type: 'turn/end',
        seq: SessionSeq(3),
        time: 80000,
        data: { turn: 1, reason: { kind: 'interrupted' } },
      },
      { type: 'turn/start', seq: SessionSeq(4), time: 3680000, data: { turn: 2 } },
    ]
    for (const event of events) state = projection.apply(state, event)
    expect(state.activity).toEqual({ start: 10000, olderWorkMs: 0, ranges: [[20000, 80000]], open: 3680000 })
  })
  it('bounds activity timing without losing the duration of uncovered work', () => {
    const projection = createProjection()
    const header = { ...Session.create(SessionId('old-activity')).header, createdAt: 0 }
    let state = projection.init(header, SessionLogOffset(0))
    const hour = 3600000
    for (let index = 0; index < 400; index++) {
      const start = index * hour
      state = projection.apply(state, { type: 'turn/start', seq: SessionSeq(index * 2), time: start, data: { turn: index } })
      state = projection.apply(state, { type: 'turn/end', seq: SessionSeq(index * 2 + 1), time: start + 1000, data: { turn: index, reason: { kind: 'completed' } } })
    }
    expect(state.activity).toMatchObject({ start: 399 * hour + 1000 - HISTORY_MS, olderWorkMs: 232000 })
    expect(state.activity.ranges).toHaveLength(168)
    const report = reportSchema.parse({
      id: 'old-base', level: 0, start: 0, end: 399 * hour + 1000, policy: '[60000]', children: [],
      source: 'no-activity', toolCount: 0, covered: 0, contextSeq: 0, summary: { progress: ['No activity.'], uncertainties: [], userActions: [] },
    })
    expect(reportRanges(report, state.activity)).toBeUndefined()
    state = foldRecord(state, { type: 'plugin:timeline/report', data: { version: 1, sessionId: header.id, report } })
    expect(state.activity.olderWorkMs).toBe(0)
  })
  it('keeps the declared failure identity when a saved record is validated', () => {
    const record = { version: 1, sessionId: 'replay', id: 'failed-report', message: 'Request timed out.' }
    expect(failureRecordSchema.parse(record)).toEqual(record)
    expect(() => failureRecordSchema.parse({ ...record, id: '' })).toThrow()
  })
  it('keeps report discussions on append and replacement and drops them on expiry', () => {
    const projection = createProjection()
    const header = { ...Session.create(SessionId('report-discussions')).header, createdAt: 0 }
    let state = projection.init(header, SessionLogOffset(0))
    const base = { version: 1, sessionId: header.id }
    const save = (id: string, end: number) => {
      state = foldRecord(state, {
        type: 'plugin:timeline/report',
        data: {
          ...base,
          report: {
            id, level: 0, start: end - 1, end, policy: '[60000]', children: [],
            source: 'no-activity', toolCount: 0, covered: 0, contextSeq: 0,
            summary: { progress: ['No activity.'], uncertainties: [], userActions: [] },
          },
        },
      })
    }
    save('first', 1)
    state = foldRecord(state, {
      type: 'plugin:timeline/annotation',
      data: {
        ...base,
        annotation: {
          id: 'note-0000000000000001', target: { kind: 'report', report: 'first' },
          text: 'Is the task still active?', createdAt: 1, reply: null,
        },
      },
    })
    const { annotations } = state.view
    expect(annotations).toHaveLength(1)
    save('second', 2)
    expect(state.view.annotations).toBe(annotations)
    save('first', 2)
    expect(state.view.reports.map(report => report.id)).toEqual(['second', 'first'])
    expect(state.view.annotations).toEqual(annotations)
    save('recent', HISTORY_MS + 3)
    expect(state.view.reports.map(report => report.id)).toEqual(['recent'])
    expect(state.view.annotations).toEqual([])
    const report = state.view.reports[0]
    if (report === undefined) throw new Error('Missing retained report')
    const reports = Array.from({ length: 5 * Math.ceil(HISTORY_MS / MINUTE_MS) }, (_, index) => ({
      ...report,
      id: reportSchema.shape.id.parse(`report-${index}`),
    }))
    state = { ...state, view: { ...state.view, reports } }
    save('newest', report.end + 1)
    expect(state.view.reports).toHaveLength(reports.length)
    expect(state.view.reports[0]).toBe(reports[1])
    expect(state.view.reports.at(-1)?.id).toBe('newest')
  })
  it('skips a malformed inherited Timeline record without losing other fork history', () => {
    const projection = createProjection()
    const header = Session.create(SessionId('damaged-fork')).header
    const state = projection.init(header, SessionLogOffset(1))
    const malformed = JSON.parse(
      '{"type":"plugin:timeline/tree","ignorable":true,"seq":0,"time":1,"data":null}',
    ) as SessionEvent
    expect(projection.apply(state, malformed)).toBe(state)
  })
  it('copies the selected forest at the fork point without carrying pending requests or write receipts', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Sessions)
      await ctx.plugin(Projections)
      const reader = await registerProjection(ctx)
      const source = ctx.sessions.create(SessionId('fork-source'))
      const base = { version: 1 as const, sessionId: source.id }
      const first = treeSchema.parse({ id: 'first', title: 'First plan', description: '', tasks: [], createdAt: 1 })
      const second = treeSchema.parse({
        id: 'second', title: 'Second plan', description: '', createdAt: 2,
        tasks: [{
          id: 'verify', parent: null, title: 'Verify recovery', description: '',
          status: 'active', done: [2, 3], timeShare: 1.5, remaining: 0, mode: 'serial', note: '', details: '',
          priority: null, createdAt: 2, updatedAt: 3,
        }],
      })
      appendPluginRecord(source, 'plugin:timeline/tree', { ...base, callId: 'first', tree: first })
      appendPluginRecord(source, 'plugin:timeline/tree', { ...base, callId: 'second', tree: second })
      const target = { kind: 'tree', tree: second.id } as const
      const note = annotationSchema.parse({
        id: 'note-0000000000000001', target, text: 'Keep the first two checks.', createdAt: 4, reply: null,
      })
      const control = annotationSchema.parse({
        id: 'note-0000000000000002', target, text: 'Pause here.', createdAt: 5, reply: null,
        control: { action: 'pause', delivery: 'sending', outcome: null },
      })
      appendPluginRecord(source, 'plugin:timeline/annotation', { ...base, annotation: note })
      appendPluginRecord(source, 'plugin:timeline/annotation', { ...base, annotation: control })
      appendPluginRecord(source, 'plugin:timeline/delivery', { ...base, id: control.id, delivery: 'accepted' })
      const task = second.tasks[0]
      if (task === undefined) throw new Error('Missing task in the source plan')
      const cut = appendPluginRecord(source, 'plugin:timeline/priority', {
        ...base, treeId: second.id, taskId: task.id, priority: 'P1', createdAt: 6,
      })
      appendPluginRecord(source, 'plugin:timeline/remove', { ...base, treeId: first.id })

      const fork = ctx.sessions.fork(source, cut, SessionId('fork-child'))
      const forkState = reader.stateOf(fork)
      expect(forkState.view.trees.map(tree => tree.id)).toEqual([first.id, second.id])
      expect(forkState.view.activeTreeId).toBe(second.id)
      expect(forkState.view.trees[1]?.tasks[0]).toMatchObject({
        status: 'active', done: [2, 3], timeShare: 1.5, priority: 'P1',
      })
      expect(forkState.view.annotations).toEqual([note])
      expect(forkState.calls).toEqual([])
      expect(reader.stateOf(source).view.annotations).toMatchObject([
        note, { ...control, control: { action: 'pause', delivery: 'accepted', outcome: null } },
      ])
      expect(reader.stateOf(source).view.trees.map(tree => tree.id)).toEqual([second.id])
      appendPluginRecord(source, 'plugin:timeline/reply', {
        ...base, id: control.id, text: 'I can pause after the check.', createdAt: 7,
      })
      expect(reader.stateOf(source).view.annotations.at(-1)?.control?.outcome?.status).toBe('answered')
      const afterReply = ctx.sessions.fork(source, undefined, SessionId('fork-after-reply'))
      expect(reader.stateOf(afterReply).view.annotations).toEqual([note])

      const completed = treeSchema.parse({
        ...second, tasks: [{ ...task, priority: 'P1', status: 'done', done: [3, 3], updatedAt: 7 }],
      })
      appendPluginRecord(fork, 'plugin:timeline/tree', {
        ...base, sessionId: fork.id, callId: 'child-update', tree: completed,
      })
      const nested = ctx.sessions.fork(fork, undefined, SessionId('fork-grandchild'))
      expect(reader.stateOf(nested).view.trees).toEqual(reader.stateOf(fork).view.trees)
      expect(reader.stateOf(nested).view.trees[1]?.tasks[0]?.done).toEqual([3, 3])
      expect(reader.stateOf(nested).view.annotations).toEqual([note])
      expect(reader.stateOf(source).view.trees[0]?.tasks[0]?.done).toEqual([2, 3])
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('replays task plans and limits the live report view without deleting log history', async () => {
    const ctx = new Context()
    await ctx.plugin(Sessions)
    const registry = await ctx.plugin(Projections)
    const reader = await registerProjection(ctx)
    const session = ctx.sessions.create(SessionId('replay'), { meta: { cwd: process.cwd() } })
    const events: SessionEvent[] = []
    ctx.on('session/event', (owner, event) => {
      if (owner === session) events.push(event)
    })
    const tree = treeSchema.parse({ id: 'work', title: 'Recovery', description: '', tasks: [], createdAt: 1 })
    appendPluginRecord(session, 'plugin:timeline/tree', {
      version: 1,
      sessionId: session.id,
      callId: 'tree',
      tree,
    })
    const report = reportSchema.parse({
      id: 'one',
      level: 0,
      start: 0,
      end: 60000,
      policy: 'test',
      children: [],
      source: 'no-activity',
      toolCount: 0,
      covered: 0,
      contextSeq: 0,
      summary: { progress: ['No activity.'], uncertainties: [], userActions: [] },
    })
    for (const field of ['start', 'end', 'createdAt']) {
      const damaged = { ...report, [field]: Number.MAX_SAFE_INTEGER }
      expect(foldRecord(reader.stateOf(session), {
        type: 'plugin:timeline/report',
        data: { version: 1, sessionId: session.id, report: damaged },
      })).toBe(reader.stateOf(session))
    }
    appendPluginRecord(session, 'plugin:timeline/report', { version: 1, sessionId: session.id, report })
    const annotation = {
      id: 'note-0000000000000001',
      target: { kind: 'report', report: report.id },
      text: 'Check the previous result.',
      createdAt: report.end,
      reply: null,
    } as const
    appendPluginRecord(session, 'plugin:timeline/annotation', { version: 1, sessionId: session.id, annotation })
    expect(reader.stateOf(session).view.annotations).toEqual([annotation])
    appendPluginRecord(session, 'plugin:timeline/report', {
      version: 1,
      sessionId: session.id,
      report: { ...report, id: reportSchema.shape.id.parse('two'), start: 604800000, end: 604860001 },
    })
    expect(reader.stateOf(session).view.reports.map(item => item.id)).toEqual(['two'])
    expect(reader.stateOf(session).view.annotations).toEqual([])
    expect(events.filter(event => pluginRecordOf(event)?.type === 'plugin:timeline/report')).toHaveLength(2)
    expect(events.filter(event => pluginRecordOf(event)?.type === 'plugin:timeline/annotation')).toHaveLength(1)
    await registry.dispose()
    await ctx.plugin(Projections)
    const resumed = await registerProjection(ctx)
    expect(resumed.stateOf(session).view.trees).toEqual([tree])
    expect(resumed.stateOf(session).view.reports.map(item => item.id)).toEqual(['two'])
    expect(resumed.stateOf(session).view.annotations).toEqual([])
    const fork = ctx.sessions.fork(session, undefined, SessionId('fork'))
    const child = resumed.stateOf(fork)
    expect(child.view.trees).toEqual([tree])
    expect(child.view.reports).toEqual([])
    expect(child.lastReportEnd).toBe(fork.header.createdAt)
    await ctx.fiber.dispose()
  })
})
