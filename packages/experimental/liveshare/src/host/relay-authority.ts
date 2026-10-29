/**
 * The Relay's statement of one share's access, and the reads that adopt it.
 *
 * A share's ACL, tier, and expiry belong to the Relay once it states them, so this module holds the
 * last state frame it reported, fences each read against the generation of the share it was for, and
 * decides whether a viewer still holds the admission a frame describes.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/relay-authority
 */

import type {
  IdentityActor,
  IdentityTriple,
  ShareAccessStateFrame,
  ShareRpcActor,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityFromKey, identityKeyOf, parseShareAccessState } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { ForkRegistry } from './fork-registry.ts'
import { isExpired, type ViewerSessionMode } from './fork-policy.ts'
import type { ShareAccessSelection } from '../share-api-types.ts'
import type { ShareAccessSummary } from './owner-types.ts'
import type { OwnerShare } from './owner-types.ts'
import type { ViewerReadService } from './viewer-read.ts'
import { isRecord, json } from './wire-json.ts'

/** What one authoritative Relay read of a share produced. */
export interface RelayAuthorityRead {
  readonly ok: boolean
  readonly accessState?: ShareAccessStateFrame
}

/**
 * Whether one requester still holds access to one share this host publishes.
 *
 * The Relay admits a request before it reaches this host, so admission is a fact for the request that
 * carried the input; input admitted earlier has to be re-checked, because the grant it relied on may have
 * ended while it waited in the queue. The rule is the Relay's own admission rule: an open share admits the
 * whole organization once its own ACL is empty, and every share admits the subjects its ACL names — by
 * subject id or by canonical identity key.
 * @param share - Share the input arrived through, as this host holds it.
 * @param requester - Identity the turn's origin recorded.
 * @returns True while that identity still holds access.
 */
export function requesterStillAdmitted(
  share: Pick<OwnerShare, 'accessMode' | 'allowedSubjectIds'>,
  requester: { readonly providerId: string; readonly tenantId: string; readonly subjectId: string },
): boolean {
  if (share.allowedSubjectIds.length === 0) return share.accessMode === 'open'
  return share.allowedSubjectIds.includes(requester.subjectId)
    || share.allowedSubjectIds.includes(identityKeyOf(requester))
}

/** Host state one Relay authority read and the frames it adopts read. */
export interface RelayAuthorityDeps {
  /** Shares this host publishes, which a frame and a read both update or verify. */
  readonly ownerShares: Map<string, OwnerShare>
  /** Whether the host has been disposed. */
  readonly disposed: () => boolean
  /** Children this host created, whose grants a narrowed frame ends. */
  readonly forks: ForkRegistry
  /** This host's own identity, used to read subject ids as identities. */
  readonly ownerIdentity: IdentityActor | undefined
  /** Subjects this deployment admits to every share. */
  readonly allowedSubjectIds: readonly string[]
  /** The viewer reader, which releases work admitted against a superseded snapshot. */
  readonly viewerRead: () => ViewerReadService
  /** Tell remote access that reader answers may have changed. */
  readonly accessChanged: () => void
  /** Stop the running turn one share may no longer drive. */
  readonly cancelShareTurn: (shareId: string, revokedSubject?: string) => void
  /** Stop child work whose grant is narrowed or removed. */
  readonly cancelChildTurns: (shareId: string, viewer?: ShareRpcActor) => void
  /** Arm or re-arm one share's expiry cancellation. */
  readonly scheduleShareExpiry: (share: OwnerShare) => void
  /** Reconcile one Session's sandbox after its shares' tiers, deadlines, or admissions changed. */
  readonly reconcileSourceAccess: (sessionId: string) => void
}

