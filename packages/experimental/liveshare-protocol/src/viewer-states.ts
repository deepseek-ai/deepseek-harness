/**
 * The conditions one viewer read can end in, and the answer that carries each.
 *
 * A page that cannot name why a read failed states one failure for every cause: a link that never
 * named a share, a share the owner stopped, an owner whose machine is asleep, and a sign-in that
 * expired all reach a reader as the same silence. These are the conditions the Relay may answer a
 * viewer with, each paired with the answer that means it and nothing else, so a page, a test, and an
 * operator all read the same name for what happened.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare-protocol
 */

/** One condition a viewer read can end in. */
export type ViewerState =
  /** The link names no share: it was never valid, or the owner deleted it. */
  | 'share-not-found'
  /** The owner stopped the share, which ends every viewer's access to it. */
  | 'share-stopped'
  /** The share's own deadline passed, which denies like a stop but states its own reason. */
  | 'share-expired'
  /** No live owner gateway holds the share's route, or one stopped answering a held read. */
  | 'owner-offline'
  /** The reader's sign-in expired, so the Relay cannot say who is asking. */
  | 'sign-in-expired'
  /** The reader is signed in and admitted to the deployment, but this share does not admit it. */
  | 'access-denied'
  /** The viewer page could not reach the Relay at all: the request never arrived. */
  | 'relay-unreachable'

/** Whether the page may ask again, or the answer is the peer's verdict. */
export type ViewerStateReach = 'retryable' | 'terminal'

/**
 * Whether the page may ask again, or the answer is the peer's verdict, for every condition.
 *
 * This is the whole vocabulary the protocol layer publishes: HTTP statuses and error codes belong to
 * the Relay, and copy keys belong to the client. A page, a test, and an operator read one name per
 * condition from here and get the retry decision with it.
 */
export const VIEWER_STATE_REACH: Readonly<Record<ViewerState, ViewerStateReach>> = {
  'share-not-found': 'terminal',
  'share-stopped': 'terminal',
  'share-expired': 'terminal',
  'owner-offline': 'retryable',
  'sign-in-expired': 'terminal',
  'access-denied': 'terminal',
  'relay-unreachable': 'retryable',
}
