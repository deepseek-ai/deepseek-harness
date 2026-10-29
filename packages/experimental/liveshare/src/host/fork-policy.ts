/**
 * Who may fork a shared session, at which boundary, and under which permission ceiling.
 *
 * A fork creates a new session that the viewer owns, while the source session stays untouched, so
 * this decision is the security core of the capability: it binds the child to the trusted viewer
 * subject the Relay asserted and to the share that granted it, refuses anything the share did not
 * authorize, and states the ceiling the child runs under.
 */

import { sharedToolNames } from './shared-tools.ts'
import type { ViewerCapabilityGroup } from './viewer-declarations.ts'


/**
 * What a viewer may do with the shared Session.
 *
 * Two tiers, the same two the owner's own permission presets name: `view` reads the shared Session
 * and drives its loop inside the granted workspace without writing it, and `write` also modifies the
 * files inside that workspace. Both tiers drive the loop; neither reconfigures the Session the owner
 * runs. Forking is not a tier: {@link ForkShareState.allowsFork} carries that switch on its own.
 */
export type ViewerSessionMode = 'view' | 'write'

/**
 * Whether one mode includes writing the source session.
 * @param mode Share mode.
 * @returns True only for `write`.
 */
export function modeAllowsSessionWrite(mode: ViewerSessionMode): boolean {
  return mode === 'write'
}

/**
 * Read one mode from owner input, keeping the compatibility rules in one place.
 * @param input Untrusted request value for `sessionMode`.
 * @returns The mode, or undefined when the value is neither a mode nor absent.
 */
export function parseSessionMode(input: unknown): ViewerSessionMode | undefined {
  if (input === undefined || input === null) return undefined
  return input === 'view' || input === 'write' ? input : undefined
}

/** Trusted viewer identity a Relay asserted for one request; never a browser-supplied value. */
export interface ForkViewer {
  readonly providerId: string
  readonly tenantId: string
  readonly subjectId: string
}

/** What the Relay knows about the share a fork request arrived through. */
export interface ForkShareState {
  readonly shareId: string
  /** Session this share points at; a fork may only ever fork this one. */
  readonly sessionId: string
  /**
   * Whether the owner allowed forking at all.
   *
   * Independent of the tier: a view-tier share may allow it, and a writable one may refuse it. A stored
   * record that omits it reads as off at the boundary that loads the record.
   */
  readonly allowsFork: boolean
  /**
   * Whether the Relay admitted this viewer to the share, decided by its own mode-aware admission.
   *
   * Passed in rather than inferred from the ACL: a selected share that named nobody has an empty
   * ACL exactly like an organization-wide open share, so an empty set cannot stand in for admission.
   */
  readonly viewerAdmitted: boolean
  /**
   * Tier the owner configured for this share, when the host knows it.
   *
   * Absent means the host cannot tell, and nothing is driven and no fork is installed: a share whose
   * tier cannot be established never grants more than reading.
   */
  readonly sessionMode?: ViewerSessionMode
  readonly stopped: boolean
  readonly expiresAt?: string
  /**
   * Plugin endpoints this share's owner selected for its viewers, grouped by declaring plugin.
   *
   * Absent means the owner exposed none, and the endpoints plugins offer stay refused. This is the grant:
   * the `share-viewer` policy exposes a plugin endpoint only where this selection and the plugin's live
   * declaration both name it.
   */
  readonly viewerCapabilities?: readonly ViewerCapabilityGroup[]
}

/** One fork attempt, already carried over the Relay channel with trusted metadata. */
export interface ForkRequest {
  readonly shareId: string
  /** Session the caller believes it is forking; must equal the share's own session. */
  readonly sourceSessionId: string
  /** Completed prefix to fork at; absent forks the whole committed history. */
  readonly atSeq?: number
  /** Stable key so a retried creation returns the same child instead of making another. */
  readonly requestKey: string
}

/** Outcome of one fork authorization. */
export type ForkDecision =
  | { readonly ok: true; readonly boundary: number; readonly ceiling: ForkCeiling; readonly requestKey: string }
  | { readonly ok: false; readonly code: ForkRefusal; readonly message: string }

/** Stable refusals a caller can act on without reading prose. */
export type ForkRefusal =
  | 'share-not-found'
  | 'share-stopped'
  | 'share-expired'
  | 'fork-not-permitted'
  | 'viewer-not-authorized'
  | 'source-session-mismatch'

