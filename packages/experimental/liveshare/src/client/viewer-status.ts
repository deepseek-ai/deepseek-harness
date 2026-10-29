/**
 * What the viewer page states while it cannot show the shared Session's content.
 *
 * A reader whose owner is offline, whose share was stopped or expired, or whose own sign-in lapsed must
 * be told so: the normal client UI renders its own shell either way, and an empty shell reads as a page
 * that simply has nothing in it. The page therefore keeps one state, derived from the share's own answer
 * and from the reads its own transport could not complete, and states it in the page.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-status
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * One state the page can be in.
 *
 * `ready` is the only state that adds nothing: the share answered and its owner's gateway is connected.
 * `offline` covers an owner that is not connected right now, which the Relay reconnects by itself, and
 * a content read this page lost in transport, which the Connection layer re-opens with backoff — both
 * are retried without the reader, so the state promises exactly what happens;
 * `stopped` and `expired` are the share's own end; `reauthenticate` is the reader's sign-in rather than
 * the share; `unknown` is a page that has not read an answer it can use yet.
 */
export type ViewerStatus =
  | 'ready'
  | 'invalid'
  | 'offline'
  | 'stopped'
  | 'expired'
  | 'reauthenticate'
  | 'unavailable'
  | 'connecting'

/** The one state the page states; a page that read nothing yet says so rather than claiming a share. */
export const viewerStatus = createSnapshotStore<ViewerStatus>('connecting')

/** Facts the page's state is derived from. */
export interface ViewerStatusFacts {
  /** Whether the share's owner gateway is connected, as the share's own answer reported it. */
  readonly ownerOnline?: boolean | undefined
  /** Stable reason code the share's answer carried, when it carried one. */
  readonly reason?: string | undefined
  /** Whether the page's last read of the share answered nothing it could use. */
  readonly unconfirmed?: boolean | undefined
  /** Whether a read for this share was refused for want of an authenticated reader. */
  readonly unauthenticated?: boolean | undefined
  /** Whether the page's Connection to the owner is down while it reconnects by itself. */
  readonly feedFailed?: boolean | undefined
  /** Whether the page could not reach the share at all, as opposed to reading what it said. */
  readonly unreachable?: boolean | undefined
  /** Whether the Relay answered that this share is unknown or deleted. */
  readonly notFound?: boolean | undefined
}

/** Refusal codes that mean the share itself is over, and the state each one states. */
const SHARE_END_STATES: Readonly<Record<string, ViewerStatus>> = {
  'share-stopped': 'stopped',
  'share-expired': 'expired',
}

/**
 * Derive the state the page states from the facts it holds.
 *
 * A share the owner ended is that fact whatever else is true, and a refused sign-in is the reader's own
 * problem rather than the share's. A disconnected owner and a content read that failed are both
 * `offline`, because both mean the page cannot read the Session right now and both are retried by the
 * page or the Relay rather than by the reader.
 * @param facts - What the page has read about this share.
 * @returns The state to state.
 */
export function readViewerStatus(facts: ViewerStatusFacts): ViewerStatus {
  if (facts.notFound === true) return 'invalid'
  const ended = facts.reason === undefined ? undefined : SHARE_END_STATES[facts.reason]
  if (ended !== undefined) return ended
  if (facts.unauthenticated === true) return 'reauthenticate'
  if (facts.ownerOnline === false || facts.feedFailed === true) return 'offline'
  if (facts.unreachable === true) return 'unavailable'
  if (facts.unconfirmed === true) return 'connecting'
  return 'ready'
}

/** Facts the page has read so far; a fact no read has stated stays unstated. */
export const viewerStatusFacts = createSnapshotStore<ViewerStatusFacts>({})

/**
 * Return the page's statement to the state a page that read nothing states.
 *
 * The viewer session plugin owns both stores' lifetime and calls this when its page starts and ends, so
 * a remount or HMR replacement states `connecting` instead of another page's offline or ended share.
 */
export function resetViewerStatus(): void {
  viewerStatusFacts.set({})
  viewerStatus.set('connecting')
}

/**
 * Record what one read said about the page's state, and publish the state those facts imply.
 *
 * Reads land one at a time — the share's own answer, and the transport's failures — so each note states
 * only the facts it read and leaves the rest as they were.
 * @param facts - Facts this read stated.
 */
export function noteViewerStatusFacts(facts: ViewerStatusFacts): void {
  const next = { ...viewerStatusFacts.getSnapshot(), ...facts }
  viewerStatusFacts.set(next)
  viewerStatus.set(readViewerStatus(next))
}
