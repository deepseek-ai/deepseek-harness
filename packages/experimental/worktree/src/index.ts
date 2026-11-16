/** Creates a new Git branch and checkout, then changes the calling Session's working directory; restores a removed checkout. */

import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-settings'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-working-directory'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { WorktreeReclamation } from './archive.ts'
import { WorktreeError } from './error.ts'
import { PREPARE_DIRECTORY } from './directory.ts'
import { generatedWorktreeName } from './name.ts'
import { runCommand, scanCommand } from './process.ts'
import type { ProcessConfig } from './process.ts'
import { CREATED_RECORD, worktreeProjection } from './projection.ts'
import type { WorktreeProjectionState } from './projection.ts'
import { checkoutIdentity, registration, removeCheckout } from './removal.ts'
import type { GitScan } from './removal.ts'
import type {
  CreatedWorktree, CreateWorktreePhase, CreateWorktreeRequest, RestoredWorktree, RestoreWorktreeRequest, WorktreeCleanup,
} from './types.ts'

export type {
  CreatedWorktree, CreateWorktreePhase, CreateWorktreeRequest, RestoredWorktree, RestoreWorktreeRequest, WorktreeCleanup, WorktreeCreation,
} from './types.ts'
export { generatedWorktreeName } from './name.ts'
export { CREATED_RECORD, createdWorktreeSchema, worktreeProjection } from './projection.ts'
export type { WorktreeProjectionState } from './projection.ts'
export { WorktreeError, type WorktreeErrorCode } from './error.ts'

/** Worktree location, generated names, executables, subprocess resource limits, and the archive cleanup switch. */
export interface Config {
  /** Keep every checkout when its Session is archived; editable live from the Plugins page. */
  retainOnArchive: Volatile<boolean>
  /** Relative checkout pool inside the source repository. */
  directory?: string
  /** Prefix for automatically generated branch and checkout names. */
  namePrefix?: string
  /** Executable name or absolute execution-world path of a Git release that honors `GIT_NO_LAZY_FETCH`. */
  gitCommand?: string
  /** Node executable used for sandboxed directory allocation. */
  nodeCommand?: string
  /** Deadline in milliseconds for one command. */
  timeoutMs?: number
  /** Subprocess termination grace in milliseconds. */
  graceMs?: number
  /**
   * Maximum captured bytes per subprocess output stream; archive inspection
   * streams `git status`, and inspection and restoration stream the worktree
   * listing, so it bounds only their stderr.
   */
  maxOutputBytes?: number
}

type ResolvedConfig = Required<Config> & ProcessConfig

interface WorktreeSpec {
  branch: string
  revision: string
}

/** Runs one confined Git command; output with an exit code outside `allowedExitCodes` throws. */
type GitRun = (directory: string, args: string[], allowedExitCodes?: number[], env?: NodeJS.ProcessEnv) => ReturnType<typeof runCommand>

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktrees: WorktreeService
  }
}

/** Reject path traversal independently of Git's branch-name grammar. */
function relativePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !value.includes(':')
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

/**
 * Creates retained Git worktrees under the mounted filesystem and sandbox
 * providers, records each creation in the Session log, and reclaims a clean,
 * unreferenced checkout when the Session that created it is archived.
 */
export class WorktreeService extends Service {
  static inject = ['workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy', 'sessionProjections']

  static Config = z.object({
    retainOnArchive: z.boolean().default(false).volatile(),
    directory: z.string().default('.agents/worktrees'),
    namePrefix: z.string().default('dsh-'),
    gitCommand: z.string().default('git'),
    nodeCommand: z.string().default('node'),
    timeoutMs: z.number().default(300_000),
    graceMs: z.number().default(3_000),
    maxOutputBytes: z.number().default(65_536),
  })

