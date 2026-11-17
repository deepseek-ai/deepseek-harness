# Subagents

English | [中文](subagent.zh.md)

The unified activation API manages local conversations and external executions. Creation ancestry, runtime ownership, and communication belong to the subagent tree. [Subagent controls](../../packages/subagent/tool-subagent-control/README.md) own agent identity and exact-caller inbox waiting; Team tools add shared tasks and task policy.

## Capabilities and activation requests

Every backend uses startActivation. Capability flags validate request options; prepareContinuable selects local Agent creation, while start selects one external execution. The model-facing tool uses parent delivery. Workflow and code mode consumers can await caller results without injecting another parent message. Historical children with unavailable descriptors remain discoverable as `mode: 'unknown'` without granting continuation capabilities; the [package README](../../packages/subagent/subagent/README.md) defines catalog persistence.

Optional `cwd` selects the child's initial directory; relative paths resolve against the parent's current effective directory. Omitting it captures that directory at admission. Local child Sessions retain the parent's original project, and cold resume retains their logged directory state.

```ts type-equiv
/**
 * Start-time options supported by a registered backend. The manager checks
 * every requested option before preparing a local child or starting an external
 * execution. depthLimit controls maxDepth; the remaining flag names match
 * SubagentStartRequest fields.
 */
interface SubagentCapabilities {
  readonly agentOptions: boolean
  /** Supports selecting a preset independently of the parent's composition. */
  readonly agentPreset: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
}
```

```ts type-equiv
/** One managed child execution and its result delivery policy. */
interface SubagentActivationSpec extends Omit<SubagentStartRequest, 'label' | 'signal'> {
  /** Registered backend to use. */
  readonly provider: string
  /** Short task label retained in cataloged child membership. */
  readonly label: string
  /**
   * Requested name, unique among the parent's children: 1–32 lower-case
   * letters, digits, or hyphens starting with a letter, other than `lead`.
   * Omission selects the first free `agent-N`.
   */
  readonly name?: string
  /** Optional reserved identity for a local child; external backends allocate their own ids. */
  readonly childId?: SessionId
  /** Cancellation before publication; callers own later cancellation through dispose. */
  readonly signal: AbortSignal
  /** Parent delivery notifies the model; caller delivery only returns the result. Local children always enter the parent catalog. */
  readonly delivery: 'parent' | 'caller'
}
```

```ts type-equiv
/** A managed execution; disposal addresses this exact activation, never a later resume. */
interface SubagentActivation {
  /** Stable identity of the child. */
  readonly childId: SessionId
  /**
   * Model-facing name: slash-separated names from the root when every creator
   * below the root is named, otherwise the child Session id.
   */
  readonly name: string
  /** Accepted inbox message, when the backend has a local inbox. */
  readonly messageId?: MessageId
  /**
   * Execution result after teardown settles and notifications are sent; capture failures reject.
   * Teardown failures are reported by dispose() without replacing a captured result.
   */
  readonly result: Promise<SubagentResult>
  /** Stop and release only this activation; rejects on teardown failure. */
  dispose(): Promise<void>
}
```

