---
description: "Abstract PTC execution seam (`ctx.ptcRuntime`) for users and maintainers composing, consuming, or building a backend that runs one model-written program against host-provided bindings."
kind: "package-reference"
---

# @deepseek-ai/dsh-ptc-runtime

English | [中文](README.zh.md)

## Summary

Use `dsh-ptc-runtime` to execute model programs against host-provided asynchronous functions. Requests return lossless JSON, captured logs, or structured failures; rejected promises indicate caller misuse. Providers isolate distinct state owners and declare whether source is an async function body or REPL statements. A provider may retain memory for an explicit owner until release; it never restores that memory from a Session. Language and isolation descriptors identify syntax and execution substrate, not security guarantees.

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

Choose this package when you compose a deployment that executes model-written programs, consume `ctx.ptcRuntime` directly, or build a backend that runs programs. PTC mode in `dsh-tools` uses it for tool programs, and `dsh-workflow-ptc` uses it for workflow orchestration. Each consumer owns the content returned to its model.

### Run a program

Call `resolve(request)` followed by `run(spec)` with a program and binding namespaces. Resolution validates cwd, timeout and sandbox choices and applies provider defaults. `programFormat` selects an async function body with top-level `await` and `return`, or REPL statements with top-level declarations, `await`, and a final expression. Lossless-JSON completion becomes `result.value`, text becomes `result.logs`, and failures become `result.error`.

```text
const spec = ctx.ptcRuntime.resolve({
  program: 'return await tools.add({ a: 1, b: 2 })',
  bindings: [{ global: 'tools', functions: { add: async (args) => args.a + args.b } }],
})
const result = await ctx.ptcRuntime.run(spec)
// result.value === 3
```

### Choose a backend

Backends expose `language` and `isolation` as diagnostic descriptors; neither grants authority or proves confinement. [`dsh-ptc-runtime-node`](../ptc-runtime-node/README.md) executes erasable TypeScript in a fresh managed Node process under the resolved sandbox policy. The private [`dsh-experimental-ptc-runtime-python`](../../experimental/ptc-runtime-python/README.md) provider executes Python in a fresh CPython subprocess without file confinement. `sandboxMode` advertises a provider's deployment file-policy mode, or is absent when that capability is unsupported.

