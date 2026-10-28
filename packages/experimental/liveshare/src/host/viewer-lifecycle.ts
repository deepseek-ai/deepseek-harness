/**
 * Lifecycle state of one viewer reader: streams, calls, reader Peers, and share refusals.
 *
 * Every viewer request is admitted against the share's lifecycle here, and every resource a request
 * opens — a reader Peer, an open stream, an in-flight call, a child's enforcement — is released from
 * this module. Closing a share or a viewer walks exactly the resources that belong to it.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/viewer-lifecycle
 */

import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { isExpired, type ForkShareState } from './fork-policy.ts'
import { shareViewerPrincipal } from './viewer-principal.ts'
import type { ReaderWriteAction } from './viewer-access-policy.ts'
import type { ViewerAnswer } from '../viewer-channel.ts'
import type { ViewerReadDeps } from './viewer-read.ts'

function sameActor(left: ShareRpcActor, right: ShareRpcActor): boolean {
  return identityKeyOf(left) === identityKeyOf(right)
}

/**
 * How long one open viewer stream may stay unpolled before this host releases it.
 *
 * A page polls each open stream without pause and one poll's hold is {@link STREAM_POLL_HOLD_MS}, so a
 * stream nothing has polled for this long belongs to a page that is gone: closed, discarded by the
 * browser, or offline past its own reconnect backoff. Releasing it stops this host holding the stream
 * and the upstream subscription the owner's gateway opened for it. The value is many poll holds, so an
 * ordinary reconnect or one slow answer never costs a stream the page is still reading.
 */
export const VIEWER_STREAM_IDLE_TTL_MS = 120_000

/** How often open streams are checked against {@link VIEWER_STREAM_IDLE_TTL_MS}. */
const STREAM_SWEEP_INTERVAL_MS = 30_000
/**
 * The refusal one share's own lifecycle applies, whatever a viewer asks through it.
 *
 * A share the owner stopped and one whose deadline passed authorize nothing. The write path reads these
 * two verdicts before it drives a Session; every read path reads them here, so a viewer cannot keep
 * reading a share the owner ended. Share state this host cannot read — a host that publishes none — is
 * not a refusal this function may name.
 * @param share - Share state as the owner host holds it, when it holds one.
 * @returns The refusal, or undefined while the share may serve.
 */
export function shareLifecycleRefusal(share: ForkShareState | undefined): ViewerAnswer | undefined {
  if (share === undefined) return undefined
  if (share.stopped) {
    return { status: 403, body: { error: 'share-stopped', message: 'this share is stopped' } }
  }
  if (isExpired(share.expiresAt, Date.now())) {
    return { status: 403, body: { error: 'share-expired', message: 'this share has expired' } }
  }
  return undefined
}

/**
 * One stream this reader holds open for a viewer page, from the reservation that opened it until the
 * page stops polling it or the share closes.
 *
 * The page's polls drive `pending`, and an unpolled stream past `lastPolledAt`'s idle deadline is a page
 * that went away, so the reader releases the stream and the owner gateway's upstream subscription.
 */
export interface OpenStream {
  readonly shareId: string
  /** Stream id the page numbered this read under, which is also its key within the share. */
  readonly id: number
  readonly endpoint: string
  /** Identity the stream opened as, re-checked on every poll. */
  readonly actor: ShareRpcActor
  readonly controller: AbortController
  iterator: AsyncIterator<unknown>
  pending: Promise<IteratorResult<unknown>> | undefined
  /** When this stream last answered a poll; an unpolled stream is a page that went away. */
  lastPolledAt: number
}

/** The Peer one reader of one share speaks for. */
interface ReaderPeer {
  readonly shareId: string
  readonly actor: ShareRpcActor
  readonly peer: PeerScope
}
/** One viewer call this reader is serving, tracked so a grant that ends can abort it. */
export interface ViewerCall {
  readonly shareId: string
  readonly actor: ShareRpcActor
  readonly controller: AbortController
  readonly signal: AbortSignal
  refreshing: boolean
}

/** A stream opening reserved before the owner gateway answers. */
export interface OpeningReservation {
  readonly shareId: string
  readonly actor: ShareRpcActor
  readonly controller: AbortController
}