/**
 * Capabilities a forked session runs under.
 *
 * A fork must never inherit the source session's ability to change the owner's machine: this list is
 * the ceiling the Host enforces on the child, not a set of settings a client may raise.
 */
export interface ForkCeiling {
  /** Session carries the read-only marker so its own UI and audit can state the limit. */
  readonly readOnly: true
  /** Tools the child may use; anything not named here is refused for this session. */
  readonly allowedTools: readonly string[]
  /** Capabilities the child may never reach, enforced by the Host rather than by configuration. */
  readonly deniedCapabilities: readonly string[]
}

/**
 * The ceiling for a shared Session's view tier.
 *
 * Every tool here reads files or has no local file effect; the enforcement layers install a confined
 * replacement for each name and refuse the rest. Tools that could act on the owner's machine or the
 * owner's session state stay absent: `bash` is excluded because an arbitrary shell cannot be bounded to
 * a workspace here, and the schedule, computer-use, and plugin-manager capabilities are capabilities the
 * Host itself owns rather than workspace file operations. Paths every listed tool declares are
 * resolved and checked against the granted workspace before it runs.
 */
export const READ_ONLY_FORK_CEILING: ForkCeiling = {
  readOnly: true,
  allowedTools: sharedToolNames('view'),
  deniedCapabilities: [
    'bash',
    'pwsh',
    'cua',
    'plugin_manager',
    'schedule_create',
    'schedule_list',
    'schedule_delete',
    'schedule_update',
    'write',
    'edit',
    'settings-write',
    'credentials',
    'plugin-self-modification',
    'subagent',
    'workspace-write',
    'share-management',
  ],
}

/**
 * The ceiling a write-mode scope runs under: the same read surface, plus the two file-mutation tools the
 * installation bounds itself. The installation replaces the deployment's `write` and `edit` with bodies
 * that publish only inside the granted workspace, so "may write" never means "may write anywhere the
 * owner can".
 */
export const WRITE_FORK_CEILING: ForkCeiling = {
  ...READ_ONLY_FORK_CEILING,
  allowedTools: sharedToolNames('write'),
  deniedCapabilities: READ_ONLY_FORK_CEILING.deniedCapabilities.filter(name => name !== 'write' && name !== 'edit'),
}


/**
 * Decide one fork request.
 * @param share Share state the Relay vouched for.
 * @param request Fork request, including the session the caller named.
 * @param now Current epoch milliseconds, so expiry is judged against the caller's clock source.
 * @returns An allowed decision carrying the boundary and ceiling, or a typed refusal.
 */
export function decideFork(
  share: ForkShareState | undefined,
  request: ForkRequest,
  now: number,
): ForkDecision {
  if (share === undefined || share.shareId !== request.shareId) {
    return { ok: false, code: 'share-not-found', message: 'share is not registered' }
  }
  if (share.stopped) return { ok: false, code: 'share-stopped', message: 'share is stopped' }
  if (isExpired(share.expiresAt, now)) {
    return { ok: false, code: 'share-expired', message: 'share has expired' }
  }
  if (!share.allowsFork) {
    return {
      ok: false,
      code: 'fork-not-permitted',
      message: 'the owner has not allowed forking this share',
    }
  }
  if (!share.viewerAdmitted) {
    return { ok: false, code: 'viewer-not-authorized', message: 'viewer may not fork this share' }
  }
  // The share names its own session, so a caller cannot point a fork at another session it can name.
  if (request.sourceSessionId !== share.sessionId) {
    return {
      ok: false,
      code: 'source-session-mismatch',
      message: 'the requested session is not the session this share carries',
    }
  }
  return { ok: true, boundary: request.atSeq ?? 0, ceiling: READ_ONLY_FORK_CEILING, requestKey: request.requestKey }
}

/**
 * Whether one share's deadline has passed.
 *
 * Exported because every path that acts on a share's behalf re-reads that share before it acts: a fork
 * decision and a shared Session's own prompt both have to refuse an expired share the same way.
 * @param expiresAt - ISO deadline the owner set, or undefined when the share never expires.
 * @param now - Epoch milliseconds to judge against.
 * @returns True when the deadline exists and has passed.
 */
export function isExpired(expiresAt: string | undefined, now: number): boolean {
  if (expiresAt === undefined) return false
  const parsed = Date.parse(expiresAt)
  return Number.isFinite(parsed) && parsed <= now
}
