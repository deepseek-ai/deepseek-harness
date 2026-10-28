/** Session binding vocabulary, the binding plugin record, and the host-only projection state. */

import type { ChangeRequestRef, ChangeRequestUpdate } from '@deepseek-ai/dsh-experimental-forge/types'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/**
 * How a change request became bound to a Session: `created` when a
 * `gh pr create` result printed its URL, `referenced` when a `gh pr view`,
 * `gh pr edit`, or `gh pr checkout` call named it or its result printed its
 * own URL, `discovered` when a lookup found it for a branch the Session pushed
 * or works on, `tracked` when a caller bound it by URL.
 */
export type BindingOrigin = 'created' | 'referenced' | 'discovered' | 'tracked'

/** Binding evidence that a shell command and its result can carry. */
export interface CommandEvidence {
  /** Origin of the change request URLs the result prints, or null when the command prints none of its own. */
  readonly urls: 'created' | 'referenced' | null
  /** Whether the result can report pushed refs. */
  readonly pushes: boolean
  /** Change request URLs explicitly selected by URL or by number, repository, and host. */
  readonly named: readonly string[]
}

/** Payload of the `plugin:forge-session/binding` record. */
export interface BindingRecord {
  /**
   * `track` binds or restores, `dismiss` hides, `discover` binds a branch lookup,
   * and `reference` binds a CLI selector lookup without restoring dismissed entries.
   */
  readonly action: 'track' | 'dismiss' | 'discover' | 'reference'
  /** Web URL of the change request. */
  readonly url: string
}

/** One shell call whose result the projection still awaits, with the evidence the call and its result carry. */
export interface PendingCommand extends CommandEvidence {
  /** Tool call id that pairs the call with its result. */
  readonly callId: string
}

/** One change request remembered by the projection, including hidden ones. */
export interface BindingState {
  /** Web URL as first recorded. */
  readonly url: string
  /** How the change request became bound. */
  readonly origin: BindingOrigin
  /** Whether a dismissal hides the binding. */
  readonly dismissed: boolean
}

/** One branch that a `git push` result reported as updated on a remote. */
export interface PushedBranch {
  /** Remote as `git push` printed it after `To`. */
  readonly remote: string
  /** Branch name on the remote. */
  readonly branch: string
  /** Sequence number of the latest `tool/result` event that reported this branch. */
  readonly seq: SessionSeq
}

/** Host-only projection state folded from shell results and binding records. */
export interface ForgeChangeRequestsState {
  /** Shell calls awaiting their result, in call order. */
  readonly pending: readonly PendingCommand[]
  /** Bound change requests in first-recorded order. */
  readonly bindings: readonly BindingState[]
  /** Pushed branches, one entry per remote and branch, ordered by latest push. */
  readonly pushes: readonly PushedBranch[]
}

/** One change request bound to a Session and not dismissed, with its latest polling result. */
export interface SessionChangeRequest {
  /** Web URL as first recorded. */
  readonly url: string
  /** How the change request became bound. */
  readonly origin: BindingOrigin
  /** Parsed reference, or null when no registered provider serves the URL. */
  readonly ref: ChangeRequestRef | null
  /** Latest polling result, or null before the first poll and without a provider. */
  readonly update: ChangeRequestUpdate | null
}

/**
 * Receives the complete visible list after a binding or provider change, or a polling result.
 * @param changeRequests - every visible binding of the watched Session, in first-recorded order.
 */
export type SessionChangeRequestsListener = (changeRequests: readonly SessionChangeRequest[]) => void

/** Deployment settings of `forgeSession`. */
export interface Config {
  /** Deadline in milliseconds for one change request lookup after a push. */
  discoveryTimeoutMs?: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** A caller or discovery action that binds, restores, or hides one change request. */
    'plugin:forge-session/binding': BindingRecord
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Every change request bound to the Session, hidden ones included, in binding order. */
    forgeChangeRequests: readonly BindingState[]
  }
}
