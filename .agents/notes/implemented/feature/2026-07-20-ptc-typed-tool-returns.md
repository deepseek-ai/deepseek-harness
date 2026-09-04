# Agent Note: Typed tool returns in PTC mode

Status: implemented

English | [中文](2026-07-20-ptc-typed-tool-returns.zh.md)

## Problem

PTC mode originally projected each nested tool result back from `ContentBlock[]` into one string. That preserved the human-readable Native presentation but erased the canonical result the tool had already produced: programs had to scrape job ids and dynamic mount ids from prose, structured search and workflow results lost their shape, and non-text blocks became placeholders. The generated SDK could describe arguments but could only promise `Promise<string>` regardless of the tool's real output.

The runtime also treated binding values and the final program value as presentation data. Separate log and completion caps could replace an oversized or non-cloneable completion with inspected text even though intermediate values do not enter model context. That made programmatic composition lossy and confused the memory boundary with the prompt boundary.

The [canonical tool-output contract](../architecture/2026-07-20-canonical-tool-output-contract.md) establishes one validated execution-time value and a separate Native renderer. PTC mode should consume that value directly, preserve it across the worker boundary, and bound only the final output the program deliberately returns to the model.

## Decision

PTC mode is a typed projection of the visible tool registry. Each successful binding resolves to the final canonical `JsonValue` after post-execute policy, while a failed binding rejects with a real `ToolCallError`. Intermediate values remain inside the run and cross the worker boundary whole. The outer `run_code` logs, completion value, or failure diagnostic enter the configurable output ledger and model-facing spill pipeline; a successfully settled sub-call whose final Native content contains an image additionally defers that complete ordered content through the parent result as logged, source-attributed context.

This note owns the return and failure contract layered on the original [PTC mode foundation](2026-06-15-ptc.md). The unified schema vocabulary is owned by the [JSON-value schema DSL note](../architecture/2026-07-20-unified-json-value-schema-dsl.md), and Native rendering and policy projection remain owned by the canonical-output note.

### Generated SDK

At each prompt assembly the registry projects every visible tool's parameter schema and detached canonical output schema into one deterministic declaration:

```ts ignore-check
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface ToolArgsMap {
  // one exact inferred entry per visible tool
}

interface ToolOutputMap {
  // one exact inferred entry per visible tool
}

type ToolName = keyof ToolOutputMap

declare class ToolCallError extends Error {
  readonly name: 'ToolCallError'
  readonly toolName: ToolName
}

declare const tools: {
  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>
}
```

`jsonSchemaToTs()` covers every supported unified-schema node: object, array, string, number, integer, boolean, null, unconstrained JSON, scalar `enum` and `const`, and `oneOf`. Unsupported raw constructs degrade to `unknown` during prompt generation rather than breaking assembly. Tool names retain their exact keys, including names that require quoted access.

### Binding values and failures

Before dispatch the bridge snapshots binding arguments as lossless JSON and snapshots the detached value again for an independent durable summary event. Host-side detachment, immutable execution, and output-schema projection all use iterative traversals rather than nested structured clone or recursive freezing. `undefined`, non-finite numbers, `-0`, sparse arrays, cycles, functions, and exotic objects reject that call before the tool runs. Successful dispatch returns `ToolExecutionResult.value`; Native `content`, metadata, and internal error information do not cross to the program. Image-bearing final content is not a second binding value: the bridge ferries it after the outer result so the next model request can see the durable image, while post-execute block/content replacement remains authoritative and text-only results are not duplicated.

PTC mode declares its rejection capability on the runtime request as `{ name: "ToolCallError", memberNameProperty: "toolName" }`. The runtime Service Definition treats those names as data: the worker materializes and injects the actual constructor used for `tools` binding failures, so `error instanceof ToolCallError` works without making a generic runtime know about tools. The worker constructs failures and defines their public fields through module-captured error and property-definition intrinsics plus null-prototype descriptors, so model mutations cannot replace the promised rejection with a worker failure. The error has the standard `Error` message plus the exact `toolName`; it deliberately omits `ToolFailure.info`, error codes, and Native content. This is an exception contract for control flow, not a failure union for programmatic classification.

