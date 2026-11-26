/** Shared tool invocation policy, cancellation, and result settlement. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { assertNever, deepFreeze, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH, ToolCompositionError, ToolNotFoundError, ToolOutputError } from './contracts.ts'
import { APPROVAL_CANCELLED, APPROVAL_ERROR_NAME, APPROVAL_REJECTED, APPROVAL_UNAVAILABLE, type ApprovalErrorCode } from './error-codes.ts'
import { validateJsonSchemaValue } from './json-schema.ts'
import type { ToolsService } from './index.ts'
import type { ToolStep } from './step.ts'
import type { ToolDefinition, ToolExecutionInput, ToolExecutionMode, ToolExecution, ToolRunContext, ToolExecutionResult, ToolExecutionSuccess, ToolErrorInfo, ToolExecutionToken, PreToolDecision, PostToolDecision } from './contracts.ts'

/** Registry-owned lookup and refusals for the calls one pipeline runs. */
export interface ToolExecutionSource {
  /**
   * Resolve the definition one call may execute. Registries apply the call's
   * model-step declarations here; undefined fails the call as `UNKNOWN_TOOL`.
   * A throw fails only that call. During preparation it fails the call before
   * policy: classification runs the call alone, and preparation settles it
   * with the error. Dispatch repeats the lookup, so a throw first met there
   * fails the call after `tools/pre-execute`, approval, guards, and
   * `tools/execute` wrappers, and `tools/post-execute` sees the failure. A
   * `ToolCompositionError` is logged with its message, and the call fails
   * with a message that tells the model the tool is misconfigured.
   * @param name - called tool name.
   * @param scope - calling Agent, or undefined for a standalone call.
   * @param toolStep - model step admitting the call, or undefined outside a step.
   * @returns the definition to execute, or undefined.
   */
  get(name: string, scope: ScopeKey | undefined, toolStep: ToolStep | undefined): ToolDefinition | undefined
  /**
   * Refuse one call before extensible policy runs, for example a model-direct
   * call to a tool the registry offers only inside programs. A refused call
   * carries no definition and settles without `tools/pre-execute`, approval,
   * guards, `tools/execute`, `tools/post-execute`, or definition callbacks;
   * cancellation takes precedence over the refusal, and a throw refuses the
   * call with the thrown error, a `ToolCompositionError` replaced as `get`
   * describes. Omitted, or undefined, lets the call continue:
   * a call whose name resolves to no definition then runs policy and fails at
   * dispatch as `UNKNOWN_TOOL`.
   * @param exec - the call as the caller supplied it.
   * @returns the error the call settles with, or undefined.
   */
  reject?(exec: ToolExecutionInput): Error | undefined
}

/** Prepared invocation; immediate results carry their post-execute requirement. */
export type ScheduledToolPreparation =
  | { kind: 'dispatch'; exec: ToolRunContext }
  | ({ exec: ToolRunContext } & ScheduledToolDispatch)

/** A `post-result` receives post-execute; a `final-result` bypasses it. */
export type ScheduledToolDispatch =
  | { kind: 'post-result'; result: ToolExecutionResult }
  | { kind: 'final-result'; result: ToolExecutionResult }

/** Registry-owned live execution object; public pipeline views stay readonly. */
type MutableToolRunContext = Omit<ToolRunContext, 'signal'> & { signal: AbortSignal }

/** Approval decision plus whether the approval channel reported cancellation. */
interface ToolAskResolution {
  readonly decision: Extract<PreToolDecision, { kind: 'allow' | 'deny' }>
  readonly approvalCancelled: boolean
}

/** Caller cancellation and dispatch state kept outside the around-wrapper view. */
interface ToolCancellationState {
  readonly callerSignal: AbortSignal
  bodyInvoked: boolean
}

/** One dispatch-scoped fused signal plus listener cleanup after the body settles. */
interface FusedToolSignal {
  readonly signal: AbortSignal
  dispose(): void
}

/**
 * Shared invocation stages for batch and program schedulers. Schedulers order
 * prepare and complete calls while dispatch may overlap. Use executeToolBatch
 * for complete calls, including a single-call batch.
 */
