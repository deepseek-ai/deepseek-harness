/**
 * Internal continuable-subagent manager: stable child ids, descriptor
 * persistence, activation admission, the live ownership graph, cold resume,
 * child-first disposal, and settlement delivery to the parent, behind
 * `ctx.subagents`.
 *
 * A continuable child has one durable Session and at most one process-local
 * {@link Activation} — one residency epoch for a reconstructed child Agent. An
 * Activation is not a request, result, cancellation, or Task boundary: it may
 * execute many FIFO turns and stays resident while descendants it created are
 * still running. The Agent inbox is the only turn queue, so this manager owns
 * residency while the Agent loop owns all turn ordering and execution. No
 * continuable path creates a Task or an intermediate result-bearing wrapper.
 *
 * Because residency is this manager's alone to end, telling the parent that a
 * child settled is its job too. An external `subagent/end` listener cannot do
 * it correctly: that payload names no parent, the child handle is already
 * disposed by then, and the release that wakes the parent's own settlement
 * watcher has already run. See {@link SubagentContinuationManager.notifySettlement}.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  Agent,
  AgentHandle,
  AgentOptions,
  CreateAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, boundContextSummary, contentHasImage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { foldSubagentDescriptor, snapshotSubagentDescriptor } from './descriptor.ts'
import type { SubagentDescriptorData } from './descriptor.ts'
import {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  resolveChildAgentOptions,
  resolveChildDepth,
} from './child-agent.ts'
import type { DelegatedPolicyOverrides } from './child-agent.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { seedDescriptorTurn } from './descriptor-seed.ts'
import type { ContinuableCreateRequest, ContinuableCreateSpec, SubagentResult, SubagentStartRequest } from './types.ts'
import type { ActivationObserver, ActivationTerminal } from './lifecycle.ts'
import { SubagentError } from './error.ts'
import { isAdjacentAgentSendMessageTool } from './internal.ts'

/** Durable attribution for one model-authored message between adjacent Agents. */
export interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
}

/**
 * Durable attribution for the runtime's own account of a continuable child
 * settling. Deliberately a different kind from
 * {@link AgentMessageSource}: an Agent message is content the sender chose,
 * while this message is the manager stating what became of the child, and a
 * transcript that merged them would credit the child with words it never wrote.
 */
export interface SubagentSettledMessageSource {
  readonly kind: 'subagent-settled'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of how the child ended. */
  readonly summary: string
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-message': AgentMessageSource
    'subagent-settled': SubagentSettledMessageSource
  }
}

/** What a caller asks for when starting a continuable background child. */
export interface ContinuableStartSpec {
  /** The `ctx.subagents` provider whose continuable-creation capability establishes the child. */
  readonly provider: string
  /** The initial delegation's short `description`, persisted as the child's creation label. */
  readonly label: string
  /**
   * Optional caller-reserved child identity. Omission preserves the manager's
   * UUID allocation; supplying one lets a durable parent record provisioning
   * before child materialization without a second identity handshake.
   */
  readonly childId?: SessionId
  /**
   * The delegation request. The manager reserves the stable child id, resolves
   * the durable descriptor, and composes the child itself.
   */
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}

/** Identities returned once a continuable child accepted its initial prompt. */
export interface ContinuableStart {
  /** The durable child session id, stable across activations. */
  readonly childId: SessionId
  /** The accepted initial prompt's inbox message id. */
  readonly messageId: MessageId
}

/**
 * Authority under which one interrupt request is admitted. `user` carries the
 * durable direct-parent address a human client presented; `ancestor` carries
 * the exact live Agent object whose recorded lineage must contain the caller.
 */
export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent }

/** Options for one model-authored message between adjacent Agents. */
export interface SubagentSendMessageOptions {
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}

/** Inputs shared by model steering and the human Queue adapter. */
type ChildDeliveryOptions =
  | { readonly delivery: 'steer'; readonly signal: AbortSignal }
  | { readonly delivery: 'queue'; readonly source: MessageSource; readonly signal: AbortSignal }

/**
 * The residency state of one continuable child, derived from Agent quiescence
 * and the owned-child set rather than a second state machine:
 * `running` — the Agent has an active admission or turn, or waking inbox work;
 * `waiting` — the Agent is quiescent but still owns undisposed children;
 * `settled` — quiescent with every owned child disposed, so the manager
 * disposes the `AgentHandle` and removes the Activation.
 */
type ActivationState = 'running' | 'waiting' | 'settled'

/**
 * Hooks the manager needs from the owning service. Declared here, by the
 * dependent, so the manager states exactly what it requires instead of
 * depending back on the whole {@link SubagentRuntime}. Package-private: no
 * consumer outside this package supplies a host.
 */
