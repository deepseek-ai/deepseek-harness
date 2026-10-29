/**
 * Durable record of the child sessions a fork created, under either share tier.
 *
 * The registry is what makes a fork isolatable: it knows which share and which viewer produced a
 * child, so a viewer's list shows only its own children, a revoked share stops its children, and a
 * child's prompt can be refused for a reason the Host can name. It also holds the ceiling the child
 * runs under, and refuses every prompt until that ceiling is installed and verified.
 *
 * One DSH home can be served by several Host processes, so every change is committed as a
 * read-modify-write under the cross-process writer lock of `@deepseek-ai/dsh-atomic-write`: the file
 * is re-read inside the lock, this process's own changes are applied to what it holds, and the result
 * replaces the file in one atomic step. A change therefore cannot be dropped by a concurrent write
 * from another process, and an entry another process changed is never restored from this process's
 * older copy.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ForkCeiling } from './fork-policy.ts'

/** Trusted creator identity of one child session. */
export interface ForkCreator {
  readonly providerId: string
  readonly tenantId: string
  readonly subjectId: string
}

/** One recorded child session and where it came from. */
export interface ForkRecord {
  readonly childSessionId: string
  /** Share that authorized the fork. */
  readonly shareId: string
  /** Session the child was forked from; the source is never modified. */
  readonly sourceSessionId: string
  /** Completed prefix the child started from. */
  readonly boundary: number
  readonly creator: ForkCreator
  readonly createdAt: string
  /** Set when the source share stopped, expired, or was revoked; the child is kept, not deleted. */
  readonly revokedAt?: string
}

/** Why one child session may not run a prompt. */
export type ForkPromptRefusal =
  | 'fork-unknown-child'
  | 'fork-viewer-mismatch'
  | 'fork-source-revoked'
  | 'fork-ceiling-uninstalled'
  /** Preparing a cold child through the owner's service failed, so nothing was admitted. */
  | 'fork-prepare-failed'

/** Whether one child may accept a prompt. */
export type ForkPromptDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ForkPromptRefusal; readonly message: string }

/** One logical fork request this host already served, so a retry resolves to its child. */
export interface ForkOperation {
  /** Identity of the logical request: trusted viewer, share, source, and the caller's operation id. */
  readonly key: string
  /** Child this request produced; empty while the request is only reserved. */
  readonly childSessionId: string
  /** Boundary the request named, which a retry of the same identity must repeat. */
  readonly boundary: number
  /**
   * Whether the child was left ready to be driven.
   *
   * A request whose child was created but could not be given read-only limits is remembered so a retry
   * does not fork again, and this flag keeps that record from ever reading as a success.
   */
  readonly ready: boolean
  /** The owner's own answer, replayed verbatim so a retry reports the child it already created. */
  readonly status: number
  readonly body: unknown
}

/** Persisted document; `version` lets a later change migrate instead of guessing. */
interface ForkRegistryFile {
  readonly version: 1
  readonly forks: readonly ForkRecord[]
  readonly operations?: readonly ForkOperation[]
}

/** The entries one registry document holds. */
interface RegistryEntries {
  readonly forks: readonly ForkRecord[]
  readonly operations: readonly ForkOperation[]
}

/** One batch of this process's changes, applied to the file inside the writer lock. */
interface ForkRegistryDelta {
  readonly forks: ReadonlyMap<string, ForkRecord>
  readonly operations: ReadonlyMap<string, ForkOperation>
  /** Withdrawals applied to every entry the file holds for that share, whoever recorded it. */
  readonly revocations: ReadonlyMap<string, string>
}

/**
 * Child-session registry with owner-only persistence and a default-deny prompt gate.
 *
 * Every mutation resolves once the file holds it and rejects when it could not be written, so a caller
 * that must not continue on an unwritten record — a reserved request, a withdrawn share — can await it
 * and stop. The registry's own reads stay in memory: the file is read at construction and each write
 * re-reads it, but an entry another process adds is not merged into this instance's maps.
 */
