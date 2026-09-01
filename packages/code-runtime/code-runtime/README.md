---
description: "Abstract code-execution seam (`ctx.codeRuntime`) for users and maintainers composing, consuming, or building a backend that runs one model-written program against host-provided bindings."
kind: "package-reference"
---

# @deepseek-ai/dsh-code-runtime

English | [中文](README.zh.md)

## Summary

`dsh-code-runtime` defines what a code runtime does: run one model-written program against a set of host-provided async functions and report `{ value, logs, error? }` — without dictating how any backend implements it. Load it in a composition with a backend and the service is available as `ctx.codeRuntime`; PTC mode in `dsh-tools` then runs model-written programs that compose tools. Every request runs once with no state carried between runs, and every program outcome — including failures — resolves as a result field rather than a rejection. The runtime knows nothing about tools or sessions: it is handed a program and named bindings, and everything tool-shaped stays with the consumer.

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

Choose this package when you compose a deployment that executes model-written programs, consume `ctx.codeRuntime` directly, or build a backend that runs programs. In the shipped composition, PTC mode in `dsh-tools` is the consumer: only what the program printed and returned re-enters the conversation.

### Run a program

Give the runtime a program source and one or more binding namespaces. Each namespace becomes one global object of async functions inside the program — PTC mode passes one under `tools`. The program runs as the body of an async function, so top-level `await` and `return` work; a lossless-JSON completion becomes `result.value`, each output channel preserves its own order in `result.logs` while cross-channel interleaving is backend-dependent, and any failure is reported in `result.error` with a kind you can branch on. The runtime never rejects for a program failure — rejection means you misused the seam, for example by submitting a run after disposal.

```text
const result = await ctx.codeRuntime.run({
  program: 'return await tools.add({ a: 1, b: 2 })',
  bindings: [{ global: 'tools', functions: { add: async (args) => args.a + args.b } }],
})
// result.value === 3
```

### Choose a backend

Backends declare two descriptors you can rely on: `language` — what the program must be written in, with `'typescript'` and `'python'` as the well-known values — and `isolation` — the execution substrate (`'worker-thread'`, `'process'`, `'container'`), a label for deployments and diagnostics, not a security claim. [`dsh-code-runtime-worker-thread`](../code-runtime-worker-thread/README.md) executes TypeScript in a fresh Node worker thread; the private [`dsh-experimental-code-runtime-python`](../../experimental/code-runtime-python/README.md) package executes Python in a fresh CPython subprocess for opt-in compositions.

### Name your bindings portably

Binding-global and error-class names are language-portable: they must match `[A-Za-z_][A-Za-z0-9_]*`, avoid every portable target language's reserved words, and avoid backend-owned slots, so one namespace list is valid against every backend. A name like `$tools`, `lambda`, or `console` fails the run before it starts; the exact exclusion sets are part of the seam contract.

### What can go wrong

