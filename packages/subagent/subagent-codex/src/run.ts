/**
 * One-shot Codex child lifecycle: spawn the real app-server through the
 * subprocess seam, publish only after initialization and ephemeral thread
 * creation, flatten post-publication failures, and dispose to whole-range
 * quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-codex/run
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  CodexAppServerWire,
  type CodexWireFailureFacts,
} from './wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

interface CodexPackageManifest {
  readonly bin: {
    readonly codex: string
  }
}

const codexPackageJsonPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackageManifest = JSON.parse(
  readFileSync(codexPackageJsonPath, 'utf8'),
) as CodexPackageManifest

/** Absolute package-local JavaScript wrapper selected by the package manifest. */
const CODEX_PACKAGE_BIN = resolve(
  dirname(codexPackageJsonPath),
  codexPackageManifest.bin.codex,
)

/** Profile-selectable non-interactive Codex permission mode. */
export type CodexPermissionMode =
  | 'never'
  | 'approve-for-me'
  | 'dangerously-bypass-approvals-and-sandbox'

/** Native non-interactive Codex modes mapped to official `thread/start` fields. */
export const CODEX_PERMISSION_MODES = [
  'never',
  'approve-for-me',
  'dangerously-bypass-approvals-and-sandbox',
] as const satisfies readonly CodexPermissionMode[]

/** Safe default for unattended Codex runs. */
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'never'

type CodexFailureStage =
  | 'initialize'
  | 'thread-start'
  | CodexWireFailureFacts['stage']
  | 'process'
  | 'teardown'

type CodexFailureCategory = CodexWireFailureFacts['category'] | 'process'

interface CodexFailureFacts {
  readonly stage: CodexFailureStage
  readonly category: CodexFailureCategory
  readonly httpStatus?: number | undefined
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: CodexFailureFacts): string {
  const fields = [
    'product: Codex',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.httpStatus !== undefined) {
    fields.push(`HTTP status: ${facts.httpStatus}`)
  }
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ] as const
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class CodexRunFailure extends Error {
  constructor(
    readonly facts: CodexFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-codex: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'CodexRunFailure'
  }
}

/**
 * Hide an unpublished Host failure behind fixed safe startup facts.
 * @param cause Original Host failure retained for internal diagnostics.
 * @returns A startup failure whose message contains only fixed safe facts.
 */
export function codexStartupFailure(cause: unknown): Error {
  return new CodexRunFailure({
    stage: 'initialize',
    category: 'unknown',
  }, cause)
}

/**
 * Fixed package-local app-server command, independent of the host `PATH`.
 * @returns Node, the official wrapper, and the fixed app-server arguments.
 */
export function codexAppServerArgv(): string[] {
  return [process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']
}

/** Fully resolved inputs for one Codex app-server run. */
export interface CodexRunSpec {
  /** Parent Session workspace, also supplied to `thread/start`. */
  readonly cwd: string
  /** Profile-selected native model; omitted to preserve Codex settings. */
  readonly model?: string
  /** Profile-selected native non-interactive permission mode. */
  readonly permissionMode: CodexPermissionMode
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared managed-range owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('subagent-codex: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-codex: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-codex: the one-shot task must not be empty')
  }
  return texts
}

/**
 * Close the private wire, terminate the managed range, and wait for the
 * subprocess owner to prove it is quiescent.
 * @param wire - private app-server protocol connection.
 * @param child - shared-service handle that owns the managed range.
 */
export async function disposeCodexChild(
  wire: CodexAppServerWire,
  child: SubprocessHandle,
): Promise<void> {
  wire.close()

  let outcome: SubprocessOutcome | undefined
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )
  try {
    child.stdin?.end()
  } catch {
    // A concurrently closed stdin does not change range ownership below.
  }
  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    throw new CodexRunFailure({
      stage: 'teardown',
      category: 'unknown',
      outcome,
    }, thrown(error))
  }
  await child.done.catch(() => {})
}

/**
 * Start the real `codex app-server --stdio` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after initialization and ephemeral thread creation.
 */
