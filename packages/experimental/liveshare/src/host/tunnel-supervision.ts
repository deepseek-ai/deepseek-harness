/**
 * Worker supervision for one owner host: registration replay, heartbeats, expiry timers, and rows owed.
 *
 * The gateway worker process carries every share this host publishes, so this module owns its
 * lifetime: the commands sent over IPC, the settlements that resolve a pending registration, the
 * timers that re-register or remove a share, and the credential state each registration presents.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/tunnel-supervision
 */

import { randomBytes } from 'node:crypto'
import { base64Url } from './base64-url.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { IdentityActor, TunnelShareSpec, TunnelWorkerEvent } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type {
  ClaimOutcome,
  OwnerIdentityStatus,
} from '../owner-identity.ts'
import { identitySubjectLabel } from '../owner-identity.ts'
import { relayRefusalStatus } from '../owner-gateway/relay-refusal.ts'
import type { RelayConnectivityView, RelayPublishView } from '../share-api-types.ts'
import { parseViewerRequest } from '../viewer-channel.ts'
import type { ViewerSessionMode } from './fork-policy.ts'
import type { PendingRelayRemoval } from './owner-persistence.ts'
import {
  ownerCredentialState,
  reportedOwnerCredentialExpiry,
  saveOwnerCredential,
  type StoredOwnerCredential,
} from './owner-credential-file.ts'
import type { OwnerShare } from './owner-types.ts'
import type { RelayAuthority } from './relay-authority.ts'
import { normalizeRelayUrl } from './relay-url.ts'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { ViewerReadService } from './viewer-read.ts'
import { TunnelWorker, type TunnelWorkerInput } from './tunnel-worker.ts'
import { isRecord } from './wire-json.ts'

/** Longest wait one timer may take; a deadline beyond it is waited for in steps. */
const MAX_EXPIRY_TIMER_MS = 2 ** 31 - 1

/** How long one stopped share's Relay deletion waits before this host tries it again. */
const PENDING_REMOVAL_RETRY_MS = 30_000

/** Longest wait between two attempts, so a Relay that never returns is asked less and less often. */
const PENDING_REMOVAL_MAX_WAIT_MS = 30 * 60_000

