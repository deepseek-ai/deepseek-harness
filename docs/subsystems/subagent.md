# Subagent

English | [中文](subagent.zh.md)

The subagent seam lets an agent delegate work to a child agent. Like [bash](shell.md), it is **one optional capability**, not part of the agent loop, so its types live here rather than in [core.md](core.md). It differs from the other capability seams because **multiple provider implementations coexist** in one context, registered by name (`ctx.subagents`), while bash allows only one executor. Its registry follows the [LLM adapter registry](llm-streaming.md), not the single-service bash executor.

Service Definition: [dsh-subagent](../../packages/subagent/subagent) (`ctx.subagents` + the vocabulary below). Service Providers are sibling packages (`dsh-subagent-spawn-in-process`, `dsh-subagent-fork-in-process`, `dsh-subagent-acp`, `dsh-subagent-codex`, `dsh-subagent-claude-code`, `dsh-subagent-dsh-sdk`); the model-facing Consumers are [dsh-tool-subagent](../../packages/subagent/tool-subagent) (per-provider delegation) and [dsh-tool-subagent-control](../../packages/subagent/tool-subagent-control) (the optional global `send_message`, `interrupt_agent`, and `list_agents` controls). The same `ctx.subagents` service owns continuable-child orchestration through an internal activation manager and read-only child and descendant discovery straight from the session store and optional session persistence. Product-provider rationale lives in [the Codex and Claude Code Agent Note](../../.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md); common-seam rationale lives in [the subagent Agent Note](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md), [the continuable subagents Agent Note](../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md), [the adjacent-Agent messaging Agent Note](../../.agents/notes/implemented/architecture/2026-08-27-adjacent-agent-steer-messaging.md), [the durable catalog Agent Note](../../.agents/notes/implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md), [the list-identity-projection Agent Note](../../.agents/notes/implemented/architecture/2026-08-06-subagent-list-identity-projection.md), and [the merged-service Agent Note](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md).

Sources: [`packages/subagent/subagent/src/types.ts`](../../packages/subagent/subagent/src/types.ts), [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts), and [`packages/subagent/subagent/src/continuation.ts`](../../packages/subagent/subagent/src/continuation.ts)

## Two kinds of capability, discovered two ways