export class ToolExecutionPipeline {
  private readonly tools: ToolsService

  /**
   * @param ctx - registry context owning policy events and approval lookup.
   * @param source - registry lookup and refusals for every call this pipeline runs.
   */
  constructor(private readonly ctx: Context, private readonly source: ToolExecutionSource) {
    // Accepted calls retain their event subject while the service is withdrawn during shutdown.
    this.tools = ctx.tools
  }

  private resolveExecution(exec: ToolExecutionInput): ToolDefinition | undefined {
    return this.source.get(exec.name, exec.agent, exec.toolStep)
  }

  /**
   * Run one source lookup or refusal for a call being prepared or dispatched.
   * A composition failure, such as two definitions that appear under the
   * call's name during a step, is logged once with its message, and the call
   * fails with a message the model can act on.
   * @param call - name, call id, and Agent of the call the lookup serves.
   * @param lookup - source lookup or refusal.
   * @returns the lookup result.
   * @throws ToolCompositionError with the model-facing message when the lookup meets a composition failure.
   */
  private lookup<T>(call: Pick<ToolExecutionInput, 'name' | 'callId' | 'agent'>, lookup: () => T): T {
    try {
      return lookup()
    } catch (error: unknown) {
      if (!(error instanceof ToolCompositionError)) throw error
      const caller = call.agent === undefined ? '' : ` from Agent ${call.agent.id}`
      this.ctx.logger.warn(`tool "${call.name}" (call ${call.callId}${caller}) cannot run: ${error.message}`)
      throw new ToolCompositionError(`tool "${call.name}" cannot run because it is misconfigured in this environment; do not retry it; use another tool or tell the user`)
    }
  }

  /**
   * The definition prepare captured for one call, while the source still offers exactly it; checked as dispatch starts.
   * @throws ToolNotFoundError when prepare captured none or the source now resolves another definition or none.
   * @throws ToolCompositionError when the lookup meets a composition failure.
   */
  private capturedDefinition(exec: ToolExecution): ToolDefinition {
    const definition = this.dispatchedDefinition(exec)
    if (this.lookup(exec, () => this.resolveExecution(exec)) !== definition) throw new ToolNotFoundError(exec.name)
    return definition
  }

  /**
   * The definition whose output contract a dispatched call's result follows. A
   * call that started keeps it even if its source withdraws the tool meanwhile.
   * @throws ToolNotFoundError when prepare captured no definition.
   */
  private dispatchedDefinition(exec: ToolExecution): ToolDefinition {
    const definition = exec.definition
    if (definition === undefined) throw new ToolNotFoundError(exec.name)
    return definition
  }

  /** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
  private deferredContexts = new WeakMap<ToolRunContext, UserMessage[]>()

  /** Executions whose tool body declared the current turn complete. */
  private concludingExecutions = new WeakSet<ToolExecution>()

  /** Original caller cancellation, kept outside the wrapper-mutable execution object. */
  private cancellationStates = new WeakMap<ToolRunContext, ToolCancellationState>()

  /** Definition-owned final content transform snapshotted before policy begins. */
  private contentFinalizers = new WeakMap<ToolRunContext, ToolDefinition['finalizeContent']>()

  /** Execution-prepared content installed before post-execute policy. */
  private contentProjectors = new WeakMap<ToolRunContext, ToolDefinition['projectContent']>()