export class ForkRegistry {
  private readonly records = new Map<string, ForkRecord>()
  /** Logical requests already served, keyed by identity; a retry resolves to the recorded child. */
  private readonly operations = new Map<string, ForkOperation>()
  /** Changes this process made that the file does not hold yet, keyed as the document keys them. */
  private readonly pendingForks = new Map<string, ForkRecord>()
  private readonly pendingOperations = new Map<string, ForkOperation>()
  /**
   * Shares this process withdrew and has not recorded a child for since.
   *
   * Only a repeated withdrawal of the same share is suppressed: the first batch already withdrew every
   * entry the file held, and a child recorded afterwards is a new child, not one the withdrawal named.
   * The marker is dropped when a new child is recorded, so withdrawing the share again (after its fork
   * switch was turned back on) withdraws that child too.
   */
  private readonly withdrawnShares = new Map<string, string>()
  /** Withdrawals this process still has to commit, keyed by share; cleared once a batch carries them. */
  private readonly pendingRevocations = new Map<string, string>()
  /** Runs this process's batches one at a time, in the order the changes were made. */
  private chain: Promise<unknown> = Promise.resolve()
  /**
   * Ceiling enforced for each child that actually has one installed.
   *
   * Enforcement is per child, not per host: a guard registers on one child's own scoped context, so a
   * successful install for one child says nothing about its siblings, and a child restored from the
   * registry file after a restart has no live guard until one is registered again. A single host-wide
   * flag would let the first child to install open every other child's prompt.
   */
  private readonly enforced = new Map<string, ForkCeiling>()

  /**
   * @param file JSON file this registry reads at construction and rewrites on every change.
   */
  constructor(private readonly file: string) {
    const document = this.load()
    for (const record of document.forks) this.records.set(record.childSessionId, record)
    for (const operation of document.operations) this.operations.set(operation.key, operation)
  }

  /**
   * The child one logical fork request already produced.
   * @param key - identity of that request.
   * @returns The recorded operation, or undefined when this host never served it.
   */
  operationOf(key: string): ForkOperation | undefined {
    return this.operations.get(key)
  }

  /**
   * Record one served fork under its logical identity, so a retry resolves to the same child.
   * @param operation - The identity, its boundary, and the owner's answer to replay.
   * @returns A promise that rejects when the record could not be written.
   */
  async recordOperation(operation: ForkOperation): Promise<void> {
    this.operations.set(operation.key, operation)
    this.pendingOperations.set(operation.key, operation)
    await this.persist()
  }

  /**
   * Bind one logical request to the boundary it named, before any child exists.
   *
   * A durable binding is what makes a later request of the same identity naming another boundary a
   * conflict rather than a second fork, even when the process that reserved it never finished creating
   * the child. A reservation is replaced by {@link recordOperation} once the child exists.
   * @param key - Identity of the logical request.
   * @param boundary - Normalized boundary that request selected.
   * @returns A promise that rejects when the reservation could not be written.
   */
  async reserveOperation(key: string, boundary: number): Promise<void> {
    if (this.operations.has(key)) return
    const operation: ForkOperation = { key, boundary, childSessionId: '', ready: false, status: 0, body: undefined }
    this.operations.set(key, operation)
    this.pendingOperations.set(key, operation)
    await this.persist()
  }

  /**
   * Record that one child's own execution limit is installed.
   *
   * The caller registers that child's scoped guard first and calls this only after it returns, so the
   * record states a fact about the child rather than an intention about the host.
   * @param childSessionId Child whose limit was installed.
   * @param ceiling Ceiling its guard enforces.
   * @returns False when this host never recorded that child, so a failed install is distinguishable.
   */
  installEnforcement(childSessionId: string, ceiling: ForkCeiling): boolean {
    if (!this.records.has(childSessionId)) return false
    this.enforced.set(childSessionId, ceiling)
    return true
  }

  /**
   * Record that one child's guard is gone, so its prompts are refused again.
   * @param childSessionId Child whose guard was disposed.
   */
  releaseEnforcement(childSessionId: string): void {
    this.enforced.delete(childSessionId)
  }

  /**
   * Whether one child's own execution limit is installed.
   * @param childSessionId Child to check.
   * @returns True only while that child has a live guard.
   */
  enforcementInstalled(childSessionId: string): boolean {
    const record = this.records.get(childSessionId)
    return record !== undefined && record.revokedAt === undefined && this.enforced.has(childSessionId)
  }