  private readonly config: ResolvedConfig
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly checkouts = new Map<string, Promise<void>>()
  private projection!: ProjectionHandle<WorktreeProjectionState>
  private reclamation: WorktreeReclamation | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'worktrees')
    this.config = config as ResolvedConfig
    if (!relativePath(this.config.directory)) throw new Error('worktree: directory must be a relative directory without dot segments')
    if (!relativePath(`${this.config.namePrefix}name`) || this.config.namePrefix.startsWith('-')) {
      throw new Error('worktree: namePrefix must produce a relative branch name')
    }
    for (const key of ['gitCommand', 'nodeCommand'] as const) {
      if (this.config[key].trim().length === 0) throw new Error(`worktree: ${key} must not be empty`)
    }
    for (const key of ['timeoutMs', 'graceMs', 'maxOutputBytes'] as const) {
      const value = this.config[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new Error(`worktree: ${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
      }
    }
    ctx.effect(() => async () => {
      this.lifetime.abort(new WorktreeError('worktree service disposed', 'WORKTREE_UNAVAILABLE'))
      await Promise.allSettled(this.pending)
    })
    // The Forge panel draws the retain switch on this row's Plugins page.
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(worktreeProjection)
    // Reclamation needs the Workspace archive events and the Session corpus; without
    // them the service only creates and restores, as a headless profile composes it.
    this.ctx.inject(['workspaceRegistry', 'sessionQuery', 'sessions', 'workingDirectory', 'sandboxPolicy'], (scope) => {
      const reclamation = new WorktreeReclamation(scope, {
        retainOnArchive: () => this.config.retainOnArchive.get(),
        exclusiveCheckout: (path, body) => this.exclusiveCheckout(path, body),
        removeCheckout: (session, request, signal, admit) => this.removeCheckout(session, request, signal, admit),
      }, this.projection)
      this.reclamation = reclamation
      scope.effect(() => () => { this.reclamation = undefined })
    })
  }

  /**
   * Create a fresh branch and checkout at a pinned local revision, then enter it.
   * Existing branches or checkout paths fail. Uncommitted files stay in the source checkout.
   * Checkout disables configured clean, smudge, and process filters without changing Git config.
   * Repository-local replacement refs still apply; baseCommit reports the resolved object name.
   * The new checkout becomes current only after Git setup succeeds. Failures may retain newly
   * allocated Git/filesystem artifacts; no branch or checkout is removed automatically.
   * @param agent - caller whose current directory selects the source repository and file policy.
   * @param request - optional new name and local revision; defaults are generated name and HEAD.
   * @param signal - cancellation of lookup, creation, and working-directory publication.
   * @param onPhase - receives each stage before it begins; it must not throw.
   * @returns canonical checkout path, branch name, pinned commit, and source repository root.
   * @throws {WorktreeError} for an invalid request, an existing branch or path, or a failed, oversized, or timed-out
   *   command; a failure after allocation keeps its `name` and `code` and adds retained-artifact context.
   */
  async create(
    agent: Agent,
    request: CreateWorktreeRequest = {},
    signal?: AbortSignal,
    onPhase?: (phase: CreateWorktreePhase) => void,
  ): Promise<CreatedWorktree> {
    const operationSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    operationSignal.throwIfAborted()
    const operation = this.createCheckout(agent, this.resolve(agent, request), operationSignal, onPhase)
    this.pending.add(operation)
    try {
      return await operation
    } finally {
      this.pending.delete(operation)
    }
  }

  /**
   * Check out a removed worktree again at its recorded directory: its branch
   * when the branch still exists, otherwise a new branch of the same name at
   * `baseCommit`. Only the missing target's unlocked registration is removed, and an
   * existing directory fails. Changes that were never committed are not
   * recovered. Checkout disables configured clean, smudge, and process filters,
   * as creation does. The calling Session's working directory does not change.
   * Failures may retain newly allocated Git/filesystem artifacts.
   * @param agent - caller whose sandbox policy confines the commands.
   * @param request - recorded directory, branch, base commit, and source repository root.
   * @param signal - cancellation of the restoration.
   * @param onPhase - receives each stage before it begins; it must not throw.
   * @returns the directory and whether the branch was created again.
   * @throws {WorktreeError} for an invalid request, an existing path, a locked registration, or a failed, oversized,
   *   or timed-out command; a failure after allocation keeps its `name` and `code` and adds retained-artifact context.
   */
  async restore(
    agent: Agent,
    request: RestoreWorktreeRequest,
    signal?: AbortSignal,
    onPhase?: (phase: CreateWorktreePhase) => void,
  ): Promise<RestoredWorktree> {
    const operationSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    operationSignal.throwIfAborted()
    const operation = this.exclusiveCheckout(request.path, () => this.restoreCheckout(agent, request, operationSignal, onPhase))
    this.pending.add(operation)
    try {
      return await operation
    } finally {
      this.pending.delete(operation)
    }
  }

  /**
   * Read the archive cleanup of a Session's created checkout; waiting never
   * starts one. Absent without the Workspace and query providers.
   * @param session - archived Session whose cleanup is read.
   * @param revision - null reads at once; a matching revision waits for that attempt to settle.
   * @returns the attempt state, or null when none exists, the revision was superseded, or the service is stopping.
   */
  async cleanupOf(session: Session, revision: number | null): Promise<WorktreeCleanup | null> {
    return await this.reclamation?.cleanupOf(session, revision) ?? null
  }

  /**
   * Inspect a recorded checkout under the Session's policy and, when eligible
   * and admitted, remove it and its registration without force or branch
   * deletion. A rejection can leave a partial directory; the branch stays.
   */
  private async removeCheckout(
    session: Session, request: RestoreWorktreeRequest, signal: AbortSignal, admit: () => boolean,
  ): Promise<boolean> {
    const control = AbortSignal.any([this.lifetime.signal, signal])
    control.throwIfAborted()
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    const git = { read: this.gitRunner(policy, control), scan: this.gitScanner(policy, control) }
    const operation = removeCheckout(this.ctx, this.config.directory, request, git, control, admit)
    this.pending.add(operation)
    try { return await operation } finally { this.pending.delete(operation) }
  }

  private exclusiveCheckout<T>(path: string, body: () => Promise<T>): Promise<T> {
    const operation = (this.checkouts.get(path) ?? Promise.resolve()).then(body)
    const tail = operation.then(() => {}, () => {})
    this.checkouts.set(path, tail)
    void tail.then(() => { if (this.checkouts.get(path) === tail) this.checkouts.delete(path) })
    return operation
  }

  private resolve(agent: Agent, request: CreateWorktreeRequest): WorktreeSpec {
    const branch = request.name ?? generatedWorktreeName(this.config.namePrefix, agent.session.id)
    if (!relativePath(branch) || branch.startsWith('-')) throw new WorktreeError('worktree name must be a relative Git branch name', 'WORKTREE_INVALID_ARGUMENT')
    const revision = request.from ?? 'HEAD'
    if (revision.length === 0) throw new WorktreeError('worktree from must name a local commit, branch, or tag', 'WORKTREE_INVALID_ARGUMENT')
    return { branch, revision }
  }

  private async createCheckout(
    agent: Agent,
    { branch, revision }: WorktreeSpec,
    signal: AbortSignal,
    onPhase: ((phase: CreateWorktreePhase) => void) | undefined,
  ): Promise<CreatedWorktree> {
    onPhase?.('prepare')
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    const run = this.gitRunner(policy, signal)
    await assertBranchName(run, cwd, branch, 'worktree name')
    const rootOutput = await run(cwd, ['rev-parse', '--show-toplevel'])
    const rootTarget = await this.ctx.fs.resolve(rootOutput.stdout.replace(/\r?\n$/, ''), { cwd, signal })
    const repositoryRoot = this.ctx.fs.processPath(rootTarget)
    const base = await run(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])
    const baseCommit = base.stdout.trim()
    const existing = await run(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])
    if (existing.exitCode === 0) throw new WorktreeError(`worktree branch already exists: ${branch}`, 'WORKTREE_ALREADY_EXISTS')
    const pool = await this.ctx.fs.resolve(this.config.directory, { cwd: repositoryRoot, signal })
    const poolPath = this.ctx.fs.processPath(pool)
    const destination = await this.ctx.fs.resolve(branch, { cwd: poolPath, signal })
    const path = this.ctx.fs.processPath(destination)
    if (await this.ctx.fs.lstat(path, undefined, signal) !== undefined) throw new WorktreeError(`worktree path already exists: ${path}`, 'WORKTREE_ALREADY_EXISTS')
    try {
      await this.prepareDirectory(policy, repositoryRoot, poolPath, path, signal)
      await run(repositoryRoot, ['--work-tree', repositoryRoot, 'worktree', 'add', '--no-checkout', '-b', branch, '--', path, baseCommit])
      const overrides = await filterOverrides(run, path)
      onPhase?.('checkout')
      await run(path, ['--work-tree', path, 'reset', '--hard', '--no-recurse-submodules', baseCommit], undefined, overrides)
      const canonicalPath = await this.ctx.workingDirectory.set(agent, path, signal)
      const created: CreatedWorktree = { path: canonicalPath, branch, baseCommit, repositoryRoot }
      appendPluginRecord(agent.session, CREATED_RECORD, created)
      return created
    } catch (error) {
      throw retainedFailure(`Could not finish worktree ${branch} at ${path}. Any created checkout and branch are retained.`, error, signal)
    }
  }

  private async restoreCheckout(
    agent: Agent,
    { path, branch, baseCommit, repositoryRoot }: RestoreWorktreeRequest,
    signal: AbortSignal,
    onPhase: ((phase: CreateWorktreePhase) => void) | undefined,
  ): Promise<RestoredWorktree> {
    onPhase?.('prepare')
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    const run = this.gitRunner(policy, signal)
    if (await this.ctx.fs.lstat(path, undefined, signal) !== undefined) throw new WorktreeError(`worktree path already exists: ${path}`, 'WORKTREE_ALREADY_EXISTS')
    if (!relativePath(branch) || branch.startsWith('-')) throw new WorktreeError('worktree branch must be a relative Git branch name', 'WORKTREE_INVALID_ARGUMENT')
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(baseCommit)) throw new WorktreeError('worktree baseCommit must be a full commit object name', 'WORKTREE_INVALID_ARGUMENT')
    const identity = await checkoutIdentity(this.ctx, this.config.directory, { path, branch, baseCommit, repositoryRoot }, run, signal)
    if (identity === null) {
      throw new WorktreeError('worktree restoration must use a canonical directory inside the configured pool of the source checkout root', 'WORKTREE_INVALID_ARGUMENT')
    }
    await assertBranchName(run, repositoryRoot, branch, 'worktree branch')
    await run(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${baseCommit}^{commit}`])
    const scan = this.gitScanner(policy, signal)
    const fields = await registration(this.ctx, { path, branch, baseCommit, repositoryRoot }, identity.target, scan, signal)
    if (fields !== undefined) {
      if (fields.some(field => field === 'locked' || field.startsWith('locked '))) throw new WorktreeError(`worktree is locked: ${path}`, 'WORKTREE_LOCKED')
      if (await this.ctx.fs.lstat(path, undefined, signal) !== undefined) throw new WorktreeError(`worktree path already exists: ${path}`, 'WORKTREE_ALREADY_EXISTS')
      await run(repositoryRoot, ['worktree', 'remove', '--', path])
    }
    const existing = await run(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])
    const branchRecreated = existing.exitCode !== 0
    try {
      const pool = await this.ctx.fs.resolve(this.config.directory, { cwd: repositoryRoot, signal })
      await this.prepareDirectory(policy, repositoryRoot, this.ctx.fs.processPath(pool), path, signal)
      await run(repositoryRoot, [
        '--work-tree', repositoryRoot, 'worktree', 'add', '--no-checkout',
        ...branchRecreated ? ['-b', branch, '--', path, baseCommit] : ['--', path, branch],
      ])
      const overrides = await filterOverrides(run, path)
      onPhase?.('checkout')
      await run(path, ['--work-tree', path, 'reset', '--hard', '--no-recurse-submodules', 'HEAD'], undefined, overrides)
      return { path, branchRecreated }
    } catch (error) {
      throw retainedFailure(`Could not restore worktree ${branch} at ${path}. Any created checkout and branch are retained.`, error, signal)
    }
  }

  /** Confine Git commands to the caller's sandbox policy, collecting bounded stdout. */
  private gitRunner(policy: SandboxExecutionPolicy, signal: AbortSignal): GitRun {
    return (directory, args, allowedExitCodes, env) => runCommand(
      this.ctx, this.config, policy, directory, this.gitArgv(args), signal, allowedExitCodes, env,
    )
  }

  /** Confine Git commands to the caller's sandbox policy, streaming stdout instead of collecting it. */
  private gitScanner(policy: SandboxExecutionPolicy, signal: AbortSignal): GitScan {
    return (directory, args, onField) => scanCommand(this.ctx, this.config, policy, directory, this.gitArgv(args), signal, onField)
  }

  /** The configured Git executable with hooks and the filesystem monitor disabled, followed by `args`. */
  private gitArgv(args: string[]): [string, ...string[]] {
    return [this.config.gitCommand, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args]
  }

  /** Allocate the checkout directory exclusively inside the pool, creating a self-ignoring pool when it is new. */
  private async prepareDirectory(
    policy: SandboxExecutionPolicy,
    repositoryRoot: string,
    poolPath: string,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    await runCommand(this.ctx, this.config, policy, repositoryRoot,
      [this.config.nodeCommand, '--input-type=module', '-e', PREPARE_DIRECTORY, poolPath, path], signal)
  }
}