  /**
   * Classify a pending call through the caller's visible tool definition. Only
   * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
   * throwing classifiers are exclusive, and so is a call whose lookup throws,
   * which preparation then fails alone.
   * @param exec - call name, parsed arguments, and optional agent scope.
   * @returns the fail-closed scheduling mode.
   */
  executionMode(exec: ToolExecutionInput): ToolExecutionMode {
    try {
      const tool = this.resolveExecution(exec)
      if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }
      const concurrencySafe: unknown = tool.isConcurrencySafe(exec.arguments)
      return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' }
    } catch {
      // Preparation repeats the lookup and settles the call with its failure.
      return { kind: 'exclusive' }
    }
  }

  private createExecution(exec: ToolExecutionInput): ScheduledToolPreparation | { kind: 'ready'; exec: MutableToolRunContext } {
    const deferredContexts: UserMessage[] = []
    const token = createExecutionToken()
    const callId = exec.callId
    const rootCallId = exec.rootCallId ?? callId
    const name = exec.name
    const agent = exec.agent
    const parent = exec.parent
    const signal = exec.signal
    // Refused calls settle before policy; other unknown tools run policy and fail at dispatch.
    // A lookup that throws, such as on an ambiguity that appears during a step, fails only this call, before policy.
    let visible: ToolDefinition | undefined
    let refusal: { readonly error: unknown } | undefined
    try {
      // The snapshotted identity keeps the input's getters from running again.
      const call = { name, callId, ...agent !== undefined ? { agent } : {} }
      visible = this.lookup(call, () => this.source.get(name, agent, exec.toolStep))
      const rejection = this.lookup(call, () => this.source.reject?.(exec))
      if (rejection !== undefined) refusal = { error: rejection }
    } catch (error: unknown) {
      refusal = { error }
    }
    // A refused call carries no definition, so none of its callbacks run.
    if (refusal !== undefined) visible = undefined
    const concludingExecutions = this.concludingExecutions
    const base = {
      token,
      callId,
      rootCallId,
      name,
      signal,
      ...agent !== undefined ? { agent } : {},
      ...exec.toolStep !== undefined ? { toolStep: exec.toolStep } : {},
      ...visible !== undefined ? { definition: visible } : {},
      ...parent !== undefined ? { parent } : {},
      ...exec.schema !== undefined ? { schema: exec.schema } : {},
      deferContext(context: UserMessage): void {
        deferredContexts.push(context)
      },
      concludeTurn(this: ToolExecution): void {
        concludingExecutions.add(this)
      },
    }
    // Capture callbacks before argument getters run.
    const capturedFinalizer = visible?.finalizeContent?.bind(visible)
    const capturedProjector = visible?.projectContent?.bind(visible)
    try {
      const detached = snapshotJsonValue(exec.arguments)
      if (detached === undefined) {
        throw new TypeError('tool execution arguments must be losslessly JSON-serializable')
      }
      const execution: MutableToolRunContext = { ...base, arguments: deepFreeze(detached) }
      this.deferredContexts.set(execution, deferredContexts)
      this.contentFinalizers.set(execution, capturedFinalizer)
      this.cancellationStates.set(execution, {
        callerSignal: signal,
        bodyInvoked: false,
      })
      if (refusal !== undefined) {
        const result = signal.aborted ? toolAbortedBeforeDispatchResult() : toolErrorResult(refusal.error)
        return { kind: 'final-result', exec: execution, result }
      }
      this.contentProjectors.set(execution, capturedProjector)
      return { kind: 'ready', exec: execution }
    } catch (error: unknown) {
      const execution: MutableToolRunContext = { ...base, arguments: undefined }
      this.contentFinalizers.set(execution, capturedFinalizer)
      return { kind: 'final-result', exec: execution, result: toolErrorResult(error) }
    }
  }

  /**
   * Snapshot input, assign its correlation token, settle a call the source
   * refuses, and run ordered pre-execute policy and guards for the others.
   * A refused call reaches no policy, approval, guard, or execution wrapper.
   * Cancellation skips a body that has not started and takes precedence over
   * a refusal.
   * @param input - the caller-supplied execution input.
   * @returns the prepared execution plus the next scheduler stage.
   */
  async prepare(input: ToolExecutionInput): Promise<ScheduledToolPreparation> {
    const created = this.createExecution(input)
    if (created.kind !== 'ready') return created
    const exec = created.exec
    if (this.callerCancelled(exec)) {
      return { kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() }
    }
    try {
      const carrier = scopeTarget(this.tools, exec.agent)
      const gate = await this.ctx.waterfall(
        carrier, 'tools/pre-execute', exec,
        () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
      )
      const askResolution = gate.kind === 'ask'
        ? await this.serviceAsk(exec, gate)
        : { decision: gate, approvalCancelled: false }
      const { decision } = askResolution
      if (this.callerCancelled(exec) && askResolution.approvalCancelled) {
        return { kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() }
      }
      if (decision.kind === 'cancel') {
        return { kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() }
      }
      const denial = decision.kind === 'allow' ? this.tools.checkGuards(exec) : decision
      if (denial !== undefined) {
        const { reason: denialReason, info: denialInfo } = denial
        return {
          kind: 'post-result',
          exec,
          result: this.materializeFinalResult({
            content: [{ type: 'text', text: `Error: ${denialReason}` }],
            isError: true,
            error: { message: denialReason, ...denialInfo === undefined ? {} : { info: denialInfo } },
          }),
        }
      }
      if (this.callerCancelled(exec)) {
        return { kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() }
      }
      return { kind: 'dispatch', exec }
    } catch (error: unknown) {
      return { kind: 'final-result', exec, result: toolErrorResult(error) }
    }
  }

  /** Whether the original caller signal is currently aborted. */
  private callerCancelled(exec: ToolRunContext): boolean {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    return state.callerSignal.aborted
  }

  /** Canonical cancellation outcome selected by whether the tool body started. */
  private cancellationResult(exec: ToolRunContext, prior?: ToolExecutionResult): ToolExecutionResult {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    return state.bodyInvoked
      ? toolAbortedResult(prior)
      : toolAbortedBeforeDispatchResult(prior)
  }

  /**
   * Dispatch the registered body with the original caller signal fused back
   * into any around-wrapper replacement. Cancellation never abandons the body:
   * a started promise reaches quiescence before its outcome becomes `ABORTED`.
   * After cancellation, a thrown signal reason or an `Error` named
   * `AbortError` without `HarnessError` identity keeps its message and gains
   * the `ABORTED` identity, whichever operation inside the body aborted; a
   * thrown `HarnessError` and any other failure stay unchanged.
   */
  private async dispatchToolBody(exec: MutableToolRunContext): Promise<ToolExecutionResult> {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    const wrapperSignal = exec.signal
    const fused = fuseToolSignals(state.callerSignal, wrapperSignal)
    const signal = fused.signal

    if (isAborted(signal)) {
      fused.dispose()
      return toolAbortedBeforeDispatchResult()
    }
    exec.signal = signal
    try {
      const tool = this.capturedDefinition(exec)
      state.bodyInvoked = true
      const returned = await tool.execute(exec.arguments, exec)
      const result = this.createSuccessResult(exec, tool, returned)
      return isAborted(signal)
        ? toolAbortedResult(result)
        : result
    } catch (error: unknown) {
      return isAborted(signal) && isUnclassifiedCancellation(error, signal)
        ? toolErrorResult(error, { name: 'AbortError', code: TOOL_ABORTED })
        : toolErrorResult(error)
    } finally {
      fused.dispose()
      exec.signal = wrapperSignal
    }
  }

  /**
   * Run around-dispatch and the tool body. Tool and unknown-tool failures still
   * receive post-execute; pipeline failures are already final. Started bodies
   * drain on cancellation before a successful outcome becomes `ABORTED`. After
   * caller cancellation, a wrapper that throws the caller signal's reason or an
   * `Error` named `AbortError` without `HarnessError` identity keeps its message
   * and gains `ABORTED`, or `ABORTED_BEFORE_DISPATCH` when the body never
   * started; a wrapper's `HarnessError` and other failures stay unchanged.
   * @param exec - the execution returned by this pipeline's prepare stage.
   * @returns whether the result still needs post-execute.
   */
  async dispatch(exec: ToolRunContext): Promise<ScheduledToolDispatch> {
    try {
      const mutableExec = exec as MutableToolRunContext
      const carrier = scopeTarget(this.tools, exec.agent)
      const result = await this.ctx.waterfall(
        carrier, 'tools/execute', mutableExec,
        () => this.dispatchToolBody(mutableExec),
      )
      const normalized = this.normalizeDispatchResult(exec, result)
      const deferredContexts = this.deferredContexts.get(exec)
      /* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
      if (deferredContexts === undefined) throw new Error('tool registry scheduler invariant violated: unprepared execution')
      const resultWithDeferredContexts: ToolExecutionResult = deferredContexts.length === 0
        ? normalized
        : this.markCanonical(exec, {
          ...normalized,
          additionalContexts: [
            ...deferredContexts,
            ...normalized.additionalContexts ?? [],
          ],
        })
      return {
        kind: 'post-result',
        result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError
          ? this.cancellationResult(exec, resultWithDeferredContexts)
          : resultWithDeferredContexts,
      }
    } catch (error: unknown) {
      return { kind: 'final-result', result: this.wrapperFailureResult(exec, error) }
    }
  }

  /** Classify a failure thrown around dispatch; see {@link dispatch}. */
  private wrapperFailureResult(exec: ToolRunContext, error: unknown): ToolExecutionResult {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    if (!isAborted(state.callerSignal) || !isUnclassifiedCancellation(error, state.callerSignal)) return toolErrorResult(error)
    return toolErrorResult(error, { name: 'AbortError', code: state.bodyInvoked ? TOOL_ABORTED : TOOL_ABORTED_BEFORE_DISPATCH })
  }

  /**
   * Run post-execute when required, apply definition-owned content finalization,
   * and publish the lossless, frozen result. Policy and finalization failures
   * become error results. Cancellation replaces a successful outcome before
   * final materialization; tool-owned errors remain intact.
   * @param exec - the execution returned by this pipeline's prepare stage.
   * @param outcome - the preparation or dispatch result awaiting completion.
   * @returns the same materialized result delivered to final observers.
   */
  async complete(exec: ToolRunContext, outcome: ScheduledToolDispatch): Promise<ToolExecutionResult> {
    switch (outcome.kind) {
      case 'final-result':
        return this.finish(exec, outcome.result)
      case 'post-result':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(outcome, 'scheduled tool outcome')
    }
    const { result } = outcome
    try {
      const project = this.contentProjectors.get(exec)
      this.contentProjectors.delete(exec)
      const content = project?.(exec, result)
      const projected = content === undefined
        ? result
        : this.markCanonical(exec, this.materializeFinalResult({ ...result, content }))
      const postResult = await this.postExecute(exec, projected)
      return this.finish(
        exec,
        this.callerCancelled(exec) && !postResult.isError
          ? this.cancellationResult(exec, postResult)
          : postResult,
      )
    } catch (error: unknown) {
      return this.finish(exec, toolErrorResult(error))
    }
  }

  /**
   * Materialize the candidate, apply definition-owned content finalization,
   * then materialize and notify the authoritative result.
   * @param exec - the prepared execution.
   * @param result - final result.
   * @returns the materialized final result.
   * @internal
   */
  private finish(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    let materializedResult: ToolExecutionResult
    try {
      materializedResult = this.materializeFinalResult(result)
    } catch (error: unknown) {
      materializedResult = this.materializeFinalResult(toolErrorResult(error))
    }
    let finalResult: ToolExecutionResult
    try {
      finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult))
    } catch (error: unknown) {
      finalResult = this.materializeFinalResult(toolErrorResult(error))
    }
    this.notifyResult(exec, finalResult)
    return finalResult
  }

  /** Apply the snapshotted tool-owned content transform without exposing other result fields. */
  private applyFinalContent(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    const finalizeContent = this.contentFinalizers.get(exec)
    if (finalizeContent === undefined) return result
    const content = finalizeContent(exec, result)
    return content === undefined ? result : { ...result, content }
  }

  /** Notify observers without exposing a mutation or error channel into the outcome. */
  private notifyResult(exec: ToolExecution, result: ToolExecutionResult): void {
    // Freeze the registry's live object before observers receive its readonly
    // WeakMap-keyable view.
    Object.freeze(exec)
    const { name: toolName, callId } = exec
    const reportFailure = (error: unknown): void => {
      this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${toolErrorMessage(error)}`)
    }
    const callbacks = this.ctx.events.dispatch('emit', [
      scopeTarget(this.tools, exec.agent), 'tools/result', exec, result,
    ])
    for (const callback of callbacks) {
      try {
        const returned: unknown = callback(exec, result)
        void Promise.resolve(returned).catch(reportFailure)
      } catch (error: unknown) {
        reportFailure(error)
      }
    }
  }

  /**
   * Resolve an `ask` decision to allow/deny through the approval seam. The
   * seam is consumed opportunistically with `ctx.get('approval')` — a
   * deployment that composes no ApprovalService keeps the historical degrade
   * to deny, and an unmount mid-session degrades the same way on the next ask.
   * An agent-less execution also degrades: without an agent there is no
   * session to audit to and no UI to route to. Otherwise the outcome maps
   * one-to-one — `allowed-once` proceeds; the three non-grants deny with
   * distinct reasons so the model can tell a human "no" from an absent
   * approval channel. Every denial carries `ApprovalError` with
   * `APPROVAL_REJECTED`, `APPROVAL_CANCELLED`, or `APPROVAL_UNAVAILABLE`.
   */
  private async serviceAsk(
    exec: ToolExecution,
    ask: Extract<PreToolDecision, { kind: 'ask' }>,
  ): Promise<ToolAskResolution> {
    const approval = this.ctx.get('approval')
    if (approval === undefined) {
      return {
        decision: approvalDenial(ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`, APPROVAL_UNAVAILABLE),
        approvalCancelled: false,
      }
    }
    if (exec.agent === undefined) {
      return {
        decision: approvalDenial(`tool "${exec.name}" requires approval, but the call has no agent to route it through`, APPROVAL_UNAVAILABLE),
        approvalCancelled: false,
      }
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      ...ask.reason !== undefined ? { reason: ask.reason } : {},
      ...ask.displayReason !== undefined ? { displayReason: ask.displayReason } : {},
      signal: exec.signal,
    })
    switch (outcome) {
      case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false }
      case 'rejected': return {
        decision: approvalDenial(`the user rejected tool "${exec.name}"`, APPROVAL_REJECTED),
        approvalCancelled: false,
      }
      case 'cancelled': return {
        decision: approvalDenial(`approval for tool "${exec.name}" was cancelled`, APPROVAL_CANCELLED),
        approvalCancelled: true,
      }
      case 'unavailable': return {
        decision: approvalDenial(`tool "${exec.name}" requires approval, but no approval channel is available`, APPROVAL_UNAVAILABLE),
        approvalCancelled: false,
      }
      default: return assertNever(outcome, 'ApprovalOutcome')
    }
  }

  /**
   * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
   * its {@link PostToolDecision}: `accept` keeps the call successful (replacing
   * `content` when given), `block` turns it into an `isError` whose content is
   * the corrective `feedback`. Either decision may attach `additionalContexts`,
   * which are ferried on the returned result for the loop's active-batch FIFO.
   * Context deferred by the tool body survives an accepted result but is
   * discarded when the outer call is blocked; a block exposes only context the
   * blocking decision explicitly supplied.
   * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
   */
  private async postExecute(exec: ToolExecution, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    const decision = await this.ctx.waterfall(
      scopeTarget(this.tools, exec.agent), 'tools/post-execute', exec, result,
      () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
    )
    const decisionContexts = decision.additionalContexts ?? []
    if (decision.kind === 'block') {
      const message = failureMessageFromContent(decision.feedback)
      return this.markCanonical(exec, {
        content: decision.feedback,
        isError: true,
        error: { message, ...decision.info === undefined ? {} : { info: decision.info } },
        ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {},
      })
    }
    if (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value')) {
      throw new TypeError('tools/post-execute accept decision cannot replace both value and content')
    }
    const additionalContexts = [
      ...result.additionalContexts ?? [],
      ...decisionContexts,
    ]
    if (Object.hasOwn(decision, 'value')) {
      if (result.isError) {
        throw new TypeError('tools/post-execute cannot replace the value of a failed result')
      }
      const replaced = this.createSuccessResult(exec, this.dispatchedDefinition(exec), decision.value)
      return this.markCanonical(exec, {
        ...replaced,
        ...additionalContexts.length > 0 ? { additionalContexts } : {},
      })
    }
    return this.markCanonical(exec, {
      ...result,
      ...decision.content !== undefined ? { content: decision.content } : {},
      ...additionalContexts.length > 0 ? { additionalContexts } : {},
    })
  }

  /** Registry-normalized results and the exact dispatch that validated each value. */
  private readonly canonicalResults = new WeakMap<object, ToolExecutionToken>()

  /** Mark one registry-normalized result as canonical only for its owning dispatch. */
  private markCanonical<T extends ToolExecutionResult>(exec: ToolExecution, result: T): T {
    this.canonicalResults.set(result, exec.token)
    return result
  }

  /** Snapshot, validate, render, and optionally project one successful body value. */
  private createSuccessResult(exec: ToolExecution, tool: ToolDefinition, candidate: unknown): ToolExecutionSuccess {
    const detached = snapshotToolValue(tool.name, candidate)
    const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
    if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
    const value = deepFreeze(detached)
    let rendered: ContentBlock[]
    try {
      rendered = tool.output.render(exec.arguments, value)
    } catch (error: unknown) {
      throw projectionError(tool.name, 'render', error)
    }
    const content = snapshotProjection(tool.name, 'render', rendered)
    let meta: JsonValue | undefined
    if (tool.output.presentationMeta !== undefined) {
      let projected: JsonValue
      try {
        projected = tool.output.presentationMeta(exec.arguments, value)
      } catch (error: unknown) {
        throw projectionError(tool.name, 'presentationMeta', error)
      }
      meta = snapshotProjection(tool.name, 'presentationMeta', projected)
    }
    const concludesTurn = this.concludingExecutions.has(exec)
    return this.markCanonical(exec, this.materializeFinalResult({
      isError: false,
      value,
      content,
      ...meta !== undefined ? { meta } : {},
      ...concludesTurn ? { concludesTurn: true as const } : {},
    }) as ToolExecutionSuccess)
  }

  /** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
  private normalizeDispatchResult(exec: ToolExecution, result: ToolExecutionResult): ToolExecutionResult {
    if (this.canonicalResults.get(result) === exec.token) return result
    if (result.isError) {
      return this.markCanonical(exec, {
        isError: true,
        error: result.error,
        content: result.content,
        ...result.meta !== undefined ? { meta: result.meta } : {},
        ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
      })
    }
    const normalized = this.createSuccessResult(exec, this.dispatchedDefinition(exec), result.value)
    return this.markCanonical(exec, {
      ...normalized,
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    })
  }

  /** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
  private materializeFinalResult(result: ToolExecutionResult): ToolExecutionResult {
    const presentation = {
      content: result.content,
      ...result.meta !== undefined ? { meta: result.meta } : {},
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    }
    if (result.isError) {
      return materializePresentation({ isError: true as const, error: result.error, ...presentation })
    }
    const detached = materializePresentation({
      isError: false as const,
      ...presentation,
      ...result.concludesTurn === true ? { concludesTurn: true as const } : {},
    })
    return deepFreeze({ ...detached, value: result.value })
  }
}

/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName: string, projector: 'render' | 'presentationMeta', error: unknown): ToolOutputError {
  return new ToolOutputError(toolName, [`output.${projector} failed: ${toolErrorMessage(error)}`])
}

/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection<T>(toolName: string, projector: 'render' | 'presentationMeta', candidate: T): T {
  try {
    const detached = snapshotJsonValue(candidate)
    if (detached === undefined) {
      throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`])
    }
    return detached
  } catch (error: unknown) {
    if (error instanceof ToolOutputError) throw error
    throw projectionError(toolName, projector, error)
  }
}

/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName: string, candidate: unknown): JsonValue {
  try {
    const detached = snapshotJsonValue(candidate)
    if (detached === undefined) throw new ToolOutputError(toolName, ['value is not lossless JSON'])
    return detached as JsonValue
  } catch (error: unknown) {
    if (error instanceof ToolOutputError) throw error
    throw new ToolOutputError(toolName, [`value snapshot failed: ${toolErrorMessage(error)}`])
  }
}

/**
 * Best-effort human-readable message from an arbitrary thrown value: Error
 * instances use `.message`; non-Error objects with a string `message`
 * property (e.g. `throw { message: 'denied' }`) use it too; everything else
 * is stringified.
 * @param error - thrown value from a tool or policy callback.
 * @returns a printable failure message, including for hostile thrown values.
 */