```ts type-equiv
/**
 * Task and optional capabilities supplied to a backend. The activation spec
 * shares these task options and defines its own label and cancellation policy.
 */
interface SubagentStartRequest {
  /** Initial child directory; relative paths resolve against the parent's current directory. Omitted inherits that directory at start. */
  readonly cwd?: string
  /**
   * Independent preset id; omission joins the parent's current generation.
   * Requires a provider with `capabilities.agentPreset` that does not inherit
   * parent context.
   */
  readonly agentPreset?: string
  /** Optional short display label persisted with a session-backed child. */
  readonly label?: string
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /**
   * The spawning agent. Its effective directory supplies the default cwd;
   * in-process children retain its origin, lineage, and delegation depth.
   */
  readonly parent: Agent
  /**
   * Cancellation signal from the spawning context (the tool's `exec.signal`).
   * This is the canonical cancellation channel both before and after startup:
   * a provider rejects `start()` after cleaning partial resources when it
   * fires before the run is published, and cancels the published run's
   * remaining turn work when it fires afterward.
   */
  readonly signal: AbortSignal
  /**
   * Optional host-Agent provider, model, reasoning-effort, and output-token
   * overrides. Requires {@link SubagentCapabilities.agentOptions}; in-process
   * providers merge them over the parent Agent's options when they create the
   * child, while the DSH SDK provider merges them over its instance defaults
   * before initializing the separate child runtime.
   */
  readonly agentOptions?: AgentOptions
  /**
   * Object-rooted JSON Schema within `assertObjectJsonSchema`'s enforced subset. Start rejects
   * unsupported schemas or providers without the capability. Data must be plain host-realm JSON;
   * a successful child returns the matching value as {@link SubagentResult.structured}.
   */
  readonly outputSchema?: ObjectJsonSchema
  /**
   * Optional absolute delegation-depth cap for the child being started: its
   * computed depth must be less than or equal to this non-negative safe
   * integer. Requires {@link SubagentCapabilities.depthLimit}; rejected at
   * start otherwise.
   */
  readonly maxDepth?: number
}
```

```ts type-equiv
/** Provider-facing request with an absolute directory selected before startup. */
interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  /** Absolute child directory captured from the parent or explicit request. */
  readonly cwd: string
}
```

## Local children and activations

Spawn alone supports an independent `agentPreset`; omission and fork inherit the parent's active composition. The [child preset rules](../../packages/subagent/subagent/README.md#restoring-child-composition) define explicit selection, event ordering, and historical restoration.

A local child has a durable Session and at most one live activation. The manager reserves identity and capacity, prepares the child through its backend, and owns input admission, cold resume, and child-first disposal. The activation result settles after resource release and completion notification. Disposal reports cleanup failure separately without replacing a captured result. Structured capture closes input for that activation; a later cold resume does not inherit the output schema.

```ts type-equiv
/**
 * What the continuation manager asks a provider for while materializing one
 * continuable child's FIRST activation. The manager has already reserved the
 * durable child identity and owns every later operation, so this request
 * carries only what distinguishes a fresh child from one seeded with parent
 * history.
 */
interface ContinuableCreateRequest {
  /** Absolute initial directory captured before provider preparation. */
  readonly cwd: string
  /** The reserved durable child session id, for provider diagnostics. */
  readonly sessionId: SessionId
  /** The delegating parent agent whose history a seeding provider reads. */
  readonly parent: Agent
  /**
   * Caller cancellation, which owns preparation only until the manager accepts
   * the initial prompt into the child's inbox.
   */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/**
 * A provider's detached contribution to one continuable child's creation. This
 * is DATA, never a capability: it carries no Agent, `AgentHandle`, prompt
 * delivery, result, disposal, or resume operation, because the continuation
 * manager owns the child's whole lifecycle after preparation.
 */
interface ContinuableCreateSpec {
  /**
   * Completed-turn prefix of the parent's log to seed the child session with,
   * or absent for a fresh child. Same durable contract as
   * `CreateAgentOptions.seed`: contiguous from seq 0, lossless JSON, balanced.
   */
  readonly seed?: readonly SessionEvent[]
}
```

## Agent names

Session ids remain the only execution identity for routing, authorization, persistence, and task ownership; names are model-facing references. `SubagentActivation.name` is the child's full name, and `listDescendants()` rows carry it as `path` when every link from the root is named. `namesOf(agent)` reports the names of a live member and its direct creator; the root is `lead`. `resolveName(caller, name, signal)` returns the Session id for `lead` or a full name; any other text that names no member is returned unchanged as a Session id, while a slash-separated address that names no member fails with `AGENT_NAME_NOT_FOUND`. Callers authorize the result; resolution grants no authority. The [package README](../../packages/subagent/subagent/README.md#agent-names) defines the name rule, defaults, failures, and catalog persistence.

```ts type-equiv
/** Model-facing names of one live tree member and its direct creator. */
interface SubagentMemberNames {
  /** `lead` for the root, the slash-separated path for a named descendant, otherwise the Session id. */
  readonly self: string
  /** The direct creator's name by the same rule; absent for the root. */
  readonly parent?: string
}
```

