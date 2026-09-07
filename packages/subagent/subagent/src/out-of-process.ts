/**
 * Provider-side vocabulary for OUT-OF-PROCESS subagent backends — the pieces
 * that enforce this seam's own contracts around a child in another process:
 * the no-capabilities advertisement, timing-bound validation, child
 * working-directory resolution (config override, else the delegating parent
 * session's workspace), the never-reject result settlement, and the standard
 * run-handle publication. Backends compose these with their own wire drivers;
 * the process machinery itself (spawn, env scrub, managed-range teardown)
 * belongs to the `dsh-subprocess` seam.
 *
 * @module @deepseek-ai/dsh-subagent/out-of-process
 */

import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentCapabilities, SubagentResult, SubagentRun, SubagentStopReason } from './types.ts'

/** Maximum UTF-8 size of {@link SubagentResult.diagnostic}. */
const MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096

const DIAGNOSTIC_TRUNCATION_SUFFIX = '\n[diagnostic truncated]'
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * Limit provider-authored failure detail without splitting a UTF-8 sequence.
 * @param diagnostic - safe diagnostic text produced by the provider.
 * @returns the original text, or a visibly truncated value within the limit.
 */
function limitSubagentDiagnostic(diagnostic: string): string {
  const bytes = utf8Encoder.encode(diagnostic)
  if (bytes.byteLength <= MAX_SUBAGENT_DIAGNOSTIC_BYTES) return diagnostic

  const suffixBytes = utf8Encoder.encode(DIAGNOSTIC_TRUNCATION_SUFFIX).byteLength
  let prefixBytes = MAX_SUBAGENT_DIAGNOSTIC_BYTES - suffixBytes
  while (((bytes[prefixBytes] as number) & 0b1100_0000) === 0b1000_0000) {
    prefixBytes -= 1
  }
  return utf8Decoder.decode(bytes.subarray(0, prefixBytes))
    + DIAGNOSTIC_TRUNCATION_SUFFIX
}

/** Enforce the byte limit on a provider-returned diagnostic. */
function normalizeSubagentDiagnostic(result: SubagentResult): SubagentResult {
  return result.diagnostic === undefined
    ? result
    : { ...result, diagnostic: limitSubagentDiagnostic(result.diagnostic) }
}

/**
 * The capability advertisement of an out-of-process backend: NONE. A child in
 * another process cannot honor parent-enforced start features
 * (`agentOptions`/`outputSchema`/`maxDepth`/`toolFilter`/`persona`), so the service rejects a
 * request needing any of them before `start` runs — never accepted-then-ignored.
 */
export const NO_START_CAPABILITIES: SubagentCapabilities = Object.freeze({
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

/**
 * Assert a configured timing bound is a positive finite number (it bounds a
 * teardown or shutdown wait; zero, negative, or NaN would skip or wedge it).
 * @param prefix - the consuming plugin's diagnostic prefix (e.g. `subagent-acp`).
 * @param name - the config field name, for the diagnostic.
 * @param value - the configured value.
 */
export function assertPositiveFinite(prefix: string, name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${prefix}: ${name} must be a positive finite number`)
  }
}

/**
 * Whether `path` names an existing directory the harness can ENTER. The
 * search-permission probe matters: `statSync().isDirectory()` is true for a
 * mode-600 directory, but a subprocess cwd needs `X_OK` or spawn fails EACCES.
 */
function isEnterableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    // statSync/accessSync throw only filesystem access errors here
    // (ENOENT/EACCES/ENOTDIR/…), and every one of them means the path cannot
    // serve as the child's cwd.
    return false
  }
}

/**
 * Assert `cwd` can actually host the child: absolute (it doubles as the
 * child's workspace identity, and a relative path would be re-anchored to the
 * server process's launch directory) and an existing directory (fail here,
 * before the process boundary, instead of as an ambiguous spawn ENOENT).
 * @param prefix - the consuming plugin's diagnostic prefix.
 * @param label - which source supplied the value, for the diagnostic.
 * @param cwd - the candidate working directory.
 * @returns `cwd`, validated.
 */
export function assertUsableCwd(prefix: string, label: string, cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new Error(`${prefix}: ${label} must be an absolute path: ${cwd}`)
  }
  if (!isEnterableDirectory(cwd)) {
    throw new Error(`${prefix}: ${label} is not an accessible directory: ${cwd}`)
  }
  return cwd
}

/**
 * Validate a configured `cwd` override ONCE, at plugin load: reject the empty
 * string (`path.resolve('')` is the process cwd — it would silently
 * reintroduce the launch-directory fallback this resolution removes),
 * interpret a relative path against the harness launch directory, and require
 * an enterable directory.
 * @param prefix - the consuming plugin's diagnostic prefix.
 * @param cwd - the configured override, or `undefined` when the config omits it.
 * @returns the validated absolute override, or `undefined` when omitted.
 */
export function validateConfiguredCwd(prefix: string, cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (cwd === '') {
    throw new Error(`${prefix}: config cwd must not be empty — omit the key to inherit the parent session cwd`)
  }
  return assertUsableCwd(prefix, 'config cwd', resolve(cwd))
}

/**
 * Resolve the child's working directory at start: the deployment override
 * when configured (already validated at load), else the parent session's
 * workspace cwd (validated here, its earliest resolvable point). Fails loud
 * when neither exists — falling back to the harness process cwd would
 * silently bind the child to the server's launch directory instead of the
 * delegating session's workspace (one server process serves many sessions,
 * each with its own cwd).
 * @param prefix - the consuming plugin's diagnostic prefix.
 * @param configured - the load-validated override, or `undefined`.
 * @param parentCwd - the delegating parent session's workspace cwd, if any.
 * @returns the absolute child working directory.
 */
export function resolveChildCwd(prefix: string, configured: string | undefined, parentCwd: string | undefined): string {
  if (configured !== undefined) return configured
  if (parentCwd === undefined) {
    throw new Error(`${prefix}: no working directory for the child — configure \`cwd\` or delegate from a parent session that has one`)
  }
  return assertUsableCwd(prefix, 'parent session cwd', parentCwd)
}

