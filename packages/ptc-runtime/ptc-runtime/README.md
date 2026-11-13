---
description: "Abstract PTC execution seam (`ctx.ptcRuntime`) for users and maintainers composing, consuming, or building a backend that runs one model-written program against host-provided bindings."
kind: "package-reference"
---

# @deepseek-ai/dsh-ptc-runtime

English | [中文](README.zh.md)

## Summary

Use `dsh-ptc-runtime` to execute model programs against host-provided asynchronous functions. Requests return lossless JSON, captured logs, or structured failures; rejected promises indicate caller misuse. Providers isolate distinct state owners and declare whether source is an async function body, REPL statements, or a script. `retainsState` reports whether a provider retains memory for an explicit owner until release; it never restores that memory from a Session. Language and isolation descriptors identify syntax and execution substrate, not security guarantees.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Choose this package when you compose a deployment that executes model-written programs, consume `ctx.ptcRuntime` directly, or build a backend that runs programs. `dsh-tool-executor-ptc` uses it for tool programs, and `dsh-workflow-ptc` uses it for workflow orchestration. Each consumer owns the content returned to its model.

### Run a program

Call `resolve(request)` followed by `run(spec)` with a program and binding namespaces. Resolution validates cwd, timeout and sandbox choices and applies provider defaults. `programFormat: PtcProgramFormat` selects an async function body with top-level `await` and `return`, or REPL/Script statements with top-level declarations, `await`, and a final expression. The Node Script provider lowers top-level await and awaits the completion value; its [declaration limitations](../ptc-runtime-node/README.md#known-limitations-and-deferred-work) apply to transformed programs. Lossless-JSON completion becomes `result.value`, captured text and images become ordered `result.output` entries, and failures become `result.error`.

Set `discardCompletion: true` to omit the successful completion without JSON validation or serialization; captured logs and failures are still returned. The TypeScript tool executor selects this option for explicit program output, while workflow consumers retain completion values.

Host bindings can return `new PtcImage(path, attachment)` to expose a stored image in Node programs. Explicit inspection appends `{ type: 'image', attachment }` entries to `result.output`, alongside `{ type: 'text', text }` entries in emission order. Text entries retain emitted newline characters; concatenate adjacent text without separators.

```text
const spec = ctx.ptcRuntime.resolve({
  program: 'return await tools.add({ a: 1, b: 2 })',
  bindings: [{ global: 'tools', functions: { add: async (args) => args.a + args.b } }],
})
const result = await ctx.ptcRuntime.run(spec)
// result.value === 3
```

<a id="choose-a-backend"></a>
### Choose a backend

Backends expose `language` and `isolation` as diagnostic descriptors; neither grants authority or proves confinement. [`dsh-ptc-runtime-node`](../ptc-runtime-node/README.md) executes erasable TypeScript in a fresh managed Node process under the resolved sandbox policy. `sandboxMode` advertises a provider's deployment file-policy mode, or is absent when that capability is unsupported.

For the optional [Node in-memory mode](../ptc-runtime-node/README.md#persistent-repl), pass the same `stateOwner` object across runs and await `release(owner)` at the owner's end. Different object identities never share an environment; omitted owners use a temporary environment. Stateless providers ignore ownership. Calls for one retained owner must not overlap.

`registerEnvironmentInitializer(program)` registers source that prepares each new environment once before user code, after current bindings are installed. Register before the first run is admitted; only one initializer may be registered. Initialization shares the first run's logs, deadline, cancellation and output budget, and its completion value is discarded. Failure prevents user execution and discards the environment without rolling back external effects. Own the returned async disposer: it cancels and drains admitted runs and releases environments. Failed cleanup blocks new execution until disposal succeeds on retry. Registration after admission of the first run remains invalid even after all environments are released. Unsupported providers and modes reject registration; see the [Node provider](../ptc-runtime-node/README.md#persistent-repl) for supported syntax.

### Name your bindings

Binding-global and error-class names must match `[A-Za-z_$][A-Za-z0-9_$]*` and exclude ECMAScript keywords and strict-mode names (`RESERVED_BINDING_WORDS`). Runtime output globals `console`, `inspect`, and `Image` are reserved by `RESERVED_BINDING_GLOBALS`. Error-member names must be non-empty and exclude `name`, `message`, and `stack` (`RESERVED_ERROR_MEMBERS`); other own property names are accepted. Invalid names make `run()` reject before a process starts.

### What can go wrong

Failures arrive as `result.error` with an orthogonal `kind`: `exception`, `timeout`, `abort`, `worker-exit`, `invalid-output`, `output-limit`, `protocol` or `sandbox-unavailable`. Providers return applicable `result.sandbox` facts separately from success or failure. Invalid or unsupported execution options fail during `resolve`; `run` rejects caller misuse, such as unresolved inputs, invalid binding names or a call after disposal. Contract misuse rejects with `PtcRuntimeError`: `PTC_RUNTIME_INVALID_ARGUMENT` for an invalid request or spec, `PTC_RUNTIME_UNAVAILABLE` after disposal or while a retained environment's cleanup is incomplete, and `PTC_RUNTIME_CONFLICT` for a concurrent run for one owner or a retained environment launched under another sandbox policy.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the seam; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package is the Service Definition role of the PTC execution capability seam ([capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): an abstract `PtcRuntime extends Service` registered as `ctx.ptcRuntime`, plus the vocabulary providers and consumers share. Providers subclass `PtcRuntime`, implement `resolve` and `run`, and register the service. `dsh-tool-executor-ptc` owns tool bindings, while `dsh-workflow-ptc` owns workflow hooks and child agents. The runtime stays ignorant of tools and sessions by contract: it receives a program, named async bindings and resolved execution options, then returns captured output, the outcome and applicable sandbox facts.

### Service API

The readonly `timeout` descriptor exposes numeric `{ defaultMs, maxMs }` for consumer presentation; an absent descriptor means numeric overrides are unsupported. An omitted `timeoutMs` selects the provider default; a number requests a validated, capped elapsed budget; explicit `null` requests no elapsed deadline. A provider rejects choices it does not support. The Node workflow adapter requests `null`, while the model-facing `run_code` tool accepts only positive numeric overrides.

`executionInstructions` supplies provider-owned usage guidance, or an empty string when none is needed. Consumers can include it in their program presentation without identifying the provider from its language or isolation descriptor; PTC includes it in the logged `run_code` schema.

`resolve(request)` owns supported option validation and deployment defaulting. `run(spec)` executes the complete inputs and resolves program outcomes after cleanup. Language and substrate descriptors guide presentation; `sandboxMode` indicates whether the consumer can pass a resolved file policy. Neither descriptors nor a successful program result substitute for the backend's reported enforcement facts.

The exhaustive semantics live in the [PTC runtime subsystem reference](../../../docs/subsystems/ptc-runtime.md); the exact signatures are in [`src/index.ts`](src/index.ts).

### Vocabulary

`PtcRunRequest` carries the program, host bindings, cancellation and optional execution choices. `PtcRunSpec` requires the resolved cwd and an explicit numeric or null deadline choice. `PtcBindingNamespace` declares program globals and optional typed rejection constructors. `PtcRunResult` separates output/value, failure and `PtcRunSandbox` facts; exact fields and provider obligations live in [`src/types.ts`](src/types.ts).

### Binding exclusions

The runtime exports `RESERVED_BINDING_WORDS`, `RESERVED_BINDING_GLOBALS`, and `RESERVED_ERROR_MEMBERS` for binding validation; see [`src/index.ts`](src/index.ts) for the exact sets.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: abstract `PtcRuntime` service and the binding exclusion sets |
| [`src/types.ts`](src/types.ts) | Vocabulary: `PtcRunRequest`, `PtcRunSpec`, bindings, results, failures and sandbox facts |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the package-level contract is not enough. They move from the PTC mode consumer to the backends and the capability-seam model.

- [PTC mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-ptc.md) — how the tool registry consumes `ctx.ptcRuntime` and presents `run_code` to the model.
- [Node process backend](../ptc-runtime-node/README.md) — the shipped TypeScript execution backend.
- [PTC runtime subsystem reference](../../../docs/subsystems/ptc-runtime.md) — request/result vocabulary, bindings, and the `ctx.ptcRuntime` cordis surface.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-executor-ptc` and the workflow adapter, which present program outcomes through their own tool results.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the seam cannot do; they are current package constraints, not a task backlog.

- **`run()` is one-shot** — `output` arrives only on the resolved `PtcRunResult`; the seam exposes no streaming-log or progress API for a live program's output.
- **Retained memory is disposable**: providers may keep state for an explicit owner; restart, release, and provider-specific failures discard it. Programs, binding calls and results remain logged by consumers; live objects are neither serialized nor replayed.
- **No container provider is supplied** — the shipped Node provider enforces the resolved file policy through the composed sandbox backend.
- **No uniform binding byte cap applies across providers** — each provider owns its transport limits; a binding can still allocate memory before its result reaches those limits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and the package code.

#### Retained state

Retained state has no disk checkpoint or restoration protocol. Consumers must tolerate its loss and retain only model-visible programs and outcomes in the Session log.

#### Future: container backend

A container-class backend would provide a hard multi-tenant boundary for both code and shell execution; nothing is decided beyond the well-known `isolation` value.

</details>
