/**
 * The host's real enforcement wiring for one forked child.
 *
 * Three parts must land before a child counts as enforced: a producer on the child's own scoped
 * runtime that resolves each execution's paths through the host's filesystem and records the verdict
 * for that exact execution, the monotonic guard that refuses whatever the verdict did not confirm,
 * and the fork-scoped replacements that check a resolved target against the granted root and delegate
 * with that target's canonical path.
 *
 * The child's authorized root is the workspace its own session was granted, never the owner's
 * deployment default. Containment is checked on the resolved path before the deployment's tool or the
 * backend opens it again by path, so a symlink swapped in between can redirect the operation; the
 * write still passes the backend's own sandbox policy. Kernel-grade isolation of untrusted code remains
 * `ctx.shell`'s job.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsTarget,
  FsVersion,
  FsWriteOutcome,
  FsWriteIntent,
} from '@deepseek-ai/dsh-fs'
import type { PreToolDecision, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { forkToolGuard, installChildEnforcement, type ForkToolExecution } from './fork-tool-guard.ts'
import { READ_ONLY_FORK_CEILING, WRITE_FORK_CEILING } from './fork-policy.ts'
import type { ForkRegistry } from './fork-registry.ts'
import {
  SHARED_TOOL_PROFILES,
  sharedEditArguments,
  withDefaultSearchRoot,
  type SharedToolProfile,
} from './shared-tools.ts'
import { isRecord } from './wire-json.ts'

/** Name of the read tool whose fork-scoped replacement this host installs. */
const FORK_READ_TOOL = 'read'

/** Name of the write tool whose fork-scoped replacement this host installs for a write-capable scope. */
const FORK_WRITE_TOOL = 'write'

/** Name of the edit tool whose fork-scoped replacement this host installs for a write-capable scope. */
const FORK_EDIT_TOOL = 'edit'

/** Why a source Session carries no usable confined layer. */
export type SourceSessionAccessRefusal =
  /** The deployment exposes no tool definition to replace. */
  | 'tool-unavailable'
  /** The replacement could not be registered in the Session's scope. */
  | 'register-refused'

/** A confined tool whose registration a scope refused, with the error that scope raised. */
export interface ForkToolRegistrationFailure {
  /** Name of the tool whose confined replacement could not register. */
  readonly tool: string
  /** Error the scope raised, preserved so the caller's own refusal can state it. */
  readonly error: unknown
}

/** What installing the source-session access layer achieved. */
export interface SourceSessionAccessInstallation {
  /** Release the guard, and every replacement this installation registered. */
  dispose(): void
  /**
   * Whether this installation confines the Session's view surface inside the granted workspace.
   *
   * The read replacement is the anchor: its absence means nothing usable was installed, a viewer-started
   * turn is refused every tool while this layer is mounted, and a caller must not report the share as
   * drivable or drive the prompt. Read-only tools the deployment does not ship stay unavailable without
   * clearing this flag.
   */
  readonly readConfined: boolean
  /** Whether this installation can enforce a bounded write through the backend. */
  readonly writeConfined: boolean
  /** Why the layer is unusable, set only when {@link readConfined} is false. */
  readonly refusal?: SourceSessionAccessRefusal
  /**
   * The confined replacement a scope refused, when one registration failed.
   *
   * Fail-closed installation returns a narrower layer instead of throwing; this keeps the error the scope
   * raised so the host can report it rather than losing the reason.
   */
  readonly registrationFailure?: ForkToolRegistrationFailure
}

/** The Session whose access this is, and everything the wrapper needs to judge one execution. */
export interface SourceSessionAccess {
  /** Session whose tool executions are constrained, for messages and audit. */
  readonly sessionId: string
  /** That Session's own scope, which the replacements are registered into. */
  readonly context: Context
  readonly scope: object
  /** Workspace this Session's tool executions may read and write inside. */
  readonly grantedRoot: FsTarget
  readonly cwd: string
  /** Resolve this Session's complete current policy after write-intent listeners settle. */
  readonly resolvePolicy: () => SandboxExecutionPolicy
  readonly fs: ForkEnforcementFs
  readonly tools: ForkToolRegistry
  readonly describe: (execution: ForkToolExecution) => ForkToolPaths
  /**
   * Present when this installation registers the bounded write, absent when the Session is read-only.
   *
   * A Session shared only at the view tier installs no write replacement, so the guard refuses the name.
   * A Session some share may write installs one, and the field beside it answers whether writing is still
   * allowed: the tier of the Session's shares can narrow while the layer stays mounted.
   */
  readonly write?: {
    /** Whether the Session's current shares still allow writing it. */
    readonly mayWrite: () => boolean
  }
  /** Refresh the Session's Relay grants before an operation that consumes its filesystem capability. */
  readonly refreshAuthorization?: () => Promise<void>
  /**
   * Whether one execution belongs to a turn whose entering input named a share viewer.
   *
   * The layer belongs to the Session, but it confines only the turns a viewer started: a turn the owner
   * started keeps the deployment's own tools, including its own path resolution, so the answer is read
   * for every execution while the layer stays mounted. Absent means every execution is confined, which
   * keeps a host that cannot attribute turns from widening one.
   */
  readonly confinedExecution?: (execution: ForkToolExecution) => boolean
}

