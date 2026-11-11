/**
 * Owner-scoped persistent PTY registry. Backends own terminal mechanics while
 * this service owns ids, publication, authorization, and awaited cleanup.
 * @module @deepseek-ai/dsh-terminal
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TerminalBackendCleanupError, TerminalError } from './error.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRequest,
  TerminalSessionIdValue,
  TerminalSessionSnapshot,
  TerminalSignal,
  TerminalSignalResult,
  TerminalSpawnRequest,
  TerminalSpawnResult,
} from './types.ts'

export type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
  TerminalSpawnRequest,
  TerminalSpawnResult,
  TerminalWaitReason,
} from './types.ts'
export { TerminalBackendCleanupError, TerminalError, type TerminalErrorCode } from './error.ts'

/** Opaque identity minted by {@link TerminalSessionService} for one live PTY session. */
export type TerminalSessionId = TerminalSessionIdValue

declare module '@deepseek-ai/cordis' {
  interface Context {
    terminals: TerminalSessionService
  }
}

/**
 * Brand one registry-minted string as a {@link TerminalSessionId}.
 * @param value - raw registry-issued id.
 * @returns Same string with the PTY session brand.
 */
export function TerminalSessionId(value: string): TerminalSessionId {
  return value as TerminalSessionId
}

interface SessionRecord {
  readonly id: TerminalSessionId
  readonly owner: Agent
  readonly name: string | undefined
  readonly type: string
  readonly session: TerminalBackendSession
  active: TerminalSendOperation | undefined
  closing: Promise<void> | undefined
}

interface PendingSpawn {
  readonly owner: Agent
  readonly controller: AbortController
  readonly settled: Promise<void>
  cleanupFailure: { error: unknown } | undefined
}

interface SpawnReservation {
  readonly signal: AbortSignal
  release(cleanupFailure: { error: unknown } | undefined): void
}

/** In-process registry for replaceable PTY backends and exact-Agent sessions. */
export class TerminalSessionService extends Service {
  private readonly backends = new Map<string, TerminalBackend>()
  private readonly sessions = new Map<TerminalSessionId, SessionRecord>()
  private readonly reservedNames = new Map<Agent, Set<string>>()
  private readonly pendingSpawns = new Map<Agent, Set<PendingSpawn>>()
  private readonly ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  private readonly disposedOwners = new WeakSet<Agent>()
  private nextId = 0
  private disposing = false

  constructor(ctx: Context) {
    super(ctx, 'terminals')
    ctx.effect(() => () => this.disposeAll(), 'pty teardown')
  }

  /**
   * Register one backend type for this effect scope.
   * @param backend - provider with a non-empty unique type.
   * @returns disposer that removes exactly this contribution.
   */
  registerBackend(backend: TerminalBackend): () => void {
    if (backend.type.length === 0) throw new Error('pty backend type must be non-empty')
    if (this.backends.has(backend.type)) {
      throw new TerminalError(`a PTY backend named "${backend.type}" is already registered`, 'DUPLICATE_BACKEND')
    }
    const dispose = this.ctx.effect(() => {
      this.backends.set(backend.type, backend)
      return () => {
        if (this.backends.get(backend.type) === backend) this.backends.delete(backend.type)
      }
    }, 'pty.registerBackend()')
    return () => void dispose()
  }

  /**
   * List registered backend types in registration order.
   * @returns fresh backend type names.
   */
  listBackends(): string[] {
    return [...this.backends.keys()]
  }

