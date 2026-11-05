/**
 * The guard a forked child's own scoped tool runtime runs before every dispatch.
 *
 * It is registered on one child's context, so it speaks for that child alone: it refuses anything the
 * ceiling does not permit, and it decides paths through the host's real filesystem authorization
 * rather than by comparing strings or trusting a tool name. The return value is the reason string the
 * tool runtime expects, and a refusal is monotonic — nothing downstream can turn it back into an
 * allow.
 */

import { forkToolDecision, type ForkToolDecision } from './fork-ceiling.ts'
import type { ForkCeiling } from './fork-policy.ts'

/** One tool execution as the runtime presents it to a guard. */
export interface ForkToolExecution {
  /** Tool being dispatched, as the harness names it. */
  readonly name: string
  /** Parsed arguments the tool will receive. */
  readonly arguments: unknown
  /** Agent the call runs on behalf of, which identifies the child. */
  readonly agent?: unknown
  /**
   * Per-execution identity the runtime assigns.
   *
   * The model-facing `callId` is caller-supplied and reusable, so a verdict keyed on it could be
   * replayed by another call; this token is the runtime's own handle for exactly one execution.
   */
  readonly token?: symbol
  /** Turn this execution serves, as the driving loop reported it; absent when it serves none. */
  readonly turn?: number
}

/** Host services the guard needs; none of them is a guess the guard could make itself. */
export interface ForkToolGuardPorts {
  /** Child session one execution belongs to, or undefined when it cannot be attributed. */
  readonly childOf: (execution: ForkToolExecution) => string | undefined
  /** Whether that child's execution limit is installed on this host. */
  readonly enforcementInstalled: (childSessionId: string) => boolean
  /**
   * Whether the definition about to run is one this host vouches for.
   *
   * A child's scope can register its own tool, and a scope-local registration shadows the
   * deployment's one under the same name, so the executed name is not evidence of what will run. The
   * host vouches for the deployment's own definition and for the ones it installed into this child's
   * scope itself; anything else is refused before the ceiling considers the name.
   */
  readonly toolIsTrusted: (childSessionId: string, tool: string) => boolean
  /**
   * Whether this exact execution already had that path authorized.
   *
   * The host answers this from the asynchronous resolution it performed for this token, never from a
   * string comparison here, so a symlink, a relative escape, or an encoded separator is decided by
   * the same code that would open the file. A missing token or a missing verdict is a refusal.
   */
  readonly authorizeReadPath: (childSessionId: string, path: string, token: symbol | undefined) => boolean
}

/** Ceiling decision for one tool name, and the paths its arguments name. */
export interface ForkToolGuardRequest {
  /** Child the execution belongs to. */
  readonly childSessionId: string
  /** Tool name. */
  readonly tool: string
  /**
   * Paths the arguments name, or undefined when they could not be established.
   *
   * Undefined is not "no paths": a tool whose arguments could not be interpreted, `grep` falling back
   * to its default directory, or a locally registered tool reusing a name all mean the paths are
   * unknown, and an unknown path set is refused rather than treated as empty.
   */
  readonly paths: readonly string[] | undefined
  /** Whether the tool declares that it touches no filesystem at all. */
  readonly noFileEffect: boolean
  /** Runtime handle of this exact execution, which the authorization must be bound to. */
  readonly token?: symbol
}

/**
 * Decide one tool execution for one child.
 *
 * A name this child's own scope registered is refused before the ceiling reads it, so shadowing a
 * permitted name cannot smuggle in a different tool. A permitted read tool is then allowed only when
 * every path it names is authorized; a tool whose effect cannot be established, or whose paths cannot
 * be authorized, is refused rather than allowed by default. An empty path set is not evidence of no
 * paths: it is allowed only when the tool itself declares that it has no filesystem effect, so an
 * unparsed argument list cannot slip through. `bash` and the other acting capabilities never reach
 * the path check.
 * @param ceiling Ceiling enforced for that child.
 * @param request Execution facts the host extracted.
 * @param ports Host filesystem and enforcement services.
 * @returns Allowed, or the reason to refuse.
 */
export function decideForkToolUse(
  ceiling: ForkCeiling | undefined,
  request: ForkToolGuardRequest,
  ports: Pick<ForkToolGuardPorts, 'authorizeReadPath' | 'toolIsTrusted'>,
): ForkToolDecision {
  const decision = forkToolDecision(ceiling, {
    childSessionId: request.childSessionId,
    sessionId: request.childSessionId,
    tool: request.tool,
  })
  if (!decision.ok) return decision
  if (!ports.toolIsTrusted(request.childSessionId, request.tool)) {
    return {
      ok: false,
      code: 'fork-tool-not-permitted',
      message: `a fork may not use ${request.tool}, which this host did not install`,
    }
  }
  if (request.paths === undefined) {
    return {
      ok: false,
      code: 'fork-paths-unknown',
      message: 'a fork may not run a tool whose paths could not be established',
    }
  }
  if (request.paths.length === 0 && !request.noFileEffect) {
    return {
      ok: false,
      code: 'fork-paths-unknown',
      message: 'a fork may not run a tool whose filesystem effect could not be established',
    }
  }
  for (const path of request.paths) {
    if (!ports.authorizeReadPath(request.childSessionId, path, request.token)) {
      return {
        ok: false,
        code: 'fork-path-outside-workspace',
        message: 'a fork may only read inside the workspace it was granted',
      }
    }
  }
  return { ok: true }
}

