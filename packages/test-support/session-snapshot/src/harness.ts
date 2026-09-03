/**
 * Shared subprocess harness for ACP snapshot suites. A library module driven by
 * the suite factory in ./suite.ts (and directly by harness-level specs); each
 * profile adapter names its own agent-under-test paths.
 *
 * It boots the REAL agent bin subprocess via the cordis Loader (so the
 * export-shape bug class stays guarded — see docs/postmortem/0001), drives it
 * over real ACP JSON-RPC stdio with a deterministic input script, tees raw
 * stdout (for the expected-output and purity checks) into an SDK client app,
 * and — in record mode — harvests the persisted session JSONL after a graceful
 * shutdown flush. The pure normalizers in ./normalize.ts turn the captured
 * stdout frames and the session-log events into stable, snapshot-able text.
 *
 * See .agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md.
 *
 * @module @deepseek-ai/dsh-session-snapshot/harness
 */

import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, delimiter } from 'node:path'
import { vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  type ContentBlock as AcpContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import {
  launchAcpTestAgent,
  type AcpTestClient,
  type AgentUnderTest,
  type LaunchedAcpTestAgent,
} from './launcher.ts'
import { clearedProxyEnv } from '@deepseek-ai/dsh-http-proxy'
import { captureWorkspaceSnapshot, type WorkspaceSnapshotEntry } from './workspace.ts'

export type { AgentUnderTest } from './launcher.ts'

const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const WAIT_POLL_INTERVAL_MS = 10

/**
 * One step of a scenario's deterministic input script (`input.json`). The
 * harness interprets these in order. `newSession` captures the server-issued
 * (random) session id into a `{{sessionId}}` variable that later steps
 * reference, since a committed file cannot know the id in advance.
 *
 * `promptAndCancel` starts a prompt without awaiting completion, waits for a
 * readiness condition, then cancels and awaits completion. Its optional
 * `waitForFile` observes a cwd-relative marker; otherwise it waits for the
 * durable turn start. The standalone `waitForFile` holds the next script step
 * behind the same marker.
 * `promptAndWaitForAgentMessage` arms an exact text-chunk waiter before sending
 * the prompt, then keeps the application live until that later update arrives.
 * `waitForTurnStart` waits for an open durable turn, optionally at or beyond a
 * specified turn number. `waitForTurnEnd` holds the subprocess open until the
 * selected session's latest complete raw-JSONL turn boundary is `turn/end`.
 * `waitForGoalPhase` waits for the latest durable goal snapshot to reach one phase.
 * `waitForInboxMessage` waits for inserted inbox text containing a scenario marker.
 * `waitForSubagentTurnEnd` waits until one background child has persisted a
 * closed model-work turn after its own descriptor; child progress has no ACP
 * update to wait on.
 * `waitForTitleAfterTurnEnd` additionally waits for a later durable title.
 * `waitForEventAfterTurnEnd` waits until a complete record of the given event
 * type follows the latest closed turn — for scenarios whose asserted state
 * (e.g. a goal pause) is appended only after cancellation reaches idle.
 * A standalone `cancel` may also wait for a cwd-relative readiness marker.
 * All wait timeouts default to 10s.
 */
export type InputStep =
  | { op: 'initialize' }
  | { op: 'newSession' }
  | { op: 'newSessionExpectError'; additionalDirectories?: string[] }
  | { op: 'prompt'; text: string }
  | { op: 'promptContent'; content: AcpContentBlock[] }
  | { op: 'promptAndWaitForAgentMessage'; text: string; waitForText: string }
  | { op: 'promptExpectError'; text: string }
  | {
    op: 'promptAndCancel'
    text: string
    waitForFile?: { path: string; timeoutMs?: number }
  }
  | { op: 'waitForFile'; path: string; timeoutMs?: number }
  | { op: 'waitForTurnStart'; minimumTurn?: number; timeoutMs?: number }
  | { op: 'waitForTurnEnd'; timeoutMs?: number }
  | { op: 'waitForSubagentTurnEnd'; child?: number; minimumTurn?: number; timeoutMs?: number }
  | { op: 'waitForGoalPhase'; phase: 'active' | 'paused' | 'blocked' | 'complete'; timeoutMs?: number }
  | { op: 'waitForInboxMessage'; text: string; timeoutMs?: number }
  | { op: 'waitForTitleAfterTurnEnd'; timeoutMs?: number }
  | { op: 'waitForEventAfterTurnEnd'; type: string; timeoutMs?: number }
  | { op: 'cancel'; waitForFile?: { path: string; timeoutMs?: number } }

/** A scenario's `input.json`: an ordered list of input steps. */
export interface InputScript {
  steps: InputStep[]
  /**
   * Ordered answers for the agent's `session/request_permission` round-trips,
   * consumed FIFO — the Nth request gets the Nth answer. Each answer selects
   * by option KIND: option ids are agent-issued randoms a committed script
   * cannot know, while kinds are the ACP-stable vocabulary, so the client maps
   * kind → the offered `optionId` at answer time. A request beyond the queue
   * (or with no queue at all) is answered `cancelled` — the stub behavior a
   * scenario without approvals relies on. A scripted kind the request does
   * not offer REJECTS the run: the scenario scripted an impossible selection,
   * and {@link runScenario} throws once the in-flight step settles (the
   * agent itself just sees `cancelled`, so it cannot absorb the bug).
   */
  permissionAnswers?: PermissionAnswer[]
}

/** One scripted answer to a permission request: which offered option kind to select. */
export interface PermissionAnswer {
  /** The `PermissionOption.kind` to select (`allow_once`, `reject_always`, …). */
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

/** One harvested session log plus the identifying facts off its header line. */
export interface HarvestedLog {
  /** The recorded session id (header `id`). */
  id: string
  /** Session creation time (header `createdAt`) — the child-ordering key. */
  createdAt: number
  /** The parent session id, if this log is a subagent child (header `parentSession`). */
  parentSession?: string
  /** The full `.jsonl` file content. */
  content: string
}

/** The result of running a scenario: raw stdout + the harvested session log(s). */
export interface RunResult {
  /** Raw stdout bytes (decoded utf8), every newline-delimited JSON-RPC frame. */
  rawStdout: string
  /** stderr (for diagnostics on failure). */
  stderr: string
  /** The session id the server issued (undefined if no session was created). */
  sessionId?: string
  /** The generated cwd the session ran in (the bash workspace). */
  cwd: string
  /** Filesystem-resolved spellings of {@link cwd} that child processes may report. */
  cwdAliases: string[]
  /** User-visible workspace state after committed and runtime-only setup. */
  initialWorkspace: WorkspaceSnapshotEntry[]
  /** User-visible workspace state after the controlled interface has settled. */
  finalWorkspace: WorkspaceSnapshotEntry[]
  /**
   * Every persisted session log harvested after the run, ordered primary-first:
   * the top-level (parent) session — the one with no `parentSession` — then each
   * subagent child by ascending `createdAt`. A single-session scenario harvests
   * exactly one; a nested-agent scenario harvests the parent plus one per child.
   */
  sessionLogs: HarvestedLog[]
}

/** How to run one scenario: the agent to boot, the mode, and the fixture wiring. */
export interface RunOptions {
  /** The agent composition to boot. */
  agent: AgentUnderTest
  /** `replay` (default, keyless) or `record` (real API, harvests the log). */
  mode: 'replay' | 'record'
  /** Scenario-specific deployment environment layered into the subprocess. */
  env?: NodeJS.ProcessEnv
  /** The recorded session JSONL fixture path (replay reads it; record writes near it). */
  fixtureFile: string
  /** Optional sidecar override path (replay). */
  overrideFile?: string
  /**
   * Recorded SUBAGENT child-session fixture paths (replay). A nested-agent
   * scenario ships one per child (`session.1.jsonl`, …); the harness forwards
   * them to `dsh-llm-replay` via `$DSH_SNAPSHOT_CHILD_FILES` so each child
   * session replays from its own recorded script. Empty for single-session
   * scenarios. Ignored in record mode (children are harvested, not replayed).
   */
  childFiles?: string[]
  /**
   * Optional `<scenario>/workspace/` directory whose contents are copied into
   * the generated cwd BEFORE the run — the standard way to seed files the agent
   * operates on (a file to read, edit, or grep). Absent for scenarios that
   * start from an empty workspace.
   */
  workspaceDir?: string
  /**
   * Optional final workspace preparation, run after {@link workspaceDir} is
   * copied and before the agent starts. This is for fixtures that cannot be
   * represented portably in Git (for example, a POSIX-only filename that is
   * invalid on Windows); ordinary seeded files belong in `workspaceDir`.
   */
  prepareWorkspace?: (cwd: string) => void | Promise<void>
  /**
   * Parent directory for the generated session cwd. Defaults to
   * `os.tmpdir()`. A scenario that must distinguish its workspace from the
   * sandbox's always-writable temporary roots can place the generated child
   * under `os.homedir()` instead. The harness removes only that generated
   * child, never the supplied parent.
   */
  workspaceParent?: string
  /**
   * Alternate live profile patch (absolute), overriding
   * {@link AgentUnderTest.configPath} for this run. Its basename still ends
   * in `cordis.yml` so the launcher can select the replay sibling.
   */
  configPath?: string
}

/**
 * Derive one stable, fixed-length spill root owned by this scenario.
 * Windows uses a two-character-shorter root because drive resolution adds its drive prefix.
 * @param fixtureFile - The scenario fixture whose parent directory provides the stable identity.
 * @param platform - the host platform, injectable for unit coverage.
 * @returns the root-relative snapshot spill directory.
 */
export function snapshotSpillRoot(
  fixtureFile: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const scenario = basename(dirname(fixtureFile))
  const key = createHash('sha256').update(scenario).digest('hex').slice(0, 9)
  const root = platform === 'win32' ? '/t' : '/tmp'
  return `${root}/dsh-acp-snap-${key}`
}

/**
 * Run a scenario end-to-end against a freshly-spawned subprocess. Owns the
 * child and its generated dirs; always tears them down. Returns the captured stdout
 * and (record mode) the harvested session-log path.
 *
 * @param input The scenario's input script (steps + optional permission answers).
 * @param opts The agent to boot, the mode, and the fixture wiring.
 * @returns The captured stdout/stderr, session id, generated cwd, and harvested logs.
 */
export async function runScenario(input: InputScript, opts: RunOptions): Promise<RunResult> {
  const cwd = await mkdtemp(join(opts.workspaceParent ?? tmpdir(), 'acp-snap-cwd-'))
  const cwdAliases = [...new Set([realpathSync(cwd), realpathSync.native(cwd)])]
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'acp-snap-sessions-'))
  // Fixed path length: spill-policy budgets the preview against the REAL path
  // before stdout normalization, so tmpdir() length differences churn expected outputs.
  // Scenario ownership also matters: replay runs concurrently, and one teardown
  // must never delete another scenario's in-flight full-output recovery file.
  const spillRoot = snapshotSpillRoot(opts.fixtureFile)
  // Everything past the temp-dir creation is followed by failure-safe cleanup,
  // so a failure in workspace seeding, spawn, or any step never leaks resources.
  let launched: LaunchedAcpTestAgent | undefined
  let sessionId: string | undefined
  let sessionLogs: HarvestedLog[] = []
  const outcome = await (async (): Promise<RunResult> => {
    // Seed the workspace if the scenario ships one (a file the agent reads/edits).
    // Copied into the generated cwd so the agent's bash tools see it; the expected outputs
    // normalize the cwd, so the seeded paths stay stable across runs.
    if (opts.workspaceDir !== undefined && existsSync(opts.workspaceDir)) {
      await cp(opts.workspaceDir, cwd, { recursive: true })
    }
    await opts.prepareWorkspace?.(cwd)
    const initialWorkspace = await captureWorkspaceSnapshot(cwd, {
      ignoredRootEntries: ['.agents', '.dsh', '.dsh-profile-patches', '.dsh-snapshot-stream-ready'],
    })
    const env: NodeJS.ProcessEnv = {
      ...opts.env,
      // A replay must not depend on the machine's network policy, the same reason it pins its home
      // and sessions root. The harness honors the proxy environment, so a runner that exports one
      // would send a scenario's fixture-server request to a proxy that cannot resolve the fixture
      // host and record that proxy's error page as the expected output. `undefined` removes the
      // name from the child rather than setting it empty.
      ...clearedProxyEnv(),
      DSH_SNAPSHOT: opts.mode,
      DSH_SNAPSHOT_FILE: opts.fixtureFile,
      DSH_SNAPSHOT_SESSIONS_ROOT: sessionsRoot,
      DSH_SNAPSHOT_SPILL_ROOT: spillRoot,
      DSH_HOME: join(cwd, '.dsh'),
      DSH_AGENTS_HOME: join(cwd, '.agents'),
      ...opts.overrideFile !== undefined ? { DSH_SNAPSHOT_OVERRIDE: opts.overrideFile } : {},
      ...opts.childFiles !== undefined && opts.childFiles.length > 0
        ? { DSH_SNAPSHOT_CHILD_FILES: opts.childFiles.join(delimiter) }
        : {},
    }

    // Permission answers are consumed FIFO across the whole run; exhaustion
    // falls back to `cancelled` so approval-free scenarios keep the plain stub.
    const permissionQueue = [...input.permissionAnswers ?? []]
    // A scenario bug detected inside a client callback (a scripted permission
    // kind the agent never offered). It cannot fail the run from in there: a
    // callback throw only becomes a JSON-RPC error RESPONSE to the agent, and
    // a tolerant agent treats that as a denial and carries on — the run (or
    // worse, a record) would absorb the impossible selection silently. So the
    // callback answers `cancelled` (a well-defined path for the agent),
    // captures the error here, and the step loop fails the run on it.
    let scriptError: Error | undefined
    launched = launchAcpTestAgent({
      agent: opts.agent,
      cwd,
      ...opts.configPath !== undefined ? { configPath: opts.configPath } : {},
      env,
      requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const answer = permissionQueue.shift()
        if (answer === undefined) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        const option = params.options.find(o => o.kind === answer.kind)
        if (option === undefined) {
          // The scenario scripted a selection the agent never offered — a scenario
          // bug. Captured (last one wins; same bug class either way) and
          // answered `cancelled`; the step loop rejects the run on it.
          scriptError = new Error(
            `snapshot-harness: scripted permission answer ${answer.kind} not among `
            + `the offered options [${params.options.map(o => o.kind).join(', ')}]`,
          )
          return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        }
        return Promise.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } })
      },
    })
    const active = launched
    await active.spawned
    const { client } = active

    for (const step of input.steps) {
      await runStep(
        client,
        step,
        cwd,
        match => active.waitForUpdate(match),
        () => sessionId,
        (id) => { sessionId = id },
        (id, timeoutMs, minimumTurn) => waitForPersistedTurnStart(sessionsRoot, id, timeoutMs, minimumTurn),
        (id, timeoutMs) => waitForPersistedTurnEnd(sessionsRoot, id, timeoutMs),
        (child, timeoutMs, minimumTurn) => waitForPersistedChildTurnEnd(sessionsRoot, child, timeoutMs, minimumTurn),
        (id, phase, timeoutMs) => waitForPersistedGoalPhase(sessionsRoot, id, phase, timeoutMs),
        (id, text, timeoutMs) => waitForPersistedInboxMessage(sessionsRoot, id, text, timeoutMs),
        (id, timeoutMs) => waitForPersistedTitleAfterTurnEnd(sessionsRoot, id, timeoutMs),
        (id, type, timeoutMs) => waitForPersistedEventAfterTurnEnd(sessionsRoot, id, type, timeoutMs),
      )
      // A permission exchange happens while a step's request is in flight, so
      // by the time the step settles any script bug it exposed is captured —
      // fail the run HERE, as a harness error, rather than hoping the agent's
      // reaction to the answer perturbs the transcript.
      if (scriptError !== undefined) throw scriptError
    }
    // Done driving: close stdin so the server disposes gracefully (flushing
    // persistence) and exits. Then await exit so the harvested log is complete.
    await active.close()
    // Harvest EVERY persisted log (parent + any subagent children) while the
    // generated dirs still exist, ordered primary-first.
    sessionLogs = await harvestSessionLogs(sessionsRoot)
    const finalWorkspace = await captureWorkspaceSnapshot(cwd, {
      ignoredRootEntries: ['.agents', '.dsh', '.dsh-profile-patches', '.dsh-snapshot-stream-ready'],
    })
    return {
      rawStdout: launched.rawStdout(),
      stderr: launched.stderr(),
      cwd,
      cwdAliases,
      initialWorkspace,
      finalWorkspace,
      ...sessionId !== undefined ? { sessionId } : {},
      sessionLogs,
    }
  })().then(
    value => ({ status: 'fulfilled', value } as const),
    (error: unknown) => {
      const stderr = launched?.stderr() ?? ''
      return {
        status: 'rejected',
        error: stderr === ''
          ? error
          : new Error(`snapshot-harness: scenario failed: ${String(error)}\nagent stderr:\n${stderr}`, { cause: error }),
      } as const
    },
  )

  // Failure-safe teardown: wait for a still-running child, then attempt every
  // owned-path removal even when an earlier cleanup rejects. Report every
  // teardown failure alongside a scenario failure so neither orthogonal
  // outcome hides the other.
  const cleanupResults: PromiseSettledResult<unknown>[] = []
  const cleanup = async (action: () => Promise<unknown>): Promise<void> => {
    cleanupResults.push(...await Promise.allSettled([action()]))
  }
  /* v8 ignore next 1 -- launch itself can only throw on a defensive synchronous spawn API failure */
  await cleanup(() => launched?.close('SIGKILL') ?? Promise.resolve())
  await cleanup(() => rm(cwd, { recursive: true, force: true }))
  await cleanup(() => rm(sessionsRoot, { recursive: true, force: true }))
  await cleanup(() => rm(spillRoot, { recursive: true, force: true }))

  const cleanupFailures = cleanupResults
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason as unknown)
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      outcome.status === 'rejected' ? [outcome.error, ...cleanupFailures] : cleanupFailures,
      outcome.status === 'rejected'
        ? 'snapshot scenario and cleanup failed'
        : 'snapshot cleanup failed',
    )
  }
  if (outcome.status === 'rejected') throw outcome.error
  return outcome.value
}

