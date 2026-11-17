/**
 * One running host's claim on a LiveShare owner state directory.
 *
 * Two hosts that start on the same DSH home restore the same persisted shares. A Relay registration
 * belongs to one host at a time, so the later host re-registering them makes the earlier host's
 * authority reads answer for a registration the Relay has moved: the earlier host then fences the
 * share and, with it, cancels the owner's running turn. This claim names the host that owns the
 * state: the holder restores, registers, and mutates the shares, and every other host reads them
 * without publishing anything.
 *
 * The rules follow the session write lease
 * ([Agent Note](../../../../../.agents/notes/implemented/feature/2026-08-31-cross-process-session-write-lease.md)):
 * ownership has no expiry, the arbiter outlives a holder's failure, and contention is a typed answer
 * rather than a crash. Two properties differ because this directory is not session data: the claim is
 * advisory and gates Relay registrations rather than file writes, and a record naming this process is
 * reclaimed, because every host in one process shares the same owner state. The
 * [owner state note](../../../../../.agents/notes/implemented/feature/2026-11-11-liveshare-owner-state-host-claim.md)
 * records why a recorded claim beats kernel arbitration.
 *
 * The claim is created exclusively (`wx`), so at most one creator wins on a local filesystem. A
 * holder is live while its recorded pid is; a record left by a process that is gone is reclaimed by
 * the next host, and so is one that names this process. The liveness check protects no share data and
 * no Session log, and pid reuse can at worst leave a live host without its shares until its next
 * start. There is deliberately no deadline that could expropriate a stalled holder.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/owner-host-claim
 */

import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { base64Url } from './base64-url.ts'
import { isRecord } from './wire-json.ts'

/** Base name of the claim file inside the owner state directory. */
export const OWNER_HOST_CLAIM_FILENAME = 'owner-host.json'

/** Another running host already owns this owner state directory. */
export class OwnerHostClaimHeldError extends Error {
  /**
   * @param holderPid - Process that holds the claim, or this process when its own claim blocks it.
   */
  constructor(readonly holderPid: number) {
    super(`the LiveShare owner state is held by dsh pid ${String(holderPid)}`)
    this.name = 'OwnerHostClaimHeldError'
  }
}

/** One held claim, released exactly once by the host that took it. */
export interface OwnerHostClaim {
  /** Release the claim when this process still holds it. */
  release(): void
  /**
   * Whether the claim file still names this host.
   *
   * A successor can replace the record while this host runs, so a caller about to change or
   * re-register the state re-reads it instead of trusting the claim taken at startup.
   * @returns True while the file still names the host that took the claim.
   */
  holds(): boolean
  /** Record this claim carries, which names the holder that took it. */
  readonly hostId: string
}

/** Liveness probe a test can replace. */
export interface OwnerHostClaimOptions {
  /** Whether the recorded holder is still running; defaults to a kernel signal-0 probe. */
  readonly alive?: (pid: number) => boolean
}

/**
 * Path of the claim file for one owner state directory.
 * @param dir - Directory that holds the owner state file.
 * @returns The claim file path.
 */
export function ownerHostClaimPath(dir: string): string {
  return join(dir, OWNER_HOST_CLAIM_FILENAME)
}

/**
 * Claim one owner state directory for this process.
 * @param dir - Directory that holds the owner state file.
 * @param options - Liveness probe override.
 * @returns The held claim.
 * @throws {OwnerHostClaimHeldError} while another live host holds the claim.
 */
export function claimOwnerHost(dir: string, options: OwnerHostClaimOptions = {}): OwnerHostClaim {
  const path = ownerHostClaimPath(dir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const hostId = base64Url(randomBytes(9))
  const record = JSON.stringify({ hostId, pid: process.pid })
  const alive = options.alive ?? processAlive
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (publishClaim(path, record, hostId)) {
      return {
        hostId,
        release: () => { releaseClaim(path, hostId) },
        holds: () => claimStillHeld(path, hostId),
      }
    }
    const current = readClaim(path)
    if (current === undefined) continue
    // An unreadable record states no holder to judge, and may be the one a concurrent host is still
    // publishing: it is left alone, so this host reports the state as held and never removes it.
    const holder = claimPidOf(current)
    if (holder !== undefined && holder !== process.pid && alive(holder)) {
      throw new OwnerHostClaimHeldError(holder)
    }
    removeObservedClaim(path, current)
  }
  /* v8 ignore start -- only a writer that recreates the claim between our removal and the retry reaches this. */
  const raced = readClaim(path)
  throw new OwnerHostClaimHeldError(raced === undefined ? process.pid : claimPidOf(raced) ?? process.pid)
  /* v8 ignore stop */
}

/**
 * Publish one claim record under its final name, or report that another record already holds it.
 *
 * The record is written beside the claim and then linked into place: a link publishes the whole file
 * it names or fails because the name exists, so no reader ever sees a claim that is not yet written.
 * @param path - Claim file path.
 * @param record - Claim record to publish.
 * @param hostId - Host the record names, which names the temporary file too.
 * @returns True when this call's record now sits at the claim path.
 */
function publishClaim(path: string, record: string, hostId: string): boolean {
  const staged = `${path}.${hostId}.tmp`
  writeFileSync(staged, record, { mode: 0o600 })
  try {
    linkSync(staged, path)
    return true
  } catch (error: unknown) {
    /* v8 ignore next -- POSIX-only failure path: a directory at the claim path refuses the write too. */
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return false
  } finally {
    rmSync(staged, { force: true })
  }
}

/**
 * Read the claim record at one path.
 * @param path - Claim file path.
 * @returns The file's content, or undefined when no claim file is there.
 */
function readClaim(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // A claim another host already removed is gone, and the next pass publishes this host's.
    return undefined
  }
}

/**
 * Remove one claim record this call judged reclaimable, unless another host published one first.
 *
 * A record whose process is gone names nothing this process must respect, and neither does one naming
 * this process: every host in one process shares the same owner state. A competing host that publishes
 * between this call's verdict and its removal wins, because the reread sees the record this call
 * judged and any other record is left in place.
 * @param path - Claim file path.
 * @param observed - Record this call read and judged reclaimable.
 */
function removeObservedClaim(path: string, observed: string): void {
  if (readClaim(path) === observed) unlinkClaim(path)
}

/**
 * Remove one claim while the file still names the host that took it.
 * @param path - Claim file path.
 * @param hostId - Host that is releasing.
 */
function releaseClaim(path: string, hostId: string): void {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    // A claim already gone needs no release.
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    // An unreadable record cannot name a successor, so nothing it holds is ours to release.
    return
  }
  if (!isRecord(parsed) || parsed.hostId !== hostId) return
  unlinkClaim(path)
}

/**
 * Read the pid one claim record names.
 * @param content - Claim file content.
 * @returns The recorded pid, or undefined when the record is missing or unreadable.
 */
function claimPidOf(content: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
    return undefined
  }
  return parsed.pid
}

/**
 * Whether one claim record still names one host.
 * @param path - Claim file path.
 * @param hostId - Host that took the claim.
 * @returns True when the file parses and names that host.
 */
function claimStillHeld(path: string, hostId: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
  return isRecord(parsed) && parsed.hostId === hostId
}

/**
 * Remove one claim file, tolerating a removal another host already made.
 * @param path - Claim file path.
 */
function unlinkClaim(path: string): void {
  // A claim another host already removed is not a failure; every other removal error surfaces.
  rmSync(path, { force: true })
}

/**
 * Whether one pid still runs.
 * @param pid - Recorded holder pid.
 * @returns True when the process exists, including one this user may not signal.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
