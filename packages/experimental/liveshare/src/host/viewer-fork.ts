/**
 * Fork orchestration for one viewer: ceiling decisions, child preparation, replay, and branch facts.
 *
 * The owner's own fork runs unchanged through the Gateway; this module decides whether it may run at
 * all, records the child the owner created under the logical request so a retry after that record
 * replays it, and records the child before anything can prompt it. Branch facts the reader was given
 * are added to list and projection answers here.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/viewer-fork
 */

import { FORK_LINEAGE_KEY, forkLineageValue, type ForkLineage } from '../fork-lineage.ts'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { viewerRequestTarget, type ViewerAnswer } from '../viewer-channel.ts'
import type { ForkPromptDecision, ForkRegistry } from './fork-registry.ts'
import { decideFork, type ForkRequest } from './fork-policy.ts'
import type { ViewerReadDeps } from './viewer-read.ts'
import type { ViewerLifecycle } from './viewer-lifecycle.ts'
import {
  requestedBoundary,
  requestedOperationId,
  requestedRpcId,
  requestedSessionId,
  type ViewerDispatch,
} from './viewer-dispatch.ts'
import { isRecord } from './wire-json.ts'

/** Host services and orchestration one fork request reads. */
export interface ViewerForkDeps {
  /** Host services the reader was built with. */
  readonly deps: ViewerReadDeps
  /** Lifecycle refusal answers and the enforcement records a child holds. */
  readonly lifecycle: ViewerLifecycle
  /** The request dispatch the owner's own fork is made through. */
  readonly dispatch: () => ViewerDispatch
}

/** Fork orchestration one viewer reader exposes. */
export interface ViewerFork {
  /**
   * Answer one fork request from a viewer.
   * @param shareId - Share the request arrived through.
   * @param path - Owner endpoint path to dispatch the fork to.
   * @param body - Opaque fork body the viewer sent.
   * @param actor - Viewer identity the Relay asserted.
   * @param signal - Cancellation of the forwarded request.
   * @returns The owner's own fork answer, or a named refusal.
   */
  answerFork(
    shareId: string,
    path: string,
    body: unknown,
    actor: ShareRpcActor,
    signal?: AbortSignal,
  ): Promise<ViewerAnswer>
  /**
   * Activate one cold child through the composition, then decide again.
   * @param childSessionId - Child to prepare.
   * @param viewer - Identity the Relay asserted.
   * @param previous - Decision the registry gave before preparation.
   * @returns The decision after the activation.
   */
  prepareColdChild(childSessionId: string, viewer: ShareRpcActor, previous: ForkPromptDecision): Promise<ForkPromptDecision>
  /**
   * Add the branch facts this reader was given to its own forks in one `session/list` answer.
   * @param answer - Owner's own `session/list` answer.
   * @param shareId - Share the request arrived through.
   * @param actor - Viewer identity the Relay asserted.
   * @returns The answer, with this reader's forks annotated for its sidebar.
   */
  annotateSessionList(answer: ViewerAnswer, shareId: string, actor: ShareRpcActor): ViewerAnswer
  /**
   * Branch facts one reader was given for one Session, or undefined when it is not that reader's branch.
   * @param shareId - Share the read arrived through.
   * @param sessionId - Session the read names.
   * @param actor - Viewer identity the Relay asserted.
   * @returns The branch facts to publish, or undefined.
   */
  lineageFor(shareId: string, sessionId: string, actor: ShareRpcActor): ForkLineage | undefined
  /**
   * One owner answer with the branch facts added to its page's projection block.
   * @param answer - The owner gateway's own answer.
   * @param lineage - Branch facts for the Session that answer describes.
   * @returns The answer, with the facts added to its projections.
   */
  withLineageAnswer(answer: ViewerAnswer, lineage: ForkLineage): ViewerAnswer
  /**
   * Add the branch facts this reader was given wherever a relayed stream carries a projection block.
   * @param values - Frames the owner gateway streams for one endpoint.
   * @param endpoint - Stream endpoint being relayed.
   * @param requested - Session the stream was opened for, when its open item named one.
   * @returns The same frames, with the facts added to their projection blocks.
   */
  withLineageFrames(
    values: AsyncIterable<unknown>,
    endpoint: string,
    requested: string | undefined,
    lineageOf: (sessionId: string) => ForkLineage | undefined,
  ): AsyncGenerator
}

