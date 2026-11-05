/** Pure task-view derivation shared by the task board and the client projection. */

import type { TeamState } from './projection.ts'
import type { TeamTaskSnapshot, TeamTaskView } from './types.ts'

/**
 * Whether two normalized file or directory prefixes overlap on path components.
 * @param left - normalized write scope.
 * @param right - normalized write scope.
 * @returns whether either scope contains the other.
 */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * Whether every current blocker of one task completed.
 * @param state - Team state supplying sibling tasks.
 * @param task - durable task snapshot to test.
 * @returns whether the task has no incomplete blockers.
 */
export function taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
  return task.blockedBy.every(id => state.tasks.find(candidate => candidate.id === id)?.status === 'completed')
}

/**
 * Derive one task view with saved owner identity, readiness, and advisory write overlaps.
 * A committing caller may pass its pre-append state because `task` supplies the
 * new value explicitly; blocker readiness, and other task scopes
 * do not change when that snapshot is appended.
 * @param state - Team state supplying sibling tasks for readiness and overlap checks.
 * @param task - durable task snapshot to view.
 * @returns a detached task view.
 */
export function projectTaskView(state: TeamState, task: TeamTaskSnapshot): TeamTaskView {
  const warnings = new Set<string>()
  for (const other of state.tasks) {
    if (other.id === task.id || other.status !== 'in_progress') continue
    if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
      warnings.add(`write scopes overlap with ${other.id}`)
    }
  }
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ...task.ownerId === undefined ? {} : { ownerId: task.ownerId },
    ...task.ownerName === undefined ? {} : { ownerName: task.ownerName },
    ready: task.status === 'pending' && taskReady(state, task),
    writeScopeWarnings: [...warnings],
  }
}
