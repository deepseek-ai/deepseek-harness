/** Package-private manager state used to place deterministic lifecycle races. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRunId, type SubagentResult } from '../src/types.ts'
import type { LocalActivation } from '../src/activation.ts'
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

/** Register an idle fixture Activation without starting a model turn. */
export function bindSubagentActivation(
  ctx: Context, child: Agent, root: Agent, ancestors: readonly SessionId[] = [root.id],
): void {
  const resident = managerState(ctx).resident
  const result = Promise.withResolvers<SubagentResult>()
  void result.promise.catch(() => undefined)
  const activation: LocalActivation = {
    kind: 'local',
    childId: child.id,
    runId: SubagentRunId(`fixture:${child.id}`),
    provider: 'fixture',
    root,
    ancestors,
    path: undefined,
    releaseSlot() {},
    handle: { agent: child, async dispose() {} },
    outputStart: child.session.seq,
    structured: undefined,
    failureAt: undefined,
    poke: Promise.withResolvers(),
    omitClosingText: false,
    delivery: 'caller',
    result,
    closing: undefined,
    accepted: false,
  }
  resident.set(child.id, activation)
  child.ctx.effect(() => () => {
    if (resident.get(child.id) === activation) resident.delete(child.id)
  }, 'fixture: managed Activation')
}