/** Lifecycle state and refusal answers one viewer reader exposes. */
export interface ViewerLifecycle {
  /**
   * The refusal one share's own lifecycle applies, whatever a viewer asks through it.
   * @param shareId - Share the request arrived through.
   * @param actor - Viewer identity the Relay asserted.
   * @returns The refusal, or undefined while the share may still serve this viewer.
   */
  shareRefusal(shareId: string, actor: ShareRpcActor): ViewerAnswer | undefined
  /**
   * The policy's refusal of one reader prompt or cancel on one Session, as the page's refusal answer.
   * @param shareId - Share the request arrived through.
   * @param actor - Viewer identity the Relay asserted.
   * @param action - `session/prompt` or `session/cancel`.
   * @param sessionId - Session the request names.
   * @param concrete - True for the call about to be dispatched, false for the snapshot rule.
   * @returns The refusal, or undefined while the policy allows the request.
   */
  accessRefusal(
    shareId: string,
    actor: ShareRpcActor,
    action: ReaderWriteAction,
    sessionId: string,
    concrete: boolean,
  ): (ViewerAnswer & { readonly reason: string }) | undefined
  /**
   * The share's lifecycle refusal followed by the policy's write refusal.
   * @param shareId - Share the request arrived through.
   * @param actor - Viewer identity the Relay asserted.
   * @param action - `session/prompt` or `session/cancel`.
   * @param source - Session the request names.
   * @returns The refusal, or undefined while the request may be dispatched.
   */
  trustedState(shareId: string, actor: ShareRpcActor, action: ReaderWriteAction, source: string): ViewerAnswer | undefined
  /**
   * Refresh authoritative admission, marking the call whose signal it is as refreshing.
   * @param shareId - Share to refresh.
   * @param signal - Signal of the request being refreshed.
   */
  refreshAdmission(shareId: string, signal?: AbortSignal): Promise<void>
  /**
   * Track one call as in flight.
   * @param shareId - Share the call belongs to.
   * @param actor - Caller identity.
   * @param controller - Controller that aborts this call.
   * @param signal - Signal that identifies this call during a refresh.
   * @returns The tracked call.
   */
  beginCall(shareId: string, actor: ShareRpcActor, controller: AbortController, signal: AbortSignal): ViewerCall
  /**
   * Stop tracking one call.
   * @param call - The call that ended.
   */
  endCall(call: ViewerCall): void
  /**
   * The Peer one reader of one share speaks for, created on its first dispatch.
   * @param shareId - Share the call belongs to.
   * @param actor - Reader identity.
   * @returns The Peer, or undefined when this host has no Connection.
   */
  peerFor(shareId: string, actor: ShareRpcActor): PeerScope | undefined
  /**
   * Dispose every tracked Reader Peer that matches.
   * @param matches - Which Peers to dispose.
   */
  disposePeers(matches: (entry: ReaderPeer) => boolean): void
  /**
   * One open stream.
   * @param shareId - Share the stream belongs to.
   * @param id - Stream id the page numbered.
   * @returns The stream, or undefined when none is open.
   */
  streamOf(shareId: string, id: number): OpenStream | undefined
  /**
   * One stream opening reserved before the owner gateway answers.
   * @param shareId - Share the stream belongs to.
   * @param id - Stream id the page numbered.
   * @returns The reservation, or undefined when none is held.
   */
  openingOf(shareId: string, id: number): OpeningReservation | undefined
  /**
   * Reserve one stream id before the owner gateway answers.
   * @param shareId - Share the stream belongs to.
   * @param id - Stream id the page numbered.
   * @param reservation - Reservation to hold.
   */
  reserveOpening(shareId: string, id: number, reservation: OpeningReservation): void
  /**
   * Drop one opening reservation when it is still the one held.
   * @param shareId - Share the stream belongs to.
   * @param id - Stream id the page numbered.
   * @param reservation - Reservation the opener holds.
   * @returns True when this reservation was the one still held.
   */
  releaseOpening(shareId: string, id: number, reservation: OpeningReservation): boolean
  /**
   * Record one opened stream and arm the idle sweep.
   * @param stream - Stream the owner gateway opened.
   */
  registerStream(stream: OpenStream): void
  /**
   * Release one stream and the upstream subscription it holds.
   * @param shareId - Share the stream belongs to.
   * @param id - Stream id the page numbered.
   */
  release(shareId: string, id: number): void
  /**
   * Whether one stream is still the open one under its key.
   * @param shareId - Share the stream belongs to.
   * @param id - Stream id the page numbered.
   * @param stream - Stream to compare.
   * @returns True while that stream is current and not aborted.
   */
  streamIsCurrent(shareId: string, id: number, stream: OpenStream): boolean
  /** Arm the timer that reclaims streams nothing polls. */
  armSweep(): void
  /**
   * Keep one child's enforcement release until its share or reader ends.
   * @param childSessionId - Child whose limit was installed.
   * @param releaseEnforcement - Disposer that releases the limit.
   */
  holdEnforcement(childSessionId: string, releaseEnforcement: () => void): void
  /**
   * Cancel pending calls without releasing retained streams or child enforcement.
   * @param shareId - Share whose mode was narrowed.
   */
  cancelPendingCalls(shareId: string): void
  /**
   * End only calls, streams, and reader Peers whose reader lost admission.
   * @param shareId - Share whose readers are re-checked.
   */
  recheckAdmission(shareId: string): void
  /**
   * Cancel pending calls, release every stream, and dispose every reader Peer of one share.
   * @param shareId - Share whose pending calls, streams, and Peers end.
   */
  closeShare(shareId: string): void
  /**
   * End only calls, streams, and reader Peers of one reader of one share.
   * @param shareId - Share the viewer's streams belong to.
   * @param viewer - Identity the Relay asserted when those streams opened.
   * @returns How many streams were released.
   */
  closeViewerStreams(shareId: string, viewer: ShareRpcActor): number
  /** Cancel pending calls, release every open stream, and dispose every reader Peer. */
  close(): void
}