/** Drive one input step over the client connection. */
async function runStep(
  client: AcpTestClient,
  step: InputStep,
  cwd: string,
  waitForUpdate: (match: (u: SessionNotification['update']) => boolean) => Promise<SessionNotification['update']>,
  getSessionId: () => string | undefined,
  setSessionId: (id: string) => void,
  waitForTurnStart: (sessionId: string, timeoutMs?: number, minimumTurn?: number) => Promise<void>,
  waitForTurnEnd: (sessionId: string, timeoutMs?: number) => Promise<void>,
  waitForChildTurnEnd: (child: number, timeoutMs?: number, minimumTurn?: number) => Promise<void>,
  waitForGoalPhase: (sessionId: string, phase: string, timeoutMs?: number) => Promise<void>,
  waitForInboxMessage: (sessionId: string, text: string, timeoutMs?: number) => Promise<void>,
  waitForTitleAfterTurnEnd: (sessionId: string, timeoutMs?: number) => Promise<void>,
  waitForEventAfterTurnEnd: (sessionId: string, type: string, timeoutMs?: number) => Promise<void>,
): Promise<void> {
  switch (step.op) {
    case 'initialize':
      await client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      return
    case 'newSession': {
      const { sessionId } = await client.newSession({ cwd, mcpServers: [] })
      setSessionId(sessionId)
      return
    }
    case 'newSessionExpectError': {
      // The bridge rejects a session/new that widens the workspace scope
      // (non-empty additionalDirectories / mcpServers — unimplemented). The SDK
      // surfaces that as a rejected RPC; swallow it so the run completes and the
      // error frame is captured in the transcript.
      await client.newSession({
        cwd,
        mcpServers: [],
        ...step.additionalDirectories !== undefined ? { additionalDirectories: step.additionalDirectories } : {},
      }).then(
        () => { throw new Error('snapshot-harness: expected session/new to be rejected but it succeeded') },
        () => { /* expected: the bridge rejected the unsupported workspace scope */ },
      )
      return
    }
    case 'prompt': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: prompt before newSession')
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: step.text }] })
      return
    }
    case 'promptContent': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: promptContent before newSession')
      await client.prompt({ sessionId, prompt: step.content })
      return
    }
    case 'promptAndWaitForAgentMessage': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: promptAndWaitForAgentMessage before newSession')
      const updateDone = waitForUpdate(update => update.sessionUpdate === 'agent_message_chunk'
        && update.content.type === 'text' && update.content.text === step.waitForText)
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: step.text }] })
      await updateDone
      return
    }
    case 'promptExpectError': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: promptExpectError before newSession')
      // The model fails this turn (a recorded provider error), so the bridge
      // answers the prompt with a JSON-RPC error and the SDK rejects. That
      // rejection IS the expected protocol result — swallow it so the run
      // completes and the stdout transcript (the error frame) is captured.
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: step.text }] })
        .then(() => { throw new Error('snapshot-harness: expected the prompt to fail but it succeeded') },
          () => { /* expected: the turn failed and the bridge returned an error */ })
      return
    }
    case 'promptAndCancel': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: promptAndCancel before newSession')
      // Dispatch without awaiting because the fixture does not settle on its
      // own. Wait for an external readiness marker or the durable turn start
      // before sending cancellation.
      const promptDone = client.prompt({ sessionId, prompt: [{ type: 'text', text: step.text }] })
      if (step.waitForFile !== undefined) {
        await waitForWorkspaceFile(cwd, step.waitForFile.path, step.waitForFile.timeoutMs)
      } else {
        await waitForTurnStart(sessionId)
      }
      await client.cancel({ sessionId })
      await promptDone
      return
    }
    case 'waitForFile':
      await waitForWorkspaceFile(cwd, step.path, step.timeoutMs)
      return
    case 'waitForTurnEnd': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: waitForTurnEnd before newSession')
      await waitForTurnEnd(sessionId, step.timeoutMs)
      return
    }
    case 'waitForSubagentTurnEnd':
      await waitForChildTurnEnd(step.child ?? 1, step.timeoutMs, step.minimumTurn)
      return
    case 'waitForGoalPhase': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: waitForGoalPhase before newSession')
      await waitForGoalPhase(sessionId, step.phase, step.timeoutMs)
      return
    }
    case 'waitForInboxMessage': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: waitForInboxMessage before newSession')
      await waitForInboxMessage(sessionId, step.text, step.timeoutMs)
      return
    }
    case 'waitForTitleAfterTurnEnd': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: waitForTitleAfterTurnEnd before newSession')
      await waitForTitleAfterTurnEnd(sessionId, step.timeoutMs)
      return
    }
    case 'waitForEventAfterTurnEnd': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: waitForEventAfterTurnEnd before newSession')
      await waitForEventAfterTurnEnd(sessionId, step.type, step.timeoutMs)
      return
    }
    case 'waitForTurnStart': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: waitForTurnStart before newSession')
      await waitForTurnStart(sessionId, step.timeoutMs, step.minimumTurn)
      return
    }
    case 'cancel': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: cancel before newSession')
      if (step.waitForFile !== undefined) {
        await waitForWorkspaceFile(cwd, step.waitForFile.path, step.waitForFile.timeoutMs)
      }
      await client.cancel({ sessionId })
      return
    }
    default:
      throw new Error(`snapshot-harness: unknown input op ${JSON.stringify(step)}`)
  }
}

