/**
 * Vocabulary for the subprocess Service Definition: fully-specified spawn requests with
 * Node-shaped per-stream stdio modes, bounded collected output with spill
 * recovery, raw piped streams, and managed-range termination. Command
 * defaulting, shell semantics, protocol framing, and presentation belong to
 * consumers such as the bash executor seam.
 * @module dsh-subprocess/types
 */

import type { Readable, Writable } from 'node:stream'

/** Namespace prefix reserved for DeepSeek Harness-managed child environment facts. */
export const DSH_ENV_PREFIX = 'DSH_' as const

/** One environment key inside the managed {@link DSH_ENV_PREFIX} namespace. */
export type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`

/** Trusted DeepSeek Harness variables for one child-process execution. */
export type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>

/** One captured stream: the (possibly truncated) text plus recovery info. */
export interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}

/**
 * stdin disposition. `'ignore'` leaves fd 0 on `/dev/null`; `'pipe'` exposes
 * {@link SubprocessHandle.stdin} for the caller's ongoing protocol writes;
 * `{ data }` writes the bytes and closes (the batch shape).
 */
export type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }

/**
 * Bounded in-memory collection for one output stream, with an optional
 * full-stream spill file. Omitting `spill` keeps only the in-memory tail —
 * the diagnostic-tail shape (a language server's stderr); including it makes
 * the complete stream recoverable up to its cap (the bash tool shape).
 */
export interface SubprocessCollect {
  /** In-memory cap in bytes; overflow keeps the TAIL. */
  maxBytes: number
  /** Full-stream spill file; absent disables spilling entirely. */
  spill?: {
    /** Whole-stream byte cap; a larger stream discards its now-incomplete spill. */
    maxBytes: number
  }
}

/**
 * stdout/stderr disposition. `'pipe'` exposes the raw `Readable` for the
 * caller's protocol decoding; `'inherit'` passes the parent's descriptor
 * through (child diagnostics land on the harness's own stream); a
 * {@link SubprocessCollect} object buffers boundedly with offset-based reads.
 */
export type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect

/** Per-stream stdio dispositions, all explicit — this seam applies no defaults. */
export interface SubprocessStdio {
  stdin: SubprocessStdinMode
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
}

/**
 * A fully-specified spawn request. This seam applies no defaults: every
 * disposition, limit, and directory is explicit, so the caller's own config —
 * not a hidden subprocess-service default — decides them (the `dsh-shell`
 * request/spec split is the owning template).
 */
export interface SubprocessSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted here. */
  argv: readonly string[]
  /** Working directory for the child. */
  cwd: string
  /** Per-stream stdio dispositions. */
  stdio: SubprocessStdio
  /**
   * Positive finite grace period in milliseconds, no greater than
   * `MAX_TIMER_DELAY_MS`, available to the provider's termination procedure
   * and used for draining still-open collected pipes after the process exits
   * (an inherited descriptor held by a survivor cannot hold the outcome open
   * indefinitely). Providers document whether range termination is staged or
   * immediate.
   */
  graceMs: number
  /**
   * Abort signal — starts the terminate escalation on the managed range when
   * it fires. The caller owns deadlines and cause classification; this seam
   * only reacts to the abort.
   */
  signal?: AbortSignal | undefined
  /**
   * Explicit environment entries merged onto the implementation's scrubbed
   * parent base (see `scrubbedParentEnv`), with no namespace validation. A
   * string is a deliberate caller opt-in, so a forwarded credential-shaped
   * entry or current `DSH_*` fact survives the scrub; `undefined` is a
   * tombstone that removes an ordinary ambient entry from the child.
   */
  env?: NodeJS.ProcessEnv | undefined
}

/**
 * Exit facts of one closed process — Node's `close`-event vocabulary.
 * Deliberately carries NO timeout or cancellation classification (the caller
 * reads the signal it owns to classify causes) and NO output: collected
 * streams stay readable through {@link SubprocessHandle.collected} after
 * settlement, so batch and streaming callers share one access path.
 */
export interface SubprocessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
}

/** One incremental {@link SubprocessOutputReader.readFrom} read. */
export interface SubprocessOutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Path to the full-stream spill file, when one was created and remains intact. */
  spillPath?: string
}

/**
 * Cursor-free incremental access to one collected output stream. Offsets are
 * whole-stream byte coordinates owned by the caller, so independent readers
 * cannot consume one another's output; `readFrom(0)` after settlement is the
 * batch result (`lossy` then means the in-memory tail lost its head — the
 * {@link CollectedOutput.truncated} fact).
 */
export interface SubprocessOutputReader {
  /**
   * Read everything captured since `fromByte`. When that offset has slid out
   * of the in-memory tail window the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the next offset, the `lossy` flag, and the spill path when one exists.
   */
  readFrom(fromByte: number): SubprocessOutputRead
}

/** Offset-based readers for the streams spawned in collect mode. */
export interface SubprocessCollectedOutputs {
  /** Present iff stdout is a {@link SubprocessCollect}. */
  readonly stdout?: SubprocessOutputReader
  /** Present iff stderr is a {@link SubprocessCollect}. */
  readonly stderr?: SubprocessOutputReader
}

/**
 * A live subprocess and its provider-managed process range. Collected output
 * remains readable after exit; piped streams belong to the caller.
 *
 * Termination and {@link SubprocessHandle.waitForExit} use the same managed
 * range. Each provider documents the range it can observe and its signalling
 * and observation limits.
 */
export interface SubprocessHandle {
  /** The child's stdin, present iff spawned with `stdin: 'pipe'`. */
  readonly stdin: Writable | undefined
  /** The child's raw stdout, present iff spawned with `stdout: 'pipe'`. */
  readonly stdout: Readable | undefined
  /** The child's raw stderr, present iff spawned with `stderr: 'pipe'`. */
  readonly stderr: Readable | undefined
  /** Offset-based readers for collect-mode streams (also readable after exit). */
  readonly collected: SubprocessCollectedOutputs
  /** Resolves with spawned-command exit facts; rejects for spawn or provider failures. */
  readonly done: Promise<SubprocessOutcome>
  /**
   * Begin the provider's documented termination procedure on the managed range
   * — the seam's only termination verb. Idempotent, a no-op once that range is
   * gone, and also triggered by the spec's abort signal.
   */
  terminate(): void
  /**
   * Wait until the same managed range is empty — not just until the spawned
   * command reports its outcome, so surviving work remains observable.
   * @param signal - optional bound for the wait.
   * @returns `true` when the managed range is empty, `false` when the signal aborted first.
   * @throws when the selected provider can no longer observe its managed range.
   */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/**
 * Signals supported by the terminal-process primitive. Kept member-identical
 * to `TerminalSignal` in `@deepseek-ai/dsh-terminal` without a cross-seam dependency;
 * change both together.
 */
export type SubprocessTerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

/** A fully specified terminal-process spawn. */
export interface SubprocessTerminalSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. */
  argv: readonly string[]
  /** Working directory in this subprocess provider's execution world. */
  cwd: string
  /** Explicit environment layered after the provider's ambient scrub. */
  env?: Record<string, string> | undefined
  /** Initial terminal row count. */
  rows: number
  /** Initial terminal column count. */
  cols: number
  /** TERM-to-KILL cleanup grace for the complete terminal session. */
  graceMs: number
  /** Cancellation of terminal allocation; a published handle owns its later lifetime. */
  signal?: AbortSignal | undefined
}

/** Current foreground process-group facts for one terminal. */
export interface SubprocessTerminalForeground {
  /** Foreground process-group id published by the terminal driver. */
  processGroupId: number
  /** Whether the provider can currently prove that group is waiting on terminal input. */
  inputWaiting: boolean
}

/**
 * One live terminal process and its owned OS session. Terminal allocation,
 * foreground-group inspection/signalling, and whole-session quiescence are one
 * deep subprocess primitive because none can be reconstructed from ordinary
 * piped stdio without substrate-specific process control.
 */
export interface SubprocessTerminalHandle {
  /** Top-level terminal process id. */
  readonly pid: number
  /** UTF-8 terminal output bytes in delivery order; ends after queued output when the terminal exits. */
  readonly output: Readable
  /** Resolves when the top-level process exits; rejects for a terminal startup, provider, or live transport failure. */
  readonly done: Promise<SubprocessOutcome>
  /**
   * Write text to the terminal input.
   * @param data - text to deliver without implicit newline conversion.
   */
  write(data: string): Promise<void>
  /**
   * Inspect the current foreground process group.
   * @returns its id and input-wait fact, or undefined when no foreground group can be resolved.
   */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined>
  /**
   * Deliver a signal to the current foreground process group.
   * @param signal - permitted terminal signal.
   * @returns the exact group id that received it.
   */
  signalForeground(signal: SubprocessTerminalSignal): Promise<number>
  /**
   * Idempotently terminate every terminal-session member the provider can still observe and await quiescence.
   * After settlement, no write, inspection, or signal call remains in flight.
   * Providers document substrate-specific observability limits.
   */
  terminate(): Promise<void>
}
