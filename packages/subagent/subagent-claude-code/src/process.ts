/**
 * Projection from the shared managed-process handle to the official Claude
 * Agent SDK's custom-spawn process interface.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/process
 */

import { EventEmitter } from 'node:events'
import type {
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

function thrown(value: unknown): Error {
  /* v8 ignore next -- the subprocess seam rejects with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Encode the SDK's complete child environment as a subprocess overlay.
 * @param env - SDK-composed child environment after its removals and replacements.
 * @returns explicit values plus tombstones for surviving ambient names the SDK removed.
 */
export function sdkEnvironmentOverlay(
  env: SpawnOptions['env'],
): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(scrubbedParentEnv())) {
    if (!(name in env)) overlay[name] = undefined
  }
  return overlay
}

/**
 * Translate one official SDK spawn request to the shared process owner.
 * @param options - command, arguments, workspace, environment, and forwarded signal from the SDK.
 * @param graceMs - managed-range termination grace.
 * @returns the fully explicit shared subprocess request.
 */
export function claudeSpawnSpec(
  options: SpawnOptions,
  graceMs: number,
): SubprocessSpawnSpec {
  if (options.cwd === undefined || options.cwd.length === 0) {
    throw new Error('subagent-claude-code: SDK spawn request omitted its workspace')
  }
  return {
    argv: [options.command, ...options.args],
    cwd: options.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs,
    signal: options.signal,
    env: sdkEnvironmentOverlay(options.env),
  }
}

/**
 * SDK-facing view of one shared managed process. Protocol transport remains
 * in the official SDK; this adapter only projects streams and exit events.
 */
export class ManagedClaudeCodeProcess implements SpawnedProcess {
  readonly stdin
  readonly stdout
  private readonly events = new EventEmitter()
  private outcomeValue: SubprocessOutcome | undefined
  private killRequested = false

  /**
   * Project a managed process with piped stdin and stdout.
   * @param child - shared handle that remains the managed-range authority.
   */
  constructor(private readonly child: SubprocessHandle) {
    this.stdin = child.stdin as NonNullable<SubprocessHandle['stdin']>
    this.stdout = child.stdout as NonNullable<SubprocessHandle['stdout']>
    // EventEmitter gives `error` special throw semantics without a listener.
    // The SDK attaches its listener synchronously after custom spawn returns,
    // while this no-op also contains an already-rejected spawn handle.
    this.events.on('error', () => {})
    void child.done.then(
      (outcome) => {
        this.outcomeValue = outcome
        this.events.emit('exit', outcome.exitCode, outcome.signal)
      },
      (error: unknown) => {
        this.events.emit('error', thrown(error))
      },
    )
  }

  /** Whether the SDK has requested managed-range termination. */
  get killed(): boolean {
    return this.killRequested
  }

  /** Direct-child exit code, or null while running or after signal exit. */
  get exitCode(): number | null {
    return this.outcomeValue?.exitCode ?? null
  }

  /** Direct-child terminating signal, if any. */
  get signalCode(): NodeJS.Signals | null {
    return this.outcomeValue?.signal ?? null
  }

  /** Exact managed-process outcome after exit, or undefined while running. */
  get outcome(): SubprocessOutcome | undefined {
    return this.outcomeValue
  }

  /**
   * Route the SDK's termination request to the managed-range process owner.
   * @param _signal - SDK-selected signal; the shared seam owns its escalation ladder.
   * @returns false only after exit or a previous termination request.
   */
  kill(_signal: NodeJS.Signals): boolean {
    if (
      this.killRequested
      || this.outcomeValue !== undefined
    ) {
      return false
    }
    this.killRequested = true
    this.child.terminate()
    return true
  }

  /** Register a persistent process lifecycle listener. */
  on(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.on(event, listener)
  }

  /** Register a one-shot process lifecycle listener. */
  once(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.once(event, listener)
  }

  /** Remove a process lifecycle listener. */
  off(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.off(event, listener)
  }
}