/** Wait until persistence exposes an open turn for the selected session. */
async function waitForPersistedTurnStart(
  root: string,
  sessionId: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  minimumTurn?: number,
): Promise<void> {
  let invalidRecord: { error: unknown } | undefined
  await vi.waitFor(async () => {
    const log = (await harvestSessionLogs(root)).find(candidate => candidate.id === sessionId)
    let openTurn: number | undefined
    try {
      openTurn = log === undefined ? undefined : latestOpenTurn(log.content)
    } catch (error) {
      // A malformed persisted record is a scenario bug, not a not-yet state:
      // vi.waitFor retries every callback throw, so capture the validation
      // failure, resolve the wait, and rethrow immediately below.
      invalidRecord = { error }
      return
    }
    if (openTurn === undefined || (minimumTurn !== undefined && openTurn < minimumTurn)) {
      const detail = minimumTurn === undefined ? 'turn/start' : `turn/start at or beyond turn ${minimumTurn}`
      throw new Error(`snapshot-harness: session "${sessionId}" did not persist ${detail} within ${timeoutMs}ms`)
    }
  }, { interval: WAIT_POLL_INTERVAL_MS, timeout: timeoutMs })
  if (invalidRecord !== undefined) throw invalidRecord.error
}

/**
 * Wait until the raw JSONL backend exposes one complete closing turn boundary.
 * The ACP cancel notification settles its prompt before the agent necessarily
 * reaches quiescence, so cancellation snapshots use this external boundary to
 * keep subprocess disposal from changing an `aborted` turn into `disposed`.
 */
