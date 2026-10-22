/** Select program syntax and own temporary or retained Node processes. */
import { stripTypeScriptTypes } from 'node:module'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PtcProgramFormat, PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { clampTimeout } from '@deepseek-ai/dsh-timeout'
import type { ResolvedConfig } from './config.ts'
import { validateBindings } from './bindings.ts'
import type { PolicyProcesses } from './policy-processes.ts'
import { ProgramWorker } from './worker.ts'

/** Syntax, state retention and model guidance selected during provider construction. */
export interface ExecutionMode {
  /** Child evaluator selected independently of process lifetime. */
  readonly format: PtcProgramFormat
  /** Whether caller-owned objects retain processes between runs. */
  readonly retainsState: boolean
  /** Model-facing syntax, output and recovery rules. */
  readonly executionInstructions: string
  /**
   * Erase TypeScript in the selected syntax without executing the program.
   * @param program - Model-written TypeScript source.
   * @returns JavaScript accepted by the selected evaluator.
   */
  stripTypes(program: string): string
}

/**
 * Select program semantics and create their shared process owner.
 * @param ctx - Provider lifecycle and execution services.
 * @param config - Validated configuration with loader defaults.
 * @param processes - Policy invalidation and process cleanup coordination.
 * @returns Mode selection and temporary or retained execution through one process implementation.
 */
export function createExecution(ctx: Context, config: ResolvedConfig, processes: PolicyProcesses): NodeExecution {
  return new NodeExecution(ctx, config, processes, resolveMode(config))
}

/** Temporary processes and optional object-owned reuse share one process implementation. */
class NodeExecution {
  private readonly owners = new WeakMap<object, ProgramWorker>()
  private readonly workers = new Set<ProgramWorker>()

  /**
   * Own process instances and optional owner lookup for one provider.
   * @param ctx - Provider lifecycle and execution services.
   * @param config - Validated limits and selected executable.
   * @param processes - Provider-owned policy invalidation and cleanup.
   * @param mode - Program syntax and TypeScript erasure.
   */
  constructor(
    private readonly ctx: Context, private readonly config: ResolvedConfig,
    private readonly processes: PolicyProcesses, readonly mode: ExecutionMode,
  ) {
    if (mode.retainsState && this.config.launch.kind === 'embedded') throw new Error('Persistent PTC requires a node-script launch')
  }

  /** Stop every owned process, retaining failed cleanup for a later retry. */
  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.workers].map(async (worker) => {
      await worker.dispose()
      this.workers.delete(worker)
    }))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  /**
   * Resolve the common file policy, directory and deadline defaults.
   * @param request - Program, bindings, owner, directory and elapsed budget.
   * @returns Resolved inputs with the selected file policy.
   */
  resolve(request: PtcRunRequest): PtcRunSpec {
    const sandboxPolicy = request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const cwd = request.cwd ?? sandboxPolicy.workspaceRoot
    if (!isAbsolute(cwd)) throw new Error(`${this.mode.retainsState ? 'persistent PTC' : 'ptc-runtime-node'}: cwd must be absolute`)
    return { ...request, sandboxPolicy, cwd, timeoutMs: request.timeoutMs === null ? null : clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, this.mode.retainsState ? 'persistent PTC timeoutMs' : 'ptc-runtime-node: timeoutMs') }
  }

  /**
   * Evaluate in a temporary process or reuse an enabled state owner's process.
   * @param spec - Resolved request; concurrent calls for one owner are rejected.
   * @returns Captured logs, JSON completion, or a structured execution failure.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    if (spec.sandboxPolicy === undefined) throw new Error('ptc-runtime-node: run requires a resolved sandbox policy')
    if (!isAbsolute(spec.cwd) || (spec.timeoutMs !== null && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > this.config.maxTimeoutMs))) throw new Error('ptc-runtime-node: run requires resolved cwd and timeout')
    const bindings = validateBindings(spec)
    const owner = this.mode.retainsState ? spec.stateOwner : undefined
    let worker = owner === undefined ? undefined : this.owners.get(owner)
    worker?.assertIdle()
    if (worker && !worker.closed && (worker.policy.mode !== spec.sandboxPolicy.mode
      || worker.policy.workspaceRoot !== spec.sandboxPolicy.workspaceRoot
      || worker.policy.sessionId !== spec.sandboxPolicy.sessionId
      || !sameAdditionalRoots(worker.policy.additionalWritableRoots, spec.sandboxPolicy.additionalWritableRoots))) {
      throw new Error('persistent PTC: release the retained environment before changing its sandbox policy')
    }
    if (!worker || worker.closed) {
      if (worker) this.workers.delete(worker)
      // Direct callers can own mutable policy arrays; the retained process owns its grant snapshot.
      worker = new ProgramWorker(this.ctx, this.config, {
        ...spec.sandboxPolicy,
        ...spec.sandboxPolicy.additionalWritableRoots === undefined
          ? {}
          : { additionalWritableRoots: [...spec.sandboxPolicy.additionalWritableRoots] },
      }, this.processes, this.mode, owner !== undefined)
      this.workers.add(worker)
      if (owner !== undefined) this.owners.set(owner, worker)
    }
    try { return await worker.run(spec, bindings) } finally {
      if (owner === undefined && worker.cleanupComplete) this.workers.delete(worker)
    }
  }

  /**
   * Release retained state and await its process cleanup.
   * @param owner - Exact object supplied to run.
   * @returns Completion after the owned process and output streams stop.
   */
  async release(owner: object): Promise<void> {
    const worker = this.owners.get(owner)
    if (!worker) return
    await worker.dispose()
    if (this.owners.get(owner) === worker) this.owners.delete(owner)
    this.workers.delete(worker)
  }
}