/** One registration this host is waiting to settle. */
interface PendingShare {
  readonly resolve: (result: { ok: boolean; error?: string }) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Fields one gateway registration needs from a share, before it is stored as an OwnerShare. */
type ShareRegistrationSource = Pick<
  OwnerShare,
  'shareId' | 'sessionId' | 'sessionTitle' | 'accessMode' | 'relay' | 'gatewayToken' | 'allowedSubjectIds'
> & {
  readonly expiresAt?: string
  readonly allowsFork: boolean
  readonly sessionMode: ViewerSessionMode
}

/** Node process and argv that start the owner gateway worker. */
export interface TunnelProcessCommand {
  readonly executable: string
  readonly args: readonly string[]
}

/**
 * Resolve the gateway worker entry beside the running host module.
 * A source checkout loads this module from `src/host/`, while the bundled host is the package's
 * `lib/index.js` entry and ships the worker as `lib/owner-gateway/cli.js`.
 * @param moduleUrl - `import.meta.url` of the running host module.
 * @returns Node executable and argv that start the owner gateway worker.
 */
export function gatewayWorkerCommand(moduleUrl: string): TunnelProcessCommand {
  if (fileURLToPath(moduleUrl).endsWith('.ts')) {
    return {
      executable: process.execPath,
      args: ['--import', 'tsx/esm', fileURLToPath(new URL('../owner-gateway/cli.ts', moduleUrl))],
    }
  }
  return {
    executable: process.execPath,
    args: [fileURLToPath(new URL('./owner-gateway/cli.js', moduleUrl))],
  }
}

function tunnelCommand(): TunnelProcessCommand {
  return gatewayWorkerCommand(import.meta.url)
}

/** Owner state, credential, and worker channels one host's registration and timers read. */
export interface TunnelSupervisionDeps {
  /** Host context, read for the optional title services the reconcile step uses. */
  readonly ctx: Context
  /** Shares this host publishes; registration replay walks them. */
  readonly ownerShares: Map<string, OwnerShare>
  /** Relay rows this host stopped but has not deleted. */
  readonly pendingRemovals: Map<string, PendingRelayRemoval>
  /** This owner instance's id, carried by every registration. */
  readonly instanceId: string
  /** Subjects this deployment admits to every share. */
  readonly allowedSubjectIds: readonly string[]
  /** Owner identity fields every registration carries, when this host has an identity. */
  readonly ownerContext: { readonly ownerProviderId?: string; readonly ownerTenantId?: string }
  /** This host's own identity, used when a credential carries no name. */
  readonly ownerIdentity: IdentityActor | undefined
  /** Relay authority reads and adopted state. */
  readonly relay: RelayAuthority
  /** The viewer reader, answered for forwarded requests. */
  readonly viewerRead: () => ViewerReadService
  /** Tell remote access that reader answers may have changed. */
  readonly accessChanged: () => void
  /** Stop whatever turn one share's Session is running. */
  readonly cancelShareTurn: (shareId: string) => void
  /** Reconcile one Session's sandbox after a share stopped or expired. */
  readonly reconcileSourceAccess: (sessionId: string) => void
  /** Stop child work whose grant is narrowed or removed. */
  readonly cancelChildTurns: (shareId: string, viewer?: ShareRpcActor) => void
  /** Whether this host has been disposed. */
  readonly disposed: () => boolean
  /** Owner credential file, written when a Relay reports a horizon. */
  readonly ownerCredentialFile: string
  /** Credential this host holds now. */
  readonly storedCredential: () => StoredOwnerCredential | undefined
  /** Replace the credential this host holds. */
  readonly setStoredCredential: (credential: StoredOwnerCredential) => void
  /** Persist this host's owner state. */
  readonly persistOwnerState: () => Promise<void>
}

/** Worker lifecycle, registration replay, credential state, and timers for one owner host. */
export interface TunnelSupervision {
  /**
   * Send one command to the gateway worker, starting it when it is not running.
   * @param command - Command the worker carries out.
   */
  send(command: TunnelWorkerInput): void
  /**
   * Wait for one registration to settle.
   * @param shareId - Share the registration named.
   * @param timeoutMs - Longest wait before the registration is reported as timed out.
   * @returns The worker's settlement for that registration.
   */
  waitForShare(shareId: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }>
  /**
   * Build the worker's registration for one owner share.
   * @param share - Share or throwaway registration to publish.
   * @param credential - Credential captured by the operation.
   * @returns The registration payload.
   */
  shareSpec(share: ShareRegistrationSource, credential: StoredOwnerCredential | undefined): TunnelShareSpec
  /**
   * Arm the cancellation that stops a share's running turn the moment the share expires.
   * @param share - Share to arm or re-arm.
   */
  scheduleShareExpiry(share: OwnerShare): void
  /**
   * Disarm the deadline of a share that is no longer published.
   * @param shareId - Share whose deadline is disarmed.
   */
  clearShareExpiry(shareId: string): void
  /**
   * Delete the Relay rows this host still owes.
   */
  flushPendingRemovals(): Promise<void>
  /** Arm the next attempt for the rows still owed, or disarm when none are left. */
  armPendingRemovalRetry(): void
  /**
   * Delete one share's row from the Relay that carries it.
   * @param relay - Relay base URL the row belongs to.
   * @param shareId - Share whose row is deleted.
   * @param gatewayToken - Management token the Relay authorizes the deletion with.
   * @returns True when the Relay removed the row, or already carried none.
   */
  deleteRelayRow(relay: string, shareId: string, gatewayToken: string): Promise<boolean>
  /**
   * Refresh every share's recorded title from the Session's own title fold.
   */
  reconcileShareTitles(): Promise<void>
  /**
   * Per-Relay facts this host has learned.
   * @param relay - Relay address the facts describe.
   * @returns The facts for that normalized address.
   */
  factsFor(relay: string): { supportsCredentials?: boolean; claim?: ClaimOutcome }
  /**
   * Ask the Relay whether it binds owner identity, and what horizon it grants the credential held.
   * @param relay - Relay base URL to probe.
   */
  probeRelayCredentialSupport(relay: string): Promise<void>
  /**
   * Bind this host's existing shares to its verified identity.
   * @param relay - Normalized Relay address the credential was issued for.
   * @param credential - Credential captured by the operation, absent when the host is unverified.
   * @returns How many shares this pass bound and how many were already bound to this identity.
   */
  claimOwnedShares(relay: string, credential: string | undefined): Promise<ClaimOutcome>
  /**
   * Credential currently usable for one Relay address.
   * @param relay - Relay address the credential was bound to.
   * @param credential - Credential this host holds.
   * @returns The credential, or undefined when this host does not judge it usable there.
   */
  credentialForRelay(relay: string, credential: StoredOwnerCredential | undefined): string | undefined
  /**
   * Credential stored for one Relay address, whether or not this host still judges it unexpired.
   * @param relay - Relay address the credential was bound to.
   * @returns The credential, or undefined when none is stored for that address.
   */
  claimableCredentialForRelay(relay: string): string | undefined
  /**
   * Register this host's shares for one Relay address again when they are not connected.
   * @param relay - Normalized Relay address the credential was issued for.
   * @param credential - Credential just committed for that address.
   */
  reregisterOfflineShares(relay: string, credential: StoredOwnerCredential): void
  /**
   * Check that one Relay answers at all.
   * @param relay - Relay address to check.
   * @returns The anonymous connectivity result.
   */
  probeRelayConnectivity(relay: string): Promise<RelayConnectivityView>
  /**
   * Register one throwaway share to check whether this host may publish.
   * @param relay - Relay address to probe.
   * @param share - Throwaway registration to carry.
   * @returns The Relay's decision about this host's credential.
   */
  probeRelayPublish(relay: string, share: Omit<TunnelShareSpec, 'shareId'>): Promise<RelayPublishView>
  /**
   * Owner identity state for one Relay address, without exposing the credential itself.
   * @param relay - Relay address to report.
   * @param extra - Renewal or claim facts to include.
   * @param credential - Credential this host holds.
   * @returns The owner identity status.
   */
  ownerIdentityStatus(
    relay: string,
    extra: { readonly renewed?: boolean; readonly claim?: ClaimOutcome },
    credential: StoredOwnerCredential | undefined,
  ): OwnerIdentityStatus
  /**
   * Stop the worker and release every timer and pending registration this module holds.
   * @param closeViewer - Releases the viewer reader at its point in the shutdown order.
   */
  dispose(closeViewer: () => void): Promise<void>
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/**
 * Version of this owner bundle, read from the manifest beside the source file or the built entry.
 * It is the only version this process can report without asking the host.
 * @returns The bundle version, or undefined when no manifest is readable.
 */
function bundleVersion(): string | undefined {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf8'))
      if (isRecord(parsed) && typeof parsed.version === 'string' && parsed.version !== '') {
        return parsed.version
      }
    } catch (_noManifestBesideThisEntry) {
      continue
    }
  }
  /* v8 ignore next -- the package manifest ships beside both entries this reads it from. */
  return undefined
}