/** Reads and adopted states of the Relay's authority over this host's shares. */
export interface RelayAuthority {
  /**
   * Whether one Relay admission still stands for one viewer.
   * @param shareId - Share the viewer was admitted to.
   * @param viewer - Identity the Relay asserted.
   * @returns True while that identity is still admitted.
   */
  viewerAdmitted(shareId: string, viewer: ShareRpcActor): boolean
  /**
   * Forget one share's held authority after the worker reconnected it.
   * @param shareId - Share the worker reconnected.
   */
  forgetRelayAccess(shareId: string): void
  /**
   * Fence off one share's held authority and release the work admitted against it.
   * @param shareId - Share whose authority ended.
   */
  invalidateRelayAccess(shareId: string): void
  /**
   * Adopt one Relay's statement of a share's access.
   * @param shareId - Share the frame describes.
   * @param state - Parsed access-state frame.
   */
  applyRelayAccess(shareId: string, state: ShareAccessStateFrame): void
  /**
   * Read one share's authority from its Relay and adopt what it states.
   * @param share - Share to read.
   * @param signal - Cancellation of the forwarded request.
   * @returns The snapshot that was adopted, or an unavailable read.
   */
  readRelayAuthority(share: OwnerShare, signal?: AbortSignal): Promise<RelayAuthorityRead>
  /**
   * Refresh one share's authority at request ingress, throwing when it cannot be read.
   * @param shareId - Share to refresh.
   * @param signal - Cancellation of the forwarded request.
   */
  refreshRelayAccess(shareId: string, signal?: AbortSignal): Promise<void>
  /**
   * The tier this host may still drive one share with, or undefined when it may not.
   * @param shareId - Share the execution arrived through.
   * @returns The tier, or undefined when the share is gone, past its deadline, or not yet reported.
   */
  drivableModeOf(shareId: string): ViewerSessionMode | undefined
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const values = new Set(left)
  return right.every(value => values.has(value))
}

/**
 * Whether one adopted frame can have ended access some viewer held under the previous one.
 *
 * The Relay admits the whole organization while the ACL is empty and the share is open; once either
 * changes, only the named subjects remain. A subject the previous ACL named and the new one does not is a
 * viewer whose grant ended.
 * @param previous - The frame this host held before.
 * @param next - The frame it just adopted.
 * @returns True when someone the previous frame admitted may no longer be admitted.
 */
export function admissionNarrowed(previous: ShareAccessStateFrame, next: ShareAccessStateFrame): boolean {
  const wasOpen = previous.allowedSubjectIds.length === 0 && previous.accessMode === 'open'
  const isOpen = next.allowedSubjectIds.length === 0 && next.accessMode === 'open'
  if (wasOpen && !isOpen) return true
  return previous.allowedSubjectIds.some(subject => !next.allowedSubjectIds.includes(subject))
}

async function relayRequests(defaultRelay: string, share: OwnerShare, signal?: AbortSignal): Promise<Response> {
  const relayUrl = new URL(`${defaultRelay}/__liveshare/requests`)
  relayUrl.searchParams.set('shareId', share.shareId)
  try {
    const response = await fetch(relayUrl, {
      headers: { authorization: `Bearer ${share.gatewayToken}` },
      signal: signal === undefined ? AbortSignal.timeout(5_000) : AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    })
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8' },
    })
  } catch {
    return json({ error: 'relay-unavailable' }, 502)
  }
}

async function relayAuthorityRead(defaultRelay: string, share: OwnerShare, signal?: AbortSignal): Promise<RelayAuthorityRead> {
  try {
    const response = await relayRequests(defaultRelay, share, signal)
    if (!response.ok) return { ok: false }
    const data: unknown = await response.json()
    if (!isRecord(data)) return { ok: false }
    const accessState = parseShareAccessState({ ...data, type: 'share-access-state' })
    return { ok: true, ...(accessState === undefined ? {} : { accessState }) }
  } catch {
    return { ok: false }
  }
}

/**
 * Build the ACL summary a share carries for one stated set of subjects.
 * @param share - Share the ACL belongs to.
 * @param acl - Subjects the Relay states for the share.
 * @param deploymentAllowedSubjectIds - Subjects this deployment admits to every share.
 * @param ownerIdentity - This host's own identity, used to read bare subject ids.
 * @returns The ACL summary.
 */