## Messages and interruption

`sendMessage` requires the exact live sender and a target Session id in the same root tree. Root and continuable members can message across branches; admission revalidates the sender and root. Running targets receive Steer; only an absent target cold-resumes, while its creation ancestors may remain offline. External executions reject follow-ups. Local and external executions report final text, structured output, diagnostics, and status to their direct creator only while it is online; caller delivery suppresses those notices. `drainDescendants` awaits whole-tree teardown; an activation receipt’s `dispose()` releases only that execution.

```ts type-equiv
/** Durable attribution for one model-authored message between Agents. */
interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
}
```

```ts type-equiv
/**
 * Durable attribution for the runtime's own account of a continuable child
 * settling. Deliberately a different kind from
 * {@link AgentMessageSource}: an Agent message is content the sender chose,
 * while this message is the manager stating what became of the child, and a
 * transcript that merged them would credit the child with words it never wrote.
 */
interface SubagentSettledMessageSource {
  readonly kind: 'subagent-settled'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of how the child ended. */
  readonly summary: string
  /** Exact execution stop reason; absent on historical notices. Writers always include it. */
  readonly stopReason?: SubagentResult['stopReason']
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}
```

```ts type-equiv
/** Options for one model-authored message within a subagent tree. */
interface SubagentSendMessageOptions {
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/**
 * Authority under which one interrupt request is admitted. `user` is a trusted
 * host operation; Remote callers need permission on the target Session before
 * invoking it. `ancestor` carries an exact live Agent in the target's creation ancestry.
 */
type SubagentInterruptAuthority =
  | { readonly kind: 'user' }
  | { readonly kind: 'ancestor'; readonly agent: Agent }
```

## Durable enumeration