A provider advertises its **start-time** features on a static descriptor the service checks BEFORE a one-shot run exists; a request that needs one the provider lacks is rejected loud (`SubagentError('UNSUPPORTED_CAPABILITY')`), never accepted-then-ignored. Those flags describe only the one-shot [`start()`](#the-provider-contract-subagentprovider) path, where the provider composes the child. **Continuable** children are composed by the continuation manager itself, so they are gated by one optional method whose presence IS the capability, with TS narrowing as the discovery mechanism: [`SubagentProvider.prepareContinuable`](#the-provider-contract-subagentprovider).

```ts type-equiv
/**
 * Which START-TIME features a provider supports. Checked by the service before delegating to
 * {@link SubagentProvider.start}: a request that needs a capability the chosen provider lacks
 * is rejected with a typed error rather than accepted-then-ignored (the "fail loud, no silent
 * degradation" rule). These flags describe the ONE-SHOT
 * {@link SubagentProvider.start} path, where the provider composes the child;
 * continuable children are composed by the continuation manager itself and are
 * gated by {@link SubagentProvider.prepareContinuable} instead. Each flag
 * corresponds one-to-one to a {@link SubagentStartRequest} option: `depthLimit`
 * to `maxDepth`; the other names match.
 */
interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}
```

## The one-shot start request

The tool layer builds this request from the model input and its own config; the service validates it against the named provider before `start`. Required `parent` supplies the session cwd, lineage, and delegation depth. Optional Agent provider, model, reasoning-effort, and token overrides, output schema, depth, tool filter, and persona require matching capability flags. In-process backends merge `agentOptions` over the parent Agent's options, scope filters and personas to child creation, and implement the supported object-rooted schema with a forced capture tool. The DSH SDK backend merges the four Agent route fields over its instance defaults and validates them in the child runtime's initialization; ACP, Codex, and Claude Code reject `agentOptions` before starting their transports.

```ts type-equiv
/**
 * What a caller asks for when starting a ONE-SHOT subagent. The tool layer
 * builds this from the model's `{ description, prompt }` plus its own config;
 * the service validates {@link SubagentCapabilities} against the named provider
 * and resolves the durable descriptor before dispatching to
 * {@link SubagentProvider.start}.
 */
interface SubagentStartRequest {
  /** Optional short display label persisted with a session-backed child. */
  readonly label?: string
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /**
   * The spawning agent. In-process providers derive workspace, lineage, and
   * delegation depth from its durable session state. ACP reads only its cwd,
   * and only when no deployment `cwd` override is configured.
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
  /**
   * Optional child tool scoping. Requires {@link SubagentCapabilities.toolFilter};
   * rejected at start otherwise. In-process backends apply it as a scoped
   * `tools.restrict()` in the child's creation window: the named tools vanish
   * from the child's prompt AND refuse to execute (one visibility), with loud
   * unknown-name validation.
   */
  readonly toolFilter?: ToolRestriction
  /**
   * Optional per-child persona. Requires {@link SubagentCapabilities.persona};
   * rejected at start otherwise. In-process backends register it as a scoped
   * `deployment:persona` section on the child, SHADOWING the deployment's
   * persona for this child alone — same template semantics as the deployment
   * persona (strict `{{…}}` interpolation against the registered variables).
   */
  readonly persona?: string
}
```

`signal` is the single cancellation channel before and after readiness. The [subagent composition-controls Agent Note](../../.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md) owns the persona, live global-tool filter, absolute-depth, and visibility-not-authority rationale.

The caller-facing request does not carry catalog format details or continuation state. `SubagentRuntime.start()` resolves the detached one-shot descriptor after capability checks, then passes this provider-facing request to the selected transport; a continuable child never reaches `SubagentProvider.start()`:

```ts type-equiv
/**
 * Provider-facing one-shot request after {@link SubagentRuntime.start} resolves
 * the durable child descriptor.
 */
interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  /** Detached descriptor a session-backed provider persists in the child log. */
  readonly descriptor: SubagentDescriptorData
}
```

## Continuable children and activations

A **continuable background subagent** is one durable child Session with at most one process-local **Activation**, the period when a reconstructed child Agent is resident. An Activation is not a request, result, cancellation, or Task: it may execute many FIFO turns and stays resident while descendants it created are still running. The continuation manager owns activation admission, direct-parent authorization, the live ownership graph, cold resume, and child-first disposal; the Agent loop owns all turn ordering and execution. No continuable path creates a Task or an intermediate result-bearing wrapper.

```text
persisted Session
  -> optional live Activation
       -> one retained AgentHandle
       -> Agent inbox as the only turn FIFO
       -> zero or more owned child Activations
```

`SubagentRuntime.startContinuable()` reserves the stable child id, snapshots the versioned `subagent/descriptor` payload, asks the named provider for its detached `ContinuableCreateSpec`, creates the child Agent through a private activation-owner scope, establishes any continuable-parent ownership, and submits the initial prompt. It resolves with `{ childId, messageId }` when inbox acceptance yields the message id — without waiting for the turn to start or for the message to enter the Session log. Every failure before that acceptance rejects with neither id, disposing any created handle and rolling back the Activation and parent ownership.

`SubagentRuntime.sendMessage()` is the sole model-authored message operation. It accepts the exact live sender plus a target id, permits only a direct parent or direct continuable child, derives sender attribution itself, and routes a direct-child target by Activation residency:

| Target Activation state | `sendMessage` |
|---|---|
| `running` | steer the nearest step in the same Activation |
| `waiting` | wake and steer the same Activation |
| no Activation | cold-resume a new Activation, then steer it |

`running` means the Agent has an active admission or turn, or waking inbox work; `waiting` means it is quiescent but still owns at least one child Activation that has not completed disposal; `settled` means quiescent with every owned child disposed, at which point the manager disposes the [`AgentHandle`](core.md#creation-and-ownership) and removes the Activation. The manager derives these internal conditions from Agent quiescence and the owned-child set rather than maintaining a second execution state machine.

The Agent inbox is the only queue. Every Agent message uses `Agent.steer()`: an idle target starts a turn, while a running target claims it at the nearest step boundary. Successful delivery returns the accepted `MessageId`; the existing `agent/inbox/inserted`, `agent/inbox/claimed`, and `agent/inbox/discarded` events remain the message-lifecycle observations, and the continuation layer defines no subagent-specific delivery route.

Authority comes from the exact live sender. Parent-to-child delivery requires the target's `SessionHeader.parentSession` to name the sender; child-to-parent delivery requires the sender's resident Activation to name the target. Siblings, ancestors beyond one edge, self-targets, stale Agent objects, and one-shot children are rejected. Each accepted message is framed as `Agent <sender-id> sent a message:` and records `AgentMessageSource`; provenance records the sender but grants no authority.

For `startContinuable()` and `sendMessage()`, the caller signal owns lookup, materialization, and admission only until inbox acceptance. Afterwards the manager owns the Activation independently: later caller cancellation neither cancels the accepted turn nor disposes the child. Human browser prompts remain a separate private Queue adapter and therefore still produce distinct FIFO turns.

`SubagentRuntime.interrupt(targetSessionId, authority)` is the one public stop: it authorizes synchronously, issues `Agent.cancel(cause, { keepInbox: true })` on the live target, and returns without awaiting quiescence. The Activation, its unclaimed pending inbox work, and published descendants are untouched; work already claimed into the interrupted turn is not requeued. Once the interrupted driver is idle, a waking send resumes the parked FIFO queue. An absent target — unknown, one-shot, or already settled — and a manager-less composition are accepted no-ops. For a live target, a mismatched parent address or caller outside its live ancestry rejects with `UNAUTHORIZED`; stale ancestor objects and self-targeting ancestor requests reject before target lookup.

```ts type-equiv
/**
 * Authority under which one interrupt request is admitted. `user` carries the
 * durable direct-parent address a human client presented; `ancestor` carries
 * the exact live Agent object whose recorded lineage must contain the caller.
 */
type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent }
```

Every Activation owns its `AgentHandle` and an `ownedChildren: Set<SessionId>`; because one Session has at most one live Activation, the child Session id identifies the live child without another runtime-incarnation reference. Starting a child or submitting parent-originated work registers the child in a continuation-managed parent's set before the child can run, and that parent cannot settle while the set is non-empty. A top-level or other non-continuation Agent has no Activation and stays outside the waiting graph. Child release happens only after the child Agent is quiescent, every child of that child is disposed, the best-effort final session flush settles, and the child's `AgentHandle` completes disposal.

Final settlement awaits `ctx.sessions.flush(session)` but ignores its participation boolean because an arbitrary listener cannot prove that a persistence backend stored the state. Rejection is logged without failing the Activation, and the manager still disposes the handle and releases ownership; the persisted child state may then be missing or stale on a later resume. Manager unload invokes an internal manager-wide drain that closes admission and disposes every live forest; `drainContinuableDescendants(parents)` closes admission only below exact live host-owned Agents and disposes their continuable descendants while unrelated forests remain live. Both await already-admitted materializations in their scope, propagate cancellation top-down, release handles child-first, and await every selected branch despite individual failures. Durable child Sessions survive that process-local teardown.

```ts type-equiv
/** Durable attribution for one model-authored message between adjacent Agents. */
interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
}
```

```ts type-equiv
/** Options for one model-authored message between adjacent Agents. */
interface SubagentSendMessageOptions {
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Identities returned once a continuable child accepted its initial prompt. */
interface ContinuableStart {
  /** The durable child session id, stable across activations. */
  readonly childId: SessionId
  /** The accepted initial prompt's inbox message id. */
  readonly messageId: MessageId
}
```

When a resident Activation settles, the manager delivers one notice to the child's durable direct parent describing how that epoch ended and carrying its final assistant content. That delivery is unconditional for every child whose id a caller received, happens before the ownership release that would let the parent be judged settled, and reaches a resident parent through the same waking-admission accounting as an Agent message. A parent whose own lineage is already tearing down receives it without a wake, because waking a quiescent Agent starts a turn rather than queueing work. Its provenance is a distinct kind so a transcript never presents a runtime account as something the child wrote.

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
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}
```

The provider participates only in preparing the initial creation spec, where `spawn` and `fork` differ. Its returned spec carries only detached provider-specific creation inputs — the optional parent-history seed — and no Agent, `AgentHandle`, prompt delivery, result, disposal, or resume operation. Cold resume does not dispatch through a provider at all: the manager folds the generic descriptor, calls `ctx.agents.resume()` through the same activation-owner scope, and submits the waiting turn.

```ts type-equiv
/**
 * What the continuation manager asks a provider for while materializing one
 * continuable child's FIRST activation. The manager has already reserved the
 * durable child identity and owns every later operation, so this request
 * carries only what distinguishes a fresh child from one seeded with parent
 * history.
 */
interface ContinuableCreateRequest {
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

The descriptor (`SubagentDescriptorData` in [descriptor.ts](../../packages/subagent/subagent/src/descriptor.ts)) is a mode-discriminated durable identity for every session-backed subagent. Both modes carry the provider name. A `one-shot` descriptor optionally carries a caller-owned display `label`; a `continuable` descriptor requires the delegation `description` as its durable creation label and additionally snapshots resolved child `agentOptions.provider`/`model`/`reasoningEffort` and optional `persona`/`toolFilter` for cold resume. It never snapshots the merge-extensible `AgentOptions` object, so an unrelated extension value cannot break continuation and a later composition input is a deliberate version change. It omits `subagentDepth` (cold resume trusts the persisted header's `delegationDepth` as the monotone floor) and `outputSchema` (one run or Activation's result contract, not durable identity).

A local one-shot provider appends the descriptor inside the child's initial turn before its first request. The continuation manager appends the descriptor after any provider-supplied lineage and before the initial prompt is admitted; `Session.inheritedEventCount` remains the fork-lineage boundary: resume-time descriptor authority reads the child's own suffix, while the list-serving identity projection folds `subagent/descriptor` last-wins so the child's own descriptor overrides a fork-seeded ancestor's. A seeded cold list skips a cache hint until an authoritative observation supplies that exact cut. The event is log-only: no `surfaceOp`, never in model history, and retained across compaction by the append-only log. Malformed current-version descriptors are corrupt; unsupported versions cannot be classified by this runtime.

## Durable enumeration: `listChildren()`, `listDescendants()`, and their entries

`SubagentRuntime.listChildren(parentSessionId)` enumerates the parent's direct session-backed subagents from the live-preferred merge of `ctx.sessions` and the session-query engine's `listSessions()` — no Agent is loaded or resumed. Candidates are the direct children whose durable header carries `origin: 'subagent'`; the marker classifies enumeration and coarse generic-route denial but cannot establish a valid descriptor, resumability, or authorization — the projection fold owns identity, and the Activation contract owns resume. Each row's `mode`/`label` is the registered `subagent` projection unit's value, served through a three-rung ladder: the registry's watermark cache for a live child (zero log reads); the optional projection checkpoint cache for a cold one (`cachedSnapshot` — an identity passing the own-suffix seq gate is final, because an own descriptor is immutable once appended); otherwise one `query.observeSession()` cold observation folded through the registry (bounded concurrency, recomputed per listing). The cache is a pure optional accelerator: absent, serving the `null` sentinel or missing the key, failing the seq gate, or faulting, it falls silently through to the authoritative refold. The fold is `subagent/descriptor` last-wins with no failure channel: the child's own descriptor overrides a fork-seeded ancestor's, and a malformed or unknown-version payload folds to a serializable `null` sentinel, treated as no value. The result is one `SubagentListEntry[]` in `createdAt`-then-id order: a served identity yields a `child` entry with `mode: 'one-shot' | 'continuable'` and `activity: 'running' | 'inactive'`; continuable entries always carry `label`, while one-shot entries carry it only when the start caller supplied presentation metadata. A settled candidate whose fold served no identity yields a `corrupt` diagnostic — missing, malformed, and unknown-version descriptors deliberately undistinguished (`unsupported` remains in the type but is never produced); a running candidate without an identity is omitted (the creation window before its descriptor lands); a failed cold inspection yields one `unavailable` diagnostic retried on the next listing, so one damaged sibling cannot hide healthy children. `hasChildren` marks a direct descendant with durable subagent origin, read from the same merged material. Activity snapshots only whether the logical record is live in `ctx.sessions`, not outcome or resumability. Absent persistence, enumeration is live-only rather than an error — a cold child cannot be resumed then either. `listChildren()` throws `SubagentError` with code `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE` when the `ctx.sessionProjections` registry is absent and `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE` when the session store is, both checked before any read so a deployment with zero children still fails deterministically; the list tool requires `ctx.subagents` and `ctx.agents` at plugin load. A service consumer such as a UI can display both modes and choose an unlabeled one-shot fallback, while the model-facing `list_agents` adapter (the separately loadable `/list-agents` plugin of [dsh-tool-subagent-control](../../packages/subagent/tool-subagent-control)) keeps only continuable entries and refines status through the live Agent registry into its own `running`/`idle`/`ready` vocabulary, whose `ready` names a storage-only child as resumable rather than terminal. Listing does not consult the continuation manager's Activation map, Agent registry, or provider availability; `send_message` remains the authoritative delivery-time operation, and a listed running continuable child may still reject delivery as an ownership conflict. The read-path rationale lives in [the list-identity-projection Agent Note](../../.agents/notes/implemented/architecture/2026-08-06-subagent-list-identity-projection.md).

`SubagentRuntime.listDescendants(rootSessionId)` applies the same live-preferred corpus and projection-backed interpretation to the root's complete descendant tree in stable pre-order. Ordinary sessions and one-shot children remain traversal nodes, so continuable descendants below them are discovered; only `origin: 'subagent'` candidates produce rows. Each returned child or diagnostic adds its position from the enumerated durable header, while a cold inspection revalidates that complete lifecycle before serving identity:

```ts type-equiv
/**
 * One entry of a descendant listing: the interpreted subagent facts plus its
 * position in the complete session tree. `parentId` is the durable direct
 * parent from the enumerated header, and `depth` counts edges from the root.
 */
type SubagentDescendantListEntry = SubagentListEntry & {
  /** Durable direct parent of this candidate in the enumerated tree. */
  readonly parentId: SessionId
  /** Edge distance from the requested root; direct children are `1`. */
  readonly depth: number
}
```


## The terminal result: `SubagentResult`

The outcome of a one-shot run, resolved by `SubagentRun.result`. `structured` is present only after a requested `outputSchema` was successfully satisfied; requesting a schema does not guarantee it, and a provider may return `stopReason: 'error'` when the child fails or finishes without a valid capture. A provider may attach a safe, non-assistant `diagnostic` to a non-`completed` result; the provider removes tool inputs, file contents, environment values, credentials, and raw protocol payloads and limits the complete value to 4096 UTF-8 bytes before consumers present it separately from `output`. A non-`completed` `stopReason` means `output` may be partial — the consumer maps it to an `isError` tool result rather than reporting partial output as success.

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
  readonly output: ContentBlock[]
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

`SubagentStopReason` is a [merge-extensible derived union](core.md#the-map--derived-union-pattern) — a backend may add variants, so consumers branch on the known cases and treat an unknown terminal reason as a failure:

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

## A one-shot run: `SubagentRun`

`SubagentRun` is the consumer-owned handle for a published one-shot child — one disposable foreground delegation with one result, never a durable child handle. Prompt submission, turn work, and infrastructure faults after publication belong to `result`. Consumers await that result and always dispose the run to reach quiescence. Child failures resolve with a non-completed stop reason; only unrepresentable infrastructure faults reject. A run has no steering and no resume: continuable conversations have no run at all, because the continuation manager holds their `AgentHandle` directly and orders every turn through the child's own inbox.

```ts type-equiv
/**
 * ONE-SHOT child handle returned after publication. Prompt submission, turn
 * work, and infrastructure faults after that boundary belong to {@link result}.
 * Consumers await that result and must always {@link dispose} to cancel
 * remaining work and reach quiescence. A run is one disposable foreground
 * delegation with one result; continuable conversations have no run — the
 * continuation manager holds their `AgentHandle` directly and orders every
 * turn through the child's own inbox.
 */
interface SubagentRun {
  /**
   * Parent-scoped run id. For a local run, this MUST equal the published child
   * session id, whose `parentSession` records `request.parent.session.id`; a
   * remote provider mints an id unique in the parent namespace.
   */
  readonly id: SessionId
  /**
   * The exact published in-process child, or `undefined` for a remote run.
   * When present, its id is {@link id}; the provider retains no ownership
   * implication beyond the run's ordinary {@link dispose} contract.
   */
  readonly localAgent: Agent | undefined
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

A local one-shot run MUST publish an ordinary child agent/session before `start()` fulfills, return that child session id as `SubagentRun.id`, expose the exact child as `localAgent`, record `request.parent.session.id` in the child's `parentSession` header, and append the resolved descriptor inside the child's initial turn before its first request. Runtime ownership may place the child under the parent, provider, or root scope. A remote provider instead returns a parent-scoped lifecycle id and `localAgent: undefined`; without a local child Session, it is absent from durable enumeration.

## The provider contract: `SubagentProvider`

Each provider is a named child-agent transport, and multiple providers may coexist. The service validates requested start-time capabilities before `start()`, and rejects a continuable start on a provider without `prepareContinuable`. `inheritsParentContext` describes only conversation seeding (`fork`: true; `spawn` and `acp`: false), allowing consumers to generate accurate model-facing wording without implying inherited tools, services, or authority. A provider whose one-shot route has static provider-owned defaults publishes optional immutable `agentRouteDefaults`, allowing a Consumer to merge model/tool overrides against the correct baseline before preflight.

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
   * Optional static provider-owned provider/model route for one-shot Agent
   * options. Consumers merge tool/model overrides over these values before
   * preflight; providers whose route derives from the parent omit it. The value
   * is detached immutable data and requires `agentOptions` support.
   */
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  /**
   * Establish a ONE-SHOT child and return its handle after publication.
   * The service has already validated that every requested start-time
   * capability is supported and resolved `request.descriptor`, so a
   * session-backed implementation appends that descriptor inside the child's
   * initial turn. Before fulfillment, the provider owns setup and cleans any
   * unpublished partial resources before rejecting. Ownership transfers on
   * fulfillment; subsequent turn or infrastructure failure settles through
   * the returned run. Distinct starts may overlap; cancellation, failure,
   * result settlement, and disposal remain independent for each run.
   */
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuable-creation capability): contribute the detached
   * creation inputs that distinguish this provider's continuable children —
   * only whether the child session is seeded with parent history. Method
   * presence IS the capability: the service rejects continuable starts on
   * providers without it, while a provider that has it may still serve
   * ordinary one-shot delegations.
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

Provider `start()` fulfills with a published run. The service mints a unique `runId`, snapshots `local` from the provider's exact `localAgent`, observes the result, emits `subagent/start`, and returns the same run; a `start()` rejection implies cleanup of unpublished resources and emits no lifecycle pair, while a post-publication result rejection closes the emitted pair. Each continuable Activation emits the same observe-only pair for its residency epoch, so a cold resume is a new epoch with its own `runId`. The paired `subagent/end` carries the same identity and the final output or infrastructure failure. Both events are observe-only and contain listener exceptions. Their `provider` field names the provider that started the run or Activation epoch; it does not claim that the provider remains registered when the edge is emitted.

## In-process backends: depth and seed

The spawn and fork backends create an ordinary one-shot agent through `parent.ctx`, pass cancellation into core creation, and dispose through `AgentHandle`; a continuable child is instead created by the continuation manager through its own activation-owner scope. Provider removal blocks new starts without revoking accepted runs. Each child gets a new flat scope rather than inheriting parent registrations. Depth and fork seeding reuse existing agent and session vocabulary:

- **Delegation depth** is durable `SessionHeader.delegationDepth` plus the merge-extensible runtime field `AgentOptions.subagentDepth`; absence means top-level depth zero, and the greater present value is authoritative. The seam owns both fields — the loop neither sets nor reads them — so an in-process child persists parent depth + 1, cold resume cannot lower it, and every start rejects a derived depth outside the safe-integer domain or above a defined absolute `request.maxDepth` cap.
- **Fork seeding** uses [`CreateAgentOptions.seed`](core.md#creation-and-ownership) (a `SessionEvent[]` prefix threaded through `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })`, the same primitive `ctx.agents.resume()` uses). The fork backend passes a *balanced completed-turn prefix* of the parent's log — the parent's events up to and including its last `turn/end` — so the seed is contiguous-from-0 and the [invariants](../../packages/runtime-diagnostics/invariants) replay accepts it (the in-flight, unbalanced turn is excluded).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsubagentmodelselection--subagentmodelselectionconfig"></a>

### `ctx.subagentModelSelection` — `SubagentModelSelectionConfig`

Singleton settings owner read by delegation tools when an Agent is published.

```ts cordis-catalog
/**
 * Read a detached selection preference for the next eligible Agent publication.
 * @returns the enabled state and exact allowed routes.
 */
current(): SubagentModelSelectionSettings
```

Source: [`packages/subagent/tool-subagent/src/model-selection-settings.ts`](../../packages/subagent/tool-subagent/src/model-selection-settings.ts)

<a id="ctxsubagents--subagentruntime"></a>

### `ctx.subagents` — `SubagentRuntime`

Named provider registry with one-shot runs, durable discovery, and continuable-child operations.

```ts cordis-catalog
/**
 * Establish one durable continuable child and deliver its initial prompt.
 * Resolves when the child's inbox accepts that prompt, without waiting for the
 * turn to start or for the message to reach the Session log; any earlier
 * failure rejects with no ids and rolls back the child entirely.
 * @param spec - provider, delegation request, and caller cancellation.
 * @returns the durable child id and the accepted prompt's message id.
 * @throws when continuation services are unavailable or materialization fails.
 */
async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>

/**
 * Steer one model-authored message to the sender's direct parent or direct
 * continuable child. A running target admits it at the nearest step boundary;
 * an idle target starts a turn, and an absent direct child cold-resumes from
 * persistence. The service derives durable sender attribution from the exact
 * live sender. Caller cancellation stops only pre-acceptance work.
 * @param sender - exact live Agent authorizing and originating the message.
 * @param targetId - durable direct-parent or direct-child session id.
 * @param content - model-authored content to deliver.
 * @param options - caller cancellation before inbox acceptance.
 * @returns the accepted message's inbox id.
 * @throws when continuation services are unavailable, adjacency is rejected,
 *   or the message was not admitted.
 */
async sendMessage( sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions, ): Promise<MessageId>

/**
 * Interrupt one live continuable child's current turn under a human parent
 * address or an exact live ancestor Agent. Fire-and-return: the cancel
 * signal is issued before this returns, but the target may keep running
 * until it observes the signal. Unclaimed pending inbox work, the Activation,
 * and published descendants are preserved; claimed work is not requeued.
 * Once the interrupted driver is idle, a waking send resumes the parked FIFO
 * queue. An absent target — including a one-shot or unknown id —
 * is an accepted no-op, as is a manager-less composition, which cannot own a
 * live Activation.
 * @param targetSessionId - the durable child session id to interrupt.
 * @param authority - the human parent address or exact live ancestor Agent.
 * @throws {SubagentError} `UNAUTHORIZED` when the authority does not own the
 *   live target.
 */
interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void

/**
 * Close continuable admission below exact live parent Agents, stop only their
 * visible descendant Activations synchronously, then await admitted scoped
 * materializations and release those forests child-first. The scoped cutoff
 * lasts until each exact parent leaves the registry; unrelated parent trees
 * remain live.
 * @param parents - exact host-owned parent Agents entering teardown.
 * @returns once every retained descendant Activation released its `AgentHandle`.
 * @throws an aggregate error after all branches settle when any failed.
 */
async drainContinuableDescendants(parents: readonly Agent[]): Promise<void>

/**
 * Release selected resident continuable direct children of one exact live
 * parent. Other children of the same parent remain admitted and resident.
 * Absent targets and a manager-less composition are accepted no-ops.
 * @param parent - exact live direct parent authorizing the selected release.
 * @param childIds - durable direct-child ids to release when resident.
 * @returns once every selected Activation released its `AgentHandle`.
 * @throws {SubagentError} `UNAUTHORIZED` when a resident target belongs to a
 *   different parent or the supplied parent identity is stale.
 */
async drainContinuableChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>

/**
 * Enumerate the parent's direct session-backed subagents without loading or
 * resuming an Agent. The Session query service supplies one live-preferred
 * corpus and shared point observations; the projection cache supplies
 * immutable descriptor hits without opening cold logs. The registered
 * `subagent` projection remains the sole mode/label classifier.
 *
 * Every query receives `signal`, and the listing rechecks cancellation
 * around each await. Read rejections that settle
 * after an abort become a stable `SubagentError` with code `CANCELLED`.
 * @param parentSessionId - parent session whose direct children are listed.
 * @param signal - caller-owned cancellation forwarded to Session queries
 *   and observed around every read await.
 * @returns children and per-child diagnostics ordered by `createdAt`, then id.
 * @throws {@link SubagentError} when the projection registry or the session
 *   store is not mounted, or the caller cancels the listing.
 */
listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>

/**
 * Enumerate the root's complete session-backed subagent tree in stable
 * pre-order from one live-preferred corpus, without loading or resuming an
 * Agent. Ordinary sessions and one-shot children remain traversal nodes so
 * continuable descendants below them are discovered; each returned entry
 * adds its durable `parentId` and root-relative `depth`. Identity resolution,
 * diagnostics, optional persistence, and cancellation follow the same
 * projection-backed contract as {@link listChildren}.
 * @param rootSessionId - session whose complete descendant tree is listed.
 * @param signal - caller-owned cancellation forwarded to persistence reads
 *   and observed around every read await.
 * @returns children and per-candidate diagnostics with tree position, in
 *   stable pre-order.
 * @throws {@link SubagentError} under the same conditions as {@link listChildren}.
 */
listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>

/**
 * Remote face of {@link listChildren} for one browser: the durable listing
 * plus live Agent activity and the delivery-time parent availability hint.
 * Parent availability is a hint; {@link prompt} performs the authoritative
 * check. Named apart from the provider-name {@link list}, which owns the
 * member.
 * @param parentSessionId - parent session whose direct children are listed.
 * @param signal - carrier cancellation forwarded to Session queries.
 * @returns the catalog view for that parent.
 * @throws {RemoteError} `gateway/bad-request` for an empty parent id,
 *   `gateway/cancelled` for an aborted read, `subagent/projections-unavailable` when
 *   the deployment has no projection registry, otherwise `gateway/internal`.
 */
@Remote('list') async remoteExportList(parentSessionId: SessionId, signal: AbortSignal): Promise<SubagentCatalog>

/**
 * Deliver one browser-authored message to a continuable child through the
 * exact live direct parent, retaining the caller-minted request identity and
 * validated browser zone on the accepted message. Success identifies the
 * message the child's FIFO inbox accepted; later execution is independent of
 * this call.
 * Image parts are admitted and persisted through the attachment store
 * before delivery, and the child's model must accept image input.
 * @param request - durable address, minted identity, content, and optional browser zone.
 * @param signal - carrier cancellation, owning the call until inbox acceptance.
 * @returns the accepted message's inbox identity.
 * @throws {RemoteError} `gateway/bad-request`, `subagent/attachment-invalid`,
 *   `subagent/invalid-time-zone`, `subagent/parent-unavailable`,
 *   `subagent/not-resumable`, `subagent/unauthorized`,
 *   `subagent/delivery-unavailable`, `gateway/cancelled`, or `gateway/internal`.
 */
@Remote('prompt') async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt>

/**
 * Remote face of {@link interrupt} under one durable parent address. No
 * catalog, history, persistence, or parent Agent lookup runs: the core
 * primitive alone authorizes the address against the live Activation, which
 * is what keeps a live child interruptible while its parent Agent is offline.
 * Absent, idle, and already-completed targets are accepted no-ops there.
 * @param childSessionId - durable child session id to interrupt.
 * @param parentSessionId - durable direct parent whose authority is claimed.
 * @param mode - required continuable-address discriminator.
 * @returns acknowledgement that the cancel signal was admitted, not that the target is quiescent.
 * @throws {RemoteError} `gateway/bad-request` for an empty id,
 *   `subagent/unauthorized` when the address does not own the live target,
 *   otherwise `gateway/internal`.
 */
@Remote('interruptByParent') interruptByParent( childSessionId: SessionId, parentSessionId: SessionId, mode: 'continuable', ): SubagentInterruptReceipt

/**
 * Register a provider under its name. Registration is effect-scoped and HMR
 * safe; removing a provider blocks new starts but does not revoke runs that
 * were already returned to their holders.
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

/**
 * List registered provider names in insertion order.
 * @returns the registered names.
 */
list(): string[]

/**
 * Establish a published child on the named provider. Capability and semantic
 * checks run before delegation. Provider ownership lasts until its promise
 * fulfills; a rejection therefore has no run for the caller to dispose and
 * emits no run lifecycle events. Post-publication turn and infrastructure
 * failures settle through the returned run.
 * @param name - the provider to use.
 * @param request - child label, prompt, parent, signal, and optional capabilities.
 * @returns the published holder-owned run.
 */
async start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
```

Types: [Agent](core.md) · [ContentBlock](llm-streaming.md) · [MessageId](llm-streaming.md) · [SessionId](core.md)

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)

<a id="subagent-events"></a>

### `subagent/*` events

<a id="subagentend--emit"></a>

#### `subagent/end` — emit

A published child settled. Scope-filtered dispatch uses the same delegating parent carrier as `subagent/start`, so the lifecycle pair reaches the same scoped audience.

```ts cordis-catalog
/**
 * A published child settled. Scope-filtered dispatch uses the same delegating
 * parent carrier as `subagent/start`, so the lifecycle pair reaches the
 * same scoped audience.
 * @param info - the run identity and terminal outcome.
 * @dshScopeScan unsupported
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

A provider established a published child. For in-process providers, `ctx.agents.get(info.id)` resolves during this notification. Scope-filtered dispatch keys the carrier by the delegating parent, so a parent-scoped listener observes only its own delegations. Paired with `subagent/end`.

```ts cordis-catalog
/**
 * A provider established a published child. For in-process providers,
 * `ctx.agents.get(info.id)` resolves during this notification.
 * Scope-filtered dispatch keys the carrier by the delegating parent, so a
 * parent-scoped listener observes only its own delegations. Paired with
 * `subagent/end`.
 * @param info - the provider and published child identity.
 * @dshScopeScan unsupported
 * @mode emit
 */
'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void
```

Types: [Scoped](scope.md)

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)
<!-- END GENERATED cordis-surface -->
