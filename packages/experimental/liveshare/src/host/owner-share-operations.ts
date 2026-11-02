/**
 * The twelve owner share-management operations behind the `liveshareShares` Remote.
 *
 * Each method owns one operation's business order; the Remote service exposes it without a second
 * implementation. Failures are thrown as `RemoteError` values with a `liveshareShares/` code, which
 * the Gateway carries to the Client unchanged.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/share-operations-impl
 */

import { randomBytes } from 'node:crypto'
import { base64Url } from './base64-url.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type {
  OwnerRelayState,
  OwnerShareView,
  ShareAccess,
  ShareAudit,
  ShareAuditEntryView,
} from '../share-api-types.ts'
import type { ForkRegistry } from './fork-registry.ts'
import type { StoredOwnerCredential } from './owner-credential-file.ts'
import type { PendingRelayRemoval } from './owner-persistence.ts'
import { storedAccessMode } from './owner-persistence.ts'
import { normalizeRelayUrl } from './relay-url.ts'
import type { RelayAuthority } from './relay-authority.ts'
import type { OwnerShare } from './owner-types.ts'
import type { SourceAccessApplier } from './source-access.ts'
import type { OwnerShareOperations } from './share-operations.ts'
import type { TunnelSupervision } from './tunnel-supervision.ts'
import { readViewerCapabilitySelection } from './viewer-capability-selection.ts'
import type { ViewerDeclarationsSurface } from './viewer-declarations.ts'
import type { ViewerReadService } from './viewer-read.ts'
import { isRecord } from './wire-json.ts'

/** Longest share lifetime an owner may set from the dialog; longer links need a fresh decision. */
const MAX_SHARE_TTL_MINUTES = 7 * 24 * 60

/** Media type an answer carries when the Relay states none, and the unavailable answer's own. */
const DEFAULT_CONTENT_TYPE = 'application/json; charset=utf-8'

/** One forwarded Relay answer, detached from the Response so its fields are stated once. */
interface RelayRead {
  readonly ok: boolean
  readonly status: number
  readonly contentType: string
  readonly text: string
}

/**
 * Forward one audit read to the Relay that carries a share, preserving its status and media type.
 * @param share - Share whose audit is read.
 * @param relayPath - Relay path to read, relative to the share's Relay.
 * @returns The Relay's answer, or the unavailable answer when it cannot be reached.
 */
async function relayReadThroughShare(share: OwnerShare, relayPath: string): Promise<RelayRead> {
  const relayUrl = new URL(`${share.relay}/${relayPath}`)
  relayUrl.searchParams.set('shareId', share.shareId)
  try {
    const response = await fetch(relayUrl, {
      headers: { authorization: `Bearer ${share.gatewayToken}` },
    })
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type') ?? DEFAULT_CONTENT_TYPE,
      text: await response.text(),
    }
  } catch {
    return { ok: false, status: 502, contentType: DEFAULT_CONTENT_TYPE, text: JSON.stringify({ error: 'relay-unavailable' }) }
  }
}

/**
 * Parse one Relay audit answer into the owner-facing record.
 * @param body - Relay response body, as text.
 * @returns The audit record, or undefined when the body is not an audit answer.
 */
function readShareAudit(body: string): ShareAudit | undefined {
  if (body === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.events)) return undefined
  const events: ShareAuditEntryView[] = []
  for (const entry of parsed.events) {
    if (!isRecord(entry)
      || typeof entry.id !== 'string'
      || typeof entry.action !== 'string'
      || typeof entry.createdAt !== 'string') return undefined
    const detail = entry.detail
    if (detail !== undefined && !isJsonValue(detail)) return undefined
    events.push({
      id: entry.id,
      action: entry.action,
      createdAt: entry.createdAt,
      ...(typeof entry.actor === 'string' ? { actor: entry.actor } : {}),
      ...(detail === undefined ? {} : { detail: detail as JsonValue }),
    })
  }
  return { events }
}

