import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createInboxStub, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import ForgeService, { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, ForgeActionFailure, ForgeFailure, ForgeProvider, ForgeReadiness,
  ForgeRepository, MergeRequest,
} from '@deepseek-ai/dsh-experimental-forge'
import ForgeSessionService from '@deepseek-ai/dsh-experimental-forge-session'
import WorktreeService from '@deepseek-ai/dsh-experimental-worktree'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { pluginRecordOf, Session as SessionRecord, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import ForgePanelController from '../src/index.ts'
import type { Config, ForgePanelState, ForgeWorktreeState } from '../src/index.ts'
import { forgeWorktreeProjection, WORKTREE_RECORD } from '../src/worktree.ts'

const execute = promisify(execFile)

function executableFile(path: string): boolean {
  let stats: Stats
  try {
    stats = statSync(path)
  } catch {
    return false // A missing or unreadable candidate moves the search to the next PATH entry.
  }
  return stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o111) !== 0)
}

/**
 * The first Git executable on PATH. Spawning the bare name makes macOS try every PATH entry
 * in turn, which costs tens of milliseconds per fixture command under the long PATH of a test run.
 */
const GIT = (process.env.PATH ?? '').split(delimiter)
  .map(directory => join(directory, process.platform === 'win32' ? 'git.exe' : 'git'))
  .find(executableFile) ?? 'git'

async function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execute(GIT, ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '0',
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
      ...env,
    },
  })
  return result.stdout.trim()
}

/** Run the real Git CLI for fixtures, isolated from the developer's configuration. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return await runGit(cwd, args)
}

/**
 * Commit one new file on the checked-out branch with a fixed author and committer date.
 * @param repo - repository path.
 * @param file - new file name inside `repo`; its content is its name.
 * @param date - ISO 8601 author and committer date.
 * @returns the new commit's object name.
 */
export async function commitAt(repo: string, file: string, date: string): Promise<string> {
  await writeFile(join(repo, file), `${file}\n`)
  await git(repo, 'add', file)
  await runGit(repo, ['commit', '-m', file], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  return await git(repo, 'rev-parse', 'HEAD')
}

/**
 * List the local branches of a repository.
 * @param repo - repository path.
 * @returns short branch names in ref name order.
 */
export async function branches(repo: string): Promise<string[]> {
  return (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')).split('\n')
}

/**
 * Await an operation that must fail.
 * @param operation - operation expected to reject.
 * @returns the rejection reason.
 * @throws when the operation fulfills.
 */
export async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error: unknown) {
    return error
  }
  throw new Error('the operation fulfilled')
}

/** A private temporary directory removed by the returned disposer. */
export async function scratch(prefix: string): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  return { path, remove: () => rm(path, { recursive: true, force: true }) }
}

/**
 * Create a repository with one commit on `main` inside `parent`.
 * @param parent - directory that receives `name`.
 * @param name - repository directory name.
 * @returns the repository path.
 */
export async function repository(parent: string, name = 'repo'): Promise<string> {
  const path = join(parent, name)
  await git(parent, 'init', '-b', 'main', name)
  await git(path, 'config', 'core.autocrlf', 'false')
  await git(path, 'config', 'user.name', 'Forge fixture')
  await git(path, 'config', 'user.email', 'forge@example.invalid')
  await git(path, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(path, 'tracked.txt'), 'initial\n')
  await git(path, 'add', 'tracked.txt')
  await git(path, 'commit', '-m', 'initial')
  return path
}

/**
 * A Session outside any store whose current directory is `cwd`.
 * @param cwd - the Session's directory.
 * @returns the Session.
 */
export function plainSession(cwd: string): Session {
  const id = SessionId('forge-git')
  return SessionRecord.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd })
}

/**
 * A context with projections, the local filesystem, the local subprocess runtime, a sandbox, and a
 * workspace-write policy rooted at `root`; the caller disposes its fiber.
 * @param record - confinements of the recording sandbox.
 * @param root - workspace root of the policy and default directory of the filesystem.
 * @param real - use the platform sandbox instead of the recording one.
 * @returns the context.
 */
export async function gitContext(record: SandboxRecord, root: string, real = false): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalSubprocessRuntime)
  if (real) await ctx.plugin(LocalSandbox)
  else await ctx.plugin(RecordingSandbox, record)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  return ctx
}

/**
 * Write an executable POSIX script.
 * @param path - script file.
 * @param body - shell commands after the shebang.
 * @returns `path`.
 */
