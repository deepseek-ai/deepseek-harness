import { describe, expect, it } from 'vitest'
import { patchSchema, taskId } from '../src/records.ts'
import { measureAll, patchTasks, prioritizedTasks } from '../src/tasks.ts'

const patch = (values: unknown) => patchSchema.array().parse(values)
describe('agent task trees', () => {
  it('infers complete work from units and rejects conflicting patches atomically', () => {
    const tasks = patchTasks([], patch([
      { id: 'group', title: 'Group' },
      { id: 'middle', title: 'Middle', parent: 'group' },
      { id: 'leaf', title: 'Leaf', parent: 'middle', done: [2, 2] },
      { id: 'other', title: 'Other' },
    ]), 1, 4)
    expect(tasks.find(task => task.id === 'leaf')?.status).toBe('done')
    for (const [input, message] of [
      [[{ id: 'other', title: 'First' }, { id: 'other', title: 'Second' }], 'Duplicate task'],
      [[{ id: 'leaf', status: 'pending', note: 'Reopened.' }], 'Pending tasks'],
      [[{ id: 'leaf', remaining: 1, note: 'Still due.' }], 'Done tasks'],
      [[{ id: 'extra', title: 'Extra' }], 'At most 4 tasks'],
      [[{ id: 'middle', status: 'retired', note: 'Removed.' }], 'Retire the subtree'],
    ] as const) expect(() => patchTasks(tasks, patch(input), 2, 4)).toThrow(message)
    expect(() => patchTasks([], patch([{ id: 'blocked', title: 'Blocked', status: 'blocked' }]), 2, 4))
      .toThrow('needs a reason')
    const retired = patchTasks(tasks, patch([{ id: 'group', status: 'retired', subtree: true, note: 'Moved elsewhere.' }]), 2, 4)
    expect(retired.map(task => task.status)).toEqual(['retired', 'retired', 'retired', 'pending'])
    expect(() => patchTasks(retired, patch([{ id: 'leaf', title: 'New title' }]), 3, 4)).toThrow('explicit status')
    expect(tasks[0]?.status).toBe('done')
  })
  it('puts urgent eligible leaves first across trees', () => {
    const tasks = patchTasks([], patch([
      { id: 'later', title: 'Later' },
      { id: 'urgent', title: 'Urgent' },
      { id: 'closed', title: 'Closed', status: 'done' },
    ]), 1, 3)
    const trees = [
      { id: 'one', tasks: tasks.slice(0, 1).map(task => ({ ...task, priority: 'P2' as const })) },
      { id: 'two', tasks: tasks.slice(1).map(task => ({ ...task, priority: 'P0' as const })) },
    ]
    expect(prioritizedTasks(trees, 1)).toMatchObject([{ tree: 'two', task: 'urgent', priority: 'P0' }])
  })
  it('partitions nested relative weights while counting leaves independently of their weights', () => {
    const tasks = patchTasks(
      [],
      patch([
        { id: 'group', title: 'Group', timeShare: 4 },
        { id: 'done', parent: 'group', title: 'Done', status: 'done', timeShare: 1 },
        { id: 'active', parent: 'group', title: 'Active', done: [1, 2], timeShare: 3 },
        { id: 'blocked', title: 'Blocked', status: 'blocked', done: [1, 4], timeShare: 2, note: 'Waiting.' },
        {
          id: 'paused',
          title: 'Paused',
          status: 'paused',
          done: [1, 2],
          timeShare: 1,
          note: 'User request.',
        },
        { id: 'pending', title: 'Pending', timeShare: 1 },
        { id: 'retired', title: 'Retired', status: 'retired', timeShare: 100, note: 'Removed.' },
      ]),
      1000,
      20,
    )
    const overall = measureAll(tasks, true).get(null)
    expect(overall?.progress).toBe(0.4375)
    expect(overall?.parts).toEqual({
      done: { fraction: 0.4375, leaves: 1, titles: ['Done'] },
      active: { fraction: 0.1875, leaves: 1, titles: ['Active'] },
      pending: { fraction: 0.1875, leaves: 2, titles: ['Paused', 'Pending'] },
      blocked: { fraction: 0.1875, leaves: 1, titles: ['Blocked'] },
    })
    expect(measureAll(tasks).get(null)).not.toHaveProperty('parts')
  })
  it('keeps the same share of sibling work after splitting a task', () => {
    const plan = patchTasks([], patch([
      { id: 'digitize', title: 'Digitize records', timeShare: 3 },
      { id: 'publish', title: 'Publish index', timeShare: 1, status: 'done' },
    ]), 1, 10)
    const split = patchTasks(plan, patch([
      { id: 'prepare', parent: 'digitize', title: 'Prepare records', timeShare: 1 },
      { id: 'scan', parent: 'digitize', title: 'Scan records', timeShare: 2 },
      { id: 'extract', parent: 'digitize', title: 'Extract text', timeShare: 4 },
      { id: 'check', parent: 'digitize', title: 'Check results', timeShare: 1 },
    ]), 2, 10)
    expect(measureAll(plan).get(null)?.progress).toBe(0.25)
    expect(measureAll(split).get(null)?.progress).toBe(0.25)

    const updated = patchTasks(split, patch([
      { id: 'scan', status: 'done', note: 'All records scanned.' },
    ]), 3, 10)
    const progress = measureAll(updated)
    expect(progress.get(taskId.parse('digitize'))?.progress).toBe(0.25)
    expect(progress.get(null)?.progress).toBeCloseTo(0.4375, 14)
  })
  it('bounds preview titles while retaining the full leaf count across nested groups', () => {
    const tasks = patchTasks(
      [],
      patch([
        { id: 'group', title: 'Group' },
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `work-${index}`,
          parent: index < 8 ? 'group' : null,
          title: `Work ${index + 1}`,
          status: 'active',
        })),
      ]),
      1,
      20,
    )
    const measured = measureAll(tasks, true)
    expect(measured.get(taskId.parse('group'))?.parts?.active).toEqual({
      fraction: 1,
      leaves: 8,
      titles: ['Work 1', 'Work 2', 'Work 3', 'Work 4', 'Work 5', 'Work 6'],
    })
    expect(measured.get(null)?.parts?.active).toEqual({
      fraction: 1,
      leaves: 12,
      titles: ['Work 1', 'Work 2', 'Work 3', 'Work 4', 'Work 5', 'Work 6'],
    })
  })
  it.each([Number.MIN_VALUE, 1, 1e308])(
    'preserves the full weighted partition with %s weights',
    (timeShare) => {
      const tasks = patchTasks(
        [],
        patch([
          { id: 'a', title: 'A', done: [1, 2], timeShare },
          { id: 'b', title: 'B', status: 'blocked', done: [1, 3], timeShare, note: 'Waiting.' },
        ]),
        1,
        10,
      )
      for (const measure of measureAll(tasks, true).values()) {
        const parts = measure.parts
        if (parts === undefined) throw new Error('Missing progress partition')
        expect(parts.done.fraction).toBe(measure.progress)
        expect(Object.values(parts).reduce((sum, part) => sum + part.fraction, 0)).toBeCloseTo(1, 14)
        expect(
          Object.values(parts).every(part => Number.isFinite(part.fraction) && part.fraction >= 0),
        ).toBe(true)
      }
    },
  )
  it('keeps status-confirmation headroom visible and excludes empty or retired-only trees', () => {
    for (const tasks of [
      [],
      patchTasks([], patch([{ id: 'x', title: 'X', status: 'retired', note: 'Removed.' }]), 1, 10),
    ])
      expect(measureAll(tasks, true).get(null)).toBeUndefined()
    const tasks = patchTasks([], patch([{ id: 'x', title: 'X', status: 'active', done: [1, 1] }]), 1, 10)
    const overall = measureAll(tasks, true).get(null)
    expect(overall?.progress).toBe(0.9999)
    expect(overall?.parts?.done.fraction).toBe(0.9999)
    expect(overall?.parts?.active.fraction).toBeCloseTo(0.0001, 14)
    expect(overall?.parts?.done.leaves).toBe(0)
  })
  it.each([Number.MIN_VALUE, 1, 1e308])('keeps relative progress stable for weights of %s', (timeShare) => {
    const tasks = patchTasks(
      [],
      patch([
        { id: 'first', title: 'First', status: 'done', timeShare },
        { id: 'second', title: 'Second', done: [1, 2], timeShare },
      ]),
      1000,
      20,
    )
    expect(measureAll(tasks).get(null)?.progress).toBe(0.75)
  })
  it('derives weighted parent progress and parallel remaining time', () => {
    const tasks = patchTasks(
      [],
      patch([
        { id: 'root', title: 'Restore sessions', mode: 'parallel' },
        { id: 'read', parent: 'root', title: 'Read saved sessions', status: 'done', timeShare: 1 },
        {
          id: 'resume',
          parent: 'root',
          title: 'Resume sessions',
          status: 'active',
          done: [1, 2],
          timeShare: 3,
          remaining: 10,
        },
      ]),
      1000,
      20,
    )
    expect(measureAll(tasks).get(null)).toEqual({ progress: 0.625, remaining: 10, status: 'active' })
  })
  it('rejects cycles and invalid group updates without mutating the prior tree', () => {
    const tasks = patchTasks(
      [],
      patch([
        { id: 'a', title: 'A' },
        { id: 'b', parent: 'a', title: 'B' },
      ]),
      1000,
      20,
    )
    const before = structuredClone(tasks)
    expect(() => patchTasks(tasks, patch([{ id: 'a', parent: 'b', note: 'Move' }]), 2000, 20)).toThrow(
      'cycle',
    )
    expect(() => patchTasks(tasks, patch([{ id: 'a', done: [1, 2], note: 'Estimate' }]), 2000, 20)).toThrow(
      'Keep the group; retry with state changes only on its leaves',
    )
    expect(() =>
      patchTasks(tasks, patch([{ id: 'a', subtree: true, note: 'Superseded' }]), 2000, 20),
    ).toThrow('requires status')
    expect(tasks).toEqual(before)
  })
  it('requires a reason for blocked work and preserves partial progress through recovery', () => {
    const tasks = patchTasks(
      [],
      patch([
        { id: 'release', title: 'Release' },
        { id: 'check', parent: 'release', title: 'Check', status: 'done', timeShare: 1 },
        { id: 'ship', parent: 'release', title: 'Ship', done: [1, 3], timeShare: 3 },
      ]),
      1000,
      20,
    )
    expect(() => patchTasks(tasks, patch([{ id: 'ship', status: 'blocked' }]), 2000, 20)).toThrow('note')
    const blocked = patchTasks(
      tasks,
      patch([{ id: 'ship', status: 'blocked', remaining: null, note: 'Waiting for release access.' }]),
      2000,
      20,
    )
    expect(measureAll(blocked).get(taskId.parse('release'))).toEqual({
      progress: 0.5,
      remaining: null,
      status: 'blocked',
    })
    expect(blocked.find(task => task.id === 'ship')?.done).toEqual([1, 3])
    const resumed = patchTasks(
      blocked,
      patch([{ id: 'ship', status: 'active', remaining: 3, note: 'Release access is available.' }]),
      3000,
      20,
    )
    expect(measureAll(resumed).get(taskId.parse('release'))).toEqual({
      progress: 0.5,
      remaining: 3,
      status: 'active',
    })
  })
  it('updates the raw group status when a former leaf gains children', () => {
    const leaf = patchTasks([], patch([{ id: 'group', title: 'Review', status: 'done' }]), 1000, 20)
    const group = patchTasks(
      leaf,
      patch([{ id: 'child', parent: 'group', title: 'Check', status: 'pending' }]),
      2000,
      20,
    )
    expect(group.find(task => task.id === 'group')?.status).toBe('pending')
    const finished = patchTasks(group, patch([{ id: 'child', status: 'done', note: 'Verified.' }]), 3000, 20)
    expect(finished.find(task => task.id === 'group')?.status).toBe('done')
  })
  it('retires a subtree, permits explicit restoration, and keeps deferred states visible', () => {
    let tasks = patchTasks(
      [],
      patch([
        { id: 'a', title: 'A' },
        { id: 'b', parent: 'a', title: 'B' },
      ]),
      1000,
      20,
    )
    tasks = patchTasks(
      tasks,
      patch([{ id: 'a', status: 'retired', subtree: true, note: 'Superseded' }]),
      2000,
      20,
    )
    expect(tasks.every(task => task.status === 'retired')).toBe(true)
    expect(measureAll(tasks).get(null)).toBeUndefined()
    tasks = patchTasks(tasks, patch([{ id: 'a', status: 'paused', note: 'Resume later' }]), 3000, 20)
    expect(measureAll(tasks).get(null)?.status).toBe('paused')
  })
})