/**
 * Confine every viewer-started turn of one shared Session to its granted workspace.
 *
 * The replacements are registered in the Session's scope, and while a viewer-started turn runs, the guard
 * on that scope permits nothing else: that turn reads through the confined replacements, and where the
 * Session's shares allow writing it writes through the bounded ones. The owner's own turns ask the same
 * guard but keep the deployment's tools, so the share never narrows the work the owner started. Every
 * path a permitted viewer turn declares is resolved and checked against the granted root before the
 * deployment's body receives its canonical form, and each call re-reads the shares' current Relay grants,
 * so a share that narrows or ends stops its own writes without the layer being reinstalled. A tool the
 * shared surface does not name, or one whose replacement could not register, is refused to that turn.
 * Stopping the layer is what restores the Session's own tools, which the host does when no share remains.
 * @param target - The Session, its granted workspace, and the authority that answers per operation.
 * @returns The installation: its disposer, and whether reads and writes can actually be confined here.
 */
export function installSourceSessionAccess(target: SourceSessionAccess): SourceSessionAccessInstallation {
  const { context, fs } = target
  const confined = target.confinedExecution ?? (() => true)
  const disposers: (() => void)[] = []
  /**
   * Names this installation registered, which its guard vouches for.
   *
   * A name the deployment registers is not evidence that the constrained definition is the one that would
   * run, so the guard permits only what this installation put in the Session's scope itself.
   */
  const installed = new Set<string>()
  /**
   * Deployment definitions this installation vouches for without replacing them.
   *
   * A tool with no local file effect needs no replacement, and replacing it would change a definition
   * other plugins recognize by identity — the skill catalog publishes only while its own `skill`
   * definition is the visible one. The guard therefore accepts the definition visible when the layer was
   * installed, and refuses the name once a different definition answers to it.
   */
  const passthrough = new Map<string, ToolDefinition>()
  let refusal: SourceSessionAccessRefusal | undefined
  let registrationFailure: ForkToolRegistrationFailure | undefined

  /** The definition this Session would run without this layer, wherever the deployment registered it. */
  const deploymentOf = (name: string): ToolDefinition | undefined =>
    context.tools.get(name, target.scope) ?? target.tools.get(name)

  // Without the deployment's read the layer has no anchor: the guard below permits a viewer-started turn
  // nothing it did not register, so that turn is refused rather than served by the owner's own tools.
  if (deploymentOf(FORK_READ_TOOL) === undefined) refusal = 'tool-unavailable'

  /**
   * Resolve one call's path and refuse it unless the granted root contains the result.
   * @param path - Path the call names.
   * @param operation - Operation the refusal names.
   * @param signal - Cancellation of the call being served.
   * @returns The canonical path a subprocess in this filesystem's world opens for that target.
   */
  const resolveGranted = async (
    path: string,
    operation: 'read' | 'write',
    signal: AbortSignal,
  ): Promise<string> => {
    const candidate = await fs.resolve(path, { cwd: target.cwd, signal })
    assertGranted(fs, target.grantedRoot, candidate, operation)
    return fs.processPath(candidate)
  }

  /**
   * Register one confined replacement and record the name this installation now vouches for.
   * @param name - Tool name the guard keys on.
   * @param deployment - The definition being replaced.
   * @param execute - Body that checks this call's paths and delegates with their canonical form.
   * @returns Whether the replacement registered.
   */
  const register = (name: string, deployment: ToolDefinition, execute: ToolDefinition['execute']): boolean => {
    try {
      disposers.push(context.tools.register({ ...deployment, execute }))
      installed.add(name)
      return true
    } catch (error: unknown) {
      // The guard is still installed: a name this host could not register is refused rather than served
      // by the deployment's own definition.
      registrationFailure ??= { tool: name, error }
      if (name === FORK_READ_TOOL) refusal = 'register-refused'
      return false
    }
  }

  /**
   * Install the confined replacement for one admitted tool.
   *
   * Every path the tool's own arguments declare is resolved and checked before the deployment's body
   * sees it, and that body is handed the canonical form so it opens exactly what was checked. A call
   * whose declared paths cannot be read is refused rather than delegated unchecked arguments.
   * @param profile - The tool's shared-surface entry.
   */
  const installShared = (profile: SharedToolProfile): void => {
    const deployment = deploymentOf(profile.name)
    // Nothing to replace: the guard below permits only registered names, so the tool stays refused.
    if (deployment === undefined) return
    if (profile.noFileEffect) {
      passthrough.set(profile.name, deployment)
      return
    }
    register(profile.name, deployment, async (args, exec) => {
      // An owner-started turn keeps the deployment's own tool, including its own path resolution: this
      // layer only bounds what a viewer's turn runs.
      if (!confined(exec)) return await deployment.execute(args, exec)
      await target.refreshAuthorization?.()
      const input = isRecord(args) ? args : {}
      const call = profile.call(input)
      if (call === undefined) {
        throw new Error(`a shared session may only use ${profile.name} with the paths it declares`)
      }
      // A pathless search reads the workspace default, so its replacement supplies the working directory
      // as the root it checks and hands to the tool.
      const named = call.paths.length === 0 && profile.defaultsToWorkspace ? [target.cwd] : call.paths
      const canonical: string[] = []
      for (const path of named) {
        canonical.push(await resolveGranted(path, 'read', exec.signal))
      }
      return await deployment.execute(call.rewrite(canonical), exec)
    })
  }

  for (const profile of SHARED_TOOL_PROFILES) {
    if (profile.tier === 'view') installShared(profile)
  }

  const writeGate = target.write
  const deploymentWrite = writeGate === undefined ? undefined : deploymentOf(FORK_WRITE_TOOL)
  if (deploymentWrite !== undefined && writeGate !== undefined) {
    const gate = writeGate
    register(FORK_WRITE_TOOL, deploymentWrite, async (args, exec) => {
      if (!confined(exec)) return await deploymentWrite.execute(args, exec)
      await target.refreshAuthorization?.()
      // The Session's current shares decide, not the tier the layer was installed for: a share can
      // narrow to view while this layer stays mounted.
      if (!gate.mayWrite()) throw new Error('this share does not allow writing this Session')
      const input = isRecord(args) ? args : {}
      const requested = input.file_path
      const content = input.content
      if (typeof requested !== 'string' || requested === '' || typeof content !== 'string') {
        throw new Error('a shared session may only write a named file with text content')
      }
      const candidate = await fs.resolve(requested, { cwd: target.cwd, signal: exec.signal })
      assertGranted(fs, target.grantedRoot, candidate, 'write')
      // The intent comes from the same waterfall the shipped write uses, so a deployment's observation
      // policy — a read-before-write rule, a stale-version rule — keeps deciding here too. This path
      // never substitutes a version it just read for the one the caller observed.
      const intent = await context.waterfall('fs/write-intent', candidate, exec, () => undefined)
      await target.refreshAuthorization?.()
      const policy = target.resolvePolicy()
      // The shares can narrow while the intent awaited: the final refresh above reads the new state, so
      // ask the gate again before anything is written instead of trusting the earlier verdict.
      if (!gate.mayWrite()) throw new Error('this share does not allow writing this Session')
      const outcome = await fs.writeText(candidate, content, intent, exec.signal, policy)
      // The published version is this caller's own next basis, exactly as the shipped write records it:
      // without it a second write of the same file would meet a policy that saw nothing since the read.
      context.emit('fs/observed', candidate, { kind: 'present', version: outcome.version }, exec)
      return {
        path: requested,
        operation: outcome.operation,
        before: outcome.before ?? null,
        after: outcome.after,
      }
    })
  }

  const deploymentEdit = writeGate === undefined ? undefined : deploymentOf(FORK_EDIT_TOOL)
  if (deploymentEdit !== undefined && writeGate !== undefined) {
    const gate = writeGate
    register(FORK_EDIT_TOOL, deploymentEdit, async (args, exec) => {
      if (!confined(exec)) return await deploymentEdit.execute(args, exec)
      await target.refreshAuthorization?.()
      if (!gate.mayWrite()) throw new Error('this share does not allow writing this Session')
      const edit = sharedEditArguments(args)
      if (edit === undefined) {
        throw new Error('a shared session may only edit a named file by replacing non-empty text')
      }
      const candidate = await fs.resolve(edit.filePath, { cwd: target.cwd, signal: exec.signal })
      assertGranted(fs, target.grantedRoot, candidate, 'write')
      // The edit intent comes from the same waterfall the shipped edit uses, so the deployment's
      // read-before-write rule keeps deciding here too.
      const intent = await context.waterfall('fs/edit-intent', candidate, exec, () => undefined)
      await target.refreshAuthorization?.()
      const policy = target.resolvePolicy()
      if (!gate.mayWrite()) throw new Error('this share does not allow writing this Session')
      const outcome = await fs.editText(
        candidate,
        { oldString: edit.oldString, newString: edit.newString, replaceAll: edit.replaceAll },
        intent,
        exec.signal,
        policy,
      )
      context.emit('fs/observed', candidate, { kind: 'present', version: outcome.version }, exec)
      return { path: fs.processPath(candidate), before: outcome.before, after: outcome.after }
    })
  }

  // This layer speaks for viewer-started turns only: the owner's own turns keep every deployment tool.
  // A viewer-started turn may run nothing but this installation's replacements, because the sandbox
  // belongs to the turn the viewer drives.
  const guard = context.tools.guard((execution) => {
    if (!confined(execution)) return undefined
    if (installed.has(execution.name)) return undefined
    // A no-effect tool keeps the deployment's own definition, which this installation vouches for by
    // identity. A name answering to a different definition — a scope-registered shadow — is refused.
    const deployment = passthrough.get(execution.name)
    if (deployment !== undefined && deploymentOf(execution.name) === deployment) return undefined
    return `a shared session may not use ${execution.name}`
  })
  disposers.push(guard)
  return {
    dispose: () => {
      for (const dispose of [...disposers].reverse()) dispose()
    },
    readConfined: installed.has(FORK_READ_TOOL),
    writeConfined: installed.has(FORK_WRITE_TOOL),
    ...(installed.has(FORK_READ_TOOL) || refusal === undefined ? {} : { refusal }),
    ...(registrationFailure === undefined ? {} : { registrationFailure }),
  }
}