  /**
   * Create and publish one owner-scoped session after backend setup succeeds.
   * @param owner - exact registered Agent that owns access and cleanup.
   * @param request - backend type plus optional owner-local name and cwd.
   * @param signal - cancellation of unpublished setup.
   * @returns published identity, metadata, status, and MOTD.
   */
  async spawn(owner: Agent, request: TerminalSpawnRequest, signal?: AbortSignal): Promise<TerminalSpawnResult> {
    this.assertActive()
    signal?.throwIfAborted()
    this.ensureOwnerCleanup(owner)
    const backend = this.backends.get(request.type)
    if (backend === undefined) throw new TerminalError(`no PTY backend registered for "${request.type}"`, 'NO_BACKEND')
    if (request.name !== undefined && request.name.length === 0) throw new Error('PTY session name must be non-empty')
    const releaseName = this.reserveName(owner, request.name)
    const spawnReservation = this.reserveSpawn(owner)
    const backendSignal = signal === undefined
      ? spawnReservation.signal
      : AbortSignal.any([signal, spawnReservation.signal])
    const sessionId = brandString<TerminalSessionId>(`pty-${++this.nextId}`)
    let session: TerminalBackendSession | undefined
    let cleanupFailure: { error: unknown } | undefined
    try {
      session = await backend.spawn({
        sessionId,
        owner,
        type: request.type,
        ...request.name !== undefined ? { name: request.name } : {},
        ...request.cwd !== undefined ? { cwd: request.cwd } : {},
        signal: backendSignal,
      })
      signal?.throwIfAborted()
      if (this.disposing) {
        throw new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING')
      }
      if (!this.isLiveOwner(owner)) {
        throw new TerminalError('PTY owner is no longer live', 'OWNER_NOT_LIVE')
      }
      const record: SessionRecord = {
        id: sessionId,
        owner,
        name: request.name,
        type: request.type,
        session,
        active: undefined,
        closing: undefined,
      }
      this.sessions.set(sessionId, record)
      return this.snapshot(record, session.motd)
    } catch (error) {
      if (error instanceof TerminalBackendCleanupError) {
        cleanupFailure = { error: error.cleanupError }
      }
      let rollbackFailure: { error: unknown } | undefined
      if (session !== undefined && !this.sessions.has(sessionId)) {
        try {
          await session.close('PTY spawn rolled back')
        } catch (closeError: unknown) {
          rollbackFailure = { error: closeError }
          cleanupFailure = rollbackFailure
        }
      }
      let failure: unknown = error
      try {
        signal?.throwIfAborted()
        spawnReservation.signal.throwIfAborted()
      } catch (cancellation: unknown) {
        failure = cancellation
      }
      if (rollbackFailure !== undefined && signal?.aborted !== true) {
        throw new AggregateError([failure, rollbackFailure.error], 'PTY spawn and rollback both failed')
      }
      throw failure
    } finally {
      spawnReservation.release(cleanupFailure)
      releaseName()
    }
  }

  /**
   * Test whether an exact owner has a published session or unpublished spawn.
   * @param owner - exact live owner to inspect.
   * @returns true across the entire spawn-to-close interval, with no publication gap.
   */
  hasOwnerActivity(owner: Agent): boolean {
    return (this.pendingSpawns.get(owner)?.size ?? 0) > 0
      || [...this.sessions.values()].some(record => record.owner === owner)
  }

  /**
   * Start one exclusive interactive send.
   * @param owner - exact session owner.
   * @param id - target PTY identity.
   * @param request - explicit text, submit behavior, and cancellation.
   * @returns live operation handle for foreground await or task registration.
   */
  startSend(owner: Agent, id: TerminalSessionId, request: TerminalSendRequest): TerminalSendOperation {
    const record = this.expectOwned(owner, id)
    if (record.closing !== undefined) throw new TerminalError(`PTY session ${id} is closing`, 'SESSION_CLOSING')
    if (record.active !== undefined) throw new TerminalError(`PTY session ${id} already has an active send`, 'SEND_ACTIVE')
    const operation = record.session.startSend(request)
    record.active = operation
    void operation.done.then(
      () => { record.active = undefined },
      () => { record.active = undefined },
    )
    return operation
  }

