/**
 * Owner-side reader for one share's viewer requests: assembly and the host services it reads.
 *
 * The Relay forwards each request unread, so this module is its only reader on the owner side. The
 * reader is assembled from three cooperating parts: {@link createViewerLifecycle} owns streams, calls,
 * Peers, and lifecycle refusals; {@link createViewerFork} owns fork orchestration and branch facts;
 * {@link createViewerDispatch} classifies and answers each request. This module states the services
 * those parts read and the interface the host mounts, so a host sees one reader with one contract.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/viewer-read
 */

import type { TypertGatewayWireStream } from '@deepseek-ai/dsh-api-gateway/types'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { ViewerAnswer, ViewerRequest } from '../viewer-channel.ts'
import type { ForkRegistry } from './fork-registry.ts'
import type { ForkShareState } from './fork-policy.ts'
import type { ReaderWriteAction } from './viewer-access-policy.ts'
import type { ShareViewerPrincipal } from './viewer-principal.ts'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { createViewerDispatch, type ViewerDispatch } from './viewer-dispatch.ts'
import { createViewerFork, type ViewerFork } from './viewer-fork.ts'
import { createViewerLifecycle, type ViewerLifecycle } from './viewer-lifecycle.ts'

export { VIEWER_STREAM_IDLE_TTL_MS } from './viewer-lifecycle.ts'

/** Host Connection members the owner dispatches viewer calls through. */
export type ViewerReadConnection = Pick<HostConnectionHandle, 'createSharedFetchHandler' | 'createPeer'>

/**
 * Minimal Typert gateway view the owner needs to open viewer streams.
 *
 * `wireStream` is the base gateway's own exported stream contract, so the opener's positional
 * arguments keep the meaning the gateway gives them: uplink, peer, then cancellation signal.
 */
export interface ViewerReadGateway {
  /** Carrier-facing stream opener and failure mapping shared by every Remote carrier. */
  readonly wireStream: TypertGatewayWireStream
}

/** Host services one owner uses to answer viewer reads. */
export interface ViewerReadDeps {
  /** Host Connection service; absent in profiles without the api gateway. */
  readonly connection?: ViewerReadConnection
  /** Typert gateway; absent in profiles without the api gateway. */
  readonly gateway?: ViewerReadGateway
  /**
   * Session the named share currently points at.
   * @param shareId - Share the Relay addressed.
   * @returns The shared Session id, or undefined when the share is gone.
   */
  readonly sharedSessionId: (shareId: string) => string | undefined
  /** Forked children this Host created, so a viewer's list can show exactly its own. */
  readonly forks?: ForkRegistry
  /**
   * Share facts a fork decision needs, as the owner host holds them.
   *
   * The Relay already admitted this viewer to the share before the request arrived here, so the
   * admission fact is true by construction; the rest — the owner's fork switch, the session the share
   * carries, its expiry — is what decides whether the fork is allowed.
   */
  readonly forkStateOf?: (shareId: string) => ForkShareState | undefined
  /**
   * Whether the viewer the Relay asserted still holds access to one share this host publishes.
   *
   * Admission is asserted request by request, but a grant can end between two of them, and a viewer
   * whose access ended must not keep reading on an admission that is no longer true. The host answers
   * with the same rule its queued-turn re-check applies, so one grant reads the same on every path.
   * Absent, only the share's own lifecycle is re-checked and the Relay's assertion stands.
   * @param shareId - Share the request arrived through.
   * @param viewer - Identity the Relay asserted for this request.
   * @returns True while that identity still holds access to that share.
   */
  readonly viewerStillAdmitted?: (shareId: string, viewer: ShareRpcActor) => boolean
  /** Refresh authoritative admission at request ingress and immediately before execution dispatch. */
  readonly refreshAdmission?: (shareId: string, signal?: AbortSignal) => Promise<void>
  /**
   * The refusal the `share-viewer` policy's write rules give one reader prompt or cancel, read before
   * dispatch.
   *
   * A refusal found here is answered with its own code as the page's refusal code, and nothing is
   * prepared or dispatched for it; the Gateway decides the call again from the policy when it is
   * dispatched. Absent, every request is dispatched and the Gateway's answer stands.
   * @param viewer - The reader.
   * @param action - The write action.
   * @param sessionId - Session the write names.
   * @param concrete - True for the call about to be dispatched, false for the snapshot rule.
   * @returns The refusal code, or undefined when the policy allows the write.
   */
  readonly writeRefusal?: (
    viewer: ShareViewerPrincipal,
    action: ReaderWriteAction,
    sessionId: string,
    concrete: boolean,
  ) => string | undefined
  /**
   * Report that a fork this reader created changed the `share-viewer` policy's bindings, so open access
   * snapshots are recomputed.
   */
  readonly accessChanged?: () => void
  /**
   * Whether the share's source Session currently carries a usable confined access layer.
   *
   * A `write` share drives that Session with the viewer's input, so the prompt is refused unless the host
   * installed the layer that confines it. Absent means no layer this host can vouch for.
   */
  readonly sourceConfined?: (shareId: string) => boolean
  /**
   * Why the share's source Session carries no usable layer, when the host recorded a reason.
   *
   * Diagnostics for the refusal's body: a capability the backend lacks reads differently from a layer that
   * was never attempted, and the owner or an integrator needs to tell those apart without a debugger.
   */
  readonly sourceRefusal?: (shareId: string) => string | undefined
  /**
   * Resolve or resume one Session through the owner's own service, without executing anything.
   *
   * A write share's source Session that this host has no confined layer for is prepared here first: the
   * layer is installed by the setup every agent creation runs, so a restarted host gets one by preparing
   * the Session rather than by driving it and hoping. Absent, nothing is prepared and the request is
   * refused when the layer is missing.
   */
  readonly prepareSource?: (sessionId: string) => Promise<void>
  /**
   * Install this child's execution limit and return its disposer.
   *
   * `write` asks for a scope that may also write inside the granted workspace; a host that cannot install
   * that bounded write refuses, so a write-mode share never falls back to an unbounded tool. Absent, or
   * returning undefined, leaves the child refused: the prompt check reads the installation record.
   */
  readonly enforceChild?: (
    childSessionId: string,
    options?: { readonly write?: boolean },
  ) => Promise<(() => void) | undefined>
  /**
   * Resolve or resume one child through the composition's own activation path, without executing
   * anything.
   *
   * A child created in an earlier process has no installed limit, and the activation is exactly what
   * installs it: the `agent/created` listeners run before the agent is published. Absent, or activating a
   * child whose limit still cannot be installed, leaves the gate refusing it.
   */
  readonly prepareChild?: (childSessionId: string) => Promise<void>
  /**
   * Start preparing one share's writable source Session, without waiting for it.
   *
   * The write rules of the `share-viewer` policy need that Session's confinement layer, and a host that
   * restarted with a restored write share could not install it during startup, while the Session's agent
   * was not live: the reader's own snapshot then carried no write action, so its composer stayed inert and
   * the prompt path that prepares the source was never reached. Asking here, when a reader requests the
   * document or opens a stream, breaks that circle. The caller never waits, and a completed installation
   * re-pushes the snapshot every open page is following.
   * @param shareId - Share the reader's request arrived through.
   */
  readonly prepareSourceForReader?: (shareId: string) => void
  /**
   * Log every allowed and refused endpoint, for enumerating what a viewer boot reads. Each served page
   * resource adds one line naming its path, byte count, and duration, so a page that renders nothing can
   * be told apart from an owner that never received its reads.
   */
  readonly debug?: boolean
  /**
   * Read one resource of the owner's served page for an admitted viewer.
   * @param path - Validated page-relative path: the index, `assets/...`, or `plugins/...`.
   * @param peer - The reader's own Peer, whose access rows the frontend renders into the index.
   * @returns The answer the page reads for that path; absent when this Host serves no page.
   */
  readonly readAsset?: (path: string, peer: PeerScope) => Promise<ViewerAnswer>
}

