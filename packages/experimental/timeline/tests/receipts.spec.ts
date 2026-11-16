import { describe, expect, it } from 'vitest'
import { patchSchema, taskId, taskReceiptSchema, treeSchema } from '../src/records.ts'
import { taskReceipt } from '../src/receipts.ts'
import { patchTasks, recordTaskHistory } from '../src/tasks.ts'

const tree = treeSchema.parse({
  id: 'plan',
  title: 'Recover saved work',
  description: '',
  createdAt: 1,
  lastTaskUpdate: 1000,
  tasks: patchTasks(
    [],
    patchSchema.array().parse([
      { id: 'group', title: 'Save and recover' },
      { id: 'save', parent: 'group', title: 'Save changes', done: [1, 2], timeShare: 1 },
      { id: 'restore', parent: 'group', title: 'Recover changes', timeShare: 3 },
    ]),
    1,
    1000,
  ),
})

describe('saved task update receipts', () => {
  it('keeps a receipt usable when a restored task lacks its parent', () => {
    const orphan = tree.tasks.find(task => task.id === 'save')
    if (orphan === undefined) throw new Error('Missing fixture task')
    const previous = { ...tree, tasks: [orphan] }
    const patch = { id: orphan.id, title: 'Verify saved changes' }
    const receipt = taskReceipt(previous, [{ ...orphan, title: patch.title }], [patch], 2000)
    expect(receipt).toMatchObject({
      branch: null,
      tasks: [{ id: orphan.id, title: patch.title, status: 'active', after: 0.5 }],
    })
    expect(recordTaskHistory([], [orphan], 2000)[0]?.history[0]).toMatchObject({
      status: 'active', progress: 0.5, at: 2000,
    })
  })
  it('uses weighted derived progress, the shared parent title, and existing task notes', () => {
    const patches = patchSchema.array().parse([
      { id: 'save', status: 'done', note: 'Changes survive reopening.' },
      { id: 'restore', done: [1, 2], note: 'Saved changes load; backup recovery remains.' },
    ])
    const receipt = taskReceipt(tree, patchTasks(tree.tasks, patches, 361000, 1000), patches, 361000)
    expect(taskReceiptSchema.parse(receipt)).toMatchObject({
      tree: 'plan',
      title: 'Recover saved work',
      branch: 'Save and recover',
      before: 0.125,
      after: 0.625,
      previousAt: 1000,
      at: 361000,
      total: 2,
      tasks: [
        { id: 'save', before: 0.5, after: 1, note: 'Changes survive reopening.', status: 'done' },
        { id: 'restore', before: 0, after: 0.5, status: 'active' },
      ],
    })
  })
  it('ignores timestamp-only edits and preserves a missing first-update baseline', () => {
    const patches = [{ id: taskId.parse('save'), title: 'Save changes' }]
    expect(taskReceipt(tree, patchTasks(tree.tasks, patches, 2000, 1000), patches, 2000)).toBeNull()
    const first = treeSchema.parse({
      id: 'first',
      title: 'New plan',
      description: '',
      createdAt: 1,
      tasks: [],
    })
    const added = [
      { id: taskId.parse('new'), title: 'Check recovery', description: 'Restore the saved plan.' },
    ]
    expect(taskReceipt(first, patchTasks([], added, 2000, 1000), added, 2000)).toMatchObject({
      previousAt: null,
      tasks: [{ note: 'Restore the saved plan.', before: 0, after: 0 }],
    })
  })
  it('bounds previews for a large batch without losing the count or full progress calculation', () => {
    const first = treeSchema.parse({
      id: 'first',
      title: 'Large plan',
      description: '',
      createdAt: 1,
      tasks: [],
    })
    const patches = Array.from({ length: 500 }, (_, i) => ({
      id: taskId.parse(`task-${i}`),
      title: `Verify item ${i}`,
      status: 'done' as const,
    }))
    const tasks = patchTasks([], patches, 2000, 1000)
    const receipt = taskReceipt(first, tasks, patches, 2000)
    expect(taskReceiptSchema.parse(receipt)).toMatchObject({ total: 500, before: 0, after: 1 })
    expect(receipt?.tasks).toHaveLength(6)
    expect(JSON.stringify(receipt).length).toBeLessThan(2000)
    const firstTask = tasks[0]
    if (firstTask === undefined) throw new Error('Missing fixture task')
    firstTask.note = 'A later note does not change the recorded card.'
    expect(receipt?.tasks[0]?.note).toBe('')
  })
  it('records decreases and subtree retirement without repeating unedited derived groups', () => {
    const patches = patchSchema
      .array()
      .parse([{ id: 'save', done: [0, 2], note: 'Reopen the failed save check.' }])
    const decreased = taskReceipt(tree, patchTasks(tree.tasks, patches, 2000, 1000), patches, 2000)
    expect(decreased).toMatchObject({
      before: 0.125,
      after: 0,
      total: 1,
      tasks: [{ id: 'save', before: 0.5, after: 0 }],
    })
    const retired = patchSchema
      .array()
      .parse([{ id: 'group', status: 'retired', subtree: true, note: 'This goal is no longer needed.' }])
    expect(
      taskReceipt(tree, patchTasks(tree.tasks, retired, 3000, 1000), retired, 3000)?.tasks.map(
        task => task.status,
      ),
    ).toEqual(['retired', 'retired', 'retired'])
  })
})
