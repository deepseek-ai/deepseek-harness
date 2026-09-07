/**
 * Fresh-process ACP subagent client. Drives one child session and owns cancellation and
 * quiescent disposal.
 *
 * @module @deepseek-ai/dsh-subagent-acp/run
 */

import { randomUUID } from 'node:crypto'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ContentBlock as AcpContentBlock,
  type StopReason,
  type ToolKind,
} from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantOutputFold, settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Fixed response to child permission requests: reject by default, or select the first allow option. */
export type PermissionPolicy = 'allow' | 'reject'

/** Resolved spawn spec for an ACP child process (no defaults — see Config). */
export interface AcpRunSpec {
  /** The executable to spawn (the child ACP agent). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /**
   * Absolute working directory for the child process AND its ACP session
   * `cwd`. The provider resolves it before this spec exists: config override,
   * else the delegating parent session's workspace.
   */
  cwd: string
  /** How to auto-answer the child's permission prompts. */
  permission: PermissionPolicy
  /**
   * Extra environment variables to ADD for the child (e.g. the child harness's
   * `DEEPSEEK_API_KEY`). Merged on top of the subprocess seam's scrubbed
   * parent env. A value here is forwarded even if its name matches the
   * credential-scrub pattern (an explicit opt-in for the child's own creds).
   * Explicit `DSH_*` entries are deployment-owned facts for the child harness
   * (e.g. `DSH_PERMISSION_MODE`); they simply merge after the scrub that
   * dropped their stale ambient namesakes.
   */
  env: Record<string, string>
  /**
   * Grace period (ms) for the child's EOF-driven quiesce in
   * {@link SubagentRun.dispose} — the window to flush persistence and tear down
   * its OWN nested subprocesses before the parent escalates to a signal. The
   * plugin fills this from its `disposeEofGraceMs` config.
   */
  disposeEofGraceMs: number
  /**
   * Process-observation and termination-escalation grace (ms). Failure
   * classification waits at most this long for structured exit facts; POSIX
   * dispose also waits this long after `SIGTERM` before `SIGKILL`, while
   * Windows force-terminates directly. The plugin fills it from
   * `disposeGraceMs`.
   */
  disposeGraceMs: number
  /**
   * Spawn function from the subprocess seam (`ctx.subprocess.spawn`), so the
   * child rides the shared scrub, managed-range teardown, and service-owned
   * lifetime instead of a package-local child_process path.
   */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /**
   * Host sink for startup, published-run, or teardown failures. Model-visible
   * text uses fixed safe facts, while this callback retains the original Error
   * when one exists. A throw from the sink itself is contained.
   */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/** EOF grace for child flush and nested-process teardown; wider than the signal grace below. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/** Default POSIX grace between SIGTERM and SIGKILL on dispose (the `disposeGraceMs` config). */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

type AcpFailureStage = 'initialize' | 'new-session' | 'prompt' | 'process' | 'teardown'

type AcpFailureCategory =
  | 'protocol'
  | 'configuration'
  | 'transport'
  | 'process-start'
  | 'process-exit'
  | 'remote-limit'
  | 'unknown'

interface AcpFailureFacts {
  readonly stage: AcpFailureStage
  readonly category: AcpFailureCategory
  readonly stopReason?: StopReason | 'unknown'
  readonly outcome?: SubprocessOutcome | undefined
}

interface AcpPermissionDecision {
  readonly policy: PermissionPolicy
  readonly request: ToolKind | 'unknown'
  readonly decision: 'allowed' | 'denied'
}

const ACP_TOOL_KINDS: ReadonlySet<string> = new Set([
  'read', 'edit', 'delete', 'move', 'search',
  'execute', 'think', 'fetch', 'switch_mode', 'other',
])

/** Fixed safe failure text derived only from provider-owned structured facts. */
function failureDiagnostic(facts: AcpFailureFacts): string {
  const fields = [
    'provider: ACP',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.stopReason !== undefined) fields.push(`stop reason: ${facts.stopReason}`)
  if (facts.outcome?.exitCode !== null && facts.outcome?.exitCode !== undefined) {
    fields.push(`exit code: ${facts.outcome.exitCode}`)
  }
  /* v8 ignore next -- Windows does not report POSIX child signals in SubprocessOutcome. */
  if (facts.outcome?.signal !== null && facts.outcome?.signal !== undefined) {
    fields.push(`signal: ${facts.outcome.signal}`)
  }
  return `Subagent failure (${fields.join('; ')})`
}

/** Fixed permission fact; ACP tool titles and option text never enter it. */
function permissionDiagnostic(permission: AcpPermissionDecision): string {
  return `ACP unattended decision (policy: ${permission.policy}; request: ${permission.request}; decision: ${permission.decision})`
}

/** Put the operation failure first, followed by the latest permission decision. */
function diagnosticText(facts: AcpFailureFacts, permission?: AcpPermissionDecision): string {
  const failure = failureDiagnostic(facts)
  return permission === undefined ? failure : `${failure}\n${permissionDiagnostic(permission)}`
}

class AcpRunFailure extends Error {
  constructor(facts: AcpFailureFacts, cause: unknown) {
    super(
      `subagent-acp: ${failureDiagnostic(facts)}`,
      { cause },
    )
    this.name = 'AcpRunFailure'
  }
}

/**
 * Hide a pre-spawn workspace/configuration failure behind fixed safe facts.
 * @param cause - original Host failure retained on the Error cause chain.
 * @returns an Error whose message contains only the fixed ACP failure line.
 */
export function acpConfigurationFailure(cause: unknown): Error {
  return new AcpRunFailure({ stage: 'initialize', category: 'configuration' }, cause)
}

/** Keep only the closed ACP tool-kind vocabulary; future values use a fixed fallback. */
function permissionRequestKind(kind: ToolKind | null | undefined): ToolKind | 'unknown' {
  const candidate = kind ?? 'unknown'
  return ACP_TOOL_KINDS.has(candidate)
    ? candidate
    : 'unknown'
}

/** Bounded managed-range exit wait: observes the handle's range until it is empty or `ms` elapses. */
async function rangeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cooperative teardown ladder for an out-of-process agent, over the seam's
 * public verbs; resolves only at whole-range quiescence: stdin EOF (the child's
 * window to flush persistence and reap its own descendants), then the
 * terminate() escalation (SIGTERM → spec grace → SIGKILL) and its
 * whole-range exit proof.
 * @param child - the spawned ACP child's handle.
 * @param eofGraceMs - tier-1 window after stdin EOF.
 */
export async function disposeAcpChild(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  const failures: Error[] = []
  child.stdin?.end()
  let exited = false
  try {
    exited = await rangeExitsWithin(child, eofGraceMs)
  } catch (error: unknown) {
    failures.push(toError(error))
  }
  if (exited) return
  // terminate() owns the bounded SIGTERM→SIGKILL timer. Its unbounded wait is
  // the process owner's exit proof, not a second derived grace that can overflow.
  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    failures.push(toError(error))
  }
  if (failures.length === 1) throw failures[0] as Error
  if (failures.length > 1) throw new AggregateError(failures, 'ACP subprocess teardown failed')
}