For the optional [Node in-memory mode](../ptc-runtime-node/README.md#persistent-repl), pass the same `stateOwner` object across runs and await `release(owner)` at the owner's end. Different object identities never share an environment; omitted owners use a temporary environment. Stateless providers ignore ownership. Calls for one retained owner must not overlap.

### Name your bindings portably

Binding-global and error-class names are language-portable: they must match `[A-Za-z_][A-Za-z0-9_]*`, avoid every portable target language's reserved words, and avoid backend-owned slots, so one namespace list is valid against every backend. A name like `$tools`, `lambda`, or `console` fails the run before it starts; the exact exclusion sets are part of the seam contract.

### What can go wrong

Failures arrive as `result.error` with an orthogonal `kind`: `exception`, `timeout`, `abort`, `worker-exit`, `invalid-output`, `output-limit`, `protocol` or `sandbox-unavailable`. Providers return applicable `result.sandbox` facts separately from success or failure. Invalid or unsupported execution options fail during `resolve`; `run` rejects caller misuse, such as unresolved inputs, invalid binding names or a call after disposal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the seam; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package is the Service Definition role of the PTC execution capability seam ([capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): an abstract `PtcRuntime extends Service` registered as `ctx.ptcRuntime`, plus the vocabulary providers and consumers share. Providers subclass `PtcRuntime`, implement `resolve` and `run`, and register the service. PTC mode in `dsh-tools` owns tool bindings, while `dsh-workflow-ptc` owns workflow hooks and child agents. The runtime stays ignorant of tools and sessions by contract: it receives a program, named async bindings and resolved execution options, then returns captured output, the outcome and applicable sandbox facts.

### Service API

The readonly `timeout` descriptor exposes numeric `{ defaultMs, maxMs }` for consumer presentation; an absent descriptor means numeric overrides are unsupported. An omitted `timeoutMs` selects the provider default; a number requests a validated, capped elapsed budget; explicit `null` requests no elapsed deadline. A provider rejects choices it does not support. The Node workflow adapter requests `null`, while the model-facing `run_code` tool accepts only positive numeric overrides.

`executionInstructions` supplies provider-owned usage guidance, or an empty string when none is needed. Consumers can include it in their program presentation without identifying the provider from its language or isolation descriptor; PTC includes it in the logged `run_code` schema.

`resolve(request)` owns supported option validation and deployment defaulting. `run(spec)` executes the complete inputs and resolves program outcomes after cleanup. Language and substrate descriptors guide presentation; `sandboxMode` indicates whether the consumer can pass a resolved file policy. Neither descriptors nor a successful program result substitute for the backend's reported enforcement facts.

The exhaustive semantics live in the [PTC runtime subsystem reference](../../../docs/subsystems/ptc-runtime.md); the exact signatures are in [`src/index.ts`](src/index.ts).

### Vocabulary

`PtcRunRequest` carries the program, host bindings, cancellation and optional execution choices. `PtcRunSpec` requires the resolved cwd and an explicit numeric or null deadline choice. `PtcBindingNamespace` declares program globals and optional typed rejection constructors. `PtcRunResult` separates logs/value, failure and `PtcRunSandbox` facts; exact fields and provider obligations live in [`src/types.ts`](src/types.ts).

### Portable identifiers

Binding-global and error-class names are language-portable: they must match the identifier subset `[A-Za-z_][A-Za-z0-9_]*` (no JS-only `$`) and clear the seam-exported exclusion sets, so one `bindings` list is valid against every backend. The package exports the contract every backend enforces — `PORTABLE_RESERVED_WORDS` (ECMAScript ∪ Python reserved words), `RESERVED_BINDING_GLOBALS` (backend-owned globals such as `console` and `__dsh_main__`), `RESERVED_ERROR_MEMBERS` and `DUNDER_MEMBER` (error-member exclusions) — so a name like `$tools`, `lambda`, or `__dsh_main__` makes `run()` reject as seam misuse on any backend. See `src/index.ts` for the exact sets.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: abstract `PtcRuntime` service and the portable-identifier exclusion sets |
| [`src/types.ts`](src/types.ts) | Vocabulary: `PtcRunRequest`, `PtcRunSpec`, bindings, results, failures and sandbox facts |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the package-level contract is not enough. They move from the PTC mode consumer to the backends and the capability-seam model.

- [PTC mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-ptc.md) — how the tool registry consumes `ctx.ptcRuntime` and presents `run_code` to the model.
- [Node process backend](../ptc-runtime-node/README.md) — the shipped TypeScript execution backend.
- [Experimental Python backend](../../experimental/ptc-runtime-python/README.md) — the private CPython subprocess provider and its fd-3 protocol.
- [PTC runtime subsystem reference](../../../docs/subsystems/ptc-runtime.md) — request/result vocabulary, bindings, and the `ctx.ptcRuntime` cordis surface.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through PTC mode in `dsh-tools` and the workflow adapter, which present program outcomes through their own tool results.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the seam cannot do; they are current package constraints, not a task backlog.

- **`run()` is one-shot** — `logs` arrive only on the resolved `PtcRunResult`; the seam exposes no streaming-log or progress API for a live program's output.
- **Retained memory is disposable**: providers may keep state for an explicit owner; restart, release, and provider-specific failures discard it. Programs, binding calls and results remain logged by consumers; live objects are neither serialized nor replayed.
- **Providers have different confinement capabilities** — the shipped Node provider enforces a resolved file policy, while the private experimental Python provider rejects an explicit policy. No container provider is supplied.
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