function accessSummaryForAcl(
  share: OwnerShare,
  acl: readonly string[],
  deploymentAllowedSubjectIds: readonly string[],
  ownerIdentity: IdentityActor | undefined,
): ShareAccessSummary {
  const selected = new Map<string, ShareAccessSelection>()
  for (const person of share.access?.selected ?? []) {
    if (acl.includes(person.identityKey)) selected.set(person.identityKey, person)
  }
  for (const key of acl) {
    const identity = identityFromKey(key)
    if (identity !== undefined) {
      selected.set(key, { ...identity, identityKey: key })
      continue
    }
    if (deploymentAllowedSubjectIds.includes(key)) continue
    const fallback = identityForGrantedSubject(key, ownerIdentity)
    if (fallback !== undefined) {
      const fallbackKey = identityKeyOf(fallback)
      selected.set(fallbackKey, { ...fallback, identityKey: fallbackKey })
    }
  }
  return {
    mode: share.accessMode,
    selected: [...selected.values()],
    deploymentAllowedSubjectIds: [...deploymentAllowedSubjectIds],
    shareAllowedSubjectIds: acl,
    broadenedByDeploymentSubjects: deploymentAllowedSubjectIds.some(subject => acl.includes(subject)),
    identityKeyAcl: true,
  }
}

/**
 * Read one granted subject as an identity, when the owner named a bare subject id.
 * @param subjectId - Subject id or canonical identity key the owner named.
 * @param ownerIdentity - This host's own identity, which supplies the provider and tenant.
 * @returns The identity, or undefined when the owner named no identity this host can read.
 */
export function identityForGrantedSubject(
  subjectId: string,
  ownerIdentity: IdentityActor | undefined,
): IdentityTriple | undefined {
  const parsed = identityFromKey(subjectId)
  if (parsed !== undefined) return parsed
  return ownerIdentity === undefined
    ? undefined
    : {
      providerId: ownerIdentity.providerId,
      tenantId: ownerIdentity.tenantId,
      subjectId,
    }
}

/**
 * Build the reader of the Relay's authority over this host's shares.
 * @param deps - Shares, viewer reader, and the work a narrowed grant ends.
 * @returns Reads and adopted states of the Relay's authority.
 */
