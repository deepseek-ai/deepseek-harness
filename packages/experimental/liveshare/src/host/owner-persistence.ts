/**
 * Owner state file: the Relay override, the shares this host restores, and the Relay rows it owes.
 *
 * One JSON document holds everything this host must survive a restart with, and every write is
 * serialized per file so the newest content is the one that lands last.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/owner-persistence
 */

import { randomBytes } from 'node:crypto'
import { base64Url } from './base64-url.ts'
import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ShareAccessSelection } from '../share-api-types.ts'
import type { ViewerSessionMode } from './fork-policy.ts'
import { normalizeRelayUrl } from './relay-url.ts'
import type { OwnerShare, ShareAccessSummary } from './owner-types.ts'
import type { ViewerCapabilityGroup } from './viewer-declarations.ts'
import { isRecord } from './wire-json.ts'


/** One share as the owner state file stores it. */
export interface PersistedOwnerShare {
  readonly shareId: string
  readonly sessionId: string
  readonly sessionTitle: string
  /** Mode this share was created with; the retired `approval` spelling reads back as `selected`. */
  readonly accessMode: 'open' | 'selected' | 'approval'
  /** Relay this share was published to; a record without one cannot be restored. */
  readonly relay: string
  readonly gatewayToken: string
  readonly allowedSubjectIds: readonly string[]
  readonly access?: ShareAccessSummary
  readonly createdAt: string
  readonly expiresAt?: string
  /**
   * Whether this share lets an admitted viewer fork it.
   *
   * Absent on every share written before the switch was stored on its own, and such a record reads as
   * off at the boundary that loads it.
   */
  readonly allowsFork?: boolean
  /**
   * Tier this share was created with.
   *
   * Absent in files written before tiers existed, and such a record loads as `view`.
   */
  readonly sessionMode?: ViewerSessionMode
  /**
   * Plugin endpoints this share exposed to its viewers when it was written.
   *
   * Absent on every share written before the capability existed, and absent means none: an upgrade never
   * exposes a plugin endpoint the owner had no chance to select.
   */
  readonly viewerCapabilities?: readonly ViewerCapabilityGroup[]
}

/** Owner state read from disk: the persisted Relay override, every restorable share, and every Relay row still owed. */
export interface LoadedOwnerState {
  readonly relayUrl?: string
  readonly instanceId: string
  readonly shares: Map<string, OwnerShare>
  readonly pendingRemovals: Map<string, PendingRelayRemoval>
}

/**
 * One Relay row this host stopped but has not deleted there yet.
 *
 * The share is gone from this host already, and the row and the token that deletes it are kept only
 * until the Relay answers: a stop that landed while the Relay was unreachable is delivered at the
 * next contact instead of being lost until the row's expiry.
 */
export interface PendingRelayRemoval {
  readonly relay: string
  readonly shareId: string
  readonly gatewayToken: string
}

/**
 * Read this host's owner state file, creating an empty state when it does not exist.
 *
 * Every stored share names the Relay it was published to, and a record without one is invalid: this
 * build has no configured address to read such a share against, and LiveShare has never shipped a
 * state file that omits the field.
 * @param file - Owner state file path.
 * @returns The loaded saved address, instance id, shares, and owed Relay rows.
 */
