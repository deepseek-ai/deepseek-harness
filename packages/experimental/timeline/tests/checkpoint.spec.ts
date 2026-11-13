import { describe, expect, it } from 'vitest'
import { Checkpoint, CHECKPOINT_BYTES } from '../src/checkpoint.ts'
import { patchSchema } from '../src/records.ts'
import { measureAll, patchTasks, prioritiesOf } from '../src/tasks.ts'
import checkpoint from './checkpoint.timeline.json' with { type: 'json' }
import manifest from '../package.json' with { type: 'json' }

describe('portable task-tree checkpoints', () => {
  it('round-trips saved statuses without requiring a new reason for each task', () => {
    const saved = Checkpoint.fromJson({
      format: checkpoint.format,
      version: 1,
      title: 'Recover saved work',
      tasks: [
        { id: 'group', title: 'Old scope' },
        { id: 'child', parent: 'group', title: 'Old task' },
        { id: 'blocked', title: 'Restore access', status: 'blocked', note: 'Waiting for access.' },
      ],
    }).restore('source', 1000).tree
    const edits = patchSchema.array().parse([
      { id: 'group', status: 'retired', subtree: true, note: 'Scope removed.' },
      { id: 'blocked', note: '' },
    ])
    const updated = patchTasks(saved.tasks, edits, 2000, 10)
    const exported = Checkpoint.fromTree({ ...saved, tasks: updated }, [], 2000, 'source-session')
    expect(Checkpoint.fromString(exported.toString()).toJson()).toEqual(exported.toJson())
  })
  it('preserves empty plans and tree-level discussions with optional clocks', () => {
    const empty = Checkpoint.fromJson({
      format: checkpoint.format, version: 1, title: 'New plan', tasks: [],
      discussions: [{ text: 'Review the plan.' }, { text: 'Next step?', reply: { text: 'Start with setup.' } }],
    })
    const restored = empty.restore('new-tree', 1000)
    expect(restored.tree).toMatchObject({ tasks: [], createdAt: 1000 })
    expect(restored.annotations).toMatchObject([
      { target: { kind: 'tree', tree: 'new-tree' }, createdAt: 1000, reply: null },
      { target: { kind: 'tree', tree: 'new-tree' }, createdAt: 1000, reply: { createdAt: 1000 } },
    ])
    expect(JSON.parse(empty.toString())).not.toHaveProperty('metadata')
    const exported = Checkpoint.fromTree(restored.tree, restored.annotations, 2000, 'source-session')
    expect(exported.toJson()).not.toHaveProperty('elapsedMs')
    expect(exported.toJson().discussions).toMatchObject([{ text: 'Review the plan.' }, { text: 'Next step?' }])
  })
  it('rejects an export whose acknowledged task details exceed the portable file limit', () => {
    const file = Checkpoint.fromJson({
      format: checkpoint.format, version: 1, title: 'Large plan',
      tasks: Array.from({ length: 400 }, (_, index) => ({ id: `task-${index}`, title: 'Work', details: '测'.repeat(2000) })),
    })
    expect(() => file.toString()).toThrow('2 MiB')
  })
  it('ends exported elapsed time at the last completed task and preserves active notes', () => {
    const complete = Checkpoint.fromJson({
      format: checkpoint.format, version: 1, title: 'Finished plan', elapsedMs: 1000,
      tasks: [{ id: 'one', title: 'Check', status: 'done' }],
    }).restore('finished', 2000)
    expect(Checkpoint.fromTree(complete.tree, [], 9000, 'source-session').toJson().elapsedMs).toBe(1000)
    const active = Checkpoint.fromJson({
      format: checkpoint.format, version: 1, title: 'Open plan',
      tasks: [
        { id: 'one', title: 'Check', status: 'active', note: 'Waiting for sample data.' },
        { id: 'two', title: 'Verify', status: 'active' },
      ],
    }).restore('active', 2000)
    expect(active.tree.tasks[0]).toMatchObject({ status: 'paused', note: 'Waiting for sample data.' })
    expect(active.tree.tasks[1]).toMatchObject({ status: 'paused', note: 'Imported checkpoint; awaiting continuation.' })
  })
  it('round-trips hierarchy, weighted units, user priorities and discussion pairs without runtime state', () => {
    const file = Checkpoint.fromJson(checkpoint)
    const restored = file.restore('copied', 300000)
    expect(measureAll(restored.tree.tasks).get(null)?.progress).toBe(
      measureAll(file.tasks).get(null)?.progress,
    )
    expect(restored.resume).toEqual(['verify'])
    expect(restored.tree.tasks.find(task => task.id === 'verify')).toMatchObject({
      status: 'paused',
      done: [2, 5],
      timeShare: 1.75,
      priority: 'P0',
      details: checkpoint.tasks[2]?.details,
    })
    const first = restored.tree.tasks[0]
    const leaf = restored.tree.tasks[1]
    const note = restored.annotations[0]
    if (first === undefined || leaf === undefined || note === undefined)
      throw new Error('Missing checkpoint fixture data')
    expect(prioritiesOf(restored.tree.tasks).get(leaf.id)).toBe('P1')
    expect(restored.tree.createdAt).toBe(180000)
    expect(restored.annotations[0]).toMatchObject({
      target: { kind: 'task', tree: 'copied', task: 'verify' },
      text: checkpoint.discussions[0]?.text,
      reply: checkpoint.discussions[0]?.reply,
    })
    const control = {
      ...note,
      id: 'note-0123456789abcdef',
      control: { action: 'pause' as const, delivery: 'accepted' as const, outcome: null },
    }
    const output = Checkpoint.fromTree(
      restored.tree,
      [...restored.annotations, control],
      300000,
      'source-session',
      manifest.version,
    )
    const exported = output.toJson()
    const exportedFile: unknown = JSON.parse(output.toString())
    expect(exportedFile).toMatchObject({ metadata: {
      plugin: manifest.name,
      pluginVersion: manifest.version,
      exportedAt: new Date(300000).toISOString(),
      sourceSessionId: 'source-session',
      sourceTreeId: 'copied',
      treeCreatedAt: new Date(180000).toISOString(),
      lastTaskUpdatedAt: new Date(300000).toISOString(),
    } })
    expect(exported).not.toHaveProperty('metadata')
    expect(exported.discussions).toHaveLength(1)
    expect(exported.tasks[0]).not.toHaveProperty('status')
    expect(exported.tasks[0]).not.toHaveProperty('done')
    expect(exported.tasks[1]).not.toHaveProperty('remaining')
    expect(Checkpoint.fromString(file.toString()).toJson()).toEqual(file.toJson())
    first.title = 'Changed copy'
    leaf.done[0] = 1
    expect(file.restore('another', 300000).tree.tasks[1]?.done).toEqual([3, 3])
    expect(file.toJson().tasks[0]?.title).toBe('Recover saved work')
  })
  it.each([
    null,
    { ...checkpoint, version: 2 },
    { ...checkpoint, tasks: [{ id: 'self', title: 'Cycle', parent: 'self' }] },
    { ...checkpoint, tasks: [{ id: 'missing', title: 'Missing parent', parent: 'absent' }] },
    { ...checkpoint, tasks: [{ id: 'bad', title: 'Bad units', done: [6, 5] }] },
    { ...checkpoint, discussions: [{ task: 'absent', text: 'Unknown task.' }] },
    { ...checkpoint, discussions: [{ text: 'Invalid date.', createdAt: Number.MAX_SAFE_INTEGER }] },
    {
      ...checkpoint,
      discussions: [
        { text: 'Invalid reply date.', reply: { text: 'Reply.', createdAt: Number.MAX_SAFE_INTEGER } },
      ],
    },
  ])('rejects unsupported or damaged checkpoints before restoration', (value) => {
    expect(() => Checkpoint.fromJson(value)).toThrow()
  })
  it('bounds UTF-8 file bytes and ignores only inert optional metadata', () => {
    expect(() => Checkpoint.fromString('中'.repeat(CHECKPOINT_BYTES / 2))).toThrow('2 MiB')
    expect(
      Checkpoint.fromJson({ ...checkpoint, metadata: { futureDescription: 'Informational only.' } }).toJson(),
    ).not.toHaveProperty('metadata')
    const descriptive = Checkpoint.fromJson({ ...checkpoint, metadata: { pluginVersion: '99.0.0' } })
    const exportedFile: unknown = JSON.parse(descriptive.toString())
    expect(exportedFile).toMatchObject({ metadata: { pluginVersion: '99.0.0' } })
    expect(descriptive.toJson()).toEqual(Checkpoint.fromJson(checkpoint).toJson())
    expect(() => Checkpoint.fromJson({ ...checkpoint, requiredNewBehavior: true })).toThrow()
  })
})