/**
 * Compare requested extra grants without resolving paths in another execution world.
 * @param left - one policy's additional roots.
 * @param right - the other policy's additional roots.
 * @returns whether both contain the same paths, ignoring order and duplicates.
 */
function sameAdditionalRoots(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const effective = (roots: readonly string[] | undefined): string[] => [...new Set(roots ?? [])].sort()
  const a = effective(left)
  const b = effective(right)
  return a.length === b.length && a.every((root, index) => root === b[index])
}

const STRIP_PREFIX = 'async function __dsh_program__() {\n'
const STRIP_SUFFIX = '\n}'
const RETAINED_STATE_INSTRUCTIONS = 'Changing the session sandbox mode clears retained variables. An approved sandbox escalation runs in a separate temporary environment: it cannot access retained variables, and its declarations are discarded afterward. Restart, Agent disposal, cancellation, timeout, output overflow, or process failure clears the environment. If a variable is undefined, recreate it and reacquire its resources. State is not restored from the conversation, and failed evaluations can leave earlier mutations in memory. Redeclaring an existing let, const, or class name fails; assign to a mutable binding or use a new name. Await all tool calls; background callbacks cannot call tools after their evaluation ends. Await child-process completion before ending an evaluation; raw subprocess output belongs to whichever evaluation is active when it arrives.'

function resolveMode(config: ResolvedConfig): ExecutionMode {
  switch (config.executionMode) {
    case 'per-call': return {
      format: 'function-body',
      retainsState: false,
      executionInstructions: 'The program is the body of an async TypeScript function; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level await and return are supported. Emit output with console.log(...) or return a lossless JSON value. Only printed values and the returned value become program output. Each call runs in a fresh Node process. Node APIs are available through await import(...). Relative paths use the supplied working directory; process.env starts empty. Direct filesystem access follows this execution\'s sandbox policy.',
      stripTypes(program) {
        const stripped = stripTypeScriptTypes(STRIP_PREFIX + program + STRIP_SUFFIX)
        return stripped.slice(STRIP_PREFIX.length, stripped.length - STRIP_SUFFIX.length)
      },
    }
    case 'persistent-in-memory': return {
      format: 'repl',
      retainsState: true,
      executionInstructions: 'The program contains TypeScript REPL statements; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level declarations and await are supported; top-level return is not supported. Emit output with console.log(...) or a final lossless JSON expression. Only printed values and that final expression become program output. Variables, functions, and imported modules remain in memory for this Agent across calls. Use await import(...) for modules. Direct filesystem access follows this execution\'s sandbox policy; process.env starts empty. ' + RETAINED_STATE_INSTRUCTIONS,
      stripTypes: stripTypeScriptTypes,
    }
    case 'vm-script': {
      const lifetime = config.scriptPersistence
        ? 'Variables, functions, and imported modules remain in memory for this Agent across calls.'
        : 'Each call runs in a fresh Node process.'
      const asynchronousFailure = 'Await asynchronous work: an uncaught callback exception or unhandled rejection terminates the process'
        + (config.scriptPersistence ? ' and clears its variables.' : '.')
      const recovery = config.scriptPersistence
        ? ' ' + RETAINED_STATE_INSTRUCTIONS + ' If a native top-level let, const, or class initializer throws, its name may remain permanently uninitialized; use a new name or restart the environment.'
        : ''
      return {
        format: 'script',
        retainsState: config.scriptPersistence,
        executionInstructions: 'The program contains TypeScript script statements; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level declarations and await are supported; top-level return is not supported. Emit output with console.log(...) or a final lossless JSON expression. The final expression is awaited if it is a Promise. Only printed values and that final expression become program output. ' + lifetime + ' Use await import(...) for modules. Relative paths use the supplied working directory. Direct filesystem access follows this execution\'s sandbox policy; process.env starts empty. ' + asynchronousFailure + ' Values from bindings and imports can belong to another realm; use Array.isArray for arrays and the supplied binding error classes for failures, because instanceof Array or Error may be false.' + recovery,
        stripTypes: stripTypeScriptTypes,
      }
    }
    /* v8 ignore next -- Loader validates the closed execution-mode union before selection. */
    default: return assertNever(config.executionMode)
  }
}