Binding arguments and resolutions are revalidated as lossless JSON on both sides of the hostile worker protocol and have no byte cap. Before crossing through structured clone, each detached value is encoded as a flat pre-order token stream whose transport nesting is bounded; the receiver rebuilds it iteratively. Valid application nesting therefore has neither a JavaScript call-stack depth cap nor a platform-specific nested structured-clone limit. At module initialization the worker captures its own realm's `Array.prototype` and `Object.prototype` identities, the native function-source intrinsic used only to recognize foreign-realm plain-container prototypes, and every structural and metering intrinsic used by the JSON boundary. Property writes use null-prototype descriptors, while private array and set operations invoke captured methods without consulting mutable global or prototype slots. Model code can therefore replace helpers such as `Object.keys`, `Array.isArray`, collection methods, string methods, or `Buffer.byteLength`, rewrite intrinsic-prototype constructor slots, or add descriptor-shaped fields to `Object.prototype` without changing validation, wire transport, or byte accounting. The foreign-realm native function-source check still rejects user-authored constructors that imitate `Object` or `Array`. The dependency-light runtime Service Definition names its structural equivalent `CodeJsonValue` so it need not depend on the session-owned canonical type; the generated SDK and tool API use `JsonValue`. Intermediate values are not prompt-truncated, context-spilled, or persisted. This preserves full acquired search, workflow, task, filesystem, and MCP values for programmatic filtering while leaving provider and executor acquisition limits truthful.

### Outer result and output ledger

The runtime accepts an exact lossless JSON completion of any root. Returning `undefined` omits the completion; returning `null` is an explicit result. `run_code` exposes the canonical outer value `{ logs: string[], result?: JsonValue }`. Its Native renderer emits logs first, renders a string result raw, and renders every other JSON root with an iterative pretty printer. Total indentation is capped at ten characters and deeper subtrees remain compact, preserving the established shallow text while keeping traversal stack-safe and formatted size linear in the canonical JSON size.

`WorkerThreadCodeRuntime` replaces the former independent log and value caps with configurable `maxOutputBytes`, defaulting to `67_108_864` bytes. The worker charges captured logs by their exact JSON-string serialization and preflights the detached completion or program exception against the remaining combined budget before posting a terminal message. A giant thrown string or stack therefore crosses the worker port only as the fixed `output-limit` diagnostic. The host repeats the hostile-peer ledger for forged traffic and native pipe writes the worker cannot observe. Fixed `CodeRunResult` field names, braces, the bounded error-kind tag, and later presentation whitespace are deliberately outside this variable-payload ledger. Neither stage materializes an over-limit serialized completion. A result at or below the cap is exact. A completion that cannot survive lossless JSON snapshotting fails as `invalid-output`; a value, diagnostic, or combined outcome over the cap fails as `output-limit` rather than becoming inspected or truncated text.

Logs stream eagerly so a terminated run can retain output already admitted. Native stdout and stderr writes that bypass the worker's patched stream slots use independent pipes, so terminal settlement continues bounded capture until worker termination completes before materializing the result. When the cap is crossed, the runtime returns an explicit bounded failure with the fitting captured prefix. That outer result then traverses the ordinary `run_code` rendering and spill policy, which may save the captured text and expose its configured head/tail preview. The spill layer cannot recover bytes the runtime rejected beyond the hard cap.

Compute time, wall time, worker heap, cancellation, and fresh-worker isolation remain independent limits. The outer ledger never charges intermediate bindings, so snapshotting, flat-wire encoding and decoding, structured-clone cost, and available process or worker memory are their practical bounds.

### Typed handles and lifetime

Background producers return a typed canonical handle such as `{ kind: 'background', jobId }` while retaining their established Native sentence. A pre-aborted background call remains a failure because successful output promises an id and no task was created. After `ctx.jobs.start()` publishes the id, task-owned cancellation governs the work: settlement or later cancellation of the enclosing `run_code` call does not kill it. A later program can pass the returned id to `job_output`, and `job_kill`, owner disposal, or service teardown owns cancellation. Foreground execution remains coupled to the call signal. The task lifetime contract is owned by the [background job runtime note](../architecture/2026-06-20-generic-long-running-tool-runtime.md).

Temporary Cordis Plugins follow the same rule: `cordis_mount` returns `{ id, pluginName, state, provides, waitingFor }`, so a program can read `mounted.id`, inspect active or pending state, and pass that id to `cordis_unmount` without parsing the stable Native sentence.

### Persistence, metadata, and spill

Nested dispatch logs the sub-call's full rendered `content`/`isError` on `tool/code-dispatch` but does not persist canonical values. `tool/result` continues to persist only rendered content, error, and optional metadata. A successful final content sequence containing an image is also wrapped in a source-attributed user message and deferred through the outer result; the normal session event makes that model-visible input reconstructable. This feature did not itself require a structural Session-format change; the released v0-to-v1 identity edge preserves these records, and replay still cannot recreate intermediate canonical program values.

