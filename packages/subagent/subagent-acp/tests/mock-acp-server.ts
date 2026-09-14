/**
 * A minimal mock ACP AGENT, run as a subprocess, for the keyless
 * `dsh-subagent-acp` tests. It speaks the agent side of ACP over stdio and is
 * fully scripted by environment variables — no model, no network:
 *
 * - `MOCK_TEXT`        — the assistant text it streams as one `agent_message_chunk`.
 * - `MOCK_ECHO_ENV`    — if set to a variable NAME, stream that variable's value
 *                        (or `<NAME unset>`) instead of MOCK_TEXT — asserts what
 *                        environment actually reached the child process.
 * - `MOCK_STOP`        — the ACP `StopReason` it returns from `prompt`
 *                        (`end_turn` default, or `max_tokens`/`refusal`/…).
 * - `MOCK_HANG`        — if `1`, `prompt` never resolves on its own (it waits for
 *                        a `session/cancel`), to exercise the client's cancel path.
 * - `MOCK_IGNORE_CANCEL` — if `1` (with MOCK_HANG), the agent receives
 *                        `session/cancel` but NEVER resolves the pending prompt
 *                        and never exits — a non-cooperative child. The backend's
 *                        `result` must still settle `aborted` on its own and
 *                        `dispose()` must still kill the process.
 * - `MOCK_PERMISSION`  — if `1`, the agent calls `session/request_permission`
 *                        before answering, to exercise the client's auto-answer.
 * - `MOCK_PERMISSION_IGNORE_DECISION` — if `1`, continue after a denied
 *                        permission so the terminal failure can carry the
 *                        provider's fixed permission fact.
 * - `MOCK_CRASH_ON_INITIALIZE` — exit while the unpublished initialize
 *                        operation is active.
 * - `MOCK_CRASH_AFTER_CHUNK` — exit after streaming the assistant chunk, so
 *                        the parent preserves partial output with process facts.
 * - `MOCK_ECHO_CWD`    — if `1`, ignore MOCK_TEXT and stream two lines instead:
 *                        the agent PROCESS's `process.cwd()` and the `cwd` the
 *                        client announced in `session/new` — so a test can assert
 *                        where the child actually ran and what workspace it was
 *                        told it has.
 * - `MOCK_READY_FILE`  — if set, the path the agent touches once its `prompt`
 *                        handler is in flight (it has streamed its chunk). A test
 *                        polls for this file to cancel on a CONDITION rather than
 *                        an arbitrary timeout (subprocess cold-start is variable).
 * - `MOCK_PROMPT_HOLD` — if set, prompt waits while this file exists; removing
 *                        it releases the response without a timing assumption.
 * - `MOCK_MISSING_SESSION_ID` — if `1`, return a malformed empty `session/new`
 *                        response to exercise startup rollback.
 * - `MOCK_FLUSH_ON_EOF` — if set, on stdin EOF the agent takes an async beat
 *                         (MOCK_FLUSH_DELAY_MS, default 150) simulating the real
 *                         acp-agent's EOF-driven quiesce+flush, then touches this
 *                         path and exits ON ITS OWN — no signal. Stands in for a
 *                         child whose durable flush completes only if dispose
 *                         gives EOF a real window before escalating to SIGTERM.
 * - `MOCK_IGNORE_EOF`   — if `1`, keep the event loop alive past stdin EOF (a bare
 *                         timer) but install a SIGTERM handler that exits (and, if
 *                         MOCK_SIGTERM_FILE is set, touches it as an observable
 *                         proof the SIGTERM rung fired). The child ignores the
 *                         graceful EOF window yet dies cooperatively on SIGTERM —
 *                         exercising dispose's middle tier (exit during the SIGTERM
 *                         grace, before the SIGKILL escalation). Touches
 *                         MOCK_READY_FILE once armed.
 *
 * It is not a test spec: the specs launch this protocol-only fixture through
 * the mode-aware example resolver (tsx in source mode, Node type stripping in
 * built mode). It imports no harness code or workspace paths.
 *
 * @module @deepseek-ai/dsh-subagent-acp/tests/mock-acp-server
 */

import { randomUUID } from 'node:crypto'
import { existsSync, watch, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  agent as createAcpAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentContext,
  type CancelNotification,
  type AuthenticateRequest,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type StopReason,
  type ToolKind,
} from '@agentclientprotocol/sdk'

// When MOCK_ECHO_ENV names a variable, stream that variable's value in place
// of MOCK_TEXT — lets a test assert exactly what env reached this process.
const echoEnvName = process.env.MOCK_ECHO_ENV
const TEXT = echoEnvName !== undefined
  ? process.env[echoEnvName] ?? `<${echoEnvName} unset>`
  : process.env.MOCK_TEXT ?? 'mock child answer'