  /**
   * Read one bounded scrollback page from an owned session.
   * @param owner - exact session owner.
   * @param id - target PTY identity.
   * @param request - optional newest-relative offset and line count.
   * @returns bounded retained text and pagination metadata.
   */
  read(owner: Agent, id: TerminalSessionId, request: TerminalReadRequest = {}): TerminalReadResult {
    return this.expectOwned(owner, id).session.read(request)
  }

  /**
   * Deliver an allowed signal through an owned backend session.
   * @param owner - exact session owner.
   * @param id - target PTY identity.
   * @param signal - allowed POSIX signal name.
   * @returns delivered foreground process-group identity.
   */
  signal(owner: Agent, id: TerminalSessionId, signal: TerminalSignal): Promise<TerminalSignalResult> {
    return this.expectOwned(owner, id).session.signal(signal)
  }

  /**
   * Close one owned session and remove it only after quiescent backend cleanup.
   * @param owner - exact session owner.
   * @param id - target PTY identity.
   * @param reason - diagnostic cleanup reason.
   * @returns true for a newly closed session, false when the same close is already in flight.
   */
  async kill(owner: Agent, id: TerminalSessionId, reason: string = 'model request'): Promise<boolean> {
    const record = this.expectOwned(owner, id)
    if (record.closing !== undefined) {
      await record.closing
      return false
    }
    const closing = record.session.close(reason)
    record.closing = closing
    try {
      await closing
      this.sessions.delete(id)
      return true
    } catch (error) {
      record.closing = undefined
      throw error
    }
  }