/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function toError(value: unknown): Error {
  // The rejecting surfaces (wire clients, spawn failures) only throw
  // `Error`s; the `String(value)` arm is a defensive fallback for a non-Error
  // throw the typed surfaces cannot produce.
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

/** Inputs to {@link settleRunResult}. */
export interface RunResultSettlement {
  /** The turn attempt (typically racing local cancellation); returns the terminal result. */
  attempt: () => Promise<SubagentResult>
  /** Snapshot the provider exposes when cancellation or failure wins settlement. */
  collectOutput: () => ContentBlock[]
  /** Snapshot safe provider-authored detail when a failure wins settlement. */
  collectDiagnostic?: (() => string | undefined) | undefined
  /** Whether local cancellation settled before the attempt's outcome is observed. */
  cancelled: () => boolean
  /** Diagnostic sink for a failure flattened to a stop reason; a throw from it is contained. */
  onError?: ((error: Error, stopReason: SubagentStopReason) => void) | undefined
  /** The request's cancellation signal (the listener is removed at settlement). */
  signal: AbortSignal
  /** The abort listener registered on {@link signal} at start. */
  onAbort: () => void
}

/**
 * Settle an out-of-process run result under the seam contract: `result` never
 * rejects after publication. A normally completed or rejected attempt resolves
 * as `aborted` when cancellation already settled locally; another rejection is
 * flattened to `stopReason: 'error'` through the contained diagnostic sink.
 * Provider-returned diagnostics use the same byte limit. The abort listener is
 * removed on every path.
 * @param parts - the attempt, output snapshot, cancellation state, sink, and signal wiring.
 * @returns the terminal result (never a rejection).
 */
export async function settleRunResult(parts: RunResultSettlement): Promise<SubagentResult> {
  try {
    const result = await parts.attempt()
    return parts.cancelled()
      ? { output: parts.collectOutput(), stopReason: 'aborted' }
      : normalizeSubagentDiagnostic(result)
  } catch (error: unknown) {
    // Cover a rejection already queued when cancellation arrives.
    if (parts.cancelled()) return { output: parts.collectOutput(), stopReason: 'aborted' }
    // Flatten post-publication transport failures while preserving diagnostics.
    try {
      parts.onError?.(toError(error), 'error')
    } catch {
      // The diagnostic sink cannot reject the run result.
    }
    const collected = parts.collectDiagnostic?.()
    const diagnostic = collected === undefined
      ? undefined
      : limitSubagentDiagnostic(collected)
    return {
      output: parts.collectOutput(),
      ...diagnostic === undefined ? {} : { diagnostic },
      stopReason: 'error',
    }
  } finally {
    parts.signal.removeEventListener('abort', parts.onAbort)
  }
}

/** Inputs to {@link subprocessRunHandle}. */
export interface SubprocessRunHandleParts {
  /** The parent-scoped run id. */
  id: SubagentRun['id']
  /** The flattened, never-rejecting result (the seam contract). */
  result: Promise<SubagentResult>
  /** The request's cancellation signal (the listener is removed on dispose). */
  signal: AbortSignal
  /** The abort listener registered on {@link signal} at start. */
  onAbort: () => void
  /** Settle local cancellation so {@link result} resolves without the child. */
  requestCancel: () => void
  /** Tear the child process down to quiescence (backend-owned ladder). */
  teardown: () => Promise<void>
}

/**
 * Publish the seam run handle for an out-of-process child. `dispose()` is
 * idempotent (one memoized teardown): it removes the abort listener, settles
 * local cancellation — there is no assumption the child cooperates — and then
 * awaits the backend's teardown to actual exit.
 * @param parts - the run identity, result, cancellation wiring, and teardown.
 * @returns the seam run handle (`localAgent` is `undefined` for remote runs).
 */
export function subprocessRunHandle(parts: SubprocessRunHandleParts): SubagentRun {
  let disposal: Promise<void> | undefined
  return {
    id: parts.id,
    localAgent: undefined,
    result: parts.result,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      parts.signal.removeEventListener('abort', parts.onAbort)
      parts.requestCancel()
      disposal = parts.teardown()
      return disposal
    },
  }
}