/**
 * Build the lifecycle state of one viewer reader.
 * @param deps - Host services and the share-to-Session lookup.
 * @returns Lifecycle state and refusal answers.
 */
export function createViewerLifecycle(deps: ViewerReadDeps): ViewerLifecycle {
  const streams = new Map<string, OpenStream>()
  const calls = new Set<ViewerCall>()
  // The current call reports the refreshed refusal itself; other work still loses admission immediately.
  const refreshAdmission = async (shareId: string, signal?: AbortSignal): Promise<void> => {
    const current = [...calls].find(call => call.signal === signal)
    if (current !== undefined) current.refreshing = true
    try {
      await deps.refreshAdmission?.(shareId, signal)
    } finally {
      if (current !== undefined) current.refreshing = false
    }
  }
  const cancelCalls = (shareId: string, actor?: ShareRpcActor): void => {
    for (const call of calls) {
      if (call.shareId !== shareId || (actor !== undefined && !sameActor(call.actor, actor))) continue
      calls.delete(call)
      call.controller.abort(new Error(actor === undefined ? 'Share access ended' : 'Viewer access ended'))
    }
  }
  const opening = new Map<string, { shareId: string; actor: ShareRpcActor; controller: AbortController }>()
  /** Live enforcement per child, released with the child's share so a disposal refuses again. */
  const enforcement = new Map<string, () => void>()
  const key = (shareId: string, id: number): string => `${shareId}\u0000${String(id)}`
  const streamIsCurrent = (shareId: string, id: number, stream: OpenStream): boolean =>
    !stream.controller.signal.aborted && streams.get(key(shareId, id)) === stream

  /**
   * One Peer per share and reader, created on its first dispatch.
   *
   * Every page and tab of one reader shares it: the viewer channel carries no connection identity. A
   * disposed Peer is replaced on the reader's next admitted request, and a call still in flight on the
   * disposed one is refused by the Gateway.
   */
  const peers = new Map<string, ReaderPeer>()
  const peerKey = (shareId: string, actor: ShareRpcActor): string => `${shareId}\u0000${identityKeyOf(actor)}`
  const peerFor = (shareId: string, actor: ShareRpcActor): PeerScope | undefined => {
    const connection = deps.connection
    if (connection === undefined) return undefined
    const held = peers.get(peerKey(shareId, actor))
    if (held !== undefined && !held.peer.signal.aborted) return held.peer
    const peer = connection.createPeer({ principal: shareViewerPrincipal(shareId, actor) })
    peers.set(peerKey(shareId, actor), { shareId, actor, peer })
    return peer
  }
  const disposePeers = (matches: (entry: ReaderPeer) => boolean): void => {
    for (const [entryKey, entry] of peers) {
      if (!matches(entry)) continue
      peers.delete(entryKey)
      entry.peer.dispose().catch((error: unknown) => {
        // Disposal failures belong to the registrations the Peer carried; the reader is already detached.
        console.warn(
          `[liveshare] viewer peer disposal failed share=${entry.shareId}`
          + ` error=${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
  }

  /** Timer sweeping streams nothing polls; armed while this reader holds at least one stream. */
  let sweepTimer: ReturnType<typeof setInterval> | undefined
  const stopSweep = (): void => {
    if (sweepTimer === undefined) return
    clearInterval(sweepTimer)
    sweepTimer = undefined
  }
  /**
   * Release every stream no page has polled within {@link VIEWER_STREAM_IDLE_TTL_MS}.
   *
   * A page that closed, crashed, or lost its network leaves its streams behind: the client's own
   * `stream-cancel` travels the same request/poll channel as its reads and is dropped with them, so
   * nothing else tells this host the reader is gone. Idleness is that signal, and releasing a stream
   * aborts the upstream subscription the owner's gateway opened for it.
   */
  const sweepIdleStreams = (): void => {
    const now = Date.now()
    for (const [streamKey, stream] of streams) {
      const idleMs = now - stream.lastPolledAt
      if (idleMs <= VIEWER_STREAM_IDLE_TTL_MS) continue
      streams.delete(streamKey)
      stream.controller.abort()
      void stream.iterator.return?.(undefined).catch(() => undefined)
      console.warn(
        `[liveshare] viewer stream reclaimed share=${stream.shareId}`
        + ` streamId=${String(stream.id)} idleMs=${String(idleMs)}`,
      )
    }
    if (streams.size === 0) stopSweep()
  }
  const armSweep = (): void => {
    if (sweepTimer !== undefined) return
    const timer = setInterval(sweepIdleStreams, STREAM_SWEEP_INTERVAL_MS)
    // Idle cleanup is not work the process owes anyone: it must never hold a host open by itself.
    timer.unref()
    sweepTimer = timer
  }
  /** Drop the sweep timer once the last stream is gone, so an idle reader keeps no timer at all. */
  const stopSweepWhenIdle = (): void => {
    if (streams.size === 0) stopSweep()
  }

  const release = (shareId: string, id: number): void => {
    const streamKey = key(shareId, id)
    const reserved = opening.get(streamKey)
    if (reserved !== undefined) {
      opening.delete(streamKey)
      reserved.controller.abort()
    }
    const stream = streams.get(streamKey)
    if (stream === undefined) return
    streams.delete(streamKey)
    stream.controller.abort()
    void stream.iterator.return?.(undefined).catch(() => undefined)
    stopSweepWhenIdle()
  }

  /**
   * The answer refusing one viewer request over a share this host may no longer serve it through.
   *
   * The verdicts are the write path's own, so one share state reads the same whatever a viewer asks:
   * a stopped share is `share-stopped`, a share past its deadline is `share-expired`, and a viewer whose
   * grant ended is `viewer-not-authorized`. Each is a stable code the served page already classifies as
   * terminal, so a refused read states the reason instead of reconnecting around it. A host with no
   * share state to read — the focused reader tests — invents no refusal.
   * @param shareId - Share the request arrived through.
   * @param actor - Viewer identity the Relay asserted.
   * @returns The refusal, or undefined while the share may still serve this viewer.
   */
  const shareRefusal = (shareId: string, actor: ShareRpcActor): ViewerAnswer | undefined => {
    const lifecycle = shareLifecycleRefusal(deps.forkStateOf?.(shareId))
    if (lifecycle !== undefined) return lifecycle
    if (deps.viewerStillAdmitted === undefined) return undefined
    return deps.viewerStillAdmitted(shareId, actor)
      ? undefined
      : {
        status: 403,
        body: {
          error: 'viewer-not-authorized',
          message: 'this viewer no longer holds access to this share',
        },
      }
  }

  /**
   * The policy's refusal of one reader prompt or cancel on one Session, as the page's refusal answer.
   * @param shareId - Share the request arrived through.
   * @param actor - Viewer identity the Relay asserted.
   * @param action - `session/prompt` or `session/cancel`.
   * @param sessionId - Session the request names.
   * @param concrete - True for the call about to be dispatched, false for the snapshot rule.
   * @returns The refusal, or undefined while the policy allows the request.
   */
  const accessRefusal = (
    shareId: string,
    actor: ShareRpcActor,
    action: ReaderWriteAction,
    sessionId: string,
    concrete: boolean,
  ): (ViewerAnswer & { readonly reason: string }) | undefined => {
    const reason = deps.writeRefusal?.(shareViewerPrincipal(shareId, actor), action, sessionId, concrete)
    return reason === undefined ? undefined : { reason, status: 403, body: { error: reason } }
  }
  function cancelPendingCalls(shareId: string): void {
    cancelCalls(shareId)
  }

  function recheckAdmission(shareId: string): void {
    for (const call of calls) {
      if (call.shareId === shareId && !call.refreshing && shareRefusal(shareId, call.actor) !== undefined) {
        call.controller.abort(new Error('Viewer access ended'))
      }
    }
    for (const held of [...opening.values(), ...streams.values()]) {
      if (held.shareId === shareId && shareRefusal(shareId, held.actor) !== undefined) {
        for (const [streamKey, candidate] of opening) {
          if (candidate === held) { opening.delete(streamKey); candidate.controller.abort() }
        }
        for (const candidate of streams.values()) {
          if (candidate === held) release(shareId, candidate.id)
        }
      }
    }
    disposePeers(entry => entry.shareId === shareId && shareRefusal(shareId, entry.actor) !== undefined)
  }

  function closeShare(shareId: string): void {
    cancelCalls(shareId)
    for (const [streamKey, reserved] of opening) {
      if (reserved.shareId !== shareId) continue
      opening.delete(streamKey)
      reserved.controller.abort()
    }
    for (const [streamKey, stream] of streams) {
      if (stream.shareId === shareId) {
        streams.delete(streamKey)
        stream.controller.abort()
        void stream.iterator.return?.(undefined).catch(() => undefined)
      }
    }
    stopSweepWhenIdle()
    disposePeers(entry => entry.shareId === shareId)
    // A share going away takes its children's limits with it, so a child that outlives its share
    // refuses again rather than running under a limit nobody can attribute.
    for (const [childSessionId, releaseEnforcement] of enforcement) {
      if (deps.forks?.find(childSessionId)?.shareId !== shareId) continue
      releaseEnforcement()
      enforcement.delete(childSessionId)
    }
  }

  function closeViewerStreams(shareId: string, viewer: ShareRpcActor): number {
    cancelCalls(shareId, viewer)
    let released = 0
    for (const [streamKey, reserved] of opening) {
      if (reserved.shareId !== shareId || !sameActor(reserved.actor, viewer)) continue
      opening.delete(streamKey)
      reserved.controller.abort()
      released += 1
    }
    for (const [streamKey, stream] of streams) {
      if (stream.shareId !== shareId || !sameActor(stream.actor, viewer)) continue
      streams.delete(streamKey)
      stream.controller.abort()
      void stream.iterator.return?.(undefined).catch(() => undefined)
      released += 1
    }
    stopSweepWhenIdle()
    disposePeers(entry => entry.shareId === shareId && sameActor(entry.actor, viewer))
    return released
  }

  function close(): void {
    for (const call of calls) call.controller.abort(new Error('Viewer service disposed'))
    calls.clear()
    for (const reserved of opening.values()) reserved.controller.abort()
    opening.clear()
    for (const stream of streams.values()) {
      stream.controller.abort()
      void stream.iterator.return?.(undefined).catch(() => undefined)
    }
    streams.clear()
    stopSweep()
    disposePeers(() => true)
    for (const releaseEnforcement of enforcement.values()) releaseEnforcement()
    enforcement.clear()
  }

  /** The share's lifecycle refusal followed by the policy's write refusal. */
  const trustedState = (
    shareId: string,
    actor: ShareRpcActor,
    action: ReaderWriteAction,
    source: string,
  ): ViewerAnswer | undefined =>
    shareRefusal(shareId, actor) ?? accessRefusal(shareId, actor, action, source, true)

  function beginCall(
    shareId: string,
    actor: ShareRpcActor,
    controller: AbortController,
    signal: AbortSignal,
  ): ViewerCall {
    const call: ViewerCall = { shareId, actor, controller, signal, refreshing: false }
    calls.add(call)
    return call
  }

  function endCall(call: ViewerCall): void {
    calls.delete(call)
  }

  function streamOf(shareId: string, id: number): OpenStream | undefined {
    return streams.get(key(shareId, id))
  }

  function openingOf(shareId: string, id: number): OpeningReservation | undefined {
    return opening.get(key(shareId, id))
  }

  function reserveOpening(shareId: string, id: number, reservation: OpeningReservation): void {
    opening.set(key(shareId, id), reservation)
  }

  function releaseOpening(shareId: string, id: number, reservation: OpeningReservation): boolean {
    const streamKey = key(shareId, id)
    if (opening.get(streamKey) !== reservation) return false
    opening.delete(streamKey)
    return true
  }

  function registerStream(stream: OpenStream): void {
    streams.set(key(stream.shareId, stream.id), stream)
    armSweep()
  }

  function holdEnforcement(childSessionId: string, releaseEnforcement: () => void): void {
    enforcement.set(childSessionId, releaseEnforcement)
  }

  return {
    shareRefusal,
    accessRefusal,
    trustedState,
    refreshAdmission,
    beginCall,
    endCall,
    peerFor,
    disposePeers,
    streamOf,
    openingOf,
    reserveOpening,
    releaseOpening,
    registerStream,
    release,
    streamIsCurrent,
    armSweep,
    holdEnforcement,
    cancelPendingCalls,
    recheckAdmission,
    closeShare,
    closeViewerStreams,
    close,
  }
}