The parent-owned `subagentCatalog` projection lists all local children and parent-delivery external children. Caller-delivery external executions leave membership and result collection to their caller; local workflow children remain discoverable after completion. External entries carry `mode: 'external'` and cannot open a child Session or accept follow-ups. Catalog entries record membership at creation without execution status. `list_agents` exposes the root and reachable continuable descendants with `running` or `inactive` activity; see the [control tool](../../packages/subagent/tool-subagent-control/README.md#list_agents).

## Results and backend handles

SubagentResult is available to program consumers. The activation registry retains the external backend handle until disposal completes. A cleanup failure does not replace a captured execution result: the activation result and parent notice retain it, while dispose rejects and the live subagent/end event reports error. Backend-owned diagnostics must satisfy the safe-detail requirements below.

```ts type-equiv
/**
 * The terminal outcome of a subagent run, resolved by {@link SubagentRun.result}.
 */
interface SubagentResult {
  /**
   * The child's final assistant output is the content of its last non-empty
   * assistant message. Empty-content messages, including usage-only messages,
   * are skipped. Without a non-empty message, the output is its accumulated
   * assistant text stream, or `[]` when the child produced neither.
   */
  readonly output: readonly ContentBlock[]
  /**
   * The structured result after a requested `outputSchema` was successfully
   * satisfied. Requesting a schema does not guarantee presence: a provider can
   * end with `stopReason: 'error'` when the child fails or finishes without a
   * valid capture. The structured value is validated against the requested
   * output schema by the provider; `unknown` here because the seam is
   * schema-agnostic.
   */
  readonly structured?: unknown
  /**
   * Provider-authored, non-assistant failure detail for a non-`completed`
   * result. Providers keep this text free of tool inputs, file contents,
   * environment values, credentials, and raw protocol payloads, and limit it
   * to 4096 UTF-8 bytes. Consumers present it separately from {@link output}.
   */
  readonly diagnostic?: string
  /** Why the run ended. A non-`completed` reason means `output` may be partial. */
  readonly stopReason: SubagentStopReason
}
```

```ts type-equiv
/**
 * Why a subagent run ended. Merge-extensible (a backend may add variants);
 * consumers branch on the known cases and fall through `default`. The known
 * cases mirror the harness turn-end vocabulary so the tool layer can map a
 * non-`completed` result to an `isError` tool result.
 */
interface SubagentStopReasonMap {
  /** The child finished its turn normally. */
  completed: 'completed'
  /** Cancelled through the request signal or disposal. */
  aborted: 'aborted'
  /** Model or transport failure. */
  error: 'error'
  /** The child hit its token ceiling before finishing. */
  'max-tokens': 'max-tokens'
  /** The child declined the task. */
  refusal: 'refusal'
}
```

```ts type-equiv
/**
 * Backend execution handle owned directly by the activation registry.
 * A result may become available before resource release; the manager always
 * disposes the handle and awaits cleanup. Backend startup failures clean up
 * partial resources before rejecting, while accepted execution failures settle
 * through result.
 */
interface SubagentRun {
  /** Provider-minted id, unique across all parents, providers, and local Sessions in this runtime. */
  readonly id: SessionId
  /**
   * Resolves with the child's terminal {@link SubagentResult} when the run
   * settles. Does NOT reject on a child-level failure — a model/transport
   * failure resolves with `stopReason: 'error'` so the consumer maps it to an
   * `isError` tool result. Rejects on an infrastructure fault the seam cannot
   * represent as a stop reason.
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work, reach child quiescence, and release resources.
   * Idempotent.
   */
  dispose(): Promise<void>
}
```

## The provider contract: SubagentProvider

`SubagentManager` owns startup, message admission, and execution lifetimes. Spawn and Fork contribute detached creation inputs for local Agents. Codex, Claude Code, ACP, and DSH SDK contribute one execution handle; they do not gain multiple turns. Each activation is an execution record that directly retains its AgentHandle or SubagentRun. External completion follows the handle’s result promise; inbox and idle admission belong only to local execution. Both paths share admission, capacity, parent ownership, cancellation, and disposal. The [package reference](../../packages/subagent/subagent/README.md) describes composition and deployment requirements.

```ts type-equiv
/**
 * One registered transport for running child agents. Providers are trusted
 * same-process implementations; callers treat descriptors and returned values
 * as borrowed immutable data. The service may call one provider concurrently
 * for distinct children. Providers isolate operation-local mutable state; a
 * shared capacity controller may delay an operation but must not couple its
 * settlement or cleanup to a sibling.
 */
interface SubagentProvider {
  /** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
  readonly name: string
  /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
  readonly capabilities: SubagentCapabilities
  /**
   * Whether the child sees the parent's completed-turn prefix. This is descriptive, not a
   * service-validated start capability: the model-facing tool derives truthful wording from it.
   * It says nothing about tool registration, injected services, or authority inheritance.
   */
  readonly inheritsParentContext: boolean
  /**
   * Optional static provider-owned provider/model route for child Agent
   * options. Consumers merge tool/model overrides over these values before
   * preflight; providers whose route derives from the parent omit it. The value
   * is detached immutable data and requires `agentOptions` support.
   */
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  /**
   * Establish one external execution and return its owned handle.
   * The service has already validated that every requested start-time
   * capability is supported. Before fulfillment, the provider owns setup and
   * cleans any unpublished partial resources before rejecting. Ownership transfers on
   * fulfillment; subsequent turn or infrastructure failure settles through
   * the returned run. Distinct starts may overlap; cancellation, failure,
   * result settlement, and disposal remain independent for each run.
   */
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuable-creation capability): contribute the detached
   * creation inputs that distinguish this provider's continuable children —
   * only whether the child session is seeded with parent history. Method
   * presence selects local activation execution. Providers without it execute
   * through start and do not accept subsequent messages.
   *
   * This is the provider's ONLY participation in a continuable child. The
   * continuation manager owns identity reservation, composition, Agent
   * creation, prompt delivery, cold resume, ownership, and disposal, so a
   * provider never sees the child's Agent, handle, turns, or teardown.
   * Distinct preparations may overlap; each follows its own signal and returns
   * data belonging only to `request.sessionId`.
   */
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
```

## Durable enumeration: `listDescendants()` and catalog entries

The model-facing `list_agents` adapter reports current activity as `running` or `inactive`. These values do not describe task completion or guarantee that `send_message` will succeed.

Direct-child entries are available as `observation.projections?.values.subagentCatalog` through `ctx.sessionQuery.observeSession(parentSessionId, { signal })`; callers release the observation with `using`. Entries follow parent event order without reading child logs or enumerating the Session corpus. Query failures propagate; a missing catalog projection means discovery is unavailable. Browser rows derive membership from the shared projection store and add activity from Session status; the control stream pushes complete catalog updates. `listDescendants()` recursively reads those catalogs and derives `hasChildren` from each child catalog. [The parent-catalog Agent Note](../../.agents/notes/implemented/architecture/2026-09-01-parent-owned-subagent-catalog.md) owns creation, fork isolation, ordering, and persistence costs.

`SubagentRuntime.listDescendants(rootSessionId)` recursively calls the same catalog reader in stable pre-order, preserving each parent's event order. External entries are leaves without local Sessions. One-shot and unknown-mode entries remain traversal nodes; unknown modes produce `unsupported` diagnostics. An unreadable child catalog produces `corrupt` or `unavailable` and stops only that branch. Root read failures, missing services or projections, and cancellation reject the listing. Each reachable catalog is observed once and released before the next read; repeated ids and cycles are skipped. Sessions absent from reachable catalogs are not discovered, including ordinary Session forks and any subagents below those forks. Each row carries its catalog parent, root-relative depth, and, when every link from the root is named, its full name as `path`:

```ts type-equiv
/** One catalog descendant with its direct parent and edge distance from the requested root. */
type SubagentDescendantListEntry = SubagentListEntry & {
  /** Parent whose catalog contains this child. */
  readonly parentId: SessionId
  /** Edge distance from the requested root; direct children are `1`. */
  readonly depth: number
  /** Slash-separated names from the requested root; absent when this child or an ancestor below the root has no name. */
  readonly path?: string
}
```



<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsubagentmodelselection--subagentmodelselectionconfig"></a>

### `ctx.subagentModelSelection` — `SubagentModelSelectionConfig`

Host settings owner that records Session authorization before the first model request.

Source: [`packages/subagent/tool-subagent/src/model-selection-settings.ts`](../../packages/subagent/tool-subagent/src/model-selection-settings.ts)

<a id="ctxsubagents--subagentruntime"></a>

### `ctx.subagents` — `SubagentRuntime`

Named provider registry with managed activations, durable discovery, and local child messaging.

```ts cordis-catalog
/**
 * Resolve a delegation tool's depth policy against the current user setting.
 * @param configured - Explicit tool limit, or provider-managed for external delegation.
 * @returns The numeric limit, or undefined when the provider owns depth enforcement.
 */
resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined

/**
 * Start a local child under its reserved identity.
 * @param spec - local task, reserved child id, and result recipient.
 * @returns activation with its accepted initial message id.
 */
startActivation(spec: SubagentActivationSpec & { readonly childId: SessionId }): Promise<SubagentActivation & { readonly messageId: MessageId }>

/**
 * Start a local or external child.
 * @param spec - task, backend, and result recipient.
 * @returns activation with a message id only for local children.
 */
startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>

/**
 * Resolve the root shared by an Agent and its other agents in its subagent tree.
 * @param caller - exact live Agent whose subagent ancestry selects the tree.
 * @returns the live root; ordinary Session forks lead independent trees.
 * @throws when the caller or its runtime owner is unavailable.
 */
rootOf(caller: Agent): Agent

/**
 * Report the model-facing names of a live tree member and its direct creator.
 * The root is `lead`; a descendant is the slash-separated path of names from
 * the root, or its Session id when it or a creator below the root has no name.
 * @param agent - exact live root or resident tree member.
 * @returns the member's name and, for a descendant, its creator's name.
 * @throws when the caller or its runtime owner is unavailable.
 */
namesOf(agent: Agent): SubagentMemberNames

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
async resolveName(caller: Agent, name: string, signal: AbortSignal): Promise<SessionId>

/**
 * Join progressing subagent tree work for its root. Idle members with parked input
 * stay resident without delaying host completion. Ordinary members return false.
 * @param root - exact live subagent tree root whose member work is awaited.
 * @returns whether work was joined; hosts recheck root idle after true.
 */
async waitForTreeWork(root: Agent): Promise<boolean>

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
async sendMessage( sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions, ): Promise<MessageId>

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
interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void

/**
 * Close admission and stop all instances in the selected subagent trees, then await
 * pending startup and cleanup. Ordinary members are ignored. The cutoff lasts
 * until each exact root leaves the registry; unrelated subagent trees remain live.
 * @param parents - exact live subagent tree roots entering teardown.
 * @returns once all admitted startup and member cleanup have settled.
 * @throws an aggregate error after all branches settle when any failed.
 */
async drainDescendants(parents: readonly Agent[]): Promise<void>

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
listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>

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
@Remote({ name: 'prompt', resources: { session: request => request.childSessionId } }) async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt>

/**
 * Remote face of {@link interrupt}, authorized on the target Session by the Gateway.
 * No catalog, history, persistence, or parent Agent lookup runs.
 * Absent, idle, and already-completed targets are accepted no-ops there.
 * @param childSessionId - durable child session id to interrupt.
 * @returns acknowledgement that the cancel signal was admitted, not that the target is quiescent.
 * @throws {RemoteError} `gateway/bad-request` for an empty id,
 *   otherwise `gateway/internal`.
 */
@Remote({ name: 'interruptByUser', resources: { session: childSessionId => childSessionId } }) interruptByUser(childSessionId: SessionId): SubagentInterruptReceipt

/**
 * Register a provider under its name. Registration is effect-scoped and HMR
 * safe; removing a provider blocks new starts but does not revoke runs that
 * were already returned to their holders. Providers without either execution
 * method are rejected with UNSUPPORTED_CAPABILITY before registration.
 * @param provider - the trusted provider implementation.
 * @returns the exact Cordis effect disposer.
 */
registerProvider(provider: SubagentProvider): () => void

/**
 * Look up a provider by name.
 * @param name - the provider name.
 * @returns the provider, or undefined when absent.
 */
getProvider(name: string): SubagentProvider | undefined
```

Types: [Agent](core.md) · [ContentBlock](llm-streaming.md) · [MessageId](llm-streaming.md) · [SessionId](core.md)

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)

