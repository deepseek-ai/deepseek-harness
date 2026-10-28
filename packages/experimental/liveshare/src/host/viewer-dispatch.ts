/**
 * Dispatch of one reader's viewer requests to the owner's own Connection and gateway.
 *
 * Endpoint classification, the source and child write paths, streams, page assets, and the request
 * entry all live here. Each handler re-reads the share's lifecycle and the policy's write refusal at
 * the points the original order required, and every resource it opens is tracked by viewer-lifecycle.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/viewer-dispatch
 */

import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import {
  viewerReadOnlyAnswer,
  viewerRequestTarget,
  type ViewerAnswer,
  type ViewerAssetBody,
  type ViewerRequest,
} from '../viewer-channel.ts'
import { STREAM_BATCH_MAX, STREAM_BATCH_WINDOW_MS, STREAM_POLL_HOLD_MS, STREAM_POLL_SLACK_MS } from '../read-budgets.ts'
import type { ViewerReadDeps } from './viewer-read.ts'
import type { OpenStream, ViewerLifecycle } from './viewer-lifecycle.ts'
import type { ViewerFork } from './viewer-fork.ts'
import { isRecord } from './wire-json.ts'

function sameActor(left: ShareRpcActor, right: ShareRpcActor): boolean {
  return identityKeyOf(left) === identityKeyOf(right)
}

/**
 * The caller's stable identifier for one logical fork request.
 *
 * An explicit request field wins; otherwise the caller's `rpcId` names that same intent, because a
 * retry re-sends the same envelope. The boundary is deliberately not read here.
 * @param envelope - Opaque request body the viewer sent.
 * @returns The operation id, or undefined when the caller named no operation at all.
 */
export function requestedOperationId(envelope: unknown): string | undefined {
  const request = viewerRequestTarget(envelope)
  const explicit = request?.operationId
  if (typeof explicit === 'string' && explicit !== '') return explicit
  if (!isRecord(envelope)) return undefined
  const rpcId = envelope.rpcId
  return typeof rpcId === 'string' && rpcId !== '' ? `rpc:${rpcId}` : undefined
}

/**
 * The correlation id of one request envelope, when it carries one.
 * @param envelope - Opaque request body the viewer sent.
 * @returns The caller's id, or undefined.
 */
export function requestedRpcId(envelope: unknown): string | undefined {
  if (!isRecord(envelope)) return undefined
  return typeof envelope.rpcId === 'string' && envelope.rpcId !== '' ? envelope.rpcId : undefined
}

/**
 * The completed-history prefix one fork request asks its child to branch from.
 *
 * A body that names none, or names something other than a safe integer, leaves the boundary unnamed:
 * the fork path then branches at the share's last completed prefix, or at 0 when the share published
 * none.
 * @param body - Opaque request body the viewer sent.
 * @returns The safe-integer boundary, or undefined when the request names none.
 */
