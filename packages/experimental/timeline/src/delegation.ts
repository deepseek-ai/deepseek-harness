import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeChainOf, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, Scoped } from '@deepseek-ai/dsh-scope'
import type { TimelineStorage } from './storage.ts'

const planningTools = ['timeline_tree', 'timeline_tasks', 'timeline_pull', 'timeline_read', 'timeline_reply']

/**
 * Session ancestry alone also describes user forks; only origin identifies delegated work.
 * @param agent - the agent whose session or role is being checked.
 * @returns whether the agent is a delegated worker.
 */
export function isWorker(agent: Agent | undefined): boolean {
  return agent?.session.header.origin === 'subagent'
}

/** The Timeline installation that owns an agent's planning tools. */
export type OwnsAgent = (agent: Agent) => boolean

/** One Timeline installation and the scope it registered its tools in; undefined is the unscoped context. */
export interface TimelineInstallation {
  readonly scope: ScopeKey | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Collect the Timeline installations that can manage one Agent; the
     * nearest one in the Agent's scope chain owns its planning tools. Each
     * installation answers with its own record.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): an installation in a preset or Agent scope answers only for Agents in that scope.
     * @param installations - receives each answering installation's record.
     * @mode emit
     */
    'timeline/installation'(this: Scoped<Agent>, installations: TimelineInstallation[]): void
  }
}

/**
 * The nearest installation in an Agent's scope chain owns the Agent, so an
 * enclosing installation cannot also manage an Agent under a scoped one. The
 * same Agents see the owner's planning tools under a native root and bind them
 * under a PTC root.
 * @param ctx - context that registered the planning tools.
 * @returns a predicate that checks whether this installation owns an agent.
 */
export function planningOwner(ctx: Context): OwnsAgent {
  const own: TimelineInstallation = { scope: scopeOf(ctx) }
  ctx.on('timeline/installation', (installations) => { installations.push(own) })
  return (agent) => {
    const installations: TimelineInstallation[] = []
    ctx.emit(scopeTarget(agent, agent), 'timeline/installation', installations)
    for (const scope of [...scopeChainOf(agent), undefined]) {
      const nearest = installations.find(installation => installation.scope === scope)
      if (nearest !== undefined) return nearest === own
    }
    return false
  }
}

/**
 * Read loaded ancestry only. IDs are assignment references, never cross-session capabilities.
 * @param ctx - owning plugin context.
 * @param agent - the agent whose session or role is being checked.
 * @param storage - Timeline's session data service.
 * @returns guidance for the delegated worker, or empty text.
 */
export function delegationContext(ctx: Context, agent: Agent, storage: TimelineStorage): string {
  const parent = agent.session.header.parentSession
  if (parent === undefined) return 'Report assigned work to the delegating agent.'
  const seen = new Set([agent.session.id])
  let owner = ctx.sessions.get(parent)
  while (owner?.header.origin === 'subagent') {
    if (seen.has(owner.id)) return `Report assigned work to parent ${parent}.`
    seen.add(owner.id)
    const next = owner.header.parentSession
    owner = next === undefined ? undefined : ctx.sessions.get(next)
  }
  const view = owner === undefined || !storage.available(owner) ? undefined : storage.stateOf(owner).view
  const tree = view?.trees.find(tree => tree.id === view.activeTreeId)
  return `Timeline delegation: parent ${parent}${owner === undefined ? '' : `; plan owner ${owner.id}`}${tree === undefined ? '' : `; current tree ${tree.id}: ${JSON.stringify(tree.title)}`}. These are references, not assignments. Use the tree/task IDs in the latest assignment message; report missing IDs to the parent.`
}

/**
 * Workers report to their parent; only managers can use Timeline's session-local tools.
 * @param ctx - owning plugin context.
 * @param owns - whether this installation owns the agent's planning tools.
 */
export function installDelegation(ctx: Context, owns: OwnsAgent): void {
  const masks = new Map<Agent, () => void>()
  const attach = (agent: Agent) => {
    if (!isWorker(agent) || !owns(agent) || masks.has(agent)) return
    masks.set(agent, agent.ctx.tools.restrict({ deny: planningTools }))
  }
  ctx.on('agent/created', ({ agent }) => {
    attach(agent)
    return undefined
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = masks.get(agent)
    masks.delete(agent)
    dispose?.()
  }, { global: true })
  ctx.effect(
    () => () => {
      for (const dispose of masks.values()) dispose()
      masks.clear()
    },
    'timeline: delegated planning masks',
  )
  // Also deny stale calls and explicit agent-local overrides, which bypass inherited masks.
  ctx.tools.guard(exec =>
    exec.agent !== undefined && isWorker(exec.agent) && owns(exec.agent) && planningTools.includes(exec.name)
      ? {
        reason: 'The delegating agent owns the shared task tree. Report assigned IDs, progress, blockers, and results to your parent instead.',
        info: { name: 'TimelineError', code: 'TIMELINE_TOOL_UNAVAILABLE' },
      }
      : undefined,
  )
  for (const agent of ctx.agents.list()) attach(agent)
}