export function loadOwnerState(file: string): LoadedOwnerState {
  if (!existsSync(file)) return { instanceId: newInstanceId(), shares: new Map(), pendingRemovals: new Map() }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`liveshare-share-host: invalid owner state file ${file}`)
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.shares)) {
    throw new Error(`liveshare-share-host: invalid owner state file ${file}`)
  }
  const relayUrl = persistedRelayUrl(parsed.relayUrl, file)
  const persistedInstanceId = (parsed as { instanceId?: unknown }).instanceId
  const instanceId = typeof persistedInstanceId === 'string' && persistedInstanceId !== ''
    ? persistedInstanceId
    : newInstanceId()
  const shares = new Map<string, OwnerShare>(parsed.shares.map((value): [string, OwnerShare] => {
    if (!isPersistedOwnerShare(value)) {
      throw new Error(`liveshare-share-host: invalid owner state file ${file}`)
    }
    const relay = normalizeRelayUrl(value.relay)
    return [value.shareId, {
      shareId: value.shareId,
      sessionId: value.sessionId,
      sessionTitle: value.sessionTitle,
      accessMode: storedAccessMode(value.accessMode),
      link: `${relay}/?shareId=${encodeURIComponent(value.shareId)}`,
      relay,
      gatewayToken: value.gatewayToken,
      allowedSubjectIds: [...value.allowedSubjectIds],
      ...(value.access === undefined ? {} : { access: { ...value.access, mode: storedAccessMode(value.access.mode) } }),
      revision: 1,
      createdAt: value.createdAt,
      ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
      // A record with no tier reads back as `view`; the record's own switch decides forking.
      sessionMode: value.sessionMode === 'write' ? 'write' : 'view',
      allowsFork: value.allowsFork === true,
      ...(value.viewerCapabilities === undefined ? {} : { viewerCapabilities: value.viewerCapabilities }),
      online: false,
    }]
  }))
  const pendingRemovals = new Map<string, PendingRelayRemoval>()
  const persistedRemovals = (parsed as { pendingRemovals?: unknown }).pendingRemovals
  for (const value of Array.isArray(persistedRemovals) ? persistedRemovals : []) {
    if (!isPendingRelayRemoval(value)) {
      throw new Error(`liveshare-share-host: invalid owner state file ${file}`)
    }
    pendingRemovals.set(value.shareId, {
      relay: normalizeRelayUrl(value.relay),
      shareId: value.shareId,
      gatewayToken: value.gatewayToken,
    })
  }
  return { instanceId, ...(relayUrl === undefined ? {} : { relayUrl }), shares, pendingRemovals }
}

/**
 * Write this host's owner state, serialized per file so the newest content lands last.
 * @param file - Owner state file path.
 * @param relayUrl - Relay override currently in force, when the owner set one.
 * @param instanceId - Identity of this owner instance.
 * @param shares - Shares to store.
 * @param pendingRemovals - Relay rows this host still owes a deletion.
 * @returns Completion of this write, including any failure the caller reports.
 */
export function writeOwnerState(
  file: string,
  relayUrl: string | undefined,
  instanceId: string,
  shares: ReadonlyMap<string, OwnerShare>,
  pendingRemovals: ReadonlyMap<string, PendingRelayRemoval>,
): Promise<void> {
  const persisted: PersistedOwnerShare[] = [...shares.values()].map(share => ({
    shareId: share.shareId,
    sessionId: share.sessionId,
    sessionTitle: share.sessionTitle,
    accessMode: share.accessMode,
    relay: share.relay,
    gatewayToken: share.gatewayToken,
    allowedSubjectIds: [...share.allowedSubjectIds],
    ...(share.access === undefined ? {} : { access: share.access }),
    createdAt: share.createdAt,
    ...(share.expiresAt === undefined ? {} : { expiresAt: share.expiresAt }),
    ...(share.allowsFork ? { allowsFork: true } : {}),
    sessionMode: share.sessionMode,
    ...(share.viewerCapabilities === undefined ? {} : { viewerCapabilities: share.viewerCapabilities }),
  }))
  const removals = [...pendingRemovals.values()].map(entry => ({
    relay: entry.relay,
    shareId: entry.shareId,
    gatewayToken: entry.gatewayToken,
  }))
  const content = JSON.stringify({
    instanceId,
    ...(relayUrl === undefined ? {} : { relayUrl }),
    shares: persisted,
    ...(removals.length === 0 ? {} : { pendingRemovals: removals }),
  }, null, 2)
  // The map holds only chains whose failures are already absorbed below, so the next write chained
  // on them can never observe a rejection.
  const write = (ownerStateWrites.get(file) ?? Promise.resolve())
    .then(() => writeFileAtomic(file, content, { mode: 0o600, dirMode: 0o700 }))
  ownerStateWrites.set(file, write.catch(() => undefined))
  return write
}

/** One state file's in-flight writes, so the newest content is the one that lands last. */
const ownerStateWrites = new Map<string, Promise<void>>()