export function toolErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null
      && 'message' in error && typeof error.message === 'string') {
      return error.message
    }
    return String(error)
  } catch {
    // A hostile thrown value can trap `instanceof`, property access, or string
    // coercion. Error normalization is the outermost safety boundary, so its
    // fallback must itself be total.
    return '<unprintable thrown value>'
  }
}

/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content: ContentBlock[]): string {
  const text = content
    .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
    .join('\n')
  return text.length > 0 ? text : 'tool result blocked by post-execute policy'
}

/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation<T>(candidate: T): T {
  const detached = snapshotJsonValue(candidate)
  if (detached === undefined) {
    throw new TypeError('tool result must be losslessly JSON-serializable')
  }
  return deepFreeze(detached)
}

/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error: unknown): ToolErrorInfo | undefined {
  try {
    return error instanceof HarnessError ? { name: error.name, code: error.code } : undefined
  } catch {
    return undefined
  }
}

/** Materialize a non-granting approval outcome as a denial with routable `ApprovalError` identity. */
function approvalDenial(reason: string, code: ApprovalErrorCode): Extract<PreToolDecision, { kind: 'deny' }> {
  return { kind: 'deny', reason, info: { name: APPROVAL_ERROR_NAME, code } }
}

/** Whether a value thrown after cancellation is that cancellation and carries no identity of its own. */
function isUnclassifiedCancellation(error: unknown, signal: AbortSignal): boolean {
  if (errorInfo(error) !== undefined) return false
  try {
    return error === signal.reason || (error instanceof Error && error.name === 'AbortError')
  } catch {
    // A value whose prototype or `name` cannot be read is not a recognizable cancellation.
    return false
  }
}

