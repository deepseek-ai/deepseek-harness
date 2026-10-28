/** Owner credential kept beside the owner state file, bound to one Relay address. */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { OwnerIdentityState } from '../owner-identity.ts'
import { fromBase64Url } from './base64-url.ts'

/** One stored credential and the Relay address it was issued for. */
export interface StoredOwnerCredential {
  /** Relay base URL, normalized, the credential is bound to. */
  readonly relay: string
  readonly credential: string
  /** ISO expiry decoded from the credential payload. */
  readonly expiresAt?: string
  readonly displayName?: string
  readonly subjectId?: string
  /** Provider-issued avatar URL for display; absent when the credential carries none. */
  readonly avatarUrl?: string
}

/**
 * Read the stored credential.
 * @param file Credential file path.
 * @returns Stored credential, or undefined when the file is absent or unreadable.
 */
export function loadOwnerCredential(file: string): StoredOwnerCredential | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    // An absent credential file is the ordinary first-run state, not a failure.
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const value = parsed as Record<string, unknown>
    if (typeof value.relay !== 'string' || value.relay === '') return undefined
    if (typeof value.credential !== 'string' || value.credential === '') return undefined
    return {
      relay: value.relay,
      credential: value.credential,
      ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
      ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
      ...(typeof value.subjectId === 'string' ? { subjectId: value.subjectId } : {}),
      ...(typeof value.avatarUrl === 'string' && value.avatarUrl !== '' ? { avatarUrl: value.avatarUrl } : {}),
    }
  } catch {
    // A corrupt credential file is treated as no credential: the owner re-verifies instead.
    return undefined
  }
}

/**
 * Persist one credential with owner-only permissions.
 * @param file Credential file path.
 * @param value Credential and the Relay address it belongs to.
 */
export function saveOwnerCredential(file: string, value: StoredOwnerCredential): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(temporary, file)
}

/**
 * Read the identity facts out of a credential without verifying its signature.
 *
 * The Relay is the only party that can verify a credential, so these facts exist to report status
 * and expiry to the local browser; they never authorize anything by themselves.
 * @param credential Credential token exactly as stored.
 * @returns Decoded payload fields, or undefined when the token is not a signed payload.
 */
export function decodeOwnerCredential(
  credential: string,
): {
  readonly expiresAt?: string
  readonly displayName?: string
  readonly subjectId?: string
  readonly avatarUrl?: string
} | undefined {
  const dot = credential.lastIndexOf('.')
  if (dot <= 0) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(fromBase64Url(credential.slice(0, dot)).toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = payload as Record<string, unknown>
  const expiresAt = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
    ? new Date(value.expiresAt).toISOString()
    : undefined
  return {
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(typeof value.displayName === 'string' && value.displayName !== ''
      ? { displayName: value.displayName }
      : {}),
    ...(typeof value.subjectId === 'string' && value.subjectId !== ''
      ? { subjectId: value.subjectId }
      : {}),
    ...(typeof value.avatarUrl === 'string' && value.avatarUrl !== ''
      ? { avatarUrl: value.avatarUrl }
      : {}),
  }
}

/**
 * Read the horizon one Relay reported for a credential it accepted.
 *
 * The signed expiry inside a credential is the horizon the Relay wrote when it minted the token, and
 * the login behind it can be renewed past that instant. A response carrying the horizon the Relay
 * currently grants is therefore the authority, and the signed value is only its floor.
 * @param reported Value of the Relay's `ownerCredentialExpiresAt` response field.
 * @returns ISO time the Relay reported, or undefined when it reported none this host can read.
 */
export function reportedOwnerCredentialExpiry(reported: unknown): string | undefined {
  if (typeof reported !== 'string' || reported === '') return undefined
  const parsed = Date.parse(reported)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

/**
 * Report the credential state for one Relay address.
 * @param stored Credential currently on disk, if any.
 * @param relay Relay base URL this host is about to use.
 * @param now Current epoch milliseconds.
 * @returns Status of the credential for that address.
 */
export function ownerCredentialState(
  stored: StoredOwnerCredential | undefined,
  relay: string,
  now: number,
): OwnerIdentityState {
  if (stored === undefined || stored.relay !== relay) return 'unverified'
  if (stored.expiresAt === undefined) return 'verified'
  const expiresAt = Date.parse(stored.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > now ? 'verified' : 'expired'
}

/**
 * Delete the stored credential.
 * @param file Credential file path.
 */
export function clearOwnerCredential(file: string): void {
  rmSync(file, { force: true })
}