const ECHO_CWD = process.env.MOCK_ECHO_CWD === '1'
const STOP = (process.env.MOCK_STOP ?? 'end_turn') as StopReason
const HANG = process.env.MOCK_HANG === '1'
const WANT_PERMISSION = process.env.MOCK_PERMISSION === '1'
const IGNORE_PERMISSION_DECISION = process.env.MOCK_PERMISSION_IGNORE_DECISION === '1'
const NO_ALLOW = process.env.MOCK_NO_ALLOW === '1'
const THOUGHT = process.env.MOCK_THOUGHT === '1'
const CRASH_ON_INITIALIZE = process.env.MOCK_CRASH_ON_INITIALIZE === '1'
const CRASH_ON_CANCEL = process.env.MOCK_CRASH_ON_CANCEL === '1'
const CRASH_ON_PROMPT = process.env.MOCK_CRASH_ON_PROMPT === '1'
const CRASH_AFTER_CHUNK = process.env.MOCK_CRASH_AFTER_CHUNK === '1'
const IGNORE_CANCEL = process.env.MOCK_IGNORE_CANCEL === '1'
const TOOL_KIND = process.env.MOCK_TOOL_KIND as ToolKind | undefined
const READY_FILE = process.env.MOCK_READY_FILE
const FLUSH_ON_EOF = process.env.MOCK_FLUSH_ON_EOF
// When MOCK_NEWSESSION_READY/GO are set, newSession touches READY then blocks
// until GO appears — letting a test cancel mid-newSession deterministically.
const NEWSESSION_GATE = process.env.MOCK_NEWSESSION_READY !== undefined && process.env.MOCK_NEWSESSION_GO !== undefined
  ? { ready: process.env.MOCK_NEWSESSION_READY, go: process.env.MOCK_NEWSESSION_GO }
  : undefined

function makeAgent() {
  // Pending cancel resolver for the HANG path: a `session/cancel` resolves the
  // prompt with `cancelled`.
  let resolveCancel: ((reason: StopReason) => void) | undefined
  // The cwd the client announced in `session/new`, echoed under MOCK_ECHO_CWD.
  let sessionCwd: string | undefined

  return {
    initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      if (CRASH_ON_INITIALIZE) process.exit(11)
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
      })
    },
    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      sessionCwd = params.cwd
      // Optionally signal "newSession reached" and block until released, so a
      // test can cancel DURING newSession (the early-cancel race window) on a
      // condition rather than a timeout.
      if (NEWSESSION_GATE !== undefined) {
        writeFileSync(NEWSESSION_GATE.ready, 'at-newSession')
        while (!existsSync(NEWSESSION_GATE.go)) await new Promise(r => setTimeout(r, 10))
      }
      if (process.env.MOCK_MISSING_SESSION_ID === '1') return {} as NewSessionResponse
      return { sessionId: process.env.MOCK_SESSION_ID ?? randomUUID() }
    },
    authenticate(_params: AuthenticateRequest): Promise<void> {
      // No auth methods advertised; nothing to do.
      return Promise.resolve()
    },
    async prompt(params: PromptRequest, conn: AgentContext): Promise<PromptResponse> {
      if (CRASH_ON_PROMPT) process.exit(1)
      const hold = process.env.MOCK_PROMPT_HOLD
      if (hold !== undefined) {
        const released = Promise.withResolvers<undefined>()
        const check = (): void => { if (!existsSync(hold)) released.resolve(undefined) }
        const watcher = watch(dirname(hold), check)
        watcher.on('error', released.reject)
        try {
          check()
          await released.promise
        } finally {
          watcher.close()
        }
      }
      if (WANT_PERMISSION) {
        // Ask the client to approve before answering; honor its decision. Under
        // MOCK_NO_ALLOW the only options are reject-shaped, so an `allow`-policy
        // client finds no allow option and must fall back to cancelled.
        const options = NO_ALLOW
          ? [{ optionId: 'no', name: 'Reject', kind: 'reject_once' as const }]
          : [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
          ]
        const decision = await conn.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'mock-call',
            title: 'mock side effect',
            ...(TOOL_KIND === undefined ? {} : { kind: TOOL_KIND }),
          },
          options,
        }) as RequestPermissionResponse
        if (decision.outcome.outcome === 'cancelled' && !IGNORE_PERMISSION_DECISION) {
          return { stopReason: 'cancelled' }
        }
      }
      // Optionally emit a NON-message update first (a thought), so the client's
      // sessionUpdate sees an update it must consume-but-not-accumulate.
      if (THOUGHT) {
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } },
        })
      }
      // Stream the canned assistant text as one chunk (or, under MOCK_ECHO_CWD,
      // the observable process cwd + announced session cwd).
      await conn.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ECHO_CWD ? `${process.cwd()}\n${sessionCwd ?? ''}` : TEXT },
        },
      })
      if (CRASH_AFTER_CHUNK) {
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        process.exit(17)
      }
      // Signal "prompt is in flight" by touching the readiness file, so a test
      // can wait on a CONDITION (file exists) rather than an arbitrary timeout
      // before cancelling — deterministic regardless of subprocess cold-start.
      if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'ready')
      if (HANG) {
        // Never resolve on our own: wait for session/cancel to settle us.
        return new Promise<PromptResponse>((resolve) => {
          resolveCancel = (reason) => { resolve({ stopReason: reason }) }
        })
      }
      return { stopReason: STOP }
    },
    cancel(_params: CancelNotification): Promise<void> {
      if (CRASH_ON_CANCEL) {
        // Exit hard instead of answering — tears the ACP pipe, so the client's
        // pending prompt REJECTS (exercises the backend's catch-while-cancelled
        // path: a transport failure after a cancel settles `aborted`).
        process.exit(1)
      }
      if (IGNORE_CANCEL) {
        // A NON-COOPERATIVE child: receive session/cancel but never resolve the
        // pending prompt and never exit. The backend's `result` must still settle
        // `aborted` on its own (the cancel-settle race), and `dispose()` must
        // still kill the process — proving cancellation does not depend on the
        // child cooperating.
        return Promise.resolve()
      }
      resolveCancel?.('cancelled')
      return Promise.resolve()
    },
  }
}

