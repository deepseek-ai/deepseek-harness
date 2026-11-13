import type { Annotation, ControlTarget, Task, Tree } from './records.ts'

/** An elapsed wait permits an explicit retry; it never proves success or failure. */
export const CONTROL_WAIT_MS = 2 * 60000

function sameControlTarget(left: Annotation['target'], right: Annotation['target']): boolean {
  return (
    left.kind === right.kind &&
    left.kind !== 'report' &&
    right.kind !== 'report' &&
    left.tree === right.tree &&
    (left.kind !== 'task' || (right.kind === 'task' && left.task === right.task))
  )
}

/**
 * Find the latest request for the exact tree or task.
 * @param annotations - saved notes and work requests.
 * @param target - addressed tree or task.
 * @returns the most recent matching note, if one exists.
 */
export function latestControl(
  annotations: readonly Annotation[],
  target: ControlTarget,
): Annotation | undefined {
  return annotations.findLast(item => item.control !== undefined && sameControlTarget(item.target, target))
}

/**
 * Check whether two requests affect any shared branch.
 * @param left - first request target.
 * @param right - second request target.
 * @param trees - the task trees for the current session.
 * @returns whether the targets affect shared work.
 */
export function controlTargetsOverlap(
  left: Annotation['target'],
  right: Annotation['target'],
  trees: readonly Tree[],
): boolean {
  if (left.kind === 'report' || right.kind === 'report' || left.tree !== right.tree) return false
  if (left.kind === 'tree' || right.kind === 'tree') return true
  const tree = trees.find(tree => tree.id === left.tree)
  const contains = (parent: Task['id'], child: Task['id']) => {
    const seen = new Set<Task['id']>()
    let id: Task['id'] | null = child
    while (id !== null && !seen.has(id)) {
      if (id === parent) return true
      seen.add(id)
      id = tree?.tasks.find(task => task.id === id)?.parent ?? null
    }
    return false
  }
  return contains(left.task, right.task) || contains(right.task, left.task)
}

/**
 * Find a request that is still within its confirmation period.
 * @param annotations - saved notes and work requests.
 * @param target - addressed tree or task.
 * @param trees - the task trees for the current session.
 * @param now - current wall clock time in milliseconds.
 * @returns the newest matching request awaiting confirmation.
 */
export function pendingControl(
  annotations: readonly Annotation[],
  target: ControlTarget,
  trees: readonly Tree[],
  now: number,
): Annotation | undefined {
  return annotations.findLast(
    item =>
      item.control?.outcome === null &&
      now - item.createdAt < CONTROL_WAIT_MS &&
      controlTargetsOverlap(item.target, target, trees),
  )
}

/** Derive the addressed leaves rather than treating an aggregate paused label as a stopped subtree. */
function scopedLeaves(tree: Tree, target: ControlTarget): Task[] | undefined {
  if (
    target.kind === 'task' &&
    !tree.tasks.some(task => task.id === target.task && task.status !== 'retired')
  )
    return
  const ids = new Set<Task['id']>()
  if (target.kind === 'task') ids.add(target.task)
  for (let size = -1; size !== ids.size; ) {
    size = ids.size
    for (const task of tree.tasks) if (task.parent !== null && ids.has(task.parent)) ids.add(task.id)
  }
  const parents = new Set(tree.tasks.filter(task => task.status !== 'retired').map(task => task.parent))
  return tree.tasks.filter(
    task =>
      task.status !== 'retired' && !parents.has(task.id) && (target.kind === 'tree' || ids.has(task.id)),
  )
}

/**
 * A receipt confirms recorded plan state, never the absence of external side effects.
 * @param annotation - the saved discussion or work request.
 * @param trees - the task trees for the current session.
 * @param at - wall clock time associated with the update.
 * @returns the original or updated note with its observed outcome.
 */
export function reconcileControl(annotation: Annotation, trees: readonly Tree[], at: number): Annotation {
  const { control, target } = annotation
  if (
    control === undefined ||
    target.kind === 'report' ||
    (control.outcome !== null && control.outcome.status !== 'answered')
  )
    return annotation
  const tree = trees.find(tree => tree.id === target.tree)
  const leaves = tree === undefined ? undefined : scopedLeaves(tree, target)
  const unfinished = leaves?.filter(task => task.status !== 'done')
  const status =
    leaves === undefined || leaves.length === 0
      ? 'unavailable'
      : unfinished?.length === 0
        ? 'completed'
        : control.action === 'pause'
          ? unfinished?.every(task => task.status === 'paused' || task.status === 'blocked')
            ? 'applied'
            : null
          : unfinished?.some(task => task.status === 'active')
            ? 'applied'
            : null
  if (status === null) return annotation
  return {
    ...annotation,
    control: { ...control, outcome: { status, at: Math.max(annotation.createdAt, at) } },
  }
}