/**
 * Live agent the registry publishes: the agent loop's own handle carries the scope it registered
 * into and the session whose workspace it was granted.
 */
interface LiveAgent extends Agent {
  readonly ctx: Context
  readonly session: Session
}

/** Path resolution and text writes as the filesystem capability exposes them. */
export interface ForkEnforcementFs {
  readonly resolve: (
    path: string,
    options?: { readonly cwd?: string; readonly signal?: AbortSignal },
  ) => Promise<FsTarget>
  readonly contains: (parent: FsTarget, child: FsTarget) => boolean
  /**
   * The canonical path a subprocess in this filesystem's world opens for a target.
   *
   * Delegating with this value hands the deployment's tool the path this host just checked instead of
   * the model's own spelling.
   */
  readonly processPath: (target: FsTarget) => string
  /**
   * Write text to one resolved target under the Session's complete policy.
   *
   * `expected` carries the caller's intent — a version to replace, or a requirement that the file is
   * absent — so the deployment's guarded-write semantics hold. `sandboxPolicy` is resolved after the
   * Session's write-intent listeners settle; a sandboxing backend fences the write by it.
   */
  readonly writeText: (
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ) => Promise<FsWriteOutcome>
  /**
   * Edit one resolved target literally under the Session's complete policy.
   *
   * `expected` carries the caller's edit intent — the version the caller observed — so the deployment's
   * guarded-edit semantics hold. `sandboxPolicy` is resolved after the Session's edit-intent listeners
   * settle; a sandboxing backend fences the edit by it.
   */
  readonly editText: (
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { readonly version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ) => Promise<FsEditOutcome>
}

/** A refusal of a target outside the granted workspace; callers identify it by `code` alone. */
type GrantedRootRefusal = Error & { readonly code: 'FS_SANDBOX_DENIED' }

/**
 * Build the refusal of a target outside the granted workspace.
 * @param message - What was refused and why.
 * @returns An `Error` carrying the `FS_SANDBOX_DENIED` code.
 */
function grantedRootRefusal(message: string): GrantedRootRefusal {
  return Object.assign(new Error(message), { code: 'FS_SANDBOX_DENIED' as const })
}

/**
 * Refuse a resolved target that the granted root does not contain.
 * @param fs - Filesystem whose containment rule decides.
 * @param root - The granted workspace root.
 * @param candidate - The resolved target one call names.
 * @param operation - The operation named in the refusal.
 * @throws GrantedRootRefusal when the granted root does not contain `candidate`.
 */
function assertGranted(fs: ForkEnforcementFs, root: FsTarget, candidate: FsTarget, operation: 'read' | 'write'): void {
  if (fs.contains(root, candidate)) return
  throw grantedRootRefusal(
    `cannot ${operation} "${candidate.displayPath}": it is not inside the workspace this session was granted`,
  )
}

/** The tool registry's definition lookup, as the tool runtime exposes it. */
export interface ForkToolRegistry {
  readonly get: (name: string, scope?: object) => ToolDefinition | undefined
}

/** Agent registry view: the child's live handle carries the scope and session it was composed with. */
interface AgentLookup {
  readonly get: (id: string) => LiveAgent | undefined
}

/** Sandbox policy view, which resolves the workspace a session was granted. */
interface WorkspacePolicy {
  readonly resolve: (request: { readonly session?: Session }) => SandboxExecutionPolicy
}

/** Paths one tool's own arguments name, or undefined when they cannot be established. */
export interface ForkToolPaths {
  readonly paths: readonly string[] | undefined
  readonly noFileEffect: boolean
}

/** Everything one child's limit is installed from, once the host has resolved its own services. */
export interface ForkEnforcementTarget {
  readonly childSessionId: string
  /** The child's own scoped context, which the guard and the verdict producer register into. */
  readonly childContext: Context
  /**
   * The child's own scope key.
   *
   * A guard registered from an unscoped context would apply to every agent in the process, so the
   * host derives this from the child's context and refuses to install without one.
   */
  readonly childScope: object
  /**
   * Canonical root of the workspace this child was granted, resolved once when the limit was
   * installed.
   *
   * Resolving it again per read would re-derive the grant from a path that may point elsewhere by
   * then, so the limit carries the root it was installed with.
   */
  readonly grantedRoot: FsTarget
  /** Working directory the child's relative paths resolve against. */
  readonly cwd: string
  /** Resolve this Session's complete current policy after write-intent listeners settle. */
  readonly resolvePolicy: () => SandboxExecutionPolicy
  readonly fs: ForkEnforcementFs
  /** The deployment's own tool registry, which decides whether a name is trusted. */
  readonly tools: ForkToolRegistry
  readonly forks: ForkRegistry
  readonly describe: (execution: ForkToolExecution) => ForkToolPaths
  /** Whether this scope may also write, through a `write` tool this host installs itself. */
  readonly write?: boolean
  /** Re-check the share's current grant immediately before each tool execution. */
  readonly authorized?: (tool: string) => boolean
  /** Refresh the child's current Relay grant before consuming its filesystem capability. */
  readonly refreshAuthorized?: () => Promise<void>
}

/** Host services and arguments one host-side installation reads. */
export interface ForkEnforcementHost {
  readonly forks: ForkRegistry
  readonly describe: (execution: ForkToolExecution) => ForkToolPaths
  /**
   * Whether the share this child serves may write, which puts this host's bounded write in the child's
   * scope.
   *
   * Read from the owner's published share rather than from configuration: a child must never install a
   * wider ceiling than the share its viewer was admitted to, and absent means reading only.
   */
  readonly write?: boolean
  /** Re-check the share's current grant immediately before each tool execution. */
  readonly authorized?: (tool: string) => boolean
  /** Refresh the child's current Relay grant before consuming its filesystem capability. */
  readonly refreshAuthorized?: () => Promise<void>
}

/**
 * What one installation could not do, for a caller that states the refusal itself.
 *
 * Installation stays fail-closed: a replacement that cannot register returns undefined rather than
 * throwing, so a child is never published under a ceiling this host did not install. The error the scope
 * raised is kept here because the caller's own refusal is the only place it can be reported.
 */
export interface ForkEnforcementFailure {
  /** The confined tool whose registration the child's scope refused. */
  registration?: ForkToolRegistrationFailure
}

/**
 * Read one service, or undefined when this deployment does not provide it.
 * @param ctx Host context to read from.
 * @param name Service name.
 * @returns The service as an untyped handle, or undefined.
 */
function serviceOf(ctx: Context, name: string): unknown {
  // `get` reports absence; the typed `ctx.<service>` accessor would treat a profile without
  // the capability as a programming error instead.
  return ctx.get(name)
}

/**
 * Read one caught value's message for a refusal this host reports.
 * @param error - Value a dependency threw.
 * @returns The error's message, or the value's own string form.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Optional Session observation the child preflight reads; absent leaves the child to activation. */
interface SessionObservationLookup {
  readonly observeSession?: (sessionId: string) => Promise<{ readonly header: { readonly cwd?: string } } & Disposable>
}

/**
 * Prove one recorded child's limit can be installed before its agent is published.
 *
 * A resumed child is announced through `agent/created` before its limit installs, so an installability
 * failure would leave a created Session whose guard never landed. Reading the stored header and resolving
 * the workspace it names happens before activation, so the child is never announced when the limit cannot
 * land. A Session whose header cannot be read fails here as well: this host cannot prove the limit
 * installs, and the caller refuses the child instead of activating one it could not confine. A
 * composition without a session query leaves the child to activation, because there is no header to read.
 * @param ctx - Host context carrying the session query and filesystem.
 * @param childSessionId - Recorded fork child to preflight.
 * @returns Nothing when the child's granted workspace resolves.
 * @throws when the child's Session cannot be read, states no workspace, or its workspace cannot be
 *   resolved.
 */
export async function preflightForkChild(ctx: Context, childSessionId: string): Promise<void> {
  const query = ctx.get('sessionQuery') as SessionObservationLookup | undefined
  const fs = serviceOf(ctx, 'fs') as ForkEnforcementFs | undefined
  if (query?.observeSession === undefined || fs === undefined) return
  let cwd: string | undefined
  try {
    using observed = await query.observeSession(childSessionId)
    cwd = observed.header.cwd
  } catch (error: unknown) {
    throw new Error(`fork ${childSessionId} preflight failed: ${messageOf(error)}`, { cause: error })
  }
  if (cwd === undefined) {
    throw new Error(`fork ${childSessionId} has no workspace to confine`)
  }
  try {
    await fs.resolve(cwd)
  } catch (error: unknown) {
    throw new Error(`fork ${childSessionId} cannot be confined: its workspace does not resolve`, { cause: error })
  }
}

/**
 * Install one child's limit against the host's own services.
 *
 * Every dependency is checked before anything registers: the record this writes is what opens the
 * child's prompt gate, so a host missing its agent registry, filesystem, sandbox policy, or live child
 * must leave that child refused rather than report a limit nothing applies.
 * @param ctx Host context that provides the agent registry, filesystem, sandbox policy, and tools.
 * @param childSessionId Child that was just forked.
 * @param host The host's fork registry and argument reader.
 * @param failure Receives the error a refused registration raised, so the caller can state it.
 * @returns The disposer that releases this child's limit, or undefined when nothing was installed.
 */
export async function installHostForkEnforcement(
  ctx: Context,
  childSessionId: string,
  host: ForkEnforcementHost,
  failure: ForkEnforcementFailure = {},
): Promise<(() => void) | undefined> {
  const agents = serviceOf(ctx, 'agents') as AgentLookup | undefined
  if (agents === undefined) return undefined
  const live = agents.get(childSessionId)
  if (live === undefined) return undefined
  // The installer's live child carries its own scope and session, so this entry installs exactly what the
  // prepublish entry would have installed for the same child.
  return await installForkEnforcementForAgent(ctx, childSessionId, live.ctx, live.session, host, failure)
}

/**
 * Install one child's limit from the scope the factory hands its setup.
 *
 * A resumed agent is unpublished while its setup runs, so the registry cannot find it yet: the caller
 * passes that setup's own context and session instead of publishing first to make a lookup succeed.
 * @param ctx Host context that provides the filesystem, sandbox policy, and tools.
 * @param childSessionId Child this scope belongs to.
 * @param childContext The unpublished child's own scope.
 * @param session The child's session, whose granted workspace the limit is confined to.
 * @param host The host's fork registry and argument reader.
 * @param failure Receives the error a refused registration raised, so the caller can state it.
 * @returns The disposer that releases this child's limit, or undefined when nothing was installed.
 */
export async function installForkEnforcementForAgent(
  ctx: Context,
  childSessionId: string,
  childContext: Context,
  session: Session,
  host: ForkEnforcementHost,
  failure: ForkEnforcementFailure = {},
): Promise<(() => void) | undefined> {
  return await installForThisAgent(ctx, childSessionId, childContext, session, host, failure)
}

/** The installation itself. */
async function installForThisAgent(
  ctx: Context,
  childSessionId: string,
  childContext: Context,
  session: Session,
  host: ForkEnforcementHost,
  failure: ForkEnforcementFailure,
): Promise<(() => void) | undefined> {
  const fs = serviceOf(ctx, 'fs') as ForkEnforcementFs | undefined
  const sandboxPolicy = serviceOf(ctx, 'sandboxPolicy') as WorkspacePolicy | undefined
  const tools = serviceOf(ctx, 'tools') as ForkToolRegistry | undefined
  if (fs === undefined || sandboxPolicy === undefined || tools === undefined) return undefined
  const childScope = scopeOf(childContext)
  // A child context without a scope would take the guard globally and limit the owner's own tool use
  // too, so its absence is a refusal rather than a reason to register anyway.
  if (childScope === undefined) return undefined
  const cwd = session.header.cwd
  // Without the child's own working directory a relative path could not be resolved against the
  // granted root, and a limit that cannot resolve paths does not exist.
  if (cwd === undefined) return undefined
  const dispose = installForkEnforcement({
    childSessionId,
    childContext,
    childScope,
    // The granted root is the child's own session workspace, resolved by the deployment's policy: the
    // owner's fallback root is what a session without a cwd would get, not what was shared.
    grantedRoot: await fs.resolve(sandboxPolicy.resolve({ session }).workspaceRoot),
    resolvePolicy: () => sandboxPolicy.resolve({ session }),
    cwd,
    fs,
    tools,
    forks: host.forks,
    describe: host.describe,
    // The share's own answer, forwarded rather than re-derived: the child's ceiling is what the owner
    // published for the share whose viewer asked for this fork.
    ...(host.write === true ? { write: true } : {}),
    ...(host.authorized === undefined ? {} : { authorized: host.authorized }),
    ...(host.refreshAuthorized === undefined ? {} : { refreshAuthorized: host.refreshAuthorized }),
  }, failure)
  // An installation that returned nothing leaves the child's prompt gate refused; the caller says so.
  if (dispose === undefined) return undefined
  return dispose
}

/**
 * Install one child's limit and register the parts that make it real.
 * @param target The child's own context and every resolved capability the limit needs.
 * @param failure Receives the error a refused registration raised, for the caller's refusal.
 * @returns The disposer that releases the limit, or undefined when nothing was installed.
 */
export function installForkEnforcement(
  target: ForkEnforcementTarget,
  failure: ForkEnforcementFailure = {},
): (() => void) | undefined {
  const { childContext, childScope, fs, forks } = target
  const requireAuthorized = (tool: string): void => {
    if (!forks.enforcementInstalled(target.childSessionId) || target.authorized?.(tool) === false) {
      throw new Error('this fork no longer holds permission for this tool')
    }
  }
  /**
   * Names this host installed into the child's scope, which its guard vouches for.
   *
   * A name is not evidence that the constrained definition is the one that would run: the guard permits
   * only what this installation registered, so a definition that failed to register stays refused.
   */
  const vouchedNames = new Set<string>()
  /**
   * Deployment definitions this installation vouches for without replacing them.
   *
   * A tool with no local file effect needs no replacement, and replacing it would change a definition
   * other plugins recognize by identity — the skill catalog publishes only while its own `skill`
   * definition is the visible one. The guard accepts the definition visible when the limit was installed,
   * and refuses the name once a different definition answers to it.
   */
  const passthrough = new Map<string, ToolDefinition>()
  /** Releases every replacement registered so far; used to unwind an installation that cannot finish. */
  const installedDisposers: (() => void)[] = []
  /**
   * The definition the child would run if this host installed nothing.
   *
   * A deployment registers its filesystem tools wherever its composition puts them — process-global on
   * a bare deployment, or in a preset/ancestor scope on a product profile — so the child's own view is
   * what the confined replacement must shadow. The child's scope cannot already hold this name: a
   * child-local registration of it would have been a different tool, and this host would refuse.
   */
  const deploymentOf = (name: string): ToolDefinition | undefined =>
    childContext.tools.get(name, childScope) ?? target.tools.get(name)
  /**
   * Register one confined replacement and record the name this installation now vouches for.
   * @param name - Tool name the guard keys on.
   * @param deployment - The definition being replaced.
   * @param execute - Body that checks this call's paths and delegates with their canonical form.
   * @returns A release for the replacement, or undefined when it could not register.
   */
  const register = (
    name: string,
    deployment: ToolDefinition,
    execute: ToolDefinition['execute'],
  ): (() => void) | undefined => {
    try {
      const dispose = childContext.tools.register({ ...deployment, execute })
      vouchedNames.add(name)
      const release = (): void => {
        vouchedNames.delete(name)
        dispose()
      }
      installedDisposers.push(release)
      return release
    } catch (error: unknown) {
      // The child's scope already registers this name, or the runtime refused the registration. This
      // host cannot confine the name then, and vouching for a definition that never registered would
      // hand the child the deployment's unconfined tool under a trusted name.
      failure.registration ??= { tool: name, error }
      return undefined
    }
  }
  /**
   * Register one admitted read-surface tool's confined replacement.
   *
   * Registering it here rather than checking the model's path later makes the call authorized against
   * the granted root by the code that delegates it, with the canonical path that check approved.
   * @param profile - The tool's shared-surface entry.
   * @returns A release for the replacement, or undefined when the deployment has no such tool or the
   *   scope refused it.
   */
  const confineShared = (profile: SharedToolProfile): (() => void) | undefined => {
    const deployment = deploymentOf(profile.name)
    // Nothing to replace: the guard permits only registered names, so the tool stays refused.
    if (deployment === undefined) return undefined
    if (profile.noFileEffect) {
      passthrough.set(profile.name, deployment)
      return undefined
    }
    return register(profile.name, deployment, async (args, exec) => {
      await target.refreshAuthorized?.()
      requireAuthorized(profile.name)
      const input = isRecord(args) ? args : {}
      const call = profile.call(input)
      if (call === undefined) {
        throw new Error(`a fork may only use ${profile.name} with the paths it declares`)
      }
      // A pathless search reads the workspace default, so its replacement supplies the working directory
      // as the root it checks and hands to the tool.
      const named = call.paths.length === 0 && profile.defaultsToWorkspace ? [target.cwd] : call.paths
      const canonical: string[] = []
      for (const path of named) {
        const candidate = await fs.resolve(path, { cwd: target.cwd, signal: exec.signal })
        if (!fs.contains(target.grantedRoot, candidate)) {
          throw new Error('a fork may only read inside the workspace it was granted')
        }
        canonical.push(fs.processPath(candidate))
      }
      requireAuthorized(profile.name)
      return await deployment.execute(call.rewrite(canonical), exec)
    })
  }
  let readReplacement: (() => void) | undefined
  for (const profile of SHARED_TOOL_PROFILES) {
    if (profile.tier !== 'view') continue
    const release = confineShared(profile)
    if (profile.name === FORK_READ_TOOL) readReplacement = release
  }
  // A deployment that ships the read tool must have its confined replacement in place for this child.
  if (deploymentOf(FORK_READ_TOOL) !== undefined && readReplacement === undefined) {
    for (const dispose of [...installedDisposers].reverse()) dispose()
    return undefined
  }
  /**
   * Register this host's own bounded `write` for one scope.
   *
   * The deployment's write tool writes wherever the model's path resolves; this one first checks that the
   * granted root contains the resolved target, then writes it through the backend under the Session's
   * current policy. A scope that may write and cannot get this replacement refuses to install at all,
   * rather than exposing the unbounded tool.
   * @param deployment - The deployment's write definition.
   * @returns A release for the replacement, or undefined when the scope refused it.
   */
  const confineWrite = (deployment: ToolDefinition): (() => void) | undefined =>
    register(FORK_WRITE_TOOL, deployment, async (args, exec) => {
      const input = isRecord(args) ? args : {}
      const requested = input.file_path
      const content = input.content
      if (typeof requested !== 'string' || requested === '' || typeof content !== 'string') {
        throw new Error('a fork may only write a named file with text content')
      }
      await target.refreshAuthorized?.()
      requireAuthorized(FORK_WRITE_TOOL)
      const candidate = await fs.resolve(requested, { cwd: target.cwd, signal: exec.signal })
      if (!fs.contains(target.grantedRoot, candidate)) {
        throw new Error('a fork may only write inside the workspace it was granted')
      }
      const intent = await childContext.waterfall('fs/write-intent', candidate, exec, () => undefined)
      await target.refreshAuthorized?.()
      const policy = target.resolvePolicy()
      requireAuthorized(FORK_WRITE_TOOL)
      const outcome = await fs.writeText(candidate, content, intent, exec.signal, policy)
      childContext.emit('fs/observed', candidate, { kind: 'present', version: outcome.version }, exec)
      return {
        path: requested,
        operation: outcome.operation,
        before: outcome.before ?? null,
        after: outcome.after,
      }
    })
  if (target.write === true) {
    const deploymentWrite = deploymentOf(FORK_WRITE_TOOL)
    // Without the replacement in place, a write-capable ceiling would expose the deployment's own tool.
    if (deploymentWrite === undefined || confineWrite(deploymentWrite) === undefined) {
      for (const dispose of [...installedDisposers].reverse()) dispose()
      return undefined
    }
  }
  /**
   * Register this host's own bounded `edit` for one scope.
   *
   * The deployment's edit tool edits wherever the model's path resolves; this one first checks that the
   * granted root contains the resolved target, then edits it through the backend under the Session's
   * current policy. A deployment without an edit tool simply leaves the name refused by the guard.
   * @param deployment - The deployment's edit definition.
   * @returns A release for the replacement, or undefined when the scope refused it.
   */
  const confineEdit = (deployment: ToolDefinition): (() => void) | undefined =>
    register(FORK_EDIT_TOOL, deployment, async (args, exec) => {
      const edit = sharedEditArguments(args)
      if (edit === undefined) {
        throw new Error('a fork may only edit a named file by replacing non-empty text')
      }
      await target.refreshAuthorized?.()
      requireAuthorized(FORK_EDIT_TOOL)
      const candidate = await fs.resolve(edit.filePath, { cwd: target.cwd, signal: exec.signal })
      if (!fs.contains(target.grantedRoot, candidate)) {
        throw new Error('a fork may only write inside the workspace it was granted')
      }
      // The edit intent comes from the same waterfall the shipped edit uses, so the deployment's
      // read-before-write rule keeps deciding here too.
      const intent = await childContext.waterfall('fs/edit-intent', candidate, exec, () => undefined)
      await target.refreshAuthorized?.()
      const policy = target.resolvePolicy()
      requireAuthorized(FORK_EDIT_TOOL)
      const outcome = await fs.editText(
        candidate,
        { oldString: edit.oldString, newString: edit.newString, replaceAll: edit.replaceAll },
        intent,
        exec.signal,
        policy,
      )
      childContext.emit('fs/observed', candidate, { kind: 'present', version: outcome.version }, exec)
      return { path: fs.processPath(candidate), before: outcome.before, after: outcome.after }
    })
  if (target.write === true) {
    const deploymentEdit = deploymentOf(FORK_EDIT_TOOL)
    // A failed registration leaves the name out of `vouchedNames`, so the guard refuses it while the
    // rest of the write surface stays usable.
    if (deploymentEdit !== undefined) confineEdit(deploymentEdit)
  }
  /**
   * Describe one execution's paths with the search default the child's own replacement supplies.
   *
   * A pathless `glob` or `grep` reads the working directory, which is a real path the guard has to
   * authorize; without it the call would be refused for naming nothing rather than for its effect.
   * @param execution - The call being judged.
   * @returns The paths it names and whether it has no file effect.
   */
  const describe = (execution: ForkToolExecution): ForkToolPaths =>
    withDefaultSearchRoot(target.describe(execution), execution.name, target.cwd)
  // Verdicts are keyed by the runtime's per-execution token: the model-facing call id is reusable, so
  // a verdict under it could authorize a different execution.
  const verdicts = new Map<symbol, readonly string[]>()
  /** Resolve every path one execution names; the granted root decides which of them count. */
  const confirmPaths = async (execution: ToolExecution): Promise<readonly string[]> => {
    const paths = describe(execution).paths ?? []
    const parent = target.grantedRoot
    const granted: string[] = []
    for (const path of paths) {
      const candidate = await fs.resolve(path, { cwd: target.cwd, signal: execution.signal })
      if (fs.contains(parent, candidate)) granted.push(path)
    }
    return granted
  }
  const disposeEnforcement = installChildEnforcement<Context>({
    childSessionId: target.childSessionId,
    ceiling: target.write === true ? WRITE_FORK_CEILING : READ_ONLY_FORK_CEILING,
    guard: forkToolGuard({
      // Attribution reads the agent's own session id: the object the runtime hands the guard need not
      // be the very instance the registry holds, while that id is the agent's declared identity.
      childOf: execution =>
        (execution.agent as { readonly id?: unknown } | undefined)?.id === target.childSessionId
          ? target.childSessionId
          : undefined,
      enforcementInstalled: id => forks.enforcementInstalled(id),
      // Only definitions this installation vouched for are executable: its own replacements, and the
      // exact deployment objects of the tools it left in place because they touch no workspace file.
      // A name whose replacement failed, or that anything else now answers to, is refused.
      toolIsTrusted: (_id, tool) => {
        if (target.authorized?.(tool) === false) return false
        if (vouchedNames.has(tool)) return true
        const deployment = passthrough.get(tool)
        return deployment !== undefined && deploymentOf(tool) === deployment
      },
      authorizeReadPath: (_id, path, token) => {
        if (token === undefined) return false
        const granted = verdicts.get(token)
        return granted !== undefined && granted.includes(path)
      },
    }, id => forks.enforcedCeiling(id), describe),
    verdictSource: async (execution) => {
      const { token } = execution
      if (token === undefined || describe(execution).paths === undefined) return
      // A resolution that throws or is cancelled confirms nothing for this execution, so no verdict is
      // recorded and the guard's own refusal names the reason; the tool call itself is not failed here.
      const granted = await confirmPaths(execution as ToolExecution).catch(() => undefined)
      if (granted !== undefined) verdicts.set(token, granted)
    },
  }, {
    contextOf: () => childContext,
    registerGuard: (context, guard) => context.tools.guard(guard),
    registerVerdictSource: (context, source) => context.on(
      'tools/pre-execute',
      async (exec, next): Promise<PreToolDecision> => {
        // The producer settles before the pipeline continues, so the guard below sees this execution's
        // verdict; the waterfall's own decision is the one the pipeline receives.
        await source(exec)
        return next()
      },
    ),
    recordEnforcement: (id, ceiling) => forks.installEnforcement(id, ceiling),
    releaseEnforcement: (id) => { forks.releaseEnforcement(id) },
  })
  if (disposeEnforcement === undefined) {
    for (const dispose of [...installedDisposers].reverse()) dispose()
    return undefined
  }
  // One verdict belongs to one execution, so it is dropped as soon as that execution settles; the
  // disposer clears whatever a cancelled or unobserved execution left behind.
  const disposeVerdicts = childContext.on('tools/result', (exec) => { verdicts.delete(exec.token) })
  return () => {
    disposeVerdicts()
    verdicts.clear()
    for (const dispose of [...installedDisposers].reverse()) dispose()
    disposeEnforcement()
  }
}