/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken(): ToolExecutionToken {
  return Symbol('dsh.tool.execution') as ToolExecutionToken
}

function toolErrorResult(error: unknown, info = errorInfo(error)): ToolExecutionResult {
  const message = toolErrorMessage(error)
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, ...info ? { info } : {} },
  }
}

/** Read live abort state across an await without treating it as synchronously immutable. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
 * Keeping the relay dispatch-scoped also removes listeners when work settles.
 */
function fuseToolSignals(caller: AbortSignal, wrapper: AbortSignal): FusedToolSignal {
  if (caller === wrapper) return { signal: caller, dispose() {} }

  const controller = new AbortController()
  let listening = false
  const dispose = (): void => {
    if (!listening) return
    listening = false
    caller.removeEventListener('abort', abortFromCaller)
    wrapper.removeEventListener('abort', abortFromWrapper)
  }
  const abortFrom = (source: AbortSignal): void => {
    const reason: unknown = source.reason
    controller.abort(reason)
    dispose()
  }
  const abortFromCaller = (): void => { abortFrom(caller) }
  const abortFromWrapper = (): void => { abortFrom(wrapper) }

  if (wrapper.aborted) abortFromWrapper()
  else if (caller.aborted) abortFromCaller()
  else {
    listening = true
    caller.addEventListener('abort', abortFromCaller, { once: true })
    wrapper.addEventListener('abort', abortFromWrapper, { once: true })
  }
  return { signal: controller.signal, dispose }
}

/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior?: ToolExecutionResult): ToolExecutionResult {
  const additionalContexts = prior?.additionalContexts ?? []
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted' }],
    isError: true,
    error: {
      message: 'tool call aborted',
      info: { name: 'AbortError', code: TOOL_ABORTED },
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  }
}

/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior?: ToolExecutionResult): ToolExecutionResult {
  const additionalContexts = prior?.additionalContexts ?? []
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  }
}

export { DEFAULT_MAX_PARALLEL_TOOL_CALLS, executeToolBatch } from './batch.ts'
export { ToolEntries } from './entries.ts'
export { ToolStep } from './step.ts'
export { NativeToolRegistry } from './native-registry.ts'
export { AgentToolRegistry } from './agent-tools.ts'