async function waitForPersistedTurnEnd(
  root: string,
  sessionId: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  await vi.waitFor(async () => {
    const log = (await harvestSessionLogs(root)).find(candidate => candidate.id === sessionId)
    if (log === undefined || !latestTurnIsClosed(log.content)) {
      throw new Error(`snapshot-harness: session "${sessionId}" did not persist turn/end within ${timeoutMs}ms`)
    }
  }, { interval: WAIT_POLL_INTERVAL_MS, timeout: timeoutMs })
}

/**
 * Wait until the Nth harvested child Session closes a model work turn.
 *
 * Harvest order matches `session.1.jsonl`, `session.2.jsonl`, and so on. A
 * continuable child appends its descriptor after any inherited history and
 * before accepting its first prompt, so only a later request header proves its
 * own model work reached a closed turn.
 */
async function waitForPersistedChildTurnEnd(
  root: string,
  child: number,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  minimumTurn = 1,
): Promise<void> {
  await vi.waitFor(async () => {
    const log = (await harvestSessionLogs(root))[child]
    if (log === undefined || !latestTurnIsClosed(log.content)
      || !hasRequestHeaderAfterDescriptor(log.content)
      || !hasClosedTurn(log.content, minimumTurn)) {
      throw new Error(
        `snapshot-harness: subagent child #${child} did not persist closed turn ${minimumTurn} within ${timeoutMs}ms`,
      )
    }
  }, { interval: WAIT_POLL_INTERVAL_MS, timeout: timeoutMs })
}