/**
 * Reject a name Git does not accept as a branch.
 * @param run - confined Git runner.
 * @param directory - repository directory for the check.
 * @param branch - candidate branch name.
 * @param field - request field named in the failure.
 */
async function assertBranchName(run: GitRun, directory: string, branch: string, field: string): Promise<void> {
  const checked = await run(directory, ['check-ref-format', `refs/heads/${branch}`], [0, 1])
  if (checked.exitCode !== 0) throw new WorktreeError(`${field} must be a valid Git branch name`, 'WORKTREE_INVALID_ARGUMENT')
}

/**
 * Add retained-artifact context to a failure without changing its routable identity:
 * a `HarnessError` keeps its `name` and `code`, and caller cancellation stays an `AbortError`.
 * A `HarnessError` subclass other than `WorktreeError` is rebuilt as a plain `HarnessError`, so
 * callers route on `name` and `code` rather than on `instanceof` the original subclass.
 * @param context - operation summary placed before the original message.
 * @param error - failure thrown after allocation began.
 * @param signal - operation cancellation.
 * @returns the error to throw, with `error` as its cause.
 */
function retainedFailure(context: string, error: unknown, signal: AbortSignal): Error {
  const message = `${context} ${error instanceof Error ? error.message : String(error)}`
  if (error instanceof WorktreeError) return new WorktreeError(message, error.code, { cause: error })
  if (error instanceof HarnessError) {
    const wrapped = new HarnessError(message, error.code, { cause: error })
    wrapped.name = error.name
    return wrapped
  }
  const wrapped = new Error(message, { cause: error })
  if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))) wrapped.name = 'AbortError'
  return wrapped
}

/**
 * Build the environment that disables every configured clean, smudge, and
 * process filter of the checkout for one command, without changing Git config.
 * @param run - confined Git runner.
 * @param path - checkout directory.
 * @returns `GIT_CONFIG_*` overrides.
 */
async function filterOverrides(run: GitRun, path: string): Promise<NodeJS.ProcessEnv> {
  const configured = await run(path, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], [0, 1])
  const drivers = new Set<string>()
  for (const key of configured.stdout.split('\0')) {
    const separator = key.lastIndexOf('.')
    if (separator > 'filter.'.length && ['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) {
      drivers.add(key.slice('filter.'.length, separator))
    }
  }
  const overrides: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(drivers.size * 4) }
  let index = 0
  for (const driver of drivers) {
    for (const attribute of ['clean', 'smudge', 'process', 'required']) {
      overrides[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`
      overrides[`GIT_CONFIG_VALUE_${index}`] = attribute === 'required' ? 'false' : ''
      index++
    }
  }
  return overrides
}

export default WorktreeService
