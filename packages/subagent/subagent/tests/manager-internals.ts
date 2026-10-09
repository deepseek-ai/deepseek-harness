/** Package-private manager state used to place deterministic lifecycle races. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentManager from '../src/manager.ts'

/** Return the service's bound subagent manager. */
export function subagentManager(ctx: Context): SubagentManager {
  const manager = ctx.subagents['manager']
  if (manager === undefined) throw new Error('expected a bound subagent manager')
  return manager
}

/** Read private lifecycle state for deterministic race placement. */
export function managerState(ctx: Context) {
  const manager = subagentManager(ctx)
  return {
    resident: manager['resident'],
    locks: manager['locks'],
    ownerCtx: manager['ownerCtx'],
  }
}

/** Remove only the map entry, leaving its Agent live for collision coverage. */
export function dropActivation(ctx: Context, childId: SessionId): void {
  managerState(ctx).resident.delete(childId)
}