The opaque `exec.parent` token marks nested calls. Presentation metadata and generic or tool-owned spill projections skip those calls because they have no direct result card and their canonical values never enter context. The outer `run_code` call alone produces one card and may spill its final post-policy presentation; `run_code` intentionally declares neither a result presenter nor presentation metadata, so UI adapters complete the card through their generic raw-content fallback using durable `tool/result.content`.

## Testing

Compile-time and snapshot tests pin exact `ToolArgsMap`, `ToolOutputMap`, `ToolName`, schema-to-TypeScript coverage, exotic names, and assembled PTC mode image forwarding. Registry and real-worker tests cover scalar, array, object, and null values; raw string rendering; absent `undefined`; consumer-declared real rejection classes, including `ToolCallError`; invalid arguments and completions, including intrinsic-looking forged prototypes; model-mutated JSON-boundary globals, prototype methods, constructor slots, and inherited descriptor fields; typed binding failures after those mutations; large uncapped intermediate bindings; nested spill suppression; generic image-bearing context deferral plus post-execute replacement/block precedence; exact and over-limit 64 MiB accounting; combined logs/value/diagnostic accounting; giant thrown stacks; bounded failure spill; hostile forged traffic; and built-package execution.

Keyless real-worker integration tests pin the two handle workflows that prose results could not safely support. A background bash call returns its job id, the outer run settles, and a later run polls that id to completion; separate cases prove pre-abort creates no task, post-publication call abort preserves the task, foreground execution stays signal-coupled, and `job_kill` owns cancellation. A Cordis program reads an active or pending mount's id and `waitingFor` fields directly, unmounts by that id, and confirms removal without parsing rendered text.

## Alternatives considered

**Return Native text plus optional JSON.** Rejected because the program would have two competing success contracts and would still need tool-specific parsing rules when the optional value is absent. Canonical value is the API; Native content is its presentation.

**Expose a success/failure union from every binding.** Rejected because failure has no stable programmatic taxonomy. Rejections preserve ordinary `try`/`catch` control flow and expose only the tool name and human-readable message.

**Cap each intermediate binding.** Rejected because intermediate values are not placed in model context and arbitrary truncation would corrupt programmatic composition. The producer's acquisition contract and process memory remain explicit boundaries.

**Silently inspect or truncate an oversized completion.** Rejected because changing a JSON value into a string is lossy and type-incorrect. The explicit `output-limit` failure lets the model choose a smaller result, while the retained logs and diagnostic can still use normal outer spill.

**Require each rich leaf tool to inspect `exec.parent` and defer itself.** Rejected because it couples leaf tools to PTC mode internals, duplicates policy handling, and misses future rich tools. The dispatch bridge owns generic forwarding from the already settled final result.

**Expose Native rich content as part of every binding's canonical value.** Rejected because a canonical value is lossless JSON and tool-specific; attachment blocks are a model projection with durable lifecycle semantics. Keeping the value and projection separate preserves typed programs without dropping images from later model context.

## Consequences

Code programs can compose tools through stable values instead of reverse-engineering Native prose. Native and Both Mode retain their existing text and UI presentation, while PTC mode receives output-schema types and exact runtime JSON. Tool authors must treat the canonical value as their programmatic API and put display-only formatting in the renderer.

The worker performs bounded-depth flat-wire transport and lossless validation but does not make intermediate values cheap or durable. Outer overflow is an explicit failed run, and error handling remains intentionally human-guided rather than a versioned code union.

## Known Limitations and Deferred Work

- Subagent and workflow caller-defined structured outputs remain object-rooted through consumer-level guards even though tool outputs may use any JSON root.
- Post-execute has separate value and presentation projections; replacing content is not a confidentiality mechanism, so policy must block or replace the value to hide it from programmatic callers.
- Intermediate canonical values are execution-local and unavailable to replay because durable events persist only presentation and bounded summaries.
- Intermediate values have no byte cap and can exhaust process or worker memory through retention, flat-wire copies, or structured-clone cost.
- The 64 MiB hard cap applies only to the outer variable payloads, excluding fixed result-envelope syntax and presentation whitespace; spill cannot recover bytes rejected beyond that cap.
- Provider or executor acquisition limits may already have discarded source data before a canonical value reaches PTC mode.
- Unsupported MCP output schemas fall back to `JsonValue`; admitted MCP images use the generic deferred projection, while audio and embedded-resource payloads remain diagnostic-only.
- There is one result card per outer `run_code`, never per nested call.
- Code failures expose `ToolCallError` message and tool name only, without a programmatic error-code union.
