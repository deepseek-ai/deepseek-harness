/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, the explicit extra writable
 * directories, the Git administration directories a linked checkout writes
 * outside that root, and the override kit (the `sandbox/mode` event, its fold,
 * and its write path; the fold is the `sandboxMode` session-projection unit
 * registered here, while the event and write path come from
 * `./session-mode.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { isAbsolute, relative, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'

/** Preserve execution-world spelling; enforcing providers resolve filesystem identity on their host. */
function resolveWorkspaceRoot(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('sandbox-policy: workspace root must be an absolute execution-world path without NUL bytes')
  return path
}

/**
 * Validate and detach the configured extra writable directories. They stay in
 * their execution-world spelling here: a local host must not canonicalize a
 * remote path. The enforcing host validates each physical directory before granting.
 * @param roots - the configured extra roots, or the empty schema default.
 * @returns a frozen copy, or `undefined` when no extra grant exists.
 */
function resolveAdditionalWritableRoots(roots: readonly string[] | undefined): readonly string[] | undefined {
  if (roots === undefined || roots.length === 0) return undefined
  for (const root of roots) {
    if (!isAbsolute(root) || root.includes('\0')) {
      throw new Error('sandbox-policy: additionalWritableRoots entries must be absolute execution-world paths')
    }
  }
  return Object.freeze([...new Set(roots)])
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write': {
      const additional = policy.additionalWritableRoots
      const extra = additional === undefined
        ? ''
        : ` Additional writable directories: ${JSON.stringify(additional)}.`
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}.${extra} Some platform temporary areas may also be writable.`
    }
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

/**
 * Whether `path` is `root` or lies below it. Both are canonical absolute paths of one execution
 * world; the test is lexical and never touches the filesystem.
 */
function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/** The `gitdir:` pointer line of a linked checkout's `.git` file. */
const GITDIR_POINTER = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m

/**
 * Read one short pointer file inside a Git administration directory through the execution-world filesystem.
 * @returns the text, or undefined when the path is not a regular file.
 */
async function pointerText(fs: FileSystem, path: string, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const entry = await fs.lstat(path, { cwd }, signal)
  if (entry?.type !== 'file') return undefined
  return fs.readText(await fs.resolve(path, { cwd, signal }), signal)
}