  /**
   * Record one child session, replacing an identical previous record.
   * @param record Child, its source, its creator, and the boundary it started from.
   * @returns A promise that rejects when the record could not be written.
   */
  async record(record: ForkRecord): Promise<void> {
    // A new child of a share this process withdrew exists after that withdrawal, so it does not inherit
    // it; the dropped marker also lets a later withdrawal of the share name this child.
    if (!this.records.has(record.childSessionId)) this.withdrawnShares.delete(record.shareId)
    this.records.set(record.childSessionId, record)
    this.pendingForks.set(record.childSessionId, record)
    await this.persist()
  }

  /**
   * Find one child session.
   * @param childSessionId Child session to look up.
   * @returns The record, or undefined when this Host never created that child.
   */
  find(childSessionId: string): ForkRecord | undefined {
    return this.records.get(childSessionId)
  }

  /**
   * Children one viewer created, which is what the viewer's own list may show.
   * @param creator Trusted viewer identity the Relay asserted.
   * @returns That viewer's children, newest last.
   */
  listForCreator(creator: ForkCreator): readonly ForkRecord[] {
    return [...this.records.values()].filter(record => sameCreator(record.creator, creator))
  }

  /**
   * Children one share produced, for the source owner's view.
   * @param shareId Source share.
   * @returns Every child of that share, whoever created it.
   */
  listForShare(shareId: string): readonly ForkRecord[] {
    return [...this.records.values()].filter(record => record.shareId === shareId)
  }

  /**
   * Mark every child of one share revoked without deleting it, so history and audit survive.
   * @param shareId Source share that stopped, expired, or lost authorization.
   * @param now ISO time of the revocation.
   * @returns A promise that rejects when the withdrawal could not be written.
   */
  async revokeShare(shareId: string, now: string): Promise<void> {
    let changed = false
    for (const [childSessionId, record] of this.records) {
      if (record.shareId !== shareId || record.revokedAt !== undefined) continue
      const revoked = { ...record, revokedAt: now }
      this.records.set(childSessionId, revoked)
      this.pendingForks.set(childSessionId, revoked)
      changed = true
    }
    // The first withdrawal is written even when this instance knows no child of that share yet: the
    // batch applies it to whatever the file holds, which is where a child another process recorded for
    // that share lives. Repeating it adds nothing once it is recorded.
    // A withdrawal a failed batch still owes is retried by another call; only one already committed
    // and not superseded by a new child is a no-op.
    if (!changed && this.withdrawnShares.has(shareId) && !this.pendingRevocations.has(shareId)) return
    this.withdrawnShares.set(shareId, now)
    this.pendingRevocations.set(shareId, now)
    await this.persist()
  }

  /**
   * Decide whether one child session may run a prompt.
   * @param childSessionId Child session the prompt targets.
   * @param viewer Trusted viewer identity the Relay asserted.
   * @returns Allowed only for that child's creator, with the source live and the ceiling installed.
   */
  allowsPrompt(childSessionId: string, viewer: ForkCreator): ForkPromptDecision {
    const record = this.records.get(childSessionId)
    if (record === undefined) {
      return { ok: false, code: 'fork-unknown-child', message: 'this session is not a fork of a share' }
    }
    if (!sameCreator(record.creator, viewer)) {
      return { ok: false, code: 'fork-viewer-mismatch', message: 'this fork belongs to another viewer' }
    }
    if (record.revokedAt !== undefined) {
      return { ok: false, code: 'fork-source-revoked', message: 'the share this fork came from is no longer active' }
    }
    // This child's own guard, not a host-wide flag: a sibling's successful install must not open this
    // child's prompt.
    if (!this.enforced.has(childSessionId)) {
      return {
        ok: false,
        code: 'fork-ceiling-uninstalled',
        message: 'read-only execution limits are not installed on this host',
      }
    }
    return { ok: true }
  }

