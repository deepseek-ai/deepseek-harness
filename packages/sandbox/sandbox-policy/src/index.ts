/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, the explicit extra writable
 * directories from configuration and live Session registrations, and the override
 * kit (the `sandbox/mode` event, its fold, and its write path; the fold is the
 * `sandboxMode` session-projection unit
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

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { SandboxInvalidRootError } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'

/** Whether a path is usable as an execution-world grant: absolute and free of NUL bytes. */
function isExecutionWorldPath(path: string): boolean {
  return isAbsolute(path) && !path.includes('\0')
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
      throw new Error('sandbox-policy: writable directories must be absolute execution-world paths without NUL bytes')
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
        : ` Additional writable directories: ${JSON.stringify(additional)}. On Windows, these additional grants apply to file tools only, not sandboxed processes.`
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
   * Absolute fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
  /**
   * Extra physical absolute directories that `workspace-write` may also write under
   * (default: none). The supervisor names them explicitly; there is no
   * automatic repository or gitfile discovery. Entries are execution-world
   * paths: this service validates absoluteness and detaches the list, while
   * the enforcing host rejects missing, non-directory, or symlinked paths. They grant nothing under
   * `read-only`. Windows process confinement ignores them; harness file tools honor them.
   */
  additionalWritableRoots?: string[]
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
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
 * default mode, fallback workspace root, session-scoped directory grants, and
 * request-time policy section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
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
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  /** The frozen extra writable directories shared by every resolved policy, or `undefined` for none. */
  readonly additionalWritableRoots: readonly string[] | undefined
  /** Independently owned grants for each live Session; never restored from its log. */
  private readonly writableRootRegistrations = new WeakMap<Session, Map<symbol, string>>()
  private sandboxModeProjectionHandle!: ProjectionHandle<SandboxMode | null>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    // Execution-world spelling is preserved; enforcing providers resolve filesystem identity on their host.
    const workspaceRoot = config.workspaceRoot ?? process.cwd()
    if (!isExecutionWorldPath(workspaceRoot)) {
      throw new Error('sandbox-policy: workspace root must be an absolute execution-world path without NUL bytes')
    }
    this.workspaceRoot = workspaceRoot
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
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session cwd is its workspace-write boundary; the
   * configured root is the fallback for agentless calls and sessions without a
   * cwd. Configured extra roots and this Session's active registrations are
   * snapshotted together; existing operations and processes keep their policy.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode and absolute workspace root.
   * @throws `SandboxInvalidRootError` (`SANDBOX_INVALID_ROOT`) when the session's recorded cwd is
   *   relative or contains a NUL byte.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    const registrations = session === undefined ? undefined : this.writableRootRegistrations.get(session)
    const additionalWritableRoots = registrations === undefined
      ? this.additionalWritableRoots
      : resolveAdditionalWritableRoots([...(this.additionalWritableRoots ?? []), ...registrations.values()])
    return {
      mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
      workspaceRoot: this.sessionWorkspaceRoot(session),
      ...additionalWritableRoots === undefined ? {} : { additionalWritableRoots },
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  /** The session's recorded cwd, or the configured root, as the workspace-write boundary. */
  private sessionWorkspaceRoot(session: Session | undefined): string {
    const cwd = session?.header.cwd
    if (cwd === undefined) return this.workspaceRoot
    if (!isExecutionWorldPath(cwd)) {
      throw new SandboxInvalidRootError(cwd, 'the Session working directory must be an absolute execution-world path without NUL bytes', 'sandbox workspace root')
    }
    return cwd
  }

  /**
   * Permit writes under one directory in this Session's future workspace-write
   * operations. The calling context owns the effect; disposal removes only this
   * registration. Other grants to the directory remain effective. Existing
   * operations and persistent processes retain their resolved permissions.
   * Grants are runtime-only and must be registered again after resume or fork.
   * On Windows, only harness file tools honor extra grants; process permissions stay unchanged.
   * @param session - exact live Session receiving the grant; other Sessions and agentless calls are unaffected.
   * @param directory - absolute execution-world path; execution rejects missing, non-directory, or symlinked paths.
   * @returns the exact Cordis effect disposer for this registration.
   * @throws when the directory is relative or contains a NUL byte.
   */
  registerWritableRoot(session: Session, directory: string): () => void {
    resolveAdditionalWritableRoots([directory])
    const dispose = this.ctx.effect(() => {
      let registrations = this.writableRootRegistrations.get(session)
      if (registrations === undefined) {
        registrations = new Map()
        this.writableRootRegistrations.set(session, registrations)
      }
      const key = Symbol()
      registrations.set(key, directory)
      return () => {
        registrations.delete(key)
        if (registrations.size === 0) this.writableRootRegistrations.delete(session)
      }
    }, 'sandboxPolicy.registerWritableRoot()')
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup preserves the exact Cordis effect disposer
    return dispose
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.sandboxModeProjectionHandle.stateOf(session) ?? undefined
  }
}

export default SandboxPolicyService