interface ContinuationHost {
  /**
   * Resolve one provider's continuable-creation contribution, or reject when
   * the provider is unknown or lacks the capability.
   * @param name - the configured provider name.
   * @param request - the reserved identity, delegating parent, and cancellation.
   * @returns the provider's detached creation spec.
   */
  prepareContinuable(name: string, request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
  /**
   * Build the lifecycle observer for one Activation's residency epoch.
   * @param provider - the provider name recorded in the durable descriptor.
   * @param childId - the durable child session id.
   * @param parent - the exact live direct parent for scoped dispatch.
   * @returns the observer whose edges this epoch publishes.
   */
  observeActivation(provider: string, childId: SessionId, parent: Agent): ActivationObserver
}

/**
 * One residency epoch for a reconstructed continuable child Agent. It directly
 * owns the published `AgentHandle`; the manager's private activation-owner
 * scope is its structural Cordis owner.
 */
interface Activation {
  /** The durable child this Activation is an epoch of. */
  readonly childId: SessionId
  /**
   * The durable direct parent, stored because settlement delivery must resolve
   * that parent after the child handle is gone. {@link ancestry} cannot answer
   * it: a `WeakSet` is not enumerable, and the child's own header is only
   * reachable through a handle disposal has already released.
   */
  readonly parentSession: SessionId
  /** The provider name recorded in the durable descriptor. */
  readonly provider: string
  /** The retained live Agent handle, disposed exactly once at settlement. */
  readonly handle: AgentHandle
  /**
   * Exact live Agent ancestry observed when this Activation materialized.
   * Weak membership preserves host-scope identity across an intermediate
   * ancestor leaving the registry without retaining that ancestor's runtime.
   */
  readonly ancestry: WeakSet<Agent>
  /**
   * Session ids of the child Activations this one owns. Because one Session has
   * at most one live Activation, the id identifies the live child without
   * another runtime-incarnation reference. Non-empty blocks settlement.
   */
  readonly ownedChildren: Set<SessionId>
  /** The lifecycle observer that emits this epoch's start and terminal edges. */
  readonly observer: ActivationObserver
  /**
   * The memoized disposal transaction. Presence IS the admission cutoff: it is
   * assigned synchronously when disposal begins, so no delivery can join a
   * handle being torn down, and a racing delivery awaits it before cold-resuming
   * a new Activation. Every converging releaser shares this one teardown.
   */
  disposal: Promise<void> | undefined
  /**
   * Accepted waking message ids this manager has not yet seen leave the inbox.
   * `Agent.status` is still `idle` in the window between a waking send and the
   * microtask that admits it, so settlement must not treat that gap as quiet.
   */
  readonly accepted: Set<MessageId>
  /**
   * Whether any delivery to this child was ever accepted. A materialization
   * rolled back before its first acceptance is a child the caller was told does
   * not exist, so its teardown owes the parent no settlement account.
   */
  announced: boolean
  /** Renewed whenever a settlement watcher must re-observe quiescence. */
  poke: PromiseWithResolvers<void>
}

/** Inputs shared by fresh and resumed Activation materialization. */
interface MaterializeInputs {
  childId: SessionId
  provider: string
  parent: Agent
  /**
   * Creation inputs; absent for a cold resume, which loads the persisted
   * session — including the delegation policy events a fresh creation seeded,
   * so a resume never re-captures the parent's policy.
   */
  create?: {
    seed: readonly SessionEvent[]
    meta: NonNullable<CreateAgentOptions['meta']>
    /** Policy captured at the delegation boundary: the parent's sandbox override plus the approval pin. */
    delegatedPolicies: DelegatedPolicyOverrides
  }
  agentOptions: AgentOptions
  composition: { persona?: string | undefined; toolFilter?: ToolRestriction | undefined }
  signal: AbortSignal
}

/**
 * One admitted materialization and the exact live ancestry observed at its
 * synchronous admission boundary. Retaining identities lets a scoped teardown
 * keep waiting even if an intermediate Agent leaves the registry meanwhile.
 */
interface Materialization {
  readonly lineage: readonly Agent[]
  readonly settled: Promise<void>
}

/**
 * Read one Activation's current disposal transaction. This indirection exists
 * because TypeScript would otherwise narrow repeated reads of the mutable field
 * inside a long-lived closure to constants instead of re-reading runtime state.
 * @param activation - the Activation to inspect.
 * @returns the in-flight or settled disposal, or `undefined` while resident.
 */
function disposalOf(activation: Activation): Promise<void> | undefined {
  return activation.disposal
}

/** Build durable attribution for one adjacent-Agent message. */
function agentMessageSource(sender: Agent): AgentMessageSource {
  return {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId: sender.id,
  }
}

/** Build the model-visible and durable representation of one adjacent-Agent message. */
function agentMessage(sender: Agent, content: ContentBlock[]) {
  return createUserMessage({
    content: [
      { type: 'text' as const, text: `Agent ${sender.id} sent a message:` },
      ...content,
    ],
    source: agentMessageSource(sender),
  })
}

/** Append adjacent-Agent return guidance to a continuable child's initial task. */
function continuableInitialPrompt(parentId: SessionId, prompt: ContentBlock[]): ContentBlock[] {
  const encodedParentId = JSON.stringify(parentId)
  return [
    ...prompt,
    {
      type: 'text',
      text: `Your parent agent id is ${encodedParentId}. Before you finish, send your result to that agent with `
        + `send_message({ agent_id: ${encodedParentId}, message: "<self-contained result>" }). The parent shares `
        + 'your workspace but does not automatically receive your transcript, tool output, or reasoning. Send '
        + 'earlier messages as well when a finding changes what the parent should do next; sending a message '
        + 'does not end your turn.',
    },
  ]
}

/**
 * One line telling a parent that a background child is finished and why, in
 * the parent's own task vocabulary.
 * @param childId - the durable child the parent knows by id.
 * @param stopReason - how the child's last ordinary turn ended.
 * @returns the model-facing opening line of the settlement notice.
 */
function settlementSummary(childId: SessionId, stopReason: SubagentResult['stopReason']): string {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed':
      return `${subject} finished and will do no further work unless you send it more.`
    case 'aborted':
      return `${subject} was stopped before it finished.`
    case 'max-tokens':
      return `${subject} ran out of room before it finished.`
    // A pre-step rejection — a hook deny, a policy plugin — discarded input
    // the child had claimed, so the parent must not treat the task as done.
    case 'refusal':
      return `${subject} declined the task.`
    case 'error':
      return `${subject} failed before it finished.`
    /* v8 ignore next 4 -- `SubagentResult['stopReason']` is merge-extensible, so this arm
     * needs a backend that adds a variant; an unnameable ending is reported as unfinished
     * rather than silently as success. */
    default:
      return `${subject} ended abnormally (${String(stopReason)}) before it finished.`
  }
}

/** Whether one settlement attempt opened the disposal transaction. */
type SettlementAttempt =
  | { readonly settling: false }
  | { readonly settling: true; readonly done: Promise<void> }

/** Serialize each durable child's delivery, release, and disposal. */
class ChildLock {
  private tails = new Map<SessionId, Promise<unknown>>()

  /**
   * Run `operation` after every previously queued operation for `childId`.
   * @param childId - the durable child whose operations are linearized.
   * @param operation - the critical section to run in order.
   * @returns the operation's own settlement.
   */
  run<T>(childId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(childId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    // Absorb rejections in the chaining tail so one failed critical section
    // cannot reject an unrelated later caller.
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(childId, tail)
    void tail.then(() => {
      if (this.tails.get(childId) === tail) this.tails.delete(childId)
    })
    return result
  }
}

/**
 * The continuable-subagent orchestration service behind `ctx.subagents`. Tool
 * schema and host adapters are consumers of this one contract; foreground
 * one-shot delegation keeps calling `ctx.subagents.start()` and never enters
 * this lifecycle.
 */
export class SubagentContinuationManager {
  /** Child session id → its live Activation. Process-local, never durable. */
  private activations = new Map<SessionId, Activation>()
  /** Materializations admitted before drain, tracked through publication or rollback. */
  private readonly materializations = new Set<Materialization>()
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