/** Whether a raw session log contains the requested closed turn. */
function hasClosedTurn(content: string, turn: number): boolean {
  return content.split('\n').filter(Boolean).some((line) => {
    const event = JSON.parse(line) as { type?: unknown; data?: { turn?: unknown } }
    return event.type === 'turn/end' && event.data?.turn === turn
  })
}

/** Wait until the latest durable goal snapshot reaches one phase. */
async function waitForPersistedGoalPhase(
  root: string,
  sessionId: string,
  phase: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  await vi.waitFor(async () => {
    const content = (await harvestSessionLogs(root)).find(log => log.id === sessionId)?.content
    const matched = content?.split('\n').filter(Boolean).some((line) => {
      const event = JSON.parse(line) as { type?: unknown; data?: { goal?: { phase?: unknown } } }
      return event.type === 'goal/change' && event.data?.goal?.phase === phase
    }) ?? false
    if (!matched) {
      throw new Error(`snapshot-harness: session "${sessionId}" did not persist goal phase "${phase}" within ${timeoutMs}ms`)
    }
  }, { interval: WAIT_POLL_INTERVAL_MS, timeout: timeoutMs })
}

/** Wait until an inserted inbox message contains scenario-owned text. */
async function waitForPersistedInboxMessage(
  root: string,
  sessionId: string,
  text: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  await vi.waitFor(async () => {
    const log = (await harvestSessionLogs(root)).find(candidate => candidate.id === sessionId)
    const matched = log?.content.split('\n').some((line) => {
      if (line.length === 0) return false
      const record = JSON.parse(line) as {
        type?: unknown
        data?: { inserted?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }> }
      }
      return record.type === 'agent/inbox/spliced' && record.data?.inserted?.some(message =>
        message.content?.some(block => block.type === 'text'
          && typeof block.text === 'string' && block.text.includes(text))) === true
    }) ?? false
    if (!matched) {
      throw new Error(`snapshot-harness: session "${sessionId}" did not persist expected inbox message within ${timeoutMs}ms`)
    }
  }, { interval: WAIT_POLL_INTERVAL_MS, timeout: timeoutMs })
}