/** Owner-side reader answering one share's forwarded viewer requests. */
export interface ViewerReadService {
  /**
   * Answer one request for one share.
   * @param shareId - Share the Relay addressed.
   * @param request - Validated viewer request.
   * @param actor - Viewer identity the Relay asserted, which no projection may infer from the body.
   * @param signal - Cancellation of the forwarded request, including a lost Relay connection.
   * @returns The answer the Relay writes back to the viewer.
   */
  answer(shareId: string, request: ViewerRequest, actor: ShareRpcActor, signal?: AbortSignal): Promise<ViewerAnswer>
  /**
   * Cancel pending calls, release every stream, and dispose every reader Peer of one share.
   * @param shareId - Share whose pending calls, streams, and Peers end.
   */
  closeShare(shareId: string): void
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
   * Cancel pending calls, release every stream, and dispose the Peer of one reader of one share.
   *
   * A grant that ended is not a reason to end another viewer's read of the same share, so the streams
   * released here are exactly the ones opened as that identity.
   * @param shareId - Share the viewer's streams belong to.
   * @param viewer - Identity the Relay asserted when those streams opened.
   * @returns How many streams were released.
   */
  closeViewerStreams(shareId: string, viewer: ShareRpcActor): number
  /** Cancel pending calls, release every open stream, and dispose every reader Peer. */
  close(): void
}

/**
 * Build the owner-side reader.
 * @param deps - Host services and the share-to-Session lookup.
 * @returns Reader answering viewer requests for every share this host publishes.
 */
export function createViewerReadService(deps: ViewerReadDeps): ViewerReadService {
  const lifecycle: ViewerLifecycle = createViewerLifecycle(deps)
  // The fork and the dispatch call each other: a fork call goes through the dispatch, and a
  // dispatched fork request goes through the fork orchestrator. Each side asks for the other only
  // while answering a request, so one late binding breaks the construction cycle.
  const fork: ViewerFork = createViewerFork({ deps, lifecycle, dispatch: () => dispatch })
  const dispatch: ViewerDispatch = createViewerDispatch({ deps, lifecycle, fork: () => fork })
  return {
    answer: (shareId, request, actor, signal) => dispatch.answer(shareId, request, actor, signal),
    cancelPendingCalls: (shareId) => { lifecycle.cancelPendingCalls(shareId) },
    recheckAdmission: (shareId) => { lifecycle.recheckAdmission(shareId) },
    closeShare: (shareId) => { lifecycle.closeShare(shareId) },
    closeViewerStreams: (shareId, viewer) => lifecycle.closeViewerStreams(shareId, viewer),
    close: () => { lifecycle.close() },
  }
}
