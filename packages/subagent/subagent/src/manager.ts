/**
 * Owns subagent startup, message admission, cold resume, and execution lifetimes.
 * One child lock orders input acceptance and closure; one activation map owns
 * capacity, parent relationships, and resource release across all providers.
 *
 * @module @deepseek-ai/dsh-subagent/manager
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId, contentHasImage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { ToolRestriction, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  appendDelegatedPolicyOverrides, applyChildComposition, captureDelegatedPolicyOverrides,
  childSessionMeta, resolveChildAgentOptions, resolveChildDepth,
} from './child-agent.ts'
import type { DelegatedPolicyOverrides } from './child-agent.ts'
import { createAgentMessage, withContinuableReturnGuidance, createSettlementMessage } from './continuation-messages.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { foldSubagentDescriptor, snapshotSubagentDescriptor } from './descriptor.ts'
import type { SubagentDescriptorData } from './descriptor.ts'
import { establishCatalogChild, establishExternalCatalogChild } from './catalog.ts'
import { SubagentError } from './error.ts'
import { isAdjacentAgentSendMessageTool } from './internal.ts'
import type { ActivationObserver } from './lifecycle.ts'
import type {
  ContinuableCreateRequest, ContinuableCreateSpec, SubagentInterruptAuthority,
  SubagentActivationSpec, SubagentActivation, SubagentStartRequest, SubagentRun,
  SubagentSendMessageOptions, SubagentResult, ResolvedSubagentStartRequest,
} from './types.ts'
import { attachStructuredRuntime } from './structured.ts'
import type { StructuredAttachment } from './structured.ts'
import type { SubagentDelivery } from './control-types.ts'
import { ActivationPool, ChildLock, activationAgent, captureLocalResult, observeLocalFailure, requireLocalActivation } from './activation.ts'
import type { Activation, ActivationResource, LocalActivation } from './activation.ts'

/** Inputs shared by model steering and human prompt delivery. */
type ChildDeliveryOptions =
  | {
    readonly delivery: 'steer'
    /**
     * A provided host source is preserved on the user message; omission attributes
     * an adjacent-Agent message to the parent.
     */
    readonly source?: MessageSource
    readonly signal: AbortSignal
  }
  | { readonly delivery: 'queue'; readonly source: MessageSource; readonly signal: AbortSignal }

/** Package-private hooks supplied by the owning service. */
interface SubagentHost {
  startExternal(name: string, request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  /** Resolve one provider's detached continuable-creation contribution. */
  prepareContinuable(name: string, request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
  /** Build the lifecycle observer for one Activation residency epoch. */
  observeActivation(provider: string, childId: SessionId, parent: Agent): ActivationObserver
}

/** Inputs shared by fresh and resumed Activation materialization. */
interface MaterializeBase {
  childId: SessionId
  provider: string
  parent: Agent
  signal: AbortSignal
  delivery?: 'parent' | 'caller' | undefined
}

/** Creation inputs for a local residency or one external backend execution. */
type MaterializeInputs = MaterializeBase & (
  | {
    kind: 'local'
    /**
     * Creation inputs; absent for a cold resume, which loads the persisted
     * session — including the delegation policy events a fresh creation seeded,
     * so a resume never re-captures the parent's policy.
     */
    create?: {
      /** Absolute initial directory captured before provider preparation. */
      cwd: string
      seed: readonly SessionEvent[] | undefined
      meta: NonNullable<CreateAgentOptions['meta']>
      /** Exact parent-log prefix length inside {@link seed}. */
      inheritedEventCount: SessionLogOffset
      /** Policy captured at delegation: the parent's sandbox override plus the approval pin. */
      delegatedPolicies: DelegatedPolicyOverrides
      /** Child-owned composition record appended after the inherited marker. */
      descriptor: SubagentDescriptorData
    }
    agentOptions: AgentOptions
    composition: { persona?: string | undefined; toolFilter?: ToolRestriction | undefined }
    outputSchema?: ObjectJsonSchema | undefined
  }
  | { kind: 'external'; start: (signal: AbortSignal) => Promise<SubagentRun> }
)

/**
 * One admitted materialization and the exact live ancestry observed at its
 * synchronous admission point. Retaining identities lets a scoped teardown
 * keep waiting even if an intermediate Agent leaves the registry meanwhile.
 */
interface Materialization {
  readonly lineage: readonly Agent[]
  readonly settled: Promise<void>
  readonly controller: AbortController
}

/** Residency state observed by the natural-settlement watcher. */
type SettlementState = 'closed' | 'retry' | 'wait' | 'ready'

/** Result of the final child-lock settlement decision. */
type SettlementAttempt =
  | Exclude<SettlementState, 'ready'>
  | { readonly done: Promise<void> }

/** Render only the safe outer message from execution or teardown failures. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown teardown failure'
}

/** Own subagent requests and the resources of every live activation. */
export class SubagentManager {
  /** Child session id → its live Activation. Process-local, never durable. */
  private readonly resident = new Map<SessionId, Activation>()
  /** Root identities retain their pool across child settlement without retaining dead roots. */
  private readonly rootPools = new WeakMap<Agent, ActivationPool>()
  /** Materializations admitted before drain, tracked through publication or rollback. */
  private readonly materializations = new Set<Materialization>()
  /** Per-child serializer shared by delivery, release, and disposal. */
  private readonly locks = new ChildLock()
  /** Structural Cordis owner of every Activation handle. */
  private readonly ownerCtx: Context
  /**
   * Exact roots whose host teardown has begun, with the live lineage members
   * observed under each root. Entries remain until that exact root leaves the
   * Agent registry, closing admission throughout its host's teardown without
   * poisoning a later same-id replacement.
   */
  private readonly closingScopes = new Map<Agent, Set<Agent>>()
  private draining = false

  /**
   * Build one manager inside the service's Agent-injected context.
   * @param ctx - context providing Agents, Sessions, and teardown ownership.
   * @param host - provider dispatch and lifecycle observation owned by the service.
   * @param maxActiveSubagents - the current configured child capacity.
   */
  constructor(
    private readonly ctx: Context,
    private readonly host: SubagentHost,
    private readonly maxActiveSubagents: () => number,
  ) {
    // Ordinary Cordis owner effects unwind in reverse registration order, which
    // cannot express the dynamic child graph. Register the private scope's
    // structural disposer FIRST and the drain SECOND, so reverse unwind invokes
    // the drain before releasing the scope; a cleanup effect on the same scope
    // as the Agent handles would let structural handle disposal bypass
    // child-first ordering.
    const scope = ctx.plugin(function activationOwner() {})
    this.ownerCtx = scope.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.closingScopes.delete(agent)
    })
    ctx.effect(function* (this: SubagentManager) {
      yield scope.dispose
      yield () => this.drain()
    }.bind(this), 'subagents.manager()')
  }