  /**
   * List fresh snapshots for exactly one owner.
   * @param owner - exact owner whose sessions are visible.
   * @returns owner-visible snapshots in publication order.
   */
  list(owner: Agent): TerminalSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter(record => record.owner === owner)
      .map(record => this.snapshot(record))
  }

  private assertActive(): void {
    if (this.disposing) throw new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING')
  }

  private isLiveOwner(owner: Agent): boolean {
    return !this.disposedOwners.has(owner) && this.ctx.get('agents')?.get(owner.id) === owner
  }

  private ensureOwnerCleanup(owner: Agent): void {
    if (!this.isLiveOwner(owner)) {
      throw new TerminalError(`agent "${owner.id}" is not the registered PTY owner`, 'OWNER_NOT_LIVE')
    }
    if (this.ownerCleanups.has(owner)) return
    const detach = owner.ctx.effect(() => async () => {
      this.disposedOwners.add(owner)
      this.ownerCleanups.delete(owner)
      await this.disposeOwned(owner)
    }, 'pty.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  private reserveName(owner: Agent, name: string | undefined): () => void {
    if (name === undefined) return () => {}
    if ([...this.sessions.values()].some(record => record.owner === owner && record.name === name)) {
      throw new TerminalError(`PTY session name "${name}" already exists for this owner`, 'DUPLICATE_NAME')
    }
    const reserved = this.reservedNames.get(owner) ?? new Set<string>()
    if (reserved.has(name)) throw new TerminalError(`PTY session name "${name}" is already being created`, 'DUPLICATE_NAME')
    reserved.add(name)
    this.reservedNames.set(owner, reserved)
    return () => {
      reserved.delete(name)
      if (reserved.size === 0) this.reservedNames.delete(owner)
    }
  }

  private reserveSpawn(owner: Agent): SpawnReservation {
    const controller = new AbortController()
    const settlement = Promise.withResolvers<void>()
    const pending: PendingSpawn = { owner, controller, settled: settlement.promise, cleanupFailure: undefined }
    const owned = this.pendingSpawns.get(owner) ?? new Set<PendingSpawn>()
    owned.add(pending)
    this.pendingSpawns.set(owner, owned)
    return {
      signal: controller.signal,
      release: (cleanupFailure) => {
        pending.cleanupFailure = cleanupFailure
        if (cleanupFailure === undefined) this.removePendingSpawn(pending)
        settlement.resolve()
      },
    }
  }

  private removePendingSpawn(pending: PendingSpawn): void {
    const owned = this.pendingSpawns.get(pending.owner)
    if (owned === undefined) return
    owned.delete(pending)
    if (owned.size === 0) this.pendingSpawns.delete(pending.owner)
  }

  private async abortPendingSpawns(owner: Agent | undefined, reason: TerminalError): Promise<void> {
    const pending = owner === undefined
      ? [...this.pendingSpawns.values()].flatMap(owned => [...owned])
      : [...(this.pendingSpawns.get(owner) ?? [])]
    for (const spawn of pending) spawn.controller.abort(reason)
    await Promise.all(pending.map(spawn => spawn.settled))
    const failures = pending.flatMap(spawn => spawn.cleanupFailure === undefined ? [] : [spawn.cleanupFailure.error])
    for (const spawn of pending) this.removePendingSpawn(spawn)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to roll back unpublished PTY setup')
    }
  }

  private expectOwned(owner: Agent, id: TerminalSessionId): SessionRecord {
    const record = this.sessions.get(id)
    if (record === undefined) throw new TerminalError(`unknown PTY session ${id}`, 'NO_SESSION')
    if (record.owner !== owner) throw new TerminalError(`PTY session ${id} belongs to another agent`, 'FOREIGN_SESSION')
    return record
  }

  private snapshot(record: SessionRecord): TerminalSessionSnapshot
  private snapshot(record: SessionRecord, motd: string): TerminalSpawnResult
  private snapshot(record: SessionRecord, motd?: string): TerminalSpawnResult | TerminalSessionSnapshot {
    return {
      sessionId: record.id,
      ...record.name !== undefined ? { name: record.name } : {},
      type: record.type,
      ...record.session.pid !== undefined ? { pid: record.session.pid } : {},
      status: record.session.status(),
      ...motd !== undefined ? { motd } : {},
    }
  }

  private async abortAndClose(owner: Agent | undefined, abortReason: TerminalError, closeReason: string): Promise<void> {
    const failures: unknown[] = []
    try {
      await this.abortPendingSpawns(owner, abortReason)
    } catch (error: unknown) {
      failures.push(error)
    }
    const records = [...this.sessions.values()].filter(record => owner === undefined || record.owner === owner)
    try {
      await this.closeRecords(records, closeReason)
    } catch (error: unknown) {
      failures.push(error)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'failed to clean up PTY lifecycle')
  }

  private async disposeOwned(owner: Agent): Promise<void> {
    try {
      await this.abortAndClose(
        owner,
        new TerminalError('PTY owner is no longer live', 'OWNER_NOT_LIVE'),
        'PTY owner disposed',
      )
    } finally {
      this.reservedNames.delete(owner)
    }
  }

  private async disposeAll(): Promise<void> {
    this.disposing = true
    // Teardown is best-effort: a close failure still clears registries and runs
    // owner cleanups before the aggregated error propagates, so one stuck
    // session cannot orphan backends, reservations, or owner detachers.
    try {
      await this.abortAndClose(
        undefined,
        new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING'),
        'PTY service disposed',
      )
    } finally {
      this.backends.clear()
      this.reservedNames.clear()
      this.pendingSpawns.clear()
      const cleanups = [...this.ownerCleanups.values()]
      this.ownerCleanups.clear()
      await Promise.all(cleanups.map(cleanup => Promise.resolve(cleanup())))
    }
  }

  private async closeRecords(records: SessionRecord[], reason: string): Promise<void> {
    const results = await Promise.allSettled(records.map(async (record) => {
      const closing = record.closing ?? record.session.close(reason)
      record.closing = closing
      try {
        await closing
        this.sessions.delete(record.id)
      } catch (error: unknown) {
        // A concurrent retry may already own a newer fence; never clear it.
        if (record.closing === closing) record.closing = undefined
        throw error
      }
    }))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map<unknown>(result => result.reason as unknown)
    if (failures.length > 0) throw new AggregateError(failures, `failed to close ${failures.length} PTY session(s)`)
  }
}

export default TerminalSessionService
