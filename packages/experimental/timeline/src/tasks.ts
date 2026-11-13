// Task semantics adapted from DeepSeek Harness (MIT).
import { patchSchema, taskSchema } from './records.ts'
import type { Priority, Task, TaskPatch, TaskRevision } from './records.ts'

/** The four categories shown on a segmented progress bar. */
export const progressStates = ['done', 'active', 'pending', 'blocked'] as const
/** Weighted shares and leaf counts by displayed status. */
export type ProgressParts = Record<
  (typeof progressStates)[number],
  { fraction: number; leaves: number; titles: string[] }
>

/** Weighted completion and an optional Client-only visual breakdown. */
interface Measure {
  progress: number
  remaining: number | null
  status: Task['status']
  parts?: ProgressParts
}

function emptyParts(): ProgressParts {
  return {
    done: { fraction: 0, leaves: 0, titles: [] },
    active: { fraction: 0, leaves: 0, titles: [] },
    pending: { fraction: 0, leaves: 0, titles: [] },
    blocked: { fraction: 0, leaves: 0, titles: [] },
  }
}

function remainderState(status: Task['status']): 'active' | 'pending' | 'blocked' {
  return status === 'active' || status === 'blocked' ? status : 'pending'
}

/**
 * Apply an atomic patch batch; unknown parents, cycles, and invalid groups fail without changing input.
 * @param previous - task records before the edit.
 * @param input - input to validate.
 * @param at - wall clock time associated with the update.
 * @param limit - upper bound on the number of entries.
 * @param source - an edit needs a reason for status changes; a checkpoint already records the status.
 * @returns the updated tasks after the whole batch validates.
 */
export function patchTasks(
  previous: readonly Task[],
  input: readonly TaskPatch[],
  at: number,
  limit: number,
  source: 'edit' | 'checkpoint' = 'edit',
): Task[] {
  const patches = patchSchema.array().min(1).max(limit).parse(input)
  const tasks = new Map(previous.map(task => [task.id, task]))
  const seen = new Set<Task['id']>()
  for (const patch of patches) {
    if (patch.subtree === true && patch.status !== 'retired')
      throw new Error('subtree:true requires status:"retired" and a note to retire the branch')
    if (seen.has(patch.id)) throw new Error(`Duplicate task ${patch.id}`)
    seen.add(patch.id)
    const before = tasks.get(patch.id)
    const done = patch.done ?? before?.done ?? [0, 1]
    if (done[0] > done[1]) throw new Error('Completed units cannot exceed total units')
    const status =
      patch.status ??
      (patch.done === undefined
        ? (before?.status ?? 'pending')
        : done[0] === done[1]
          ? 'done'
          : done[0] > 0
            ? 'active'
            : 'pending')
    if (
      before !== undefined &&
      (patch.status !== undefined ||
        patch.done !== undefined ||
        patch.parent !== undefined ||
        patch.timeShare !== undefined ||
        patch.remaining !== undefined) &&
      !patch.note?.trim()
    )
      throw new Error(`Task ${patch.id} needs a note explaining its change`)
    if (source === 'edit' && ['blocked', 'paused', 'retired'].includes(status) && !patch.note?.trim() && before?.status !== status)
      throw new Error(`Task ${patch.id} needs a reason`)
    if (before?.status === 'retired' && patch.status === undefined)
      throw new Error('Restoring a task needs an explicit status')
    const task = taskSchema.parse({
      id: patch.id,
      parent: patch.parent === undefined ? (before?.parent ?? null) : patch.parent,
      title: patch.title ?? before?.title,
      description: patch.description ?? before?.description ?? '',
      status,
      done: status === 'done' ? [done[1], done[1]] : done,
      timeShare: patch.timeShare ?? before?.timeShare ?? 1,
      remaining:
        status === 'done' ? 0 : patch.remaining === undefined ? (before?.remaining ?? null) : patch.remaining,
      mode: patch.mode ?? before?.mode ?? 'serial',
      note: patch.note ?? before?.note ?? '',
      details: patch.details ?? before?.details ?? '',
      priority: before?.priority ?? null,
      history: before?.history ?? [],
      createdAt: before?.createdAt ?? at,
      updatedAt: at,
    })
    if (status === 'pending' && task.done[0] !== 0)
      throw new Error('Pending tasks cannot have completed units')
    if (status === 'done' && patch.remaining !== undefined && patch.remaining !== 0)
      throw new Error('Done tasks have no remaining work')
    tasks.set(task.id, task)
  }
  if (tasks.size > limit) throw new Error(`At most ${limit} tasks per tree`)
  const parentOf = (id: Task['id']) => {
    const ancestor = tasks.get(id)
    if (ancestor === undefined) throw new Error(`Unknown parent ${id}`)
    return ancestor.parent
  }
  for (const task of tasks.values()) {
    const ancestors = new Set([task.id])
    let parent = task.parent
    while (parent !== null) {
      if (ancestors.has(parent)) throw new Error('Task tree contains a cycle')
      ancestors.add(parent)
      parent = parentOf(parent)
    }
  }
  for (const patch of patches) {
    if (patch.status !== 'retired' || !patch.subtree) continue
    for (const task of tasks.values()) {
      let parent = task.parent
      while (parent !== null) {
        if (parent === patch.id) {
          tasks.set(task.id, { ...task, status: 'retired', updatedAt: at })
          break
        }
        parent = parentOf(parent)
      }
    }
  }
  for (const task of tasks.values()) {
    if (task.status === 'retired') continue
    if (task.parent !== null && tasks.get(task.parent)?.status === 'retired')
      throw new Error('Retire the subtree or move its children')
    const children = [...tasks.values()].filter(
      child => child.parent === task.id && child.status !== 'retired',
    )
    if (children.length === 0) continue
    const patch = patches.find(item => item.id === task.id)
    if (patch?.done !== undefined || patch?.remaining !== undefined || patch?.status !== undefined) {
      throw new Error(
        `Group ${task.id} derives progress and status from children. Keep the group; retry with state changes only on its leaves.`,
      )
    }
    tasks.set(task.id, { ...task, done: [0, 1], remaining: null })
  }
  const result = [...tasks.values()]
  const measures = measureAll(result)
  return result.map((task) => {
    const measure = measures.get(task.id)
    return measure === undefined || measure.status === task.status ? task : { ...task, status: measure.status }
  })
}