export async function script(path: string, body: string): Promise<string> {
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

/**
 * Confinements seen by the recording sandbox; a set `failure` is thrown instead of confining, and a set `gate`
 * delays each recorded confinement until the promise it returns for the argv settles.
 */
export interface SandboxRecord {
  readonly calls: { argv: readonly string[]; policy: SandboxPolicy }[]
  failure: unknown
  gate: ((argv: readonly string[]) => Promise<void> | undefined) | undefined
}

/** A fresh record without failure or gate. */
export function sandboxRecord(): SandboxRecord {
  return { calls: [], failure: undefined, gate: undefined }
}

/** Sandbox double that records each confinement in its plugin config and returns the argv unchanged. */
export class RecordingSandbox extends SandboxProvider {
  constructor(ctx: Context, private readonly record: SandboxRecord) {
    super(ctx)
  }

  async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    if (this.record.failure !== undefined) throw this.record.failure
    this.record.calls.push({ argv, policy })
    await this.record.gate?.(argv)
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

/** Confinements held by {@link hold}. */
export interface Hold {
  /** Settles when the first matching command reaches the sandbox. */
  readonly reached: Promise<void>
  /** Let every held and later matching command run. */
  readonly release: () => void
}

/**
 * Hold each confinement whose argv contains `argument` until released; other confinements keep the record's previous gate.
 * @param record - sandbox record whose gate is wrapped.
 * @param argument - exact argv element that selects the held commands, such as a Git subcommand.
 * @returns the arrival signal and the release.
 */
export function hold(record: SandboxRecord, argument: string): Hold {
  const reached: PromiseWithResolvers<void> = Promise.withResolvers()
  const released: PromiseWithResolvers<void> = Promise.withResolvers()
  const previous = record.gate
  record.gate = (argv) => {
    if (!argv.includes(argument)) return previous?.(argv)
    reached.resolve()
    return released.promise
  }
  return { reached: reached.promise, release: () => { released.resolve() } }
}

/** Repository served by {@link FakeProvider}. */
export const demo: ForgeRepository = { forge: 'fake', host: 'fake.test', owner: 'octo', name: 'demo' }

/** Canonical URL of a `demo` change request. */
export function pullUrl(number: number): string {
  return `https://fake.test/octo/demo/pull/${number}`
}

/** Open change request snapshot with settled checks. */
export function snapshot(ref: ChangeRequestRef): ChangeRequestSnapshot {
  return {
    ref,
    url: pullUrl(ref.number),
    title: `Change ${ref.number}`,
    state: 'open',
    draft: false,
    author: 'octo',
    headBranch: 'feat',
    headSha: 'a'.repeat(40),
    baseBranch: 'main',
    additions: 12,
    deletions: 3,
    mergeability: 'mergeable',
    mergeReady: true,
    mergeMethods: ['squash', 'merge', 'rebase'],
    reviewDecision: 'none',
    checks: [],
    checksRollup: 'success',
    checksTruncated: false,
    unresolvedThreads: 0,
    updatedAt: '2026-10-09T00:00:00Z',
    closedAt: null,
  }
}

/** Provider for `https://fake.test/<owner>/<name>.git` remotes and `https://fake.test/<owner>/<name>/pull/<n>` URLs. */
export class FakeProvider implements ForgeProvider {
  readonly forge = 'fake'
  readonly fetches: (readonly number[])[] = []
  readonly probes: string[] = []
  /** Polling failures returned instead of snapshots, by change request number. */
  readonly failures = new Map<number, ForgeFailure>()
  /** Snapshot fields that replace the defaults, by change request number. */
  readonly overrides = new Map<number, Partial<ChangeRequestSnapshot>>()
  readinessImpl: (host: string, signal: AbortSignal) => Promise<ForgeReadiness> = () => Promise.resolve({ state: 'ready', message: null })
  /** Every action in call order, such as `ready 7` or `merge 7 squash <sha>`. */
  readonly actions: string[] = []
  /** Outcome of the next actions; undefined reports success. */
  actionResult: ForgeActionFailure | undefined
  /** Patches or failures the change request diff returns, by number; others return a not-found failure. */
  readonly patches = new Map<number, string | ForgeFailure>()
  /** Change request numbers in the order their diffs were read. */
  readonly diffs: number[] = []
  /** File texts or failures by `<commit>:<path>`; others return a not-found failure. */
  readonly texts = new Map<string, string | ForgeFailure>()
  /** Open change request numbers that a head lookup returns, by head branch. */
  readonly heads = new Map<string, readonly number[]>()
  /** Head lookups in call order, as `<owner>/<name> <branch>`. */
  readonly lookups: string[] = []

  repositoryFromRemote(url: string): ForgeRepository | undefined {
    const [, host = '', owner = '', name = ''] = /^https:\/\/([a-z.]+\.test)\/([^/]+)\/([^/]+?)\.git$/.exec(url) ?? []
    return host.length === 0 ? undefined : { forge: 'fake', host, owner, name }
  }

  changeRequestFromUrl(url: string): ChangeRequestRef | undefined {
    const [, owner = '', name = '', number = ''] = /^https:\/\/fake\.test\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url) ?? []
    return number.length === 0 ? undefined : { repository: { ...demo, owner, name }, number: Number(number) }
  }

  changeRequestUrl(ref: ChangeRequestRef): string {
    return `https://fake.test/${ref.repository.owner}/${ref.repository.name}/pull/${ref.number}`
  }

  fetch(refs: readonly ChangeRequestRef[]): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    this.fetches.push(refs.map(ref => ref.number))
    return Promise.resolve(new Map(refs.map(ref => [
      changeRequestKey(ref), this.failures.get(ref.number) ?? { ...snapshot(ref), ...this.overrides.get(ref.number) },
    ])))
  }

  findByHead(repository: ForgeRepository, branch: string): Promise<readonly ChangeRequestRef[]> {
    this.lookups.push(`${repository.owner}/${repository.name} ${branch}`)
    return Promise.resolve((this.heads.get(branch) ?? []).map(number => ({ repository, number })))
  }

  readiness(host: string, signal: AbortSignal): Promise<ForgeReadiness> {
    this.probes.push(host)
    return this.readinessImpl(host, signal)
  }

  markReady(ref: ChangeRequestRef): Promise<ForgeActionFailure | undefined> {
    this.actions.push(`ready ${ref.number}`)
    return Promise.resolve(this.actionResult)
  }

  merge(ref: ChangeRequestRef, request: MergeRequest): Promise<ForgeActionFailure | undefined> {
    this.actions.push(`merge ${ref.number} ${request.method} ${request.headSha}`)
    return Promise.resolve(this.actionResult)
  }

  diff(ref: ChangeRequestRef): Promise<string | ForgeFailure> {
    this.diffs.push(ref.number)
    return Promise.resolve(this.patches.get(ref.number) ?? { code: 'not-found', message: `no diff of #${ref.number}` })
  }

  fileText(_ref: ChangeRequestRef, commit: string, path: string): Promise<string | ForgeFailure> {
    return Promise.resolve(this.texts.get(`${commit}:${path}`) ?? { code: 'not-found', message: `no ${path} at ${commit}` })
  }

  fileUrl(ref: ChangeRequestRef, commit: string, path: string): string {
    return `${pullUrl(ref.number)}/files/${commit}/${path}`
  }
}