  constructor(
    private readonly ctx: Context,
    private readonly host: ContinuationHost,
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
    ctx.effect(function* (this: SubagentContinuationManager) {
      yield scope.dispose
      yield () => this.drain()
    }.bind(this), 'subagents.continuations()')
  }

  /**
   * Start one continuable background child: reserve its durable identity,
   * resolve the provider's detached creation spec, create the child Agent
   * through the private activation-owner scope, establish any continuable-parent
   * ownership, and submit the initial prompt. Resolves when inbox acceptance
   * yields the message id — without waiting for the turn to start or for the
   * message to reach the Session log.
   *
   * Every failure before that acceptance rejects without either id, disposing
   * any created handle and rolling back the Activation and parent ownership.
   * The caller signal owns lookup, materialization, and admission only until
   * acceptance; afterwards the manager owns the Activation independently.
   * @param spec - provider, delegation request, and caller cancellation.
   * @returns the durable child id and the accepted initial prompt's message id.
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    const request = spec.request
    const parent = request.parent
    this.assertAdmitting(parent)
    const persistence = this.requirePersistence()
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

    const prepared = await this.host.prepareContinuable(spec.provider, {
      sessionId: childId,
      parent,
      signal: spec.signal,
    })
    spec.signal.throwIfAborted()
    this.assertAdmitting(parent)

    const lineageSeedLength = prepared.seed?.length ?? 0
    const seed = seedDescriptorTurn(childId, prepared.seed, descriptor)
    const messageId = await this.locks.run(childId, async () => {
      spec.signal.throwIfAborted()
      this.assertAdmitting(parent)
      this.assertChildIdAvailable(childId)
      if (spec.childId !== undefined) {
        const persisted = await persistence.listSnapshots(spec.signal)
        spec.signal.throwIfAborted()
        this.assertAdmitting(parent)
        this.assertChildIdAvailable(childId)
        if (persisted.some(snapshot => snapshot.header.id === childId)) {
          throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD')
        }
      }
      const activation = await this.materialize({
        childId,
        provider: spec.provider,
        parent,
        create: { seed, meta: childSessionMeta(parent, childDepth, lineageSeedLength), delegatedPolicies },
        agentOptions,
        composition: { persona: request.persona, toolFilter: request.toolFilter },
        signal: spec.signal,
      })
      return this.submitMaterialized(
        activation,
        isAdjacentAgentSendMessageTool(this.ctx.get('tools')?.get('send_message', activation.handle.agent))
          ? continuableInitialPrompt(parent.id, request.prompt)
          : request.prompt,
        { source: { kind: 'user' }, signal: spec.signal, delivery: 'queue' },
        parent,
      )
    })
    return { childId, messageId }
  }

  /** Reject one child identity already owned by a live Agent or Session. */
  private assertChildIdAvailable(childId: SessionId): void {
    if (this.ctx.agents.get(childId) !== undefined || this.ctx.get('sessions')?.get(childId) !== undefined) {
      throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD')
    }
  }

  /**
   * Deliver one model-authored message to a direct continuable child or to the
   * sender's direct parent. Both directions use Steer: a running target admits
   * the message at its nearest step boundary, while an idle target starts a
   * turn. A missing direct child cold-resumes through the ordinary continuation
   * lifecycle. The caller signal owns the operation only until inbox acceptance.
   * @param sender - exact live Agent authorizing and originating the message.
   * @param targetId - durable direct-parent or direct-child session id.
   * @param content - model-authored content to deliver.
   * @param options - caller cancellation before acceptance.
   * @returns the accepted message's inbox id.
   * @throws when adjacency, availability, or admission rejects delivery.
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
    const senderActivation = this.activations.get(sender.id)
    if (senderActivation !== undefined
      && senderActivation.handle.agent === sender
      && senderActivation.parentSession === targetId) {
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
   * @param content - human-authored content to deliver.
   * @param source - durable host-protocol provenance.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted message's inbox id.
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

  /** Route one parent-originated delivery through residency and cold resume. */
  private async deliverToChild(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    this.assertAdmitting(parent)
    while (true) {
      const live = await this.locks.run(childId, async () => {
        const activation = this.activations.get(childId)
        if (activation === undefined) return this.coldResume(parent, childId, content, options)
        // A delivery that arrives after the disposal transaction began must not
        // reach a handle being torn down; wait for release, then cold-resume.
        const disposal = activation.disposal
        /* v8 ignore next 3 -- the send-versus-dispose cutoff: reaching this arm needs a
         * delivery to observe the transaction inside the same critical section that opened it,
         * which no test can schedule deterministically. The behavior is covered end-to-end by
         * "cold-resumes a delivery that lost the race with final disposal". */
        if (disposal !== undefined) {
          return disposal.then(() => undefined, () => undefined)
        }
        // Text-only delivery stays await-free, so the disposal-cutoff check
        // above and the submit share one critical window. The image path
        // awaits a capability read, so it re-checks the cutoff afterwards; a
        // disposal that began during the read is waited out and retried like
        // one observed on entry.
        if (contentHasImage(content)) {
          await this.assertImageCapable(activation.handle.agent, options.signal)
          if (activation.disposal !== undefined) {
            await Promise.allSettled([activation.disposal])
            return undefined
          }
        }
        return this.submitAdmitted(activation, content, options, parent)
      })
      /* v8 ignore start -- only the lost-cutoff arm above returns undefined, so only that
       * race reaches the retry below, which then cold-resumes a new Activation. */
      if (live !== undefined) return live
      this.assertAdmitting(parent)
      options.signal.throwIfAborted()
      /* v8 ignore stop */
    }
  }