/** Resolve a pointer target to a canonical directory, or undefined when it is not an existing directory. */
async function pointerDirectory(fs: FileSystem, path: string, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const target = await fs.resolve(path, { cwd, signal })
  const info = await fs.stat(target, signal)
  return info?.type === 'directory' ? fs.processPath(target) : undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** File-sandbox mode a session starts from (default: `read-only`). */
  mode?: SandboxMode
  /**
   * Absolute fallback root for agentless calls and sessions without a recorded
   * directory (default: `process.cwd()`). Normal agent calls use their
   * session's workspace root instead.
   */
  workspaceRoot?: string
  /**
   * Extra physical absolute directories that `workspace-write` may also write under
   * (default: none). The supervisor names them explicitly; the Git
   * administration directories of a linked checkout are derived separately
   * and need no entry here. Entries are execution-world paths: this service
   * validates absoluteness and detaches the list, while the enforcing host
   * rejects missing, non-directory, or symlinked paths. They grant nothing under
   * `read-only`.
   */
  additionalWritableRoots?: string[]
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its workspace root becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/** The sandbox-mode projection's state schema (state equals the public shape). */
const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and workspace root travel together to every enforcing capability.
 *
 * A session's workspace root comes from the working-directory service when
 * it is mounted: the checkout the Session works in, which a worktree
 * relocation moves. A linked checkout keeps its Git administration directory
 * and the repository's common directory outside that root; {@link prepare}
 * derives them through the execution-world filesystem once per root, and
 * `resolve` adds the derived directories to `additionalWritableRoots`. Tool
 * executions await that derivation in `tools/pre-execute`; Session creation and
 * every directory change start it early.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
    additionalWritableRoots: z.array(z.string()).default([]),
  })

  static inject = ['sessionProjections']

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute `workspace-write` fallback root for calls without a session root. */
  readonly workspaceRoot: string
  /** The frozen extra writable directories shared by every resolved policy, or `undefined` for none. */
  readonly additionalWritableRoots: readonly string[] | undefined
  private sandboxModeProjectionHandle!: ProjectionHandle<SandboxMode | null>
  /** Derived Git administration directories by workspace root; present only once the root's `.git` entry was read. */
  private readonly gitAdministration = new Map<string, readonly string[]>()
  /** Derivations in flight by workspace root. */
  private readonly derivations = new Map<string, Promise<readonly string[]>>()
  private readonly lifecycle = new AbortController()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
    this.additionalWritableRoots = resolveAdditionalWritableRoots(config.additionalWritableRoots)
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    this.sandboxModeProjectionHandle = await ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
    ctx.on('session/created', (session) => { this.prewarm(session) })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'working-directory/change') this.prewarm(session)
    })
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent !== undefined) await this.prepare(exec.agent.session, exec.signal)
      return next()
    })
    ctx.effect(() => async () => {
      this.lifecycle.abort(new Error('sandbox-policy service disposed'))
      await Promise.allSettled(this.derivations.values())
    })
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session's workspace root is its workspace-write
   * boundary, and the Git administration directories {@link prepare} derived
   * for that root join the configured extra writable directories; the
   * configured root is the fallback for agentless calls and sessions without a
   * recorded directory.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode, absolute workspace root, and extra writable directories.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    const workspaceRoot = resolveWorkspaceRoot(this.rootOf(session))
    const additional = this.additionalRootsWith(session === undefined ? undefined : this.gitAdministration.get(workspaceRoot))
    return {
      mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
      workspaceRoot,
      ...additional === undefined ? {} : { additionalWritableRoots: additional },
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.sandboxModeProjectionHandle.stateOf(session) ?? undefined
  }

  /**
   * Derive the Git administration directories of the session's workspace root
   * so the next {@link resolve} grants them: a linked checkout's `.git` file
   * names its administration directory, whose `commondir` names the
   * repository's common directory. Directories inside the root, missing
   * directories, and a root without a `.git` entry add nothing. One derivation
   * runs per root; its result is kept once the root's `.git` entry was read,
   * and a failed read is logged and retried on the next call.
   * @param session - session whose workspace root is inspected.
   * @param signal - caller cancellation, checked before and after the shared derivation.
   * @returns the derived directories outside the root, canonical in the execution world.
   */
  async prepare(session: Session, signal?: AbortSignal): Promise<readonly string[]> {
    signal?.throwIfAborted()
    const root = this.rootOf(session)
    const settled = this.gitAdministration.get(root)
    if (settled !== undefined) return settled
    let derivation = this.derivations.get(root)
    if (derivation === undefined) {
      derivation = this.derive(root).finally(() => { this.derivations.delete(root) })
      this.derivations.set(root, derivation)
    }
    const derived = await derivation
    signal?.throwIfAborted()
    return derived
  }

  private prewarm(session: Session): void {
    // Failures are logged inside the derivation; disposal rejects the pending wait.
    void this.prepare(session).catch(() => undefined)
  }

  private async derive(root: string): Promise<readonly string[]> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return []
    const signal = this.lifecycle.signal
    try {
      const pointer = await fs.lstat('.git', { cwd: root }, signal)
      if (pointer === undefined) return []
      const outside: string[] = []
      if (pointer.type === 'file') {
        const text = await fs.readText(await fs.resolve('.git', { cwd: root, signal }), signal)
        const target = GITDIR_POINTER.exec(text)?.[1]
        const gitDirectory = target === undefined ? undefined : await pointerDirectory(fs, target, root, signal)
        if (gitDirectory !== undefined) {
          outside.push(gitDirectory)
          const common = (await pointerText(fs, 'commondir', gitDirectory, signal))?.trim()
          const commonDirectory = common === undefined || common.length === 0
            ? undefined
            : await pointerDirectory(fs, common, gitDirectory, signal)
          if (commonDirectory !== undefined) outside.push(commonDirectory)
        }
      }
      signal.throwIfAborted()
      // Distinct directories outside the root, keeping only those no other candidate already contains.
      const candidates = [...new Set(outside)].filter(directory => !within(root, directory))
      const derived = Object.freeze(candidates.filter(directory =>
        !candidates.some(other => other !== directory && within(other, directory))))
      this.gitAdministration.set(root, derived)
      return derived
    } catch (error) {
      if (signal.aborted) throw error
      this.ctx.logger.warn(`sandbox-policy: could not derive the Git administration directories of ${JSON.stringify(root)}: ${String(error)}`)
      return []
    }
  }

  /**
   * The session's workspace root: the root the working-directory service recorded, else the header directory,
   * else the deployment fallback.
   */
  private rootOf(session: Session | undefined): string {
    if (session === undefined) return this.workspaceRoot
    return this.ctx.get('workingDirectory')?.recordedRootOf(session) ?? session.header.cwd ?? this.workspaceRoot
  }

  private additionalRootsWith(derived: readonly string[] | undefined): readonly string[] | undefined {
    if (derived === undefined || derived.length === 0) return this.additionalWritableRoots
    return Object.freeze([...new Set([...this.additionalWritableRoots ?? [], ...derived])])
  }
}

export default SandboxPolicyService