/** An Agent double that counts the turns it would start. */
export interface TestAgent extends Agent {
  /** Turns the Agent would have started: a wake while idle, or one latched behind maintenance and replayed when it ends. */
  readonly wakes: number
}

/**
 * An idle Agent double that delivers like the Agent loop: `followup` queues the message for the next turn, `steer`
 * and `inject` for the next step, each announces it with `agent/inbox/inserted`, and every delivery but `inject`
 * then wakes the Agent. A wake during maintenance waits and replays when the task ends while a message is still
 * pending; it drives no turns and leaves the inbox to the caller. It runs one maintenance task at a time, refusing
 * another synchronously while one runs, and `cancel` clears the inbox unless told to keep it and aborts the running
 * task's signal with its cause.
 * @param ctx - composition that owns the Agent scope.
 * @param session - Session the Agent drives.
 * @returns the Agent, not yet registered.
 */
export function testAgent(ctx: Context, session: Session): TestAgent {
  const scope = ctx.plugin(() => {})
  const inbox = createInboxStub()
  let maintenance: Maintenance | undefined
  let wakes = 0
  const wake = (): void => {
    if (maintenance === undefined) wakes++
    else if (!maintenance.disposed) maintenance.latched = true
  }
  const agent: TestAgent = {
    id: session.id, session, options: {}, status: 'idle', ctx: scope.ctx, model: unsupportedModel(), inbox,
    get wakes() { return wakes },
    send(message, target, wakeup) {
      inbox.append(target, message)
      agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
      if (wakeup) wake()
    },
    followup(message) { agent.send(message, 'next-turn', true) },
    steer(message) { agent.send(message, 'next-step', true) },
    inject(message) { agent.send(message, 'next-step', false) },
    cancel(cause, options = {}) {
      if (options.keepInbox !== true) inbox.clear()
      if (maintenance === undefined) return
      if (cause.kind === 'disposed') maintenance.disposed = true
      maintenance.abort.abort(cause)
    },
    async whenIdle() {
      while (maintenance !== undefined) await maintenance.done
    },
    runMaintenance(task) {
      if (maintenance !== undefined) throw new Error(`agent "${session.id}" already has active work`)
      const current: Maintenance = { abort: new AbortController(), latched: false, disposed: false, done: Promise.resolve() }
      maintenance = current
      const running = task(current.abort.signal).finally(() => {
        maintenance = undefined
        if (current.latched && !current.disposed && inbox.nextTurn.length + inbox.nextStep.length > 0) wakes++
      })
      current.done = running.then(() => undefined, () => undefined)
      return running
    },
  }
  return agent
}

