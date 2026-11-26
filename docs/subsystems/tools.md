# Tools

English | [中文](tools.zh.md)

The tool pipeline of [dsh-tools](../../packages/core/tools). [core.md](core.md) introduces `ToolDefinition` as the pipeline-authoring type shared by the core packages; the model-facing [`ToolSchema`](llm-streaming.md#the-model-request-and-result) wire type is declared with the model request. This page documents every `ToolDefinition` field, the typed schema DSL that builds it, the guarded execution types, and the UI-presentation types.

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts) · [`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts) · [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts)

## `ToolDefinition` — a registered tool

A `ToolSchema` (the model-facing fields) plus a mandatory canonical output declaration, the `execute` function, host-only scheduler metadata, an optional final-content callback, and optional UI presenters. The registry holds these; the loop dispatches calls through them. `projectToolSchema()` builds each model-facing `ToolSchema` by an explicit allowlist — `output`/`execute`/`projectContent`/`finalizeContent`/`timeoutMs`/`guidance`/`isConcurrencySafe`/`presentCall`/`presentResult` must never leak into a model request.

```ts type-equiv
/** Tool-owned canonical output contract used after the body returns a JSON value. */
interface ToolOutputDefinition {
  /** Raw supported JSON Schema enforced against every successful canonical value. */
  readonly schema: JsonSchemaNode
  /** Pure projection from validated arguments and value to Native/model content. */
  render(args: unknown, value: JsonValue): ContentBlock[]
  /** Pure replayable presentation projection for native and nested calls. */
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}
```

```ts type-equiv
/** A registered tool: its schema plus the execution function. */
interface ToolDefinition extends ToolSchema {
  /** Mandatory canonical output declaration. */
  readonly output: ToolOutputDefinition
  /**
   * Run one accepted call and return only its canonical lossless-JSON value.
   * Async work must observe or forward `exec.signal` and settle only after its
   * owned work reaches quiescence. The executor preserves caller cancellation
   * through around-dispatch signal replacement and does not abandon this
   * promise, but it cannot hard-kill same-process code.
   * @param args - losslessly snapshotted, frozen model arguments.
   * @param exec - execution identity, cancellation signal, and context deferral.
   * @returns the canonical value declared by `output.schema`.
   */
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  /**
   * Install execution-prepared content before `tools/post-execute` policies.
   * The callback is captured when the call starts and runs once for a
   * normalized outcome entering post-execute. Policy replacements remain
   * authoritative; pipeline failures that bypass post-execute skip projection.
   * @param exec - immutable execution identity and arguments.
   * @param result - normalized result before post-execute policy.
   * @returns replacement content, or undefined to preserve the renderer output.
   */
  projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Synchronous last-mile transform for model-facing content. The executor
   * snapshots this callback when execution starts and invokes it exactly once
   * for every normalized outcome, including pipeline failures that bypass
   * `tools/post-execute`, immediately before lossless materialization.
   * Returning `undefined` preserves the content; every other result field
   * remains executor-owned. The callback must be total and must not throw.
   * @param exec - immutable execution identity and arguments.
   * @param result - complete normalized outcome before materialization.
   * @returns replacement content, or `undefined` to preserve it.
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Cooperative tool-call timeout budget in milliseconds. Omit for no deadline.
   * Enforced by `@deepseek-ai/dsh-tool-call-timeout-policy` (a `tools/execute` wrapper); it
   * is NEVER sent to the model — `projectToolSchema()` keeps only name/description/
   * parameters. Declaring it asserts this tool forwards `exec.signal` to a
   * cooperative implementation that can reach quiescence when the signal aborts.
   */
  timeoutMs?: number
  /**
   * Existing system prompt guidance that `ctx.tools.register()` shows only
   * while the viewing scope's registrations resolve this definition; not for
   * new tools, which describe themselves in their schema. Registries other
   * than `ctx.tools` ignore it.
   */
  readonly guidance?: ToolGuidance
  /**
   * Pure synchronous classifier for overlap with sibling tool calls. Only
   * `true` opts in; omission, exceptions, non-`true` returns, and invalid
   * `defineTool` arguments are exclusive. This metadata is never model-visible.
   *
   * Opted-in executions must not mutate parent-owned state. Shared state must
   * tolerate concurrent dispatch; recorder races are permitted only when they
   * commute or fail closed. See the
   * [parallel-tool-call Agent Note](../../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)
   * for the full contract.
   * @param args - parsed arguments; `defineTool` validates before calling.
   * @returns Whether this call may join a parallel group.
   */
  isConcurrencySafe?(args: unknown): boolean
  /**
   * Optional: how to present the PENDING state of one call in a UI, derived from
   * the call's `args` (parsed arguments, `unknown` — the tool validates/narrows
   * its own input). Returns a {@link ToolCallView} (a `card`-tagged render intent),
   * or `undefined` (or omit the method) to fall back to a generic presentation
   * (title = tool name, raw args as input). Pure and side-effect-free: a UI may
   * call it during live streaming AND a session-log replay, so it must depend
   * only on `args`.
   */
  presentCall?(args: unknown): ToolCallView | undefined
  /**
   * Optional: how to present the COMPLETED state, given the same `args` and the
   * durable result projection (`content`, failure state, and optional `meta`). Returns a
   * {@link ToolResultView}, or `undefined` (or omit the method) to keep the
   * pending title and render the raw result content. Pure and side-effect-free
   * for the same replay reason.
   */
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```

```ts type-equiv
/**
 * Literal system prompt section that `ctx.tools.register()` registers with a
 * tool and renders only while the viewing scope's registrations resolve the
 * tool's definition. Under the shipped Native and PTC roots that is while the
 * scope can call the tool directly or in programs, so a restriction or a
 * nearer same-name definition hides it. It keeps the prompt text that existing
 * tools had; adding guidance is discouraged, and a new tool puts what the
 * model needs into its description and parameter descriptions
 * ([rationale](../../../../.agents/notes/implemented/architecture/2026-11-19-composable-tool-registries.md)).
 */
interface ToolGuidance {
  /**
   * Section name, `tool:<name>` by default. Tools naming the same section
   * share one section and must declare the same guidance; otherwise the
   * latest registration in the nearest registering scope decides it.
   */
  readonly section?: string
  /** Named section placement. */
  readonly order: PromptSectionOrderName
  /**
   * Section text, or a provider called with the names of the section's tools
   * whose definitions the viewing scope's registrations resolve, in name order.
   */
  readonly text: string | ((available: readonly string[]) => string)
  /** Notice for Sessions that saw the section once no registration of it remains. */
  readonly retirement?: string
}
```

`execute` receives `args: unknown` — a raw `ToolDefinition` validates its own input. First-party tools don't write that by hand; they use `defineTool`, which validates and narrows the arguments, infers the body return from `output.schema`, and types both output projectors. `finalizeContent` deliberately receives the immutable execution instead of typed arguments because invalid-input and outer pipeline failures reach it too; it may enforce a tool-owned content bound while preserving `isError`, canonical value, structured error identity, deferred contexts, and presentation metadata.

## The unified JSON-value schema DSL

Plugin authors use one vocabulary for typed parameters and typed output values. `ValueSchemaSpec` supports `string`, `number`, `integer`, `boolean`, `null`, `array`, `object`, author-only `json`, and exact-one `oneOf`; scalar `enum` and `const` values must match their node type. An explicit object node always declares `additionalProperties: true | false`. Parameter definitions remain an implicit open object property map, with `required: true` attached to each required property.

Source: [`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts)

```ts type-equiv
/** One author-facing schema for any lossless JSON value root. */
type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec
```

```ts type-equiv
/** One implicit parameter-root property, optionally required. */
type ParameterPropertySpec = ValueSchemaSpec & { required?: true }
```

```ts type-equiv
/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
  [key: symbol]: never
}
```

`{ type: 'json' }` infers `JsonValue` and compiles to an annotation-only unconstrained raw schema. Output roots can be objects, arrays, scalars, or null. `InferValue<S>` honors literal constraints and object openness through 16 container levels, then falls back to `JsonValue` instead of exhausting TypeScript's type-instantiation stack. `InferArgs<P>` turns per-property requiredness into required and optional string keys:

```ts type-equiv
/**
 * Infer the TypeScript value accepted by an author-facing value schema. Exact
 * inference is bounded to 16 container levels, then falls back to `JsonValue`.
 */
type InferValue<S> = InferValueAt<S, []>
```

```ts type-equiv
/** Infer the TypeScript argument object for an implicit parameter schema. */
type InferArgs<S> = InferProperties<S, []>
```

`defineTool({ name, description, parameters, output, execute, … })` ties parameter inference to `parameterSchemaSpecToJsonSchema()` and `validateArgs()`, and ties `execute`/`render`/`presentationMeta` to `InferValue<OutputSchema>`. Schema records contain only own enumerable string keys, and schema arrays are dense intrinsic arrays, so inference, compilation, and validation observe the same declaration. Inference stays exact through 16 container levels and then widens to `JsonValue`; runtime validation keeps walking the complete schema. `valueSchemaSpecToJsonSchema()` compiles output declarations through the same enforced raw subset. A parameter mismatch throws `ToolArgsError` (`INVALID_ARGS`); an invalid body or post-policy value throws `ToolOutputError` (`INVALID_TOOL_OUTPUT`). Both use the normal tool-error path. Raw JSON Schema remains open by default; unsupported keywords reject instead of being accepted without enforcement.

Registration is a trusted same-process contract. The registry borrows the typed definition as readonly input, requires `output`, validates its raw schema, and checks semantic requirements such as a positive finite `timeoutMs`; `projectToolSchema()` constructs the model-facing projection when building a request, so execution and presentation share one resolved definition without leaking callbacks onto the wire.

## `ToolRestriction` — one scope's live filter over what it inherits

`ToolRestriction` applies to the tools a scope inherits: the deployment-global layer plus every ancestor scope on its chain, including the entries those scopes include from other registries. The registry compiles readonly names into private sets, intersects multiple restrictions, then overlays the scope's OWN registrations and inclusions, which stay exempt so a delegated child keeps the tools it answers through. A deny-only filter admits later unlisted inherited tools, while an allow-list excludes them. An `allow` name must be one the scope inherits, including a tool listed by the unscoped view before an Agent sees it, so a provider can add the tool later under the restriction; `deny` accepts any name, so a scope can deny a tool before anything offers it.

```ts type-equiv
/**
 * Per-scope filter over inherited tools: global and ancestor registrations,
 * including entries an ancestor includes from another registry. Restrictions
 * intersect and do not affect the restricting scope's own contributions.
 */
interface ToolRestriction {
  /** Inherited tool names that stay visible; every other inherited tool is removed. */
  readonly allow?: readonly string[]
  /** Inherited tool names removed from visibility; a name nothing offers is accepted. */
  readonly deny?: readonly string[]
}
```

## Tool registries, roots, and model steps

A `ToolRegistry` is a set of directly callable entries. Including a registry reads its entries at every query, so the source keeps ownership of its definitions. A registry owns no batch execution; `ctx.tools.execute()` runs every batch.

```ts type-equiv
/**
 * A set of directly callable entries. Native registries expose their tools as
 * entries; a PTC registry exposes one program entry and calls its other tools
 * from programs. Registrations and inclusions return their exact disposers.
 * `ctx.tools.execute()` runs the entries of the selected root, so a registry
 * owns no batch execution of its entries.
 */
interface ToolRegistry {
  /**
   * Add one tool. A registry without scopes ignores the caller's scope.
   * @param tool - validated definition; duplicate names in the same place fail.
   * @returns the disposer that removes exactly this registration.
   */
  register(tool: ToolDefinition): () => void
  /**
   * Read another registry's entries at every query. The source keeps ownership
   * of its definitions; its later additions and removals appear in the next query.
   * @param registry - source whose `get()` and `getAll()` entries this registry includes.
   * @returns the disposer that removes exactly this inclusion.
   */
  include(registry: Pick<ToolRegistry, 'get' | 'getAll'>): () => void
  /**
   * Resolve one entry as a scope sees it.
   * @param name - entry name.
   * @param scope - viewing Agent or preset; omission selects the unscoped view.
   * @returns the entry, or undefined when the scope has none with that name.
   * @throws ToolCompositionError when the deciding scope has several candidates for the name or an inclusion cycles.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined
  /**
   * List the entries a scope sees. A registry lists every definition of a name
   * that has several, so a registry that includes it decides that name in its
   * own place. `get()` throws for such a name; `ctx.tools.getAll()` resolves
   * its root's listing and throws when a name still has several.
   * @param scope - viewing Agent or preset; omission selects the unscoped view.
   * @returns entries in registration order.
   * @throws ToolCompositionError when an inclusion cycles, or, for `ctx.tools`, when a name has several definitions.
   */
  getAll(scope?: ScopeKey): readonly ToolDefinition[]
}
```

Each scope selects one **root** registry with `ctx.tools.setRoot()`, and `ctx.tools` routes to it. `ctx.tools.register()` and `include()` contribute to the calling scope; the contribution reaches the root that scope selects and every root selected below it, and roots that load later receive the contributions made before them. The nearest scope offering a name decides it, and a scope's restrictions apply to what it inherits; one scope offering two different definitions under one name, or an inclusion cycle, fails as `ToolCompositionError` (`INVALID_TOOL_COMPOSITION`). A registry lists every definition of a conflicting name, and only the place that decides the name fails on it: a nearer scope offering the name shadows the conflict, and a registration or inclusion fails only for the names it contributes. `ctx.tools.get()` and `getAll()` return the selected root's entries for the viewing scope. A native root offers every tool the scope sees as an entry; a PTC root binds them in programs and offers one entry, `run_code`, so under it `ctx.tools.getAll()` is `[run_code]`. The nearest root wins, and an unloaded root stays selected so lookups and calls fail as `ToolRegistryUnavailableError` (`TOOL_REGISTRY_UNAVAILABLE`) instead of reaching another root; a scope without any root fails the same way. A root must not include or read `ctx.tools`: `setRoot()` rejects such a root as `INVALID_TOOL_COMPOSITION`, and a root, or a registry the root includes, that reads it later fails the lookup or call that reaches the read the same way, while a registry included in `ctx.tools` that reads it fails as an inclusion cycle; a root selected again keeps its one inclusion of the registrations, and selecting or unloading a root emits `tools/change`. A registry can also be included as one tool: Standard includes CUA's private PTC registry, whose `cua_run_code` entry binds only `cua`.

A tool section that is shown only while its tool is available is the definition's `guidance`; the filesystem, search, `apply_patch`, schedule, on-demand MCP catalog, and delegation sections are. `ctx.tools.register()` registers it in the same effect as the tool and renders it only while the viewing scope's registrations resolve that definition, which under the shipped Native and PTC roots means while the scope can call the tool directly or in programs, so a restriction or a nearer same-name definition hides it. Tools naming one `section` share it and must declare the same guidance, because the latest registration in the nearest registering scope decides it. Other tool sections, such as `tool:bash`, stay when their tool is restricted ([limitations](../../packages/core/tools/README.md#known-limitations-and-deferred-work)). New guidance is discouraged; a tool describes itself in its schema ([rationale](../../.agents/notes/implemented/architecture/2026-11-19-composable-tool-registries.md)). Guidance may mention another plugin's tool without checking whether it is registered.

Before each model step, AgentLoop captures `ctx.tools.getAll(agent)` as a `ToolStep`. The step's prompt declares those entries; its batch and nested program calls execute only them, and a PTC root pins the bindings it declares for the step. Calls to a same-name replacement or to a tool added while the model responds therefore fail as `UNKNOWN_TOOL` until the next step, and so do calls to a declared tool that its provider removes or withdraws for the Agent. A model-direct call to a tool the root binds only in programs fails as `UNKNOWN_TOOL` before `tools/pre-execute`, approval, guards, and execution wrappers, and the message names the entries the step can call, so the model sees the program entry. Dispatch runs exactly the definition captured when the call was prepared. Providers that offer a tool to individual Agents include an `AgentToolRegistry` and call `set(agent, names)` when the Agent's state changes; a step captures the tools set before it starts. Web tools update when the Agent's model route, a credential, or the Web providers change; Plan, Office, and Team update on their own state changes.

`ctx.tools.execute()` runs a complete raw model-call batch against the entries of the Agent's selected root, or the deployment root for a standalone call; an accepted batch settles through the root it started with even if that root unloads. Each execution record carries the `definition` its call resolved, so policies read the definition instead of looking the name up again. A composition failure fails only its call. One met while the call is prepared fails it before policy; dispatch repeats the lookup, so one first met there fails the call after `tools/pre-execute`, approval, guards, and `tools/execute` wrappers, and `tools/post-execute` sees it. Either way the result tells the model the tool is misconfigured, and the deployment log records the failure's message, which names the conflicting definitions when the failure is an ambiguity. `agent` is absent for standalone service calls; `log` is absent for programmatic calls outside a model step, such as initialization hooks. An Agent without `log` still scopes tool access but produces no root call/result events. Tool-owned events may still use its Session.

```ts type-equiv
/** Raw model calls, with optional Agent ownership and model-step logging. */
interface ToolBatchInput {
  readonly calls: readonly ToolCallBlock[]
  readonly signal: AbortSignal
  /**
   * Positive integer limiting how many concurrency-safe calls of this batch run
   * at once; program call limits remain separate. Undefined allows
   * `DEFAULT_MAX_PARALLEL_TOOL_CALLS` from `@deepseek-ai/dsh-tools/pipeline`.
   */
  readonly maxParallelToolCalls?: number
  /**
   * Owning Agent supplies scoped tools and execution context, including outside a turn.
   * Undefined for standalone calls outside an Agent, such as a service invocation.
   */
  readonly agent?: Agent
  /**
   * Model step whose declarations admit the calls, including program calls.
   * A call whose current entry differs from the declared one fails as `UNKNOWN_TOOL`.
   * Undefined resolves the root's current entries.
   */
  readonly toolStep?: ToolStep
  /**
   * Committed model step receiving root call/result events; requires `agent`.
   * Undefined when `agent` is absent or for calls outside a model response, such
   * as session initialization hooks. Without `log`, root call/result events are
   * omitted while `agent`, when provided, still supplies scope and execution context.
   */
  readonly log?: {
    readonly turn: number
    readonly step: number
  }
}
```

```ts type-equiv
/** One settled result correlated with its original model call. */
interface ToolCallResult {
  readonly callId: ToolCallId
  readonly result: ToolExecutionResult
}
```

```ts type-equiv
/** Model-ordered outcomes and context accepted for the next step. */
interface ToolBatchResult {
  readonly results: readonly ToolCallResult[]
  readonly additionalContexts: readonly UserMessage[]
  readonly concluded: boolean
}
```

## Execution: extensible waterfalls plus monotonic policy

`ctx.tools.execute()` and the PTC registry's program calls pass parsed `ToolExecutionInput` values to the shared `ToolExecutionPipeline`. The pipeline owns argument snapshots, execution identities, policy waterfalls, dispatch, and final-result notification, returning one `ToolExecutionResult` per invocation. The public `ToolRegistry` has no batch execution: `ctx.tools.execute()` runs model-direct batches through the entries of the selected root, and a PTC registry runs its programs' calls through its own pipeline.

```ts type-equiv
/** Opaque call identity that permits correlation without exposing mutable execution state. */
type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }
```

```ts type-equiv
/**
 * Parsed input to the shared invocation pipeline. The pipeline
 * adds its own token to form a {@link ToolExecution};
 * callers do not choose that token.
 */
interface ToolExecutionInput {
  readonly callId: ToolCallId
  /**
   * Root model-requested call owning this execution tree. Callers omit it for
   * a root execution; nested dispatchers propagate the enclosing value.
   */
  readonly rootCallId?: ToolCallId
  readonly name: string
  /** Binding-time tool schema for a PTC inner call; frozen by its producer and never logged. */
  readonly schema?: ToolSchema
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: Agent
  /**
   * Model step whose declarations admit this call and its nested program calls.
   * A call outside a model step omits it and resolves the registry's current entries.
   */
  readonly toolStep?: ToolStep
  /**
   * Opaque token of the enclosing program execution, when one exists. A PTC
   * registry sets this on program calls so commit-style observers can wait for
   * the outer program outcome without receiving its live mutable execution.
   * The token also marks the call as a program call rather than a model-direct
   * call: `ctx.tools.execute()` runs only model-direct calls, and one naming a
   * tool that the selected root offers only inside programs fails as
   * `UNKNOWN_TOOL` before the policy pipeline.
   */
  readonly parent?: ToolExecutionToken
  /** Required caller-owned cancellation for this invocation. */
  readonly signal: AbortSignal
}
```

A tool body receives the runtime extension. `deferContext()` attaches context to the execution's own result — the composite-tool nested-dispatch channel, also usable by a leaf tool minting a plugin-sourced instruction — without injecting inside the still-open outer call.

```ts type-equiv
/**
 * Runtime context handed to a tool implementation after the executor has
 * accepted a {@link ToolExecution}. {@link deferContext} attaches context to
 * this execution's own result — a composite tool ferries nested-dispatch
 * context back to the outer result, and a leaf tool may mint a fresh
 * plugin-sourced instruction; the loop appends it only after the
 * `tool/result`.
 */
interface ToolRunContext extends ToolExecution {
  /**
   * Defer one context — typically a nested-dispatch context ferried by a
   * composite tool, or a fresh plugin-sourced instruction — until this tool's
   * final result reaches the agent loop. Contexts retain their individual
   * source and metadata and are emitted in call order.
   */
  deferContext(context: UserMessage): void
  /**
   * Mark a successful final result as terminal for the current agent turn.
   * The marker rides this execution's own result (`concludesTurn` exists only
   * on {@link ToolExecutionSuccess}); a composite that dispatches nested
   * calls forwards it from the nested result, exactly like
   * `additionalContexts`, so only an authoritative nested success can
   * conclude the enclosing run.
   */
  concludeTurn(): void
}
```

The agent loop asks the registry for each pending call's execution mode and uses it to form exclusive barriers and rolling-pool parallel runs:

```ts type-equiv
/**
 * Scheduling mode for one pending call. `parallel` may overlap with siblings;
 * `exclusive` runs alone and forms an ordering barrier.
 */
type ToolExecutionMode =
  | { kind: 'parallel' }
  | { kind: 'exclusive' }
```

PTC bindings freeze their ToolSchema at construction and pass it through the scheduler into `ToolExecution.schema`; it is transient execution metadata. Before policy, each actually started sub-dispatch records only pairing ids, name, and normalized arguments. Neither start nor settle events serialize description, parameters, or schema. The bridge later exposes the settled call to the `tools/ptc-dispatch-log` waterfall, which may change the durable content copy while preserving the program value, model-visible outer result, and structured failure identity:

```ts type-equiv
/**
 * One settled `run_code` sub-dispatch about to be logged, as seen by the
 * `tools/ptc-dispatch-log` waterfall: the parent execution (session owner,
 * outer call identity), the sub-call identity, and the outcome whose durable
 * copy a listener may reshape. `content` is the RENDERED result projection
 * (what a native `tool/result` would carry) — the program itself received
 * the structured `value` (or just the error message on failure); only the
 * `tool/ptc-dispatch` event's copy changes.
 */
interface PtcDispatchLog {
  /** The outer `run_code` execution. */
  readonly exec: ToolExecution
  /** The calling agent (the scope routing key and the spill owner), when the outer call has one. */
  readonly agent?: Agent
  /** Opaque sub-call id; new calls use `<parent>:ptc:<n>`. */
  readonly subCallId: ToolCallId
  /** The dispatched sub-tool name. */
  readonly name: string
  /** Whether the sub-call settled as an error. */
  readonly isError: boolean
  /** The sub-call's complete model-facing content (the settle event's default payload). */
  readonly content: ContentBlock[]
}
```

```ts type-equiv
/**
 * One pending tool call inside the executor pipeline. Parsed arguments cross
 * one lossless-JSON materialization boundary before policy and are deep-frozen;
 * call identity, the caller signal, and the executor-assigned {@link token} are
 * readonly. The executor freezes the complete object before `tools/result`
 * observers run.
 */
interface ToolExecution extends ToolExecutionInput {
  /** Root model-requested call, resolved for every root and nested execution. */
  readonly rootCallId: ToolCallId
  /** Executor-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: ToolExecutionToken
  /**
   * The definition the registry resolved for this call, captured before policy
   * runs. Absent when no visible definition has the name or when the call's
   * model step declared a different definition; that call fails as
   * `UNKNOWN_TOOL`. Dispatch runs exactly this definition: when the registry
   * no longer offers it as dispatch starts, the call fails as `UNKNOWN_TOOL`.
   */
  readonly definition?: ToolDefinition
}
```

```ts type-equiv
/**
 * Around-dispatch view of a {@link ToolExecution}. A `tools/execute` wrapper
 * may replace the signal for its delegated lifetime, but it cannot remove it.
 * The executor fuses every replacement with the captured caller signal.
 */
interface ToolDispatchExecution extends Omit<ToolExecution, 'signal'> {
  /** Cancellation signal visible to the next wrapper or tool body. */
  signal: AbortSignal
}
```

`ToolExecutionToken` is an opaque runtime `Symbol` used only for identity comparison. Before policy, `execute()` materializes and freezes arguments, rejects non-JSON input, and assigns the token. Identity fields, the required caller signal, and the optional parent token remain readonly. A `ToolDispatchExecution` wrapper may replace but not remove the signal; the registry re-fuses the caller signal before invoking the body. Final observers receive the frozen execution identity.

A `ToolGuard` is scope-aware final pre-dispatch policy. Its return type deliberately has no allow result: `undefined` preserves the waterfall decision, while a returned reason or `ToolGuardDenial` can only reduce permission, so a later listener cannot undo it. A denial's optional `info` becomes the failed result's structured error identity.

```ts type-equiv
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 * @param execution - the identity-protected call after extensible pre-execute policy completed.
 * @returns a final denial reason, a denial with structured error identity, or `undefined` to leave the call allowed.
 */
type ToolGuard = (execution: Readonly<ToolExecution>) => string | ToolGuardDenial | undefined
```

```ts type-equiv
/** A guard denial: the model-facing reason and optional structured error identity recorded on the result. */
interface ToolGuardDenial {
  /** Model-facing reason rendered as the failed call's content. */
  readonly reason: string
  /** Structured error identity persisted beside the reason. */
  readonly info?: ToolErrorInfo
}
```

```ts type-equiv
/** Canonical failure detail; internal routing information remains optional. */
interface ToolFailure {
  /** Human-readable failure message without the Native `Error: ` envelope. */
  message: string
  /** Internal error class/code used by policy and durable diagnostics. */
  info?: ToolErrorInfo
}
```

```ts type-equiv
/** Successful canonical tool execution, including its Native/model projection. */
interface ToolExecutionSuccess {
  readonly isError: false
  /** Execution-local canonical value; deliberately omitted from durable events. */
  readonly value: JsonValue
  readonly content: ContentBlock[]
  readonly error?: never
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  /** The agent loop stops after committing this successful result batch. */
  readonly concludesTurn?: true
}
```

```ts type-equiv
/** Failed canonical tool execution; failures never carry a successful value. */
interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure
  readonly value?: never
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: never
}
```

```ts type-equiv
/** The discriminated, execution-local outcome of one tool call. */
type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure
```

```ts type-equiv
/** Structured error metadata for a failed tool call (alongside the model-facing text). */
interface ToolErrorInfo {
  name: string
  code: string
  /** Optional raw user-facing detail; durable projections preserve it but model-facing content does not include it. */
  reason?: string
}
```

The result carries only the outcome. Call identity remains on the immutable `ToolExecution` that accompanies it through every hook and on the durable `tool/call` / `tool/result` session events, so wrappers cannot create a second, disagreeing identity. The canonical `value` is execution-local: the loop persists only `content`, `error`, and `meta`, while `tool/ptc-dispatch` stores the sub-call's rendered `content`, `isError`, optional structured `error`, and presentation `meta`. Replay reproduces presentation but cannot reconstruct canonical intermediate values. Optional `ToolErrorInfo.reason` retains raw user-facing detail without adding it to model-facing content. The registry sets `info` from a thrown `HarnessError` (its `name` and `code`), from a pre-execute `deny` that supplies it, and on its own cancellation results (`AbortError` with `ABORTED` or `ABORTED_BEFORE_DISPATCH`); when a started body throws the signal's reason or an `Error` named `AbortError` after cancellation, the result keeps that message and carries `AbortError` with `ABORTED`, and a `tools/execute` wrapper that throws such a value after caller cancellation gets the same identity, with `ABORTED_BEFORE_DISPATCH` when the body never started; a `tools/execute` wrapper may also return a result with `info`, such as the timeout policy's `TOOL_TIMEOUT`. An `ask` that approval does not grant becomes a denial with the name `ApprovalError`, which identifies the registry's denial and is not a thrown class, and `APPROVAL_REJECTED`, `APPROVAL_CANCELLED`, or `APPROVAL_UNAVAILABLE`. A guard denial or post-execute block carries `info` only when it supplies one; any other thrown value produces an `error` without `info`.

On success the registry snapshots and validates the body value, freezes it, and invokes the pure renderer plus the optional presentation metadata projector for native and nested calls. It separately materializes the durable presentation fields immediately before `tools/result`; an invalid value, renderer/projector failure, or non-JSON presentation becomes a JSON-safe `isError`. The final live observer therefore sees the exact execution-local value beside fields safe for the later durable append.

Before final content, the registry materializes the candidate result; a failure in content, structured error, additional context, or presentation metadata becomes a JSON-safe `isError` result that still reaches `finalizeContent`. The registry invokes that callback exactly once, then materializes and freezes the accepted result immediately before `tools/result`, so the observed live outcome is safe for the later durable `tool/result` append.

Each interception waterfall returns a typed **Decision** (the idiom shared with the `agent/*` waterfalls). `tools/pre-execute` listeners receive `(exec, next)` and return a `PreToolDecision`; `tools/execute` wrappers return a `ToolExecutionResult`; `tools/post-execute` listeners receive `(exec, result, next)` and return a `PostToolDecision`:

```ts type-equiv
/**
 * Pre-dispatch decision. `allow` runs the call; `deny` materializes its
 * model-facing reason and optional structured error identity; `cancel` selects
 * the canonical cancellation result without presenting a policy denial; `ask`
 * runs only after an approval service returns `allowed-once` and otherwise
 * denies; its `reason` is the audited approval reason and its optional
 * `displayReason` is the localized prompt text. Input rewriting is excluded because arguments are already logged and
 * presented.
 */
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } }
```

```ts type-equiv
/**
 * Post-dispatch decision: accept, replace one projection, attach context for the
 * next request, or block by turning corrective feedback into an error result
 * whose optional `info` is its structured error identity.
 */
type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; info?: ToolErrorInfo; additionalContexts?: UserMessage[] }
```

Call `next()` for the default or return a decision to short-circuit. Pre-policy may deny or ask; only `allowed-once` proceeds, while a non-grant, missing approval channel or service, or agent-less request becomes a denial. A deny may attach structured identity and user-facing detail without changing its model-facing reason. Guards may still impose a final denial. Arguments cannot be rewritten because history, audit, UI, and execution must agree.

Post-policy may replace either content or value, never both. Content replacement preserves the canonical value and existing metadata; value replacement is revalidated and recomputes content/metadata; a block removes the value and becomes an `isError` containing corrective feedback. Content replacement is presentation policy, not confidentiality policy: a listener that must hide the programmatic value blocks or replaces it. `tools/result` receives the frozen execution and result after normalization; observers cannot transform them, and observer failures are contained. Unknown and throwing tools both become structured errors (`ToolNotFoundError` maps to `UNKNOWN_TOOL`), so the call fails without ending the turn. A tool body whose composition or call lacks a required Agent, service, or open turn throws `ToolContextUnavailableError` (`TOOL_CONTEXT_UNAVAILABLE`).

## The enforced raw JSON Schema subset

Raw schemas from subagents, workflows, MCP, and dynamic registrations use the wire-level counterpart of the author DSL. `assertSupportedJsonSchema()` accepts any JSON root, `validateJsonSchemaValue()` enforces it, and `JsonSchemaError` reports every unsupported or malformed schema path. The empty annotation-only node means unconstrained lossless JSON. `oneOf` requires at least two branches and a value must match exactly one. Consumers that still require an object root call `assertObjectJsonSchema()` and carry `ObjectJsonSchema`; this is how subagent/workflow caller-defined structured output remains object-rooted without restricting the shared vocabulary.

```ts type-equiv
/** Scalar JSON values supported by `enum` and `const`. */
type JsonSchemaScalar = string | number | boolean | null
```

```ts type-equiv
/** Single-type keywords accepted by the enforced subset. */
type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
```

```ts type-equiv
/**
 * One raw JSON Schema node in the enforced subset. The optional fields express
 * the external wire schema; {@link assertSupportedJsonSchema} rejects invalid
 * combinations before a caller treats the node as trusted.
 */
interface JsonSchemaNode {
  /** Omit with no constraints for any JSON value, or use `oneOf`. */
  type?: JsonSchemaType
  /** Exactly one branch must validate; at least two branches are required. */
  oneOf?: JsonSchemaNode[]
  /** Nested property schemas (`type: 'object'` only). */
  properties?: Record<string, JsonSchemaNode>
  /** Required property names; each must appear in `properties`. */
  required?: string[]
  /** `false` rejects undeclared keys; absent/`true` follows JSON Schema's open default. */
  additionalProperties?: boolean
  /** Item schema (`type: 'array'` only); absent accepts any JSON item. */
  items?: JsonSchemaNode
  /** Allowed values for a scalar node. */
  enum?: JsonSchemaScalar[]
  /** The single allowed value for a scalar node. */
  const?: JsonSchemaScalar
  /** Annotation, ignored for validation. */
  description?: string
  /** Annotation, ignored for validation. */
  title?: string
  /** Annotation, ignored for validation but required to be lossless JSON. */
  default?: JsonValue
  /** Annotation, ignored for validation but required to be lossless JSON. */
  examples?: JsonValue
}
```

```ts type-equiv
/** A consumer-constrained object-rooted schema. */
type ObjectJsonSchema = JsonSchemaNode & { type: 'object' }
```

## Tool-presentation UI vocabulary

How a tool wants its call shown in a UI (an editor tool-call card, a CLI log line), provider-neutral so a tool describes itself without depending on any client protocol. `presentCall`/`presentResult` return a **`card`-tagged render intent** — a discriminated union a UI bridge switches on:

- `ToolCallView` (pending): `{ card: 'generic', title, kind?, rawInput?, content?, locations? }` (the default card; `locations` is `{ path, line? }[]` files the call reads/modifies, for editor follow-along), `{ card: 'terminal', title, description?, cwd? }` (a shell command → a terminal card), or `{ card: 'diff', title, diffs, locations? }` (a file create/modify → an inline diff card; `diffs` is `{ path, oldText, newText }[]`, `oldText: null` for a new file).
- `ToolResultView` (completed): `{ card: 'generic', title?, content? }`, `{ card: 'terminal', title?, output?, exitCode?, signal? }` (the captured run output + exit; a capable UI shows an exit-status pill, while another may derive a fenced ` ```console ` fallback), `{ card: 'diff', title?, diffs }` (a completed file mutation → the change to show, typically the applied hunks with context lines computed from the before/after content, or a whole-file diff when there is no before-image), `{ card: 'search', shape, title?, truncated, total, … }` (a completed discovery search → grouped-by-file matches for `shape: 'matches'` (grep) or a flat path list for `shape: 'paths'` (glob); `truncated`/`total` report whether the inline result was capped so a UI never presents a partial result as complete; the view carries no result text — a UI without a search card falls back to the raw result content), `{ card: 'read', title?, path, offset, lines, totalLines, lang?, content? }` (a completed file read → a line-numbered, optionally syntax-highlighted code view; `offset` is the 1-based first line the window requested, kept even when `lines` is empty; `lang` is a language hint from the extension, and `content` is the envelope-stripped text a UI without read support falls back to), or `{ card: 'web', kind: 'search' | 'fetch', title?, … }` (a completed web retrieval; `kind: 'search'` carries the structured `sources`/`answer?`/`truncated`, `kind: 'fetch'` carries `url`/`statusCode`/`truncated`, and a UI without the `web` capability falls back to the raw result content — the body is not duplicated into the view). Completed views replace pending views, so mutation tools return a diff result even when it duplicates the call-time snippet; a search and a web retrieval have no `card` call-time analogue (their pending state stays a generic card, since the structured result exists only after `execute`).

`ToolCallKind` (`'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'`) picks an icon on a generic card. `FileLocation` (`{ path, line? }`), `FileDiff` (`{ path, oldText, newText }`), and `ReadFileLine` (`{ number, text }`, one 1-based numbered line of a read window) are the shared file-card vocabulary. The design is pinned in [the render-intent-union Agent Note](../../.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.md); host/client runtimes project this neutral vocabulary into their own views.

The full presentation field docs live in [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts). The `bash` schema and executor are on [shell.md](shell.md); generic background controls are on [jobs.md](jobs.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtools--toolsservice"></a>

### `ctx.tools` — `ToolsService`

`ctx.tools`: routes scoped tool contributions to the root registry each scope selects, answers lookups and dispatch from that root, and applies scoped restrictions and guards. A root receives the registrations its scope sees when it is selected; a native root offers them as model entries, and a PTC root binds them in programs.

```ts cordis-catalog
/**
 * Register in the calling scope. The tool reaches the root the scope
 * selects and the roots its descendant scopes select: a native root offers
 * it as an entry, a PTC root binds it in programs. Nearer scopes shadow
 * farther ones; duplicates within one scope, a name an inclusion in the
 * scope already offers, and the reserved `run_code` name fail. A tool's
 * `guidance` registers its system prompt section in the same effect; the
 * section renders while the viewing scope's registrations resolve the tool.
 * @param tool - tool schema, execution, and optional finalization, presentation, or guidance.
 * @returns the exact disposer that unregisters the tool and its guidance.
 * @throws ToolCompositionError when the scope's inclusions already offer another definition with the name.
 */
register(tool: ToolDefinition): () => void

/**
 * Include another registry's entries in the calling scope; they reach roots
 * as registrations do. Each query reads the source for the viewing scope.
 * Descendant scopes inherit the entries, so their restrictions apply; the
 * including scope's own restrictions do not.
 * @param registry - source that keeps ownership of its definitions.
 * @returns the exact disposer that removes this inclusion.
 * @throws ToolCompositionError when the scope already offers another definition under one of the source's names,
 * when the source itself offers several definitions under one of them, or when the source includes this service.
 */
include(registry: Pick<ToolRegistry, 'get' | 'getAll'>): () => void

/**
 * Restrict inherited tools for the calling scope. Restrictions intersect;
 * the scope's own registrations and inclusions stay visible. `allow` names
 * must be ones an inherited registration or inclusion can offer; an
 * inclusion contributes its unscoped entries, so a tool a provider adds to
 * Agents later can be allowed in advance. `deny` accepts any name, so a
 * scope can deny a tool before anything offers it.
 * @param filter - inherited-tool mask: `allow` (keep only) and/or `deny` (remove).
 * @returns the exact disposer that lifts this restriction.
 * @throws Error when the context is unscoped, the filter is empty, a name is `run_code`, or an `allow` name is not inherited.
 */
restrict(filter: ToolRestriction): () => void

/**
 * Resolve one entry of the root a scope selects: a native root resolves the
 * scope's registrations, a PTC root only its program entry.
 * @param name - entry name.
 * @param scope - the viewing scope (the agent); omitted reads the root the unscoped context selects.
 * @returns the root's entry, or undefined when the root has none with that name.
 * @throws ToolRegistryUnavailableError when the scope's selected root is missing or unloaded.
 * @throws ToolCompositionError when the deciding scope offers several definitions, or when the root
 * or an included registry reads `ctx.tools`.
 */
get(name: string, scope?: ScopeKey): ToolDefinition | undefined

/**
 * List the entries of the root a scope selects, which its model steps
 * declare: a native root lists the scope's registrations after shadowing and
 * restrictions, a PTC root only its program entry.
 * @param scope - the viewing scope (the agent); omitted reads the root the unscoped context selects.
 * @returns the root's entries.
 * @throws ToolRegistryUnavailableError when the scope's selected root is missing or unloaded.
 * @throws ToolCompositionError when a visible name has several definitions in its deciding scope, or
 * when the root or an included registry reads `ctx.tools`.
 */
getAll(scope?: ScopeKey): readonly ToolDefinition[]

/**
 * Select the root registry for the calling scope; an unscoped call selects
 * the root for every scope without its own. Agents use the nearest selected root. The
 * root includes the registrations each viewing scope sees, and keeps them
 * after unloading so accepted batches settle their calls; selecting the
 * same registry again does not include them twice. A root must not include
 * or read `ctx.tools`: such a read fails with `ToolCompositionError` when
 * the root is selected or, for a root that reads it later, in the lookup or
 * batch that reaches it. Register tools through `ctx.tools`: a tool
 * registered directly in a root skips the scope's conflict check, so another
 * definition registered under its name through `ctx.tools` is accepted and
 * the next `ctx.tools.getAll()` throws. Selecting or unloading a root emits
 * `tools/change`; an observer that throws fails the selection, which
 * restores the scope's earlier selection, or none, and emits `tools/change`
 * again.
 * @param registry - initialized root owned by the contributing plugin.
 * @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
 * @throws Error when the calling scope already has a live root.
 * @throws ToolCompositionError when the root's own entries conflict with the registrations, or when the root reads `ctx.tools`.
 * @throws the error a `tools/change` observer throws for the selection.
 */
setRoot(registry: ToolRegistry): () => void

/**
 * Execute a complete batch of calls to the entries of the root the Agent
 * selects, or the unscoped context's root for a standalone call. Each call runs the entry the root
 * resolves for the Agent; with a model step, only the exact entry the step
 * declared, and any other call fails as `UNKNOWN_TOOL`. A call naming a
 * tool the Agent can reach only from the root's entries, such as a program
 * binding, fails as `UNKNOWN_TOOL` before `tools/pre-execute`, approval,
 * guards, and execution wrappers, and its message names the entries the
 * Agent can call directly. An accepted batch settles through the root it
 * started with even if that root unloads. With log, root call/result events are committed to
 * the Agent's Session; without log, they are omitted. One outcome is
 * returned per input call in input order, including skipped calls on abort,
 * and the batch never settles while started work is still running.
 * Internal failures reject with ToolBatchExecutionError after draining,
 * preserving committed outcomes and context; callers must stop dependent
 * work and repair missing log results.
 * @param input - original calls, cancellation, optional concurrency override, Agent, model step, and logging step.
 * @returns settled results, deferred context, and whether a success concludes the turn.
 * @throws ToolRegistryUnavailableError when the Agent's selected root is missing or unloaded.
 */
async execute(input: ToolBatchInput): Promise<ToolBatchResult>

/**
 * Register a monotonic denial in the calling scope.
 * @param guard - evaluated after extensible pre-execute policy by the shared pipeline.
 * @returns the effect disposer that removes this guard.
 */
guard(guard: ToolGuard): () => void

/**
 * Check global and inherited guards after pre-execute policy and approval resolve.
 * @param exec - invocation whose guards are checked before dispatch.
 * @returns the first denial with its optional structured identity, or undefined when no guard denies.
 */
checkGuards(exec: ToolExecution): ToolGuardDenial | undefined
```

Types: [ScopeKey](scope.md)

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts)

<a id="tools-events"></a>

### `tools/*` events

<a id="toolschange--emit"></a>

#### `tools/change` — emit

A tool was registered or unregistered, a registry inclusion changed, a scoped restriction changed, or a root registry was selected or unloaded. Entries an included registry adds or removes later do not emit this event. When `ctx.tools` emits it for a registration, inclusion, restriction, or root selection, a listener that throws fails that contribution, which is undone and emits this event again; a removal is not undone. Another producer may handle a listener failure differently, for example by logging it. Unfiltered registry notification: scoped listeners receive changes from every scope because a global contribution can affect every agent's next assembly.

```ts cordis-catalog
/**
 * A tool was registered or unregistered, a registry inclusion changed, a
 * scoped restriction changed, or a root registry was selected or unloaded.
 * Entries an included registry adds or removes later do not emit this
 * event. When `ctx.tools` emits it for a registration, inclusion,
 * restriction, or root selection, a listener that throws fails that
 * contribution, which is undone and emits this event again; a removal is
 * not undone. Another producer may handle a listener failure differently,
 * for example by logging it. Unfiltered
 * registry notification: scoped listeners receive changes from every scope
 * because a global contribution can affect every agent's next assembly.
 * @mode emit
 */
'tools/change'(): void
```

Source: [`packages/core/tools/src/events.ts`](../../packages/core/tools/src/events.ts)

<a id="toolsexecute--waterfall"></a>

#### `tools/execute` — waterfall

Around-dispatch waterfall for timeout, retry, or metrics. `next()` returns a normalized result; wrappers may change only `exec.signal`, while call identity remains immutable. The registry re-fuses the original caller signal before the body, so replacement cannot detach caller cancellation; wrappers must still restore their signal and reach quiescence. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.

```ts cordis-catalog
/**
 * Around-dispatch waterfall for timeout, retry, or metrics. `next()` returns
 * a normalized result; wrappers may change only `exec.signal`, while call
 * identity remains immutable. The registry re-fuses the original caller
 * signal before the body, so replacement cannot detach caller cancellation;
 * wrappers must still restore their signal and reach quiescence.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
 * @param exec - the allowed call about to dispatch (name, parsed arguments, caller agent, signal).
 * @mode waterfall
 */
'tools/execute'(this: Scoped<ToolsService>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
```

Types: [Scoped](scope.md)

Source: [`packages/core/tools/src/events.ts`](../../packages/core/tools/src/events.ts)

<a id="toolspost-execute--waterfall"></a>

#### `tools/post-execute` — waterfall

Accept, replace, enrich, or block a normalized dispatch result. `next()` accepts it unchanged; thrown tools still reach this waterfall as errors. Async listeners must observe `exec.signal`; after they settle, caller cancellation replaces only a successful accepted outcome with the code selected by whether the tool body was invoked. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.

```ts cordis-catalog
/**
 * Accept, replace, enrich, or block a normalized dispatch result. `next()`
 * accepts it unchanged; thrown tools still reach this waterfall as errors. Async
 * listeners must observe `exec.signal`; after they settle, caller
 * cancellation replaces only a successful accepted outcome with the code
 * selected by whether the tool body was invoked.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
 * @param exec - the call that just ran (name, parsed arguments, caller agent).
 * @param result - the dispatch outcome a listener may accept, replace, or block.
 * @mode waterfall
 */
'tools/post-execute'(this: Scoped<ToolsService>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
```

Types: [Scoped](scope.md)

Source: [`packages/core/tools/src/events.ts`](../../packages/core/tools/src/events.ts)

<a id="toolspre-execute--waterfall"></a>

#### `tools/pre-execute` — waterfall

Allow, deny, cancel, or ask before dispatch. `next()` delegates to allow; `cancel` selects the canonical pre-dispatch cancellation result, and missing approval support turns `ask` into denial. Async gates must observe `exec.signal`; the registry rechecks cancellation after they settle but never abandons their promise. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.

```ts cordis-catalog
/**
 * Allow, deny, cancel, or ask before dispatch. `next()` delegates to allow;
 * `cancel` selects the canonical pre-dispatch cancellation result, and missing
 * approval support turns `ask` into denial. Async gates must observe
 * `exec.signal`; the registry rechecks cancellation after they settle but
 * never abandons their promise.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
 * @param exec - the pending call (name, parsed arguments, caller agent).
 * @mode waterfall
 */
'tools/pre-execute'(this: Scoped<ToolsService>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
```

Types: [Scoped](scope.md)

Source: [`packages/core/tools/src/events.ts`](../../packages/core/tools/src/events.ts)

<a id="toolsptc-dispatch-log--waterfall"></a>

#### `tools/ptc-dispatch-log` — waterfall

Allow a listener to replace content in the DURABLE LOG COPY of one `run_code` sub-dispatch outcome before the bridge appends its `tool/ptc-dispatch` event. `next()` keeps the content unchanged; a listener may return replacement blocks (e.g. the spill policy's preview + locator for an oversized text result). Only the logged copy is affected — the program already received the complete value, and the model sees neither. A throwing listener is contained: the bridge falls back to logging the original settled content. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's dispatches.

```ts cordis-catalog
/**
 * Allow a listener to replace content in the DURABLE LOG COPY of one
 * `run_code` sub-dispatch outcome before the bridge appends its
 * `tool/ptc-dispatch` event. `next()` keeps the
 * content unchanged; a listener may return replacement blocks (e.g. the
 * spill policy's preview + locator for an oversized text result). Only the
 * logged copy is affected — the program already received the complete
 * value, and the model sees neither. A throwing listener is contained:
 * the bridge falls back to logging the original settled content.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's dispatches.
 * @param dispatch - the parent execution, sub-call identity, and the settled content to log.
 * @mode waterfall
 */
'tools/ptc-dispatch-log'(this: Scoped<ToolsService>, dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
```

Types: [ContentBlock](llm-streaming.md) · [Scoped](scope.md)

Source: [`packages/core/tool-registry-ptc/src/runtime-types.ts`](../../packages/core/tool-registry-ptc/src/runtime-types.ts)

<a id="toolsresult--emit"></a>

#### `tools/result` — emit

Observe the frozen, lossless-JSON final outcome. Listener failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): keyed by `exec.agent`.

```ts cordis-catalog
/**
 * Observe the frozen, lossless-JSON final outcome. Listener failures are contained.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): keyed by `exec.agent`.
 * @param exec - the execution object that traversed the pipeline.
 * @param result - a deep-frozen snapshot of the final returned result.
 * @mode emit
 */
'tools/result'(this: Scoped<ToolsService>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
```

Types: [Scoped](scope.md)

Source: [`packages/core/tools/src/events.ts`](../../packages/core/tools/src/events.ts)
<!-- END GENERATED cordis-surface -->
