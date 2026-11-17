/** Session binding vocabulary, the binding plugin record, and the host-only projection state. */

import type { ChangeRequestRef, ChangeRequestUpdate } from '@deepseek-ai/dsh-experimental-forge/types'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/**
 * How a change request became bound to a Session: `created` when the result of a command a registered rule names as a
 * creation printed its URL, `referenced` when a command a rule names as a reference named it, its result printed its
 * own URL, or a lookup for it found the URL, `discovered` when a lookup found it for a branch the Session pushed or
 * works on, `tracked` when a caller bound it by URL.
 */
export type BindingOrigin = 'created' | 'referenced' | 'discovered' | 'tracked'

/**
 * The shell commands of one forge family's CLI that bind change requests to the Session that ran them, registered
 * with `ctx.forgeSession.registerCommands`. The `forgeChangeRequests` projection folds the Session log with the
 * recognized rules and folds it again when a registration changes them, so a rule must classify the same input the
 * same way every time: its members are fixed, and `select` reads only its arguments.
 */
export interface ForgeCommandRule {
  /** Stable name of the rule, such as `gh`; no two registered rules share one. */
  readonly id: string
  /** Positive integer the registrant raises whenever the rule classifies some command or output differently. */
  readonly version: number
  /** Executable word the rule classifies, such as `gh`; no two registered rules share one. */
  readonly executable: string
  /** Subcommand word sequences that create a change request and print its URL, such as `['pr', 'create']`. */
  readonly creates: readonly (readonly string[])[]
  /** Subcommands that act on one change request, which their words or their output name, such as `['pr', 'view']`. */
  readonly references: ForgeCommandGroup
  /**
   * Subcommands that send a raw API request, such as `['api']`, whose words can name one change request. Their output
   * is not read, since one request can list many change requests.
   */
  readonly apiRequests: ForgeCommandGroup
  /** Regular expression source matching a change request page path after the repository path, such as `\/pull\/\d+`. */
  readonly changeRequestPath: string
  /** JSON member names whose value is the URL of the change request a reference command prints, such as `url`. */
  readonly urlMembers: readonly string[]
  /**
   * Find the change request that one literal reference or API request command names.
   * @param command - the command's kind, subcommand, operands, and option values.
   * @param environment - the variables the command assigns before the executable, the last assignment of a name winning.
   * @returns the change request's URL when the command names its host; a lookup when it names the change request
   * without one; undefined when it names no change request.
   */
  select(command: ForgeCommandArguments, environment: Readonly<Record<string, string>>): ForgeCommandSelection | undefined
}

/** Subcommands of one kind and the options they accept. */
export interface ForgeCommandGroup {
  /** Subcommand word sequences, such as `['pr', 'view']`; may be empty. */
  readonly subcommands: readonly (readonly string[])[]
  /**
   * Options that take a value: the next word, the text after `=`, or for a one-letter option such as `-R`, the rest of
   * the word.
   */
  readonly valueOptions: readonly string[]
  /** Options that take no value; a command with any other option names nothing. */
  readonly flagOptions: readonly string[]
}

/** The parsed words of one reference or API request command after its executable. */
export interface ForgeCommandArguments {
  /** Which group of the rule the subcommand belongs to. */
  readonly kind: 'reference' | 'api-request'
  /** The subcommand words, such as `['pr', 'view']`. */
  readonly subcommand: readonly string[]
  /** Words after the subcommand that are neither options nor option values. */
  readonly operands: readonly string[]
  /** Each value option as written, with its value, in command order. */
  readonly values: readonly (readonly [option: string, value: string])[]
}

/**
 * The change request one command names: its URL, or a read-only command, starting with the executable, that prints
 * exactly that URL. forge-session runs a lookup in the shell of the command that named it, with that command's
 * variable assignments, and only while the command runs; replaying the Session log runs none.
 */
export type ForgeCommandSelection = { readonly url: string } | { readonly lookup: readonly string[] }

/** Binding evidence that a shell command and its result can carry. */
export interface CommandEvidence {
  /** Origin of the change request URLs the result prints, or null when the command prints none of its own. */
  readonly urls: 'created' | 'referenced' | null
  /** Whether the result can report pushed refs. */
  readonly pushes: boolean
  /** Change request URLs explicitly selected by URL or by number, repository, and host. */
  readonly named: readonly string[]
  /** Ids of the rules whose commands the command runs, whose output forms read the result's URLs. */
  readonly rules: readonly string[]
}

/** Payload of the `plugin:forge-session/binding` record. */
export interface BindingRecord {
  /**
   * `track` binds or restores, `dismiss` hides, `discover` binds a branch lookup,
   * and `reference` binds a command lookup without restoring dismissed entries.
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
  /** Sequence number of the latest `tool/result` or `tool/ptc-dispatch` event that reported this branch. */
  readonly seq: SessionSeq
}

/** Host-only projection state folded from shell results, program dispatches, and binding records with the registered rules. */
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