Failures arrive as `result.error` with an orthogonal `kind`: the program threw or failed to parse (`exception`), a budget expired (`timeout`), the run was aborted (`abort`), the execution substrate died (`worker-exit`), the completion value was not lossless JSON (`invalid-output`), or the serialized output exceeded the cap (`output-limit`). Each kind carries a model-feedable message. `run()` rejects only for seam misuse, such as a run submitted after disposal or a binding name that fails the portable-identifier rules.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the seam; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package is the Service Definition role of the code-execution capability seam ([capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): an abstract `CodeRuntime extends Service` registered as `ctx.codeRuntime`, plus the vocabulary both backends and the consumer share. Providers subclass `CodeRuntime`, implement `run`, and register the service; the consumer (PTC mode in `dsh-tools`) generates the model-facing SDK and bridges tool dispatch. The runtime stays ignorant of tools and sessions by contract: it receives a program and named async bindings and returns `{ value, logs, error? }`.

### Service API

The contract is three members a backend implements: `run(request)` executes one program against the request's bindings and resolves every program outcome — parse/transform failure, thrown exception, invalid completion, output overflow, budget expiry, abort, or substrate death — as a result `error` field, with rejection reserved for caller misuse such as a run submitted after disposal; `language` and `isolation` are read-only descriptors labeling the source language and execution substrate for deployments and diagnostics.

The exhaustive semantics live in the [code runtime subsystem reference](../../../docs/subsystems/code-runtime.md); the exact signatures are in [`src/index.ts`](src/index.ts).

### Vocabulary

`CodeRunRequest` (`program`, `bindings`, `signal?`) carries everything the runtime acts on; defaulting (time budgets, output caps) is each provider's validated config, never a hidden `??` inside `run()`. `bindings` is a list of `CodeBindingNamespace`s (`global` + `functions` + optional `errorClass`), each exposed to the program as one global object of async callables returning `CodeJsonValue` — the seam's structural lossless-JSON type. An `errorClass` descriptor names a real program-global constructor and the own property that receives the rejected member name, so backends never learn consumer terms such as `ToolCallError`. `CodeRunResult` reports the lossless-JSON completion `value?`, per-channel-ordered `logs: string[]` with backend-dependent cross-channel interleaving, and `error?` (`CodeRunFailure`: orthogonal `kind` + model-feedable `message`). See `src/types.ts` for the full contracts.

### Portable identifiers

Binding-global and error-class names are language-portable: they must match the identifier subset `[A-Za-z_][A-Za-z0-9_]*` (no JS-only `$`) and clear the seam-exported exclusion sets, so one `bindings` list is valid against every backend. The package exports the contract every backend enforces — `PORTABLE_RESERVED_WORDS` (ECMAScript ∪ Python reserved words), `RESERVED_BINDING_GLOBALS` (backend-owned globals such as `console` and `__dsh_main__`), `RESERVED_ERROR_MEMBERS` and `DUNDER_MEMBER` (error-member exclusions) — so a name like `$tools`, `lambda`, or `__dsh_main__` makes `run()` reject as seam misuse on any backend. See `src/index.ts` for the exact sets.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: abstract `CodeRuntime` service and the portable-identifier exclusion sets |
| [`src/types.ts`](src/types.ts) | Vocabulary: `CodeRunRequest`, `CodeBindingNamespace`, `CodeJsonValue`, `CodeRunResult`, `CodeRunFailure` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the package-level contract is not enough. They move from the PTC mode consumer to the backends and the capability-seam model.

- [PTC mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-ptc.md) — how the tool registry consumes `ctx.codeRuntime` and presents `run_code` to the model.
- [Worker-thread backend](../code-runtime-worker-thread/README.md) — the shipped TypeScript execution backend.
- [Experimental Python backend](../../experimental/code-runtime-python/README.md) — the private CPython subprocess provider and its fd-3 protocol.
- [Code runtime subsystem reference](../../../docs/subsystems/code-runtime.md) — request/result vocabulary, bindings, and the `ctx.codeRuntime` cordis surface.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through PTC mode in `dsh-tools`, which exposes `run_code` and returns program logs, values, or failures as retained tool-result tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the seam cannot do; they are current package constraints, not a task backlog.

- **`run()` is one-shot** — `logs` arrive only on the resolved `CodeRunResult`; the seam exposes no streaming-log or progress API for a live program's output.
- **No state survives between runs** — every request runs against a fresh world; a persistent REPL-style kernel is deferred until a backend brings its own logging story.
- **The worker-thread backend ships; the Python process backend is private experimental; `'container'` has no implementation** — a hard security boundary awaits a container backend.
- **Intermediate binding values have no byte cap** — implementations remain subject to structured-clone cost and process memory, while a provider or executor may already have imposed its own acquisition bound.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and the package code.

#### Future: persistent kernel backend

A REPL-style kernel that keeps state across `run_code` calls remains undecided; it would need its own logging story, because the no-state-between-runs contract is what keeps every request reconstructable from the session log alone.

#### Future: container backend

A container-class backend would provide a hard multi-tenant boundary for both code and shell execution; nothing is decided beyond the well-known `isolation` value.

</details>