/** Whether a child log contains model work after its own descriptor event. */
function hasRequestHeaderAfterDescriptor(content: string): boolean {
  const events = content.slice(0, content.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as { type?: unknown })
  const descriptor = events.findLastIndex(event => event.type === 'subagent/descriptor')
  return descriptor >= 0
    && events.slice(descriptor + 1).some(event => event.type === 'request/header')
}

/** Wait until a complete provider or fallback title record follows the latest closed turn. */
async function waitForPersistedTitleAfterTurnEnd(
  root: string,
  sessionId: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  await vi.waitFor(async () => {
    const log = (await harvestSessionLogs(root)).find(candidate => candidate.id === sessionId)
    if (log === undefined || !latestTitleFollowsTurnEnd(log.content)) {
      throw new Error(`snapshot-harness: session "${sessionId}" did not persist session/title after turn/end within ${timeoutMs}ms`)
    }
  }, { interval: WAIT_POLL_INTERVAL_MS, timeout: timeoutMs })
}

/** Wait until a complete record of `type` follows the latest closed turn. */
async function waitForPersistedEventAfterTurnEnd(
  root: string,
  sessionId: string,
  type: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  await vi.waitFor(async () => {
    const log = (await harvestSessionLogs(root)).find(candidate => candidate.id === sessionId)
    if (log === undefined || !latestEventFollowsTurnEnd(log.content, type)) {
      throw new Error(`snapshot-harness: session "${sessionId}" did not persist ${type} after turn/end within ${timeoutMs}ms`)
    }
  }, { interval: WAIT_POLL_INTERVAL_MS, timeout: timeoutMs })
}