/** The maintenance task an {@link testAgent} runs, and the wake it latched. */
interface Maintenance {
  readonly abort: AbortController
  /** Whether a delivery woke the Agent during the task. */
  latched: boolean
  /** Whether the Agent's disposal aborted the task, which drops the latched wake. */
  disposed: boolean
  /** Settles once the task ends, whatever its outcome. */
  done: Promise<void>
}

/** A user prompt. */
export function prompt(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * Queue a user prompt for the next turn and wake the Agent, as the Web Session Remote does.
 * @param agent - receiving Agent.
 * @param text - prompt text.
 */
export function sendPrompt(agent: Agent, text: string): void {
  agent.followup(prompt(text))
}

/**
 * Match the directory notice that entering `path` queues.
 * @param path - directory the notice names.
 * @returns an asymmetric matcher for the notice message.
 */
export function notice(path: string): unknown {
  const text: unknown = expect.stringContaining(JSON.stringify(path))
  return expect.objectContaining({ role: 'user', source: { kind: 'working-directory' }, content: [{ type: 'text', text }] })
}

/** One step proposal of the Agent loop. */
export interface StepProposal {
  readonly turn: number
  readonly step: number
  /** Messages removed from the inbox for the step; none when omitted. */
  readonly messages?: UserMessage[]
  /** Decision of the listeners after the panel's; entering with `messages` when omitted. */
  readonly decision?: PreStepDecision
  /** Turn cancellation; a fresh signal when omitted. */
  readonly signal?: AbortSignal
}

/**
 * Run the `agent/pre-step` waterfall that the Agent loop runs before it enters a step.
 * @param ctx - composition whose listeners decide.
 * @param agent - Agent that proposes the step.
 * @param proposal - turn, step, messages, and the decision after the panel's listener.
 * @returns the decision the listeners compose.
 */
export async function proposeStep(ctx: Context, agent: Agent, proposal: StepProposal): Promise<PreStepDecision> {
  const messages = proposal.messages ?? []
  const decision: PreStepDecision = proposal.decision ?? { kind: 'enter', messages }
  return await agentEvents(ctx, agent).waterfall('agent/pre-step', {
    modelSelection: { provider: 'mock', model: 'mock' }, messages, turn: proposal.turn, step: proposal.step,
    signal: proposal.signal ?? new AbortController().signal,
  }, () => Promise.resolve(decision))
}

/**
 * Append the start of a turn, as the Agent loop does before it proposes the turn's first step.
 * @param session - live Session receiving the event.
 * @param turn - turn number.
 */
export function startTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
}

/**
 * Append the start of a step, as the Agent loop does after an entered proposal.
 * @param session - live Session receiving the event.
 * @param turn - turn number.
 * @param step - step number within the turn.
 */
export function startStep(session: Session, turn: number, step = 1): void {
  session.append('step/start', { turn, step })
}

/** A booted composition without the panel Remote, with one live Session and its idle Agent. */
export interface Runtime {
  readonly ctx: Context
  readonly provider: FakeProvider
  readonly sandbox: SandboxRecord
  readonly session: Session
  readonly agent: TestAgent
  /** Data of the Session's worktree records in log order. */
  readonly records: unknown[]
  /** Fiber of the worktree service, or undefined when it is not mounted. */
  readonly worktrees: ReturnType<Context['plugin']> | undefined
}

/** A {@link Runtime} with the panel Remote. */
export interface Bench extends Runtime {
  /** Fiber of the panel Remote. */
  readonly panel: ReturnType<Context['plugin']>
  /** Reads the `forgeWorktree` projection without holding a registration, so the panel's own registration decides its lifetime. */
  readonly worktreeStates: ProjectionHandle<ForgeWorktreeState>
}

/** Optional services of a {@link runtime} or {@link bench}. */
export interface BenchOptions {
  /** Mount the worktree service. */
  readonly worktrees?: boolean
}

/**
 * Mount the Session, directory, process, forge, and binding services with a recording sandbox, and open one live Session.
 * @param cwd - Session project directory.
 * @param options - optional services.
 * @returns the composition without the panel Remote.
 */
