/**
 * PTC mode `run_code` transport. Programs call the registry's agent-visible
 * tools through nested executions scheduled under the native concurrency
 * contract; each sub-dispatch is logged for reconstruction, while only the
 * outer curated result enters model history.
 * @module @deepseek-ai/dsh-tools/src/ptc
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Images deferred from a successful PTC subcall's final result. */
    'ptc-mode': { kind: 'ptc-mode' }
  }
}

import type { ContentBlock, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction, PtcRunResult, PtcRunSandbox, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { approveEscalation, ESCALATION_TARGETS, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { deepFreeze, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, parameterSchemaSpecToJsonSchema } from './schema.ts'
import { TOOL_RUNTIME_SCHEDULER } from './index.ts'
import type { PtcDispatchLog, ToolDefinition, ToolExecutionResult, ToolRuntime, ToolRunContext } from './index.ts'
import type {} from './types.ts'

/** The model-facing name of the PTC mode tool. */
export const RUN_CODE_NAME = 'run_code'

/**
 * The language-specific `run_code` schema text: the tool `description` and its
 * `code` parameter description, kept together so a language's two model-facing
 * strings share one source of truth. Keyed by `PtcRuntime.language`, mirroring
 * `SDK_RENDERERS` in {@link ./index.ts}. The emitted flavor MUST match the
 * semantics the same language's SDK instructions promise, so the model never
 * receives a TypeScript schema beside a Python SDK (or vice versa).
 */
interface RunCodeFlavor {
  /** The tool `description` the model sees for this language. */
  readonly description: string
  /** The `code` parameter's description for this language. */
  readonly codeDescription: string
}

/**
 * The TypeScript flavor: the fallback for a schema read with no runtime
 * mounted ({@link resolveFlavor} owns which readers reach that). A real
 * assembly always resolves a runtime first, so the model never sees this
 * fallback outside its own language.
 */
const TYPESCRIPT_FLAVOR: RunCodeFlavor = {
  description:
    'Execute a TypeScript program against the available tools. Takes two required '
    + 'arguments: `code`, the BODY of an async function (erasable syntax only; top-level '
    + '`await` and `return` work), and `description`, a short summary of what the program '
    + 'does. Call tools as `await tools.name(args)` per the declarations in the system '
    + 'prompt. Only what you print or return is program output — curate it. Image-bearing '
    + 'subtool results are attached after the run.',
  codeDescription: 'The program: the body of an async TypeScript function.',
}

/**
 * The Python flavor: the body of an async function, top-level `await` and
 * `return`, answer via `print` and/or the returned value, matching
 * {@link ./py-types.ts}'s SDK instructions.
 */
const PYTHON_FLAVOR: RunCodeFlavor = {
  description:
    'Execute a Python program against the available tools. Takes two required '
    + 'arguments: `code`, the BODY of an async function (top-level `await` and `return` '
    + 'work), and `description`, a short summary of what the program does. Call tools as '
    + '`await tools.name(args)` per the declarations in the system prompt. Use '
    + '`print(...)` and/or `return <value>` for program output — curate it. Image-bearing '
    + 'subtool results are attached after the run.',
  codeDescription: 'The program: the body of an async Python function.',
}

/**
 * The languages PTC mode ships a presentation for. Both per-language tables —
 * {@link RUN_CODE_FLAVORS} here and `SDK_RENDERERS` in {@link ./index.ts} — are
 * checked against this union with `satisfies`, so a language added to one and
 * not the other fails `typecheck` instead of waiting for a runtime that reports
 * it. The tables stay declared `Record<string, …>` because `PtcRuntime.language`
 * is an unconstrained `string`: this union pins what the harness ships, while the
 * `Object.hasOwn` guards reject what a mounted runtime may report.
 */
export type PtcSdkLanguage = 'typescript' | 'python'

/** Per-language `run_code` schema flavors (see {@link RunCodeFlavor}); one entry per {@link PtcSdkLanguage}. */
const RUN_CODE_FLAVORS: Record<string, RunCodeFlavor> = {
  typescript: TYPESCRIPT_FLAVOR,
  python: PYTHON_FLAVOR,
} satisfies Record<PtcSdkLanguage, RunCodeFlavor>

/**
 * The `description` parameter's model-facing description: language-independent
 * (the UI label contract is the same for every runtime), shared between the
 * static spec and the language-aware `parameters` getter so the two emissions
 * can never drift.
 */
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
  = 'Clear, concise description of what this program does in active voice, '
    + '5-10 words (shown in the UI). Examples: "Count TODO markers across packages"; '
    + '"Read failing test and its fixture"; "Rename config key in every cordis.yml".'

const RUN_CODE_CONTROLS = {
  timeoutMs: { type: 'number', description: 'Positive elapsed-time budget in milliseconds, capped by the deployment maximum.' },
  sandbox_permissions: { type: 'string', enum: [...ESCALATION_TARGETS], description: 'Wider sandbox mode for this complete program execution; requires justification and approval.' },
  justification: { type: 'string', description: 'Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request.' },
} as const

function controlParameters(runtime: PtcRuntime | undefined) {
  // Catalog readers have no mounted runtime; real model assembly requires one.
  if (runtime === undefined) return RUN_CODE_CONTROLS
  return {
    ...runtime.timeout === undefined ? {} : {
      timeoutMs: { ...RUN_CODE_CONTROLS.timeoutMs,
        description: `Positive elapsed-time budget in milliseconds, including nested tool and approval waits. Default ${runtime.timeout.defaultMs}; capped at ${runtime.timeout.maxMs}. Zero does not disable the deadline.` },
    },
    ...runtime.sandboxMode === undefined ? {} : {
      sandbox_permissions: RUN_CODE_CONTROLS.sandbox_permissions,
      justification: RUN_CODE_CONTROLS.justification,
    },
  }
}

function escalationGuidance(runtime: PtcRuntime | undefined): string {
  return runtime?.sandboxMode === undefined ? ''
    : ' A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying. Programs are never replayed automatically.'
}

/**
 * Resolve the {@link RunCodeFlavor} for the loaded runtime's language, read at
 * schema-emission time so the model-visible `run_code` schema always matches
 * the SDK section's language. `peekRuntime` returns `undefined` only when no
 * runtime is mounted, which reaches this function through definition readers
 * and `schemas()` — the doc-catalog harvest is the only shipped one, and none
 * of them feeds a model, because `wireSchemas` calls `requirePtcRuntime`
 * before projecting — so that path degrades to {@link TYPESCRIPT_FLAVOR}. A
 * mounted runtime whose language has no flavor entry fails loud, exactly as
 * `requirePtcRuntime` rejects it at assembly. Keeping this table in step with
 * `SDK_RENDERERS` is the compiler's job ({@link PtcSdkLanguage}); what this
 * guard owns is the runtime-supplied language neither table knows, which never
 * yields a wrong-language schema for a real runtime.
 */
function resolveFlavor(peekRuntime: () => PtcRuntime | undefined): RunCodeFlavor {
  const runtime = peekRuntime()
  if (runtime === undefined) {
    // No runtime mounted: reached by definition readers and `schemas()`, of
    // which the doc-catalog harvest is the only shipped one. None feeds a
    // model — `wireSchemas` calls `requirePtcRuntime` before projecting, so
    // the assembly path never arrives here. Degrade to the TS default.
    return TYPESCRIPT_FLAVOR
  }
  // Own-property read: a language like `toString`/`constructor` would otherwise
  // resolve an inherited Object.prototype member as a flavor.
  const flavor = RUN_CODE_FLAVORS[runtime.language]
  if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === undefined) {
    const known = Object.keys(RUN_CODE_FLAVORS).map(name => JSON.stringify(name)).join(', ')
    throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`)
  }
  return flavor
}

/**
 * Thrown by `run_code` when the program run itself failed — a program
 * exception, a budget expiry, an abort, or substrate death. Extends
 * {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
 * pipeline converts it into a structured `isError` result whose text carries
 * the failure kind plus the captured logs, so the model can self-correct.
 */
export class CodeRunFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RUN_FAILED')
    this.name = 'CodeRunFailedError'
  }
}

/**
 * Snapshot one binding call's argument as lossless JSON, then snapshot that
 * detached value again so dispatch and logging stay independent without
 * reintroducing structured-clone's platform-specific nesting limit.
 */
function jsonNormalizeArgs(value: unknown): { dispatched: unknown; logged: unknown } {
  let snapshot: JsonValue | undefined
  try {
    snapshot = snapshotJsonValue(value) as JsonValue | undefined
  } catch (error: unknown) {
    throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (snapshot === undefined) {
    throw new Error('tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)')
  }
  const logged = snapshotJsonValue(snapshot)
  /* v8 ignore next -- snapshot is already a detached lossless JSON value. */
  if (logged === undefined) {
    throw new Error('tool arguments could not be detached for durable logging')
  }
  return { dispatched: snapshot, logged }
}

/** Two-space JSON presentation, matching the existing shallow `run_code` text contract. */
const JSON_INDENT = '  '

/**
 * ECMAScript caps `JSON.stringify`'s `space` string at ten characters. The
 * renderer also caps TOTAL indentation there, compacting deeper subtrees, so
 * formatted output remains linear in the canonical JSON size.
 */
const MAX_JSON_INDENT_CHARS = 10

/** A pending fragment in the iterative JSON presentation traversal. */
type JsonRenderTask =
  | { kind: 'text'; text: string }
  | { kind: 'value'; value: JsonValue; depth: number; compact: boolean }

/** Render one non-string JSON root without recursive traversal or unbounded indentation growth. */
function renderJsonValue(value: Exclude<JsonValue, string>): string {
  const chunks: string[] = []
  const tasks: JsonRenderTask[] = [{ kind: 'value', value, depth: 0, compact: false }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'text') {
      chunks.push(task.text)
      continue
    }

    const current = task.value
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      chunks.push(String(current))
      continue
    }
    if (typeof current === 'string') {
      chunks.push(JSON.stringify(current))
      continue
    }

    const compact = task.compact || (task.depth + 1) * JSON_INDENT.length > MAX_JSON_INDENT_CHARS
    const childDepth = task.depth + 1
    if (Array.isArray(current)) {
      chunks.push('[')
      if (current.length === 0) {
        chunks.push(']')
        continue
      }
      tasks.push({ kind: 'text', text: compact ? ']' : `\n${JSON_INDENT.repeat(task.depth)}]` })
      for (let index = current.length - 1; index >= 0; index--) {
        const item = current[index]
        /* v8 ignore next -- canonical JsonValue arrays are dense. */
        if (item === undefined) throw new Error('cannot render a sparse JSON array')
        tasks.push({ kind: 'value', value: item, depth: childDepth, compact })
        tasks.push({
          kind: 'text',
          text: compact
            ? index === 0 ? '' : ','
            : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}`,
        })
      }
      continue
    }

    const keys = Object.keys(current)
    chunks.push('{')
    if (keys.length === 0) {
      chunks.push('}')
      continue
    }
    tasks.push({ kind: 'text', text: compact ? '}' : `\n${JSON_INDENT.repeat(task.depth)}}` })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) throw new Error('cannot render a missing JSON object key')
      const item = current[key]
      /* v8 ignore next -- canonical JsonValue records contain no undefined properties. */
      if (item === undefined) throw new Error('cannot render an undefined JSON object property')
      tasks.push({ kind: 'value', value: item, depth: childDepth, compact })
      tasks.push({
        kind: 'text',
        text: compact
          ? `${index === 0 ? '' : ','}${JSON.stringify(key)}:`
          : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `,
      })
    }
  }
  return chunks.join('')
}

/** Render one present program completion value for the model-facing result text. */
function renderValue(value: JsonValue): string {
  return typeof value === 'string' ? value : renderJsonValue(value)
}

/** Canonical value returned by the outer PTC mode transport. */
type RunCodeOutput = { logs: string[]; result?: JsonValue; sandbox?: PtcRunSandbox }

/**
 * Registry-private capabilities the bridge receives at construction — the
 * `requireRuntime` idiom: operations only the owning registry can mint stay
 * off its public service API and flow here as closures instead.
 */
export interface RunCodeBridgeOptions {
  /** Reads the approval channel when a program requests a wider sandbox mode. */
  peekApprover: () => ApprovalService | undefined
  /** Resolves standing Session authority only for a runtime that enforces file policy. */
  resolveSandboxPolicy: (exec: ToolRunContext) => SandboxExecutionPolicy
  /** Resolves `ctx.ptcRuntime` or throws the loud misconfiguration error (shared with the registry's assembly-time checks). */
  requireRuntime: () => PtcRuntime
  /**
   * Reads `ctx.ptcRuntime` without throwing: `undefined` when none is mounted.
   * Lets schema emission tell "no runtime" (degrade to TS; the readers that
   * reach it are {@link resolveFlavor}'s) apart from "unknown language" (fail
   * loud).
   */
  peekRuntime: () => PtcRuntime | undefined
  /** The run's overlap cap for parallel-classified sub-calls (the registry passes its validated `maxParallelSubCalls`). */
  maxParallel: number
  /** Runs the contained `tools/ptc-dispatch-log` waterfall over one settled sub-dispatch (the registry's private invoker). */
  shapeDispatchLog: (dispatch: PtcDispatchLog) => Promise<ContentBlock[]>
}

/**
 * Build the `run_code` {@link ToolDefinition}: required `code` and
 * `description` parameters, executed through the dispatch bridge described
 * above. The
 * registry reserves it as presentation infrastructure under non-native modes,
 * outside the filterable global/scoped capability layers.
 * @param registry - the owning registry (sub-calls go through its `execute`,
 *   bindings cover its registered tools).
 * @param options - the registry-private capabilities described above.
 * @returns the registry-ready definition.
 */
export function createRunCodeTool(registry: ToolRuntime, options: RunCodeBridgeOptions): ToolDefinition {
  const { requireRuntime, peekRuntime, maxParallel, shapeDispatchLog } = options
  const definition = defineTool({
    name: RUN_CODE_NAME,
    // The description and `code` parameter description are placeholders here:
    // the language-aware getters installed below replace both, resolving the
    // loaded runtime's flavor at schema-emission time so the schema the MODEL
    // sees matches the SDK section's language. Argument VALIDATION still keys
    // off this static spec (defineTool closes over it), which is language-
    // independent (one required string `code`).
    description: TYPESCRIPT_FLAVOR.description,
    parameters: {
      code: { type: 'string', required: true, description: TYPESCRIPT_FLAVOR.codeDescription },
      description: {
        type: 'string',
        required: true,
        description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION,
      },
      ...RUN_CODE_CONTROLS,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: { type: 'array', required: true, items: { type: 'string' } },
          result: { type: 'json' },
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true, enum: ['read-only', 'workspace-write', 'danger-full-access'] },
              denied: { type: 'boolean', required: true },
              enforcement: { type: 'string', enum: ['full', 'partial'] },
            },
          },
        },
      },
      render: (_args, value) => {
        const rendered = value.result === undefined ? '' : renderValue(value.result)
        const parts = [value.logs.join('\n'), rendered].filter(part => part.length > 0)
        if (value.sandbox?.enforcement === 'partial') parts.push('File sandbox enforcement is partial on this host.')
        if (value.sandbox?.denied) parts.push(`The ${value.sandbox.mode} file sandbox denied an operation.${escalationGuidance(peekRuntime())}`)
        return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(run_code completed with no output)' }]
      },
    },
    async execute(args, exec): Promise<RunCodeOutput> {
      if (args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string')
      }
      const runtime = requireRuntime()
      validateEscalationArgs(args.sandbox_permissions, args.justification)
      if (args.timeoutMs !== undefined && runtime.timeout === undefined) {
        throw new Error('timeoutMs is not available for this PTC runtime')
      }
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error('invalid timeoutMs: expected a positive finite number')
      }
      const standingPolicy = runtime.sandboxMode === undefined ? undefined : options.resolveSandboxPolicy(exec)
      let policy = standingPolicy
      if (args.sandbox_permissions !== undefined && args.justification !== undefined) {
        if (standingPolicy === undefined) throw new Error('sandbox_permissions is not available for this PTC runtime')
        const approvedMode = await approveEscalation({
          requestedMode: args.sandbox_permissions,
          justification: args.justification,
          effectiveMode: standingPolicy.mode,
          subject: 'program',
        }, {
          approver: options.peekApprover(), agent: exec.agent, callId: exec.callId,
          toolName: RUN_CODE_NAME, signal: exec.signal,
        })
        policy = { ...standingPolicy, mode: approvedMode }
      }
      exec.signal.throwIfAborted()

      // The run-scoped abort: follows the outer signal in, and fires when the
      // run settles for ANY reason, so an in-flight sub-dispatch is aborted
      // (its executor kills on this signal) instead of orphaned, and
      // queued-unstarted dispatches are abandoned.
      const runController = new AbortController()
      const onOuterAbort = (): void => { runController.abort(exec.signal.reason) }
      exec.signal.addEventListener('abort', onOuterAbort, { once: true })

      let dispatches = 0
      // The per-run scheduler uses the registry's staged interface and follows
      // the same concurrency rules as the native loop. It also follows the
      // native loop's SEQUENCING: every ordered stage (the dispatch-start
      // append, prepare = pre-execute/guards, finalize/finish = post-execute,
      // context deferral, the settle append) runs inside ONE driver lane, so
      // ordered policy stages never overlap each other and only the
      // around-dispatch/body stage runs concurrently. Starts are strictly
      // submission-ordered; results commit in submission order through the
      // head-of-line cursor. Consecutive parallel-classified calls overlap up
      // to maxParallel; an exclusive call waits for the pool to drain, runs
      // alone, and holds its barrier until its COMMIT (post-execute included)
      // completes, exactly like a native exclusive group. Classification is
      // re-read via executionMode() immediately before each start (a registry
      // mutation while queued can flip a call exclusive), matching the native
      // scheduler's lazy reclassification.
      interface PendingDispatch {
        /** Ordered stage: append the start event, await prepare (pre-execute/guards), launch the body into `flight`. */
        start(): Promise<void>
        classify(): 'parallel' | 'exclusive'
        abandon(): void
        /** Ordered stage: post-execute + context deferral + settle event, in submission order. */
        commit(): Promise<void>
        /** The launched around-dispatch/body stage; resolved until start() replaces it. */
        flight: Promise<void>
        /** True once the dispatch stage parked its outcome; the commit cursor waits on it. */
        settled: boolean
        /** The classification this entry started under; an exclusive holds its barrier through commit(). */
        mode?: 'parallel' | 'exclusive'
      }
      const pendingQueue: PendingDispatch[] = []
      const inFlight = new Set<Promise<void>>()
      /** Tracked settle-event side work (log-content listener + append), drained at run settlement. */
      const logWork = new Set<Promise<void>>()
      const commitQueue: PendingDispatch[] = []
      let exclusiveActive = false
      let driving = false
      let driverRun: Promise<void> = Promise.resolve()
      let wake: (() => void) | undefined
      const wakeup = (): void => {
        const release = wake
        wake = undefined
        release?.()
      }
      /**
       * The single ordered lane. Each pass commits the head-of-line settled
       * dispatch (ordered post-execute), then starts the next queued entry if
       * its slot is free (ordered pre-execute), and otherwise sleeps until a
       * body settles or a new submission arrives. One run reaching the
       * empty-queues/empty-pool state is quiescence.
       */
      const drive = (): Promise<void> => {
        if (driving) return driverRun
        driving = true
        driverRun = (async () => {
          try {
            for (;;) {
              // Create the wakeup promise before inspecting state so a settle or submission arriving
              // between the checks and the await below cannot be lost.
              const signal = new Promise<void>((resolve) => { wake = resolve })
              const commitHead = commitQueue[0]
              if (commitHead !== undefined && commitHead.settled) {
                commitQueue.shift()
                await commitHead.commit()
                // The barrier covers post-execute: later starts wait for the
                // exclusive call's full pipeline, as under the native loop.
                if (commitHead.mode === 'exclusive') exclusiveActive = false
                continue
              }
              const head = pendingQueue[0]
              if (head !== undefined) {
                if (runController.signal.aborted) {
                  pendingQueue.shift()
                  head.abandon()
                  continue
                }
                // Reclassify at start time (fail-closed on registry changes).
                const mode = head.classify()
                const capacity = !exclusiveActive
                  && (mode === 'exclusive' ? inFlight.size === 0 : inFlight.size < maxParallel)
                if (capacity) {
                  if (mode === 'exclusive') exclusiveActive = true
                  head.mode = mode
                  pendingQueue.shift()
                  // Joined before start() so the commit cursor sees submission
                  // order; nothing commits it until `settled` flips.
                  commitQueue.push(head)
                  await head.start()
                  const flight: Promise<void> = head.flight.finally(() => {
                    inFlight.delete(flight)
                    wakeup()
                  })
                  inFlight.add(flight)
                  continue
                }
              }
              if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return
              await signal
            }
          } finally {
            driving = false
            wake = undefined
          }
        })()
        return driverRun
      }
      /** Every dispatch settled AND committed; nothing can start (the run is aborted at call time). */
      const drainDispatches = async (): Promise<void> => {
        // The abort already fired: the driver abandons queued-unstarted
        // entries, awaits the live pool, and drains the ordered commit lane —
        // including a commit already in progress when the program returned.
        await drive()
        // Every settle event is appended inside the open run_code turn
        // (tasks self-remove on settlement).
        while (logWork.size > 0) await Promise.allSettled([...logWork])
      }

      // Read through a call, not a bare property: the abort state genuinely
      // changes across awaits, and a direct `.aborted` re-check after one
      // would be narrowed away by control flow analysis.
      const runOver = (): boolean => runController.signal.aborted

      const binding = (schema: ToolSchema): PtcBindingFunction => async (rawArgs: unknown): Promise<JsonValue> => {
        const { name } = schema
        if (runOver()) {
          throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} not dispatched`)
        }
        const normalized = jsonNormalizeArgs(rawArgs)
        const n = ++dispatches
        const subCallId = brandString<ToolCallId>(`${String(exec.callId)}:ptc:${n}`)
        const input = {
          callId: subCallId,
          rootCallId: exec.rootCallId,
          name,
          schema,
          arguments: normalized.dispatched,
          ...exec.agent ? { agent: exec.agent } : {},
          parent: exec.token,
          signal: runController.signal,
        }
        type DispatchOutcome = { isError: true; message: string } | { isError: false; value: JsonValue }
        const scheduler = registry[TOOL_RUNTIME_SCHEDULER]
        const outcome = await new Promise<DispatchOutcome>((resolve, reject) => {
          // Set by the dispatch stage (or start() for a pre-settled result): what commit() finalizes in submission order.
          let parked:
            | { kind: 'post-result' | 'final-result'; exec: ToolRunContext; result: ToolExecutionResult }
            | undefined
          const settle = (result: ToolExecutionResult): void => {
            // The program gets its value NOW: the log-content listener (for
            // example, a spill backend) must never delay the binding or occupy
            // a dispatch slot. The event append is tracked side work; the run's
            // settlement drains logWork so every settle event is still appended
            // inside the open turn (shapeDispatchLog is contained, so this
            // chain cannot reject).
            resolve(result.isError
              ? { isError: true, message: result.error.message }
              : { isError: false, value: result.value })
            const agent = exec.agent
            if (agent === undefined) return
            const task: Promise<void> = (async () => {
              // The listener may replace the durable copy with a preview and
              // locator; the program's value and model-visible result are
              // untouched.
              const logged = await shapeDispatchLog({
                exec, agent, subCallId, name, isError: result.isError,
                // The registry deep-froze this projection at result
                // finalization; append snapshots the final copy again, so
                // the log stays detached.
                content: result.content,
              })
              agent.session.append('tool/ptc-dispatch', {
                rootCallId: exec.rootCallId,
                parentCallId: exec.callId,
                subCallId,
                name,
                // The SIBLING parse of the dispatched value: byte-identical JSON,
                // but a separate object — a tool mutating its args cannot desync
                // this record from what it actually received.
                arguments: normalized.logged,
                isError: result.isError,
                ...result.error?.info === undefined ? {} : { error: result.error.info },
                content: logged,
              })
            })().finally(() => { logWork.delete(task) })
            logWork.add(task)
          }
          pendingQueue.push({
            flight: Promise.resolve(),
            settled: false,
            // Re-read per driver pass against the same agent view the SDK
            // declared; fail-closed exclusive when undeclared/invalid.
            classify: () => registry.executionMode(input).kind,
            abandon: () => {
              reject(new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`))
            },
            async start(): Promise<void> {
              exec.agent?.session.append('tool/ptc-dispatch-start', {
                rootCallId: exec.rootCallId,
                parentCallId: exec.callId,
                subCallId,
                name,
                arguments: normalized.logged,
              })
              // Ordered prepare runs INSIDE the driver lane: the next entry's
              // pre-execute waits for this resolution, as under the native
              // scheduler. Only the launched body below overlaps.
              const prepared = await scheduler.prepare(input)
              if (prepared.kind === 'dispatch') {
                this.flight = scheduler.dispatch(prepared.exec).then((dispatchOutcome) => {
                  parked = { kind: dispatchOutcome.kind, exec: prepared.exec, result: dispatchOutcome.result }
                  this.settled = true
                })
                return
              }
              parked = { kind: prepared.kind, exec: prepared.exec, result: prepared.result }
              this.settled = true
            },
            async commit(): Promise<void> {
              /* v8 ignore next -- commit() runs only after `settled` flipped, which set parked. */
              if (parked === undefined) return
              const result = parked.kind === 'post-result'
                ? await scheduler.finalize(parked.exec, parked.result)
                : scheduler.finish(parked.exec, parked.result)
              if (!result.isError && result.content.some(block => block.type === 'image')) {
                exec.deferContext(createUserMessage({
                  content: result.content,
                  source: { kind: 'ptc-mode' },
                }))
              }
              for (const context of result.additionalContexts ?? []) {
                exec.deferContext(context)
              }
              // The composite forwards `additionalContexts` above and
              // `concludesTurn` here from the nested result. Only a successful
              // nested result can carry the terminal marker
              // (ToolExecutionFailure types it never), so a policy-converted
              // failure cannot stop the turn through a recovering program.
              if (result.concludesTurn) exec.concludeTurn()
              settle(result)
              // Backpressure on pending event-append tasks: each task retains
              // a full result while a slow backend stores it, so the pool cap
              // bounds their count. Beyond the cap, the
              // ordered lane waits, so later sub-calls cannot start and
              // pending I/O/memory cannot grow without bound.
              while (logWork.size > maxParallel) await Promise.race(logWork)
            },
          })
          wakeup()
          void drive()
        })
        // A budget expiry or outer cancel that occurs while this call was in
        // flight already aborted the dispatch; stop the program now rather
        // than hand it a result from a run that is over.
        if (runOver()) {
          throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} result discarded`)
        }
        // The worker turns a binding rejection into ToolCallError and adds
        // only the binding name. Native content and internal error metadata
        // stay outside the program-facing failure contract.
        if (outcome.isError) throw new Error(outcome.message)
        return outcome.value
      }

      // Null-prototype + defineProperty, mirroring the worker-side namespace
      // build: a registered tool named `__proto__` must become an ordinary
      // own key (a plain-object assignment would hit the prototype setter,
      // silently dropping the binding), and the runtime host resolves
      // binding names as own properties only.
      const functions: Record<string, PtcBindingFunction> = Object.create(null) as Record<string, PtcBindingFunction>
      // Enumerate the CALLING AGENT's visible set (scoped tools join,
      // restricted globals vanish) — the same view the SDK section declared,
      // so a program can bind exactly what its prompt promised; sub-dispatch
      // re-resolves per call through the same view (exec.agent threads down).
      for (const schema of registry.schemas(exec.agent)) {
        if (schema.name === RUN_CODE_NAME) continue
        Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(deepFreeze(schema)) })
      }

      try {
        let result: PtcRunResult
        try {
          result = await runtime.run(runtime.resolve({
            program: args.code,
            bindings: [{
              global: 'tools',
              functions,
              errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
            }],
            signal: runController.signal,
            ...exec.agent?.session.header.cwd !== undefined ? { cwd: exec.agent.session.header.cwd } : {},
            ...policy !== undefined ? { sandboxPolicy: policy } : {},
            ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
          }))
        } finally {
          // Abort sub-dispatches and drain every in-flight dispatch before
          // closing the turn (queued-unstarted ones are abandoned unlogged).
          // Binding failures remain observable through their individual promises.
          runController.abort('run_code settled')
          await drainDispatches()
        }

        if (result.error) {
          const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join('\n')}` : ''
          const sandboxText = result.sandbox === undefined ? ''
            : `\nFile sandbox: ${result.sandbox.mode}${result.sandbox.enforcement === undefined ? '' : `; enforcement: ${result.sandbox.enforcement}`}${result.sandbox.denied ? '; operation denied' : ''}.`
          throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}${sandboxText}${result.sandbox?.denied ? escalationGuidance(runtime) : ''}`)
        }
        return {
          logs: result.logs,
          ...result.sandbox === undefined ? {} : { sandbox: result.sandbox },
          ...result.value !== undefined ? { result: result.value } : {},
        }
      } finally {
        exec.signal.removeEventListener('abort', onOuterAbort)
      }
    },
    // The model-authored description is the call's always-visible UI label
    // (the bash `description` precedent); the program itself rides rawInput.
    presentCall: args => ({
      card: 'generic',
      title: args.description,
      kind: 'execute',
      rawInput: args.code,
    }),
    // Deliberately no presentResult: the generic card fallback keeps this
    // title and reads durable result content without duplicating a large raw
    // result into the host view payload.
  })
  // Resolve the language flavor lazily, at the moment the registry projects the
  // schema (`schemaOf` destructures `description`/`parameters`). The definition
  // is minted once at registration, before a runtime is known; deferring here
  // is the least invasive point that still emits the loaded runtime's language.
  Object.defineProperty(definition, 'description', {
    enumerable: true,
    get: () => {
      const runtime = peekRuntime()
      const instructions = runtime?.executionInstructions
      return resolveFlavor(peekRuntime).description
        + (instructions ? ` ${instructions}` : '')
        + (runtime === undefined ? '' : " The working directory is the Session's current directory.")
        + escalationGuidance(runtime)
    },
  })
  Object.defineProperty(definition, 'parameters', {
    enumerable: true,
    // Recompile through the same spec→schema projection defineTool used, so
    // the emitted schema always matches the validated specification.
    get: () => parameterSchemaSpecToJsonSchema({
      code: { type: 'string', required: true, description: resolveFlavor(peekRuntime).codeDescription },
      description: { type: 'string', required: true, description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION },
      ...controlParameters(peekRuntime()),
    }) as unknown as Record<string, unknown>,
  })
  return definition
}