export async function startCodexRun(
  request: SubagentStartRequest,
  spec: CodexRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-codex: request was aborted before app-server startup')
  }

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: codexAppServerArgv(),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw new CodexRunFailure({
      stage: 'initialize',
      category: 'unknown',
    }, thrown(error))
  }

  const wire = new CodexAppServerWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
    spec.permissionMode,
    spec.model,
  )
  const onStderr = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    try {
      // Synchronous fd forwarding preserves byte order without owning a
      // backpressure queue. A slow host sink can block this event-loop turn.
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // Host stderr is an observation sink, not a child-run failure authority.
    }
  }
  const onStderrError = (): void => {
    // Stderr observation is auxiliary. JSON-RPC and child.done remain the
    // only terminal authorities if the diagnostic stream itself fails.
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  const disposeProcess = async (): Promise<void> => {
    try {
      await disposeCodexChild(wire, child)
      // Let stderr already queued by the process close reach the Host before
      // its forwarding listeners are detached.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    } finally {
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
    }
  }

  let processFailureFacts: CodexFailureFacts | undefined
  const processFailure: Promise<never> = child.done.then<never>(
    (outcome) => {
      processFailureFacts = {
        stage: 'process',
        category: 'process',
        outcome,
      }
      throw new CodexRunFailure(processFailureFacts)
    },
    (error: unknown) => {
      processFailureFacts = {
        stage: 'process',
        category: 'unknown',
      }
      throw new CodexRunFailure(processFailureFacts, thrown(error))
    },
  )
  // A normal post-result dispose also closes the process. Keep its expected
  // late rejection observed when the terminal result settles first.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-codex: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let startupStage: 'initialize' | 'thread-start' = 'initialize'
  try {
    wire.start()
    await Promise.race([wire.initialize(request.signal), processFailure])
    startupStage = 'thread-start'
    await Promise.race([wire.startThread(spec.cwd, request.signal), processFailure])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = runAbort.signal.aborted
    if (!(error instanceof CodexRunFailure) && !cancelledBeforeCleanup) {
      // Node reports stdout EOF before the child close that owns its outcome.
      // Let an already-exiting process publish those facts before rollback.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
    const failure = new CodexRunFailure({
      stage: startupStage,
      category: 'unknown',
      outcome: error instanceof CodexRunFailure
        ? error.facts.outcome
        : processFailureFacts?.outcome,
    }, thrown(error))
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      const cleanupFailure = thrown(disposeError)
      throw new AggregateError(
        [failure, cleanupFailure],
        `${failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (cancelledBeforeCleanup) {
      throw new Error('subagent-codex: request was aborted before run publication')
    }
    try {
      request.signal.throwIfAborted()
    } catch {
      throw new Error('subagent-codex: request was aborted before run publication')
    }
    throw failure
  }

  const collectOutput = (): ContentBlock[] => wire.collectOutput()
  let diagnostic: string | undefined
  const recordFailureDiagnostic = (facts: CodexFailureFacts): string => {
    const failure = failureDiagnostic(facts)
    const permission = wire.collectDiagnostic()
    diagnostic = permission === undefined
      ? failure
      : `${failure}\n${permission}`
    return diagnostic
  }
  const withProcessOutcome = (facts: CodexFailureFacts): CodexFailureFacts => {
    const outcome = processFailureFacts?.outcome
    return outcome === undefined
      ? facts
      : { ...facts, outcome }
  }
  const publishedProcessFailure = processFailure.catch(
    async (error: unknown): Promise<never> => {
      // Frames already queued by the exiting app-server remain authoritative.
      // One I/O turn lets them settle before process exit ends the run.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      throw error
    },
  )
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        const terminal = await Promise.race([
          wire.runTurn(texts, runAbort.signal),
          publishedProcessFailure,
        ])
        if (terminal.stopReason === 'completed') return terminal
        // Let stderr already queued with the terminal frame reach the Host
        // before the non-completed result settles.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const facts = withProcessOutcome(wire.collectFailure())
        return { ...terminal, diagnostic: recordFailureDiagnostic(facts) }
      } catch (error: unknown) {
        // Give stderr data already queued in Node one turn to reach the Host
        // before error settlement.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const endedBeforeTerminal = wire.endedBeforeTerminal()
        if (
          endedBeforeTerminal
          && processFailureFacts === undefined
          && !runAbort.signal.aborted
        ) {
          try {
            const exited = await child.waitForExit(
              AbortSignal.timeout(Math.ceil(spec.disposeGraceMs)),
            )
            if (exited) await child.done
          } catch {
            // The wire failure remains authoritative when exit observation fails.
          }
        }
        const facts = error instanceof CodexRunFailure
          ? error.facts
          : endedBeforeTerminal && processFailureFacts !== undefined
            ? processFailureFacts
            : withProcessOutcome(wire.collectFailure())
        recordFailureDiagnostic(facts)
        throw error instanceof CodexRunFailure
          ? error
          : new CodexRunFailure(facts, thrown(error))
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