/**
 * Build the guard one child's tool runtime registers.
 *
 * The returned function matches `ToolGuard` structurally — a reason string or undefined — so the host
 * registers it with `tools.guard(...)` on the child's own context without this package depending on the
 * tool runtime.
 * @param ports Host services the guard cannot decide for itself.
 * @param ceilingOf Ceiling installed for one child.
 * @param describe Names that tool's arguments, from its own description: the paths it touches, or
 * undefined when they cannot be established, and whether it touches no filesystem at all.
 * @returns The guard to register, which refuses whenever the child cannot be attributed.
 */
export function forkToolGuard(
  ports: ForkToolGuardPorts,
  ceilingOf: (childSessionId: string) => ForkCeiling | undefined,
  describe: (execution: ForkToolExecution) => { readonly paths: readonly string[] | undefined; readonly noFileEffect: boolean },
): (execution: ForkToolExecution) => string | undefined {
  return (execution) => {
    const childSessionId = ports.childOf(execution)
    // An execution this guard cannot attribute to a child is refused: the guard speaks for children,
    // and an unattributed call is not one it can vouch for.
    if (childSessionId === undefined) return 'a fork may not act without a child session'
    if (!ports.enforcementInstalled(childSessionId)) {
      return 'read-only execution limits are not installed for this fork'
    }
    const decision = decideForkToolUse(ceilingOf(childSessionId), {
      childSessionId,
      tool: execution.name,
      ...describe(execution),
      ...(execution.token === undefined ? {} : { token: execution.token }),
    }, ports)
    return decision.ok ? undefined : decision.message
  }
}

/** Host services one child-scoped guard installation needs. */
export interface ChildEnforcementPorts<Context> {
  /** The child's own scoped context, or undefined when this host cannot reach it. */
  readonly contextOf: (childSessionId: string) => Context | undefined
  /**
   * Register the guard on that context.
   *
   * The runtime returns its own disposer; returning undefined means nothing was registered, and the
   * installation must not be recorded as installed.
   */
  readonly registerGuard: (
    context: Context,
    guard: (execution: ForkToolExecution) => string | undefined,
  ) => (() => void) | undefined
  /** Record that this child's limit is installed; false when this host never recorded that child. */
  readonly recordEnforcement: (childSessionId: string, ceiling: ForkCeiling) => boolean
  /** Drop that record when the installation is released, so the child refuses again. */
  readonly releaseEnforcement: (childSessionId: string) => void
  /**
   * Register the async producer that writes this execution's path verdict before the guard runs.
   *
   * Verified paths live there, keyed by the runtime's per-execution token, so the synchronous guard
   * only ever consumes a verdict produced by the real resolution for that same execution.
   */
  readonly registerVerdictSource: (
    context: Context,
    source: (execution: ForkToolExecution) => Promise<void>,
  ) => (() => void) | undefined
}

/** One context owns the persistent guard and its replaceable enforcement installation. */
interface ChildGuardOwner {
  installation?: {
    readonly guard: (execution: ForkToolExecution) => string | undefined
    readonly dispose: () => void
  }
}

/**
 * Install one child's execution limit and return its disposer.
 *
 * The child context owns one persistent guard. Reinstallation replaces its verdict source and
 * decision together, without retaining the previous installation's path verdicts. Calls fail closed
 * while no installation is published, including registration failure and release.
 *
 * The enforcement record is written only after both runtime registrations succeed. Release drops
 * that record and the verdict producer, but leaves the context's guard registered; an obsolete
 * disposer cannot release a successor. Scope teardown owns the persistent guard's removal.
 * @param input Child to enforce, the ceiling to enforce, and the guard to register.
 * @param ports Host context lookup, guard registration, and enforcement record.
 * @returns The disposer that releases the limit, or undefined when nothing was installed.
 */
export function installChildEnforcement<Context>(
  input: {
    readonly childSessionId: string
    readonly ceiling: ForkCeiling
    readonly guard: (execution: ForkToolExecution) => string | undefined
    readonly verdictSource: (execution: ForkToolExecution) => Promise<void>
  },
  ports: ChildEnforcementPorts<Context>,
): (() => void) | undefined {
  const context = ports.contextOf(input.childSessionId)
  if (context === undefined) return undefined
  const scoped = context as Context & { readonly liveshareForkToolGuard?: ChildGuardOwner }
  let owner = Object.hasOwn(scoped, 'liveshareForkToolGuard') ? scoped.liveshareForkToolGuard : undefined
  owner?.installation?.dispose()
  const disposeVerdicts = ports.registerVerdictSource(context, input.verdictSource)
  if (disposeVerdicts === undefined) return undefined
  if (owner === undefined) {
    const created: ChildGuardOwner = {}
    if (ports.registerGuard(context, execution => created.installation === undefined
      ? 'read-only execution limits are not installed for this fork'
      : created.installation.guard(execution)) === undefined) {
      disposeVerdicts()
      return undefined
    }
    // An inherited context must not reuse its ancestor's guard owner.
    Object.defineProperty(scoped, 'liveshareForkToolGuard', { value: created })
    owner = created
  }
  if (!ports.recordEnforcement(input.childSessionId, input.ceiling)) {
    disposeVerdicts()
    return undefined
  }
  const held = owner
  const installation = {
    guard: input.guard,
    dispose: () => {
      if (held.installation !== installation) return
      delete held.installation
      disposeVerdicts()
      ports.releaseEnforcement(input.childSessionId)
    },
  }
  held.installation = installation
  return installation.dispose
}