/** Wait for a cwd-relative marker proving an external action reached readiness. */
async function waitForWorkspaceFile(
  cwd: string,
  path: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  const target = join(cwd, path)
  await vi.waitFor(() => {
    if (!existsSync(target)) {
      throw new Error(`snapshot-harness: workspace file "${path}" did not appear within ${timeoutMs}ms`)
    }
  }, { interval: WAIT_POLL_INTERVAL_MS, timeout: timeoutMs })
}

/** Return whether the last complete raw-JSONL turn boundary closes its turn. */
function latestTurnIsClosed(content: string): boolean {
  const complete = content.slice(0, content.lastIndexOf('\n') + 1)
  return complete.lastIndexOf('\n{"type":"turn/end",')
    > complete.lastIndexOf('\n{"type":"turn/start",')
}

/** Return whether the last complete title record occurs after the last complete turn end. */
function latestTitleFollowsTurnEnd(content: string): boolean {
  const complete = content.slice(0, content.lastIndexOf('\n') + 1)
  const turnEnd = complete.lastIndexOf('\n{"type":"turn/end",')
  return turnEnd >= 0 && complete.lastIndexOf('\n{"type":"session/title",') > turnEnd
}

/** Return whether a complete record of `type` occurs after the last complete turn end. */
function latestEventFollowsTurnEnd(content: string, type: string): boolean {
  const complete = content.slice(0, content.lastIndexOf('\n') + 1)
  const turnEnd = complete.lastIndexOf('\n{"type":"turn/end",')
  return turnEnd >= 0 && complete.lastIndexOf(`\n{"type":"${type}",`) > turnEnd
}