  /**
   * Ceiling installed for one child, for the caller that has to apply it.
   * @param childSessionId Child whose ceiling is asked for.
   * @returns That child's ceiling, or undefined while its prompts are refused.
   */
  enforcedCeiling(childSessionId: string): ForkCeiling | undefined {
    return this.enforcementInstalled(childSessionId) ? this.enforced.get(childSessionId) : undefined
  }

  /**
   * Read the registry at construction.
   *
   * A file that cannot be read or understood reads as empty here rather than failing the Host's start;
   * the write path refuses that same file, so nothing replaces content it could not read.
   * @returns The entries the file holds, or nothing.
   */
  private load(): RegistryEntries {
    try {
      return readRegistry(this.file)
    } catch (error) {
      // A corrupt registry is treated as empty: children then read as unknown and are refused.
      void error
      return { forks: [], operations: [] }
    }
  }

  /**
   * Commit every change this process made since the previous batch.
   *
   * Batches run one at a time in call order, so a later change can never be undone by an earlier one.
   * @returns A promise that rejects when the file could not be written, keeping that batch pending for
   * the next change to retry.
   */
  private persist(): Promise<void> {
    const delta: ForkRegistryDelta = {
      forks: new Map(this.pendingForks),
      operations: new Map(this.pendingOperations),
      revocations: new Map(this.pendingRevocations),
    }
    this.pendingForks.clear()
    this.pendingOperations.clear()
    this.pendingRevocations.clear()
    const attempt = this.chain.then(() => this.commit(delta))
    // A failed batch must not stop the ones after it; retain() puts its changes back in the pending maps.
    this.chain = attempt.then(() => undefined, () => undefined)
    return attempt
  }

  /**
   * Apply one batch to the file, holding the cross-process writer lock for the whole cycle.
   *
   * The file is re-read inside the lock and the batch is applied to what it holds, so an entry no batch
   * touched survives whatever another process wrote since this instance last read, and an entry this
   * process changed is written on top of that other write instead of replacing it with an older copy.
   * @param delta - This process's changes.
   * @returns A promise that resolves once the replace has committed.
   */
  private async commit(delta: ForkRegistryDelta): Promise<void> {
    try {
      // The lock is a sibling of the file, so its directory has to exist before it is acquired.
      mkdirSync(dirname(this.file), { recursive: true })
      await withFileLock(this.file, async () => {
        const base = readRegistry(this.file)
        const forks = new Map(base.forks.map(entry => [entry.childSessionId, entry]))
        // A withdrawal names the children that existed when it committed: every entry the file held
        // then, whichever process wrote it. Entries this batch adds are new children created after the
        // withdrawal, so they are merged below, outside this loop, and never inherit its timestamp.
        for (const [shareId, revokedAt] of delta.revocations) {
          for (const [childSessionId, entry] of forks) {
            if (entry.shareId !== shareId || entry.revokedAt !== undefined) continue
            forks.set(childSessionId, { ...entry, revokedAt })
          }
        }
        for (const [childSessionId, entry] of delta.forks) {
          const revokedAt = forks.get(childSessionId)?.revokedAt ?? entry.revokedAt
          forks.set(childSessionId, revokedAt === undefined ? entry : { ...entry, revokedAt })
        }
        const operations = new Map(base.operations.map(entry => [entry.key, entry]))
        for (const [key, entry] of delta.operations) operations.set(key, entry)
        const document: ForkRegistryFile = {
          version: 1,
          forks: [...forks.values()],
          operations: [...operations.values()],
        }
        await writeFileAtomic(this.file, JSON.stringify(document, null, 2), { mode: 0o600 })
      })
    } catch (error) {
      this.retain(delta)
      throw error
    }
  }

  /**
   * Put a batch that failed to commit back among the pending changes, unless a later change already
   * replaced those entries, so the next mutation writes them again instead of dropping them.
   * @param delta - The batch whose commit failed.
   */
  private retain(delta: ForkRegistryDelta): void {
    for (const [childSessionId, entry] of delta.forks) {
      if (this.pendingForks.has(childSessionId) || this.records.get(childSessionId) !== entry) continue
      this.pendingForks.set(childSessionId, entry)
    }
    for (const [key, entry] of delta.operations) {
      if (this.pendingOperations.has(key) || this.operations.get(key) !== entry) continue
      this.pendingOperations.set(key, entry)
    }
    for (const [shareId, revokedAt] of delta.revocations) {
      // Retry a withdrawal that is still this process's current one. A newer withdrawal already
      // replaced the marker, or a new child cleared it, so replaying this batch could withdraw a child
      // it never named.
      if (this.withdrawnShares.get(shareId) === revokedAt) this.pendingRevocations.set(shareId, revokedAt)
    }
  }
}

