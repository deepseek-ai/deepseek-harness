/** Team display derived from the shared Session catalog and per-Session projections. */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TeamProjection } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Collect every discovered continuable descendant and the Lead's shared board.
 * @param state - current catalog and Host-computed projections.
 * @param leadSessionId - Team root resolved from the selected conversation.
 * @returns the combined view, or undefined until the Lead projection arrives.
 */
export function teamView(state: SessionListState, leadSessionId: SessionId | undefined): TeamProjection | undefined {
  if (leadSessionId === undefined) return undefined
  const root = state.projectionsBySession[leadSessionId]?.values.agentTeam
  if (root === undefined) return undefined
  const members = [...root.members]
  const seen = new Set(members.map(member => member.id))
  let failure = root.failure
  for (const member of members) {
    if (member.id === leadSessionId || member.phase !== 'active') continue
    const child = state.projectionsBySession[member.id]?.values.agentTeam
    if (child === undefined) continue
    failure ??= child.failure
    for (const descendant of child.members) {
      if (descendant.role === 'lead' || seen.has(descendant.id)) continue
      seen.add(descendant.id)
      members.push(descendant)
    }
  }
  return { ...root, members, ...failure === undefined ? {} : { failure } }
}

/**
 * Compare the immutable Team facts a panel displays, excluding other Sessions.
 * @param left - previous combined view.
 * @param right - newly selected view.
 * @returns whether React can retain the previous selection.
 */
export function sameTeamView(left: TeamProjection | undefined, right: TeamProjection | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.failure === right.failure && left.tasks === right.tasks
    && left.members.length === right.members.length
    && left.members.every((member, index) => member === right.members[index]))
}
