/**
 * Service Definition for the PTC execution capability seam that runs one model-written program against host async bindings.
 * Runtimes know nothing about tools or sessions; consumers own those concerns.
 * @module @deepseek-ai/dsh-ptc-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { PtcProgramFormat, PtcRunRequest, PtcRunResult, PtcRunSpec } from './types.ts'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

export { PtcImage } from './image.ts'

export type {
  PtcBindingErrorClass,
  PtcBindingFunction,
  PtcBindingNamespace,
  PtcJsonValue,
  PtcProgramFormat,
  PtcRunFailure,
  PtcRunRequest,
  PtcRunResult,
  PtcOutput,
  PtcRunSpec,
  PtcRunSandbox,
} from './types.ts'

/** Output globals reserved for the runtime's console, inspection function, and image constructor. */
export const RESERVED_BINDING_GLOBALS: ReadonlySet<string> = new Set(['console', 'inspect', 'Image'])

/** Error fields unavailable as PtcBindingErrorClass.memberNameProperty. */
export const RESERVED_ERROR_MEMBERS: ReadonlySet<string> = new Set(['name', 'message', 'stack'])

/** ECMAScript keywords and strict-mode names unavailable as binding globals or error class names. */
export const RESERVED_BINDING_WORDS: ReadonlySet<string> = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
])

declare module '@deepseek-ai/cordis' {
  interface Context {
    ptcRuntime: PtcRuntime
  }
}

/**
 * Every {@link PtcRuntimeError} code:
 * - `PTC_RUNTIME_UNAVAILABLE`: the runtime was disposed, or a retained environment's cleanup is
 *   incomplete; release the owner or reload the runtime before running more programs.
 * - `PTC_RUNTIME_CONFLICT`: a program is already running for the same state owner, or the owner's
 *   retained environment was launched under a different sandbox policy; wait, or release the owner.
 * - `PTC_RUNTIME_INVALID_ARGUMENT`: the consumer passed a request or spec that violates this contract,
 *   such as a relative `cwd` or an unresolved spec.
 */
export const PTC_RUNTIME_ERROR_CODES = [
  'PTC_RUNTIME_UNAVAILABLE',
  'PTC_RUNTIME_CONFLICT',
  'PTC_RUNTIME_INVALID_ARGUMENT',
] as const

/** One {@link PtcRuntimeError} code. */
export type PtcRuntimeErrorCode = typeof PTC_RUNTIME_ERROR_CODES[number]

/** Contract misuse a {@link PtcRuntime} rejects; `code` is one of {@link PTC_RUNTIME_ERROR_CODES}. */
export class PtcRuntimeError extends HarnessError {
  override readonly code: PtcRuntimeErrorCode

  constructor(message: string, code: PtcRuntimeErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PtcRuntimeError'
    this.code = code
  }
}

/**
 * Registers one `ctx.ptcRuntime` implementation. Program, budget, abort, and substrate
 * failures resolve in {@link PtcRunResult}; only Service Definition contract misuse rejects, with
 * {@link PtcRuntimeError}. Implementations bridge structured-cloneable bindings, materialize each declared namespace rejection
 * class, treat programs as hostile peers, isolate distinct state owners, and
 * terminate and await in-flight runs during disposal.
 */
export abstract class PtcRuntime extends Service {
  /**
   * The source language {@link run} expects `program` to be written in, as a
   * lowercase identifier. Informational, not gating — a consumer that
   * generates language-specific presentation (typed SDK stubs, usage
   * instructions) switches on it and fails loud on a language it cannot
   * present. The shipped Node backend and `dsh-tool-executor-ptc` support
   * `'typescript'`. Other languages require their own consumers.
   */
  abstract readonly language: string

  /**
   * The execution substrate, as a lowercase identifier. Informational, not
   * gating — a descriptor so deployments and diagnostics can tell backends
   * apart, not a security claim. Well-known values: `'worker-thread'`,
   * `'process'`, `'container'`.
   */
  abstract readonly isolation: string

  /** Source evaluation form, independent of whether the provider retains state for an owner. */
  get programFormat(): PtcProgramFormat { return 'function-body' }

  /** Whether this provider retains program memory across runs for the same stateOwner. */
  get retainsState(): boolean { return false }

  /**
   * Release an owner's retained environment and await its execution resources.
   * Stateless providers have no retained resources to release.
   * @param owner - The exact object supplied as the request's state owner.
   * @returns Completion after all owned execution resources have been released.
   * @throws When managed resource cleanup fails.
   */
  release(owner: object): Promise<void> { void owner; return Promise.resolve() }

  /**
   * Register source evaluated once when each execution environment is created.
   * Registration must precede the first run admission; only one initializer may
   * be registered. Current bindings are installed before initialization. Its
   * completion is discarded; logs, timeout, cancellation and output bounds share
   * the first run. Initialization failure discards the environment without
   * executing the user program or rolling back external effects.
   * @param program - Initialization source in the provider's language and format.
   * @returns An idempotent async disposer that stops admission, cancels and drains
   * admitted runs, and releases environments. Failed cleanup blocks execution
   * until the disposer succeeds on retry. The caller owns this disposer.
   * @throws When unsupported, registered twice, registered after admission, or invalid.
   */
  registerEnvironmentInitializer(program: string): () => Promise<void> {
    void program
    throw new Error('PTC runtime: environment initialization is unsupported')
  }

  /** Provider-owned program usage guidance for consumers to present alongside the source language. */
  get executionInstructions(): string { return '' }

  /** Deployment file-policy mode, or undefined for a provider without confinement support. */
  get sandboxMode(): SandboxMode | undefined { return undefined }

  /** Configured numeric elapsed-time defaults and cap, or undefined when per-call overrides are unsupported. */
  get timeout(): { defaultMs: number; maxMs: number } | undefined { return undefined }

  constructor(ctx: Context) {
    super(ctx, 'ptcRuntime')
  }

  /**
   * Resolve supported options and provider defaults before execution.
   * @param request - Program, bindings, cancellation and optional execution choices.
   * @returns Complete directory, deadline and supported authority for run.
   * @throws When an explicit choice is invalid or unsupported by this provider; contract misuse throws {@link PtcRuntimeError}.
   */
  abstract resolve(request: PtcRunRequest): PtcRunSpec

  /**
   * Execute resolved inputs; program outcomes resolve as result fields.
   * @param spec - directory, deadline, program, bindings, cancellation and supported policy.
   * @returns Captured output and the execution outcome.
   */
  abstract run(spec: PtcRunSpec): Promise<PtcRunResult>
}

export default PtcRuntime
