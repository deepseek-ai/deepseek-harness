/**
 * Shared program transport. Programs call their admitted tools through nested
 * executions scheduled under the native concurrency contract; each sub-dispatch
 * is logged for reconstruction, while only the outer curated result enters model
 * history.
 * @module
 */

import { isDeepStrictEqual } from 'node:util'
import type { PtcDispatchLog } from './runtime-types.ts'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, HarnessError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'

import type { ContentBlock, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import { PtcImage } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcOutput } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingFunction, PtcRunResult, PtcRunSandbox, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { approveEscalation, ESCALATION_TARGETS, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { deepFreeze, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  defineTool, parameterSchemaSpecToJsonSchema, projectToolSchema, RUN_CODE_NAME, TOOL_ABORTED, ToolArgsError,
  ToolContextUnavailableError,
} from '@deepseek-ai/dsh-tools'
import type { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { PtcCalls } from './ptc-calls.ts'
import { CodeRunFailedError, ToolCallLimitExceededError } from './errors.ts'
import type { Config } from './config.ts'
import type { RunCodeToolOptions } from './run-code.ts'
import type { ToolDefinition, ToolExecution, ToolExecutionFailure, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from './types.ts'

/** The model-facing name of the PTC mode tool. */
export { RUN_CODE_NAME }

/** Tool and code-parameter descriptions for one program format. */
interface RunCodeFlavor {
  /** The tool `description` the model sees for this language. */
  readonly description: string
  /** The `code` parameter's description for this language. */
  readonly codeDescription: string
}

/** Keep tool-call rules here; the runtime owns evaluation syntax and state retention. */
function runCodeFlavor(language: string, outputInstruction: string, execution = {
  programDescription: 'the program to execute',
  codeDescription: `The ${language} program to execute, following this tool's execution instructions.`,
}): RunCodeFlavor {
  return {
    description: `Execute a ${language} program against the available tools. Takes two required arguments: `
      + `\`code\`, ${execution.programDescription}, and \`description\`, a short summary of what the program does. `
      + 'Call tools as `await tools.name(args)` per the declarations in the system prompt. '
      + outputInstruction,
    codeDescription: execution.codeDescription,
  }
}

const TYPESCRIPT_OUTPUT_INSTRUCTION = 'Show selected text and images with inspect(...values).'
const TYPESCRIPT_FLAVOR = runCodeFlavor('TypeScript', TYPESCRIPT_OUTPUT_INSTRUCTION)
const TYPESCRIPT_FUNCTION_FLAVOR = runCodeFlavor('TypeScript', TYPESCRIPT_OUTPUT_INSTRUCTION, {
  programDescription: 'the BODY of an async function (erasable syntax only; top-level `await` and `return` work)',
  codeDescription: 'The program: the body of an async TypeScript function.',
})
/**
 * Read the active runtime, rejecting missing providers and unsupported languages.
 * @param ctx - executor context containing the runtime provider.
 * @returns the mounted TypeScript provider.
 */
export function requirePtcRuntime(ctx: Context): PtcRuntime {
  const runtime = ctx.get('ptcRuntime')
  if (runtime === undefined) {
    throw new ToolContextUnavailableError('dsh-tools: mode "ptc" requires a PTC runtime — load a ctx.ptcRuntime implementation (e.g. @deepseek-ai/dsh-ptc-runtime-node) or load @deepseek-ai/dsh-tool-executor-native')
  }
  return requireRuntimeLanguage(runtime)
}

/**
 * Reject providers whose source language the executor cannot present.
 * @param runtime - Mounted or explicitly supplied provider.
 * @returns The supported provider.
 * @throws ToolContextUnavailableError for a language other than TypeScript.
 */
export function requireRuntimeLanguage(runtime: PtcRuntime): PtcRuntime {
  if (runtime.language !== 'typescript') {
    throw new ToolContextUnavailableError(`dsh-tools: unsupported PTC runtime language ${JSON.stringify(runtime.language)}; use a TypeScript provider (language: "typescript")`)
  }
  return runtime
}

/** The shared UI-label description for the static spec and program-format-aware parameters getter. */
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
  = 'Clear, concise description of what this program does in active voice, '
    + '5-10 words (shown in the UI). '
    + 'Examples: "Count TODO markers across packages"; '
    + '"Read failing test and its fixture"; "Rename config key in every cordis.yml".'

const RUN_CODE_CONTROLS = {
  timeoutMs: { type: 'number', description: 'Positive elapsed-time budget in milliseconds, capped by the deployment maximum.' },
  sandbox_permissions: { type: 'string', enum: [...ESCALATION_TARGETS], description: 'Wider sandbox mode for this complete program execution; requires justification and approval.' },
  justification: { type: 'string', description: 'Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request.' },
} as const

function controlParameters(runtime: PtcRuntime) {
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

function escalationGuidance(mode: PtcRuntime['sandboxMode']): string {
  return mode === undefined ? ''
    : ' A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying. Programs are never replayed automatically.'
}

/** Match schema text to the runtime program syntax. */
function resolveFlavor(runtime: PtcRuntime): RunCodeFlavor {
  return runtime.programFormat === 'function-body' ? TYPESCRIPT_FUNCTION_FLAVOR : TYPESCRIPT_FLAVOR
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

/** Whether a rejection is the caller's cancellation rather than a failure of its own. */
function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
}

/** Canonical value returned by the outer PTC mode transport. */
type RunCodeOutput = { logs: string[]; sandbox?: PtcRunSandbox }

/** Render captured text, selected images, and the applied file policy in emission order. */
function renderRunOutput(
  value: RunCodeOutput,
  guidance: string,
  output: PtcOutput[] = value.logs.map(text => ({ type: 'text', text })),
  toolName: string,
): ContentBlock[] {
  const content: ContentBlock[] = []
  const appendText = (text: string): void => { if (text.length > 0) content.push({ type: 'text', text }) }
  const remaining: string[] = []
  for (const block of output) {
    if (block.type === 'text') remaining.push(block.text)
    else {
      appendText(remaining.join(''))
      remaining.length = 0
      content.push(block)
    }
  }
  appendText(remaining.join(''))
  const details: string[] = []
  if (value.sandbox?.enforcement === 'partial') details.push('File sandbox enforcement is partial on this host.')
  if (value.sandbox?.denied) details.push(`The ${value.sandbox.mode} file sandbox denied an operation.${guidance}`)
  appendText(details.filter(text => text.length > 0).join('\n'))
  return content.length > 0 ? content : [{ type: 'text', text: `(${toolName} completed with no output)` }]
}

/** Unowned programs do not require Session directory state. */
async function resolveWorkingDirectory(ctx: Context, exec: ToolRunContext): Promise<string | undefined> {
  if (exec.agent === undefined) return undefined
  const directories = ctx.get('workingDirectory')
  if (directories === undefined) throw new ToolContextUnavailableError('dsh-tools: run_code with an Agent requires workingDirectory')
  return directories.ensure(exec.agent, exec.signal)
}

/** Resolve standing authority for a runtime that enforces file policy. */
function resolveSandboxPolicy(ctx: Context, exec: ToolRunContext): SandboxExecutionPolicy {
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined) throw new ToolContextUnavailableError('dsh-tools: confined PTC runtime requires sandboxPolicy')
  return policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
}

/**
 * Build a program transport using the shared nested-call scheduler.
 * @param ctx - executor context owning policy listeners and active program cleanup.
 * @param executor - shared invocation pipeline for nested calls.
 * @param config - validated timeout-based tool-call allowance and concurrency limits.
 * @param calls - Executor-owned cancellation and reset coordination.
 * @param options - Fixed runtime and tools for a registered program tool; omission selects PTC's visible registry and current runtime.
 * @returns the transport definition with runtime-dependent schema text.
 */
export function createRunCodeTransport(
  ctx: Context,
  executor: ToolExecutionPipeline,
  config: Config,
  calls: PtcCalls,
  options?: Omit<RunCodeToolOptions, 'limits'>,
): ToolDefinition {
  const { maxSubCallsPerMinute, maxParallelSubCalls: maxParallel } = config
  const toolName = options?.name ?? RUN_CODE_NAME
  const getRuntime = options === undefined ? () => requirePtcRuntime(ctx) : () => requireRuntimeLanguage(options.runtime)
  // Retain services for log settlement after the executor context becomes inactive.
  const tools = ctx.tools
  const logger = ctx.logger

  /** A failed log-content listener preserves the settled content and cannot fail the dispatch. */
  async function shapeDispatchLog(dispatch: PtcDispatchLog): Promise<ContentBlock[]> {
    try {
      return await ctx.waterfall(
        scopeTarget(tools, dispatch.agent), 'tools/ptc-dispatch-log', dispatch,
        () => Promise.resolve(dispatch.content),
      )
    } catch (error: unknown) {
      logger.warn(`tools: ptc-dispatch-log listener failed for ${dispatch.name}: ${toolErrorMessage(error)}; logging the original settled content`)
      return dispatch.content
    }
  }

  type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']
  const inspections = new WeakMap<ToolExecution, {
    value?: RunCodeOutput
    failure?: Pick<ToolExecutionFailure, 'error' | 'content'>
    output: PtcOutput[]
  }>()
  const programImage = (ref: ImageRef): PtcImage => {
    const attachments = ctx.get('attachments')
    const fs = ctx.get('fs')
    const access = attachments === undefined || fs === undefined ? undefined
      : resolveImageAttachmentAccess(attachments, path => fs.processPathFromHostPath(path), ref)
    if (access === undefined) throw new Error('Image storage must expose a readable path in the program filesystem')
    return new PtcImage(access.readonlyPath, ref)
  }
  const stateOwners = new WeakMap<object, WeakSet<PtcRuntime>>()
  const definition = defineTool({
    name: toolName,
    // Getters below project the current program format; argument validation uses this static spec.
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
      render: (_args, value) => renderRunOutput(value,
        escalationGuidance(options === undefined ? ctx.get('ptcRuntime')?.sandboxMode : options.runtime.sandboxMode), undefined, toolName),
    },
    async execute(args, exec): Promise<RunCodeOutput> {
      if (args.description.trim().length === 0) {
        throw new ToolArgsError(['invalid description: expected a non-empty string'])
      }
      const runtime = getRuntime()
      const run = async (callSignal: AbortSignal): Promise<RunCodeOutput> => {
        // The schema omits both fields without runtime confinement; reject them before pairing checks.
        if (runtime.sandboxMode === undefined && (args.sandbox_permissions !== undefined || args.justification !== undefined)) {
          throw new ToolArgsError(['sandbox_permissions and justification are not available for this PTC runtime'])
        }
        validateEscalationArgs(args.sandbox_permissions, args.justification)
        if (args.timeoutMs !== undefined && runtime.timeout === undefined) {
          throw new ToolArgsError(['timeoutMs is not available for this PTC runtime'])
        }
        if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
          throw new ToolArgsError(['invalid timeoutMs: expected a positive finite number'])
        }
        const standingPolicy = runtime.sandboxMode === undefined ? undefined : resolveSandboxPolicy(ctx, exec)
        let policy = standingPolicy
        if (args.sandbox_permissions !== undefined && args.justification !== undefined) {
          const confined = standingPolicy as SandboxExecutionPolicy
          const approvedMode = await approveEscalation({
            requestedMode: args.sandbox_permissions,
            justification: args.justification,
            effectiveMode: confined.mode,
            subject: 'program',
          }, {
            approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId,
            toolName, signal: callSignal,
          })
          policy = { ...confined, mode: approvedMode }
        }
        const cwd = await resolveWorkingDirectory(ctx, { ...exec, signal: callSignal })
        callSignal.throwIfAborted()

        // The run-scoped abort: follows the outer signal in, and fires when the
        // run settles for ANY reason, so an in-flight sub-dispatch is aborted
        // (its executor kills on this signal) instead of orphaned, and
        // queued-unstarted dispatches are abandoned.
        const runController = new AbortController()
        const onOuterAbort = (): void => { runController.abort(callSignal.reason) }
        callSignal.addEventListener('abort', onOuterAbort, { once: true })

        let toolCallAttempts = 0
        let maxSubCalls: number
        // The per-run scheduler uses the registry's staged interface and follows
        // the same concurrency rules as the native loop. It also follows the
        // native loop's SEQUENCING: every ordered stage (the dispatch-start
        // append, prepare = pre-execute/guards, complete = post-execute,
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
          // FIXME: Let image-producing tools declare their program result adaptation.
          const usesProgramImage = name === 'read_image' || name === 'cua'
          if (runOver()) {
            throw new Error(`${toolName} run is over (${String(runController.signal.reason)}); ${name} not dispatched`)
          }
          // Count before validation and queuing so repeated failed calls also exhaust the allowance.
          const n = ++toolCallAttempts
          if (n > maxSubCalls) {
            const error = new ToolCallLimitExceededError(maxSubCalls, n, maxSubCallsPerMinute, toolName)
            runController.abort(error)
            throw error
          }
          const normalized = jsonNormalizeArgs(rawArgs)
          const subCallId = brandString<ToolCallId>(`${String(exec.callId)}:ptc:${n}`)
          const input = {
            callId: subCallId,
            rootCallId: exec.rootCallId,
            name,
            schema,
            arguments: normalized.dispatched,
            ...exec.agent ? { agent: exec.agent } : {},
            ...exec.toolSet !== undefined ? { toolSet: exec.toolSet } : {},
            parent: exec.token,
            signal: runController.signal,
          }
          type DispatchOutcome = { isError: true; message: string }
            | { isError: false; value: JsonValue; content: ContentBlock[]; imageRemoved: boolean }
          const outcome = await new Promise<DispatchOutcome>((resolve, reject) => {
            // Set by the dispatch stage (or start() for a pre-settled result): what commit() finalizes in submission order.
            let parked:
              | { kind: 'post-result' | 'final-result'; exec: ToolRunContext; result: ToolExecutionResult }
              | undefined
            const settle = (result: ToolExecutionResult, imageRemoved: boolean): void => {
              // The program gets its value NOW: the log-content listener (for
              // example, a spill backend) must never delay the binding or occupy
              // a dispatch slot. The event append is tracked side work; the run's
              // settlement drains logWork so every settle event is still appended
              // inside the open turn (shapeDispatchLog is contained, so this
              // chain cannot reject).
              resolve(result.isError
                ? { isError: true, message: result.error.message }
                : { isError: false, value: result.value, content: result.content, imageRemoved })
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
                  ...result.meta === undefined ? {} : { meta: result.meta },
                })
              })().finally(() => { logWork.delete(task) })
              logWork.add(task)
            }
            pendingQueue.push({
              flight: Promise.resolve(),
              settled: false,
              // Re-read per driver pass against the same agent view the SDK
              // declared; fail-closed exclusive when undeclared/invalid.
              classify: () => executor.executionMode(input).kind,
              abandon: () => {
                reject(new Error(`${toolName} run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`))
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
                const prepared = await executor.prepare(input)
                if (prepared.kind === 'dispatch') {
                  this.flight = executor.dispatch(prepared.exec).then((dispatchOutcome) => {
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
                const result = await executor.complete(parked.exec, parked)
                if (!usesProgramImage && !result.isError && result.content.some(block => block.type === 'image')) {
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
                settle(result, parked.result.content.some(block => block.type === 'image')
                  && !result.content.some(block => block.type === 'image'))
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
            throw new Error(`${toolName} run is over (${String(runController.signal.reason)}); ${name} result discarded`)
          }
          // The worker turns a binding rejection into ToolCallError and adds
          // only the binding name. Native content and internal error metadata
          // stay outside the program-facing failure contract.
          if (outcome.isError) throw new Error(outcome.message)
          if (usesProgramImage) {
            const images = outcome.content.filter(block => block.type === 'image')
            const first = images[0]
            if (first !== undefined && images.length === 1) return programImage(first.attachment)
            if (outcome.imageRemoved) {
              throw new Error('Image output was removed by a tool output policy.\n'
                + outcome.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
            }
            if (name === 'read_image' || images.length > 1) throw new Error('Image-producing tools must return exactly one image')
          }
          return outcome.value
        }

        // Null-prototype + defineProperty, mirroring the worker-side namespace
        // build: a registered tool named `__proto__` must become an ordinary
        // own key (a plain-object assignment would hit the prototype setter,
        // silently dropping the binding), and the runtime host resolves
        // binding names as own properties only.
        const functions: Record<string, PtcBindingFunction> = Object.create(null) as Record<string, PtcBindingFunction>
        // PTC uses step-admitted registry tools; a registered program tool uses
        // only its private definitions, resolved by its own pipeline on each call.
        const schemas = options === undefined ? tools.schemas(exec.agent, exec.toolSet)
          : options.tools.map(definition => projectToolSchema(definition, true))
        for (const schema of schemas) {
          Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(deepFreeze(schema)) })
        }

        try {
          let result: PtcRunResult
          try {
            if (exec.agent !== undefined) {
              const agent = exec.agent
              let runtimes = stateOwners.get(agent)
              if (runtimes === undefined) stateOwners.set(agent, runtimes = new WeakSet())
              // Cordis can wrap service returns repeatedly; cleanup belongs to the original provider.
              let provider: PtcRuntime = runtime
              for (;;) {
                const original = (provider as PtcRuntime & { [symbols.original]?: PtcRuntime })[symbols.original]
                if (original === undefined) break
                provider = original
              }
              if (!runtimes.has(provider)) {
                agent.ctx.effect(() => () => runtime.release(agent), 'PTC retained environment')
                runtimes.add(provider)
              }
            }
            const spec = runtime.resolve({
              program: args.code,
              discardCompletion: true,
              ...exec.agent === undefined || policy?.mode !== standingPolicy?.mode ? {} : { stateOwner: exec.agent },
              bindings: [{
                global: 'tools',
                functions,
                errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
              }],
              signal: runController.signal,
              ...cwd !== undefined ? { cwd } : {},
              ...policy !== undefined ? { sandboxPolicy: policy } : {},
              ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
            })
            maxSubCalls = spec.timeoutMs === null ? Infinity
              : Math.floor(spec.timeoutMs / 60_000 * maxSubCallsPerMinute)
            result = await runtime.run(spec)
          } catch (error) {
            // Runtimes reject only contract misuse; a rejection without its own code becomes CODE_RUN_FAILED.
            // The cancellation itself passes through for the registry to classify as ABORTED.
            if (error instanceof HarnessError || isCancellation(error, callSignal)) throw error
            throw new CodeRunFailedError(`code run failed: ${toolErrorMessage(error)}`, 'CODE_RUN_FAILED', { cause: error })
          } finally {
            // Abort sub-dispatches and drain every in-flight dispatch before
            // closing the turn (queued-unstarted ones are abandoned unlogged).
            // Binding failures remain observable through their individual promises.
            runController.abort(`${toolName} settled`)
            await drainDispatches()
          }

          const logs = result.output.flatMap(block => block.type === 'text' ? [block.text] : [])
          const hasImages = result.output.some(block => block.type === 'image')
          if (result.error) {
            const limitError = runController.signal.reason instanceof ToolCallLimitExceededError
              ? runController.signal.reason : undefined
            let failure: HarnessError
            if (result.error.kind === 'abort' && exec.signal.aborted && limitError === undefined) {
              const message = runtime.retainsState ? `tool call aborted: ${result.error.message}` : 'tool call aborted'
              failure = new HarnessError(message, TOOL_ABORTED)
              failure.name = 'AbortError'
            } else {
              const logsText = logs.length > 0 && !hasImages
                ? `\nCaptured output:\n${logs.join('')}` : ''
              const sandboxText = result.sandbox === undefined ? ''
                : `${logsText.endsWith('\n') ? '' : '\n'}File sandbox: ${result.sandbox.mode}${result.sandbox.enforcement === undefined ? '' : `; enforcement: ${result.sandbox.enforcement}`}${result.sandbox.denied ? '; operation denied' : ''}.`
              const failureText = limitError === undefined || limitError.message === result.error.message
                ? result.error.message : `${limitError.message}\n${result.error.message}`
              failure = new CodeRunFailedError(`code run failed (${result.error.kind}): ${failureText}${logsText}${sandboxText}${result.sandbox?.denied ? escalationGuidance(runtime.sandboxMode) : ''}`)
            }
            if (hasImages) inspections.set(exec, {
              failure: {
                error: { message: failure.message, info: { name: failure.name, code: failure.code } },
                content: [{ type: 'text', text: `Error: ${failure.message}` }],
              },
              output: result.output,
            })
            throw failure
          }
          const value: RunCodeOutput = {
            logs,
            ...result.sandbox === undefined ? {} : { sandbox: result.sandbox },
          }
          if (hasImages) inspections.set(exec, { value, output: result.output })
          return value
        } finally {
          callSignal.removeEventListener('abort', onOuterAbort)
        }
      }
      return exec.agent === undefined || (runtime.sandboxMode === undefined && !runtime.retainsState) ? run(exec.signal)
        : calls.run(exec.agent.session.id, exec.signal,
          () => runtime.sandboxMode === undefined ? undefined : resolveSandboxPolicy(ctx, exec).mode, run)
    },
    projectContent(exec, result) {
      const selected = inspections.get(exec)
      inspections.delete(exec)
      if (selected === undefined) return undefined
      if (result.isError) {
        if (!isDeepStrictEqual(selected.failure, { error: result.error, content: result.content })) return undefined
        return [...result.content, ...renderRunOutput({ logs: [] }, '', selected.output, toolName)]
      }
      if (selected.value === undefined || !isDeepStrictEqual(selected.value, result.value)) return undefined
      return renderRunOutput(selected.value,
        escalationGuidance(options === undefined ? ctx.get('ptcRuntime')?.sandboxMode : options.runtime.sandboxMode), selected.output, toolName)
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
  // Read current runtime instructions and controls whenever the schema is projected.
  Object.defineProperty(definition, 'description', {
    enumerable: true,
    get: () => {
      const runtime = getRuntime()
      const instructions = runtime.executionInstructions
      return (options?.description ?? resolveFlavor(runtime).description)
        + (instructions ? ` ${instructions}` : '')
        + " Each program starts in the Session's current directory. Running programs keep their initial directory."
        + escalationGuidance(runtime.sandboxMode)
    },
  })
  Object.defineProperty(definition, 'parameters', {
    enumerable: true,
    // Recompile through the same spec→schema projection defineTool used, so
    // the emitted schema always matches the validated specification.
    get: () => {
      const runtime = getRuntime()
      return parameterSchemaSpecToJsonSchema({
        code: { type: 'string', required: true, description: resolveFlavor(runtime).codeDescription },
        description: { type: 'string', required: true, description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION },
        ...controlParameters(runtime),
      })
    },
  })
  return definition
}