/**
 * Title one share should adopt after reading its Session.
 * @param recorded - Title stored on the share when it was created or last refreshed.
 * @param current - Title the Session's own title fold reports.
 * @returns The replacement title, or undefined when the Session reports none or the same one.
 */
export function refreshedShareTitle(recorded: string, current: unknown): string | undefined {
  return typeof current === 'string' && current !== '' && current !== recorded ? current : undefined
}

/** Optional Session lookup: a profile without it keeps each share's recorded title. */
interface SessionLookup {
  get(sessionId: string): unknown
}

/** Optional title fold: read by the Session object the lookup above returned. */
interface SessionTitleLookup {
  get(session: unknown): { readonly title?: unknown } | undefined
}

/**
 * Render a failed Relay request as the owner-facing diagnosis.
 *
 * The share dialog prints this text unchanged, so it carries the transport cause (TLS trust, DNS,
 * refused connection, timeout) instead of a summary the owner cannot act on.
 * @param error - Rejection raised by the Relay request.
 * @returns The cause, prefixed with the runtime's error code when it reports one.
 */
function describeTransportFailure(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code
    return typeof code === 'string' ? `${code}: ${cause.message}` : cause.message
  }
  return String(cause)
}

/**
 * Build the worker supervisor for one owner host.
 * @param deps - Shares, credential state, viewer reader, and persistence.
 * @returns Worker lifecycle, registration replay, credential state, and timers.
 */
