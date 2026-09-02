/**
 * Service Definition and drive registry for the session-projection capability seam: the merge-extensible state and client-view type
 * tables, the `ProjectionDefinition` state-driven computation unit contract,
 * and the `ctx.sessionProjections` registry that DRIVES every registered unit
 * forward eagerly over committed session events. Domain host plugins
 * contribute pure folds and optional client views; the framework owns the
 * subscription, the per-session watermark cache, and change notification;
 * carriers consume the snapshot read face and the change feed. Neither side
 * knows the other
 * (capability-seam three-way split). Design authority: the session-projection
 * RFC (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 *
 * Whole-value event rule (load-bearing): a state-carrying log event MUST
 * carry the complete post-change state, never a bare delta — it keeps every
 * unit's transition trivially cheap and every served value self-describing.
 *
 * @module @deepseek-ai/dsh-session-projection
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ZodType } from 'zod'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjections: SessionProjectionRegistry
  }
}

import type { SessionProjectionMap, SessionProjectionStateMap } from './types.ts'

export type { SessionProjectionMap, SessionProjectionStateMap } from './types.ts'

/**
 * One domain's state-driven computation unit: a pure synchronous fold plus
 * declarations and an optional client view — never an opaque getter. The framework drives
 * `apply` on every committed session event; the domain holds no
 * subscriptions and owns only the computation. All functions MUST be
 * synchronous (an async unit would tear the carriers' consistency cut), and
 * `state` MUST be plain JSON (the persisted-cache precondition).
 */
export interface ProjectionDefinition<
  K extends keyof SessionProjectionStateMap,
  S extends SessionProjectionStateMap[K] = SessionProjectionStateMap[K],
> {
  /** The projection key this unit owns (its `SessionProjectionStateMap` entry). */
  key: K
  /** Validates persisted state before it seeds a fold. */
  stateSchema: ZodType<S>
  /**
   * State for the empty log and its immutable Session metadata.
   * @param header - immutable metadata for the Session being projected.
   * @param inheritedEventCount - exact fork-inherited prefix length.
   * @returns the initial state.
   */
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): NoInfer<S>
  /**
   * Pure transition: previous state + one committed event → next state. A
   * unit uninterested in an event MUST return the same state reference — an
   * unchanged reference (`Object.is`) produces zero downstream work.
   * @param state - the state covering all prior events.
   * @param event - the next committed session event.
   * @returns the next state (same reference when the event is not the unit's).
   */
  apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>
  /** Client view. Omit for host-only units. */
  wire?: K extends keyof SessionProjectionMap ? {
    /** Validates the wire payload before it leaves the host. */
    viewSchema: ZodType<SessionProjectionMap[K]>
    /**
     * State → wire payload (the read-side projection). The live drive keeps
     * the two latest raw results and compares them with `Object.is`; an
     * object-valued view must reuse its reference to suppress publication
     * across internal-only state changes.
     * @param state - the current state.
     * @returns the whole current value for this unit's key.
     */
    view(state: NoInfer<S>): SessionProjectionMap[K]
  } : never
  /**
   * Persisted-cache invalidation version: bump whenever the serialized state fields or the
   * fold semantics change, so persisted `(sessionId, key, ver, seq, val)`
   * rows from an older unit are discarded instead of being forward-applied
   * into garbage. Non-negative integer.
   */
  stateVersion: number
}

/**
 * Change-feed listener: one unit's raw `view` result changed by `Object.is`
 * for one session. `value` is the schema-validated output; `seq` is the
 * unit's watermark at emission (the seq of the event that caused the change).
 */
export type ProjectionChangeListener = (
  session: Session,
  key: Extract<keyof SessionProjectionMap, string>,
  value: unknown,
  seq: SessionSeq,
) => void

/**
 * One consistent read cut over every registered client-visible unit for one session.
 * `asOfSeq` is the shared watermark — the seq of the last event every value
 * reflects (`-1` for an empty log).
 */