/**
 * Project one stored share onto the owner list's wire record.
 *
 * The stored ACL keeps the retired `approval` spelling for old files; the wire maps it to
 * `selected`, which is the name every current surface uses.
 * @param share - Share as this host stores it.
 * @returns The owner-facing record.
 */
function ownerShareView(share: OwnerShare): OwnerShareView {
  return {
    shareId: share.shareId,
    sessionId: share.sessionId,
    sessionTitle: share.sessionTitle,
    link: share.link,
    createdAt: share.createdAt,
    ...(share.expiresAt === undefined ? {} : { expiresAt: share.expiresAt }),
    allowsFork: share.allowsFork,
    sessionMode: share.sessionMode,
    viewerCapabilities: share.viewerCapabilities ?? [],
    online: share.online,
    ...(share.access === undefined ? {} : { access: { ...share.access, mode: storedAccessMode(share.access.mode) } }),
  }
}

/**
 * Whether one string is a usable Relay base URL.
 * @param value Candidate address.
 * @returns True when the address normalizes.
 */
function isRelayAddress(value: string): boolean {
  try {
    normalizeRelayUrl(value)
    return true
  } catch {
    return false
  }
}

/** Host state the twelve operations read and change. */
export interface OwnerShareOperationDeps {
  /** Shares this host publishes. */
  readonly ownerShares: Map<string, OwnerShare>
  /** Relay rows this host stopped but has not deleted. */
  readonly pendingRemovals: Map<string, PendingRelayRemoval>
  /** Subjects this deployment admits to every share. */
  readonly allowedSubjectIds: readonly string[]
  /** Children this host created. */
  readonly forks: ForkRegistry
  /** The viewer reader, closed and re-checked by lifecycle changes. */
  readonly viewerRead: ViewerReadService
  /** The declaration surface whose live offers a capability selection is accepted against. */
  readonly viewerDeclarations: ViewerDeclarationsSurface
  /** Reads and adopted states of the Relay's authority over this host's shares. */
  readonly relay: RelayAuthority
  /** Worker registration, expiry timers, and persistence channels. */
  readonly tunnel: TunnelSupervision
  /** Current effective Relay address; absent while the owner has saved none. */
  readonly effectiveRelay: () => string | undefined
  /** Configured and effective Relay addresses, as the owner UI reads them. */
  readonly relayState: () => OwnerRelayState
  /** Set the owner's Relay override, which also sets the effective address. */
  readonly selectRelayAddress: (override: string | undefined) => void
  /** Bump the revision that fences owner operations begun under the previous address. */
  readonly bumpRelayRevision: () => void
  /** Credential this host holds now. */
  readonly storedCredential: () => StoredOwnerCredential | undefined
  /** Persist this host's owner state. */
  readonly persistOwnerState: () => Promise<void>
  /** Install the access layer one share's source Session needs. */
  readonly applySourceAccess: SourceAccessApplier
  /** Whether one share's source Session carries a usable confined layer. */
  readonly sourceConfined: (shareId: string) => boolean
  /** Tell remote access that reader answers may have changed. */
  readonly accessChanged: () => void
  /** Stop whatever turn one share's Session is running. */
  readonly cancelShareTurn: (shareId: string) => void
  /** Reconcile one Session's sandbox after a share stopped. */
  readonly reconcileSourceAccess: (sessionId: string) => void
  /** Stop child work whose grant is narrowed or removed. */
  readonly cancelChildTurns: (shareId: string, viewer?: ShareRpcActor) => void
}

/**
 * Build the twelve owner share-management operations for one host.
 * @param deps - Shares, Relay authority, worker channel, persistence, and lifecycle callbacks.
 * @returns The operations the Remote service calls.
 */