<a id="subagent-events"></a>

### `subagent/*` events

<a id="subagentend--emit"></a>

#### `subagent/end` — emit

A published child settled. Scope-filtered dispatch uses the same subagent tree-root carrier as `subagent/start`, so the lifecycle pair reaches the same scoped audience.

```ts cordis-catalog
/**
 * A published child settled. Scope-filtered dispatch uses the same subagent tree-root
 * carrier as `subagent/start`, so the lifecycle pair reaches the
 * same scoped audience.
 * @param info - run identity, durable direct creator `parentSessionId`, and terminal outcome.
 * @mode emit
 */
'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void
```

Types: [Scoped](scope.md)

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)

<a id="subagentprovider-added--emit"></a>

#### `subagent/provider-added` — emit

A provider became resolvable in the registry.

```ts cordis-catalog
/**
 * A provider became resolvable in the registry.
 * @param provider - the registered provider.
 * @mode emit
 */
'subagent/provider-added'(provider: SubagentProvider): void
```

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)

<a id="subagentprovider-removed--emit"></a>

#### `subagent/provider-removed` — emit

A provider left the registry. Accepted runs remain holder-owned.

```ts cordis-catalog
/**
 * A provider left the registry. Accepted runs remain holder-owned.
 * @param name - the provider name that no longer resolves.
 * @mode emit
 */
'subagent/provider-removed'(name: string): void
```

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)

<a id="subagentstart--emit"></a>

#### `subagent/start` — emit

A provider established a published child. For in-process providers, `ctx.agents.get(info.id)` resolves during this notification. Scope-filtered dispatch keys the carrier by the subagent tree root, so a root-scoped listener observes all subagent tree activations. Paired with `subagent/end`.

```ts cordis-catalog
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
```

Types: [Scoped](scope.md)

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)
<!-- END GENERATED cordis-surface -->