/**
 * Map an ACP {@link StopReason} to a harness {@link SubagentStopReason}.
 * @param reason - the terminal reason from the child's `session/prompt` response.
 * @returns the harness equivalent; `max_turn_requests` and any unknown future
 * variant map to `error`, so an unclean stop is never reported as `completed`.
 */
export function acpStopReason(reason: StopReason): SubagentStopReason {
  switch (reason) {
    case 'end_turn':
      return 'completed'
    case 'max_tokens':
      return 'max-tokens'
    case 'refusal':
      return 'refusal'
    case 'cancelled':
      return 'aborted'
    // `max_turn_requests` (the child hit its turn-request budget) has no direct
    // harness equivalent and means the task did NOT finish cleanly — surface it
    // as a generic failure so the consumer maps it to an isError result rather
    // than reporting a partial answer as success.
    case 'max_turn_requests':
      return 'error'
    // ACP StopReason is a closed wire union, but a future SDK could add a
    // variant; treat an unknown terminal reason as a failure (never silently
    // 'completed').
    default:
      return 'error'
  }
}

/**
 * Collect the text of an ACP content block (non-text blocks contribute nothing).
 * @param content - the content block off a streamed `agent_message_chunk`.
 * @returns the block's text, or `''` for a non-text block.
 */
export function acpContentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/**
 * Translate the harness prompt blocks into ACP prompt blocks (text only).
 * @param prompt - the harness prompt; non-text blocks are dropped.
 * @returns the ACP text blocks, in order.
 */
