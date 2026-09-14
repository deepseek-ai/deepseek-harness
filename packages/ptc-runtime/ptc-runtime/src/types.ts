/**
 * Vocabulary types for the PTC execution seam: what a caller hands a
 * {@link ../index.ts | PtcRuntime} and what it gets back. Pure types — no
 * runtime code lives here.
 *
 * @module @deepseek-ai/dsh-ptc-runtime/src/types
 */

import type { SandboxEnforcement, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * One host-side function exposed to the program as an async callable. The
 * runtime bridges calls to it (possibly across a serialization boundary), so
 * `args` and the resolution value MUST be lossless JSON. A runtime rejects a
 * lossy or non-cloneable value with a descriptive error rather than corrupting
 * the run. No seam-level byte cap applies to a binding resolution. A rejection
 * of this function surfaces inside the program as a rejection of the
 * corresponding call.
 */
export type PtcBindingFunction = (args: unknown) => Promise<PtcJsonValue>

/** A lossless JSON value transferable through the dependency-light Service Definition. */
export type PtcJsonValue = null | boolean | number | string | PtcJsonValue[] | { [key: string]: PtcJsonValue }

/**
 * Program-visible typed rejection for one binding namespace. The runtime
 * injects a real error constructor under `name`; rejected member calls become
 * its instances and expose the exact member name through
 * `memberNameProperty`. Both strings are runtime data rather than knowledge
 * of a particular consumer such as PTC mode.
 */
export interface PtcBindingErrorClass {
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

/**
 * A named group of {@link PtcBindingFunction}s the runtime exposes to the
 * program as one global object (e.g. `tools`). Function names are arbitrary
 * strings — a runtime must treat names like `__proto__` or `constructor` as
 * ordinary own properties (null-prototype construction), never as prototype
 * collisions.
 */
export interface PtcBindingNamespace {
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

/**
 * Caller inputs for one program. The provider's resolve method validates supported
 * options and supplies directory, deadline, and authority before execution.
 */
export interface PtcRunRequest {
  /**
   * The program source, in the runtime's {@link ../index.ts | language}. It
   * runs as the body of an async function: top-level `await` and `return`
   * are available, and the completion value becomes
   * {@link PtcRunResult.value}.
   */
  program: string
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

/** Fully resolved execution inputs; run never supplies a missing directory or deadline choice. */
export interface PtcRunSpec extends PtcRunRequest {
  /** Absolute directory in the provider's execution world. */
  cwd: string
  /** Positive finite elapsed budget in milliseconds after provider capping, or null for no deadline. */
  timeoutMs: number | null
}

/** File confinement applied to a program, independently of its terminal outcome. */
export interface PtcRunSandbox {
  /** File-effect mode used for this execution. */
  mode: SandboxMode
  /** Program failure text matched backend diagnostics; not enforcement proof or an exhaustive denial record. */
  denied: boolean
  /** Completeness reported by the selected confining backend; absent for full access. */
  enforcement?: SandboxEnforcement
}

/**
 * Why a run failed. The kinds are orthogonal outcomes reported independently
 * (per docs/defensive-patterns.md): a budget expiry is not an exception, an
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
export interface PtcRunFailure {
  /** The failure class (see the interface doc for each kind's meaning). */
  kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit' | 'protocol' | 'sandbox-unavailable'
  /** Human-readable detail, suitable for feeding back to a model to self-correct. */
  message: string
}

/**
 * The outcome of one run. An error is a FIELD on a resolved result, never a
 * rejection of `run()` — reporting a failed program is the caller's job, not
 * an exception path.
 */
export interface PtcRunResult {
  /** Applied file policy and observed denial, when the provider enforces file policy. */
  sandbox?: PtcRunSandbox
  /**
   * The program's completion value (its top-level `return`), when it ran to
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
