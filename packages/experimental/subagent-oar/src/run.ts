/**
 * One-shot OAR execution, root-answer selection, and owned session disposal.
 * Native records remain in OAR; DSH receives assistant text and fixed failure facts.
 *
 * @module @deepseek-ai/dsh-experimental-subagent-oar/run
 */

import { randomUUID } from 'node:crypto'
import type {
  FailureClass,
  InstallationSnapshot,
  RejectionCode,
  Runtime,
  Session,
  TurnOutcome,
} from '@botiverse/oar'
import { awaitTurnEnd } from '@botiverse/oar/observe'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
  type ResolvedSubagentStartRequest,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { oarEnvironment } from './environment.ts'

/** Resolved deployment settings and the runtime owned by one provider instance. */
export interface OarRunSpec {
  /** Selected OAR runtime; installation is probed for each delegation. */
  readonly runtime: Runtime
  /** Native model id; omitted to preserve native settings. */
  readonly model?: string
  /** Native reasoning effort; unsupported choices fail at startup. */
  readonly effort?: string
  /** Explicit environment applied after the shared credential scrub. */
  readonly env: Readonly<Record<string, string | null>>
  /** Native process arguments; OAR validates arguments it owns. */
  readonly launchArgs: readonly string[]
  /** Optional turn deadline in milliseconds; excludes OAR session startup. */
  readonly timeoutMs?: number
  /** Receives safe summaries; native causes are retained for debugging and can contain secrets. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

type FailureStage = 'installation' | 'startup' | 'turn' | 'abort' | 'dispose'
type FailureCategory = FailureClass | RejectionCode | 'not-found' | 'unsupported' | 'timeout'

const failureAdvice: Readonly<Record<FailureStage, string>> = {
  installation: 'Install and authenticate the selected runtime before retrying.',
  startup: 'Check the runtime installation, authentication, and launch settings.',
  turn: 'Check the selected runtime and its account before retrying.',
  abort: 'The runtime did not accept interruption; session disposal was requested.',
  dispose: 'The runtime may still be active; check it before starting another task.',
}

/**
 * Every {@link OarFailure} code:
 * - `OAR_INVALID_TASK` — the task is empty or contains a non-text block; send one non-empty text task.
 * - `OAR_RUNTIME_UNAVAILABLE` — the selected runtime is unsupported, not installed, or its installation probe failed;
 *   install and authenticate it before retrying.
 * - `OAR_START_FAILED` — the runtime could not open or publish a session; check its installation, authentication, and launch settings.
 * - `OAR_TURN_FAILED` — the native turn failed or was rejected; check the runtime and its account before retrying.
 * - `OAR_ABORT_FAILED` — the runtime did not accept interruption; session disposal was requested.
 * - `OAR_DISPOSE_FAILED` — session disposal failed and the runtime may still be active; check it before starting another task.
 */
export const OAR_FAILURE_CODES = [
  'OAR_INVALID_TASK',
  'OAR_RUNTIME_UNAVAILABLE',
  'OAR_START_FAILED',
  'OAR_TURN_FAILED',
  'OAR_ABORT_FAILED',
  'OAR_DISPOSE_FAILED',
] as const

/** One code from {@link OAR_FAILURE_CODES}. */
export type OarFailureCode = typeof OAR_FAILURE_CODES[number]

const stageCodes: Readonly<Record<FailureStage, OarFailureCode>> = {
  installation: 'OAR_RUNTIME_UNAVAILABLE',
  startup: 'OAR_START_FAILED',
  turn: 'OAR_TURN_FAILED',
  abort: 'OAR_ABORT_FAILED',
  dispose: 'OAR_DISPOSE_FAILED',
}

/** OAR delegation failure carrying a stable {@link OarFailureCode}; native causes stay in `cause` and can contain secrets. */
export class OarFailure extends HarnessError {
  override readonly code: OarFailureCode