  /**
   * Interrupt one live continuable child's current turn under the supplied authority.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live ancestor Agent.
   */
  interrupt(
    targetSessionId: SessionId,
    authority: SubagentInterruptAuthority,
  ): void {
    if (authority.kind === 'ancestor') {
      const caller = authority.agent
      if (this.ctx.agents.get(caller.id) !== caller) {
        throw new SubagentError(
          `interrupting "${targetSessionId}" requires the exact live ancestor agent`,
          'UNAUTHORIZED',
        )
      }
      if (caller.id === targetSessionId) {
        throw new SubagentError(
          `agent "${caller.id}" cannot interrupt itself`,
          'UNAUTHORIZED',
        )
      }
    }
    const activation = this.resident.get(targetSessionId)
    if (activation === undefined) return
    if (authority.kind === 'user') {
      if (activation.parent.id !== authority.parentSessionId) {
        throw new SubagentError(
          `subagent "${targetSessionId}" belongs to another parent session`,
          'UNAUTHORIZED',
        )
      }
    } else if (!activation.ancestry.has(authority.agent)) {
      throw new SubagentError(
        `subagent "${targetSessionId}" is not a live descendant of agent "${authority.agent.id}"`,
        'UNAUTHORIZED',
      )
    }
    // Disposal already stopped the target with a whole-Activation teardown;
    // a second cancel would be a redundant signal on a closing handle.
    if (activation.closing !== undefined) return
    const kind = authority.kind === 'user' ? 'user' : 'parent'
    if (activation.kind === 'local') {
      activation.handle.agent.cancel({ kind }, { keepInbox: true })
    } else {
      activation.controller.abort({ kind })
      // The settlement observer reports teardown failures.
      void this.dispose(activation).catch(() => undefined)
    }
  }

  /**
   * Close admission, await every already-admitted materialization through
   * publication or rollback, then dispose the stable live Activation graph
   * child-first.
   */
  async drain(): Promise<void> {
    this.draining = true
    for (const pending of this.materializations) pending.controller.abort()
    await Promise.all([...this.materializations].map(materialization => materialization.settled))
    const owned = new Set<SessionId>()
    for (const activation of this.resident.values()) {
      for (const child of activation.ownedChildren) owned.add(child)
    }
    const roots = [...this.resident.values()].filter(activation => !owned.has(activation.childId))
    await this.disposeRoots(roots, 'activation(s)')
  }

  /**
   * Join progressing child work, leaving idle parked inboxes resident.
   * @param parent - exact live parent whose descendants are observed.
   * @returns whether work was joined and the host must recheck parent completion.
   */
  async waitForChildren(parent: Agent): Promise<boolean> {
    let observed = false
    while (true) {
      const pending = [...this.materializations].filter(item => item.lineage.includes(parent))
      const children = [...this.resident.values()].filter(item => activationAgent(item) !== parent && item.ancestry.has(parent))
      observed ||= children.some(item => item.kind === 'local' && item.handle.agent.status !== 'idle')
      await Promise.all(children.flatMap(item => item.kind === 'local' ? [item.handle.agent.whenIdle()] : []))
      const waits: Promise<unknown>[] = pending.map(item => item.settled)
      for (const item of children) {
        if (item.kind === 'external' || item.closing !== undefined) {
          waits.push(item.result.promise.catch(() => undefined))
          continue
        }
        if (item.handle.agent.status !== 'idle') {
          waits.push(item.handle.agent.whenIdle())
          continue
        }
        if (item.ownedChildren.size > 0) {
          // Published descendants are observed separately; preparation holds
          // keep the owner pending until publication or rollback wakes it.
          if ([...item.ownedChildren].some(id => !this.resident.has(id))) waits.push(item.poke.promise)
          continue
        }
        const inbox = item.handle.agent.inbox
        if (item.failureAt === undefined && (inbox.nextTurn.length > 0 || inbox.nextStep.length > 0)) continue
        waits.push(Promise.race([item.result.promise.catch(() => undefined), item.poke.promise]))
      }
      if (waits.length > 0) {
        observed = true
        await Promise.all(waits)
        continue
      }
      // A descendant can be published while whenIdle follows another child.
      if ([...this.materializations].some(item => item.lineage.includes(parent) && !pending.includes(item))
        || [...this.resident.values()].some(item => activationAgent(item) !== parent
          && item.ancestry.has(parent) && !children.includes(item))) continue
      return observed
    }
  }

  /**
   * Stop the managed descendants of exact live host-owned parents.
   * @param parents - exact live roots whose managed descendants must stop.
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    const roots = new Set(parents.filter(parent => this.ctx.agents.get(parent.id) === parent))
    if (roots.size === 0) return

    for (const root of roots) {
      this.closingMembers(root).add(root)
    }

    const targets: Activation[] = []
    for (const activation of this.resident.values()) {
      const child = activationAgent(activation)
      const lineage = this.liveLineage(child ?? activation.parent)
      const owners = [...roots].filter(root => child !== root
        && activation.ancestry.has(root))
      if (owners.length === 0) continue
      targets.push(activation)
      for (const owner of owners) {
        const members = this.closingMembers(owner)
        if (child !== undefined) members.add(child)
        for (const agent of lineage) members.add(agent)
      }
    }
    const materializations = [...this.materializations].filter((materialization) => {
      const owners = [...roots].filter(root => materialization.lineage.includes(root))
      for (const owner of owners) {
        const members = this.closingMembers(owner)
        for (const agent of materialization.lineage) members.add(agent)
      }
      if (owners.length > 0) materialization.controller.abort()
      return owners.length > 0
    })

    const ownedTargets = new Set<SessionId>()
    for (const activation of targets) {
      for (const child of activation.ownedChildren) ownedTargets.add(child)
    }
    const targetRoots = targets.filter(activation => !ownedTargets.has(activation.childId))

    for (const activation of targets) {
      const disposal = this.dispose(activation)
      void disposal.catch(() => undefined)
    }

    await Promise.all(materializations.map(materialization => materialization.settled))
    await this.disposeRoots(targetRoots, 'scoped activation(s)')
  }

  /**
   * Release selected resident direct children of one exact live parent.
   * @param parent - exact live direct parent authorizing the selected release.
   * @param childIds - durable direct-child ids to release when resident.
   */
  async drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    if (this.ctx.agents.get(parent.id) !== parent) {
      throw new SubagentError('selected child teardown requires the exact live parent agent', 'UNAUTHORIZED')
    }
    const targets: Activation[] = []
    for (const childId of new Set(childIds)) {
      const activation = this.resident.get(childId)
      if (activation === undefined) continue
      if (activation.parent.id !== parent.id || !activation.ancestry.has(parent)) {
        throw new SubagentError(
          `subagent "${childId}" is not a direct child of agent "${parent.id}"`,
          'UNAUTHORIZED',
        )
      }
      targets.push(activation)
    }