export async function runtime(cwd: string, options: BenchOptions = {}): Promise<Runtime> {
  const ctx = new Context()
  const provider = new FakeProvider()
  const sandbox = sandboxRecord()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(LocalFileSystem, { cwd })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(RecordingSandbox, sandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: cwd })
    await ctx.plugin(WorkingDirectoryService)
    await ctx.plugin(ForgeService, { activeIntervalMs: 60_000, idleIntervalMs: 60_000, maxBackoffMs: 60_000, fetchTimeoutMs: 1_000 })
    await ctx.plugin({ inject: ['forge'], apply(child: Context) { child.forge.register(provider) } })
    await ctx.plugin(ForgeSessionService, {})
    const worktrees = options.worktrees === true ? ctx.plugin(WorktreeService, {}) : undefined
    if (worktrees !== undefined) await worktrees
    const session = ctx.sessions.create(SessionId(`forge-panel-${Math.random().toString(36).slice(2)}`), { meta: { cwd } })
    const records: unknown[] = []
    ctx.on('session/event', (target: Session, event: SessionEvent) => {
      const record = pluginRecordOf(event)
      if (target === session && record?.type === WORKTREE_RECORD) records.push(record.data)
    })
    const agent = testAgent(ctx, session)
    await ctx.agents.register(agent)
    return { ctx, provider, sandbox, session, agent, records, worktrees }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

/**
 * Mount a {@link runtime} and the panel Remote.
 * @param cwd - Session project directory.
 * @param config - panel Remote configuration.
 * @param options - optional services.
 * @returns the composition with one live Session.
 */
export async function bench(cwd: string, config: Config = {}, options: BenchOptions = {}): Promise<Bench> {
  const base = await runtime(cwd, options)
  const panel = base.ctx.plugin(ForgePanelController, config)
  try {
    await panel
  } catch (error) {
    await base.ctx.fiber.dispose()
    throw error
  }
  const worktreeStates = await base.ctx.sessionProjections.register(forgeWorktreeProjection)
  await worktreeStates.dispose()
  return { ...base, panel, worktreeStates }
}

/** A panel stream reader that keeps every state it has pulled. */
export interface Follower {
  readonly states: ForgePanelState[]
  /** Pull states until one satisfies `predicate`, checking the states already pulled first. */
  until: (predicate: (state: ForgePanelState) => boolean) => Promise<ForgePanelState>
  /** Pull states until one that this call pulls satisfies `predicate`. */
  next: (predicate: (state: ForgePanelState) => boolean) => Promise<ForgePanelState>
  /** Abort the stream and wait for it to end. */
  stop: () => Promise<void>
}

/**
 * Start reading `ctx.forgePanel.follow(session)`.
 * @param ctx - composition that provides `forgePanel`.
 * @param session - Session to follow.
 * @returns the reader.
 */
export function follow(ctx: Context, session: Session): Follower {
  const controller = new AbortController()
  const iterator = ctx.forgePanel.follow(session, controller.signal)[Symbol.asyncIterator]()
  const states: ForgePanelState[] = []
  const pull = async (predicate: (state: ForgePanelState) => boolean): Promise<ForgePanelState> => {
    while (true) {
      const next = await iterator.next()
      if (next.done === true) throw new Error('panel stream ended')
      states.push(next.value)
      if (predicate(next.value)) return next.value
    }
  }
  return {
    states,
    async until(predicate) {
      for (const state of states) if (predicate(state)) return state
      return await pull(predicate)
    },
    next: pull,
    async stop() {
      controller.abort()
      await iterator.return?.()
    },
  }
}

/**
 * Append one completed turn in which the model runs `bash` commands.
 * @param session - live Session receiving the events.
 * @param turn - turn number.
 * @param calls - commands with their rendered results.
 */
export function shellTurn(session: Session, turn: number, calls: readonly { callId: string; command: string; output: string }[]): void {
  const step = 1
  const callArguments = (command: string) => JSON.stringify({ command })
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  session.append('assistant/message', {
    turn,
    step,
    stream: [],
    message: createAssistantMessage({
      content: calls.map(call => ({ type: 'tool-call' as const, id: ToolCallId(call.callId), name: 'bash', arguments: callArguments(call.command) })),
      source: { provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  for (const call of calls) session.append('tool/call', { turn, step, callId: ToolCallId(call.callId), name: 'bash', arguments: callArguments(call.command) })
  for (const call of calls) {
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({ callId: ToolCallId(call.callId), content: [{ type: 'text', text: call.output }], isError: false }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}
