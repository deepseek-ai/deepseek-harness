/** Durable aliases for subagent tools; execution remains owned by subagents. @module */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import { fullNameSchema, nameSchema, subagentNamesProjection } from './projection.ts'
import type { SubagentNamesState } from './projection.ts'

export type { SubagentNameBinding } from './projection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagentNames: SubagentNames
  }
}

/** Stable categories for alias validation and lookup failures. */
export type SubagentNameErrorCode = 'INVALID_AGENT_NAME' | 'DUPLICATE_AGENT_NAME' | 'AGENT_NAME_NOT_FOUND'

/** An alias could not be reserved, bound, or resolved. */
export class SubagentNameError extends HarnessError {
  constructor(message: string, code: SubagentNameErrorCode) {
    super(message, code)
    this.name = 'SubagentNameError'
  }
}

/** A caller-owned name reservation; release it after startup and binding settle. */
export interface SubagentNameReservation {
  readonly name: string
  /** Release the reservation; repeated disposal is harmless. */
  dispose(): void
}

/** Root-Session aliases shared by named creation, discovery, and control tools. */
export class SubagentNames extends Service {
  static inject = ['subagents', 'sessionProjections']

  private projection!: ProjectionHandle<SubagentNamesState>
  private readonly pending = new WeakMap<Agent, Set<string>>()

  constructor(ctx: Context) {
    super(ctx, 'subagentNames')
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(subagentNamesProjection)
    this.ctx.on('subagent/message-name', sender => this.nameOf(sender))
  }

  /**
   * Reserve a complete name without starting an agent or writing a Session event.
   * @param parent - exact live caller whose name prefixes the child name.
   * @param requested - optional sibling segment; omission selects the first free agent-N.
   * @returns a reservation the caller must dispose after startup and binding.
   */
  reserve(parent: Agent, requested?: string): SubagentNameReservation {
    if (requested !== undefined && !nameSchema.safeParse(requested).success) {
      throw new SubagentNameError('agent name must start with a lower-case letter and contain only lower-case letters, digits, underscores, or hyphens', 'INVALID_AGENT_NAME')
    }
    const root = this.ctx.subagents.rootOf(parent)
    const bindings = this.projection.stateOf(root.session).bindings
    const prefix = parent === root ? 'lead'
      : bindings.find(binding => binding.childId === parent.id)?.name ?? `lead/legacy:${parent.id}`
    const pending = this.pending.get(root) ?? new Set<string>()
    this.pending.set(root, pending)
    const occupied = new Set([...bindings.map(binding => binding.name), ...pending])
    let segment = requested
    if (segment === undefined) {
      let ordinal = 1
      while (occupied.has(`${prefix}/agent-${ordinal}`)) ordinal++
      segment = `agent-${ordinal}`
    }
    const name = `${prefix}/${segment}`
    if (occupied.has(name)) throw new SubagentNameError(`agent name "${name}" is already in use; choose another name`, 'DUPLICATE_AGENT_NAME')
    pending.add(name)
    let active = true
    return { name, dispose: () => {
      if (!active) return
      active = false
      pending.delete(name)
    } }
  }

  /**
   * Record an accepted child's full name in the caller's root Session.
   * Binding failure does not cancel or dispose the child; callers report its id.
   * @param parent - exact live caller whose root owns the alias.
   * @param childId - identity returned by the subagent service.
   * @param name - complete name returned by reserve.
   */
  bind(parent: Agent, childId: SessionId, name: string): void {
    if (!fullNameSchema.safeParse(name).success) throw new SubagentNameError('a bound agent name must be a complete lead/... path', 'INVALID_AGENT_NAME')
    const root = this.ctx.subagents.rootOf(parent)
    const bindings = this.projection.stateOf(root.session).bindings
    const existing = bindings.find(binding => binding.childId === childId || binding.name === name)
    if (existing !== undefined) {
      if (existing.childId === childId && existing.name === name) return
      throw new SubagentNameError(`agent name "${name}" or identity ${childId} is already bound`, 'DUPLICATE_AGENT_NAME')
    }
    root.session.append('subagent-name/bound', { version: 1, childId, name })
  }

  /**
   * Read a bound name from the live root's projection without loading ancestors.
   * @param caller - exact live caller selecting the tree.
   * @param targetId - requested identity; omission selects the caller.
   * @returns lead for the root, a bound full name, or the unchanged id.
   */
  nameOf(caller: Agent, targetId: SessionId = caller.id): string {
    const root = this.ctx.subagents.rootOf(caller)
    if (targetId === root.id) return 'lead'
    return this.projection.stateOf(root.session).bindings.find(binding => binding.childId === targetId)?.name ?? targetId
  }

  /**
   * Resolve an alias or pass through an id for the subagent service to authorize.
   * @param caller - exact live caller selecting the root mapping.
   * @param name - lead, a bound full name, or a raw Session id.
   * @returns the target identity; an unknown lead/... name throws.
   */
  resolveName(caller: Agent, name: string): SessionId {
    const root = this.ctx.subagents.rootOf(caller)
    if (name === 'lead') return root.id
    const binding = this.projection.stateOf(root.session).bindings.find(binding => binding.name === name)
    if (binding !== undefined) return binding.childId
    if (name.startsWith('lead/')) throw new SubagentNameError(`agent "${name}" was not found; use list_agents to discover names or ids`, 'AGENT_NAME_NOT_FOUND')
    return SessionId(name)
  }
}

export default SubagentNames