export interface ProjectionSnapshot {
  /** Seq of the last event the values reflect; -1 for an empty log. */
  asOfSeq: SessionSeqCursor
  /** Whole current client value per registered key. */
  values: Partial<SessionProjectionMap>
}

/**
 * One unit's checkpoint: its internal state (plain JSON by the unit
 * contract), the seq of the last event folded into it, and the unit
 * `stateVersion` that produced it — the persisted projection-cache row
 * `(sessionId, key, ver, seq, val)` minus the two outer keys. A row is
 * never authoritative, only a fold shortcut: `restore` discards it on a
 * version mismatch or when it claims events past the stored log end.
 */
export interface ProjectionCheckpointRow {
  /** The registering unit's `stateVersion` at fold time. */
  ver: number
  /** Seq of the last event folded into `val`; -1 for the empty log. */
  seq: SessionSeqCursor
  /** The unit's internal state — plain JSON per the unit contract. */
  val: unknown
}

/** Checkpoint rows keyed by projection key (one session's persisted cache value). */
export type ProjectionCheckpoint = Record<string, ProjectionCheckpointRow>

/** Type-erased unit view the drive machinery works with (the registration contract already proved the typed form). */
interface ErasedDefinition {
  key: string
  stateSchema: { parse(value: unknown): unknown }
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): unknown
  apply(state: unknown, event: SessionEvent): unknown
  wire: { viewSchema: { parse(value: unknown): unknown }; view(state: unknown): unknown } | undefined
  stateVersion: number
}

/** Per-session per-unit watermark and fixed live-drive view buffer. */
interface UnitCell {
  state: unknown
  /** Seq of the last event passed through `apply` (regardless of change). */
  observedSeq: SessionSeqCursor
  /** `[previousView, currentView]`; undefined slots mean no cached comparison. */
  readonly views: [unknown, unknown]
}

/**
 * One live registration: the unit plus its per-session cells (dropped whole
 * once the last registrant releases it).
 *
 * `refs` exists because one unit definition already serves every session — the
 * cells are keyed by `Session` — while registrants are per-session:
 * an agent preset mounts the same tool package once per agent, so N sessions
 * on one preset register the same key N times. Without a count the first
 * registrant would own the disposer, and its session ending would strip the
 * projection from every other live session.
 */
interface Registration {
  readonly def: ErasedDefinition
  readonly cells: WeakMap<Session, UnitCell>
  /** Live registrants sharing this unit; the last one out removes the key. */
  refs: number
}

/** Convert a log offset to the inclusive cursor immediately before it. */
function cursorBefore(offset: SessionLogOffset): SessionSeqCursor {
  return offset === 0 ? -1 : SessionSeq(offset - 1)
}

/**
 * `ctx.sessionProjections`: the projection unit table and its drive. The
 * service subscribes to `session/event` once; every committed event passes
 * every registered unit's `apply` (eager drive). A changed state reference
 * computes the next client view; the change feed is notified only when its
 * raw result changes by `Object.is`.
 * Cells build lazily — a unit registered after events flowed, or a session
 * older than the registry, folds `init` over the in-memory log on first
 * touch (event or read). Registration is an effect (disposer rides the
 * calling fiber): an unloaded domain plugin's key disappears from snapshots
 * and clients read it as capability absence. A host reader either declares
 * `sessionProjections` in its plugin `inject` or fails explicitly when the
 * registry or required key is absent. Contributors may preserve optional
 * registration through `ctx.inject(['sessionProjections'], ...)`. Registrants sharing a key
 * share one unit and are counted: the same tool package mounted in N agent
 * presets registers N times, and the key survives until the last one
 * unloads.
 */
export class SessionProjectionRegistry extends Service {
  private readonly registrations = new Map<string, Registration>()
  private readonly listeners = new Set<ProjectionChangeListener>()

