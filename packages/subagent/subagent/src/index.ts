/**
 * Service Definition for the subagent capability seam (`ctx.subagents`): a named-provider registry plus a
 * capability-validating asynchronous start API. Providers establish a
 * child before returning its run, so fulfillment is the single publication and
 * ownership-transfer boundary.
 *
 * Multiple providers coexist: each registers under a unique name and callers
 * select one by name.
 *
 * This package owns the Service Definition role of the capability seam. Service Providers
 * (`@deepseek-ai/dsh-subagent-spawn-in-process`, `-fork`, `-acp`) and the model-facing
 * consumer (`@deepseek-ai/dsh-tool-subagent`) are separate packages.
 *
 * `startActivation` establishes every child under the activation manager, which
 * owns execution, result delivery, and resource release. Local providers seed
 * resumable Agents; external providers return a single execution handle.
 * `sendMessage` steers between local Agents in one subagent tree without exposing
 * whether a child is resident. Discovery combines real child Sessions with
 * parent-owned records for external executions.
 * Direct discovery reads parent catalogs; descendants recursively read reachable
 * child catalogs. External entries are leaves without local Sessions.
 *
 * Same-process providers are trusted typed collaborators. Requests, provider
 * descriptors, results, and lifecycle payloads are borrowed immutable values;
 * serialization and hostile-input validation belong at real process, worker,
 * persistence, and model boundaries.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { Remote, RemoteError, TypertRemoteService, principalOf, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import {
  rejectPrompt, validateControlRequest,
} from './control.ts'
import type {
  SubagentInterruptReceipt,
  SubagentPromptReceipt,
  SubagentPromptRequest,
  SubagentPromptRequestId,
} from './control-types.ts'
import type {
  SubagentCapabilities,
  SubagentActivation,
  SubagentActivationSpec,
  SubagentInterruptAuthority,
  SubagentMemberNames,
  SubagentProvider,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentSendMessageOptions,
  SubagentStartRequest,
} from './types.ts'
import { SubagentError } from './error.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { createLifecycleEmitter } from './lifecycle.ts'
import type { LifecycleEmitter } from './lifecycle.ts'
import SubagentManager from './manager.ts'
import { listDescendants as listSubagentDescendants, resolveAgentPath } from './list-children.ts'
import type { SubagentDescendantListEntry } from './list-children.ts'
import { subagentIdentityProjectionDefinition, subagentTimingProjectionDefinition } from './projection.ts'
import { subagentCatalogProjectionDefinition } from './catalog.ts'
import { ROOT_AGENT_NAME } from './names.ts'

export type {} from './catalog.ts'
export type {} from './projection.ts'
export * from './out-of-process.ts'
export { AssistantOutputFold, finalAssistantOutput } from './assistant-output.ts'
export { SubagentRunId } from './types.ts'
export { ROOT_AGENT_NAME } from './names.ts'
export type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentActivation,
  SubagentActivationSpec,
  SubagentInterruptAuthority,
  SubagentMemberNames,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentSendMessageOptions,
  SubagentStartRequest,
  ResolvedSubagentStartRequest,
  SubagentStopReason,
  SubagentStopReasonMap,
} from './types.ts'
export {
  foldSubagentDescriptor,
  snapshotSubagentDescriptor,
  SUBAGENT_DESCRIPTOR_VERSION,
} from './descriptor.ts'
export type {
  ContinuableSubagentDescriptorData,
  ContinuableSubagentDescriptorInput,
  OneShotSubagentDescriptorData,
  SubagentDescriptorData,
} from './descriptor.ts'
export { STRUCTURED_OUTPUT_TOOL } from './structured.ts'
export { SubagentError } from './error.ts'
export { assertSubagentMaxDepth, delegationDepthOf } from './depth.ts'
export {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  parentAgentOptionsForDelegation,
  resolveChildAgentOptions,
  resolveChildDepth,
  SubagentDepthError,
} from './child-agent.ts'
export type { ChildComposition, DelegatedPolicyOverrides } from './child-agent.ts'
export type { AgentMessageSource, SubagentSettledMessageSource } from './continuation-messages.ts'
export type * from './control-types.ts'
export type { SubagentDescendantListEntry } from './list-children.ts'
export type { SubagentRunEndInfo, SubagentRunInfo } from './types.ts'
export type { SubagentCatalogEntry, SubagentIdentityProjection, SubagentTimingProjection } from './projection-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentRuntime
  }

  interface Events {
    /**
     * A provider became resolvable in the registry.
     * @param provider - the registered provider.
     * @mode emit
     */
    'subagent/provider-added'(provider: SubagentProvider): void
    /**
     * A provider left the registry. Accepted runs remain holder-owned.
     * @param name - the provider name that no longer resolves.
     * @mode emit
     */
    'subagent/provider-removed'(name: string): void
    /**
     * A provider established a published child. For in-process providers,
     * `ctx.agents.get(info.id)` resolves during this notification.
     * Scope-filtered dispatch keys the carrier by the subagent tree root, so a
     * root-scoped listener observes all subagent tree activations. Paired with
     * `subagent/end`.
     * @param info - provider, child identity, and durable direct creator `parentSessionId`.
     * @mode emit
     */
    'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void
    /**
     * A published child settled. Scope-filtered dispatch uses the same subagent tree-root
     * carrier as `subagent/start`, so the lifecycle pair reaches the
     * same scoped audience.
     * @param info - run identity, durable direct creator `parentSessionId`, and terminal outcome.
     * @mode emit
     */
    'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void
  }
}