/**
 * Capture semantic edits, including derived group progress, in the same durable task write.
 * @param previous - task records before the edit.
 * @param tasks - task records for the addressed tree.
 * @param at - wall clock time associated with the update.
 * @returns the updated tasks with new history for changed entries.
 */
export function recordTaskHistory(previous: readonly Task[], tasks: readonly Task[], at: number): Task[] {
  const before = new Map(previous.map(task => [task.id, task]))
  const oldMeasures = measureAll(previous)
  const measures = measureAll(tasks)
  const snapshot = (
    task: Task,
    measure: Measure | undefined,
  ): Omit<TaskRevision, 'at' | 'previousProgress'> => ({
    parent: task.parent,
    title: task.title,
    description: task.description,
    status: task.status === 'retired' ? 'retired' : (measure?.status ?? task.status),
    progress: measure?.progress ?? task.done[0] / task.done[1],
    done: [...task.done],
    weight: task.timeShare,
    note: task.note,
    details: '',
    priority: task.priority,
  })
  return tasks.map((task) => {
    const old = before.get(task.id)
    const current = snapshot(task, measures.get(task.id))
    const prior = old === undefined ? undefined : snapshot(old, oldMeasures.get(old.id))
    const history = old?.history ?? task.history
    const detailsChanged = task.details !== (old?.details ?? '')
    return {
      ...task,
      history:
        !detailsChanged && JSON.stringify(current) === JSON.stringify(prior)
          ? history
          : [...history, {
            ...current,
            // The full details stay in the task record. Revisions carry only a changed preview.
            details: detailsChanged ? task.details.slice(0, 400) : '',
            at,
            previousProgress: prior?.progress ?? null,
          }],
    }
  })
}

/**
 * User priority applies to a subtree; an explicit child priority overrides its parent.
 * @param tasks - task records for the addressed tree.
 * @returns the effective priority of each task.
 */
export function prioritiesOf(tasks: readonly Task[]): ReadonlyMap<Task['id'], Priority> {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const result = new Map<Task['id'], Priority>()
  const visit = (task: Task): Priority => {
    if (result.has(task.id)) return result.get(task.id) ?? null
    const parent = task.parent === null ? undefined : byId.get(task.parent)
    const priority = task.priority ?? (parent === undefined ? null : visit(parent))
    result.set(task.id, priority)
    return priority
  }
  for (const task of tasks) visit(task)
  return result
}

/**
 * Keep the next-work queue short and exclude completed or deliberately unavailable work.
 * @param trees - the task trees for the current session.
 * @param limit - upper bound on the number of entries.
 * @returns eligible leaves in priority order, up to the limit.
 */