export function createOwnerShareOperations(deps: OwnerShareOperationDeps): OwnerShareOperations {
  const ownerShares = deps.ownerShares
  const pendingRemovals = deps.pendingRemovals
  const allowedSubjectIds = deps.allowedSubjectIds
  const forks = deps.forks
  const viewerRead = deps.viewerRead
  const viewerDeclarations = deps.viewerDeclarations
  const relay = deps.relay
  const tunnel = deps.tunnel
  const currentCredential = deps.storedCredential
  const effectiveRelay = deps.effectiveRelay
  const relayState = deps.relayState
  const selectRelayAddress = deps.selectRelayAddress
  const bumpRelayRevision = deps.bumpRelayRevision
  const persistOwnerState = deps.persistOwnerState
  const applySourceAccess = deps.applySourceAccess
  const sourceConfined = deps.sourceConfined
  const accessChanged = deps.accessChanged
  const cancelShareTurn = deps.cancelShareTurn
  const cancelChildTurns = deps.cancelChildTurns
  const reconcileSourceAccess = deps.reconcileSourceAccess

  /**
   * The owner operations behind the `liveshareShares` Remote.
   *
   * Each method owns one share-management side effect and its order; the Remote service exposes them
   * without a second implementation.
   */
  const operations: OwnerShareOperations = {
    /**
     * Order: address gate -> credential gate -> id/token/expiry -> waitForShare -> send(add-share) ->
     * settlement -> failure remove-share and 502 -> ownerShares.set(online) -> persist (failure removes
     * the share, clears its expiry, and sends remove-share) -> scheduleShareExpiry -> applySourceAccess.
     *
     * The address gate must run first: with no saved address there is no Relay to register with, so the
     * refusal names that rather than a credential the owner cannot supply either. The credential gate
     * must run before a token exists; the registration must settle before the
     * share is stored, or the owner is told about a link the Relay refused; the record must be
     * durable before its deadline is armed or its layer is installed, or a restart loses a share the
     * process is already serving; and a failed settle must remove the worker registration before the
     * answer returns, or the Relay keeps a share this host never stored.
     */
    async create(request) {
      if (request.sessionId === '') {
        throw new RemoteError('liveshareShares/missing-session-id', 'create requires a sessionId', {})
      }
      const sessionTitle = request.sessionTitle === undefined || request.sessionTitle === ''
        ? request.sessionId
        : request.sessionTitle
      const accessMode = request.accessMode ?? 'open'
      // Nothing can be published before the owner saves an address: the Share dialog is where one is
      // chosen, and this refusal is what a caller skipping that step reads.
      const relayAddress = effectiveRelay()
      if (relayAddress === undefined) {
        throw new RemoteError('liveshareShares/relay-url-required',
          'no Liveshare server address is saved; save one in the Share dialog first', {})
      }
      // The Relay refuses an unverified publisher, so the owner host does too instead of creating a
      // share that can never connect and leaving a dead link in the manager.
      const relay = normalizeRelayUrl(relayAddress)
      const credential = currentCredential()
      if (tunnel.credentialForRelay(relay, credential) === undefined) {
        const identity = tunnel.ownerIdentityStatus(relay, {}, credential)
        if (identity.state === 'relay-unsupported') {
          throw new RemoteError('liveshareShares/relay-upgrade-required',
            `${relay} does not bind owner identity`, { identity })
        }
        throw new RemoteError('liveshareShares/owner-login-required',
          `no verified owner credential is stored for ${relay}`, { identity })
      }
      const ttlMinutes = request.ttlMinutes
      if (ttlMinutes !== undefined && !(Number.isSafeInteger(ttlMinutes)
        && ttlMinutes > 0 && ttlMinutes <= MAX_SHARE_TTL_MINUTES)) {
        throw new RemoteError('liveshareShares/invalid-ttl', 'ttlMinutes is outside the allowed range', {})
      }
      const expiresAt = ttlMinutes === undefined
        ? undefined
        : new Date(Date.now() + ttlMinutes * 60_000).toISOString()
      const requestedSubjects = request.allowedSubjectIds ?? []
      const sessionMode = request.sessionMode ?? 'view'
      const allowsFork = request.allowsFork === true
      const shareAllowedSubjectIds = [...new Set([...allowedSubjectIds, ...requestedSubjects])]
      const shareId = base64Url(randomBytes(9))
      const gatewayToken = base64Url(randomBytes(32))
      const share = {
        shareId,
        sessionId: request.sessionId,
        sessionTitle,
        accessMode,
        relay,
        gatewayToken,
        allowedSubjectIds: shareAllowedSubjectIds,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        allowsFork,
        sessionMode,
      }
      const access: ShareAccess = {
        mode: accessMode,
        selected: [],
        deploymentAllowedSubjectIds: [...allowedSubjectIds],
        shareAllowedSubjectIds,
        broadenedByDeploymentSubjects: allowedSubjectIds.length > 0,
        identityKeyAcl: true,
      }
      const connected = tunnel.waitForShare(shareId, 15_000)
      tunnel.send({ type: 'add-share', share: tunnel.shareSpec(share, credential) })
      const result = await connected
      if (!result.ok) {
        tunnel.send({ type: 'remove-share', shareId })
        throw new RemoteError('liveshareShares/relay-unavailable', result.error ?? 'relay-unavailable', {
          relay,
          ...(result.error === undefined ? {} : { reason: result.error }),
        })
      }
      // Publication stays on the Relay the worker registered with; an override applies to later shares.
      const createdAt = new Date().toISOString()
      const link = `${relay}/?shareId=${encodeURIComponent(shareId)}`
      ownerShares.set(shareId, {
        shareId,
        sessionId: request.sessionId,
        sessionTitle,
        accessMode,
        link,
        relay,
        gatewayToken,
        allowedSubjectIds: shareAllowedSubjectIds,
        access,
        revision: 1,
        createdAt,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        allowsFork,
        sessionMode,
        online: true,
      })
      try {
        await persistOwnerState()
      } catch {
        ownerShares.delete(shareId)
        tunnel.clearShareExpiry(shareId)
        tunnel.send({ type: 'remove-share', shareId })
        throw new RemoteError('liveshareShares/owner-state-unavailable',
          'the owner state file could not be written', {})
      }
      // The share's own deadline is what stops its running turn later, armed from the record it just stored.
      tunnel.scheduleShareExpiry(ownerShares.get(shareId) as OwnerShare)
      // A share created in write mode installs its access layer before the owner is told the share exists:
      // a request admitted on the strength of this answer must never arrive ahead of the layer judging it.
      await applySourceAccess(ownerShares.get(shareId) as OwnerShare, undefined, 'publish')
      return { link, shareId, sessionId: request.sessionId, sessionMode, access }
    },

    /**
     * Order: reconcileShareTitles -> void flushPendingRemovals() -> each share's readRelayAuthority
     * (success applyRelayAccess, failure invalidateRelayAccess) -> persist when any record changed ->
     * assemble the list.
     *
     * Reconciling first means the persisted titles match the fields assembled below; flushing first
     * uses the same list request as the host's next Relay contact; and reading each share's authority
     * before assembling means the list carries the tier and ACL the Relay actually committed, not
     * only what this host last stored.
     */
    async list() {
      await tunnel.reconcileShareTitles()
      // The owner's own page polling the list is the ordinary moment this host reaches the Relay.
      void tunnel.flushPendingRemovals()
      const views = await Promise.all([...ownerShares.values()].map(async (share) => {
        await relay.readRelayAuthority(share)
        const next = ownerShares.get(share.shareId)
        if (next === undefined) return undefined
        return { changed: next !== share, share: ownerShareView(next) }
      }))
      const live = views.flatMap(view => view === undefined ? [] : [view])
      if (live.some(view => view.changed)) {
        try {
          await persistOwnerState()
        } catch {
          throw new RemoteError('liveshareShares/owner-state-unavailable',
            'the owner state file could not be written', {})
        }
      }
      return { shares: live.map(view => view.share) }
    },

    /**
     * Order: send(remove-share) -> closeShare -> cancel the source turn -> cancel child turns ->
     * forks.revokeShare -> ownerShares.delete -> accessChanged -> clearShareExpiry -> persist ->
     * deleteRelayRow -> record and arm a pending removal.
     *
     * The worker registration goes first so the Relay cannot admit a viewer while this host still
     * holds the record; the record is still present when the turn and forks are revoked because they
     * name the share; and the Relay row is deleted only after the local record is durable, because a
     * reachable deletion is what lets the pending-removal queue stay empty.
     */
    async stop(request) {
      const share = ownerShares.get(request.shareId)
      if (share === undefined) {
        throw new RemoteError('liveshareShares/share-not-found', `share ${request.shareId} is not published`, {
          shareId: request.shareId,
        })
      }
      const { shareId } = share
      // The owner's authority over its own share is local: the worker registration, the reader, the
      // turn it admitted, its forks, and the stored record all go before the Relay is asked, so a
      // Relay that is down or slow cannot keep a share alive that the owner has stopped.
      tunnel.send({ type: 'remove-share', shareId })
      viewerRead.closeShare(shareId)
      // A removed share leaves nothing to drive the Session, so a turn it admitted is cancelled while the
      // record is still here to say which share and which Session that turn belongs to.
      cancelShareTurn(shareId)
      cancelChildTurns(shareId)
      // A removed share takes its forks with it: the children stay in the registry as history, but they
      // are marked revoked so a later resume cannot install a limit and drive a child whose share the
      // owner withdrew.
      await forks.revokeShare(shareId, new Date().toISOString())
      ownerShares.delete(shareId)
      // A Session no share names any more loses its sandbox, which restores its own tools.
      reconcileSourceAccess(share.sessionId)
      accessChanged()
      tunnel.clearShareExpiry(shareId)
      try {
        await persistOwnerState()
      } catch {
        throw new RemoteError('liveshareShares/owner-state-unavailable',
          'the owner state file could not be written', {})
      }
      const relayRemoved = await tunnel.deleteRelayRow(share.relay, shareId, share.gatewayToken)
      if (!relayRemoved) {
        // The Relay still carries this row, so this host owes it a deletion it could not deliver: the
        // share's identity and the token that deletes the row are kept until that deletion lands.
        pendingRemovals.set(shareId, { relay: share.relay, shareId, gatewayToken: share.gatewayToken })
        try {
          await persistOwnerState()
        } catch {
          throw new RemoteError('liveshareShares/owner-state-unavailable',
            'the owner state file could not be written', {})
        }
        tunnel.armPendingRemovalRetry()
      }
      return relayRemoved ? { ok: true } : { ok: true, relay: 'unreachable' }
    },

    /**
     * Order: look up the share -> no-op branch (reinstall the layer when it is not confined) ->
     * ownerShares.set -> accessChanged -> cancel pending calls on a write-to-view narrowing -> persist
     * (failure restores the previous record) -> send(remove-share) then send(add-share) -> revoke forks
     * when the switch turns off -> applySourceAccess.
     *
     * The record must be stored before either worker message, because those messages make the Relay
     * reread the share; persistence must succeed before the Relay is told, or a failed write leaves the
     * Relay carrying a permission this host cannot restore; and the layer is re-installed last because
     * a request admitted on the new answer must not arrive before the layer that judges it.
     */
    async updatePermissions(request) {
      if (request.shareId === '') {
        throw new RemoteError('liveshareShares/missing-share-id', 'updatePermissions requires a shareId', {})
      }
      const hasTtl = request.ttlMinutes !== undefined
      if (request.sessionMode === undefined && request.allowsFork === undefined && !hasTtl) {
        throw new RemoteError('liveshareShares/missing-permission',
          'updatePermissions requires a permission or lifetime change', {})
      }
      if (hasTtl && request.ttlMinutes !== null && !(Number.isSafeInteger(request.ttlMinutes)
        && request.ttlMinutes > 0 && request.ttlMinutes <= MAX_SHARE_TTL_MINUTES)) {
        throw new RemoteError('liveshareShares/invalid-ttl', 'ttlMinutes is outside the allowed range', {})
      }
      const current = ownerShares.get(request.shareId)
      if (current === undefined) {
        throw new RemoteError('liveshareShares/share-not-found', `share ${request.shareId} is not published`, {
          shareId: request.shareId,
        })
      }
      const shareId = request.shareId
      const nextMode = request.sessionMode ?? current.sessionMode
      const nextAllowsFork = request.allowsFork ?? current.allowsFork
      const nextExpiresAt = hasTtl
        ? request.ttlMinutes === null
          ? undefined
          : new Date(Date.now() + request.ttlMinutes * 60_000).toISOString()
        : current.expiresAt
      const changed = nextMode !== current.sessionMode
        || nextAllowsFork !== current.allowsFork
        || nextExpiresAt !== current.expiresAt
      if (!changed) {
        // A share that already names this state may still have no usable layer: its Session was not
        // live when it was set, or this host restarted before one could be installed. Asking again
        // installs it rather than answering as if the capability were already in place.
        if (!sourceConfined(shareId)) await applySourceAccess(current, undefined, 'mode')
        return {
          shareId, sessionMode: current.sessionMode, allowsFork: current.allowsFork,
          ...(current.expiresAt === undefined ? {} : { expiresAt: current.expiresAt }),
        }
      }
      const { expiresAt: _previousExpiry, ...retained } = current
      const next: OwnerShare = {
        ...retained,
        sessionMode: nextMode,
        allowsFork: nextAllowsFork,
        ...(nextExpiresAt === undefined ? {} : { expiresAt: nextExpiresAt }),
        revision: current.revision + 1,
      }
      ownerShares.set(shareId, next)
      // The reader's snapshot recomputes from the stored tier and fork switch.
      accessChanged()
      if (current.sessionMode === 'write' && nextMode !== 'write') viewerRead.cancelPendingCalls(shareId)
      try {
        await persistOwnerState()
      } catch {
        ownerShares.set(shareId, current)
        throw new RemoteError('liveshareShares/owner-state-unavailable',
          'the owner state file could not be written', {})
      }
      // The Relay is the authority for both values, so the share is re-registered with them instead of
      // the owner keeping a local opinion the Relay cannot see.
      tunnel.send({ type: 'remove-share', shareId })
      tunnel.send({ type: 'add-share', share: tunnel.shareSpec(next, currentCredential()) })
      tunnel.scheduleShareExpiry(next)
      if (!nextAllowsFork) {
        // Turning the fork switch off stops children from acting immediately; their data stays.
        await forks.revokeShare(shareId, new Date().toISOString())
        accessChanged()
      }
      // Both tiers drive the source Session, so its access layer stays and is re-installed for the tier
      // in force: a request admitted on the strength of the owner's answer must never arrive before the
      // layer that judges it exists, and a narrowed tier must stop the writes the wider one allowed
      // without ending the turn itself.
      await applySourceAccess(next, undefined, 'mode')
      return {
        shareId, sessionMode: next.sessionMode, allowsFork: next.allowsFork,
        ...(next.expiresAt === undefined ? {} : { expiresAt: next.expiresAt }),
      }
    },

    /**
     * Order: look up the share -> validate the submission against the live plugin offers ->
     * ownerShares.set -> persist (failure restores the previous record) -> accessChanged.
     *
     * The live offers are the authority, so a name no plugin currently offers is refused before the
     * record changes; the selection is stored before exposure is invalidated, so every open reader
     * snapshot recomputes from the record that was actually persisted.
     */
    async setCapabilities(request) {
      if (request.shareId === '') {
        throw new RemoteError('liveshareShares/missing-share-id', 'setCapabilities requires a shareId', {})
      }
      const current = ownerShares.get(request.shareId)
      if (current === undefined) {
        throw new RemoteError('liveshareShares/share-not-found', `share ${request.shareId} is not published`, {
          shareId: request.shareId,
        })
      }
      // The live offers are the authority: a name no plugin currently offers is refused by name here
      // rather than stored as a selection no decision could ever expose.
      const accepted = readViewerCapabilitySelection(viewerDeclarations.declaredCapabilities(), request.capabilities)
      if (!accepted.ok) {
        const refusal = accepted.refusal
        if (refusal.code === 'invalid-capabilities') {
          throw new RemoteError('liveshareShares/invalid-capabilities', 'capabilities is not a plugin selection', {})
        }
        if (refusal.code === 'unknown-plugin') {
          throw new RemoteError('liveshareShares/unknown-plugin',
            `no plugin offers viewer endpoints under ${refusal.plugin}`, { plugin: refusal.plugin })
        }
        throw new RemoteError('liveshareShares/endpoint-not-offered',
          `${refusal.plugin} does not offer ${refusal.endpoint} as ${refusal.kind}`,
          { plugin: refusal.plugin, kind: refusal.kind, endpoint: refusal.endpoint })
      }
      const { viewerCapabilities: _replaced, ...retained } = current
      const next: OwnerShare = {
        ...retained,
        ...(accepted.selection === undefined ? {} : { viewerCapabilities: accepted.selection }),
        revision: current.revision + 1,
      }
      ownerShares.set(request.shareId, next)
      try {
        await persistOwnerState()
      } catch {
        ownerShares.set(request.shareId, current)
        throw new RemoteError('liveshareShares/owner-state-unavailable',
          'the owner state file could not be written', {})
      }
      // Every open reader snapshot recomputes the policy's bindings, which read this selection and the
      // plugins' offers per decision, so exposure ends or begins at the next call.
      accessChanged()
      return { shareId: request.shareId, viewerCapabilities: next.viewerCapabilities ?? [] }
    },

    /**
     * Read the live offers. A declaration is an offer, not a grant: nothing here exposes anything.
     * @returns The endpoints plugins currently offer.
     */
    capabilities() {
      return { capabilities: viewerDeclarations.declaredCapabilities() }
    },

    /**
     * Read the address the owner saved, which is also the address new shares publish to.
     * @returns Relay state shared by the owner UI; both fields are absent while none is saved.
     */
    relay() {
      return relayState()
    },

    /**
     * Order: capture the previous effective address -> store the saved address -> bump the
     * authorization revision when the address changed -> persist.
     *
     * The revision is bumped before persistence so a login transaction begun under the old address is
     * already fenced; a failed write reports the failure but leaves the selected address in force,
     * exactly as the route always did.
     */
    async setRelay(request) {
      const previousRelay = effectiveRelay()
      if (request.relayUrl === null || request.relayUrl.trim() === '') {
        selectRelayAddress(undefined)
      } else {
        let normalized: string
        try {
          normalized = normalizeRelayUrl(request.relayUrl.trim())
        } catch {
          throw new RemoteError('liveshareShares/invalid-relay-url', 'relayUrl is not a usable base URL', {})
        }
        selectRelayAddress(normalized)
      }
      if (effectiveRelay() !== previousRelay) bumpRelayRevision()
      try {
        await persistOwnerState()
      } catch {
        throw new RemoteError('liveshareShares/owner-state-unavailable',
          'the owner state file could not be written', {})
      }
      return relayState()
    },

    /**
     * Order: resolve the requested address (or the effective one) -> validate it -> probe Relay
     * credential support when this address has not answered yet -> report identity.
     *
     * Probing before reporting keeps an address this host has not asked from borrowing another
     * address's support answer; the credential itself never enters the report.
     */
    async identity(request) {
      const relay = request.relay === undefined || request.relay === '' ? effectiveRelay() : request.relay
      if (relay === undefined) {
        throw new RemoteError('liveshareShares/relay-url-required',
          'no Liveshare server address is saved; save one in the Share dialog first', {})
      }
      if (!isRelayAddress(relay)) {
        throw new RemoteError('liveshareShares/invalid-relay', `${relay} is not a usable Relay address`, { relay })
      }
      const credential = currentCredential()
      const status = tunnel.ownerIdentityStatus(relay, {}, credential)
      // Support is per address, so an address this host has not probed yet is probed now rather than
      // borrowing another address's answer. A credential the signed token says is stale is probed
      // too: the Relay renews the login behind it, and only its answer can move the local horizon.
      if (tunnel.factsFor(relay).supportsCredentials === undefined || status.state !== 'verified') {
        await tunnel.probeRelayCredentialSupport(relay)
      }
      return tunnel.ownerIdentityStatus(relay, {}, credential)
    },

    /**
     * Order: resolve the share -> forward the audit read to the Relay -> parse a successful answer.
     *
     * The Relay's own status and body are preserved on refusal, because the owner page classifies them;
     * a body this host cannot parse is reported as an unavailable audit rather than silently flattened.
     */
    async audit(request) {
      const share = ownerShares.get(request.shareId)
      if (share === undefined) {
        throw new RemoteError('liveshareShares/share-not-found', `share ${request.shareId} is not published`, {
          shareId: request.shareId,
        })
      }
      const response = await relayReadThroughShare(share, '__liveshare/audit')
      const audit = response.ok ? readShareAudit(response.text) : undefined
      if (audit !== undefined) return audit
      throw new RemoteError('liveshareShares/audit-unavailable', `audit is unavailable for ${share.relay}`, {
        relay: share.relay,
        status: response.status,
        contentType: response.contentType,
        ...(response.text === '' ? {} : { body: response.text }),
      })
    },

    /**
     * Order: flush owed Relay deletions -> run the anonymous connectivity check.
     *
     * Asking whether the Relay answers is the other moment this host learns it can deliver a deletion.
     */
    async testRelay() {
      void tunnel.flushPendingRemovals()
      // Nothing is in force before the owner saves an address, and a probe of no address is not a fact
      // about any Relay: the answer states the missing address instead of inventing a failure.
      const relay = effectiveRelay()
      if (relay === undefined) {
        return { ok: false, httpReachable: false, blocking: true, error: 'no Liveshare server address is saved' }
      }
      // Connectivity is the first step and carries no owner credential: the address either answers or
      // it does not, and a server that refuses an anonymous request has still answered.
      return tunnel.probeRelayConnectivity(normalizeRelayUrl(relay))
    },

    /**
     * Order: read the session id -> resolve the credential and identity row -> register one throwaway
     * share -> remove it after settlement.
     *
     * The permission step runs after authorization, so a host that holds no credential for the
     * effective address reports the authorization it still owes instead of asking the Relay to refuse
     * it; the throwaway registration carries the same credential, identity row, and management token a
     * real share would, so the Relay decides it the same way.
     */
    async testPublish(request) {
      if (request.sessionId === '') {
        throw new RemoteError('liveshareShares/missing-session-id', 'testPublish requires a sessionId', {})
      }
      const relayAddress = effectiveRelay()
      if (relayAddress === undefined) {
        return { ok: false, blocking: true, error: 'no Liveshare server address is saved' }
      }
      const relay = normalizeRelayUrl(relayAddress)
      const credential = currentCredential()
      const ownerCredential = tunnel.credentialForRelay(relay, credential)
      if (ownerCredential === undefined) {
        return {
          ok: false,
          blocking: true,
          error: `${relay}: no verified owner credential is stored for this address`,
        }
      }
      const share = tunnel.shareSpec({
        // The probe assigns the throwaway id it waits on; every other field is the real one.
        shareId: '',
        sessionId: request.sessionId,
        sessionTitle: request.sessionId,
        accessMode: 'open',
        relay,
        gatewayToken: base64Url(randomBytes(32)),
        allowedSubjectIds: [],
        allowsFork: false,
        sessionMode: 'view',
      }, credential)
      const result = await tunnel.probeRelayPublish(relay, share)
      return result
    },
  }
  return operations
}
