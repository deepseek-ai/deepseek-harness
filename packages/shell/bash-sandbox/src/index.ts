/**
 * Sandbox-consuming bash executor. It wraps the exact local bash argv through
 * `ctx.sandbox`, inherits local process mechanics, and reports the selected
 * mode, enforcement, and denial facts. Positive runner-executable evidence
 * identifies a broken confinement runner: foreground calls throw
 * `SANDBOX_UNAVAILABLE`, while background processes carry `runnerFailed`;
 * other provider rejections retain stage-neutral local-executor semantics. The
 * tool owns approval and passes a complete per-call policy.
 * @module @deepseek-ai/dsh-bash-sandbox
 */

import { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxMode,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from './helpers.ts'

/**
 * Plugin config: the local executor's knobs, verbatim. The sandbox policy —
 * the default mode and fallback `workspace-write` root — is NOT here: it lives
 * on `ctx.sandboxPolicy` (`@deepseek-ai/dsh-sandbox-policy`), which resolves
 * each calling session's mode and cwd for every enforcing capability. The runner
 * choice is likewise the `ctx.sandbox` provider's config, not this executor's.
 */
export type Config = LocalConfig

/**
 * Registers as `ctx.shell` in place of the local executor and requires a
 * `ctx.sandbox` provider plus `ctx.sandboxPolicy`; the tool layer is
 * unchanged. Tool calls pass the calling session's resolved policy; direct
 * calls fall back to deployment policy. `result.sandbox` reports the mode and
 * enforcement actually used.
 */
export class SandboxBashExecutor extends LocalBashExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  // No own Config: the sandbox default (mode + workspaceRoot) is owned by
  // ctx.sandboxPolicy, so this executor inherits LocalBashExecutor's Config
  // verbatim (the config catalog walks the inherited static).

  private readonly mode: SandboxMode
  /**
   * Per-process confinement facts retained until settlement. Providers may
   * vary enforcement and diagnostic dialect between overlapping calls, so a
   * shared latest-wrap value would classify a process against the wrong facts.
   * Unconfined processes have no entry.
   */
  private readonly processFacts = new Map<ShellProcess, {
    mode: ConfinedSandboxMode
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureRules: readonly RunnerFailureRule[]
    runnerProgram: string | undefined
    workdir: string
  }>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // The default mode is the capability fact used for schema advertisement;
    // actual tool executions carry their resolved per-call policy.
    this.mode = ctx.sandboxPolicy.defaultMode
  }

  /** The configured default mode — the capability fact the tool layer reads. */
  override get sandboxMode(): SandboxMode {
    return this.mode
  }

  /**
   * Stamp a complete per-call policy onto the spec. Tool calls supply the
   * calling session's resolved mode and root; lower-level callers fall back to
   * the deployment policy.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') {
      return SandboxBashExecutor.decorateResult(
        await super.execute(spec),
        result => ({ ...result, sandbox: { mode, denied: false } }),
      )
    }
    let confined: ConfinedArgv | undefined
    const ex = await this.executeArgv(spec, async (signal) => {
      const prepared = await this.confine(spec.command, { ...policy, mode }, signal)
      signal.throwIfAborted()
      confined = prepared
      return prepared.argv
    }, (process) => {
      const facts = confined as ConfinedArgv
      this.processFacts.set(process, {
        mode,
        enforcement: facts.enforcement,
        denialSignatures: facts.denialSignatures,
        runnerFailureRules: facts.runnerFailureRules,
        runnerProgram: facts.argv[0],
        workdir: spec.workdir,
      })
    })
    return SandboxBashExecutor.decorateResult(ex, (result) => {
      if (confined === undefined) return { ...result, sandbox: { mode, denied: false } }
      const { enforcement, denialSignatures, runnerFailureRules } = confined
      // Runner failure outranks denial because the command did not run. Carry
      // the matched fatal line, not an informational line that preceded it.
      const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, runnerFailureRules)
      if (runnerFailure !== undefined) {
        throw new SandboxUnavailableError(mode, runnerFailure.detail)
      }
      return { ...result, sandbox: { mode, denied: classifyDenial(result, denialSignatures), enforcement } }
    }, (error) => {
      // An upstream abort remains cancellation even when it prevents spawn.
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
      if (confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    })
  }

  /**
   * Decorate the handle's foreground projection in place, memoized once. The
   * handle keeps its identity (never wrapped in a second object) because the
   * per-process facts and `onProcessDone` key on the exact instance.
   */
  private static decorateResult(
    ex: ShellExecution,
    map: (result: ShellRunResult) => ShellRunResult,
    mapError?: (error: unknown) => never,
  ): ShellExecution {
    const base = ex.result.bind(ex)
    let decorated: Promise<ShellRunResult> | undefined
    ex.result = () => {
      decorated ??= base().then(map, mapError)
      return decorated
    }
    return ex
  }

  /**
   * Stamp per-process sandbox facts before `done` settles. Full-access processes
   * have no facts; signal deaths are not denials.
   */
  protected override onProcessDone(proc: ShellProcess, stderr: string, providerRejected: boolean, providerError?: unknown): void {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      // A provider rejection exposes no public failure stage. Attribute it to
      // the confinement runner only when the error independently names argv[0].
      // Otherwise settled runner failure outranks denial-like diagnostics.
      const runnerFailed = providerRejected
        ? isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir)
        : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined
      proc.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      }
    }
    super.onProcessDone(proc, stderr, providerRejected, providerError)
  }

  /**
   * Wrap one shell command via the `ctx.sandbox` provider. Provider errors
   * propagate unchanged; the returned argv is handed directly to the local
   * executor's subprocess path.
   * @param command - shell source for the confined inner `bash -c`.
   * @param policy - resolved confined execution policy.
   * @param signal - cancellation of confinement preparation.
   * @returns the provider's exact argv and settlement-classification facts.
   */
  private confine(command: string, policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    return this.ctx.sandbox.confine(['bash', '-c', command], policy, signal)
  }
}

export default SandboxBashExecutor