/** Return the latest open turn number, validating the persisted boundary record. */
function latestOpenTurn(content: string): number | undefined {
  const complete = content.slice(0, content.lastIndexOf('\n') + 1)
  const start = complete.lastIndexOf('\n{"type":"turn/start",')
  if (start <= complete.lastIndexOf('\n{"type":"turn/end",')) return undefined
  const end = complete.indexOf('\n', start + 1)
  const record = JSON.parse(complete.slice(start + 1, end)) as { data?: { turn?: unknown } | null }
  const turn = record.data?.turn
  if (!Number.isSafeInteger(turn) || (turn as number) < 1) {
    throw new Error('snapshot-harness: invalid persisted turn/start record')
  }
  return turn as number
}

/**
 * Harvest EVERY persisted `.jsonl` session log under a sessions root, parse each
 * header line, and return them ordered primary-first: the top-level session (no
 * `parentSession`) leads, then each subagent child by ascending `createdAt`.
 *
 * Snapshot configs select the JSONL backend's raw mode, which lays sessions
 * out as `<root>/<project>/<session-id>/session.jsonl`. Recursive collection
 * catches the primary and every child session. Returns `[]` if no log was
 * produced (a no-session scenario).
 */
async function harvestSessionLogs(root: string): Promise<HarvestedLog[]> {
  let files: string[]
  try {
    files = await readdir(root, { recursive: true })
  } catch {
    return []
  }
  const logs: HarvestedLog[] = []
  for (const file of files) {
    if (basename(file) !== 'session.jsonl') continue
    const content = await readFile(join(root, file), 'utf8')
    const firstLine = content.split('\n').find(line => line.trim().length > 0) ?? '{}'
    const header = JSON.parse(firstLine) as { id?: unknown; createdAt?: unknown; parentSession?: unknown }
    logs.push({
      id: typeof header.id === 'string' ? header.id : '',
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
      ...typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {},
      content,
    })
  }
  // Primary (no parentSession) first, then children by ascending createdAt. A
  // scenario has exactly one top-level session. Subagent children are created
  // synchronously and strictly sequentially, so their createdAt values are
  // strictly ordered; the recordedId tiebreak only keeps a degenerate
  // same-millisecond collision (unreachable here) deterministic. This harvest
  // order must match the replay load order in dsh-llm-replay's loadSessionScripts
  // so session.<n>.jsonl maps to the same child on record and replay — replay
  // re-sorts childFiles by the same key, so the two stay consistent.
  logs.sort((a, b) => {
    const ap = Number(a.parentSession !== undefined)
    const bp = Number(b.parentSession !== undefined)
    return ap - bp || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  })
  return logs
}