export function createRelayAuthority(deps: RelayAuthorityDeps): RelayAuthority {
  const relayAccess = new Map<string, ShareAccessStateFrame>()
  const relayGenerations = new Map<string, number>()
  const generationOf = (shareId: string): number => relayGenerations.get(shareId) ?? 0

  function viewerAdmitted(shareId: string, viewer: ShareRpcActor): boolean {
    const state = relayAccess.get(shareId)
    return !deps.disposed() && state !== undefined && !isExpired(state.expiresAt, Date.now())
      && requesterStillAdmitted(state, viewer)
  }

  function forgetRelayAccess(shareId: string): void {
    relayAccess.delete(shareId)
    deps.accessChanged()
  }

  function invalidateRelayAccess(shareId: string): void {
    relayGenerations.set(shareId, generationOf(shareId) + 1)
    const heldAuthority = relayAccess.delete(shareId)
    if (heldAuthority || deps.ownerShares.get(shareId)?.online === true) {
      deps.cancelShareTurn(shareId)
      deps.cancelChildTurns(shareId)
    }
    deps.viewerRead().closeShare(shareId)
    deps.accessChanged()
  }

  /**
   * Adopt one Relay's statement of a share's access.
   *
   * The frame is the authority for what a viewer receives, but only for what it states: the fork switch
   * below is guarded, so a Relay older than that switch leaves the owner's own decision standing rather
   * than silently narrowing the share.
   */
  function applyRelayAccess(
    shareId: string,
    state: ShareAccessStateFrame,
  ): void {
    if (deps.disposed()) return
    const previous = relayAccess.get(shareId)
    if (previous !== undefined && previous.version >= state.version) return
    relayAccess.set(shareId, state)
    const share = deps.ownerShares.get(shareId)
    if (share === undefined) return
    const { expiresAt: _expiresAt, ...retained } = share
    // The Relay's stated fork switch replaces the owner's decision; one it never stated leaves it intact.
    const nextAllowsFork = state.allowsFork ?? share.allowsFork
    const next: OwnerShare = { ...retained, accessMode: state.accessMode,
      allowedSubjectIds: state.allowedSubjectIds,
      allowsFork: nextAllowsFork,
      access: accessSummaryForAcl({ ...share, accessMode: state.accessMode }, state.allowedSubjectIds,
        deps.allowedSubjectIds, deps.ownerIdentity), revision: share.revision + 1,
      ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt }) }
    deps.ownerShares.set(shareId, next)
    deps.scheduleShareExpiry(next)
    if (previous !== undefined && (previous.sessionMode !== state.sessionMode
      || previous.allowsFork !== nextAllowsFork
      || previous.accessMode !== state.accessMode || !sameStringSet(previous.allowedSubjectIds, state.allowedSubjectIds)
      || previous.expiresAt !== state.expiresAt)) {
      // End requests admitted against the superseded snapshot before any later operation runs.
      if (previous.sessionMode === 'write' && state.sessionMode !== 'write') deps.viewerRead().cancelPendingCalls(shareId)
      deps.viewerRead().recheckAdmission(shareId)
      for (const child of deps.forks.listForShare(shareId)) {
        // A fork outlives a tier narrowing: the child runs under its own read-only ceiling. It ends with
        // the viewer's admission, or with the switch that created it.
        if (!viewerAdmitted(shareId, child.creator) || state.allowsFork !== true) {
          deps.cancelChildTurns(shareId, child.creator)
          deps.viewerRead().closeViewerStreams(shareId, child.creator)
        }
      }
      // An admission that narrowed can have ended a viewer's grant, and the host no longer attributes a
      // turn to a requester: it stops whatever the Session runs now rather than leave input admitted
      // under a grant that ended driving the owner's machine. A tier narrowing alone ends no turn,
      // because every execution re-reads the share's current tier before writing.
      if (admissionNarrowed(previous, state)) deps.cancelShareTurn(shareId)
      // The Session's sandbox follows its shares: a narrowed tier re-installs the read-only layer, and a
      // deadline that just passed releases it.
      deps.reconcileSourceAccess(share.sessionId)
    }
    deps.accessChanged()
  }

  async function readRelayAuthority(share: OwnerShare, signal?: AbortSignal): Promise<RelayAuthorityRead> {
    signal?.throwIfAborted()
    const generation = generationOf(share.shareId)
    const snapshot = await relayAuthorityRead(share.relay, share, signal)
    signal?.throwIfAborted()
    const current = deps.ownerShares.get(share.shareId)
    if (deps.disposed() || generation !== generationOf(share.shareId) || current?.gatewayToken !== share.gatewayToken
      || current.relay !== share.relay) return { ok: false }
    if (!snapshot.ok || snapshot.accessState === undefined) {
      invalidateRelayAccess(share.shareId)
      return { ok: false }
    }
    applyRelayAccess(share.shareId, snapshot.accessState)
    return snapshot
  }

  async function refreshRelayAccess(shareId: string, signal?: AbortSignal): Promise<void> {
    const share = deps.ownerShares.get(shareId)
    if (deps.disposed() || share === undefined) throw new Error('share-not-found')
    if (!(await readRelayAuthority(share, signal)).ok) throw new Error('Relay access state is unavailable')
  }

  /**
   * The tier this host may still drive one share with, or undefined when it may not.
   *
   * The deadline belongs to the grant: a share whose expiry has passed is not drivable even though its
   * record still names a tier, so its turns read as unestablished exactly as a downgraded share's do.
   *
   * The answer is the narrower of two statements: what this host registered, and what the Relay reports
   * for it. The Relay can lower a share — a deployment that does not write reports `view` for one — and
   * must never raise what the owner chose, so a stored record narrowed after its last registration caps
   * the Relay's wider answer.
   */
  function drivableModeOf(shareId: string): ViewerSessionMode | undefined {
    const share = deps.ownerShares.get(shareId)
    if (deps.disposed() || share === undefined || isExpired(share.expiresAt, Date.now())) return undefined
    const reported = relayAccess.get(shareId)?.sessionMode
    if (reported === undefined) return undefined
    return reported === 'write' && share.sessionMode === 'write' ? 'write' : 'view'
  }

  return {
    viewerAdmitted,
    forgetRelayAccess,
    invalidateRelayAccess,
    applyRelayAccess,
    readRelayAuthority,
    refreshRelayAccess,
    drivableModeOf,
  }
}