  /**
   * Create and install the registry as `ctx.sessionProjections`.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionProjections')
    ctx.on('session/created', (session: Session) => {
      if (session.seq !== 0) return
      for (const registration of this.registrations.values()) {
        if (registration.cells.has(session)) continue
        registration.cells.set(session, {
          state: registration.def.init(session.header, session.inheritedEventCount),
          observedSeq: -1,
          views: [undefined, undefined],
        })
      }
    })
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.drive(session, event)
    })
  }

  /**
   * Register one domain's unit. The registration is an effect on the calling
   * context's fiber: disposing the fiber (or calling the returned disposer)
   * removes the key — and the unit's cached cells — from subsequent drives
   * and snapshots.
   * @param definition - key, state schema, pure unit functions, and stateVersion.
   * @returns the exact disposer that unregisters this unit.
   */
  register<
    K extends keyof SessionProjectionMap,
    S extends SessionProjectionStateMap[K],
  >(
    definition: Omit<ProjectionDefinition<K, S>, 'wire'> & {
      wire: NonNullable<ProjectionDefinition<K, S>['wire']>
    },
  ): () => void
  /**
   * Register one host-only unit. Its state is omitted from client snapshots
   * and always checkpointed like every other unit.
   * @param definition - key, state schema, pure unit functions, and stateVersion.
   * @returns the exact disposer that unregisters this unit.
   */
  register<
    K extends Exclude<keyof SessionProjectionStateMap, keyof SessionProjectionMap>,
    S extends SessionProjectionStateMap[K],
  >(
    definition: Omit<ProjectionDefinition<K, S>, 'wire'>,
  ): () => void
  register<K extends keyof SessionProjectionStateMap, S extends SessionProjectionStateMap[K]>(
    definition: ProjectionDefinition<K, S>,
  ): () => void {
    const wire = definition.wire as {
      viewSchema: ZodType
      view(state: S): unknown
    } | undefined
    const erased: ErasedDefinition = {
      key: definition.key,
      stateSchema: definition.stateSchema,
      init: (header, inheritedEventCount) => definition.init(header, inheritedEventCount),
      apply: (state, event) => definition.apply(state as S, event),
      wire: wire === undefined
        ? undefined
        : { viewSchema: wire.viewSchema, view: state => wire.view(state as S) },
      stateVersion: definition.stateVersion,
    }
    if (!Number.isSafeInteger(definition.stateVersion) || definition.stateVersion < 0) {
      throw new Error(`session projection ${JSON.stringify(definition.key)} stateVersion must be a non-negative integer, got ${String(definition.stateVersion)}`)
    }
    const dispose = this.ctx.effect(function* (this: SessionProjectionRegistry) {
      const key = erased.key
      const existing = this.registrations.get(key)
      if (existing === undefined) {
        this.registrations.set(key, { def: erased, cells: new WeakMap(), refs: 1 })
      } else {
        if (existing.def.stateVersion !== erased.stateVersion) {
          throw new Error(`session projection key ${JSON.stringify(key)} is already registered at stateVersion ${String(existing.def.stateVersion)}; refusing to share it with stateVersion ${String(erased.stateVersion)}`)
        }
        existing.refs += 1
      }
      yield () => {
        const live = this.registrations.get(key)
        /* v8 ignore next -- the disposer runs once per successful registration, so the entry it counted is still here */
        if (live === undefined) return
        live.refs -= 1
        if (live.refs === 0) this.registrations.delete(key)
      }
    }.bind(this), 'sessionProjections.register()')
    return () => void dispose()
  }