  /**
   * Interrupt one live continuable child's current turn. Admission is
   * synchronous and the effect is asynchronous: this authorizes the caller,
   * requests `Agent.cancel(cause, { keepInbox: true })` on the target, and
   * returns without waiting for the target to observe the signal or reach
   * quiescence. The Activation, its handle, accepted unclaimed inbox work, and
   * already-published descendants are untouched; work already claimed into the
   * interrupted turn is not requeued. Once the interrupted driver is idle, a
   * waking send resumes the parked queue.
   *
   * An absent target is an accepted no-op, which uniformly covers natural
   * completion races, repeated requests, one-shot ids, and unknown ids without
   * consulting the durable catalog. A target whose disposal transaction is
   * already open is likewise an accepted no-op after authorization.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live ancestor Agent.
   * @throws {SubagentError} `UNAUTHORIZED` when the presented authority does
   *   not own the live target: a stale or self-targeting ancestor caller, a
   *   parent address that is not the live target's durable direct parent, or
   *   an ancestor outside the target's recorded live lineage.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    if (authority.kind === 'ancestor') {
      const caller = authority.agent
      // A stale caller is rejected even when the target is absent, so a
      // replaced same-id Agent can never probe this manager's state.
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
    const activation = this.activations.get(targetSessionId)
    if (activation === undefined) return
    if (authority.kind === 'user') {
      if (activation.handle.agent.session.header.parentSession !== authority.parentSessionId) {
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
    if (activation.disposal !== undefined) return
    activation.handle.agent.cancel(
      authority.kind === 'user' ? { kind: 'user' } : { kind: 'parent' },
      { keepInbox: true },
    )
  }

  /** Deliver one resident continuable child's message to its live direct parent. */
  private sendToParent(
    activation: Activation,
    sender: Agent,
    content: ContentBlock[],
  ): MessageId {
    /* v8 ignore next 6 -- only synchronous re-entrant teardown can open this
     * transaction between exact-agent authorization and this no-await span. */
    if (activation.disposal !== undefined) {
      throw new SubagentError(
        `subagent "${sender.id}" activation is being disposed; the message was not delivered`,
        'ACTIVATION_CLOSING',
      )
    }
    const parent = this.ctx.agents.get(activation.parentSession)
    if (parent === undefined) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
      )
    }
    const message = agentMessage(sender, content)
    this.sendWaking(parent, message, () => { this.sendAgentMessage(parent, message) })
    return message.id
  }

  /**
   * Perform one waking send to a parent, accounted against that parent's own
   * Activation when it has one. Registering the id before the send is what
   * keeps a continuation-managed parent from being judged quiescent in the
   * window between a waking send and the microtask that admits it.
   * @param parent - the exact live parent receiving the waking message.
   * @param message - the message whose id is accounted.
   * @param send - the synchronous waking send to perform.
   */
  private sendWaking(
    parent: Agent,
    message: ReturnType<typeof createUserMessage>,
    send: () => void,
  ): void {
    const parentActivation = this.activations.get(parent.id)
    if (parentActivation !== undefined && parentActivation.handle.agent === parent) {
      this.admitWaking(parentActivation, message.id, send)
    } else {
      send()
    }
  }

  /** Send one Agent message while translating only the target's own rejection. */
  private sendAgentMessage(
    parent: Agent,
    message: ReturnType<typeof createUserMessage>,
  ): void {
    try {
      parent.steer(message)
    } catch (error: unknown) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
        { cause: error },
      )
    }
  }

  /**
   * Close admission, await every already-admitted materialization through
   * publication or rollback, then dispose the stable live Activation forest
   * child-first. Sibling branches drain independently: one failure is recorded
   * but never prevents the remaining handles from being attempted, and the
   * aggregate rejects only after every branch settles.
   * @returns once materialization is quiescent and every live Activation released its handle.
   * @throws an aggregate error when any branch failed to release.
   */
  async drain(): Promise<void> {
    // Close admission synchronously before the first await. Materializations
    // already past that cutoff remain tracked until their handle is installed
    // or rollback completes, producing a stable forest for the later snapshot.
    this.draining = true
    await Promise.all([...this.materializations].map(materialization => materialization.settled))
    // Snapshot roots after closing admission: a root is an Activation no live
    // Activation owns, so disposing roots recurses child-first into the forest.
    const owned = new Set<SessionId>()
    for (const activation of this.activations.values()) {
      for (const child of activation.ownedChildren) owned.add(child)
    }
    const roots = [...this.activations.values()].filter(activation => !owned.has(activation.childId))
    await this.disposeRoots(roots, 'activation(s)')
  }

  /**
   * Stop only the continuable descendants of exact live host-owned parents.
   * Admission stays closed for those parent trees until each exact parent
   * leaves the Agent registry; unrelated trees and manager-wide admission stay
   * live.
   * @param parents - exact live roots whose continuable descendants must stop.
   * @returns once every retained descendant Activation released its handle.
   * @throws an aggregate error after all scoped branches settle when any failed.
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    const roots = new Set(parents.filter(parent => this.ctx.agents.get(parent.id) === parent))
    if (roots.size === 0) return

    // Publish the scoped admission cutoff before the first await. Merge with an
    // earlier call for the same exact root so a converging drain cannot forget
    // descendants whose release is already in flight.
    for (const root of roots) {
      this.closingMembers(root).add(root)
    }

    const targets: Activation[] = []
    for (const activation of this.activations.values()) {
      const lineage = this.liveLineage(activation.handle.agent)
      // Strict descendants only: a continuable Agent may itself be a
      // host-owned root, and its host remains responsible for that root handle.
      const owners = [...roots].filter(root => activation.handle.agent !== root
        && activation.ancestry.has(root))
      if (owners.length === 0) continue
      targets.push(activation)
      for (const owner of owners) {
        const members = this.closingMembers(owner)
        members.add(activation.handle.agent)
        for (const agent of lineage) members.add(agent)
      }
    }
    const materializations = [...this.materializations].filter((materialization) => {
      const owners = [...roots].filter(root => materialization.lineage.includes(root))
      for (const owner of owners) {
        const members = this.closingMembers(owner)
        for (const agent of materialization.lineage) members.add(agent)
      }
      return owners.length > 0
    })

    const ownedTargets = new Set<SessionId>()
    for (const activation of targets) {
      for (const child of activation.ownedChildren) ownedTargets.add(child)
    }
    const targetRoots = targets.filter(activation => !ownedTargets.has(activation.childId))

    // Open every selected transaction before the materialization barrier.
    // Disposal propagates cancellation top-down in the same synchronous span;
    // handle release remains child-first.
    for (const activation of targets) {
      const disposal = this.dispose(activation)
      void disposal.catch(() => undefined)
    }

    await Promise.all(materializations.map(materialization => materialization.settled))
    await this.disposeRoots(targetRoots, 'scoped activation(s)')
  }

  /**
   * Release selected resident direct children of one exact live parent without
   * closing admission for the parent's other continuable children. Owned
   * descendants are released recursively through the same lifecycle.
   * @param parent - exact live direct parent authorizing the selected release.
   * @param childIds - durable direct-child ids to release when resident.
   * @returns once every selected Activation released its handle.
   * @throws {SubagentError} `UNAUTHORIZED` when a resident target is not the
   *   parent's direct continuable child or the parent identity is stale.
   */
  async drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    if (this.ctx.agents.get(parent.id) !== parent) {
      throw new SubagentError('selected child teardown requires the exact live parent agent', 'UNAUTHORIZED')
    }
    const targets: Activation[] = []
    for (const childId of new Set(childIds)) {
      const activation = this.activations.get(childId)
      if (activation === undefined) continue
      if (activation.parentSession !== parent.id || !activation.ancestry.has(parent)) {
        throw new SubagentError(
          `subagent "${childId}" is not a direct child of agent "${parent.id}"`,
          'UNAUTHORIZED',
        )
      }
      targets.push(activation)
    }

    // Open every transaction before the first await so cancellation propagates
    // across the selected roots in one synchronous span.
    for (const activation of targets) {
      const disposal = this.dispose(activation)
      void disposal.catch(() => undefined)
    }
    await this.disposeRoots(targets, 'selected activation(s)')
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
        `continuable subagent teardown failed for ${reasons.length} ${failureSubject}: `
        + reasons.map(reason => errorChain(reason)).join('; '),
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

  /**
   * Return the exact currently resolvable ancestry from `agent` upward. The
   * first element is always the supplied identity, even when it is already
   * stale; each ancestor after it must be the registry's current exact entry.
   */
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

  /**
   * The teardown that closed continuable admission for this agent's lineage.
   * `'manager'` is the whole manager draining; an Agent is the exact scoped root
   * whose forest is closing.
   * @param agent - the agent whose lineage is tested.
   * @returns the closing teardown, or `undefined` while admission is open.
   */
  private closingTeardownFor(agent: Agent): Agent | 'manager' | undefined {
    if (this.draining) return 'manager'
    const lineage = this.liveLineage(agent)
    for (const [root, members] of this.closingScopes) {
      if (members.has(agent) || lineage.includes(root)) return root
    }
    return undefined
  }

  /** Reject new admission once the manager or this exact parent tree began draining. */
  private assertAdmitting(agent: Agent): void {
    const closing = this.closingTeardownFor(agent)
    if (closing === undefined) return
    throw new SubagentError(
      closing === 'manager'
        ? 'continuable subagents are draining; the operation was not admitted'
        : `continuable subagents below parent "${closing.id}" are draining; the operation was not admitted`,
      'DRAINING',
    )
  }

  /**
   * Derive residency from Agent quiescence and the owned-child set. `running`
   * covers an active admission, an open turn, or accepted waking inbox work.
   *
   * `Agent.status` alone is insufficient: it stays `idle` between an accepted
   * waking send and the microtask that admits it, so a synchronous inbox
   * observer would see `settled` while a turn is already queued. `accepted`
   * holds the ids this manager admitted but has not yet seen drained.
   */
  private stateOf(activation: Activation): ActivationState {
    if (activation.handle.agent.status === 'running' || activation.accepted.size > 0) return 'running'
    if (activation.ownedChildren.size > 0) return 'waiting'
    return 'settled'
  }

  /**
   * Cold-resume a persisted child: retain and authorize its prepared Session, fold the
   * generic descriptor, create the Activation through `ctx.agents.resume()`,
   * and submit the waiting turn. This never dispatches through a subagent
   * provider — the persisted Session already holds the initial prefix and the
   * descriptor is the whole reconstruction input.
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
    // Authorize the persisted header before folding: only the durable child's
    // exact live direct parent may continue it.
    this.authorizeLineage(parent, childId, source.header.parentSession)
    // Fold only the child's own suffix: a fork seed replays the parent's log,
    // which may carry an ANCESTOR's descriptor when the parent is itself a
    // continuable child.
    const descriptor = foldSubagentDescriptor(
      source.events.slice(source.header.seedLength ?? 0),
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

  /**
   * Submit to a freshly materialized Activation or roll it back completely.
   * @param activation - the just-published Activation to admit or release.
   * @param content - the initial or resumed message content.
   * @param options - durable source, scheduling, and pre-acceptance cancellation.
   * @param parent - the live direct parent authorizing admission.
   * @returns the accepted inbox message id.
   */
  private async submitMaterialized(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
  ): Promise<MessageId> {
    try {
      if (contentHasImage(content)) {
        // The capability read awaits with the activation already published, so
        // the disposal cutoff is re-checked before the submit; a drain that
        // began during the read turns into a clean closing rejection.
        await this.assertImageCapable(activation.handle.agent, options.signal)
        if (activation.disposal !== undefined) {
          throw new SubagentError(`subagent "${activation.childId}" is closing`, 'ACTIVATION_CLOSING')
        }
      }
      return this.submitAdmitted(activation, content, options, parent)
    } catch (error: unknown) {
      /* v8 ignore next -- rollback disposal failures must not mask the
       * pre-acceptance signal, drain, or lifecycle failure. */
      await this.dispose(activation).catch(() => undefined)
      throw error
    }
  }

  /**
   * Refuse image content addressed to a child whose model accepts text only.
   * Callers guard with `contentHasImage`, so text-only delivery never awaits.
   * The check runs inside the per-child delivery lock, before the message
   * exists, so a rejection leaves no partial user message. When the child's
   * route is not fixed by its options (a request-waterfall listener owns it)
   * or no LLM registry is composed, delivery proceeds and the LLM layer's
   * text-only projection replaces each image with its stable placeholder.
   * @param agent - the live or freshly materialized child agent.
   * @param signal - caller cancellation bounding the model-info read.
   * @throws {SubagentError} `MODEL_DOES_NOT_SUPPORT_IMAGES` when the child's resolved model declines image input.
   */
  private async assertImageCapable(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<void> {
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return
    const llm = this.ctx.get('llm')
    /* v8 ignore next -- a deployment without the LLM registry serves no model
     * to refuse against; delivery then defers to the text-only projection. */
    if (llm === undefined) return
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      throw new SubagentError(
        `Model "${model}" does not support image input.`,
        'MODEL_DOES_NOT_SUPPORT_IMAGES',
      )
    }
  }

  /**
   * Create or resume the child Agent through the private activation-owner
   * scope, install the handle in a fresh Activation, and register ownership on
   * a continuation-managed parent. Rejection leaves no Activation, no handle,
   * and no ownership membership.
   */
  private materialize(inputs: MaterializeInputs): Promise<Activation> {
    this.assertAdmitting(inputs.parent)
    const settled = Promise.withResolvers<void>()
    const lineage = this.liveLineage(inputs.parent)
    const materialization: Materialization = {
      lineage,
      settled: settled.promise,
    }
    this.materializations.add(materialization)
    return this.materializeTracked(inputs, lineage).finally(() => {
      this.materializations.delete(materialization)
      settled.resolve()
    })
  }

  /**
   * Perform one tracked materialization. The caller keeps the drain barrier
   * registered until this either returns a resident Activation or finishes
   * rollback.
   */
  private async materializeTracked(
    inputs: MaterializeInputs,
    parentLineage: readonly Agent[],
  ): Promise<Activation> {
    const { childId, provider, parent, create } = inputs
    // No id pre-check here: the child lock serializes each durable child, both
    // callers reach this only after confirming no Activation exists, and
    // `AgentRegistry.enter()` is the authoritative collision boundary for an id
    // some other owner holds — a duplicate would reject there with rollback.
    inputs.signal.throwIfAborted()
    const setup = (childCtx: Context): void => {
      // Only fresh creation seeds the delegation policy onto the child's own
      // log (after any fork seed, so fresh policy wins stale seed state); a
      // cold resume replays those persisted events instead.
      if (create !== undefined) {
        appendDelegatedPolicyOverrides((childCtx.agent as Agent).session, create.delegatedPolicies)
      }
      applyChildComposition(childCtx, parent, inputs.composition)
    }
    const observer = this.host.observeActivation(provider, childId, parent)
    // Agent creation owns rollback before handle transfer. A rejection leaves
    // no resident Activation and therefore publishes no lifecycle edge.
    const handle: AgentHandle = create === undefined
      ? await this.ownerCtx.agents.resume({
        resumeSessionId: childId,
        agentOptions: inputs.agentOptions,
        signal: inputs.signal,
        setup,
      })
      : await this.ownerCtx.agents.create({
        sessionId: childId,
        meta: create.meta,
        seed: create.seed,
        agentOptions: inputs.agentOptions,
        signal: inputs.signal,
        setup,
      })

    const activation: Activation = {
      childId,
      // The durable lineage, not merely the caller: creation stamps this same
      // agent into the child's header, and cold resume authorized it against
      // the persisted header before materializing.
      parentSession: parent.id,
      provider,
      handle,
      ancestry: new WeakSet([handle.agent, ...parentLineage]),
      ownedChildren: new Set(),
      observer,
      disposal: undefined,
      accepted: new Set(),
      announced: false,
      poke: Promise.withResolvers<void>(),
    }
    // After transfer, any failure must dispose the created handle, remove the
    // Activation, and roll back parent ownership before rejecting.
    this.activations.set(childId, activation)
    try {
      inputs.signal.throwIfAborted()
      this.assertAdmitting(parent)
      this.acquireOwnership(parent, childId)
      // Every accepted id leaves the inbox exactly once, through dequeue or
      // discard. Clearing it there is what lets `stateOf()` distinguish a truly
      // quiet Agent from one whose accepted turn has not been admitted yet.
      // Registered through the child's own scoped context, so scope filtering
      // already restricts both listeners to this exact agent.
      handle.agent.ctx.on('agent/inbox/claimed', ({ message }) => {
        /* v8 ignore next -- a claim of an id this manager never admitted needs
         * another sender on the same child, which no current path allows. */
        if (activation.accepted.delete(message.id)) this.wake(activation)
      })
      handle.agent.ctx.on('agent/inbox/discarded', ({ message }) => {
        if (activation.accepted.delete(message.id)) this.wake(activation)
      })
      // Agent creation committed setup at its publication boundary;
      // revocations from here on are immediate live revocation.
      // Publish the start edge before any turn can run, so observers see this
      // epoch before its first request.
      observer.start(handle.agent)
    } catch (error: unknown) {
      // Listener exceptions are contained by the lifecycle emitter; a start
      // publication throw therefore leaves no residency edge to pair.
      /* v8 ignore next -- rollback failure must not mask the admission failure
       * that prevented this operation from returning an accepted message id. */
      await this.rollbackUnpublished(activation).catch(() => undefined)
      throw error
    }
    this.watchSettlement(activation)
    return activation
  }

  /**
   * Release an Activation whose start edge was not published. The memoized
   * transaction remains in the live map until handle disposal settles, so a
   * concurrent drain or delivery observes the same closing boundary.
   */
  private rollbackUnpublished(activation: Activation): Promise<void> {
    return (activation.disposal ??= (async () => {
      try {
        await activation.handle.dispose()
      } finally {
        this.activations.delete(activation.childId)
        this.releaseOwnership(activation.childId)
      }
    })())
  }

  /**
   * Register the child in a continuation-managed parent's owned set before the
   * child can run, so that parent cannot settle while the child is live. A
   * top-level or other non-continuation Agent has no Activation and stays
   * outside the waiting graph.
   */
  private acquireOwnership(parent: Agent, childId: SessionId): void {
    const parentActivation = this.activations.get(parent.id)
    if (parentActivation === undefined) return
    if (parentActivation.disposal !== undefined) {
      throw new SubagentError(
        `subagent parent "${parent.id}" is being disposed; the child was not established`,
        'ACTIVATION_CLOSING',
      )
    }
    parentActivation.ownedChildren.add(childId)
  }

  /** Remove one child from its live owner's set and let that owner re-check settlement. */
  private releaseOwnership(childId: SessionId): void {
    for (const candidate of this.activations.values()) {
      if (candidate.ownedChildren.delete(childId)) this.wake(candidate)
    }
  }

  /** Let a settlement watcher re-observe quiescence after ownership or inbox changes. */
  private wake(activation: Activation): void {
    activation.poke.resolve()
    activation.poke = Promise.withResolvers<void>()
  }

  /**
   * Submit one message as the child's next FIFO turn and return its accepted
   * inbox id. Acceptance is the operation's success boundary; the manager owns
   * the Activation independently afterwards.
   */
  private submit(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
  ): MessageId {
    // Parent-originated delivery keeps the parent live through ownership, so
    // establish it before the message can enter the child's inbox.
    this.acquireOwnership(parent, activation.childId)
    const message = options.delivery === 'steer'
      ? agentMessage(parent, content)
      : createUserMessage({ content, source: options.source })
    const accepted = this.admitWaking(activation, message.id, () => {
      if (options.delivery === 'steer') activation.handle.agent.steer(message)
      else activation.handle.agent.followup(message)
    })
    // Past this point the caller has an id for this child, so its eventual
    // settlement is something the parent is owed an account of.
    activation.announced = true
    return accepted
  }

  /**
   * Account one waking send across a resident Activation's settlement window.
   * @param activation - Activation receiving waking inbox work.
   * @param messageId - stable identity of the message about to be sent.
   * @param send - synchronous send that publishes one enqueue occurrence.
   * @returns the accepted message id.
   */
  private admitWaking(
    activation: Activation,
    messageId: MessageId,
    send: () => void,
  ): MessageId {
    // Waking Agent sends publish inbox events synchronously, so observers must
    // see this Activation as busy before the call begins.
    activation.accepted.add(messageId)
    try {
      send()
    } catch (error: unknown) {
      activation.accepted.delete(messageId)
      throw error
    }
    // Accepted waking work keeps this Activation live until whenIdle() observes
    // the complete waking suffix.
    this.wake(activation)
    return messageId
  }

  /**
   * Cross the final admission cutoff and submit without yielding. Signal abort,
   * manager drain, or Activation disposal that wins before this synchronous
   * span rejects without inbox acceptance.
   */
  private submitAdmitted(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
  ): MessageId {
    options.signal.throwIfAborted()
    this.assertAdmitting(parent)
    /* v8 ignore next 6 -- only a synchronous re-entrant disposer can change
     * this field between the caller's live check and this no-await boundary. */
    if (disposalOf(activation) !== undefined) {
      throw new SubagentError(
        `subagent "${activation.childId}" activation is being disposed; the message was not accepted`,
        'ACTIVATION_CLOSING',
      )
    }
    this.authorizeLineage(
      parent,
      activation.childId,
      activation.handle.agent.session.header.parentSession,
    )
    return this.submit(activation, content, options, parent)
  }

  /**
   * Authorize one operation against the durable direct-parent lineage. Other
   * agents, ancestors, teams, workflows, and hosts remain rejected until an
   * explicit authority protocol has a production consumer.
   */
  private authorizeLineage(
    parent: Agent,
    childId: SessionId,
    parentSession: SessionId | undefined,
  ): void {
    if (this.ctx.agents.get(parent.id) !== parent) {
      throw new SubagentError(
        `subagent "${childId}" delivery requires the exact live parent agent`,
        'UNAUTHORIZED',
      )
    }
    if (parentSession !== parent.id) {
      throw new SubagentError(`subagent "${childId}" belongs to another parent session`, 'UNAUTHORIZED')
    }
  }

  /**
   * Follow one Activation to settlement: wait for Agent quiescence, then for
   * every owned child to complete disposal, and dispose the handle once both
   * hold. A `next-turn` delivered while `waiting` wakes the same Agent and
   * returns it to `running`, so this re-observes rather than settling early.
   */
  private watchSettlement(activation: Activation): void {
    void (async () => {
      while (disposalOf(activation) === undefined) {
        const poked = activation.poke.promise
        await Promise.race([activation.handle.agent.whenIdle(), poked])
        if (disposalOf(activation) !== undefined) return
        // Re-check settlement INSIDE the child lock and begin disposal in the
        // same critical section, so a concurrent delivery either wins admission
        // before the transaction opens or waits for release and cold-resumes.
        // Deciding outside the lock would let a delivery observe a not-yet
        // resident handle that this watcher is already about to tear down.
        const settling = await this.locks.run<SettlementAttempt>(activation.childId, () => {
          if (disposalOf(activation) !== undefined || this.stateOf(activation) !== 'settled') {
            return Promise.resolve({ settling: false })
          }
          // `dispose()` assigns its memoized transaction synchronously, so
          // admission is closed before this critical section releases.
          return Promise.resolve({ settling: true, done: this.dispose(activation) })
        })
        if (!settling.settling) {
          // Still running, or waiting on descendants: re-observe after the next
          // accepted message or ownership release.
          if (activation.handle.agent.status !== 'running') await poked
          continue
        }
        try {
          await settling.done
        } catch (error: unknown) {
          this.ctx.logger.warn(
            `subagent "${activation.childId}" activation teardown failed: ${errorChain(error)}`,
          )
        }
        return
      }
    })()
  }

  /**
   * Stop one Activation immediately, then release it child-first. The memoized
   * transaction is installed before cancellation or recursive callbacks, so
   * admission and reentrant teardown converge on the same owner.
   *
   * The final session flush is best effort and never prevents handle disposal
   * or ownership release, because retaining a child would permanently pin its
   * ancestors in `waiting`.
   * @param activation - the residency epoch to stop and release.
   * @returns the one disposal transaction owned by this Activation.
   */
  private dispose(activation: Activation): Promise<void> {
    const existing = activation.disposal
    if (existing !== undefined) return existing
    const completion = Promise.withResolvers<void>()
    // Presence is the admission cutoff. Assign it before the async helper starts
    // because that helper cancels Agents and may synchronously re-enter callers.
    activation.disposal = completion.promise
    void this.finishDisposal(activation).then(completion.resolve, completion.reject)
    return completion.promise
  }

  /**
   * Propagate stop synchronously, then finish the child-first release.
   * @param activation - the Activation whose disposal transaction is installed.
   * @returns once the handle and ownership edge are released.
   */
  private async finishDisposal(activation: Activation): Promise<void> {
    this.wake(activation)
    const { childId } = activation
    // Stop top-down before the first await. Slow descendant cleanup may delay
    // release, but it cannot let this ancestor continue model or tool work.
    activation.handle.agent.cancel({ kind: 'parent' })
    const idle = activation.handle.agent.whenIdle()
    const children = [...activation.ownedChildren]
      .map(child => this.activations.get(child))
      .filter((child): child is Activation => child !== undefined)
    const childDisposals = children.map(child => this.dispose(child))

    const failures: SubagentError[] = []
    try {
      // Release remains child-first even though cancellation propagated
      // top-down: every owned child completes before this handle is removed.
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
          `subagent "${childId}" child teardown failed: ${reasons.map(reason => errorChain(reason)).join('; ')}`,
          'ACTIVATION_TEARDOWN_FAILED',
        ))
      }
      // Quiesce before the flush: a turn still running would keep
      // appending events the flush cannot cover.
      await idle
      await this.flushFinalState(activation)
      // Capture the child-dependent edge data while the child is still live:
      // handle disposal unregisters it, and consumers read its log and scope.
      activation.observer.capture(activation.handle.agent)
    } catch (error: unknown) {
      failures.push(new SubagentError(
        `subagent "${childId}" activation teardown failed: ${errorChain(error)}`,
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: error },
      ))
    }
    try {
      await activation.handle.dispose()
    } catch (error: unknown) {
      failures.push(new SubagentError(
        `subagent "${childId}" activation handle disposal failed: ${errorChain(error)}`,
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
        + failures.map(item => errorChain(item)).join('; '),
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: new AggregateError(failures) },
      )
    }
    // Only now is the Activation gone: keeping the entry until disposal settles
    // makes a racing delivery wait for release rather than cold-resume into the
    // still-registered agent.
    this.activations.delete(childId)
    // BEFORE releasing ownership, while the parent still counts this child and
    // therefore cannot be judged settled. Delivering after the release would
    // race a parent watcher that resumes one microtask later, finds itself
    // childless and quiet, and disposes an Agent whose `cancel()` clears the
    // inbox this notice is sitting in.
    this.notifySettlement(activation, activation.observer.terminal(failure))
    // Release ownership even on failure: a retained failed child would pin its
    // ancestors in `waiting` forever.
    this.releaseOwnership(childId)
    // Emit once the disposal outcome is known, so a rejecting scoped cleanup
    // cannot be reported as a successful epoch.
    activation.observer.settle(failure)
    if (failure !== undefined) throw failure
  }

  /**
   * Tell the durable direct parent that this child produced everything it is
   * going to. Unconditional for every child the caller received an id for: it
   * does not consider whether the child reported, because the cases that most
   * need it — a token ceiling, a model failure, cancellation, teardown — are
   * exactly the ones where the child never got to choose. A materialization
   * rolled back before its first acceptance stays silent, since the caller was
   * told that child was not established. A parent that is no longer live is not
   * an error; the child's own Session remains the durable record either way.
   * A parent whose own lineage is already closing receives the notice without a
   * wake, because teardown is not a reason to start a turn.
   *
   * Never blocks disposal. A delivery failure is logged and dropped, because
   * retaining a child to retry a notice would pin its whole ancestry in
   * `waiting` forever.
   * @param activation - the settling Activation, still owned by its parent.
   * @param terminal - how this epoch ended, as the terminal edge will report it.
   */
  private notifySettlement(activation: Activation, terminal: ActivationTerminal): void {
    if (!activation.announced) return
    try {
      const parent = this.ctx.agents.get(activation.parentSession)
      if (parent === undefined) return
      const summary = settlementSummary(activation.childId, terminal.stopReason)
      const message = createUserMessage({
        content: [
          { type: 'text' as const, text: summary },
          ...terminal.output === undefined
            ? [{ type: 'text' as const, text: 'It left no closing message.' }]
            : [{ type: 'text' as const, text: 'Its closing message:' }, ...terminal.output],
        ],
        source: {
          kind: 'subagent-settled' as const,
          form: 'notice' as const,
          summary: boundContextSummary(summary),
          senderSessionId: activation.childId,
        },
      })
      // A parent whose own teardown already began must not be woken. Waking is
      // not a queue operation: `followup()` on a quiescent Agent starts a turn,
      // and `cancel()` does not arm against a later one, so a notice arriving
      // during teardown would spend a model request on an Agent its host is
      // about to dispose — once per tree layer, since each layer's own notice
      // then wakes the layer above it. Injecting delivers to a parent still
      // reading its inbox and records the account in the log either way; it
      // does NOT survive that parent's own disposal, whose `keepInbox: false`
      // cancel durably clears whatever it never claimed.
      if (this.closingTeardownFor(parent) !== undefined) {
        parent.inject(message)
        return
      }
      // An idle parent has nothing else to look at, so it gets one ordinary
      // turn. A busy parent is steered instead of woken: `Inbox.claim()` takes
      // the whole next-step batch at one boundary, so several children settling
      // together cost one step rather than one turn each. Steering rather than
      // injecting closes the window where a driver retires between this status
      // read and the send, which would strand the notice unclaimed.
      this.sendWaking(parent, message, () => {
        if (parent.status === 'idle') parent.followup(message)
        else parent.steer(message)
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `subagent "${activation.childId}" settlement notice was not delivered to its parent: `
        + errorChain(error),
      )
    }
  }

  /**
   * Request a best-effort final session flush after the child is quiescent.
   * Listener failure is logged because flush participation cannot identify a
   * particular persistence backend, and teardown must still release ownership.
   * @param activation - the Activation whose final events should be flushed.
   */
  private async flushFinalState(activation: Activation): Promise<void> {
    const child = activation.handle.agent
    try {
      await child.ctx.sessions.flush(child.session)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `subagent "${activation.childId}" best-effort final session flush failed; `
        + `the persisted state may be unavailable or stale on resume: ${errorChain(error)}`,
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

export type { SubagentDescriptorData }
export default SubagentContinuationManager