export function requestedBoundary(body: unknown): number | undefined {
  const request = viewerRequestTarget(body)
  if (request === undefined) return undefined
  const value = request.atSeq
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * The Session one prompt, cancel, or fork envelope names.
 * @param envelope - Opaque request body the viewer sent.
 * @returns The `sessionId` of the request record, or undefined when it names none.
 */
export function requestedSessionId(envelope: unknown): string | undefined {
  const sessionId = viewerRequestTarget(envelope)?.sessionId
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
}

/**
 * The ordinary Session a `session/page` or `session/follow` request addresses.
 * @param envelope - Unary envelope or stream payload the viewer sent.
 * @returns The Session id for a `session` address, or undefined for any other address.
 */
export function requestedAddressSession(envelope: unknown): string | undefined {
  const address = viewerRequestTarget(envelope)?.address
  if (!isRecord(address) || address.kind !== 'session') return undefined
  return typeof address.sessionId === 'string' && address.sessionId !== '' ? address.sessionId : undefined
}

/** Host services one dispatched viewer request reads. */
export interface ViewerDispatchDeps {
  /** Host services the reader was built with. */
  readonly deps: ViewerReadDeps
  /** Lifecycle state, refusal answers, and the resources a request opens. */
  readonly lifecycle: ViewerLifecycle
  /** Fork orchestration, which a fork call and the branch annotations go through. */
  readonly fork: () => ViewerFork
}

/** The one entry a viewer reader exposes for forwarded requests. */
export interface ViewerDispatch {
  /**
   * Answer one request for one share.
   * @param shareId - Share the Relay addressed.
   * @param request - Validated viewer request.
   * @param actor - Viewer identity the Relay asserted.
   * @param signal - Cancellation of the forwarded request.
   * @returns The answer the Relay writes back to the viewer.
   */
  answer(shareId: string, request: ViewerRequest, actor: ShareRpcActor, signal?: AbortSignal): Promise<ViewerAnswer>
  /**
   * Dispatch one ordinary owner call for one admitted viewer.
   * @param path - Owner endpoint path.
   * @param body - Opaque request body.
   * @param shareId - Share the request arrived through.
   * @param actor - Viewer identity the Relay asserted.
   * @param signal - Cancellation of the forwarded request.
   * @returns The owner's own answer.
   */
  dispatchCall(
    path: string,
    body: unknown,
    shareId: string,
    actor: ShareRpcActor,
    signal?: AbortSignal,
  ): Promise<ViewerAnswer>
}

/**
 * Build the request dispatch for one viewer reader.
 * @param input - Host services, lifecycle state, and the fork orchestrator.
 * @returns The reader's request entry and the plain owner-call dispatch a fork uses.
 */
export function createViewerDispatch(input: ViewerDispatchDeps): ViewerDispatch {
  const deps = input.deps
  const fork = input.fork
  const lifecycle = input.lifecycle
  const sessionOf = (shareId: string): string | undefined => deps.sharedSessionId(shareId)


  const dispatch = async (
    path: string,
    body: unknown,
    shareId: string,
    actor: ShareRpcActor,
    signal?: AbortSignal,
  ): Promise<ViewerAnswer> => {
    signal?.throwIfAborted()
    const handler = deps.connection?.createSharedFetchHandler('/api')
    const peer = lifecycle.peerFor(shareId, actor)
    if (handler === undefined || peer === undefined) return { status: 503, body: { error: 'viewer-read-unavailable' } }
    const response = await handler.fetch(new Request(`http://liveshare.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    }), peer)
    const payload: unknown = await response.json().catch(() => undefined)
    return { status: response.status, body: payload ?? { error: 'invalid-owner-response' } }
  }

  /**
   * Answer one prompt or cancel a viewer sent to the share's own Session.
   *
   * Both travel the standard Gateway dispatch under the source-write role: the Gateway decides the call
   * from the `share-viewer` policy and reaches the owner's own Session controller, so a cancel stops
   * whatever turn that Session is running. The policy's write rule (share admission, drivable tier,
   * confined layer) is read before dispatch and again after every await, because a mode change, a
   * removal, or an expiry that lands while preparation or dispatch is in flight must refuse the request
   * rather than be reported after it ran.
   */
  const answerSourceWrite = async (
    shareId: string,
    action: 'session/prompt' | 'session/cancel',
    path: string,
    body: unknown,
    actor: ShareRpcActor,
    signal?: AbortSignal,
  ): Promise<ViewerAnswer> => {
    const source = sessionOf(shareId)
    if (source === undefined) return { status: 403, body: { error: 'share-not-found' } }
    const refusedBefore = lifecycle.shareRefusal(shareId, actor)
    if (refusedBefore !== undefined) return refusedBefore
    const before = lifecycle.accessRefusal(shareId, actor, action, source, true)
    // Driving the source Session runs the viewer's input against the owner's machine, so it happens only
    // while the layer that confines that Session is installed and usable. A host whose backend cannot
    // anchor the operations refuses the prompt instead of running it against the owner's own tools.
    if (before !== undefined && before.reason !== 'source-write-unavailable') return before
    if (before !== undefined) {
      // A restarted host holds no layer for a Session whose agent is not live yet, and the layer is installed
      // by the same setup every agent creation runs through. Preparing the source Session through the owner's
      // own service is what makes that happen; the state is read back afterwards, and a host that still has
      // no usable layer refuses rather than driving the Session unconstrained.
      let prepared = false
      try {
        await deps.prepareSource?.(source)
        prepared = deps.prepareSource !== undefined
      } catch {
        // An unsuccessful preparation changes nothing: the refusal below is the answer either way.
      }
      const refusedDuringPreparation = lifecycle.shareRefusal(shareId, actor)
      if (refusedDuringPreparation !== undefined) return refusedDuringPreparation
      const after = lifecycle.accessRefusal(shareId, actor, action, source, true)
      if (after?.reason === 'source-write-unavailable') {
        return {
          status: 403,
          body: {
            error: 'source-write-unavailable',
            message: 'this host could not confine the shared session, so it cannot drive it',
            // Diagnostics only: whether this host asked its own service to prepare the Session. Neither
            // field is a path or a credential.
            prepared,
            session: 'known',
            ...(deps.sourceRefusal?.(shareId) === undefined
              ? {}
              : { reason: deps.sourceRefusal(shareId) }),
          },
        }
      }
      if (after !== undefined) return after
    }
    await lifecycle.refreshAdmission(shareId, signal)
    const refusedAtDispatch = lifecycle.trustedState(shareId, actor, action, source)
    if (refusedAtDispatch !== undefined) return refusedAtDispatch
    const answer = await dispatch(path, body, shareId, actor, signal)
    // Re-checked after the await: a share that stopped allowing writes while this ran must not be recorded
    // as having served it.
    const refusedAfterDispatch = lifecycle.shareRefusal(shareId, actor)
    if (refusedAfterDispatch !== undefined) return refusedAfterDispatch
    const after = lifecycle.accessRefusal(shareId, actor, action, source, true)
    if (after?.reason === 'source-write-unavailable') {
      return {
        status: 403,
        body: {
          error: 'source-write-unavailable',
          message: 'the shared session stopped being confined while this request ran',
        },
      }
    }
    return after ?? answer
  }

  /** Drive only the asserted viewer's fork of this share while its execution limit is installed. */
  const answerChildWrite = async (
    shareId: string,
    endpoint: 'session/prompt' | 'session/cancel',
    path: string,
    body: unknown,
    actor: ShareRpcActor,
    signal?: AbortSignal,
  ): Promise<ViewerAnswer> => {
    // Driving a child is execution on the owner's machine, so the share state is read before anything else
    // here: a revoked viewer, an elapsed deadline, and a stopped share are refused exactly as a read is,
    // whether or not the named child would also have been refused.
    const refusingShare = lifecycle.shareRefusal(shareId, actor)
    if (refusingShare !== undefined) return refusingShare
    const target = requestedSessionId(body)
    if (target === undefined) return dispatch(path, body, shareId, actor, signal)
    // The policy's snapshot rule decides before anything is resumed: the child is reachable through
    // this share, belongs to this reader, is not revoked, and the share still allows forks to act.
    const unattributed = lifecycle.accessRefusal(shareId, actor, endpoint, target, false)
    if (unattributed !== undefined) return unattributed
    if (endpoint === 'session/prompt') {
      const decision = deps.forks?.allowsPrompt(target, actor)
        ?? { ok: false as const, code: 'fork-ceiling-uninstalled' as const, message: 'this host has no fork registry' }
      // The one refusal a cold child still deserves a chance at is a missing limit: preparing it is what
      // installs that limit, before the agent is published.
      const preparing = !decision.ok && decision.code === 'fork-ceiling-uninstalled' && deps.prepareChild !== undefined
      const prepared = preparing ? await fork().prepareColdChild(target, actor, decision) : decision
      const refusedAfterPreparation = lifecycle.shareRefusal(shareId, actor)
      if (refusedAfterPreparation !== undefined) return refusedAfterPreparation
      // Re-authorize after preparation: resuming the child must not carry a request that stopped being
      // admissible while it ran.
      const racing = lifecycle.accessRefusal(shareId, actor, endpoint, target, false)
      if (racing !== undefined) return racing
      if (!prepared.ok) {
        console.warn(
          `[liveshare] child write refused share=${shareId} child=${target}`
          + ` endpoint=${path} code=${prepared.code} viewer=${actor.subjectId}`,
        )
        return { status: 403, body: { error: prepared.code, message: prepared.message } }
      }
    }
    await lifecycle.refreshAdmission(shareId, signal)
    const refusedAtDispatch = lifecycle.shareRefusal(shareId, actor)
      ?? lifecycle.accessRefusal(shareId, actor, endpoint, target, true)
    if (refusedAtDispatch !== undefined) return refusedAtDispatch
    // A body carrying both `sessionId` and `address` names two Session identities, so the Gateway's
    // Session resolver refuses it as invalid resources before the target operation runs. Prompt and
    // cancel requests name their Session by `sessionId` alone.
    return dispatch(path, body, shareId, actor, signal)
  }

  const answerCall = async (
    shareId: string,
    path: string,
    body: unknown,
    actor: ShareRpcActor,
    signal?: AbortSignal,
  ): Promise<ViewerAnswer> => {
    // Classify and forward one normalized target, never the raw string: `/api/session/./fork` or a query
    // suffix would otherwise skip the fork decision here and reach the owner's dispatch as an unrecorded
    // fork. `URL.canParse` answers without throwing; an unparseable target keeps the caller's path, which
    // matches no API endpoint, so it is forwarded exactly as received.
    const parsed = URL.canParse(path, 'http://liveshare.invalid')
      ? new URL(path, 'http://liveshare.invalid')
      : undefined
    const target = parsed === undefined ? path : `${parsed.pathname}${parsed.search}`
    const endpoint = parsed !== undefined && parsed.pathname.startsWith('/api/')
      ? parsed.pathname.slice('/api/'.length)
      : ''
    // Forking is decided here as well as by the policy: fork identity, replay, and the committed
    // boundary need state a synchronous policy does not read.
    if (endpoint === 'session/fork') return fork().answerFork(shareId, target, body, actor, signal)
    if (endpoint === 'session/prompt' || endpoint === 'session/cancel') {
      // A request naming the share's own source Session is decided by the source path whatever the mode,
      // so its refusal names the share's rule rather than the fork registry's "not a fork of a share".
      const source = sessionOf(shareId)
      if (source !== undefined && requestedSessionId(body) === source) {
        return answerSourceWrite(shareId, endpoint, target, body, actor, signal)
      }
      return answerChildWrite(shareId, endpoint, target, body, actor, signal)
    }
    if (sessionOf(shareId) === undefined) return { status: 404, body: { error: 'share-not-found' } }
    // A share this host still holds is not the same as a share that may still serve: its deadline, a stop,
    // and a grant that ended are decided here, before the owner's gateway reads anything for this viewer.
    const refused = lifecycle.shareRefusal(shareId, actor)
    if (refused !== undefined) return refused
    const answer = await dispatch(target, body, shareId, actor, signal)
    // A Peer disposed while the call ran is refused by the Gateway; the share's own refusal names why.
    const refusedAfter = lifecycle.shareRefusal(shareId, actor)
    if (refusedAfter !== undefined) return refusedAfter
    if (endpoint === 'session/list') return fork().annotateSessionList(answer, shareId, actor)
    // A branch page states its own branch facts: the projection value a page learned from the session
    // list is replaced by this Session's own baseline when the page opens it.
    const requested = endpoint === 'session/page' ? requestedAddressSession(body) : undefined
    const lineage = requested === undefined ? undefined : fork().lineageFor(shareId, requested, actor)
    return lineage === undefined ? answer : fork().withLineageAnswer(answer, lineage)
  }

  const answerStreamOpen = async (
    shareId: string,
    id: number,
    endpoint: string,
    payload: unknown,
    actor: ShareRpcActor,
    signal?: AbortSignal,
  ): Promise<ViewerAnswer> => {
    if (sessionOf(shareId) === undefined) return { status: 404, body: { error: 'share-not-found' } }
    // Refused before the opener runs, so a share that may not serve this viewer costs no upstream
    // subscription — and a stream that can never be read is never opened in the first place.
    const refused = lifecycle.shareRefusal(shareId, actor)
    if (refused !== undefined) return refused
    if (deps.gateway === undefined) return { status: 503, body: { error: 'viewer-read-unavailable' } }
    // Stream ids are the opening page's own numbering, so a live stream under this key means two
    // pages numbered a stream identically: the older one loses its stream to this open.
    const replaced = lifecycle.streamOf(shareId, id)
    if (replaced !== undefined) {
      if (!sameActor(replaced.actor, actor)) return viewerReadOnlyAnswer(endpoint)
      console.warn(
        `[liveshare] viewer stream replaced share=${shareId} streamId=${String(id)}`
        + ` endpoint=${endpoint} hadPending=${String(replaced.pending !== undefined)}`
        + ' — two viewer pages numbered their streams identically, or the page re-opened this id',
      )
    }
    const reserved = lifecycle.openingOf(shareId, id)
    if (reserved !== undefined && !sameActor(reserved.actor, actor)) return viewerReadOnlyAnswer(endpoint)
    const peer = lifecycle.peerFor(shareId, actor)
    if (peer === undefined) return { status: 503, body: { error: 'viewer-read-unavailable' } }
    lifecycle.release(shareId, id)
    const controller = new AbortController()
    const reservation = { shareId, actor, controller }
    lifecycle.reserveOpening(shareId, id, reservation)
    const cancelled = (): void => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', cancelled, { once: true })
    const values = await deps.gateway.wireStream.open(
      endpoint,
      payload,
      emptyViewerUplink(),
      peer,
      controller.signal,
    ).catch((error: unknown) => error)
    signal?.removeEventListener('abort', cancelled)
    lifecycle.releaseOpening(shareId, id, reservation)
    const refusedAfterOpen = lifecycle.shareRefusal(shareId, actor)
    if (refusedAfterOpen !== undefined) controller.abort()
    if (controller.signal.aborted) {
      if (isAsyncIterable(values)) void values[Symbol.asyncIterator]().return?.().catch(() => undefined)
      // Only the caller's abort or this share's own refusal aborts this controller; the caller's
      // abort wins when both happened, as it did before either answer was built.
      signal?.throwIfAborted()
      if (refusedAfterOpen !== undefined) return refusedAfterOpen
    }
    if (!isAsyncIterable(values)) {
      // A stream that never opened is a failure the viewer sees as a Remote failure, so its cause is
      // named here rather than only at the page.
      console.warn(
        `[liveshare] viewer stream open failed share=${shareId} streamId=${String(id)} endpoint=${endpoint}`
        + ` cause=${describeViewerStreamCause(values)}`,
      )
      return { status: 200, body: { failure: deps.gateway.wireStream.failure(values) } }
    }
    if (viewerReadDebugEnabled()) {
      console.log(`[liveshare] viewer stream open share=${shareId} streamId=${String(id)} endpoint=${endpoint}`)
    }
    const requested = endpoint === 'session/follow' ? requestedAddressSession(payload) : undefined
    lifecycle.registerStream({
      shareId,
      id,
      actor,
      endpoint,
      controller,
      // Every projection block a reader receives states the same branch facts its session list carried.
      iterator: endpoint === 'session/follow' || endpoint === 'session/control'
        ? fork().withLineageFrames(
          values,
          endpoint,
          requested,
          target => fork().lineageFor(shareId, target, actor),
        )
        : values[Symbol.asyncIterator](),
      pending: undefined,
      lastPolledAt: Date.now(),
    })
    return { status: 200, body: { opened: true } }
  }

  const answerStreamNext = async (
    shareId: string,
    id: number,
    actor: ShareRpcActor,
    signal?: AbortSignal,
  ): Promise<ViewerAnswer> => {
    const stream = lifecycle.streamOf(shareId, id)
    if (stream === undefined || deps.gateway === undefined) {
      // The carrier signal a page uses to know it must re-open rather than poll this id forever.
      if (viewerReadDebugEnabled()) {
        console.log(`[liveshare] viewer stream missing share=${shareId} streamId=${String(id)}`)
      }
      return { status: 404, body: { error: 'stream-not-found' } }
    }
    // A poll belongs to the opening identity, and both identity and share admission must still hold.
    if (!sameActor(stream.actor, actor)) return viewerReadOnlyAnswer('stream-next')
    const refused = lifecycle.shareRefusal(shareId, actor)
    if (refused !== undefined) {
      lifecycle.release(shareId, id)
      return refused
    }
    stream.lastPolledAt = Date.now()
    signal?.throwIfAborted()
    const gateway = deps.gateway
    const startedAt = Date.now()
    const pending = stream.pending ?? stream.iterator.next()
    stream.pending = pending
    const held = await pollStream(pending, STREAM_POLL_HOLD_MS,
      signal === undefined ? stream.controller.signal : AbortSignal.any([signal, stream.controller.signal]))
    // This poll answers within its hold by construction, so an answer later than the hold means this
    // host was the slow hop for the viewer's read and names the lag here instead of at the browser.
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs > STREAM_POLL_HOLD_MS + STREAM_POLL_SLACK_MS) {
      console.warn(
        `[liveshare] viewer stream poll late share=${shareId} id=${String(id)} elapsedMs=${String(elapsedMs)}`
        + ` holdMs=${String(STREAM_POLL_HOLD_MS)} outcome=${held.kind}`,
      )
    }
    const refusedAfterPoll = lifecycle.shareRefusal(shareId, actor)
    if (refusedAfterPoll !== undefined || !lifecycle.streamIsCurrent(shareId, id, stream)) {
      return refusedAfterPoll ?? { status: 404, body: { error: 'stream-not-found' } }
    }
    if (held.kind === 'pending') return { status: 200, body: { pending: true } }
    stream.pending = undefined
    if (held.kind === 'failure') {
      // This is the owner-side half of what the viewer reports as a Remote failure, so the cause is
      // logged with the stream it ends; it is also the reason the page cannot recover this id.
      console.warn(
        `[liveshare] viewer stream failed share=${shareId} streamId=${String(id)}`
        + ` elapsedMs=${String(Date.now() - startedAt)} cause=${describeViewerStreamCause(held.error)}`,
      )
      lifecycle.release(shareId, id)
      return { status: 200, body: { failure: gateway.wireStream.failure(held.error) } }
    }
    if (held.result.done === true) {
      lifecycle.release(shareId, id)
      return { status: 200, body: { end: true } }
    }
    // The value that ended the wait answers together with whatever the stream queued behind it: one
    // response costs one round trip to the page, so a burst that is already producing would pay one
    // trip per value. A pull still unanswered when the batch bounds run out stays this stream's
    // pending pull, exactly as an unanswered first pull does.
    stream.pending = undefined
    const values = await drainStream(stream, held.result.value)
    const refusedAfterDrain = lifecycle.shareRefusal(shareId, actor)
    if (refusedAfterDrain !== undefined || !lifecycle.streamIsCurrent(shareId, id, stream)) {
      return refusedAfterDrain ?? { status: 404, body: { error: 'stream-not-found' } }
    }
    return { status: 200, body: { values } }
  }

  /**
   * Collect the values one answer carries: the first value plus what the stream already queued.
   * @param stream - Open stream the poll belongs to.
   * @param first - Value that ended the poll's wait.
   * @returns The bounded, in-order batch.
   */
  const drainStream = async (stream: OpenStream, first: unknown): Promise<readonly unknown[]> => {
    const batch: unknown[] = [first]
    while (batch.length < STREAM_BATCH_MAX) {
      const pending = stream.iterator.next()
      stream.pending = pending
      const raced = await pollStream(pending, STREAM_BATCH_WINDOW_MS, stream.controller.signal)
      // Anything other than another value ends the batch here; `stream.pending` keeps it, so the next
      // poll answers with the failure, the end, or the hold that this pull is still waiting for.
      if (raced.kind !== 'value' || raced.result.done === true) return batch
      stream.pending = undefined
      batch.push(raced.result.value)
    }
    return batch
  }

  async function answer(
    shareId: string,
    request: ViewerRequest,
    actor: ShareRpcActor,
    signal?: AbortSignal,
  ): Promise<ViewerAnswer> {
    signal?.throwIfAborted()
    const callerSignal = signal
    const polledStream = request.op === 'stream-next' ? lifecycle.streamOf(shareId, request.id) : undefined
    const controller = request.op === 'call' ? new AbortController() : undefined
    if (controller !== undefined) {
      signal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    }
    const call = controller === undefined || signal === undefined ? undefined
      : lifecycle.beginCall(shareId, actor, controller, signal)
    const abortStream = (): void => {
      if (request.op === 'call' || request.op === 'asset') return
      const stream = lifecycle.streamOf(shareId, request.id) ?? lifecycle.openingOf(shareId, request.id)
      if (stream !== undefined && sameActor(stream.actor, actor)) lifecycle.release(shareId, request.id)
    }
    signal?.addEventListener('abort', abortStream, { once: true })
    const answer = await (async (): Promise<ViewerAnswer> => {
      // A reader asking for its page or opening a stream is about to receive its own access snapshot:
      // ask for this share's source to be prepared first (see `prepareSourceForReader`). It is
      // asked before the refresh so a share whose Relay mode cannot be read still names that state, and
      // the installation re-pushes the snapshot the page follows, so nothing here has to wait for it.
      // Both requests are one per page load, so no poll drives this.
      if (request.op === 'asset' || request.op === 'stream-open') deps.prepareSourceForReader?.(shareId)
      await lifecycle.refreshAdmission(shareId, signal)
      callerSignal?.throwIfAborted()
      if (polledStream !== undefined && sameActor(polledStream.actor, actor)) {
        const refused = lifecycle.shareRefusal(shareId, actor)
        if (refused !== undefined) {
          if (request.op === 'stream-next' && lifecycle.streamOf(shareId, request.id) === polledStream) {
            lifecycle.release(shareId, request.id)
          }
          return refused
        }
      }
      switch (request.op) {
        case 'call': {
          if (deps.debug === true) console.log(`[liveshare] viewer read share=${shareId} path=${request.path}`)
          return answerCall(shareId, request.path, request.body, actor, signal)
        }
        case 'stream-open': {
          if (deps.debug === true) console.log(`[liveshare] viewer stream open share=${shareId} endpoint=${request.endpoint}`)
          return answerStreamOpen(shareId, request.id, request.endpoint, request.payload, actor, signal)
        }
        case 'stream-next':
          return answerStreamNext(shareId, request.id, actor, signal)
        case 'asset': {
          const refused = lifecycle.shareRefusal(shareId, actor)
          if (refused !== undefined) return refused
          if (!isViewerAssetPath(request.path)) return { status: 404, body: { error: 'asset-not-found' } }
          if (deps.readAsset === undefined) return { status: 503, body: { error: 'viewer-page-unavailable' } }
          const startedAt = Date.now()
          const peer = lifecycle.peerFor(shareId, actor)
          if (peer === undefined) return { status: 503, body: { error: 'viewer-page-unavailable' } }
          const read = await deps.readAsset(request.path, peer)
          // Only the document itself loses its manifest link; the Owner's own page reads the same bytes
          // from the static reader and keeps it.
          const served = request.path === '' ? withoutManifestLink(read) : read
          if (deps.debug === true && served.status === 200) {
            console.log(
              `[liveshare] viewer asset share=${shareId} path=${request.path}`
                + ` bytes=${String(assetBodyBytes(served.body))} ms=${String(Date.now() - startedAt)}`,
            )
          }
          return served
        }
        case 'stream-cancel':
          const held = lifecycle.streamOf(shareId, request.id) ?? lifecycle.openingOf(shareId, request.id)
          if (held !== undefined && !sameActor(held.actor, actor)) {
            return viewerReadOnlyAnswer('stream-cancel')
          }
          if (viewerReadDebugEnabled()) {
            console.log(`[liveshare] viewer stream cancel share=${shareId} streamId=${String(request.id)}`)
          }
          lifecycle.release(shareId, request.id)
          return { status: 200, body: { cancelled: true } }
        default:
          return assertNever(request)
      }
    })().finally(() => {
      signal?.removeEventListener('abort', abortStream)
      if (call !== undefined) lifecycle.endCall(call)
    })
    signal?.throwIfAborted()
    if (deps.debug === true && answer.status !== 200) {
      console.log(
        `[liveshare] viewer read refused share=${shareId} op=${request.op}`
          + ` target=${request.op === 'call' || request.op === 'asset' ? request.path : request.op === 'stream-open' ? request.endpoint : String(request.id)}`
          + ` status=${String(answer.status)}`,
      )
    }
    return answer
  }


  return {
    answer,
    dispatchCall: dispatch,
  }
}

/**
 * Uplink of one read-only viewer stream.
 *
 * The viewer channel is request/poll only, so the page sends no Client-to-Host item inside an open
 * stream and this direction is empty by construction. It is still supplied because the gateway's
 * opener takes the position, and a fresh iterator per open keeps one stream's end from becoming
 * another's.
 * @returns An async iterable that yields nothing.
 */
function emptyViewerUplink(): AsyncIterable<unknown> {
  return (async function* () {})()
}


/** Wait for one owned pull, bounded by time or cancellation, and always release its timer. */
async function pollStream(
  pending: Promise<IteratorResult<unknown>>, ms: number, signal?: AbortSignal,
): Promise<
  | { kind: 'value'; result: IteratorResult<unknown> }
  | { kind: 'failure'; error: unknown }
  | { kind: 'pending' }
> {
  signal?.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort!: () => void
  const stop = new Promise<{ kind: 'pending' }>((resolve, reject) => {
    timer = setTimeout(() => { resolve({ kind: 'pending' }) }, ms)
    abort = () => { reject(new Error('Viewer request cancelled', { cause: signal?.reason })) }
    signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([
      pending.then(result => ({ kind: 'value' as const, result }), (error: unknown) => ({ kind: 'failure' as const, error })),
      stop,
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}


/**
 * Exact top-level files of the owner's served page the owner answers.
 *
 * The owner's index references these against the document base rather than inside `assets/`, so the page
 * requests them by exact name. The Relay admits the same three names and forwards their reads, so both
 * halves of the channel hold one list: admitting them makes no other top-level file readable.
 */
const VIEWER_TOP_LEVEL_FILES: readonly string[] = ['manifest.webmanifest', 'favicon.svg', 'favicon-dark.svg']

/**
 * Whether one page-relative path names a resource of the served page: the index, a shell asset, a client
 * plugin bundle, or one of {@link VIEWER_TOP_LEVEL_FILES}. The resource readers reject traversal and
 * unknown bundles themselves.
 * @param path - Page-relative path the viewer asked for, including any query.
 * @returns True for a path the owner may answer.
 */
function isViewerAssetPath(path: string): boolean {
  // A source map is not a page resource: serving one would hand a viewer the Owner's original sources.
  // This gate is authoritative for both a page-resource read and an `asset` op forwarded through the
  // Relay, which forwards both as this same parse: neither the request line nor the body is read there.
  if (namesSourceMap(path)) return false
  if (path === '' || path === 'index.html' || path.startsWith('assets/') || path.startsWith('plugins/')) return true
  // A top-level file carries no directory, so only the part before any query is compared: a prefix match
  // would admit a sibling such as `favicon.svg.map`.
  const pathname = path.split('?')[0] as string
  return VIEWER_TOP_LEVEL_FILES.some(name => pathname === name)
}

/** A `.map` extension that ends one file name, before the `&` flags a plugin bundle key may carry. */
const SOURCE_MAP_EXTENSION = /\.map(?:[?&]|$)/u

/**
 * Whether one asset path names a source map.
 *
 * The extension must end the file name, so a bundle key such as `plugins/??a,b/x.js.map&rev=1` counts
 * while `index-abc.js` and `client.css` do not. The percent-decoded form is read too, because the
 * resource readers decode before they resolve a file: `assets/x.js%2Emap` names the same map.
 * @param path - Page-relative path the viewer asked for.
 * @returns True when the path names a source map.
 */
function namesSourceMap(path: string): boolean {
  if (SOURCE_MAP_EXTENSION.test(path)) return true
  try {
    return SOURCE_MAP_EXTENSION.test(decodeURIComponent(path))
  } catch {
    // A malformed escape names no file either reader resolves, so the requested text alone decides.
    return false
  }
}

/**
 * Drop the document's manifest link from one served viewer document.
 *
 * A browser fetches a manifest without credentials, so the Relay cannot resolve the share from that
 * request and answers its own 404 — no function is lost, but every viewer page load would carry that
 * noise. The whole line goes, and every other byte of the document is preserved.
 * @param answer - Owner answer for the document read.
 * @returns The same answer without the manifest link line, or unchanged when it carries no asset body.
 */
function withoutManifestLink(answer: ViewerAnswer): ViewerAnswer {
  if (answer.status !== 200 || !isViewerAssetBody(answer.body)) return answer
  const html = Buffer.from(answer.body.base64, 'base64').toString('utf8')
  const stripped = html.split('\n').filter(line => !line.includes('rel="manifest"')).join('\n')
  if (stripped === html) return answer
  return {
    status: 200,
    body: { contentType: answer.body.contentType, base64: Buffer.from(stripped, 'utf8').toString('base64') },
  }
}

/**
 * Whether one owner answer body carries a decoded page resource.
 * @param body - Owner answer body.
 * @returns True when it holds the content type and base64 bytes of one resource.
 */
function isViewerAssetBody(body: unknown): body is ViewerAssetBody {
  return isRecord(body) && typeof body.contentType === 'string' && typeof body.base64 === 'string'
}

/** Whether per-request viewer-read lines are recorded; anomalies log regardless. */
function viewerReadDebugEnabled(): boolean {
  return process.env.LIVESHARE_DEBUG_READS === '1'
}

/**
 * Describe one stream cause for a log without carrying payload or credentials.
 * @param cause Thrown value or failure object a stream ended with.
 * @returns Name, message, and abort state when the value has them.
 */
function describeViewerStreamCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}${cause.name === 'AbortError' ? ' (aborted)' : ''}`
  }
  if (typeof cause === 'object' && cause !== null) {
    const value = cause as { readonly code?: unknown; readonly message?: unknown }
    const code = typeof value.code === 'string' ? value.code : 'object'
    const message = typeof value.message === 'string' ? `: ${value.message}` : ''
    return `${code}${message}`
  }
  return typeof cause
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

/**
 * Decoded byte count of one served page resource, measured from its base64 body.
 * @param body - Owner answer body of a status-200 asset read.
 * @returns The resource's byte count, or undefined when the body carries no base64 payload.
 */
function assetBodyBytes(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined
  const base64 = body.base64
  if (typeof base64 !== 'string') return undefined
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor(base64.length * 3 / 4) - padding
}

function assertNever(value: never): never {
  throw new Error(`liveshare: unhandled viewer request ${JSON.stringify(value)}`)
}