/**
 * Read one registry document from disk.
 *
 * An absent file is the ordinary state before the first fork and reads as empty. A file that exists but
 * cannot be read or understood throws, because a read-modify-write must not replace content it could
 * not read. A single entry that fails its own validation is dropped while the rest of the document is
 * kept, which is what lets a file an older version wrote stay readable.
 * @param file - Registry file to read.
 * @returns The entries the file holds.
 */
function readRegistry(file: string): RegistryEntries {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { forks: [], operations: [] }
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw notARegistry(file)
  const value = parsed as { readonly version?: unknown; readonly forks?: unknown; readonly operations?: unknown }
  if (value.version !== 1 || !Array.isArray(value.forks)) throw notARegistry(file)
  return {
    forks: value.forks.filter(isForkRecord),
    // Operations are optional: a file written before they existed carries none. An entry that cannot be
    // read at all is dropped, but one that merely predates a field keeps its identity and child — see
    // readForkOperation.
    operations: Array.isArray(value.operations)
      ? value.operations.flatMap((entry) => {
        const operation = readForkOperation(entry)
        return operation === undefined ? [] : [operation]
      })
      : [],
  }
}

/**
 * The failure a rewrite reports instead of discarding a document it cannot understand.
 * @param file - Registry file that failed to parse.
 * @returns The error to throw.
 */
function notARegistry(file: string): Error {
  return new Error(`liveshare: refusing to rewrite ${file}: not a version 1 fork registry document`)
}

function sameCreator(left: ForkCreator, right: ForkCreator): boolean {
  return left.providerId === right.providerId
    && left.tenantId === right.tenantId
    && left.subjectId === right.subjectId
}

function isForkRecord(value: unknown): value is ForkRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.childSessionId === 'string' && record.childSessionId !== ''
    && typeof record.shareId === 'string' && record.shareId !== ''
    && typeof record.sourceSessionId === 'string' && record.sourceSessionId !== ''
    && typeof record.boundary === 'number' && Number.isSafeInteger(record.boundary)
    && isForkCreator(record.creator)
    && typeof record.createdAt === 'string'
    && (record.revokedAt === undefined || typeof record.revokedAt === 'string')
}

/**
 * Read one persisted operation, keeping the identity→child relation older files carry.
 *
 * A record written before readiness existed cannot be confirmed as ready, so it is not discarded: it
 * keeps the child it named — a retry must not create a second one — and reads as unconfirmed, which is
 * what stops an unenforced child from being replayed as a success. Only an entry that cannot identify
 * its request and child at all is dropped.
 * @param value - One entry from the registry file.
 * @returns The operation, or undefined when the entry identifies nothing.
 */
function readForkOperation(value: unknown): ForkOperation | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const operation = value as Record<string, unknown>
  if (typeof operation.key !== 'string' || operation.key === '') return undefined
  // Empty names a reservation: the request is bound to a boundary, and its child does not exist yet.
  if (typeof operation.childSessionId !== 'string') return undefined
  if (typeof operation.boundary !== 'number' || !Number.isSafeInteger(operation.boundary)) return undefined
  return {
    key: operation.key,
    childSessionId: operation.childSessionId,
    boundary: operation.boundary,
    ready: operation.ready === true,
    status: typeof operation.status === 'number' ? operation.status : 0,
    body: operation.body,
  }
}

function isForkCreator(value: unknown): value is ForkCreator {
  if (typeof value !== 'object' || value === null) return false
  const creator = value as Record<string, unknown>
  return typeof creator.providerId === 'string' && creator.providerId !== ''
    && typeof creator.tenantId === 'string'
    && typeof creator.subjectId === 'string' && creator.subjectId !== ''
}