  /**
   * @param message - safe summary without native detail.
   * @param code - failure class.
   * @param options - native cause, retained for local debugging.
   */
  constructor(message: string, code: OarFailureCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'OarFailure'
    this.code = code
  }
}

/** Build the safe stage and category summary for one native failure. */
function stageFailure(stage: FailureStage, category: FailureCategory, options?: ErrorOptions): OarFailure {
  const message = `OAR subagent failure (stage: ${stage}; category: ${category}). ${failureAdvice[stage]}`
  return new OarFailure(message, stageCodes[stage], options)
}

function reportFailure(spec: OarRunSpec, error: OarFailure): void {
  try {
    spec.onError?.(error, 'error')
  } catch (_error: unknown) {
    // A diagnostic observer cannot replace the run's result or cleanup failure.
  }
}

/**
 * Validate one text task before opening a native session.
 * @param prompt - content supplied by the shared subagent service.
 * @returns the text blocks in their original order, without inserted separators.
 * @throws {OarFailure} `OAR_INVALID_TASK` when the task is empty or contains a non-text block.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new OarFailure('subagent-oar: the one-shot task must contain only text blocks', 'OAR_INVALID_TASK')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new OarFailure('subagent-oar: the one-shot task must contain only text blocks', 'OAR_INVALID_TASK')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new OarFailure('subagent-oar: the one-shot task must not be empty', 'OAR_INVALID_TASK')
  }
  return texts.join('')
}

/** Cancellation remains live across native startup and cleanup awaits. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** The caller cancelled delegation before the run was published. */
function cancellationFailure(): DOMException {
  return new DOMException('OAR subagent startup was cancelled', 'AbortError')
}

async function disposeSession(session: Session, spec: OarRunSpec): Promise<void> {
  try {
    await session.dispose()
  } catch (error: unknown) {
    const failure = stageFailure('dispose', 'unknown', { cause: error })
    reportFailure(spec, failure)
    throw failure
  }
}

function completedTurn(outcome: TurnOutcome, output: readonly ContentBlock[]): SubagentResult {
  switch (outcome.kind) {
    case 'completed':
      return { output, stopReason: 'completed' }
    case 'aborted':
      return { output, stopReason: 'aborted' }
    case 'failed':
      return {
        output,
        stopReason: 'error',
        diagnostic: stageFailure('turn', outcome.failure).message,
      }
    /* v8 ignore next -- OAR supplies the closed TurnOutcome union; native parsing belongs to its adapters. */
    default: return assertNever(outcome)
  }
}

function publishRun(
  session: Session,
  prompt: string,
  request: ResolvedSubagentStartRequest,
  spec: OarRunSpec,
): SubagentRun {
  const stopped = Promise.withResolvers<SubagentResult>()
  const messages = new Map<string, string>()
  let streamedText = ''
  let phase: 'running' | 'cancelled' | 'timeout' | 'settled' = 'running'
  let disposal: Promise<void> | undefined

  const collectOutput = (): readonly ContentBlock[] => {
    let answer = streamedText
    for (const text of messages.values()) {
      if (text.length > 0) answer = text
    }
    return answer.length === 0 ? [] : [{ type: 'text', text: answer }]
  }
  const dispose = (): Promise<void> => disposal ??= disposeSession(session, spec)
  const abort = async (): Promise<void> => {
    try {
      await session.abort()
    } catch (error: unknown) {
      reportFailure(spec, stageFailure('abort', 'unknown', { cause: error }))
    }
  }
  const interrupt = (reason: 'cancelled' | 'timeout'): void => {
    if (phase !== 'running') return
    phase = reason
    stopped.resolve({
      output: collectOutput(),
      stopReason: reason === 'cancelled' ? 'aborted' : 'error',
      ...reason === 'timeout' ? {
        diagnostic: 'OAR subagent exceeded its execution timeout. Increase timeoutMs or use a smaller task.',
      } : {},
    })
    void abort()
    // The run handle awaits the same disposal; observe its rejection while cancellation settles.
    void dispose().catch((_error: unknown) => {})
  }
  const onAbort = (): void => { interrupt('cancelled') }
  const unsubscribe = session.events((event) => {
    if (event.sessionId !== session.id || event.agentPath.length !== 0 || event.kind !== 'text_delta') return
    streamedText += event.text
    if (event.messageId !== undefined) {
      messages.set(event.messageId, (messages.get(event.messageId) ?? '') + event.text)
    }
  }, { cursor: { sessionId: session.id, afterSeq: -1 } })
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (isAborted(request.signal)) onAbort()
  const timer = spec.timeoutMs === undefined ? undefined : setTimeout(() => { interrupt('timeout') }, spec.timeoutMs)
  const runTurn = async (): Promise<SubagentResult> => {
    const inputId = randomUUID()
    const admitted = await session.prompt(prompt, { inputId })
    if (admitted.kind === 'rejected') {
      return {
        output: collectOutput(),
        stopReason: 'error',
        diagnostic: stageFailure('turn', admitted.code).message,
      }
    }
    const outcome = await awaitTurnEnd(session, admitted.seq, inputId)
    return completedTurn(outcome, collectOutput())
  }
  const result = settleRunResult({
    attempt: async () => {
      if (phase !== 'running') return stopped.promise
      try {
        return await Promise.race([
          runTurn(),
          stopped.promise,
        ])
      } catch (error: unknown) {
        throw stageFailure('turn', 'unknown', { cause: error })
      }
    },
    collectOutput,
    collectDiagnostic: () => stageFailure('turn', 'unknown').message,
    cancelled: () => phase === 'cancelled',
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  }).finally(() => {
    clearTimeout(timer)
    unsubscribe()
    if (phase === 'running') phase = 'settled'
  })
  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel: onAbort,
    teardown: async () => {
      await dispose()
      await result
    },
  })
}