  /**
   * Subscribe to the change feed. The registration is an effect on the
   * calling context's fiber.
   * @param listener - called once per client-visible unit whose raw view changed by `Object.is`, per committed event.
   * @returns the exact disposer that unsubscribes.
   */
  onChanged(listener: ProjectionChangeListener): () => void {
    const dispose = this.ctx.effect(() => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }, 'sessionProjections.onChanged()')
    return () => void dispose()
  }

  /**
   * Read one unit's current host state after materializing every registered
   * unit at the Session cursor. Unrelated wire views are not produced.
   * The returned value is live; callers must not mutate it.
   * @param session - the session whose state is read.
   * @param key - the registered unit key.
   * @returns current state, or `undefined` when the key is not registered.
   */
  stateOf<K extends keyof SessionProjectionStateMap>(
    session: Session,
    key: K,
  ): SessionProjectionStateMap[K] | undefined {
    const registration = this.registrations.get(key)
    if (registration === undefined) return undefined
    this.materializeCells(session)
    return this.cellFor(registration, session).state as SessionProjectionStateMap[K]
  }

  /**
   * One consistent cut over every registered client-visible unit for one session, read from
   * the watermark cache (missing cells fold lazily over the in-memory log).
   * Fully synchronous — every value and `asOfSeq` reflect the same log
   * position. Each value passes its unit's `viewSchema` before leaving.
   * @param session - the session whose projection values are read.
   * @param keys - optional client-visible outputs; state materialization remains complete.
   * @returns the snapshot; `values` is empty when no selected client-visible unit is registered.
   */
  snapshot(
    session: Session,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot {
    const values: Record<string, unknown> = {}
    const selected = keys === undefined ? undefined : new Set<string>(keys)
    this.materializeCells(session)
    for (const registration of this.registrations.values()) {
      if (registration.def.wire === undefined) continue
      if (selected !== undefined && !selected.has(registration.def.key)) continue
      const cell = this.cellFor(registration, session)
      values[registration.def.key] = this.viewCell(registration, cell)
    }
    return { asOfSeq: cursorBefore(session.seq), values }
  }

  /**
   * Read only already-materialized client-visible cells without folding history.
   * Values may trail the live Session and are therefore hints, not a complete
   * baseline. Missing cells are omitted.
   * @param session - attached Session whose cached cells are inspected.
   * @param keys - optional wire keys to view.
   * @returns the lowest common cached cut, or `undefined` when no wire cell exists.
   */
  cachedSnapshot(
    session: Session,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const values: Record<string, unknown> = {}
    let asOfSeq: SessionSeqCursor | undefined
    const selected = keys === undefined ? undefined : new Set<string>(keys)
    for (const registration of this.registrations.values()) {
      if (registration.def.wire === undefined) continue
      if (selected !== undefined && !selected.has(registration.def.key)) continue
      const cell = registration.cells.get(session)
      if (cell === undefined) continue
      values[registration.def.key] = this.viewCell(registration, cell)
      if (asOfSeq === undefined || cell.observedSeq < asOfSeq) {
        asOfSeq = cell.observedSeq
      }
    }
    return asOfSeq === undefined ? undefined : { asOfSeq, values }
  }

  /**
   * State-level checkpoint of every persisted unit for one session, read
   * from the watermark cache (missing cells fold lazily over the in-memory
   * log). This is the write side of the persisted projection cache: the
   * returned rows are the `(key → {ver, seq, val})` part of the durable
   * `(sessionId, key, ver, seq, val)`
   * rows. Every `val` is a DETACHED structured clone — never the live
   * cell reference: the watermark cache is this registry's authoritative
   * mutable state, and a caller reaching the live reference could corrupt
   * every subsequent snapshot and frame through it (plain JSON by the unit
   * contract, so the clone is total).
   * @param session - the session whose unit states are checkpointed.
   * @returns one row per registered key.
   */
  checkpoint(session: Session): ProjectionCheckpoint {
    const rows: ProjectionCheckpoint = {}
    for (const registration of this.registrations.values()) {
      const cell = this.cellFor(registration, session)
      rows[registration.def.key] = {
        ver: registration.def.stateVersion,
        seq: cell.observedSeq,
        val: structuredClone(cell.state),
      }
    }
    return rows
  }

  /**
   * The stored seq a {@link restore} tail read over `checkpoint` must start
   * at: one event BELOW the lowest usable watermark (a row is usable when
   * its `ver` matches the live unit's `stateVersion`; an absent or mismatched row
   * pulls the floor to `0` — that key must refold the full log). The
   * one-below anchor is load-bearing: the tail then proves how far the
   * stored log still extends, so {@link restore} can detect a log that
   * shrank below a row's watermark (crash-repair truncation) instead of
   * serving the stale row as current — an empty tail read from the anchor
   * yields an end below every watermark and the restore rejects for a full
   * re-read.
   * @param checkpoint - persisted rows for one session (possibly stale or empty).
   * @returns the offset for the stored-log suffix read (`SessionHandle.read`),
   *   or `undefined` when no unit is registered (no read needed —
   *   {@link restore} would serve empty values regardless).
   */
  restoreFloor(checkpoint: ProjectionCheckpoint): SessionLogOffset | undefined {
    let floor: number | undefined
    for (const registration of this.registrations.values()) {
      const row = checkpoint[registration.def.key]
      const need = row !== undefined && row.ver === registration.def.stateVersion
        ? Math.max(row.seq + 1, 0)
        : 0
      floor = floor === undefined ? need : Math.min(floor, need)
    }
    return floor === undefined ? undefined : SessionLogOffset(Math.max(floor - 1, 0))
  }

  /**
   * View a checkpoint's rows without any log read: for every registered
   * client-visible unit whose row's `ver` matches, serve the schema-validated
   * `view` of the schema-validated stored state; mismatched, malformed, or absent rows leave their key
   * absent (a cold or listing consumer treats it as not-yet-available and a
   * fuller read path refolds it). The zero-I/O rung of the read ladder —
   * values are as stale as their rows, never wrong.
   * @param checkpoint - persisted rows for one session (possibly stale or empty).
   * @param keys - optional wire keys to view.
   * @returns whole values per key with a usable row; empty when none.
   */
  viewCheckpoint(
    checkpoint: ProjectionCheckpoint,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): Partial<SessionProjectionMap> {
    const values: Record<string, unknown> = {}
    const selected = keys === undefined ? undefined : new Set<string>(keys)
    for (const registration of this.registrations.values()) {
      const def = registration.def
      if (def.wire === undefined) continue
      if (selected !== undefined && !selected.has(def.key)) continue
      const row = checkpoint[def.key]
      if (row === undefined || row.ver !== def.stateVersion) continue
      let state: unknown
      try {
        state = def.stateSchema.parse(row.val)
      } catch {
        continue
      }
      values[def.key] = def.wire.viewSchema.parse(def.wire.view(state))
    }
    return values
  }

  /**
   * Cold read: fold every persisted unit over a stored log suffix, seeding
   * each from its checkpoint row when usable — the one read recipe (cached
   * state + forward tail replay + `view`) applied without a live `Session`.
   * Call with the stored events at or past `restoreFloor(checkpoint)` (a
   * `SessionHandle.read` slice) and that same floor as
   * `baseSeq`; the floor's one-below anchor makes the supplied end honest,
   * so a shrunk log is detected here. A row is usable iff its
   * `ver` matches the live unit's `stateVersion`, it does not predate `baseSeq`
   * (`seq >= baseSeq - 1`), and it does not claim events past the
   * supplied end (`seq <= endSeq`); an unusable row is discarded
   * and its key refolds from `init` — which is only sound over the full
   * log, so a discarded row with `baseSeq > 0` throws (the caller re-reads
   * from seq 0, e.g. after a crash-repair truncation shrank the log below
   * a row's watermark).
   * @param checkpoint - persisted rows for one session (possibly stale or empty).
   * @param events - the stored events with `seq >= baseSeq`, in seq order.
   * @param baseSeq - the seq `events` starts at (its first event's seq when non-empty).
   * @param header - immutable metadata for the Session being restored.
   * @param inheritedEventCount - exact fork-inherited prefix length supplied to unit initialization.
   * @returns the snapshot cut at the supplied log end (`asOfSeq` is the last
   *   supplied event's seq, `baseSeq - 1` for an empty tail) plus the
   *   refreshed checkpoint rows at that cut, ready for a durable write-back.
   */
  restore(
    checkpoint: ProjectionCheckpoint,
    events: readonly SessionEvent[],
    baseSeq: SessionLogOffset,
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
  ):
  { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint } {
    const endSeq: SessionSeqCursor = events.at(-1)?.seq ?? cursorBefore(baseSeq)
    const beforeBase = cursorBefore(baseSeq)
    const values: Record<string, unknown> = {}
    const refreshed: ProjectionCheckpoint = {}
    for (const registration of this.registrations.values()) {
      const def = registration.def
      const row = checkpoint[def.key]
      const usable = row !== undefined
        && row.ver === def.stateVersion
        && row.seq >= beforeBase
        && row.seq <= endSeq
      if (!usable && baseSeq > 0) {
        throw new Error(
          `session projection ${JSON.stringify(def.key)} cannot restore from seq ${baseSeq}: `
          + 'its checkpoint row is missing, version-mismatched, or beyond the supplied log end; re-read from seq 0',
        )
      }
      let state = usable
        ? def.stateSchema.parse(row.val)
        : def.init(header, inheritedEventCount)
      const from = usable ? row.seq : beforeBase
      const startIndex = from - baseSeq + 1
      for (let index = startIndex; index < events.length; index++) {
        const event = events[index]
        const expectedSeq = SessionSeq(baseSeq + index)
        if (event === undefined || event.seq !== expectedSeq) {
          throw new Error(`session projection ${JSON.stringify(def.key)} cannot restore across missing seq ${String(expectedSeq)}`)
        }
        state = def.apply(state, event)
      }
      if (def.wire !== undefined) values[def.key] = def.wire.viewSchema.parse(def.wire.view(state))
      refreshed[def.key] = { ver: def.stateVersion, seq: endSeq, val: state }
    }
    return {
      snapshot: { asOfSeq: endSeq, values: values },
      checkpoint: refreshed,
    }
  }

  /**
   * Restore an exact cut and install its states on the supplied prepared Session.
   * A later publication reuses these cells; ordinary live reads and event drive
   * advance any constructor-owned suffix exactly once.
   * @param session - exact prepared Session that owns the restored log prefix.
   * @param checkpoint - persisted rows for this Session lifecycle.
   * @param events - exact events at the observation cut.
   * @param baseSeq - first supplied event sequence.
   * @returns all projection values at the supplied cut.
   */
  hydrate(
    session: Session,
    checkpoint: ProjectionCheckpoint,
    events: readonly SessionEvent[],
    baseSeq: SessionLogOffset,
  ): ProjectionSnapshot {
    const endSeq: SessionSeqCursor = events.at(-1)?.seq ?? cursorBefore(baseSeq)
    let complete = true
    for (const registration of this.registrations.values()) {
      const current = registration.cells.get(session)
      if (current?.observedSeq !== endSeq) {
        complete = false
        break
      }
    }
    if (complete) {
      const values: Record<string, unknown> = {}
      for (const registration of this.registrations.values()) {
        if (registration.def.wire === undefined) continue
        const current = registration.cells.get(session) as UnitCell
        values[registration.def.key] = this.viewCell(registration, current)
      }
      return { asOfSeq: endSeq, values }
    }
    const restored = this.restore(
      checkpoint,
      events,
      baseSeq,
      session.header,
      session.inheritedEventCount,
    )
    for (const registration of this.registrations.values()) {
      const row = restored.checkpoint[registration.def.key]
      if (row === undefined) continue
      const current = registration.cells.get(session)
      if (current !== undefined && current.observedSeq > row.seq) continue
      registration.cells.set(session, {
        state: row.val,
        observedSeq: row.seq,
        views: [undefined, undefined],
      })
    }
    return restored.snapshot
  }

  /** Materialize every registered unit cell at the Session's current cursor. */
  private materializeCells(session: Session): void {
    for (const registration of this.registrations.values()) this.cellFor(registration, session)
  }

  /** Fold one unit from init over `events`, producing a cell watermarked at the last folded event. */
  private buildCell(
    def: ErasedDefinition,
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
  ): UnitCell {
    let state = def.init(header, inheritedEventCount)
    for (const event of events) state = def.apply(state, event)
    return { state, observedSeq: (events.at(-1)?.seq ?? -1), views: [undefined, undefined] }
  }

  /** Read (or lazily build, folding the full in-memory log) one unit's cell. */
  private cellFor(registration: Registration, session: Session): UnitCell {
    let cell = registration.cells.get(session)
    if (cell === undefined) {
      cell = this.buildCell(
        registration.def,
        session.header,
        session.inheritedEventCount,
        session.snapshotEvents(),
      )
      registration.cells.set(session, cell)
    } else {
      this.advanceCell(registration.def, cell, session, cursorBefore(session.seq))
    }
    return cell
  }

  /** Advance one existing cell through a contiguous Session prefix. */
  private advanceCell(
    def: ErasedDefinition,
    cell: UnitCell,
    session: Session,
    throughSeq: SessionSeqCursor,
  ): void {
    if (cell.observedSeq >= throughSeq) return
    for (let seq = cell.observedSeq + 1; seq <= throughSeq; seq++) {
      const event = session.eventAt(SessionSeq(seq))
      if (event === undefined || event.seq !== seq) {
        throw new Error(`session projection ${JSON.stringify(def.key)} cannot advance across missing seq ${String(seq)}`)
      }
      const next = def.apply(cell.state, event)
      if (!Object.is(next, cell.state)) {
        cell.views[0] = cell.views[1]
        cell.views[1] = undefined
      }
      cell.state = next
      cell.observedSeq = SessionSeq(seq)
    }
  }

  /** Eager drive: pass one committed event through every unit; notify on changed raw view references. */
  private drive(session: Session, event: SessionEvent): void {
    for (const registration of this.registrations.values()) {
      let cell = registration.cells.get(session)
      if (cell !== undefined && cell.observedSeq >= event.seq) continue
      if (cell === undefined) {
        // Late build mid-stream: fold history before this event (seq = log
        // index, so the prefix slice is exact), then take the normal gate.
        cell = this.buildCell(
          registration.def,
          session.header,
          session.inheritedEventCount,
          session.snapshotEvents(SessionLogOffset(0), SessionLogOffset(event.seq)),
        )
        registration.cells.set(session, cell)
      } else {
        this.advanceCell(
          registration.def,
          cell,
          session,
          event.seq === 0 ? -1 : SessionSeq(event.seq - 1),
        )
      }
      const previousState = cell.state
      const next = registration.def.apply(previousState, event)
      const changed = !Object.is(next, previousState)
      cell.state = next
      cell.observedSeq = event.seq
      const wire = registration.def.wire
      if (changed && wire !== undefined) {
        const views = cell.views
        views[0] = views[1]
        if (this.listeners.size > 0) {
          views[1] = wire.view(next)
          if (!Object.is(views[0], views[1])) {
            const value = wire.viewSchema.parse(views[1])
            for (const listener of this.listeners) {
              listener(session, registration.def.key as Extract<keyof SessionProjectionMap, string>, value, event.seq)
            }
          }
        } else {
          views[1] = undefined
        }
      }
      // An unchanged state keeps its current view as the valid comparison
      // value for the next state change.
    }
  }

  /** Return one schema-validated wire value. */
  private viewCell(registration: Registration, cell: UnitCell): unknown {
    const wire = registration.def.wire
    if (wire === undefined) throw new Error(`session projection ${JSON.stringify(registration.def.key)} has no wire view`)
    return wire.viewSchema.parse(wire.view(cell.state))
  }
}

export default SessionProjectionRegistry