    for (const activation of targets) {
      const disposal = this.dispose(activation)
      void disposal.catch(() => undefined)
    }
    await this.disposeRoots(targets, 'selected activation(s)')
  }

  /**
   * Start one continuable background child and resolve at initial inbox acceptance.
   * Every earlier failure disposes any created handle and rolls back Activation
   * and parent ownership without returning either id.
   * @param spec - provider, delegation request, and caller cancellation.
   * @returns the durable child id and accepted initial prompt message id.
   */
  async startLocal(spec: SubagentActivationSpec): Promise<SubagentActivation & { messageId: MessageId }> {
    const request = spec.request
    const parent = request.parent
    this.assertAdmitting(parent)
    const persistence = spec.delivery === 'caller' ? this.ctx.get('sessionPersistence') : this.requirePersistence()
    assertSubagentMaxDepth(request.maxDepth)
    const childId = spec.childId ?? brandString<SessionId>(randomUUID())
    this.assertChildIdAvailable(childId)
    const childDepth = resolveChildDepth(parent, request.maxDepth)
    // Snapshot before any await: invalid descriptor JSON rejects the call
    // before a child exists, and the detached value is what reaches the log.
    const agentOptions = resolveChildAgentOptions(parent, request.agentOptions, childDepth)
    const agentProvider = agentOptions.provider
    const agentModel = agentOptions.model
    const agentReasoningEffort = agentOptions.reasoningEffort
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: spec.provider,
      label: spec.label,
      ...agentProvider !== undefined ? { agentProvider } : {},
      ...agentModel !== undefined ? { agentModel } : {},
      ...agentReasoningEffort !== undefined ? { agentReasoningEffort } : {},
      ...request.persona !== undefined ? { persona: request.persona } : {},
      ...request.toolFilter !== undefined ? { toolFilter: request.toolFilter } : {},
    })
    // Capture before the first await: a later parent switch belongs to the
    // parent's future, not to this child.
    const delegatedPolicies = captureDelegatedPolicyOverrides(parent)

    // An idle continuation-managed parent must not settle while a caller is
    // still creating its child. A turn-scoped delegation does not need this,
    // but the service is also callable outside a turn.
    const releaseHold = this.holdOwnership(parent, childId)
    try {
      const cwd = await this.resolveDirectory(request, spec.signal)
      const prepared = await this.host.prepareContinuable(spec.provider, {
        sessionId: childId,
        cwd,
        parent,
        signal: spec.signal,
      })
      spec.signal.throwIfAborted()
      this.assertAdmitting(parent)

      const inheritedEventCount = SessionLogOffset(prepared.seed?.length ?? 0)
      const seed = prepared.seed
      let established!: Activation
      const messageId = await this.locks.run(childId, async () => {
        spec.signal.throwIfAborted()
        this.assertAdmitting(parent)
        this.assertChildIdAvailable(childId)
        if (spec.childId !== undefined) {
          const persisted = await persistence?.stat(childId, { signal: spec.signal })
          spec.signal.throwIfAborted()
          this.assertAdmitting(parent)
          this.assertChildIdAvailable(childId)
          if (persisted !== undefined) {
            throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD')
          }
        }
        const activation = await this.materialize({
          kind: 'local',
          childId,
          provider: spec.provider,
          parent,
          create: {
            cwd,
            seed,
            meta: childSessionMeta(parent, childDepth, prepared.seed !== undefined),
            inheritedEventCount,
            delegatedPolicies,
            descriptor,
          },
          agentOptions,
          composition: { persona: request.persona, toolFilter: request.toolFilter },
          signal: spec.signal,
          delivery: spec.delivery,
          outputSchema: spec.request.outputSchema,
        })
        established = activation
        const child = requireLocalActivation(activation).handle.agent
        const childHeader = child.session.header
        return await this.submitMaterialized(
          activation,
          spec.delivery !== 'caller' && isAdjacentAgentSendMessageTool(this.ctx.get('tools')?.get('send_message', child))
            ? withContinuableReturnGuidance(parent.id, request.prompt)
            : request.prompt,
          { source: { kind: 'user' }, signal: spec.signal, delivery: 'queue' },
          parent,
          () => {
            establishCatalogChild(parent.session, childHeader, descriptor)
          },
        )
      })
      return { ...this.receipt(established), childId, messageId }
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /**
   * Start an external backend under activation ownership.
   * @param spec - task, provider, cancellation, and delivery policy.
   * @returns the accepted activation and its result/disposal capabilities.
   */
  async startExternal(spec: SubagentActivationSpec): Promise<SubagentActivation> {
    const parent = spec.request.parent
    this.assertAdmitting(parent)
    const pendingId = brandString<SessionId>(randomUUID())
    const releaseHold = this.holdOwnership(parent, pendingId)
    let activation: Activation | undefined
    try {
      const cwd = await this.resolveDirectory(spec.request, spec.signal)
      activation = await this.materialize({
        kind: 'external',
        childId: pendingId,
        provider: spec.provider,
        parent,
        signal: spec.signal,
        delivery: spec.delivery,
        start: signal => this.host.startExternal(spec.provider, {
          ...spec.request, cwd, label: spec.label, signal,
        }),
      })
      this.assertAdmitting(parent)
      this.assertLiveParent(parent, activation.childId)
      spec.signal.throwIfAborted()
      if (spec.delivery === 'parent') {
        establishExternalCatalogChild(parent.session, activation.childId, spec.label)
      }
      this.announce(activation)
      return this.receipt(activation)
    } catch (error: unknown) {
      if (activation !== undefined) {
        try {
          await this.dispose(activation)
        } catch (cleanupError: unknown) {
          this.ctx.logger.warn(`subagent "${activation.childId}" admission rollback failed: ${failureMessage(cleanupError)}`)
        }
      }
      throw error
    } finally {
      releaseHold()
    }
  }

  /** Capture the explicit or inherited directory while the parent still owns startup. */
  private async resolveDirectory(request: Pick<SubagentStartRequest, 'parent' | 'cwd'>, signal: AbortSignal): Promise<string> {
    const cwd = request.cwd !== undefined && isAbsolute(request.cwd)
      ? request.cwd
      : resolve(await this.ctx.workingDirectory.ensure(request.parent, signal), request.cwd ?? '.')
    signal.throwIfAborted()
    return cwd
  }

  /**
   * Deliver one model-authored message to a direct continuable child or to the
   * sender's direct parent. A missing direct child cold-resumes through the
   * ordinary continuation lifecycle.
   * @param sender - exact live Agent authorizing and originating the message.
   * @param targetId - durable direct-parent or direct-child session id.
   * @param content - model-authored content to deliver.
   * @param options - caller cancellation before acceptance.
   * @returns the accepted message's inbox id.
   */
  async sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: SubagentSendMessageOptions,
  ): Promise<MessageId> {
    if (this.ctx.agents.get(sender.id) !== sender) {
      throw new SubagentError(
        'message delivery requires the exact live sender agent',
        'UNAUTHORIZED',
      )
    }
    this.assertAdmitting(sender)
    const senderActivation = this.resident.get(sender.id)
    if (senderActivation !== undefined
      && senderActivation.kind === 'local'
      && senderActivation.handle.agent === sender
      && senderActivation.parent.id === targetId) {
      options.signal.throwIfAborted()
      return this.sendToParent(senderActivation, sender, content)
    }
    if (sender.session.header.parentSession === targetId) {
      throw new SubagentError(
        `agent "${sender.id}" is not a resident continuable child and cannot send to parent "${targetId}"`,
        'UNAUTHORIZED',
      )
    }
    return this.deliverToChild(sender, targetId, content, {
      signal: options.signal,
      delivery: 'steer',
    })
  }

  /**
   * Queue one human-authored prompt as a distinct direct-child turn.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution for the human prompt.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted durable message id.
   */
  async queuePrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return this.deliverToChild(parent, childId, content, { source, signal, delivery: 'queue' })
  }

  /**
   * Steer one host-authored prompt to a direct continuable child.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution for the host prompt.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted durable message id.
   */
  async steerPrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return this.deliverToChild(parent, childId, content, { source, signal, delivery: 'steer' })
  }

  /** Admit local input synchronously before any teardown can begin. */
  private deliver(activation: Activation, message: UserMessage, delivery: SubagentDelivery): void {
    if (activation.closing !== undefined) {
      throw new SubagentError(
        'subagent activation is being disposed; the message was not accepted',
        'ACTIVATION_CLOSING',
      )
    }
    const local = requireLocalActivation(activation)
    if (local.structured?.acceptsInput() === false) {
      throw new SubagentError('subagent is submitting or has submitted its structured result; the message was not accepted', 'INPUT_CLOSED')
    }
    if (delivery === 'steer') local.handle.agent.steer(message)
    else local.handle.agent.followup(message)
  }

  /**
   * Reject one child identity already owned by a live Agent or Session.
   * @param childId - proposed durable child session id.
   */
  private assertChildIdAvailable(childId: SessionId): void {
    if (this.resident.has(childId) || this.ctx.agents.get(childId) !== undefined || this.ctx.get('sessions')?.get(childId) !== undefined) {
      throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD')
    }
  }

  /**
   * Pre-register `childId` in a continuation-managed parent's owned set so the
   * parent cannot settle while a caller is still establishing or resuming that
   * child. Returns a releaser for the failure path; it removes only a hold
   * this call added, and leaves ownership in place once a live Activation for
   * the child exists.
   * @param parent - the live direct parent the operation is admitted under.
   * @param childId - the durable child the operation addresses.
   * @returns the failure-path releaser; a no-op when nothing was added.
   */
  private holdOwnership(parent: Agent, childId: SessionId): () => void {
    const parentActivation = this.resident.get(parent.id)
    if (parentActivation === undefined || activationAgent(parentActivation) !== parent) return () => {}
    if (parentActivation.closing !== undefined) {
      throw new SubagentError(
        `subagent parent "${parent.id}" is being disposed; the child was not established`,
        'ACTIVATION_CLOSING',
      )
    }
    if (parentActivation.ownedChildren.has(childId)) return () => {}
    parentActivation.ownedChildren.add(childId)
    return () => {
      const live = this.resident.get(childId)
      /* v8 ignore next 4 -- reaching this arm needs another delivery to establish the child
       * between this operation's failure and its releaser running, which no test can schedule
       * deterministically: the ownership edge then belongs to that live Activation, so the
       * conservative keep leaves it for finishDisposal's releaseOwnership. */
      if (live !== undefined && live.closing === undefined) return
      if (parentActivation.ownedChildren.delete(childId)) this.wake(parentActivation)
    }
  }

  /**
   * Apply activation admission to a resident parent before delivering input.
   * @param parent - exact live Agent receiving the message.
   * @param message - durable user message to deliver.
   * @param delivery - receiving inbox destination.
   */
  private sendWaking(parent: Agent, message: UserMessage, delivery: SubagentDelivery): void {
    const parentActivation = this.resident.get(parent.id)
    if (parentActivation !== undefined && activationAgent(parentActivation) === parent) {
      try {
        this.deliver(parentActivation, message, delivery)
      } finally {
        this.wake(parentActivation)
      }
      return
    }
    if (delivery === 'steer') parent.steer(message)
    else parent.followup(message)
  }

  /**
   * Reject new admission once the manager or this exact parent tree began draining.
   * @param agent - exact live Agent whose lineage determines admission.
   */
  private assertAdmitting(agent: Agent): void {
    const closing = this.closingTeardownFor(agent)
    if (closing === undefined) return
    throw new SubagentError(
      closing === 'manager'
        ? 'subagents are draining; the operation was not admitted'
        : `subagents below parent "${closing.id}" are draining; the operation was not admitted`,
      'DRAINING',
    )
  }

  /**
   * Authorize one operation against the durable direct-parent lineage.
   * @param parent - exact live Agent claiming direct-parent authority.
   * @param childId - durable child session id addressed by the operation.
   * @param parentSession - durable direct-parent id recorded by the child.
   */
  private authorizeLineage(
    parent: Agent,
    childId: SessionId,
    parentSession: SessionId | undefined,
  ): void {
    this.assertLiveParent(parent, childId)
    if (parentSession !== parent.id) {
      throw new SubagentError(`subagent "${childId}" belongs to another parent session`, 'UNAUTHORIZED')
    }
  }

  /** Reject parent authority after the live registry entry changes. */
  private assertLiveParent(parent: Agent, childId: SessionId): void {
    if (this.ctx.agents.get(parent.id) !== parent) {
      throw new SubagentError(
        `subagent "${childId}" delivery requires the exact live parent agent`,
        'UNAUTHORIZED',
      )
    }
  }

  /**
   * Create or resume one child Agent and publish its Activation.
   * @param inputs - reconstruction and admission inputs for the residency epoch.
   * @returns the published process-local Activation.
   */
  private materialize(inputs: MaterializeInputs): Promise<Activation> {
    this.assertAdmitting(inputs.parent)
    inputs.signal.throwIfAborted()
    const lineage = this.liveLineage(inputs.parent)
    const pool = this.resident.get(inputs.parent.id)?.pool ?? this.rootPool(inputs.parent)
    const releaseSlot = pool.reserve(this.maxActiveSubagents())
    const settled = Promise.withResolvers<void>()
    const controller = new AbortController()
    const materialization: Materialization = {
      lineage,
      settled: settled.promise,
      controller,
    }
    this.materializations.add(materialization)
    return this.materializeTracked(
      { ...inputs, signal: AbortSignal.any([inputs.signal, controller.signal]) }, lineage, pool, releaseSlot,
    ).catch((error: unknown) => {
      releaseSlot()
      if (error instanceof Error && error.name === 'AbortError') this.assertAdmitting(inputs.parent)
      throw error
    }).finally(() => {
      this.materializations.delete(materialization)
      settled.resolve()
    })
  }

  /**
   * Stop and release one Activation through its memoized close transaction.
   * @param activation - exact residency epoch to close.
   * @returns the shared close transaction.
   */
  private dispose(activation: Activation): Promise<void> {
    return this.close(activation, () => this.finishDisposal(activation, true))
  }

  /** Close admission synchronously and share one release, including startup rollback. */
  private close(activation: Activation, release: () => Promise<void>): Promise<void> {
    if (activation.closing !== undefined) return activation.closing
    const completion = Promise.withResolvers<void>()
    activation.closing = completion.promise
    void release().then(completion.resolve, completion.reject)
    return completion.promise
  }

  /** Dispose independent roots and report every branch failure after all settle. */
  private async disposeRoots(
    roots: readonly Activation[],
    failureSubject: 'activation(s)' | 'scoped activation(s)' | 'selected activation(s)',
  ): Promise<void> {
    const failures = await Promise.all(roots.map(async (activation) => {
      try {
        await this.dispose(activation)
        return undefined
      } catch (error: unknown) {
        return error
      }
    }))
    const reasons = failures.filter(failure => failure !== undefined)
    if (reasons.length > 0) {
      throw new SubagentError(
        `subagent teardown failed for ${reasons.length} ${failureSubject}: `
        + reasons.map(reason => failureMessage(reason)).join('; '),
        'ACTIVATION_TEARDOWN_FAILED',
      )
    }
  }

  /** Return the retained member set for one exact scoped-teardown root. */
  private closingMembers(root: Agent): Set<Agent> {
    const existing = this.closingScopes.get(root)
    if (existing !== undefined) return existing
    const members = new Set<Agent>()
    this.closingScopes.set(root, members)
    return members
  }

  /** Return the exact currently resolvable ancestry from `agent` upward. */
  private liveLineage(agent: Agent): Agent[] {
    const lineage = [agent]
    const seen = new Set<SessionId>([agent.id])
    let parentSession = agent.session.header.parentSession
    while (parentSession !== undefined) {
      const parent = this.ctx.agents.get(parentSession)
      if (parent === undefined || seen.has(parent.id)) break
      lineage.push(parent)
      seen.add(parent.id)
      parentSession = parent.session.header.parentSession
    }
    return lineage
  }

  /** Return the teardown that closed continuable admission for this agent's lineage. */
  private closingTeardownFor(agent: Agent): Agent | 'manager' | undefined {
    if (this.draining) return 'manager'
    const lineage = this.liveLineage(agent)
    for (const [root, members] of this.closingScopes) {
      if (members.has(agent) || lineage.includes(root)) return root
    }
    return undefined
  }

  /** Resolve a root's pool once; descendants inherit their resident parent's pool directly. */
  private rootPool(parent: Agent): ActivationPool {
    let pool = this.rootPools.get(parent)
    if (pool === undefined) {
      pool = new ActivationPool()
      this.rootPools.set(parent, pool)
    }
    return pool
  }

  /** Perform one tracked materialization through publication or rollback. */
  private async materializeTracked(
    inputs: MaterializeInputs,
    parentLineage: readonly Agent[],
    pool: ActivationPool,
    releaseSlot: () => void,
  ): Promise<Activation> {
    const { provider, parent } = inputs
    let childId = inputs.childId
    inputs.signal.throwIfAborted()
    let resource: ActivationResource
    if (inputs.kind === 'external') {
      const controller = new AbortController()
      const cancelStartup = (): void => { controller.abort(inputs.signal.reason) }
      inputs.signal.addEventListener('abort', cancelStartup, { once: true })
      try {
        const run = await inputs.start(controller.signal)
        resource = { kind: 'external', run, controller }
        void run.result.catch(() => undefined)
        childId = run.id
        try { this.assertChildIdAvailable(childId) } catch (error: unknown) {
          await run.dispose()
          throw error
        }
      } finally {
        inputs.signal.removeEventListener('abort', cancelStartup)
      }
    } else {
      const { create } = inputs
      let structured: StructuredAttachment | undefined
      const setup = async (childCtx: Context, child: Agent): Promise<void> => {
        // Only fresh creation appends the descriptor and delegated policy after
        // the inherited marker; a cold resume replays those persisted events.
        if (create !== undefined) {
          child.session.append('subagent/descriptor', create.descriptor)
          appendDelegatedPolicyOverrides(child.session, create.delegatedPolicies)
          const workingDirectory = childCtx.get('workingDirectory')
          if (workingDirectory === undefined) throw new Error('local subagents require the working-directory service')
          await workingDirectory.set(child, create.cwd, inputs.signal)
        }
        applyChildComposition(childCtx, parent, inputs.composition)
        if (inputs.outputSchema !== undefined) {
          structured = attachStructuredRuntime(childCtx, inputs.outputSchema, () =>
            this.resident.get(childId)?.ownedChildren.size === 0
            && child.inbox.nextStep.length === 0
            && child.inbox.nextTurn.length === 0,
          )
        }
      }
      const handle = create === undefined
        ? await this.ownerCtx.agents.resume({
          resumeSessionId: childId,
          parentAgent: parent,
          agentOptions: inputs.agentOptions,
          signal: inputs.signal,
          setup,
        })
        : await this.ownerCtx.agents.create({
          sessionId: childId,
          parentAgent: parent,
          meta: create.meta,
          ...(create.seed === undefined ? {} : { seed: create.seed }),
          inheritedEventCount: create.inheritedEventCount,
          agentOptions: inputs.agentOptions,
          signal: inputs.signal,
          setup,
        })

      resource = { kind: 'local', handle, outputStart: handle.agent.session.seq, structured, failureAt: undefined, poke: Promise.withResolvers<void>() }
    }
    const observer = this.host.observeActivation(provider, childId, parent)

    const activation: Activation = {
      pool,
      releaseSlot,
      childId,
      ...resource,
      parent,
      delivery: inputs.delivery ?? 'parent',
      result: Promise.withResolvers<SubagentResult>(),
      closing: undefined,
      ancestry: new WeakSet(resource.kind === 'external' ? parentLineage : [resource.handle.agent, ...parentLineage]),
      ownedChildren: new Set(),
      observer,
      announced: false,
    }
    void activation.result.promise.catch(() => undefined)
    this.resident.set(childId, activation)
    try {
      this.assertAdmitting(parent)
      inputs.signal.throwIfAborted()
      if (this.ctx.agents.get(parent.id) !== parent) throw new SubagentError('subagent parent is no longer live', 'UNAUTHORIZED')
      this.acquireOwnership(parent, childId)
      const wakeSettlement = (): void => { this.wake(activation) }
      if (activation.kind === 'local') {
        observeLocalFailure(activation, wakeSettlement)
        activation.handle.agent.ctx.on('agent/inbox/inserted', wakeSettlement)
        activation.handle.agent.ctx.on('agent/inbox/claimed', wakeSettlement)
        activation.handle.agent.ctx.on('agent/inbox/discarded', wakeSettlement)
      }
      observer.start(activationAgent(activation))
    } catch (error: unknown) {
      /* v8 ignore next -- rollback failure must not mask the admission failure
       * that prevented this operation from returning an accepted message id. */
      await this.rollbackUnpublished(activation, error).catch(() => undefined)
      throw error
    }
    return activation
  }

  /**
   * Begin settlement observation after initial acceptance is recorded.
   * @param activation - accepted activation to observe.
   */
  private announce(activation: Activation): void {
    if (activation.announced) return
    activation.announced = true
    if (activation.kind === 'local') {
      this.watchLocalSettlement(activation)
    } else {
      const finish = (): Promise<void> => this.close(activation, () => this.finishDisposal(activation, false))
      void activation.run.result.then(finish, finish).catch((error: unknown) => { this.reportTeardownFailure(activation, error) })
    }
  }

  /** Release an Activation whose start edge was not published. */
  private rollbackUnpublished(activation: Activation, error: unknown): Promise<void> {
    return this.close(activation, async () => {
      try {
        await (activation.kind === 'local' ? activation.handle.dispose() : activation.run.dispose())
      } finally {
        this.resident.delete(activation.childId)
        activation.releaseSlot()
        this.releaseOwnership(activation.childId)
        activation.result.reject(error)
      }
    })
  }

  /** Register the child in a continuation-managed parent's owned set. */
  private acquireOwnership(parent: Agent, childId: SessionId): void {
    const parentActivation = this.resident.get(parent.id)
    if (parentActivation === undefined) return
    if (parentActivation.closing !== undefined) {
      throw new SubagentError(
        `subagent parent "${parent.id}" is being disposed; the child was not established`,
        'ACTIVATION_CLOSING',
      )
    }
    parentActivation.ownedChildren.add(childId)
    this.wake(parentActivation)
  }

  /** Remove one child from its live owner's set and let that owner re-check settlement. */
  private releaseOwnership(childId: SessionId): void {
    for (const candidate of this.resident.values()) {
      if (candidate.ownedChildren.delete(childId)) this.wake(candidate)
    }
  }

  /** Let a settlement watcher re-check residency after relevant state changes. */
  private wake(activation: Activation): void {
    if (activation.kind === 'external') return
    activation.poke.resolve()
    activation.poke = Promise.withResolvers<void>()
  }

  /** Follow one Activation to natural settlement. */
  private watchLocalSettlement(activation: LocalActivation): void {
    void (async () => {
      while (true) {
        const idleObservation = activation.poke
        await activation.handle.agent.whenIdle()
        if (activation.closing !== undefined) return
        const readiness = await this.locks.run(activation.childId, () => Promise.resolve(
          this.settlementState(activation, idleObservation),
        ))
        if (readiness === 'closed') return
        if (readiness === 'retry') continue
        if (readiness === 'wait') {
          await idleObservation.promise
          continue
        }

        const finalSeq = activation.handle.agent.session.seq
        await this.flushFinalState(activation)
        const attempt = await this.locks.run<SettlementAttempt>(activation.childId, () => {
          const state = this.settlementState(activation, idleObservation)
          if (state !== 'ready') return Promise.resolve(state)
          if (activation.handle.agent.session.seq !== finalSeq) {
            return Promise.resolve('retry')
          }
          let done!: Promise<void>
          try {
            void activation.handle.agent.runMaintenance(() => {
              done = this.close(activation, () => this.finishDisposal(activation, false))
              return Promise.resolve()
            })
          } catch (_error: unknown) {
            // Another activity already owns the Agent's idle phase.
            return Promise.resolve('retry')
          }
          return Promise.resolve({ done })
        })

        if (typeof attempt === 'string') {
          if (attempt === 'closed') return
          continue
        }
        try {
          await attempt.done
        } catch (error: unknown) {
          this.reportTeardownFailure(activation, error)
        }
        return
      }
    })()
  }

  /** Report disposal failure once after the natural settlement observer finishes. */
  private reportTeardownFailure(activation: Activation, error: unknown): void {
    this.ctx.logger.warn(`subagent "${activation.childId}" activation teardown failed: ${failureMessage(error)}`)
  }

  /** Check pending input and owned children before closing admission. */
  private settlementState(
    activation: LocalActivation,
    observation: PromiseWithResolvers<void>,
  ): SettlementState {
    if (activation.closing !== undefined) return 'closed'
    if (activation.poke !== observation) return 'retry'
    const inbox = activation.handle.agent.inbox
    if (activation.ownedChildren.size > 0) return 'wait'
    if (activation.failureAt === undefined && (inbox.nextTurn.length > 0 || inbox.nextStep.length > 0)) return 'wait'
    return 'ready'
  }

  /** Propagate stop synchronously and await descendant startup rollback before release. */
  private async finishDisposal(activation: Activation, stop: boolean): Promise<void> {
    this.wake(activation)
    const { childId } = activation
    const failures: SubagentError[] = []
    let result: SubagentResult = { output: [], stopReason: 'error' }
    let resultFailure: { error: unknown } | undefined
    let externalDisposal: Promise<void> | undefined
    const child = activationAgent(activation)
    const detail = (error: unknown): string => child === undefined
      ? failureMessage(error)
      : errorChain(error)
    try {
      if (activation.kind === 'external') {
        if (stop) {
          activation.controller.abort({ kind: 'parent' })
          // Some backends settle their result only when disposal begins.
          externalDisposal = Promise.resolve().then(() => activation.run.dispose())
          void externalDisposal.catch(() => undefined)
        }
        result = await activation.run.result
      } else {
        if (stop) {
          activation.handle.agent.cancel({ kind: 'parent' })
          const idle = activation.handle.agent.whenIdle()
          const children = [...activation.ownedChildren]
            .map(child => this.resident.get(child))
            .filter((child): child is Activation => child !== undefined)
          const pending = [...this.materializations].filter(item => item.lineage.includes(activation.handle.agent))
          const childDisposals = children.map(child => this.dispose(child))
          for (const item of pending) item.controller.abort()
          childDisposals.push(...pending.map(item => item.settled))
          const childFailures = await Promise.all(childDisposals.map(async (disposal) => {
            try {
              await disposal
              return undefined
            } catch (error: unknown) {
              return error
            }
          }))
          const reasons = childFailures.filter(reason => reason !== undefined)
          if (reasons.length > 0) {
            failures.push(new SubagentError(
              `subagent "${childId}" child teardown failed: ${reasons.map(reason => failureMessage(reason)).join('; ')}`,
              'ACTIVATION_TEARDOWN_FAILED',
            ))
          }
          await idle
          await this.flushFinalState(activation)
        }
        result = captureLocalResult(activation)
      }
    } catch (error: unknown) {
      resultFailure = { error }
      failures.push(new SubagentError(
        `subagent "${childId}" activation teardown failed: ${detail(error)}`,
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: error },
      ))
    }
    try {
      if (activation.kind === 'local') await activation.handle.dispose()
      else await (externalDisposal ?? activation.run.dispose())
    } catch (error: unknown) {
      failures.push(new SubagentError(
        `subagent "${childId}" activation handle disposal failed: ${detail(error)}`,
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: error },
      ))
    }

    let failure: SubagentError | undefined
    if (failures.length === 1) {
      failure = failures[0]
    } else if (failures.length > 1) {
      failure = new SubagentError(
        `subagent "${childId}" activation teardown failed at ${failures.length} boundaries: `
        + failures.map(item => detail(item)).join('; '),
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: new AggregateError(failures) },
      )
    }
    this.resident.delete(childId)
    activation.releaseSlot()
    const terminal: SubagentResult = failure === undefined ? result : { output: [], stopReason: 'error' }
    this.notifySettlement(activation, result)
    this.releaseOwnership(childId)
    activation.observer.settle(terminal)
    if (resultFailure === undefined) activation.result.resolve(result)
    else activation.result.reject(resultFailure.error)
    if (failure !== undefined) throw failure
  }

  /** Deliver the captured execution result to the durable direct parent after cleanup. */
  private notifySettlement(activation: Activation, terminal: SubagentResult): void {
    if (!activation.announced || activation.delivery === 'caller') return
    try {
      const parent = this.ctx.agents.get(activation.parent.id)
      if (parent !== activation.parent) return
      const message = createSettlementMessage(
        activation.childId, terminal, activationAgent(activation) !== undefined,
      )
      if (this.closingTeardownFor(parent) !== undefined) {
        parent.inject(message)
        return
      }
      this.sendWaking(parent, message, parent.status === 'idle' ? 'queue' : 'steer')
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `subagent "${activation.childId}" settlement notice was not delivered to its parent: `
        + errorChain(error),
      )
    }
  }

  /** Request a best-effort final session flush before closing natural-settlement admission. */
  private async flushFinalState(activation: LocalActivation): Promise<void> {
    try {
      await activation.handle.agent.ctx.sessions.flush(activation.handle.agent.session)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `subagent "${activation.childId}" best-effort final session flush failed; `
        + `the persisted state may be unavailable or stale on resume: ${errorChain(error)}`,
      )
    }
  }

  /** Return capabilities bound to an exact activation instead of a future same-id instance. */
  private receipt(activation: Activation): SubagentActivation {
    return {
      childId: activation.childId,
      result: activation.result.promise,
      dispose: () => this.dispose(activation),
    }
  }

  /** Route one parent-originated delivery through residency and cold resume. */
  private async deliverToChild(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    this.assertAdmitting(parent)
    const releaseHold = this.holdOwnership(parent, childId)
    try {
      return await this.deliverFollowup(parent, childId, content, options)
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /** The delivery loop behind {@link deliverToChild}, run under the parent hold. */
  private async deliverFollowup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    while (true) {
      const live = await this.locks.run(childId, async () => {
        const activation = this.resident.get(childId)
        if (activation === undefined) return this.coldResume(parent, childId, content, options)
        requireLocalActivation(activation)
        const disposal = activation.closing
        /* v8 ignore next 3 -- the send-versus-dispose cutoff needs a delivery to
         * observe the transaction inside the same critical section that opened it. */
        if (disposal !== undefined) {
          return disposal.then(() => undefined, () => undefined)
        }
        if (contentHasImage(content)) {
          await this.assertImageCapable(requireLocalActivation(activation).handle.agent, options.signal)
          if (activation.closing !== undefined) {
            await Promise.allSettled([activation.closing])
            return undefined
          }
        }
        const messageId = this.submitAdmitted(activation, content, options, parent)
        this.announce(activation)
        return messageId
      })
      /* v8 ignore start -- only a delivery that lost the disposal cutoff retries. */
      if (live !== undefined) return live
      this.assertAdmitting(parent)
      options.signal.throwIfAborted()
      /* v8 ignore stop */
    }
  }

  /** Deliver one resident continuable child's message to its live direct parent. */
  private sendToParent(
    activation: Activation,
    sender: Agent,
    content: ContentBlock[],
  ): MessageId {
    /* v8 ignore next 6 -- only synchronous re-entrant teardown can open this
     * transaction between exact-agent authorization and this no-await span. */
    if (activation.closing !== undefined) {
      throw new SubagentError(
        `subagent "${sender.id}" activation is being disposed; the message was not delivered`,
        'ACTIVATION_CLOSING',
      )
    }
    const parent = this.ctx.agents.get(activation.parent.id)
    if (parent !== activation.parent) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
      )
    }
    const message = createAgentMessage(sender, content)
    this.sendAgentMessage(parent, message)
    return message.id
  }

  /** Send one Agent message while translating only the target's own rejection. */
  private sendAgentMessage(
    parent: Agent,
    message: ReturnType<typeof createUserMessage>,
  ): void {
    try {
      this.sendWaking(parent, message, 'steer')
    } catch (error: unknown) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
        { cause: error },
      )
    }
  }

  /**
   * Cold-resume a persisted child and submit the waiting turn. The descriptor
   * supplies every reconstruction input; no subagent provider is dispatched.
   */
  private async coldResume(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    const query = this.requireSessionQuery()
    let observation: SessionObservation
    try {
      observation = await query.observeSession(childId, {
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    using source = observation
    this.assertAdmitting(parent)
    this.authorizeLineage(parent, childId, source.header.parentSession)
    const descriptor = foldSubagentDescriptor(
      source.events.slice(source.inheritedEventCount),
    )
    if (descriptor === undefined || descriptor.mode !== 'continuable') {
      throw new SubagentError(
        `subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`,
        'NOT_RESUMABLE',
      )
    }
    let activation: Activation
    try {
      activation = await this.materialize({
        kind: 'local',
        childId,
        provider: descriptor.provider,
        parent,
        agentOptions: {
          ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
          ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
          ...descriptor.agentReasoningEffort !== undefined
            ? { reasoningEffort: ReasoningEffortId(descriptor.agentReasoningEffort) }
            : {},
        },
        composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter },
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      if (error instanceof SubagentError) throw error
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    return await this.submitMaterialized(activation, content, options, parent)
  }

  /** Admit a materialized child, commit its creation fact, and release it on failure. */
  private async submitMaterialized(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
    commit?: () => void,
  ): Promise<MessageId> {
    try {
      if (contentHasImage(content)) {
        await this.assertImageCapable(requireLocalActivation(activation).handle.agent, options.signal)
        if (activation.closing !== undefined) {
          throw new SubagentError(`subagent "${activation.childId}" is closing`, 'ACTIVATION_CLOSING')
        }
      }
      const messageId = this.submitAdmitted(activation, content, options, parent)
      commit?.()
      this.announce(activation)
      return messageId
    } catch (error: unknown) {
      try {
        await this.dispose(activation)
      } catch (cleanupError: unknown) {
        this.ctx.logger.warn(
          `subagent continuation: disposal after admission or catalog append failure also failed: ${String(cleanupError)}`,
        )
      }
      throw error
    }
  }

  /** Build and submit one message across the final synchronous admission cutoff. */
  private submitAdmitted(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
  ): MessageId {
    const message = options.source === undefined
      ? createAgentMessage(parent, content)
      : createUserMessage({ content, source: options.source })
    options.signal.throwIfAborted()
    this.assertAdmitting(parent)
    this.authorizeLineage(parent, activation.childId, activation.parent.id)
    this.acquireOwnership(parent, activation.childId)
    try {
      this.deliver(activation, message, options.delivery)
    } finally {
      this.wake(activation)
    }
    return message.id
  }

  /** Refuse image content for a child whose fixed model accepts text only. */
  private async assertImageCapable(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<void> {
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return
    const llm = this.ctx.get('llm')
    /* v8 ignore next -- without an LLM registry, delivery defers to projection. */
    if (llm === undefined) return
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      throw new SubagentError(
        `Model "${model}" does not support image input.`,
        'MODEL_DOES_NOT_SUPPORT_IMAGES',
      )
    }
  }

  /** Resolve the persistence service continuable children require, or fail loud. */
  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new SubagentError(
        'continuable subagents require session persistence (load a dsh-session-persistence backend)',
        'PERSISTENCE_UNAVAILABLE',
      )
    }
    return persistence
  }

  /** Resolve the Session query service used for cold child observations. */
  private requireSessionQuery(): SessionQueryEngine {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      throw new SubagentError(
        'continuable subagents require session query (load @deepseek-ai/dsh-session-query)',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return query
  }
}

export default SubagentManager