/**
 * Durable attribution of one browser-authored follow-up. The Session
 * Controller declares this `user-rpc` message source and depends on this
 * package, so the fields are spelled here: `MessageSource`'s `user` member
 * accepts the record and the correlation id rides the durable message the
 * Client reconciles its optimistic prompt against.
 */
interface BrowserPromptSource {
  readonly kind: 'user'
  readonly rpcId: SubagentPromptRequestId
  readonly clientTimeZone?: string
  /** Caller that submitted this follow-up, written only when it is not the owner; absent means the owner. */
  readonly principal?: Principal
}

/** Host configuration for continuable subagent capacity. */
export interface Config {
  /** Maximum live children sharing uninterrupted continuable parent links; defaults to 8. */
  maxActiveSubagents: Volatile<number>
  /** Default delegation depth for tools without an explicit limit; defaults to 1. */
  maxDepth: Volatile<number>
}

/** Named provider registry with managed activations, durable discovery, and local child messaging. */
export class SubagentRuntime extends TypertRemoteService {
  static Config = z.object({
    maxDepth: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(1).volatile(),
    maxActiveSubagents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8).volatile(),
  })
  static inject = ['workingDirectory', 'sessionProjections']
  private providers = new Map<string, SubagentProvider>()
  private manager: SubagentManager | undefined
  /**
   * The contained lifecycle-edge publisher. Built here because scoped dispatch
   * keys its carrier by this exact service instance, whose own context filter
   * composes into the carrier.
   */
  private readonly emitLifecycle: LifecycleEmitter

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagents')
    this.emitLifecycle = createLifecycleEmitter(this.ctx, parent => scopeTarget(this, parent))
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const catalogProjection = await ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
    await ctx.sessionProjections.register(subagentTimingProjectionDefinition)
    const identityProjection = await ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
    if (ctx.fiber.uid === null) return
    ctx.inject(['agents'], (childCtx: Context) => {
      const manager = new SubagentManager(childCtx, {
        identityOf: session => identityProjection.stateOf(session).identity,
        catalogOf: session => subagentCatalogProjectionDefinition.wire.view(catalogProjection.stateOf(session)),
        emitLifecycle: this.emitLifecycle,
      }, () => this.config.maxActiveSubagents.get())
      this.manager = manager
      childCtx.effect(() => () => {
        /* v8 ignore else -- one injected binding owns the slot until its fiber disposes. */
        if (this.manager === manager) this.manager = undefined
      }, 'subagents.managerBinding()')
    })
  }

  /**
   * Resolve a delegation tool's depth policy against the current user setting.
   * @param configured - Explicit tool limit, or provider-managed for external delegation.
   * @returns The numeric limit, or undefined when the provider owns depth enforcement.
   */
  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined {
    if (configured === 'provider-managed') return undefined
    if (configured !== undefined) return configured
    const depth = this.config.maxDepth.get()
    assertSubagentMaxDepth(depth)
    return depth
  }

  /**
   * Start a local child under its reserved identity.
   * @param spec - local task, reserved child id, and result recipient.
   * @returns activation with its accepted initial message id.
   */
  startActivation(spec: SubagentActivationSpec & { readonly childId: SessionId }):
  Promise<SubagentActivation & { readonly messageId: MessageId }>
  /**
   * Start a local or external child.
   * @param spec - task, backend, and result recipient.
   * @returns activation with a message id only for local children.
   */
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
  /**
   * Establish a managed child with backend-specific execution capabilities.
   * @param spec - task, backend, and result recipient.
   * @returns identities, execution result, and exact-activation disposal. A reserved
   * childId requires a local backend and guarantees an accepted messageId.
   * @throws PROVIDER_CHANGED if the selected provider is removed or replaced before dispatch.
   */
  async startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation> {
    const provider = this.expectProvider(spec.provider)
    if (spec.childId !== undefined && provider.prepareContinuable === undefined) {
      throw new SubagentError('reserved child ids require a local backend', 'UNSUPPORTED_CAPABILITY')
    }
    assertSubagentMaxDepth(spec.maxDepth)
    this.assertCapabilities(provider, spec)
    const manager = this.requireManager()
    if (this.ctx.get('agents')?.get(spec.parent.id) !== spec.parent) {
      throw new SubagentError('subagent creation requires the exact live parent agent', 'UNAUTHORIZED')
    }
    if (spec.outputSchema !== undefined) assertObjectJsonSchema(spec.outputSchema)
    const prepare = provider.prepareContinuable?.bind(provider)
    if (prepare !== undefined) {
      return manager.startLocal(spec, (request) => {
        this.assertProviderCurrent(provider)
        return prepare(request)
      })
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- registerProvider requires start when prepareContinuable is absent.
    const start = provider.start!.bind(provider)
    return manager.startExternal(spec, (request) => {
      this.assertProviderCurrent(provider)
      return start(request)
    })
  }

  /**
   * Resolve the root shared by an Agent and its other agents in its subagent tree.
   * @param caller - exact live Agent whose subagent ancestry selects the tree.
   * @returns the live root; ordinary Session forks lead independent trees.
   * @throws when the caller or its runtime owner is unavailable.
   */
  rootOf(caller: Agent): Agent {
    return this.requireManager().rootOf(caller)
  }

  /**
   * Report the model-facing names of a live tree member and its direct creator.
   * The root is `lead`; a descendant is the slash-separated path of names from
   * the root, or its Session id when it or a creator below the root has no name.
   * @param agent - exact live root or resident tree member.
   * @returns the member's name and, for a descendant, its creator's name.
   * @throws when the caller or its runtime owner is unavailable.
   */
  namesOf(agent: Agent): SubagentMemberNames {
    return this.requireManager().namesOf(agent)
  }

  /**
   * Resolve a model-supplied agent reference within the caller's tree. `lead`
   * selects the root and a slash-separated path is looked up through the
   * catalogs along it. Any other text that is not a name in the tree is
   * returned as a Session id, because a single token can be one; a
   * slash-separated address never is, so an unmatched path fails instead of
   * reaching a member lookup as an unknown id. Resolution grants no authority:
   * messaging, interruption, and assignment authorize the result.
   * @param caller - exact live Agent whose tree root anchors the lookup.
   * @param name - `lead`, a full name from the root, or a Session id.
   * @param signal - cancellation forwarded to each catalog read.
   * @returns the referenced Session id.
   * @throws {@link SubagentError} `AGENT_NAME_NOT_FOUND` when a path names no member;
   *   when the caller's root is unavailable; or when a catalog along the path cannot be read.
   */
  async resolveName(caller: Agent, name: string, signal: AbortSignal): Promise<SessionId> {
    const root = this.rootOf(caller)
    if (name === ROOT_AGENT_NAME) return root.id
    const resolved = await resolveAgentPath(this.ctx, root.id, name, signal)
    if (resolved !== undefined) return resolved
    if (name.includes('/')) {
      throw new SubagentError(
        `agent name ${JSON.stringify(name)} was not found in this subagent tree; use list_agents to see the names`,
        'AGENT_NAME_NOT_FOUND',
      )
    }
    return brandString<SessionId>(name)
  }

  /**
   * Join progressing subagent tree work for its root. Idle members with parked input
   * stay resident without delaying host completion. Ordinary members return false.
   * @param root - exact live subagent tree root whose member work is awaited.
   * @returns whether work was joined; hosts recheck root idle after true.
   */
  async waitForTreeWork(root: Agent): Promise<boolean> {
    return this.manager?.waitForTreeWork(root) ?? false
  }

  /**
   * Steer one model-authored message to another member of the same subagent tree.
   * A running target receives it at its next step; an idle target starts a turn.
   * A cold target resumes under its runtime subagent tree root without restoring
   * its creation ancestors. Sender identity is rechecked before inbox acceptance; cancellation
   * stops only pre-acceptance work and never retracts an accepted message.
   * @param sender - exact live root or resident continuable Agent originating the message.
   * @param targetId - another root or continuable member's durable Session id.
   * @param content - model-authored content to deliver.
   * @param options - caller cancellation before inbox acceptance.
   * @returns the accepted message's inbox id.
   * @throws when the target is outside the tree, cannot resume, or rejects input.
   */
  async sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: SubagentSendMessageOptions,
  ): Promise<MessageId> {
    return this.requireManager().sendMessage(sender, targetId, content, options)
  }

  /**
   * Interrupt one live child's current execution under a trusted user
   * operation or an exact live ancestor Agent. Fire-and-return: the cancel
   * signal is issued before this returns, but the target may keep running
   * until it observes the signal. Unclaimed pending inbox work, the Activation,
   * and published descendants are preserved; claimed work is not requeued.
   * Once the interrupted Agent is idle, a waking send resumes the parked FIFO
   * queue. External backends stop their single execution. An absent target
   * is an accepted no-op, as is a manager-less composition, which cannot own a
   * live Activation.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - a trusted user operation or exact live ancestor Agent.
   * @throws {SubagentError} `UNAUTHORIZED` when the authority does not own the
   *   live target.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.manager?.interrupt(targetSessionId, authority)
  }

  /**
   * Close admission and stop all instances in the selected subagent trees, then await
   * pending startup and cleanup. Ordinary members are ignored. The cutoff lasts
   * until each exact root leaves the registry; unrelated subagent trees remain live.
   * @param parents - exact live subagent tree roots entering teardown.
   * @returns once all admitted startup and member cleanup have settled.
   * @throws an aggregate error after all branches settle when any failed.
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    const manager = this.manager
    // An absent activation manager cannot own materialized children.
    if (manager === undefined) return
    await manager.drainDescendants(parents)
  }

  /**
   * Recursively list reachable parent catalogs in stable pre-order, preserving
   * each catalog's event order. Each row carries its catalog parent and depth;
   * external children are leaves; one-shot and unknown-mode children remain
   * traversal nodes. Unknown modes
   * produce unsupported diagnostics. Unreadable child catalogs produce corrupt
   * or unavailable diagnostics and stop only that branch. Root read failures,
   * missing services or projections, and cancellation reject the whole listing.
   * Each catalog is observed once and released before the next read. No Agent
   * is loaded or resumed; Sessions absent from reachable catalogs are omitted.
   * @param rootSessionId - session whose catalog starts descendant discovery.
   * @param signal - cancellation forwarded to and checked around each catalog read.
   * @returns children and branch diagnostics in parent-catalog pre-order.
   * @throws {@link SubagentError} when listing dependencies are unavailable or the caller cancels.
   * @throws SessionQueryError when the root catalog cannot be read.
   */
  listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]> {
    return listSubagentDescendants(this.ctx, rootSessionId, signal)
  }

  /**
   * Deliver one browser-authored message to a continuable child through its
   * live subagent tree root, retaining the caller-minted request identity and
   * validated browser zone on the accepted message. Success identifies the
   * message the child's inbox accepted; later execution is independent of this
   * call. Queue delivery targets a later turn; steer delivery targets the
   * nearest step and retains the Agent loop's best-effort fallback semantics.
   * Image parts are admitted and persisted through the attachment store
   * before delivery, and the child's model must accept image input.
   * Cold resume at capacity rejects with `subagent/delivery-unavailable`.
   * Access is checked on the target Session before attachment admission or restoration.
   * @param request - target id, delivery, minted identity, content, and optional browser zone.
   * @param signal - carrier cancellation, owning the call until inbox acceptance.
   * @returns the accepted message's inbox identity.
   * @throws {RemoteError} `gateway/bad-request`, `subagent/attachment-invalid`,
   *   `subagent/invalid-time-zone`,
   *   `subagent/not-resumable`, `subagent/unauthorized`,
   *   `subagent/delivery-unavailable`, `gateway/cancelled`, or `gateway/internal`.
   */
  @Remote({ name: 'prompt', resources: { session: request => request.childSessionId } })
  async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt> {
    const { childSessionId, clientTimeZone, delivery } = request
    validateControlRequest('subagent.prompt', request)
    const canonicalTimeZone = clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(clientTimeZone)
    if (clientTimeZone !== undefined && canonicalTimeZone === undefined) {
      throw new RemoteError(
        'subagent/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: clientTimeZone },
      )
    }
    const principal = principalOf(this.ctx.invocation)
    const source: BrowserPromptSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
      ...(principal === undefined ? {} : { principal }),
    }
    try {
      // Admission precedes delivery: image parts become durable references
      // here, so the child inbox only ever accepts Host-persisted attachments.
      let content: ContentBlock[]
      if (request.content.every((part): part is { readonly type: 'text'; readonly text: string } => part.type === 'text')) {
        content = request.content.map(part => ({ type: 'text', text: part.text }))
      } else {
        const attachments = this.ctx.get('attachments')
        if (attachments === undefined) throw new Error('subagent image prompt requires an attachment store')
        content = await attachments.admitPromptContent(request.content)
      }
      return {
        messageId: await this.requireManager().deliverPrompt(
          childSessionId,
          content,
          { source, signal, delivery },
        ),
      }
    } catch (error: unknown) {
      return rejectPrompt(error, childSessionId, signal)
    }
  }

  /**
   * Remote face of {@link interrupt}, authorized on the target Session by the Gateway.
   * No catalog, history, persistence, or parent Agent lookup runs.
   * Absent, idle, and already-completed targets are accepted no-ops there.
   * @param childSessionId - durable child session id to interrupt.
   * @returns acknowledgement that the cancel signal was admitted, not that the target is quiescent.
   * @throws {RemoteError} `gateway/bad-request` for an empty id,
   *   otherwise `gateway/internal`.
   */
  @Remote({ name: 'interruptByUser', resources: { session: childSessionId => childSessionId } })
  interruptByUser(childSessionId: SessionId): SubagentInterruptReceipt {
    validateControlRequest('subagent.interrupt', { childSessionId })
    try {
      this.interrupt(childSessionId, { kind: 'user' })
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', 'subagent interrupt failed', {}, { cause: error })
    }
    return { accepted: true }
  }

  /**
   * Register a provider under its name. Registration is effect-scoped and HMR
   * safe; removing a provider blocks new starts but does not revoke runs that
   * were already returned to their holders. Providers without either execution
   * method are rejected with UNSUPPORTED_CAPABILITY before registration.
   * @param provider - the trusted provider implementation.
   * @returns the exact Cordis effect disposer.
   */
  registerProvider(provider: SubagentProvider): () => void {
    const name = provider.name
    if (provider.start === undefined && provider.prepareContinuable === undefined) {
      throw new SubagentError(`subagent provider "${name}" must implement start or prepareContinuable`, 'UNSUPPORTED_CAPABILITY')
    }
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous disposer
    return this.ctx.effect(function* (this: SubagentRuntime) {
      if (this.providers.has(name)) {
        throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(name, provider)
      yield () => {
        this.providers.delete(name)
        this.emitLifecycle('subagent/provider-removed', name)
      }
      // A throwing added-listener unwinds the yielded rollback, matching the
      // repository's fail-loud registration semantics.
      this.ctx.emit('subagent/provider-added', provider)
    }.bind(this), 'subagents.registerProvider()')
  }

  /**
   * Look up a provider by name.
   * @param name - the provider name.
   * @returns the provider, or undefined when absent.
   */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /** A pending start must use the exact provider whose capabilities were checked. */
  private assertProviderCurrent(provider: SubagentProvider): void {
    if (this.providers.get(provider.name) !== provider) {
      throw new SubagentError(`subagent provider "${provider.name}" changed during startup; retry the delegation`, 'PROVIDER_CHANGED')
    }
  }

  /** Look up a provider for dispatch or fail loud. */
  private expectProvider(name: string): SubagentProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    return provider
  }

  /** Resolve the subagent manager or fail loud. */
  private requireManager(): SubagentManager {
    if (this.manager === undefined) {
      throw new SubagentError(
        'continuable subagents require the agents service',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return this.manager
  }

  /** Reject the first requested capability that the provider lacks. */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    if (request.agentPreset !== undefined && (!provider.capabilities.agentPreset || provider.inheritsParentContext)) {
      throw new SubagentError(
        `subagent provider "${provider.name}" does not support independent agent preset selection`,
        'UNSUPPORTED_CAPABILITY',
      )
    }
    const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
      { when: request.agentOptions !== undefined, cap: 'agentOptions' },
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
    ]
    for (const { when, cap } of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new SubagentError(
          `subagent provider "${provider.name}" does not support the "${cap}" capability`,
          'UNSUPPORTED_CAPABILITY',
        )
      }
    }
  }

}

export default SubagentRuntime