/**
 * Build the fork orchestration for one viewer reader.
 * @param input - Host services, lifecycle state, and the request dispatch.
 * @returns Fork orchestration and branch annotations.
 */
export function createViewerFork(input: ViewerForkDeps): ViewerFork {
  const deps = input.deps
  const lifecycle = input.lifecycle
  const dispatch = input.dispatch
  /** Fork requests being served right now, so concurrent retries of one intent create one child. */
  const inFlight = new Map<string, { readonly boundary: number; readonly answer: Promise<ViewerAnswer> }>()

  /**
   * Activate one cold child through the composition, then decide again.
   *
   * An activation that fails is reported as its own refusal: reporting the generic missing-limit code
   * would hide a Session that was never brought up, which is the failure this path exists to avoid.
   */
  const prepareColdChild = async (
    childSessionId: string,
    viewer: ShareRpcActor,
    previous: ForkPromptDecision,
  ): Promise<ForkPromptDecision> => {
    try {
      await deps.prepareChild?.(childSessionId)
    } catch (error: unknown) {
      return {
        ok: false,
        code: 'fork-prepare-failed',
        message: `preparing this fork failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return deps.forks?.allowsPrompt(childSessionId, viewer) ?? previous
  }

  /**
   * Answer one fork request from a viewer.
   *
   * The upstream fork runs unchanged; this decides whether it may run at all, and records the child
   * so the viewer can see it and the source owner can revoke it later. The request key is derived
   * rather than minted, so a retried creation resolves to the boundary the caller asked for instead
   * of producing a second child.
   * @param shareId Share the request arrived through.
   * @param path Owner endpoint path to dispatch the fork to.
   * @param body Opaque fork body the viewer sent.
   * @param actor Viewer identity the Relay asserted.
   * @returns The owner's own fork answer, or a named refusal.
   */
  const answerFork = async (
    shareId: string,
    path: string,
    body: unknown,
    actor: ShareRpcActor,
    signal?: AbortSignal,
  ): Promise<ViewerAnswer> => {
    const share = deps.forkStateOf?.(shareId)
    if (share === undefined) return { status: 404, body: { error: 'share-not-found' } }
    // Forking is the one write a viewer performs, so the share state is read here exactly as a read
    // endpoint reads it: a viewer whose grant ended, a share past its deadline, and a stopped share are
    // refused before a child could ever be created for them.
    const refusingShare = lifecycle.shareRefusal(shareId, actor)
    if (refusingShare !== undefined) return refusingShare
    const sourceSessionId = requestedSessionId(body)
    // A fork has to name the Session it branches from, and this host decides the request before the
    // owner's Gateway sees it: a body naming none is refused here instead of reaching the owner.
    if (sourceSessionId === undefined) {
      return {
        status: 400,
        body: { error: 'fork-session-required', message: 'a fork request must name the session it branches from' },
      }
    }
    const atSeq = requestedBoundary(body)
    const request: ForkRequest = {
      shareId,
      sourceSessionId,
      ...(atSeq === undefined ? {} : { atSeq }),
      requestKey: forkRequestKey(shareId, actor, sourceSessionId, atSeq),
    }
    const decision = decideFork(share, request, Date.now())
    if (!decision.ok) {
      console.warn(
        `[liveshare] fork refused share=${shareId} code=${decision.code}`
        + ` source=${sourceSessionId} viewer=${actor.subjectId}`,
      )
      return { status: 403, body: { error: decision.code, message: decision.message } }
    }
    // The admission above ran first, so a served operation is only replayed for a caller that is still
    // admitted to a live share: the identity never stands in for the authorization.
    const identity = forkOperationIdentity(shareId, actor, sourceSessionId, requestedOperationId(body))
    // A child identity is honoured only under a bound operation identity: without rpcId or operationId
    // the host cannot prove the retry is the request that created it, so a body naming a child is
    // refused instead of being forwarded as a field the owner's request type cannot carry.
    if (identity === undefined && namesForkChildSessionId(body)) {
      return {
        status: 403,
        body: { error: 'fork-identity-required', message: 'naming a fork child requires an rpcId or operationId' },
      }
    }
    if (identity !== undefined) {
      // The request in flight wins over a recorded one: a retry that arrives while the first is still
      // enforcing its child must wait for that same outcome, not read a half-finished success.
      const pending = inFlight.get(identity)
      if (pending !== undefined) {
        if (pending.boundary !== decision.boundary) return forkOperationConflict()
        // The answer belongs to the request that started the fork; this caller is waiting on it with an
        // id of its own, so it is re-correlated exactly like a recorded replay.
        const answer = await pending.answer
        return { status: answer.status, body: correlateForkAnswer(answer.body, requestedRpcId(body)) }
      }
      const settled = deps.forks?.operationOf(identity)
      if (settled !== undefined) {
        // A retry repeats the request it already made; the same identity naming a different boundary is
        // a different intent that must not silently receive the earlier child.
        if (settled.boundary !== decision.boundary) return forkOperationConflict()
        // An interrupted request that never created a child is not a replay: it creates now.
        if (settled.childSessionId !== '') {
          // A child whose readiness was never confirmed is refused by name, never replayed as a success,
          // and never replaced by a second child — including a record written before readiness existed.
          return settled.ready
            // The recorded answer describes the child; its correlation id belongs to the request that
            // produced it, so the replay carries THIS request's id or a Connection client reads it as a
            // mismatch against the call it is waiting on.
            ? { status: settled.status, body: correlateForkAnswer(settled.body, requestedRpcId(body)) }
            : forkEnforcementFailed(settled.childSessionId)
        }
      }
      // Bind this identity to its boundary before anything is created: a request naming another boundary
      // then conflicts even if this process dies before it records the child. The reservation is awaited
      // inside `create` rather than here, so a concurrent retry still meets the in-flight entry below
      // instead of starting a second fork while the reservation reaches the disk.
    }
    const create = async (): Promise<ViewerAnswer> => {
      if (identity !== undefined) await deps.forks?.reserveOperation(identity, decision.boundary)
      // The owner's `SessionForkRequest` mints the child id itself, so the request body is forwarded
      // unchanged: a retry is made idempotent by the operation this host reserves and records, not by a
      // child id it could inject into a request type that has no such field.
      const answer = await dispatch().dispatchCall(path, body, shareId, actor, signal)
      const childSessionId = forkedSessionId(answer)
      if (childSessionId !== undefined) {
        await deps.forks?.record({
          childSessionId,
          shareId,
          sourceSessionId,
          boundary: decision.boundary,
          creator: { providerId: actor.providerId, tenantId: actor.tenantId, subjectId: actor.subjectId },
          createdAt: new Date().toISOString(),
        })
        deps.accessChanged?.()
        // Register the child's limit before anything can prompt it: the installation writes the record
        // the prompt gate reads, so a child whose guard could not be registered stays refused.
        let installed: (() => void) | undefined
        try {
          // A write-mode share's child is installed with the bounded write; every other child, and any
          // child whose share mode this host cannot establish, keeps the read-only ceiling.
          installed = await deps.enforceChild?.(childSessionId, { write: share.sessionMode === 'write' })
        } catch (error: unknown) {
          // The child exists in the owner's log whatever happens here, so the failure is reported and
          // recorded rather than swallowed; a prompt still refuses because no limit was installed.
          console.warn(
            `[liveshare] fork limits failed share=${shareId} child=${childSessionId}`
            + ` viewer=${actor.subjectId} error=${error instanceof Error ? error.message : String(error)}`,
          )
        }
        if (installed !== undefined) lifecycle.holdEnforcement(childSessionId, installed)
        const ready = installed !== undefined
        // The operation is recorded either way — the child exists, and a retry must not fork a second
        // one — but a record that could not be enforced never answers as a success.
        if (identity !== undefined) {
          await deps.forks?.recordOperation({
            key: identity,
            childSessionId,
            boundary: decision.boundary,
            ready,
            status: ready ? answer.status : 503,
            body: ready ? answer.body : forkEnforcementFailed(childSessionId).body,
          })
        }
        if (!ready) return forkEnforcementFailed(childSessionId)
        console.log(
          `[liveshare] fork created share=${shareId} child=${childSessionId}`
          + ` boundary=${String(decision.boundary)} viewer=${actor.subjectId}`,
        )
      }
      return answer
    }
    if (identity === undefined) return create()
    const started = create()
    inFlight.set(identity, { boundary: decision.boundary, answer: started })
    try {
      return await started
    } finally {
      inFlight.delete(identity)
    }
  }


  /**
 * Stable key for one fork attempt, so a retry lands on the same boundary instead of a new child.
 * @param shareId Share the fork came through.
 * @param actor Viewer identity the Relay asserted.
 * @param sourceSessionId Session being forked.
 * @param atSeq Boundary the caller asked for, when it asked for one.
 * @returns Key unique to that viewer, share, session, and boundary.
 */
  function forkRequestKey(
    shareId: string,
    actor: ShareRpcActor,
    sourceSessionId: string,
    atSeq: number | undefined,
  ): string {
    return [
      shareId,
      actor.providerId,
      actor.tenantId,
      actor.subjectId,
      sourceSessionId,
      atSeq === undefined ? 'end' : String(atSeq),
    ].join('\u0000')
  }

  /**
 * Whether one fork envelope names a child identity itself.
 *
 * The current `SessionForkRequest` has no child identity field, so nothing this host injects could be
 * honoured; a body that names one anyway is refused unless it carries the operation identity a replay
 * needs, instead of being forwarded as if the owner would adopt that child.
 * @param envelope - Opaque fork body the viewer sent.
 * @returns True when the request record names a non-empty `childSessionId`.
 */
  function namesForkChildSessionId(envelope: unknown): boolean {
    const childSessionId = viewerRequestTarget(envelope)?.childSessionId
    return typeof childSessionId === 'string' && childSessionId !== ''
  }

  /**
 * Re-wrap a recorded answer for the request replaying it.
 *
 * Everything the owner said about the child is kept; only a correlation id the recorded body carries
 * is replaced with the current caller's, so a client waiting on this call does not read the answer as
 * belonging to the request that created the child.
 * @param recorded - Body the owner answered with when the child was created.
 * @param rpcId - Correlation id of the request being served now.
 * @returns The body to answer with.
 */
  function correlateForkAnswer(recorded: unknown, rpcId: string | undefined): unknown {
    if (rpcId === undefined || !isRecord(recorded) || !('rpcId' in recorded)) return recorded
    return { ...recorded, rpcId }
  }

  /**
 * Identity of one logical fork request, or undefined when the caller named no operation.
 *
 * It binds the trusted viewer identity, the share, and the source session to the caller's operation id
 * — never the boundary, which is payload the recorded operation is compared against. An absent
 * operation id leaves the request unidentified, so it behaves as before rather than being folded onto
 * some other caller's intent.
 * @param shareId - Share the request arrived through.
 * @param actor - Trusted viewer identity the Relay asserted.
 * @param sourceSessionId - Session the fork would branch from.
 * @param operationId - Caller-supplied operation id, when it named one.
 * @returns The identity, whose fields cannot collide because the separator is not an id character.
 */
  function forkOperationIdentity(
    shareId: string,
    actor: ShareRpcActor,
    sourceSessionId: string,
    operationId: string | undefined,
  ): string | undefined {
    if (operationId === undefined) return undefined
    return [actor.providerId, actor.tenantId, actor.subjectId, shareId, sourceSessionId, operationId]
      .join('\u0000')
  }

  /**
 * The answer a caller gets when one operation id names a boundary its earlier request did not.
 * @returns The conflict answer, which names the request rather than creating a second child.
 */
  function forkOperationConflict(): ViewerAnswer {
    return {
      status: 409,
      body: {
        error: 'fork-operation-conflict',
        message: 'this request already created a fork at another boundary',
      },
    }
  }

  /**
 * The answer for a fork whose child was created but could not be given read-only limits.
 *
 * The child is named so the owner can find it, and the answer is a failure: a child that cannot be
 * driven is not a fork the viewer got.
 * @param childSessionId - Child that exists in the owner's log without a limit.
 * @returns The refusal, which a retry of the same request also receives.
 */
  function forkEnforcementFailed(childSessionId: string): ViewerAnswer {
    return {
      status: 503,
      body: {
        error: 'fork-enforcement-failed',
        message: `fork ${childSessionId} was created without read-only limits and cannot be driven`,
        sessionId: childSessionId,
      },
    }
  }

  /**
 * Read the child session id out of the owner's fork answer.
 * @param answer Owner's answer to the fork call.
 * @returns The child session id, or undefined when the fork did not report one.
 */
  function forkedSessionId(answer: ViewerAnswer): string | undefined {
    if (answer.status !== 200 || !isRecord(answer.body)) return undefined
    const result = answer.body.result
    if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) return undefined
    const sessionId = result.value.sessionId
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  }


  /**
 * Add the branch facts this reader was given to its own forks in one `session/list` answer.
 *
 * The Session Controller already returned only the rows the `share-viewer` policy lets this reader see;
 * a kept fork carries its branch facts as that row's projection value, because the shared Session summary
 * states no branch fields.
 * @param answer Owner's own `session/list` answer.
 * @param shareId Share the request arrived through.
 * @param actor Viewer identity the Relay asserted.
 * @param forks Registry of children this Host created.
 * @returns The answer, with this reader's forks annotated for its sidebar.
 */
  function annotateSessionList(
    answer: ViewerAnswer,
    shareId: string,
    actor: ShareRpcActor,
    forks: ForkRegistry | undefined,
  ): ViewerAnswer {
    if (answer.status !== 200 || !isRecord(answer.body)) return answer
    const result = answer.body.result
    if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) return answer
    const items = result.value.items
    if (!Array.isArray(items)) return answer
    const annotated = items.map((item): unknown => {
      if (!isRecord(item) || typeof item.sessionId !== 'string') return item
      const lineage = forkLineageFor(shareId, item.sessionId, actor, forks)
      return lineage === undefined ? item : { ...item, projections: listHintsWithForkLineage(item.projections, lineage) }
    })
    return { status: answer.status, body: { ...answer.body, result: { ...result, value: { ...result.value, items: annotated } } } }
  }

  /**
 * Branch facts one reader was given for one Session, or undefined when it is not that reader's branch.
 *
 * A reader reaches a branch only through the share it created it from, so the registry's creator is
 * the whole test. The whole subject decides it, not just the provider and subject id: the same person
 * can exist in two tenants, and the Relay's tenant admission is not a substitute for this check.
 * @param shareId - Share the read arrived through.
 * @param sessionId - Session the read names.
 * @param actor - Viewer identity the Relay asserted.
 * @param forks - Registry of children this Host created.
 * @returns The branch facts to publish, or undefined.
 */
  function forkLineageFor(
    shareId: string,
    sessionId: string,
    actor: ShareRpcActor,
    forks: ForkRegistry | undefined,
  ): ForkLineage | undefined {
    if (forks === undefined) return undefined
    const child = forks.find(sessionId)
    if (child === undefined || child.shareId !== shareId) return undefined
    if (identityKeyOf(child.creator) !== identityKeyOf(actor)) return undefined
    return forkLineageValue(child.sourceSessionId)
  }

  /**
 * One owner projection block with the branch facts added to its values.
 * @param block - Projection block the owner produced, when the row carries one.
 * @param lineage - Branch facts for the block's Session.
 * @returns The block, with the facts under their projection key.
 */
  function withForkLineageValues(block: unknown, lineage: ForkLineage): Record<string, unknown> {
    const record = isRecord(block) ? block : {}
    const values = isRecord(record.values) ? record.values : {}
    return {
      ...record,
      asOfSeq: typeof record.asOfSeq === 'number' ? record.asOfSeq : 0,
      values: { ...values, [FORK_LINEAGE_KEY]: lineage },
    }
  }

  /**
 * One session list row's projection hints with the branch facts this reader was given.
 * @param block - Projection hints the owner's own list row carried, when it carried any.
 * @param lineage - Branch facts for that row's Session.
 * @returns Hints naming their sequence space, with the facts added.
 */
  function listHintsWithForkLineage(block: unknown, lineage: ForkLineage): Record<string, unknown> {
    const record = isRecord(block) ? block : {}
    return {
      ...withForkLineageValues(record, lineage),
      // The owner's own block names its sequence space. A row the owner served without one was viewed
      // from its persisted checkpoint, so the added facts are a listing hint too.
      kind: record.kind === 'sequenced' ? 'sequenced' : 'cached',
    }
  }

  /**
 * One owner answer with the branch facts added to its page's projection block.
 * @param answer - The owner gateway's own answer.
 * @param lineage - Branch facts for the Session that answer describes.
 * @returns The answer, with the facts added to its projections.
 */
  function withForkLineageAnswer(answer: ViewerAnswer, lineage: ForkLineage): ViewerAnswer {
    if (answer.status !== 200 || !isRecord(answer.body)) return answer
    const result = answer.body.result
    if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) return answer
    return {
      ...answer,
      body: {
        ...answer.body,
        result: {
          ...result,
          value: {
            ...result.value,
            projections: withForkLineageValues(result.value.projections, lineage),
          },
        },
      },
    }
  }

  /**
 * Add the branch facts this reader was given wherever a relayed stream carries a projection block.
 *
 * The facts are not folded from the Session log, so an owner baseline never states them: without
 * this, a branch would lose the value a page learned from the session list the moment that branch's
 * own baseline replaced the block.
 * @param values - Frames the owner gateway streams for one endpoint.
 * @param endpoint - Stream endpoint being relayed.
 * @param requested - Session the stream was opened for, when its open item named one.
 * @param lineageOf - Branch facts for one Session, or undefined when it is not this reader's branch.
 * @returns The same frames, with the facts added to their projection blocks.
 */
  async function* withForkLineageFrames(
    values: AsyncIterable<unknown>,
    endpoint: string,
    requested: string | undefined,
    lineageOf: (sessionId: string) => ForkLineage | undefined,
  ): AsyncGenerator {
    for await (const frame of values) {
      if (!isRecord(frame)) {
        yield frame
        continue
      }
      if (endpoint === 'session/follow') {
        const lineage = requested === undefined ? undefined : lineageOf(requested)
        yield frame.type === 'snapshot' && lineage !== undefined
          ? { ...frame, projections: withForkLineageValues(frame.projections, lineage) }
          : frame
        continue
      }
      // `session/control` carries one baseline block per Session the controller let this reader see. A later
      // frame replaces one projection key, and this one is never replaced by the owner's own registry.
      const value = isRecord(frame.value) ? frame.value : undefined
      const projections = value !== undefined && isRecord(value.projections) ? value.projections : undefined
      if (frame.type !== 'baseline' || value === undefined || projections === undefined) {
        yield frame
        continue
      }
      const annotated: Record<string, unknown> = {}
      for (const [sessionId, block] of Object.entries(projections)) {
        const lineage = lineageOf(sessionId)
        annotated[sessionId] = lineage === undefined ? block : withForkLineageValues(block, lineage)
      }
      yield { ...frame, value: { ...value, projections: annotated } }
    }
  }

  return {
    answerFork,
    prepareColdChild,
    annotateSessionList: (answer, shareId, actor) => annotateSessionList(answer, shareId, actor, deps.forks),
    lineageFor: (shareId, sessionId, actor) => forkLineageFor(shareId, sessionId, actor, deps.forks),
    withLineageAnswer: withForkLineageAnswer,
    withLineageFrames: withForkLineageFrames,
  }
}