/**
 * Whether one stored value is a Relay row this host still owes a deletion.
 * @param value - Parsed state file entry.
 * @returns True when the entry names a Relay, a share, and the token that deletes its row.
 */
function isPendingRelayRemoval(value: unknown): value is PendingRelayRemoval {
  return isRecord(value)
    && typeof value.relay === 'string' && value.relay !== ''
    && typeof value.shareId === 'string' && value.shareId !== ''
    && typeof value.gatewayToken === 'string' && value.gatewayToken !== ''
}

/** One owner DSH instance id, minted on first use and kept in the owner state file. */
function newInstanceId(): string {
  return base64Url(randomBytes(9))
}

function persistedRelayUrl(value: unknown, file: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new Error(`liveshare-share-host: invalid owner state file ${file}`)
  }
  return normalizeRelayUrl(value)
}

/**
 * Whether one stored value is a group of plugin endpoints a share exposed.
 *
 * The names are only checked as strings: the `share-viewer` policy intersects them with the plugins'
 * live declarations, so a name nothing declares can never expose an endpoint.
 * @param value - Parsed state file entry.
 * @returns True when the entry names a plugin and its endpoint lists.
 */
function isViewerCapabilityGroup(value: unknown): value is ViewerCapabilityGroup {
  return isRecord(value)
    && typeof value.plugin === 'string' && value.plugin !== ''
    && Array.isArray(value.readable) && value.readable.every(action => typeof action === 'string')
    && Array.isArray(value.writable) && value.writable.every(action => typeof action === 'string')
}

/**
 * Read the mode a state file stored, mapping the retired `approval` spelling to `selected`.
 * @param mode - Access mode as the state file recorded it.
 * @returns The mode this build's runtime and wire surfaces use.
 */
export function storedAccessMode(mode: 'open' | 'selected' | 'approval'): 'open' | 'selected' {
  return mode === 'approval' ? 'selected' : mode
}

function isPersistedOwnerShare(value: unknown): value is PersistedOwnerShare {
  return isRecord(value)
    && typeof value.shareId === 'string' && value.shareId !== ''
    && typeof value.sessionId === 'string'
    && typeof value.sessionTitle === 'string'
    && (value.accessMode === 'open' || value.accessMode === 'selected' || value.accessMode === 'approval')
    && typeof value.relay === 'string' && value.relay !== ''
    && typeof value.gatewayToken === 'string' && value.gatewayToken !== ''
    && Array.isArray(value.allowedSubjectIds)
    && value.allowedSubjectIds.every(subject => typeof subject === 'string')
    && (value.access === undefined || isShareAccessSummary(value.access))
    && typeof value.createdAt === 'string'
    && (value.expiresAt === undefined || typeof value.expiresAt === 'string')
    && (value.allowsFork === undefined || typeof value.allowsFork === 'boolean')
    && (value.viewerCapabilities === undefined
      || (Array.isArray(value.viewerCapabilities) && value.viewerCapabilities.every(isViewerCapabilityGroup)))
    && (value.sessionMode === undefined || value.sessionMode === 'view' || value.sessionMode === 'write')
}

function isShareAccessSummary(value: unknown): value is ShareAccessSummary {
  if (!isRecord(value)) return false
  return (value.mode === 'open' || value.mode === 'selected' || value.mode === 'approval')
    && Array.isArray(value.selected)
    && value.selected.every(isShareAccessSelection)
    && Array.isArray(value.deploymentAllowedSubjectIds)
    && value.deploymentAllowedSubjectIds.every(subject => typeof subject === 'string')
    && Array.isArray(value.shareAllowedSubjectIds)
    && value.shareAllowedSubjectIds.every(subject => typeof subject === 'string')
    && typeof value.broadenedByDeploymentSubjects === 'boolean'
    && value.identityKeyAcl === true
}

function isShareAccessSelection(value: unknown): value is ShareAccessSelection {
  return isRecord(value)
    && typeof value.providerId === 'string' && value.providerId !== ''
    && typeof value.tenantId === 'string' && value.tenantId !== ''
    && typeof value.subjectId === 'string' && value.subjectId !== ''
    && typeof value.identityKey === 'string' && value.identityKey !== ''
}
