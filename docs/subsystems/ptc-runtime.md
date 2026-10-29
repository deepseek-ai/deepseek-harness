# PTC runtime

English | [中文](ptc-runtime.zh.md)

The PTC execution [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) supplies `ctx.ptcRuntime` through [dsh-ptc-runtime](../../packages/ptc-runtime/ptc-runtime). It runs one program against host bindings and reports output, failure and applicable sandbox facts. PTC execution is optional rather than part of [the agent-loop spine](core.md). The [PTC foundation](../../.agents/notes/implemented/feature/2026-06-15-ptc.md) owns registry presentation, the [typed-return contract](../../.agents/notes/implemented/feature/2026-07-20-ptc-typed-tool-returns.md) owns binding values, and the [sandboxed Node decision](../../.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.md) owns the shipped execution provider.

Source: [`packages/ptc-runtime/ptc-runtime/src/types.ts`](../../packages/ptc-runtime/ptc-runtime/src/types.ts)

## The run: request in, result out

`PtcRunRequest` contains the program, bindings, cancellation and optional execution choices. The provider's `resolve` validates supported choices and applies its deployment defaults; `run` receives a `PtcRunSpec` with an explicit directory and deadline choice. An omitted timeout uses provider defaults, a number requests a capped elapsed budget, and `null` requests no elapsed deadline. Providers reject unsupported choices before execution:

```ts type-equiv
/**
 * Caller inputs for one program. The provider's resolve method validates supported
 * options and supplies directory, deadline, and authority before execution.
 */
interface PtcRunRequest {
  /**
   * The program source, in the runtime's {@link ../index.ts | language}. It
   * follows the provider's programFormat: an async function body supports
   * top-level `await` and `return`; REPL and Script programs support top-level
   * declarations, `await`, and a final expression, but not top-level `return`.
   * The Script provider lowers top-level await; its executionInstructions and
   * documentation define retained-binding semantics. The completion value
   * becomes {@link PtcRunResult.value}.
   */
  program: string
  /**
   * Object-identity owner for optional in-memory state. Omission requests a fresh
   * environment. Consumers must await runtime.release(owner) when the owner ends.
   * Stateless providers ignore this field; retained state is never durable.
   */
  stateOwner?: object
  /** Host functions exposed to the program, one global object per namespace. */
  bindings: PtcBindingNamespace[]
  /** Working directory in the mounted filesystem and subprocess execution world. */
  cwd?: string
  /**
   * Elapsed execution budget in milliseconds. Omission uses provider defaults;
   * null requests no deadline. Providers validate and cap numeric budgets or reject unsupported choices.
   */
  timeoutMs?: number | null
  /** Resolved authority for this execution. Providers without confinement reject an explicit policy. */
  sandboxPolicy?: SandboxExecutionPolicy
  /**
   * Abort the run: the runtime stops the program (hard, even mid-loop) and
   * resolves with a {@link PtcRunFailure} of kind `'abort'`. In-flight
   * binding calls are the CALLER's to settle — the runtime only stops asking.
   */
  signal?: AbortSignal
}
```

```ts type-equiv
/** Fully resolved execution inputs; run never supplies a missing directory or deadline choice. */
interface PtcRunSpec extends PtcRunRequest {
  /** Absolute directory in the provider's execution world. */
  cwd: string
  /** Positive finite elapsed budget in milliseconds after provider capping, or null for no deadline. */
  timeoutMs: number | null
}
```

```ts type-equiv
/** File confinement applied to a program, independently of its terminal outcome. */
interface PtcRunSandbox {
  /** File-effect mode used for this execution. */
  mode: SandboxMode
  /** Program failure text matched backend diagnostics; not enforcement proof or an exhaustive denial record. */
  denied: boolean
  /** Completeness reported by the selected confining backend; absent for full access. */
  enforcement?: SandboxEnforcement
}
```

Program failures resolve through `PtcRunResult.error`; invalid caller inputs may reject before execution. Sandbox mode, observed denial and enforcement completeness are separate facts, so a successful program does not by itself prove that every requested restriction was enforced:

```ts type-equiv
/**
 * The outcome of one run. An error is a FIELD on a resolved result, never a
 * rejection of `run()` — reporting a failed program is the caller's job, not
 * an exception path.
 */
interface PtcRunResult {
  /** Applied file policy and observed denial, when the provider enforces file policy. */
  sandbox?: PtcRunSandbox
  /**
   * The program's completion value (a return or final REPL/Script expression), when it ran to
   * completion and the value crossed the runtime's lossless-JSON boundary.
   * Invalid or over-limit completions fail the run instead of substituting a
   * rendered string; a failed or value-less run leaves this absent.
   */
  value?: PtcJsonValue
  /**
   * Captured text. Each source channel preserves emission order; interleaving
   * across independent channels is backend-dependent. Bounded only as part of
   * the outer result.
   */
  logs: string[]
  /** Present iff the run failed; see {@link PtcRunFailure} for the taxonomy. */
  error?: PtcRunFailure
}
```

```ts type-equiv
/** Source evaluation form, independent of retained program state. */
type PtcProgramFormat = 'function-body' | 'repl' | 'script'
```

`programFormat` distinguishes async function bodies, REPL statements, and scripts. REPL and Script programs accept top-level `await`, declarations, and a final expression; top-level `return` is not supported. The Node Script provider lowers top-level await and awaits the completion value; its [declaration limitations](../../packages/ptc-runtime/ptc-runtime-node/README.md#known-limitations-and-deferred-work) apply to transformed programs. `retainsState` reports memory retention independently of source syntax. `stateOwner` is an in-process object identity for optional retained memory; distinct objects remain isolated. Consumers await `release(owner)` when that owner ends; cleanup failures reject that call. Omitted owners are one-shot, and stateless providers ignore ownership. The [persistent Node provider](../../packages/ptc-runtime/ptc-runtime-node/README.md#persistent-repl) defines reset and recovery behavior; no retained object enters the durable Session format.

## Bindings: host functions as program globals

Each `PtcBindingNamespace` becomes a global object of async callables; PTC passes `tools`. Arguments and resolutions must be lossless JSON. Providers enforce their own transport caps; the seam sets no uniform binding-byte limit. An optional error-class descriptor creates program-visible typed rejections without naming a consumer inside the runtime. Binding names are own properties, so `__proto__` cannot traverse a prototype:

```ts type-equiv
/**
 * Program-visible typed rejection for one binding namespace. The runtime
 * injects a real error constructor under `name`; rejected member calls become
 * its instances and expose the exact member name through
 * `memberNameProperty`. Both strings are runtime data rather than knowledge
 * of a particular consumer such as PTC mode.
 */
interface PtcBindingErrorClass {
  /** Constructor global and resulting `Error.name`; same portable identifier rule as {@link PtcBindingNamespace.global}. */
  name: string
  /**
   * Non-empty own property for the member name. The portable exclusion set is
   * `RESERVED_ERROR_MEMBERS` plus dunder-form names (`__x__`, non-empty
   * middle), enforced identically by every backend; any other name —
   * identifiers or not — is accepted everywhere.
   */
  memberNameProperty: string
}
```

```ts type-equiv
/**
 * A named group of {@link PtcBindingFunction}s the runtime exposes to the
 * program as one global object (e.g. `tools`). Function names are arbitrary
 * strings — a runtime must treat names like `__proto__` or `constructor` as
 * ordinary own properties (null-prototype construction), never as prototype
 * collisions.
 */
interface PtcBindingNamespace {
  /**
   * The global identifier the program sees. Must match the LANGUAGE-PORTABLE
   * identifier subset `[A-Za-z_][A-Za-z0-9_]*` and no language's reserved
   * words, so the same namespace list works against every backend regardless
   * of `language` — a JS-only spelling like `$tools` is rejected by design,
   * not just by the Python backend. Names that satisfy the identifier rule but
   * name a backend-owned slot (`RESERVED_BINDING_GLOBALS`, e.g. `console`,
   * `__dsh_main__`) are also refused everywhere; see its declaration for the
   * exact set and why each entry is reserved.
   */
  global: string
  /** The callable members, keyed by the exact name the program calls. */
  functions: Record<string, PtcBindingFunction>
  /** Optional program-visible typed rejection contract for this namespace. */
  errorClass?: PtcBindingErrorClass
}
```

```ts type-equiv
/** A lossless JSON value transferable through the dependency-light Service Definition. */
type PtcJsonValue = null | boolean | number | string | PtcJsonValue[] | { [key: string]: PtcJsonValue }
```

```ts type-equiv
/**
 * One host-side function exposed to the program as an async callable. The
 * runtime bridges calls to it (possibly across a serialization boundary), so
 * `args` and the resolution value MUST be lossless JSON. A runtime rejects a
 * lossy or non-cloneable value with a descriptive error rather than corrupting
 * the run. No seam-level byte cap applies to a binding resolution. A rejection
 * of this function surfaces inside the program as a rejection of the
 * corresponding call.
 */
type PtcBindingFunction = (args: unknown) => Promise<PtcJsonValue>
```

## Captured output and the failure taxonomy

Logs are plain strings. Each source channel preserves emission order, while interleaving across independent channels is backend-dependent because channel metadata is not part of the seam. The runtime captures the program's console and stream output, and consumers render only the text. Implementations cap the serialized outer log-array plus completion-value or failure-message payload; fixed result-envelope syntax and consumer presentation whitespace are not part of that variable-payload ledger. Overflow is an explicit failure rather than in-band value substitution.

Failure kinds are **orthogonal outcomes reported independently** (per [defensive-patterns](../defensive-patterns/general.md)): a budget expiry is not an exception, an abort is not a timeout, and a substrate death (e.g. OOM) is neither:

```ts type-equiv
/**
 * Why a run failed. The kinds are orthogonal outcomes reported independently
 * (per docs/defensive-patterns/general.md): a budget expiry is not an exception, an
 * abort is not a timeout, and a substrate death is neither.
 *
 * - `'exception'` — the program threw or failed to parse/transform.
 * - `'timeout'` — an implementation-owned budget expired; the message says which.
 * - `'abort'` — {@link PtcRunRequest.signal} fired.
 * - `'worker-exit'` — the execution substrate died without settling (e.g. OOM).
 * - `'invalid-output'` — the completion value was not lossless JSON.
 * - `'output-limit'` — the serialized outer logs/value/diagnostic exceeded the configured cap.
 * - `'protocol'` — the program sent invalid or over-budget control traffic.
 * - `'sandbox-unavailable'` — required confinement could not be established.
 */
interface PtcRunFailure {
  /** The failure class (see the interface doc for each kind's meaning). */
  kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit' | 'protocol' | 'sandbox-unavailable'
  /** Human-readable detail, suitable for feeding back to a model to self-correct. */
  message: string
}
```

## The service

`PtcRuntime` is defined in [`src/index.ts`](../../packages/ptc-runtime/ptc-runtime/src/index.ts). `resolve(request)` returns complete execution inputs, and `run(spec)` executes them. `executionInstructions` supplies provider-owned usage guidance for consumer presentation. `timeout` reports the configured elapsed-time default and maximum when per-call overrides are supported; `resolve` still validates and caps each request. `language` selects supported program presentation; `isolation` describes the substrate without claiming security. `sandboxMode` advertises file-policy support, with `undefined` for a provider that does not supply confinement. Each implementation keeps program state separate between runs and terminates and awaits active executions during disposal.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxptcruntime--ptcruntime-abstract-seam"></a>

### `ctx.ptcRuntime` — `PtcRuntime` (abstract seam)

Registers one `ctx.ptcRuntime` implementation. Program, budget, abort, and substrate failures resolve in PtcRunResult; only Service Definition contract misuse rejects. Implementations bridge structured-cloneable bindings, materialize each declared namespace rejection class, treat programs as hostile peers, isolate distinct state owners, and terminate and await in-flight runs during disposal.

```ts cordis-catalog
/**
 * Release an owner's retained environment and await its execution resources.
 * Stateless providers have no retained resources to release.
 * @param owner - The exact object supplied as the request's state owner.
 * @returns Completion after all owned execution resources have been released.
 * @throws When managed resource cleanup fails.
 */
release(owner: object): Promise<void>

/**
 * Resolve supported options and provider defaults before execution.
 * @param request - Program, bindings, cancellation and optional execution choices.
 * @returns Complete directory, deadline and supported authority for run.
 * @throws When an explicit choice is invalid or unsupported by this provider.
 */
abstract resolve(request: PtcRunRequest): PtcRunSpec

/**
 * Execute resolved inputs; program outcomes resolve as result fields.
 * @param spec - directory, deadline, program, bindings, cancellation and supported policy.
 * @returns Captured output and the execution outcome.
 */
abstract run(spec: PtcRunSpec): Promise<PtcRunResult>
```

Source: [`packages/ptc-runtime/ptc-runtime/src/index.ts`](../../packages/ptc-runtime/ptc-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