const implementation = makeAgent()
createAcpAgentApp({ name: 'dsh-subagent-acp-test-agent' })
  .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
  .onRequest(methods.agent.authenticate, async ({ params }) => {
    await implementation.authenticate(params)
    return {}
  })
  .onRequest(methods.agent.session.new, ({ params }) => implementation.newSession(params))
  .onRequest(methods.agent.session.prompt, ({ params, client }) => implementation.prompt(params, client))
  .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))

// Under MOCK_TRAP_SIGTERM, ignore SIGTERM and keep stdin open so the process
// neither quiesces on EOF nor dies on the graceful signal — exercising the
// backend dispose path's SIGKILL escalation. Without this the process exits
// normally on SIGTERM / stdin end. Touch READY_FILE once the trap is armed, so
// a test waits for that CONDITION before disposing (the trap must be in place,
// not merely the process spawned — otherwise SIGTERM hits the default handler).
if (process.env.MOCK_TRAP_SIGTERM === '1') {
  process.on('SIGTERM', () => { /* trapped: refuse to exit on the graceful signal */ })
  // Keep the event loop alive (a bare timer) so nothing else lets it exit.
  setInterval(() => { /* stay alive until SIGKILL */ }, 1000)
  if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'trap-armed')
}

// Under MOCK_FLUSH_ON_EOF, model the real acp-agent's EOF-driven quiesce: on
// stdin 'end' (the dispose path's `child.stdin.end()`), take an ASYNC beat to
// "flush", then touch the marker and exit ON OUR OWN — no signal involved. The
// beat is MOCK_FLUSH_DELAY_MS (default 150). A dispose that sends SIGTERM before
// the beat completes (no graceful window, or an EOF grace shorter than the
// flush) default-terminates this process and the marker is missing; a dispose
// that gives the EOF quiesce enough window first lets the flush land.
if (FLUSH_ON_EOF !== undefined) {
  const flushDelayMs = Number(process.env.MOCK_FLUSH_DELAY_MS ?? '150')
  process.stdin.on('end', () => {
    setTimeout(() => {
      writeFileSync(FLUSH_ON_EOF, 'flushed')
      process.exit(0)
    }, flushDelayMs)
  })
}

// Under MOCK_IGNORE_EOF, keep the loop alive past stdin EOF (so the graceful EOF
// window times out) but INSTALL A SIGTERM HANDLER that records it and exits — the
// child ignores the graceful EOF window yet dies cooperatively on SIGTERM,
// exercising dispose's MIDDLE tier (exit during the SIGTERM grace, before the
// SIGKILL escalation). When MOCK_SIGTERM_FILE is set the handler touches it, an
// OBSERVABLE proof that the SIGTERM rung fired: if dispose skipped the middle
// rung and jumped EOF→SIGKILL, SIGKILL is uncatchable so the handler never runs
// and the marker is missing. Touch READY_FILE once armed (a test waits on it).
if (process.env.MOCK_IGNORE_EOF === '1') {
  const sigtermFile = process.env.MOCK_SIGTERM_FILE
  process.on('SIGTERM', () => {
    if (sigtermFile !== undefined) writeFileSync(sigtermFile, 'sigterm')
    process.exit(0)
  })
  setInterval(() => { /* stay alive past EOF until SIGTERM */ }, 1000)
  if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'ignore-eof-armed')
}