export function prioritizedTasks(trees: readonly { id: string; tasks: readonly Task[] }[], limit = 12): {
  tree: string
  task: Task['id']
  title: string
  priority: NonNullable<Priority>
  status: Task['status']
}[] {
  return trees
    .flatMap((tree) => {
      const priorities = prioritiesOf(tree.tasks)
      const parents = new Set(
        tree.tasks.filter(task => task.status !== 'retired').map(task => task.parent),
      )
      return tree.tasks
        .filter(task => !parents.has(task.id) && (task.status === 'active' || task.status === 'pending'))
        .flatMap((task) => {
          const priority = priorities.get(task.id) ?? null
          return priority === null
            ? []
            : [{ tree: tree.id, task: task.id, title: task.title, priority, status: task.status }]
        })
    })
    .sort((a, b) => a.priority.localeCompare(b.priority))
    .slice(0, limit)
}

/**
 * Measure each leaf and group once, including the virtual root at null.
 * @param tasks - task records for the addressed tree.
 * @param withParts - whether to include the breakdown by status.
 * @returns progress by task, including the virtual root at null.
 */
export function measureAll(
  tasks: readonly Task[],
  withParts = false,
): ReadonlyMap<Task['id'] | null, Measure> {
  const children = new Map<Task['id'] | null, Task[]>()
  for (const task of tasks) {
    if (task.status === 'retired') continue
    const siblings = children.get(task.parent)
    if (siblings === undefined) children.set(task.parent, [task])
    else siblings.push(task)
  }
  const result = new Map<Task['id'] | null, Measure>()
  const visit = (id: Task['id'] | null, mode: Task['mode']): Measure | undefined => {
    const rows = children.get(id)
    if (rows === undefined) return undefined
    const values = rows.map((task) => {
      const value = visit(task.id, task.mode) ?? {
        progress: task.status === 'done' ? 1 : task.done[0] / task.done[1],
        remaining: task.status === 'done' ? 0 : task.remaining,
        status: task.status,
      }
      if (withParts && value.parts === undefined) {
        value.parts = emptyParts()
        value.parts.done.fraction = value.progress
        value.parts[remainderState(value.status)].fraction = 1 - value.progress
        const part = value.parts[value.status === 'done' ? 'done' : remainderState(value.status)]
        part.leaves = 1
        part.titles = [task.title]
      }
      result.set(task.id, value)
      return { task, value }
    })
    const largest = Math.max(...rows.map(task => task.timeShare))
    const total = values.reduce((sum, { task }) => sum + task.timeShare / largest, 0)
    const states = values.map(({ value }) => value.status)
    const status = states.every(state => state === 'done')
      ? 'done'
      : states.includes('active')
        ? 'active'
        : states.includes('blocked')
          ? 'blocked'
          : states.includes('paused')
            ? 'paused'
            : 'pending'
    const durations = values.map(({ value }) => value.remaining ?? 0)
    const value: Measure = {
      progress:
        status === 'done'
          ? 1
          : Math.min(
            0.9999,
            values.reduce(
              (sum, { task, value: item }) => sum + (task.timeShare / largest) * item.progress,
              0,
            ) / total,
          ),
      remaining: values.some(({ value: item }) => item.remaining === null)
        ? null
        : mode === 'parallel'
          ? Math.max(...durations)
          : durations.reduce((sum, duration) => sum + duration, 0),
      status,
    }
    if (withParts) {
      const parts = emptyParts()
      for (const { task, value: item } of values) {
        // Every child is measured with parts when withParts is set.
        // oxlint-disable-next-line typescript/no-non-null-assertion
        const childParts = item.parts!
        for (const state of progressStates) {
          const part = childParts[state]
          parts[state].fraction += (task.timeShare / largest / total) * part.fraction
          parts[state].leaves += part.leaves
          // Six titles suffice for a complete small list or a five-item preview plus ellipsis.
          parts[state].titles.push(...part.titles.slice(0, 6 - parts[state].titles.length))
        }
      }
      // Match the existing completion cap without losing the remaining work's proportions.
      parts.done.fraction = value.progress
      const rest = parts.active.fraction + parts.pending.fraction + parts.blocked.fraction
      for (const state of ['active', 'pending', 'blocked'] as const)
        parts[state].fraction = rest === 0 ? 0 : (parts[state].fraction / rest) * (1 - value.progress)
      if (rest === 0) parts[remainderState(status)].fraction = 1 - value.progress
      value.parts = parts
    }
    result.set(id, value)
    return value
  }
  visit(null, 'serial')
  return result
}