export function toAcpPrompt(prompt: ContentBlock[]): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  for (const block of prompt) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
  }
  return blocks
}

/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function toError(value: unknown): Error {
  // The catch only sees rejections from the ACP SDK RPCs and the spawn `error`
  // event, which are always `Error`s; the `String(value)` arm is a defensive
  // fallback for a non-Error throw that the typed APIs cannot produce.
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

/** Report an original Host failure without letting the observation sink replace it. */
function reportFailure(spec: AcpRunSpec, error: unknown): void {
  try {
    spec.onError?.(toError(error), 'error')
  } catch {
    // Host diagnostic logging cannot replace the child failure.
  }
}

/** Classify an unpublished failure from the active protocol operation and observed process facts. */
function startupFailure(
  error: unknown,
  stage: Extract<AcpFailureStage, 'initialize' | 'new-session'>,
  outcome: SubprocessOutcome | undefined,
): AcpRunFailure {
  return new AcpRunFailure(
    /* v8 ignore next -- Windows anonymous pipes cannot expose a live-child protocol close during startup. */
    outcome === undefined
      ? { stage, category: 'transport' }
      : { stage, category: 'process-exit', outcome },
    error,
  )
}

/** Map one remote terminal reason to the optional safe failure line it needs. */
function terminalFailure(
  reason: StopReason,
  permission: AcpPermissionDecision | undefined,
): string | undefined {
  switch (reason) {
    case 'end_turn':
      return undefined
    case 'max_turn_requests':
      return diagnosticText({
        stage: 'prompt',
        category: 'remote-limit',
        stopReason: 'max_turn_requests',
      }, permission)
    case 'max_tokens':
    case 'refusal':
    case 'cancelled':
      return permission === undefined
        ? undefined
        : permissionDiagnostic(permission)
    default:
      return diagnosticText({ stage: 'prompt', category: 'unknown', stopReason: 'unknown' }, permission)
  }
}

/**
 * Start and publish one ACP child after initialization and session creation.
 * Child failures resolve through the run result. Startup rejects with fixed
 * safe facts after provider-owned cleanup; successful cleanup proves managed
 * range quiescence. Cleanup failure preserves startup plus teardown facts for an ordinary
 * failure, or teardown alone after cancellation, without claiming quiescence.
 * Disposal cancels, terminates, and settles the child's managed range.
 * @param request - the start request; its signal is the cancellation channel.
 * @param spec - the resolved spawn spec: command/args/cwd, env, permission
 * policy, dispose graces, and the optional error sink.
 * @returns the ready run handle for the child subprocess.
 */
export async function startAcpRun(request: SubagentStartRequest, spec: AcpRunSpec): Promise<SubagentRun> {
  if (request.signal.aborted) throw new Error('subagent request was aborted before the ACP child started')
  // ACP session ids are unique only within the child server. The lifecycle id
  // is minted in the parent namespace so fresh processes cannot collide with
  // each other or with a local agent that happens to use the same session id.
  const id = brandString<SessionId>(randomUUID())

  // Keep diagnostics on parent stderr ('inherit'); only ACP output contributes
  // to the result. The seam's scrub drops ambient credentials and DSH_* names
  // while spec.env (the child's own key, its deployment facts) merges after it.
  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    reportFailure(spec, error)
    throw new AcpRunFailure({ stage: 'process', category: 'process-start' }, error)
  }
  /* v8 ignore start -- 'pipe' dispositions expose both streams by the seam contract; defensive. */
  if (child.stdin === undefined || child.stdout === undefined) {
    throw new Error('subagent-acp: subprocess implementation dropped a piped protocol stream')
  }
  /* v8 ignore stop */
  let processOutcome: SubprocessOutcome | undefined
  let processFailure: Error | undefined
  const processDone = child.done.then(
    (outcome) => {
      processOutcome = outcome
      return outcome
    },
    (error: unknown) => {
      processFailure = toError(error)
      throw processFailure
    },
  )

  // A rejected direct result surfaces into the startup race; a clean exit must
  // never win it, so the success arm parks forever. (The ACP connection
  // observing its streams closing bounds a child that exits without speaking
  // the protocol.)
  const processRejected: Promise<never> = processDone.then(
    /* v8 ignore next -- the success arm's never-settling executor is intentionally empty. */
    () => new Promise<never>(() => {}),
    (err: unknown) => Promise.reject(toError(err)),
  )
  processRejected.catch(() => { /* observed by the startup race; never unhandled */ })

  const observeProcessOutcome = async (signal?: AbortSignal): Promise<SubprocessOutcome | undefined> => {
    if (processOutcome !== undefined) return processOutcome
    const timeout = AbortSignal.timeout(Math.ceil(spec.disposeGraceMs))
    const bound = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const aborted = Promise.withResolvers<undefined>()
    /* v8 ignore next -- Windows cannot expose the live-child protocol close needed to await this abort. */
    const onObservationAbort = (): void => { aborted.resolve(undefined) }
    bound.addEventListener('abort', onObservationAbort, { once: true })
    /* v8 ignore next -- closes the event-loop race between listener registration and the preceding derived-signal check. */
    if (bound.aborted) onObservationAbort()
    try {
      return await Promise.race([processDone, aborted.promise])
    } catch {
      // A provider rejection after handle publication leaves no direct outcome;
      // the active protocol failure remains authoritative.
      return processOutcome
    } finally {
      bound.removeEventListener('abort', onObservationAbort)
    }
  }

  // Startup rollback and the published handle share one process teardown.
  let processDisposal: Promise<void> | undefined
  const disposeProcess = (): Promise<void> => (processDisposal ??= disposeAcpChild(child, spec.disposeEofGraceMs))

  // ACP exposes no complete assistant messages, so the shared fold selects its
  // accumulated assistant text.
  const fold = new AssistantOutputFold()
  // Shared mutable state keeps cancellation visible across async closures.
  const flags = { cancelled: false }
  let latestPermission: AcpPermissionDecision | undefined

  const clientApp = createAcpClientApp({ name: 'deepseek-harness-subagent-acp' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk') {
        fold.pushText(acpContentText(update.content))
      }
      // Other updates (thoughts, tool calls, plans) are consumed but not
      // surfaced — the subagent returns only its final answer.
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      // Auto-answer by the configured policy. `allow` selects the first option
      // whose kind is `allow_once` or `allow_always`; if the child offered none (or we
      // reject), answer `cancelled` so the child does not proceed.
      if (spec.permission === 'allow') {
        const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
        if (allow !== undefined) {
          latestPermission = {
            policy: 'allow',
            request: permissionRequestKind(params.toolCall.kind),
            decision: 'allowed',
          }
          return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
        }
      }
      latestPermission = {
        policy: spec.permission,
        request: permissionRequestKind(params.toolCall.kind),
        decision: 'denied',
      }
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    })

  const connection = clientApp.connect(ndJsonStream(
    NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  const agent = connection.agent

  let sessionId: string | undefined
  let startupStage: Extract<AcpFailureStage, 'initialize' | 'new-session'> = 'initialize'
  // Cancellation settles the result without waiting for a cooperative child.
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
    // Best-effort ACP cancel; process teardown remains authoritative.
    /* v8 ignore next */
    if (sessionId !== undefined) {
      void agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => { /* child gone / no session */ })
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  // Read at every return so a partial answer survives a later cancel/error.
  const collectOutput = (): ContentBlock[] => fold.collect() ?? []

  // Establish the remote session before publishing a handle. Any failure owns
  // the still-private process and therefore reaps it before rejecting.
  try {
    await Promise.race([
      (async (): Promise<void> => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          // Advertise NO optional client capabilities (no fs, no terminal): the
          // child self-serves in its own process.
          clientCapabilities: {},
        })
        startupStage = 'new-session'
        const session = await agent.request(methods.agent.session.new, { cwd: spec.cwd, mcpServers: [] })
        const returnedSessionId: unknown = Reflect.get(session, 'sessionId')
        if (typeof returnedSessionId !== 'string') {
          throw new AcpRunFailure(
            { stage: 'new-session', category: 'protocol' },
            new Error('ACP child published without a session id'),
          )
        }
        sessionId = returnedSessionId
        /* v8 ignore next -- cancelSettled wins the startup race before this post-response guard can settle it. */
        if (flags.cancelled) throw new Error('subagent cancelled before the ACP session started')
      })(),
      processRejected,
      cancelSettled.then((): never => { throw new Error('subagent cancelled before the ACP session started') }),
    ])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = flags.cancelled
    // A child closing its protocol stream can precede whole-range exit
    // observation. Local cancellation does not need the discarded startup
    // classification; other failures use the configured process grace.
    const observedOutcome = !cancelledBeforeCleanup && !(error instanceof AcpRunFailure)
      ? await observeProcessOutcome()
      : undefined
    const startup = cancelledBeforeCleanup
      ? { kind: 'cancelled' } as const
      : {
        kind: 'failed',
        failure: error instanceof AcpRunFailure
          ? error
          : startupFailure(error, startupStage, observedOutcome),
      } as const
    if (startup.kind === 'cancelled') {
      // Local cancellation owns the startup outcome; only cleanup failure is
      // reported below when teardown itself rejects.
    } else {
      reportFailure(spec, error instanceof AcpRunFailure
        ? error.cause
        : processFailure ?? error)
    }
    try {
      await disposeProcess()
    } catch (cleanupError: unknown) {
      reportFailure(spec, cleanupError)
      const cleanupFailure = new AcpRunFailure({
        stage: 'teardown',
        category: processOutcome === undefined ? 'unknown' : 'process-exit',
        ...(processOutcome === undefined ? {} : { outcome: processOutcome }),
      }, cleanupError)
      if (startup.kind === 'cancelled') {
        throw new AggregateError([cleanupFailure], cleanupFailure.message)
      }
      throw new AggregateError(
        [startup.failure, cleanupFailure],
        `${startup.failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (startup.kind === 'cancelled') {
      throw new Error('subagent request was aborted before the ACP child started')
    }
    throw startup.failure
  }
  // The startup transaction validates the returned id before it can fulfill.
  // This assertion carries that cross-closure invariant into TypeScript.
  /* v8 ignore next */
  if (sessionId === undefined) throw new Error('unreachable: ACP startup fulfilled without a session id')
  const remoteSessionId = sessionId

  let diagnostic: string | undefined
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async (): Promise<SubagentResult> => {
      try {
        const promptResult = await Promise.race([
          agent.request(methods.agent.session.prompt, {
            sessionId: remoteSessionId,
            prompt: toAcpPrompt(request.prompt),
          }),
          cancelSettled.then((): never => { throw new Error('subagent cancelled while the ACP prompt was running') }),
        ])
        const stopReason = acpStopReason(promptResult.stopReason)
        diagnostic = terminalFailure(promptResult.stopReason, latestPermission)
        return {
          output: collectOutput(),
          ...(diagnostic === undefined ? {} : { diagnostic }),
          stopReason,
        }
      } catch (error: unknown) {
        if (!flags.cancelled) {
          const outcome = await observeProcessOutcome(request.signal)
          const facts = outcome === undefined
            ? { stage: 'prompt', category: 'transport' } as const
            : { stage: 'process', category: 'process-exit', outcome } as const
          diagnostic = diagnosticText(facts, latestPermission)
        }
        throw processFailure ?? error
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => flags.cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      try {
        // ACP normally quiesces from stdin EOF, including the final flush, so
        // this backend uses a wider EOF grace before process termination.
        await disposeProcess()
      } catch (error: unknown) {
        reportFailure(spec, error)
        throw new AcpRunFailure({
          stage: 'teardown',
          category: processOutcome === undefined ? 'unknown' : 'process-exit',
          ...(processOutcome === undefined ? {} : { outcome: processOutcome }),
        }, error)
      }
    },
  })
}
