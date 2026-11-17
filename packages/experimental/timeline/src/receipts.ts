import type { Task, TaskPatch, TaskReceipt, Tree } from './records.ts'
import { measureAll } from './tasks.ts'

/**
 * Snapshot one semantic task batch without reading conversation history or model output.
 * @param tree - the task tree before the change.
 * @param tasks - task records for the addressed tree.
 * @param patches - the task edits sent in the batch.
 * @param at - wall clock time associated with the update.
 * @returns the changes for a progress card, or null for a no-op.
 */
export function taskReceipt(
  tree: Tree,
  tasks: readonly Task[],
  patches: readonly TaskPatch[],
  at: number,
): TaskReceipt | null {
  const before = new Map(tree.tasks.map(task => [task.id, task]))
  const edited = new Set(patches.map(patch => patch.id))
  const fields = [
    'parent',
    'title',
    'description',
    'status',
    'done',
    'timeShare',
    'remaining',
    'mode',
    'note',
    'details',
  ] as const
  const changes = tasks.filter((task) => {
    const previous = before.get(task.id)
    if (!edited.has(task.id) && !(task.status === 'retired' && previous?.status !== 'retired')) return false
    return (
      previous === undefined ||
      fields.some(field => JSON.stringify(task[field]) !== JSON.stringify(previous[field]))
    )
  })
  if (changes.length === 0) return null
  const oldMeasures = measureAll(tree.tasks)
  const measures = measureAll(tasks)
  const parent = changes[0]?.parent
  return {
    version: 1,
    tree: tree.id,
    title: tree.title,
    branch:
      parent != null && changes.every(task => task.parent === parent)
        ? (tasks.find(task => task.id === parent)?.title ?? null)
        : null,
    at,
    previousAt: tree.lastTaskUpdate ?? null,
    before: oldMeasures.get(null)?.progress ?? 0,
    after: measures.get(null)?.progress ?? 0,
    total: changes.length,
    tasks: changes.slice(0, 6).map(task => ({
      id: task.id,
      title: task.title,
      note: task.note || task.description,
      status: task.status === 'retired' ? 'retired' : (measures.get(task.id)?.status ?? task.status),
      before: oldMeasures.get(task.id)?.progress ?? 0,
      after: measures.get(task.id)?.progress ?? task.done[0] / task.done[1],
    })),
  }
}