export function createTunnelSupervision(deps: TunnelSupervisionDeps): TunnelSupervision {
  const pending = new Map<string, PendingShare>()
  const forwardedRequests = new Map<string, AbortController>()
  const forwardedTasks = new Set<Promise<void>>()
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let worker: TunnelWorker | undefined
  let pendingRemovalTimer: ReturnType<typeof setTimeout> | undefined
  let pendingRemovalWait = PENDING_REMOVAL_RETRY_MS
  const dshVersion = bundleVersion()

  const settle = (event: TunnelWorkerEvent): void => {
    if (event.type === 'share-access-state') {
      deps.relay.applyRelayAccess(event.shareId, event)
      return
    }
    if (event.type === 'share-rpc-cancel') {
      forwardedRequests.get(event.token)?.abort(new Error('Relay request ended'))
      return
    }
    if (event.type === 'share-rpc-request') {
      const request = parseViewerRequest(event.body)
      if (request === undefined) {
        send({
          type: 'share-rpc-response',
          token: event.token,
          id: event.id,
          shareId: event.shareId,
          status: 400,
          body: { error: 'invalid viewer request' },
        })
        return
      }
      const controller = new AbortController()
      forwardedRequests.set(event.token, controller)
      const task = deps.viewerRead().answer(event.shareId, request, event.actor, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return
          send({ type: 'share-rpc-response', token: event.token, id: event.id,
            shareId: event.shareId, status: result.status, body: result.body })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          console.error(`[liveshare] viewer read failed share=${event.shareId}: ${error instanceof Error ? error.message : String(error)}`)
          send({
            type: 'share-rpc-response',
            token: event.token,
            id: event.id,
            shareId: event.shareId,
            status: 500,
            body: { error: 'viewer-read-failed' },
          })
        })
        .finally(() => {
          if (forwardedRequests.get(event.token) === controller) forwardedRequests.delete(event.token)
          forwardedTasks.delete(task)
        })
      forwardedTasks.add(task)
      return
    }
    if (event.type === 'share-connected') {
      deps.relay.forgetRelayAccess(event.shareId)
      const share = deps.ownerShares.get(event.shareId)
      if (share !== undefined) share.online = true
      // A share the Relay admitted proves this host can reach it, so the rows it owes may go now.
      void flushPendingRemovals()
    } else if (event.type === 'share-error' || event.type === 'share-closed') {
      deps.relay.invalidateRelayAccess(event.shareId)
      const share = deps.ownerShares.get(event.shareId)
      if (share !== undefined) share.online = false
      // A share restored from owner state has no waiter to receive this, so the reason a share is
      // offline would otherwise exist only inside the worker. Recording it is what makes a share that
      // never came back diagnosable from the owner side.
      if (event.type === 'share-error') {
        console.warn(`[liveshare] share offline share=${event.shareId} reason=${event.message}`)
      }
    }
    if (event.type !== 'share-connected' && event.type !== 'share-error') return
    const entry = pending.get(event.shareId)
    if (entry === undefined) return
    pending.delete(event.shareId)
    clearTimeout(entry.timer)
    entry.resolve(event.type === 'share-connected'
      ? { ok: true }
      : { ok: false, ...(event.message === '' ? {} : { error: event.message }) })
  }

  const ensureWorker = (): TunnelWorker => {
    if (worker !== undefined) return worker
    worker = new TunnelWorker({ command: tunnelCommand() })
    worker.onEvent(settle)
    worker.start()
    return worker
  }

  const send = (command: TunnelWorkerInput): void => {
    if (command.type === 'remove-share') deps.relay.invalidateRelayAccess(command.shareId)
    ensureWorker().send(command)
  }

  const waitForShare = (
    shareId: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(shareId)
        resolve({ ok: false, error: 'gateway-timeout' })
      }, timeoutMs)
      pending.set(shareId, { resolve, timer })
    })
  }

  const scheduleShareExpiry = (share: OwnerShare): void => {
    const armed = expiryTimers.get(share.shareId)
    if (armed !== undefined) clearTimeout(armed)
    expiryTimers.delete(share.shareId)
    const at = share.expiresAt === undefined ? undefined : Date.parse(share.expiresAt)
    if (at === undefined || !Number.isFinite(at)) return
    armShareExpiry(share.shareId, share.sessionId, at - Date.now())
  }

  /** One wait for a deadline, re-armed when the deadline is further away than a single timeout may wait. */
  const armShareExpiry = (shareId: string, sessionId: string, delayMs: number): void => {
    const timer = setTimeout(() => {
      expiryTimers.delete(shareId)
      const at = deps.ownerShares.get(shareId)?.expiresAt
      const deadline = at === undefined ? undefined : Date.parse(at)
      if (deadline !== undefined && Number.isFinite(deadline) && deadline > Date.now()) {
        armShareExpiry(shareId, sessionId, deadline - Date.now())
        return
      }
      // The deadline passed, so this share can no longer drive anything: its running turn is stopped and
      // every stream a viewer opened through it is released, upstream subscriptions included. The record
      // stays where it is, so the reader refuses later reads from the same deadline.
      deps.cancelShareTurn(shareId)
      deps.cancelChildTurns(shareId)
      deps.viewerRead().closeShare(shareId)
      // A Session whose shares have all passed their deadlines gets its own tools back.
      deps.reconcileSourceAccess(sessionId)
      deps.accessChanged()
    }, Math.max(0, Math.min(delayMs, MAX_EXPIRY_TIMER_MS)))
    // An armed deadline is not work the process owes anyone: it must never hold a host open by itself.
    timer.unref()
    expiryTimers.set(shareId, timer)
  }

  const clearShareExpiry = (shareId: string): void => {
    const armed = expiryTimers.get(shareId)
    if (armed === undefined) return
    clearTimeout(armed)
    expiryTimers.delete(shareId)
  }

  /**
   * Delete one share's row from the Relay that carries it.
   *
   * Bounded: no owner decision waits on the Relay's answer, so a host that cannot reach it stops
   * trying here and leaves the row for the next attempt.
   */
  const deleteRelayRow = async (relay: string, shareId: string, gatewayToken: string): Promise<boolean> => {
    try {
      const relayUrl = new URL(`${relay}/__liveshare/share`)
      relayUrl.searchParams.set('shareId', shareId)
      const response = await fetch(relayUrl, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${gatewayToken}` },
        signal: AbortSignal.timeout(5_000),
      })
      return response.ok || response.status === 404
    } catch {
      // An unreachable Relay is the ordinary offline case, and the owner's stop already took effect.
      return false
    }
  }

  /**
   * Delete the Relay rows this host still owes.
   *
   * One row per share the owner stopped while the Relay could not be told, attempted again whenever
   * the Relay may answer: at startup, on an owner request that reaches it, and on the retry timer
   * that is armed while rows remain.
   */
  const flushPendingRemovals = async (): Promise<void> => {
    if (deps.pendingRemovals.size === 0) return
    let delivered = false
    for (const entry of [...deps.pendingRemovals.values()]) {
      if (await deleteRelayRow(entry.relay, entry.shareId, entry.gatewayToken)) {
        deps.pendingRemovals.delete(entry.shareId)
        delivered = true
      }
    }
    if (delivered) {
      pendingRemovalWait = PENDING_REMOVAL_RETRY_MS
      try {
        await deps.persistOwnerState()
      } catch {
        // The rows are gone from this host; the file still names them until its next write succeeds.
      }
    }
    armPendingRemovalRetry()
  }

  /** Arm the next attempt for the rows still owed, or disarm when none are left. */
  const armPendingRemovalRetry = (): void => {
    if (pendingRemovalTimer !== undefined) clearTimeout(pendingRemovalTimer)
    pendingRemovalTimer = undefined
    if (deps.pendingRemovals.size === 0 || deps.disposed()) return
    const wait = pendingRemovalWait
    // Only this timer backs off; a trigger that reaches the Relay still flushes at once.
    pendingRemovalWait = Math.min(pendingRemovalWait * 2, PENDING_REMOVAL_MAX_WAIT_MS)
    const timer = setTimeout(() => {
      pendingRemovalTimer = undefined
      void flushPendingRemovals()
    }, wait)
    // A row the Relay has not been told about is not work this process owes: it never holds the host open.
    timer.unref()
    pendingRemovalTimer = timer
  }

  /**
   * Refresh every share's recorded title from the Session's own title fold.
   *
   * A share records the title the owner held when it was created, and renaming the Session
   * afterwards left that copy stale. Both services are read optionally: a profile without the
   * session-title fold keeps the recorded title instead of failing to mount this bundle.
   */
  const reconcileShareTitles = async (): Promise<void> => {
    const sessions = deps.ctx.get('sessions') as SessionLookup | undefined
    const titles = deps.ctx.get('sessionTitle') as SessionTitleLookup | undefined
    if (sessions === undefined || titles === undefined) return
    for (const share of [...deps.ownerShares.values()]) {
      const session = sessions.get(share.sessionId)
      if (session === undefined) continue
      const snapshot = titles.get(session)
      const title = refreshedShareTitle(share.sessionTitle, snapshot?.title)
      if (title === undefined) continue
      const next: OwnerShare = { ...share, sessionTitle: title, revision: share.revision + 1 }
      deps.ownerShares.set(next.shareId, next)
      // The worker ignores an add for a share it already carries, so the renamed title only
      // reaches the Relay after the old registration is dropped.
      send({ type: 'remove-share', shareId: next.shareId })
      send({ type: 'add-share', share: shareSpec(next, deps.storedCredential()) })
      await deps.persistOwnerState()
    }
  }

  /**
   * The name a reader sees beside one share.
   *
   * The name comes from the verified credential's own display name. A credential that carries only a
   * subject shows that subject's label rather than an invented name, and a registration without a
   * credential falls back to the Relay's host name. Creating a share already requires a verified
   * credential, so a name always resolves.
   */
  const readerFacingOwnerName = (
    relay: string,
    credential: StoredOwnerCredential | undefined,
  ): string => {
    const status = ownerIdentityStatus(relay, {}, credential)
    const displayName = nonEmpty(status.displayName)
    if (displayName !== undefined) return displayName
    const subjectId = nonEmpty(status.subjectId)
    return subjectId === undefined ? new URL(relay).host : identitySubjectLabel(subjectId)
  }

  /**
   * The owner identity every registration of a share carries.
   *
   * A share reaches the Relay's ACL both when the owner creates it and when the worker is handed
   * the shares this profile reconnected with, and a reader's admission is derived from these fields
   * either way, so both sites build the row here instead of keeping two copies in step by hand.
   */
  const ownerIdentityRow = (relay: string, credential: StoredOwnerCredential | undefined) => ({
    ...deps.ownerContext,
    ownerDisplayName: readerFacingOwnerName(relay, credential),
    /* v8 ignore next -- the version is read from the package manifest beside this module. */
    ...(dshVersion === undefined ? {} : { dshVersion }),
    ownerInstanceId: deps.instanceId,
  })

  const shareSpec = (share: ShareRegistrationSource, credential: StoredOwnerCredential | undefined): TunnelShareSpec => {
    const ownerCredential = registrableCredentialForRelay(share.relay, credential)
    return {
      shareId: share.shareId,
      sessionId: share.sessionId,
      sessionTitle: share.sessionTitle,
      // A share loaded from a state file written before the allowlist mode was renamed keeps that
      // mode: the stored ACL still decides who may read the share, and the Relay accepts the name.
      accessMode: share.accessMode,
      relay: share.relay,
      gatewayToken: share.gatewayToken,
      // The Relay refuses a new share without this, and takes the owner identity from it.
      ...(ownerCredential === undefined ? {} : { ownerCredential }),
      ...ownerIdentityRow(share.relay, credential),
      allowedSubjectIds: [...new Set([...deps.allowedSubjectIds, ...share.allowedSubjectIds])],
      ...(share.expiresAt === undefined ? {} : { expiresAt: share.expiresAt }),
      allowsFork: share.allowsFork,
      sessionMode: share.sessionMode,
    }
  }

  /**
   * Register this host's shares for one Relay address again when they are not connected.
   *
   * A gateway refusal ends that registration for the lifetime of the worker process, so a share the
   * Relay turned down while this host held no credential it would accept stays offline until
   * something hands the worker a registration again. Every credential that becomes usable is
   * therefore followed by one attempt per offline share of that address, which is what makes the
   * owner's own verification a reconnect instead of a restart. A connected share is left alone: its
   * registration is already the one the Relay admitted.
   */
  const reregisterOfflineShares = (relay: string, credential: StoredOwnerCredential): void => {
    for (const share of [...deps.ownerShares.values()]) {
      if (deps.disposed() || share.relay !== relay || share.online) continue
      send({ type: 'add-share', share: shareSpec(share, credential) })
    }
  }

  /**
   * Per-Relay facts, keyed by normalized base URL.
   *
   * An owner can point this host at more than one address, and each address has its own support and
   * claim outcome: mixing them would report one Relay's policy for another. A probe
   * that answers late writes only the address it asked about, so switching addresses cannot inherit
   * a stale answer.
   */
  const relayFacts = new Map<string, { supportsCredentials?: boolean; claim?: ClaimOutcome }>()
  const factsFor = (relay: string): { supportsCredentials?: boolean; claim?: ClaimOutcome } => {
    const normalized = normalizeRelayUrl(relay)
    const existing = relayFacts.get(normalized)
    if (existing !== undefined) return existing
    const created: { supportsCredentials?: boolean; claim?: ClaimOutcome } = {}
    relayFacts.set(normalized, created)
    return created
  }

  /**
   * Credential currently usable for one Relay address.
   *
   * A credential is bound to the address it was minted for, so a host that switches Relay keeps the
   * old file but never sends it to the new address.
   */
  const credentialForRelay = (
    relay: string,
    credential: StoredOwnerCredential | undefined,
  ): string | undefined => {
    const normalized = normalizeRelayUrl(relay)
    return ownerCredentialState(credential, normalized, Date.now()) === 'verified'
      ? credential?.credential
      : undefined
  }

  /**
   * Credential stored for one Relay address, whether or not this host still judges it unexpired.
   *
   * A claim presents this instead of {@link credentialForRelay}: the Relay decides a credential
   * against the login it keeps renewing, so a token past its signed expiry may still be accepted
   * there, and the answer is what tells this host the horizon that actually applies. A Relay that has
   * genuinely stopped accepting it answers a refusal, which changes nothing here.
   */
  const claimableCredentialForRelay = (relay: string): string | undefined => {
    const normalized = normalizeRelayUrl(relay)
    return deps.storedCredential()?.relay === normalized ? deps.storedCredential()?.credential : undefined
  }

  /**
   * Credential a registration for one share this host already holds presents.
   *
   * The Relay renews the login behind a credential, so its signed expiry is a floor and only the
   * Relay can say whether it still authorizes; this host's own read through
   * {@link ownerCredentialState} states what it can see, not what the Relay still accepts. A share in
   * this host's own state therefore registers with the credential stored for that address whatever
   * that read says. Withholding it made a Relay that no longer holds the row judge the restore an
   * anonymous first publish and refuse it, which left a link the owner never stopped sharing offline
   * until a restart. Creating a share keeps {@link credentialForRelay}, so an expired login still
   * blocks exactly the new shares it is the owner's to authorize.
   */
  const registrableCredentialForRelay = (
    relay: string,
    credential: StoredOwnerCredential | undefined,
  ): string | undefined => {
    const normalized = normalizeRelayUrl(relay)
    return credential?.relay === normalized ? credential.credential : undefined
  }

  /**
   * Adopt the horizon one Relay reported for the credential a claim presented.
   *
   * The Relay renews the login behind a credential, so the expiry signed into the token is a floor:
   * adopting the reported horizon is what keeps the status page and the publish path from calling a
   * credential expired that the Relay still accepts. A reported horizon earlier than the stored one is
   * adopted too, because a Relay that stopped renewing the login is the authority on that as well.
   */
  const adoptReportedCredentialHorizon = (relay: string, presented: string, reported: unknown): void => {
    const expiresAt = reportedOwnerCredentialExpiry(reported)
    const current = deps.storedCredential()
    // The answer belongs to the token this pass presented; a credential replaced while the request was
    // in flight keeps the horizon its own issuing Relay gave it.
    if (expiresAt === undefined || current === undefined
      || current.relay !== normalizeRelayUrl(relay) || current.credential !== presented) return
    if (current.expiresAt === expiresAt) return
    const committed: StoredOwnerCredential = { ...current, expiresAt }
    try {
      saveOwnerCredential(deps.ownerCredentialFile, committed)
    } catch {
      // A record this host cannot rewrite keeps the horizon it already had.
      return
    }
    deps.setStoredCredential(committed)
  }

  /**
   * Ask the Relay whether it binds owner identity, and what horizon it grants the credential held.
   *
   * A Relay that answers without `supported: true` is older than this owner build, and the host
   * refuses creation there rather than publishing a share anonymously. A Relay this host cannot
   * reach leaves the answer unknown: that is an availability problem, not a policy one.
   *
   * The probe presents the stored credential for that address when there is one, so this is also the
   * path that refreshes the local horizon for an owner whose shares are all gone and which therefore
   * never reaches a claim. A Relay that does not answer with a horizon leaves the stored value alone.
   */
  const probeRelayCredentialSupport = async (relay: string): Promise<void> => {
    const normalized = normalizeRelayUrl(relay)
    const facts = factsFor(normalized)
    const presented = claimableCredentialForRelay(normalized)
    try {
      const response = await fetch(new URL(`${normalized}/__liveshare/owner-credential`), {
        signal: AbortSignal.timeout(5_000),
        ...(presented === undefined ? {} : { headers: { 'x-liveshare-owner-credential': presented } }),
      })
      if (deps.disposed()) return
      if (!response.ok) {
        facts.supportsCredentials = false
        return
      }
      const body = await response.json() as { readonly supported?: unknown; readonly ownerCredentialExpiresAt?: unknown }
      if (deps.disposed()) return
      facts.supportsCredentials = body.supported === true
      if (presented !== undefined) adoptReportedCredentialHorizon(normalized, presented, body.ownerCredentialExpiresAt)
    } catch {
      // Unreachable stays unknown; the creation path still refuses without a credential.
      return
    }
  }

  /**
   * Bind this host's existing shares to its verified identity.
   *
   * A claim carries both the share's own management token and the owner credential, so the Relay
   * binds an identity only for a caller that already holds the share. The pass is idempotent, and a
   * Relay this host cannot reach simply leaves its shares unclaimed for the next attempt.
   * The pass uses one captured credential and address throughout; later owner changes cannot redirect it.
   */
  const claimOwnedShares = async (
    relay: string,
    credential: string | undefined,
  ): Promise<ClaimOutcome> => {
    let claimed = 0
    let skipped = 0
    if (credential === undefined || deps.disposed()) return { claimed, skipped }
    for (const share of [...deps.ownerShares.values()]) {
      if (deps.disposed()) break
      if (normalizeRelayUrl(share.relay) !== relay) continue
      try {
        const response = await fetch(
          new URL(`${share.relay}/__liveshare/share/claim?shareId=${encodeURIComponent(share.shareId)}`),
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${share.gatewayToken}`,
              'x-liveshare-owner-credential': credential,
            },
          },
        )
        if (!response.ok) continue
        const body = await response.json() as { readonly claimed?: unknown; readonly ownerCredentialExpiresAt?: unknown }
        adoptReportedCredentialHorizon(relay, credential, body.ownerCredentialExpiresAt)
        if (body.claimed === true) claimed += 1
        else skipped += 1
      } catch {
        // An unreachable Relay leaves the share as it was; the next pass retries it.
        continue
      }
    }
    return { claimed, skipped }
  }

  /** Owner identity state for one Relay address, without exposing the credential itself. */
  const ownerIdentityStatus = (
    relay: string,
    extra: { readonly renewed?: boolean; readonly claim?: ClaimOutcome },
    credential: StoredOwnerCredential | undefined,
  ): OwnerIdentityStatus => {
    const normalized = normalizeRelayUrl(relay)
    const facts = factsFor(normalized)
    // A Relay that cannot bind identity makes local credential state irrelevant: reporting anything
    // else would offer a verification path that cannot succeed at that address.
    const state = facts.supportsCredentials === false
      ? 'relay-unsupported'
      : ownerCredentialState(credential, normalized, Date.now())
    const bound = credential?.relay === normalized ? credential : undefined
    const claim = extra.claim ?? facts.claim
    return {
      state,
      relay: normalized,
      ...(bound?.displayName === undefined ? {} : { displayName: bound.displayName }),
      ...(bound?.subjectId === undefined ? {} : { subjectId: bound.subjectId }),
      ...(bound?.avatarUrl === undefined ? {} : { avatarUrl: bound.avatarUrl }),
      ...(bound?.expiresAt === undefined ? {} : { expiresAt: bound.expiresAt }),
      ...(extra.renewed === undefined ? {} : { renewed: extra.renewed }),
      ...(claim === undefined ? {} : { claim }),
    }
  }

  async function httpReachable(relay: string): Promise<{ reachable: true } | { reachable: false; reason: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 5_000)
    try {
      const response = await fetch(relay, { method: 'GET', redirect: 'manual', signal: controller.signal })
      await response.body?.cancel()
      return { reachable: true }
    } catch (error) {
      return { reachable: false, reason: describeTransportFailure(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * What one Relay connectivity check reports back to the owner dialog.
   *
   * `blocking` is the Host's own severity decision. An address that does not answer blocks the flow
   * before authorization, because the next step cannot run against it; nothing about credentials is
   * read here.
   */
  const probeRelayConnectivity = async (relay: string): Promise<RelayConnectivityView> => {
    const reachable = await httpReachable(relay)
    return reachable.reachable
      ? { ok: true, httpReachable: true, blocking: false }
      : { ok: false, httpReachable: false, blocking: true, error: `${relay}: ${reachable.reason}` }
  }

  /**
   * Register one throwaway share with the Relay and report what it answered.
   *
   * The probe carries the same credential, identity row, and management token a real share would, so
   * the Relay decides it the same way. The share is removed as soon as it settles either way.
   */
  const probeRegistration = async (
    share: Omit<TunnelShareSpec, 'shareId'>,
  ): Promise<{ ok: boolean; error?: string }> => {
    const shareId = `test-${base64Url(randomBytes(6))}`
    const result = waitForShare(shareId, 12_000)
    send({ type: 'add-share', share: { ...share, shareId } })
    const settled = await result
    send({ type: 'remove-share', shareId })
    return settled
  }

  /**
   * What one publish-permission check reports back to the owner dialog.
   *
   * `blocking` is the Host's own severity decision, because only the Host sees what the Relay answered:
   * a refusal is the Relay's decision about this credential and reaches the same answer on every
   * attempt, so it blocks until the owner verifies again; a transient failure keeps the ordinary retry.
   * The dialog picks its visual state from this flag and prints `error` unchanged.
   */
  const probeRelayPublish = async (
    relay: string,
    share: Omit<TunnelShareSpec, 'shareId'>,
  ): Promise<RelayPublishView> => {
    const settled = await probeRegistration(share)
    if (settled.ok) return { ok: true, blocking: false }
    const refusal = settled.error === undefined ? undefined : relayRefusalStatus(settled.error)
    if (refusal === undefined) {
      // The Relay did not decide this registration: the gateway keeps its reconnect schedule, so the
      // share stays creatable and the diagnosis only reports what happened.
      return {
        ok: false,
        blocking: false,
        ...(settled.error === undefined ? {} : { error: `${relay}: ${settled.error}` }),
      }
    }
    // A refusal is a decision about the credential this host presented, and the owner acts on it by
    // verifying again at this address rather than by waiting.
    return {
      ok: false,
      blocking: true,
      error: refusal === 401 || refusal === 403
        ? `${relay}: this address did not accept this host's owner credential (relay refused registration status=${String(refusal)})`
        : `${relay}: the Relay refused this registration (relay refused registration status=${String(refusal)})`,
    }
  }

  const dispose = async (closeViewer: () => void): Promise<void> => {
    for (const controller of forwardedRequests.values()) controller.abort(new Error('Host disposed'))
    if (pendingRemovalTimer !== undefined) clearTimeout(pendingRemovalTimer)
    closeViewer()
    for (const armed of expiryTimers.values()) clearTimeout(armed)
    expiryTimers.clear()
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: 'host disposed' })
    }
    pending.clear()
    await worker?.stop()
    await Promise.all(forwardedTasks)
    forwardedRequests.clear()
    worker = undefined
  }

  return {
    send,
    waitForShare,
    shareSpec,
    scheduleShareExpiry,
    clearShareExpiry,
    flushPendingRemovals,
    armPendingRemovalRetry,
    deleteRelayRow,
    reconcileShareTitles,
    factsFor,
    probeRelayCredentialSupport,
    claimOwnedShares,
    credentialForRelay,
    claimableCredentialForRelay,
    reregisterOfflineShares,
    probeRelayConnectivity,
    probeRelayPublish,
    ownerIdentityStatus,
    dispose,
  }
}