/**
 * Open one OAR session and return a one-shot DSH run. OAR cannot interrupt session
 * startup; cancellation during that await disposes the returned session before rejection.
 * @param request - text task, resolved child directory, parent, and cancellation signal.
 * @param spec - selected runtime, native settings, deadline, and safe diagnostic observer.
 * @returns the run after native session creation; post-publication failures settle through result.
 */
export async function startOarRun(
  request: ResolvedSubagentStartRequest,
  spec: OarRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (isAborted(request.signal)) throw cancellationFailure()
  const cwd = assertUsableCwd('subagent-oar', 'child cwd', request.cwd)

  let installation: InstallationSnapshot | undefined
  try {
    installation = await spec.runtime.installation?.({ env: oarEnvironment(spec.env) })
  } catch (error: unknown) {
    const failure = stageFailure('installation', 'unknown', { cause: error })
    reportFailure(spec, failure)
    throw failure
  }
  if (isAborted(request.signal)) throw cancellationFailure()
  if (installation === undefined || installation.kind === 'unsupported') {
    throw stageFailure('installation', 'unsupported')
  }
  if (installation.kind === 'not_found') {
    throw stageFailure('installation', 'not-found')
  }

  let session: Session
  try {
    session = await spec.runtime.session(installation, {
      cwd,
      ...spec.model === undefined ? {} : { model: spec.model },
      ...spec.effort === undefined ? {} : { effort: spec.effort },
      env: oarEnvironment(spec.env),
      launchArgs: spec.launchArgs,
    })
  } catch (error: unknown) {
    if (isAborted(request.signal)) throw cancellationFailure()
    const failure = stageFailure('startup', 'unknown', { cause: error })
    reportFailure(spec, failure)
    throw failure
  }
  if (isAborted(request.signal)) {
    await disposeSession(session, spec)
    throw cancellationFailure()
  }

  let run: SubagentRun
  try {
    run = publishRun(session, prompt, request, spec)
  } catch (error: unknown) {
    const failure = stageFailure('startup', 'unknown', { cause: error })
    reportFailure(spec, failure)
    await disposeSession(session, spec)
    throw failure
  }
  if (isAborted(request.signal)) {
    await run.dispose()
    throw cancellationFailure()
  }
  return run
}
