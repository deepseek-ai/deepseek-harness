/**
 * Shared buffering, serialization, adoption, repair, and disposal orchestration
 * for first-party backends. Third-party backends may implement the public
 * persistence seam directly.
 * @module @deepseek-ai/dsh-session-persistence/coordinator
 */

import { Context } from '@deepseek-ai/cordis'
import {
  adoptSessionEvent,
  interruptedTurnClosers,
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  SessionPreparation,
  snapshotSessionEvent,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { BorrowedSessionSource, SessionInspection, SessionLocation } from './index.ts'
import { SessionPersistenceNotFoundError } from './errors.ts'
import type { SessionPersistenceRevision } from './revision.ts'
import { observeQueuedAbort, SessionPreparations } from './preparations.ts'
import type { SessionPreparationReservation } from './preparations.ts'
import { SessionWriteBehind } from './write-behind.ts'

/** Default number of detached session preparations retained by a coordinator. */
export const DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5

/** Default maximum intentional wait before a live session batch starts writing. */
export const DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200

/** Largest write batching delay accepted by Node's timer implementation. */
export const MAX_WRITE_BATCH_DELAY_MS = MAX_TIMER_DELAY_MS

/** Durable session contents failed validation after a successful backend read. */
export class SessionPersistenceCorruptionError extends Error {
  /**
   * @param message - stable corruption context.
   * @param options - original validation failure.
   */
  constructor(message: string, options: ErrorOptions) {
    super(message, options)
    this.name = 'SessionPersistenceCorruptionError'
  }
}

/**
 * The stored log is intact but this runtime cannot faithfully interpret it:
 * the header carries an unsupported format version, or an event's type is
 * unknown to this build and the event is not marked ignorable. Distinct from
 * {@link SessionPersistenceCorruptionError} — nothing is damaged; the raw log
 * remains readable at {@link location} when the backend keeps one artifact
 * per session.
 */
export class SessionFormatUnsupportedError extends Error {
  /**
   * @param message - stable reason the log cannot be interpreted, already
   *   including the raw-log path when one exists.
   * @param location - the backend's artifact location, when one exists.
   */
  constructor(message: string, readonly location?: SessionLocation) {
    super(message)
    this.name = 'SessionFormatUnsupportedError'
  }
}

/**
 * Direction-aware refusal text for a stored session whose format version this
 * build does not read. Shared by the coordinator's load-time check and by
 * backends that must refuse BEFORE decoding version-dependent structure (a
 * future format may not satisfy this build's structural checks at all, and the
 * user must see "upgrade the harness", never "corrupt").
 * @param id - the stored session id, for message context.
 * @param version - the stored format version.
 * @returns the stable refusal text, without a raw-log path suffix.
 */
export function sessionFormatVersionRefusal(id: string, version: number): string {
  return version > SESSION_FORMAT_VERSION
    ? `session "${id}" uses log format v${version}, but this harness reads only v${SESSION_FORMAT_VERSION}: the log was written by a newer harness — upgrade the harness to open it`
    : `session "${id}" uses log format v${version}, older than the supported v${SESSION_FORMAT_VERSION}, and this build ships no upgrade path for it`
}

/** Coordinator policy supplied by a concrete persistence backend. */
export interface PersistenceCoordinatorOptions {
  /** Maximum completed unpublished preparations retained for reuse. */
  readonly preparedSessionCacheSize: number
  /** Maximum intentional batching wait after an idle live queue receives work. */
  readonly writeBatchMaxDelayMs: number
}

/**
 * A stored session's header, valid contiguous event prefix, source-qualified
 * revision, and optional opaque torn-tail marker. The revision identifies the
 * exact detached prefix. The coordinator only checks marker presence and
 * returns its value to {@link PersistenceBackend.commitRepair}; each backend
 * owns the marker type.
 */
export interface StoredPrefix<TornMarker = unknown> {
  meta: SessionHeader
  events: SessionEvent[]
  /** Revision observed for exactly this detached prefix. */
  revision: SessionPersistenceRevision
  tornMarker?: TornMarker
}

/**
 * A stored session's header plus the events at or past a requested seq — the
 * return shape of the optional seek-capable
 * {@link PersistenceBackend.loadStoredFrom} hook. Non-mutating reads carry no
 * torn marker: there is nothing to repair.
 */
export interface StoredSuffix {
  meta: SessionHeader
  events: SessionEvent[]
}

/**
 * The storage contract between {@link PersistenceCoordinator} and a concrete
 * backend: the minimal set of durable primitives the orchestration calls. A
 * backend implements these (over files, rows, an object store, …); the
 * coordinator supplies everything else (buffering, serialization, cursors,
 * adoption, crash repair sequencing, dispose quiescence).
 *
 * @typeParam TornMarker - the backend's opaque torn-tail repair token (see
 * {@link StoredPrefix}). The coordinator treats it as fully opaque.
 */
export interface PersistenceBackend<TornMarker = unknown> {
  /** Human-readable backend name, used in the dispose-failure AggregateError. */
  readonly name: string

  /**
   * Read a stored prefix by id, scanning every backend storage scope. Returns
   * `undefined` if no stored artifact exists. Returned metadata must identify
   * `id` before repair or state publication. Used by resume/load, live adoption,
   * and — via `!== undefined` — the create-collision probe. The returned
   * `tornMarker` is present iff there is a torn tail to truncate. Every header
   * and event graph must be fresh, mutually unaliased, and unretained by the
   * backend because preparation freezes and publishes them in place. The
   * returned revision must identify exactly those values and use the same
   * representation as {@link readStoredRevision}.
   * @param id - persisted session id to resolve.
   * @param signal - optional cancellation for backend read work.
   */
  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<TornMarker> | undefined>

  /**
   * Read the current source-qualified revision for one stored session without
   * loading its event log. Returns `undefined` when the identity is absent.
   * @param id - persisted session id to observe.
   * @param signal - optional cancellation for backend read work.
   */
  readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined>

  /**
   * Optional seek-capable suffix read behind the service's `readFrom`: return
   * the header plus the stored events with `seq >= fromSeq` without reading
   * the whole log. A backend whose medium can address events by seq implements
   * this so `readFrom` scales with the suffix; sequential backends
   * omit it and the coordinator falls back to {@link loadStored} plus a
   * forward skip. Non-mutating (no truncation, no closers). Validation of the
   * region strictly below `fromSeq` is limited to seq contiguity — the
   * service contract scopes this read to the suffix — unless that suffix
   * contains a supported legacy shape whose normalization needs earlier
   * message-identity facts, in which case the coordinator falls back
   * to the complete stored prefix.
   * Unknown-type refusal follows the same suffix scope: a seek-capable
   * backend's `readFrom` checks only the returned suffix, while the
   * sequential fallback parses the whole artifact and refuses on an unknown
   * required event anywhere in it — over-refusal on the sequential side is
   * accepted rather than widening the seek read.
   * @param id - persisted session id to resolve.
   * @param fromSeq - first event seq to include (non-negative safe integer,
   *   validated by the coordinator before this hook runs).
   * @param signal - optional cancellation for backend read work.
   */
  loadStoredFrom?(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined>

  /** Durably create an empty header-only session artifact. */
  materializeHeader?(meta: SessionHeader): Promise<void>

  /**
   * Durably append a CONTIGUOUS batch, lazily materializing the session first
   * when `!isMaterialized`. The materialize-write and the first event batch MUST
   * commit ATOMICALLY (a crash between them must not leave a materialized-but-
   * empty session). Returns once the batch is durable.
   */
  appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void>

  /**
   * Make a crash repair durable: truncate the torn tail (iff
   * `tornMarker !== undefined`) and append `closers` (iff any). NOT required to
   * be atomic — a file backend may truncate-then-append in two fsync'd steps.
   * Used by load (truncate + synthetic closers) and by live-adoption (truncate
   * only, `closers = []`).
   */
  commitRepair(meta: SessionHeader, tornMarker: TornMarker | undefined, closers: readonly SessionEvent[]): Promise<void>

  /**
   * List all stored (materialized) sessions' metadata.
   * @param signal - optional cancellation for backend listing work.
   */
  list(signal?: AbortSignal): Promise<SessionHeader[]>

  /**
   * Optional side-effect-free artifact locator, used to point refusal
   * diagnostics ({@link SessionFormatUnsupportedError}) at the raw log.
   * Backends without one artifact per session omit it or return `undefined`.
   * @param meta - the header whose artifact is requested.
   */
  locate?(meta: SessionHeader): SessionLocation | undefined

  /**
   * Optional lifecycle teardown (e.g. close a database handle). Awaited by the
   * coordinator's dispose effect AFTER the quiescence drain. A stateless file
   * backend omits it.
   */
  close?(): Promise<void>
}

/** Per-session write state held by the coordinator's in-memory bookkeeping. */
interface SessionState {
  meta: SessionHeader
  /** The next seq the backend expects to append (the stored log length). */
  cursor: number
  /**
   * Whether lazy creation has produced a durable artifact. The first append
   * atomically materializes the header with events; reclaim logic uses this to
   * distinguish an unused id from a persisted collision.
   */
  materialized: boolean
  /**
   * The live Session this state was bound to via `onCreated`, if any. State
   * created through the public `create()`/`load()` API has no owner; state bound
   * to a live session lets `onCreated` reject a second, unrelated session on the
   * same id (a collision) instead of silently no-opping.
   */
  owner?: Session
}

/** One live session's initialization and bounded write-behind controller. */
interface LiveSessionState {
  init: Promise<void>
  writes: SessionWriteBehind
}

/** One validated cold source and the exact unpublished Session built from it. */
interface PreparedSessionSource<TornMarker> {
  readonly inspection: SessionInspection
  readonly session: Session
  readonly revision: SessionPersistenceRevision
  /** Session length after constructor-owned seed markers were appended. */
  readonly sessionLength: number
  readonly tornMarker: TornMarker | undefined
  readonly closers: readonly SessionEvent[]
}

/** Collect the rejection reasons from a set of promises (none-throwing). */
async function settledErrors(promises: Iterable<Promise<unknown>>): Promise<unknown[]> {
  const settled = await Promise.allSettled([...promises])
  const errors: unknown[] = []
  for (const result of settled) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  return errors
}

/** Whether a live session seed reproduces a persisted prefix exactly. */
function seedCoversPrefix(seed: readonly SessionEvent[], prefix: readonly SessionEvent[]): boolean {
  return prefix.length <= seed.length
    && prefix.every((event, index) => {
      const seedEvent = seed[index]
      return seedEvent !== undefined && JSON.stringify(seedEvent) === JSON.stringify(event)
    })
}

/** Reject events from an obsolete v0 vocabulary that this build cannot replay. */
function assertSupportedEvents(events: readonly SessionEvent[], id: SessionId): void {
  const legacyType: string = 'request/header-delta'
  const legacy = events.find(event => event.type === legacyType)
  if (legacy !== undefined) {
    throw new Error(`session "${id}" contains unsupported legacy request/header-delta event at seq ${legacy.seq}`)
  }
  const legacyModeType: string = 'mode/set'
  const legacyMode = events.find(event => event.type === legacyModeType)
  if (legacyMode !== undefined) {
    throw new Error(`session "${id}" contains unsupported legacy mode/set event at seq ${legacyMode.seq}`)
  }
  const fallback = events.find(event => event.type === 'request/header'
    && (event.data as { reason?: string }).reason === 'fallback')
  if (fallback !== undefined) {
    throw new Error(`session "${id}" contains unsupported legacy request/header reason "fallback" at seq ${fallback.seq}`)
  }
}

/** Return an object record without widening arrays into message payloads. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Whether a record contains every required key and no key outside the optional extension set. */
function hasOnlyKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = [...required, ...optional]
  return Object.keys(record).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(record, key))
}

type PersistedMessageId = SessionEvent<'user/message'>['data']['id']

/** Mint the stable import identity for a message persisted before identities existed. */
function legacyMessageId(id: SessionId, seq: number): PersistedMessageId {
  return `legacy-message:${id}:${seq}` as PersistedMessageId
}

/** Read a replacement target while leaving malformed surface metadata to the session validator. */
function replacementStart(event: SessionEvent): number | undefined {
  const op = asRecord((event as SessionEvent & { surfaceOp?: unknown }).surfaceOp)
  return op?.['op'] === 'replace' && typeof op['start'] === 'number'
    ? op['start']
    : undefined
}

/** Whether one suffix event needs facts available only from the preceding stored prefix. */
function needsLegacyPrefix(event: SessionEvent): boolean {
  const data = asRecord(event.data)
  const legacySteeringType: string = 'steering/message'
  if (event.type === legacySteeringType) return true
  if (data === undefined) return false
  switch (event.type) {
    case 'user/message':
      return !Object.hasOwn(data, 'id') && Object.hasOwn(data, 'content')
    case 'assistant/message':
      return !Object.hasOwn(data, 'message') && Object.hasOwn(data, 'content')
    case 'tool/result':
      return !Object.hasOwn(data, 'message') && Object.hasOwn(data, 'callId')
    default:
      return false
  }
}

/** Upgrade the removed steering surface event into its current user-message equivalent. */
function migrateLegacySteeringEvent(event: SessionEvent, id: SessionId): SessionEvent {
  const legacyType: string = 'steering/message'
  if (event.type !== legacyType) return event
  const data = asRecord(event.data)
  if (data === undefined) {
    throw new Error(`session "${id}" contains malformed pre-react-loop steering/message at seq ${event.seq}`)
  }
  const wrapped = asRecord(data['message'])
  if (wrapped !== undefined && Number.isSafeInteger(data['turn'])
    && hasOnlyKeys(data, ['turn', 'message'])) {
    return { ...event, type: 'user/message', data: wrapped } as SessionEvent
  }
  if (!Number.isSafeInteger(data['turn']) || !hasOnlyKeys(data, ['turn', 'content', 'source'])) {
    throw new Error(`session "${id}" contains malformed pre-react-loop steering/message at seq ${event.seq}`)
  }
  const { turn: _turn, ...message } = data
  return {
    ...event,
    type: 'user/message',
    data: {
      ...message,
      id: legacyMessageId(id, event.seq),
      role: 'user',
    },
  } as SessionEvent
}

/** Remove the obsolete trigger after verifying the complete old turn-start envelope. */
function migrateLegacyTurnStartEvent(event: SessionEvent, id: SessionId): SessionEvent {
  if (event.type !== 'turn/start') return event
  const data = asRecord(event.data)
  if (data === undefined || !Object.hasOwn(data, 'trigger')) return event
  const trigger = asRecord(data['trigger'])
  if (!Number.isSafeInteger(data['turn']) || (data['turn'] as number) < 1
    || !hasOnlyKeys(data, ['turn', 'trigger'])
    || trigger === undefined || typeof trigger['kind'] !== 'string' || trigger['kind'].length === 0) {
    throw new Error(`session "${id}" contains malformed pre-react-loop turn/start at seq ${event.seq}`)
  }
  return { ...event, data: { turn: data['turn'] } } as SessionEvent
}

/** Upgrade an obsolete turn ending while preserving the latest-master envelope. */
function migrateLegacyTurnEndEvent(event: SessionEvent, id: SessionId): SessionEvent {
  if (event.type !== 'turn/end') return event
  const data = asRecord(event.data)
  /* v8 ignore next -- a non-record current envelope cannot match a legacy shape. */
  if (data === undefined) return event
  const malformed = (): never => {
    throw new Error(`session "${id}" contains malformed pre-react-loop turn/end at seq ${event.seq}`)
  }
  const reason = asRecord(data['reason'])
  if (!Number.isSafeInteger(data['turn']) || (data['turn'] as number) < 1
    || !hasOnlyKeys(data, ['turn', 'reason'])
    || reason === undefined || typeof reason['kind'] !== 'string') return malformed()

  let currentReason: Record<string, unknown> | undefined
  switch (reason['kind']) {
    case 'completed':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
      if (!hasOnlyKeys(reason, ['kind'])) return malformed()
      return event
    case 'aborted':
      if (Object.hasOwn(reason, 'reason')) return event
      if (!hasOnlyKeys(reason, ['kind'])) return malformed()
      currentReason = { kind: 'aborted', reason: { kind: 'legacy' } }
      break
    case 'disposed':
      if (!hasOnlyKeys(reason, ['kind'])) return malformed()
      currentReason = { kind: 'aborted', reason: { kind: 'disposed' } }
      break
    case 'error': {
      if (Object.hasOwn(reason, 'error')) return event
      if (!Number.isSafeInteger(reason['step']) || (reason['step'] as number) < 0) return malformed()
      const failure = asRecord(reason['failure'])
      if (failure !== undefined && hasOnlyKeys(reason, ['kind', 'step', 'failure'])
        && hasOnlyKeys(failure, ['message', 'code'], ['status', 'providerRetryAfterMs', 'requestId'])
        && typeof failure['message'] === 'string' && typeof failure['code'] === 'string'
        && (failure['status'] === undefined || typeof failure['status'] === 'number')
        && (failure['providerRetryAfterMs'] === undefined || typeof failure['providerRetryAfterMs'] === 'number')
        && (failure['requestId'] === undefined || typeof failure['requestId'] === 'string')) {
        currentReason = { kind: 'error', error: failure }
        break
      }
      const messageKeys = reason['code'] === undefined
        ? ['kind', 'step', 'message']
        : ['kind', 'step', 'message', 'code']
      if (!hasOnlyKeys(reason, messageKeys)
        || typeof reason['message'] !== 'string'
        || (reason['code'] !== undefined && typeof reason['code'] !== 'string')) return malformed()
      currentReason = {
        kind: 'error',
        error: {
          message: reason['message'],
          code: typeof reason['code'] === 'string' ? reason['code'] : 'UNKNOWN',
        },
      }
      break
    }
    default:
      return event
  }

  return {
    ...event,
    data: {
      ...data,
      reason: currentReason,
    },
  } as SessionEvent
}

/**
 * Upgrade one pre-identity message event into the current wrapper shape.
 * Current-looking malformed events remain untouched so validation rejects them
 * instead of disguising corruption as legacy data.
 */
function migrateLegacyMessageEvent(
  event: SessionEvent,
  id: SessionId,
  messageIds: ReadonlyMap<number, PersistedMessageId>,
): SessionEvent {
  const data = asRecord(event.data)
  if (data === undefined) return event
  switch (event.type) {
    case 'user/message': {
      if (Object.hasOwn(data, 'id') || Object.hasOwn(data, 'role')
        || Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'content') || !Object.hasOwn(data, 'source')) return event
      return {
        ...event,
        data: {
          ...data,
          id: legacyMessageId(id, event.seq),
          role: 'user',
        },
      } as SessionEvent
    }
    case 'assistant/message': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'content') || !Object.hasOwn(data, 'provenance')) return event
      const { content, provenance, ...eventData } = data
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: legacyMessageId(id, event.seq),
            role: 'assistant',
            content,
            source: {
              ...asRecord(provenance),
              kind: 'model',
            },
          },
        },
      } as SessionEvent
    }
    case 'tool/result': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'callId') || !Object.hasOwn(data, 'content')
        || !Object.hasOwn(data, 'isError')) return event
      const { callId, content, isError, ...eventData } = data
      const inheritedId = replacementStart(event)
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: inheritedId === undefined
              ? legacyMessageId(id, event.seq)
              : messageIds.get(inheritedId),
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: callId,
              content,
              isError,
            }],
            source: {
              kind: 'tool',
              callId,
            },
          },
        },
      } as SessionEvent
    }
    default:
      return event
  }
}

/** Read the identified message carried by one validated current event. */
function eventMessageId(event: SessionEvent): PersistedMessageId | undefined {
  const data = asRecord(event.data)
  const message = event.type === 'user/message' ? data : asRecord(data?.['message'])
  return typeof message?.['id'] === 'string' ? message['id'] as PersistedMessageId : undefined
}

/** Materialize stored events as upgraded, validated snapshots with immutable messages. */
function snapshotStoredEvents(events: readonly SessionEvent[], id: SessionId): SessionEvent[] {
  assertSupportedEvents(events, id)
  const messageIds = new Map<number, PersistedMessageId>()
  return events.map((event) => {
    const migratedStart = migrateLegacyTurnStartEvent(event, id)
    const migratedTurn = migrateLegacyTurnEndEvent(migratedStart, id)
    const migratedSteering = migrateLegacySteeringEvent(migratedTurn, id)
    const snapshot = snapshotSessionEvent(migrateLegacyMessageEvent(migratedSteering, id, messageIds))
    const messageId = eventMessageId(snapshot)
    if (messageId !== undefined) messageIds.set(snapshot.seq, messageId)
    return snapshot
  })
}

/** Upgrade and validate an exclusively owned backend result without copying it. */
function adoptStoredEvents(events: SessionEvent[], id: SessionId): SessionEvent[] {
  assertSupportedEvents(events, id)
  const messageIds = new Map<number, PersistedMessageId>()
  for (const [index, event] of events.entries()) {
    const migratedStart = migrateLegacyTurnStartEvent(event, id)
    const migratedTurn = migrateLegacyTurnEndEvent(migratedStart, id)
    const migratedSteering = migrateLegacySteeringEvent(migratedTurn, id)
    const adopted = adoptSessionEvent(migrateLegacyMessageEvent(migratedSteering, id, messageIds))
    events[index] = adopted
    const messageId = eventMessageId(adopted)
    if (messageId !== undefined) messageIds.set(adopted.seq, messageId)
  }
  return events
}

/**
 * Owns the backend-agnostic session write-path orchestration. A backend
 * constructs one (`new PersistenceCoordinator(ctx, this)`), implements
 * {@link PersistenceBackend}, and delegates its write/read service methods to
 * the matching coordinator methods.
 *
 * All per-id operations are serialized (a per-id promise chain) so concurrent
 * flushes / a flush racing a load never interleave storage writes. The
 * constructor installs the write-path listeners, per-session retirement, and
 * the backend dispose effect.
 *
 * @typeParam TornMarker - the backend's opaque torn-tail repair token.
 */
export class PersistenceCoordinator<TornMarker = unknown> {
  /** Backend bookkeeping keyed by session id (NOT the live Session object). */
  private states = new Map<SessionId, SessionState>()
  /** Lifecycle and write-behind state keyed by the exact live Session. */
  private live = new Map<Session, LiveSessionState>()
  /** Exact disposed lifecycles whose buffered tail is still draining. */
  private retirements = new Map<SessionId, Promise<void>>()
  /** Shared cold reads, unpublished reservations, and completed LRU entries. */
  private readonly preparations: SessionPreparations<PreparedSessionSource<TornMarker>, SessionState>
  /**
   * Per-session serialization: every operation chains onto the prior one for the
   * same id, so writes for one session never interleave. Keyed by session id.
   */
  private chains = new Map<SessionId, Promise<unknown>>()
  /** Resolved fixed write-batching window shared by per-session controllers. */
  private readonly writeBatchMaxDelayMs: number

  constructor(
    private ctx: Context,
    private backend: PersistenceBackend<TornMarker>,
    options: PersistenceCoordinatorOptions = {
      preparedSessionCacheSize: DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    },
  ) {
    if (!Number.isSafeInteger(options.preparedSessionCacheSize)
      || options.preparedSessionCacheSize < 1) {
      throw new TypeError('preparedSessionCacheSize must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.writeBatchMaxDelayMs)
      || options.writeBatchMaxDelayMs < 1
      || options.writeBatchMaxDelayMs > MAX_WRITE_BATCH_DELAY_MS) {
      throw new TypeError(`writeBatchMaxDelayMs must be an integer between 1 and ${MAX_WRITE_BATCH_DELAY_MS}`)
    }
    this.writeBatchMaxDelayMs = options.writeBatchMaxDelayMs
    this.preparations = new SessionPreparations(options.preparedSessionCacheSize)
    this.installWritePath()
  }

  // --- Public API (the backend's service methods delegate here) ---

  /**
   * Register detached session metadata for lazy creation on the first append.
   * @param meta - header to snapshot; duplicate tracked or persisted ids reject.
   */
  create(meta: SessionHeader): Promise<void> {
    // Snapshot before queueing so caller mutation cannot diverge the key and header.
    const snapshot = snapshotJsonValue(meta)
    if (snapshot === undefined) {
      return Promise.reject(new TypeError('session metadata must be losslessly JSON-serializable'))
    }
    if (!Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0) {
      return Promise.reject(new TypeError('session metadata createdAt must be a non-negative safe integer'))
    }
    return this.serialize(snapshot.id, () => this.createCore(snapshot))
  }

  /**
   * Materialize one exact live session without inventing a session event.
   * @param session - live session already registered through the write path.
   */
  async ensureMaterialized(session: Session): Promise<void> {
    await this.flush(session)
    await this.serialize(session.id, async () => {
      const state = this.states.get(session.id)
      /* v8 ignore next -- successful live flush always initializes the exact session state. */
      if (state === undefined) throw new Error(`session "${session.id}" is not registered for persistence`)
      if (state.materialized) return
      if (this.backend.materializeHeader === undefined) {
        throw new Error('session persistence backend cannot materialize an empty session')
      }
      await this.backend.materializeHeader(state.meta)
      state.materialized = true
      this.preparations.invalidate(session.id)
    })
  }

  private async createCore(meta: SessionHeader): Promise<void> {
    // Do NOT clobber an existing session: the SessionId IS the identity.
    if (this.states.has(meta.id) || this.preparations.has(meta.id)) {
      throw new Error(`session "${meta.id}" already exists in this backend`)
    }
    // A persisted artifact under this id (in ANY scope) blocks creation: load/
    // resume identify a session by id alone, so a second artifact would make
    // resume nondeterministic.
    if (await this.backend.loadStored(meta.id) !== undefined) {
      throw new Error(`session "${meta.id}" already has a persisted log on disk; load/resume it instead of creating`)
    }
    // Pure lazy: record intent only. No artifact until the first append.
    this.states.set(meta.id, { meta, cursor: 0, materialized: false })
  }

  // `async` so synchronous materialization failures below reject (not throw) per
  // the Promise<void> contract — callers use `await expect(...).rejects`.
  /**
   * Durably persist a batch of events. Honors the append-only and contiguous-seq
   * contracts; rejects non-JSON-serializable `event.data`.
   * @param id - the session the batch belongs to.
   * @param events - the contiguous batch to persist, in seq order; materialized
   *   as a detached lossless-JSON snapshot at call time.
   */
  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    // Validate and deep-snapshot the complete batch HERE, in one traversal,
    // before the op waits behind the per-session chain. A check followed by
    // structuredClone would reread accessors and could sanitize an exotic value
    // into an apparently valid record; the single-pass materializer makes the
    // checked value exactly the value persisted.
    const batch = snapshotJsonValue(events)
    if (batch === undefined) {
      throw new TypeError('session event batch is not losslessly JSON-serializable because it contains non-JSON-serializable data')
    }
    return this.serialize(id, () => this.appendCore(id, batch))
  }

  private async appendCore(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    // Every append route converges here: the public service, live write-behind
    // drains, and HMR seed/suffix adoption. Legacy-shape rejection stays at
    // this shared boundary so a stale JavaScript plugin cannot persist a
    // retired shape this backend refuses to load. The unknown-type guard is
    // deliberately read-side only: an append-time refusal would stall a live
    // session's durability mid-flight, which costs more than a loud refusal at
    // the log's next load (trade-off owned by the session-log-version-mechanism
    // Agent Note).
    assertSupportedEvents(events, id)
    if (events.length === 0) return
    this.preparations.assertWritable(id)
    let state = this.states.get(id)
    if (state === undefined) state = await this.adopt(id)

    // Contiguity contract: each event's seq must continue the stored log.
    for (const [i, event] of events.entries()) {
      if (event.seq !== state.cursor + i) {
        throw new Error(`append seq mismatch for "${id}": expected ${state.cursor + i} at index ${i}, got ${event.seq}`)
      }
    }

    await this.backend.appendBatch(state.meta, events, state.materialized)
    // The durable write is the transaction: mark materialized + advance the
    // cursor as soon as it commits (uniform across backends).
    state.materialized = true
    state.cursor += events.length
    this.preparations.invalidate(id)
  }

  /**
   * Prepare and reserve the exact unpublished Session used by resume.
   * Revision retries converge once the durable log remains unchanged for one
   * read/check round trip; continuous external writers may delay completion.
   * @param id - persisted session to prepare.
   * @param signal - optional cancellation for reading and repair.
   * @returns an owned preparation released after publication or rollback.
   */
  async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    for (;;) {
      await this.waitForRetirement(id, signal)
      if (this.ctx.sessions.get(id) !== undefined) {
        throw new Error(`cannot prepare session "${id}" while it is live`)
      }
      const reservation = await this.preparations.reserve(
        id,
        () => this.serialize(id, () => this.prepareCore(id)),
        source => this.serialize(id, () => this.commitPrepared(source), signal),
        signal,
      )
      if (reservation === undefined) continue
      if (this.ctx.sessions.get(id) !== undefined) {
        this.preparations.release(reservation, false)
        throw new Error(`cannot prepare session "${id}" while it is live`)
      }
      return SessionPreparation.create(reservation.source.session, {
        release: () => {
          this.preparations.release(
            reservation,
            reservation.state.owner === undefined
              && reservation.source.session.seq === reservation.source.sessionLength,
          )
        },
      })
    }
  }

  /**
   * Commit recovery and return its immutable logical view without publication.
   * Revision retries converge once the durable log remains unchanged for one
   * read/check round trip; continuous external writers may delay completion.
   * @param id - persisted session to load.
   * @returns prepared header and balanced events.
   */
  async load(id: SessionId): Promise<SessionInspection> {
    for (;;) {
      await this.waitForRetirement(id)
      const live = this.ctx.sessions.get(id)
      if (live !== undefined) return this.loadLiveSnapshot(live)
      const reservation = await this.preparations.reserve(
        id,
        () => this.serialize(id, () => this.prepareCore(id)),
        source => this.serialize(id, () => this.commitPrepared(source)),
      )
      if (reservation === undefined) continue
      const attached = this.ctx.sessions.get(id)
      if (attached !== undefined) {
        this.preparations.discard(reservation)
        return this.loadLiveSnapshot(attached)
      }
      this.preparations.discard(reservation)
      return reservation.source.inspection
    }
  }

  /**
   * Inspect a logical session without publishing it or committing recovery.
   * A stale ready source is reloaded. A source already committing or reserved
   * for resume remains exclusive, and inspection may borrow its immutable view.
   * Revision retries converge once the log is stable for one read/check round
   * trip; continuous external writers may delay completion.
   * @param id - persisted session to inspect.
   * @param signal - optional cancellation for preparation work.
   * @returns immutable prepared metadata and events; a live view may have an open turn.
   */
  async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    for (;;) {
      signal?.throwIfAborted()
      if (this.retirements.has(id)) await this.waitForRetirement(id, signal)
      const live = this.ctx.sessions.get(id)
      if (live !== undefined) return this.inspectLive(live)
      try {
        const source = await this.preparations.inspect(
          id,
          () => this.serialize(id, () => this.prepareCore(id)),
          signal,
        )
        const attached = this.ctx.sessions.get(id)
        if (attached !== undefined) return this.inspectLive(attached)
        const current = await this.serialize(
          id,
          () => this.isPreparedSourceCurrent(source, signal),
          signal,
        )
        const published = this.ctx.sessions.get(id)
        if (published !== undefined) return this.inspectLive(published)
        if (current) return source.inspection
        if (this.preparations.discardReady(id, source) === 'retained') {
          return source.inspection
        }
      } catch (error: unknown) {
        signal?.throwIfAborted()
        const attached = this.ctx.sessions.get(id)
        if (attached !== undefined) return this.inspectLive(attached)
        throw error
      }
    }
  }

  /**
   * Borrow one exact logical view while pinning its reusable prepared Session.
   * @param id - persisted session to observe.
   * @param signal - optional cancellation for preparation work.
   * @returns a disposable observation retaining the prepared source.
   */
  async borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    for (;;) {
      signal?.throwIfAborted()
      if (this.retirements.has(id)) await this.waitForRetirement(id, signal)
      const live = this.ctx.sessions.get(id)
      if (live !== undefined) {
        return { source: 'live', inspection: this.inspectLive(live), [Symbol.dispose]: () => {} }
      }
      const observation = await this.preparations.borrow(
        id,
        () => this.serialize(id, () => this.prepareCore(id)),
        signal,
      )
      const source = observation.source
      try {
        const attached = this.ctx.sessions.get(id)
        if (attached !== undefined) {
          observation[Symbol.dispose]()
          return { source: 'live', inspection: this.inspectLive(attached), [Symbol.dispose]: () => {} }
        }
        const current = await this.serialize(
          id,
          () => this.isPreparedSourceCurrent(source, signal),
          signal,
        )
        const published = this.ctx.sessions.get(id)
        if (published !== undefined) {
          observation[Symbol.dispose]()
          return { source: 'live', inspection: this.inspectLive(published), [Symbol.dispose]: () => {} }
        }
        if (current || this.preparations.discardReady(id, source) === 'retained') {
          return {
            source: 'prepared',
            inspection: source.inspection,
            revision: source.revision,
            preparedSession: source.session,
            [Symbol.dispose]: () => { observation[Symbol.dispose]() },
          }
        }
      } catch (error: unknown) {
        observation[Symbol.dispose]()
        signal?.throwIfAborted()
        const attached = this.ctx.sessions.get(id)
        if (attached !== undefined) {
          return { source: 'live', inspection: this.inspectLive(attached), [Symbol.dispose]: () => {} }
        }
        throw error
      }
      observation[Symbol.dispose]()
    }
  }

  /**
   * Read the stored events from `fromSeq` onward, detached and non-mutating
   * (the read-from-seq primitive behind the service's `readFrom`). Runs on
   * the same per-id chain as writes; a backend with the seek-capable
   * {@link PersistenceBackend.loadStoredFrom} hook reads only the suffix,
   * every other backend reads its stored prefix and skips forward here.
   * @param id - persisted session to read.
   * @param fromSeq - first event seq to include; a non-negative safe integer.
   * @param signal - optional cancellation for queued and backend read work.
   * @returns stored header and the valid stored events with `seq >= fromSeq`.
   */
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
      return Promise.reject(new TypeError(`readFrom fromSeq must be a non-negative safe integer, got ${String(fromSeq)}`))
    }
    const retired = Promise.resolve(this.retirements.get(id))
    const waited = signal === undefined ? retired : observeQueuedAbort(retired, signal, () => false)
    return waited.then(() => this.serialize(id, () => this.readFromCore(id, fromSeq, signal), signal))
  }

  private async readFromCore(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    signal?.throwIfAborted()
    if (this.backend.loadStoredFrom !== undefined) {
      let suffix: StoredSuffix | undefined
      try {
        suffix = await this.backend.loadStoredFrom(id, fromSeq, signal)
      } catch (error: unknown) {
        if (signal?.aborted) signal.throwIfAborted()
        throw error
      }
      signal?.throwIfAborted()
      if (suffix === undefined) throw new SessionPersistenceNotFoundError(id)
      this.assertStoredId(id, suffix.meta)
      this.assertVersion(suffix.meta)
      if (suffix.events.some(needsLegacyPrefix)) {
        const whole = await this.readStoredPrefix(id, signal)
        return { meta: whole.meta, events: whole.events.filter(event => event.seq >= fromSeq) }
      }
      const events = snapshotStoredEvents(suffix.events, id)
      this.assertEventsSupported(suffix.meta, events)
      return { meta: structuredClone(suffix.meta), events }
    }
    const whole = await this.readStoredPrefix(id, signal)
    // Sequential fallback: contiguous seqs from 0 make the suffix an index slice.
    return { meta: whole.meta, events: whole.events.slice(fromSeq) }
  }

  /** Read one detached physical prefix without logical recovery or caching. */
  private async readStoredPrefix(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    signal?.throwIfAborted()
    const stored = await this.backend.loadStored(id, signal)
    signal?.throwIfAborted()
    if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
    this.assertStoredId(id, stored.meta)
    this.assertVersion(stored.meta)
    const events = snapshotStoredEvents(stored.events, id)
    this.assertEventsSupported(stored.meta, events)
    return {
      meta: structuredClone(stored.meta),
      events,
    }
  }

  /** Read, repair in memory, validate, and freeze one cold source once. */
  private async prepareCore(id: SessionId): Promise<PreparedSessionSource<TornMarker>> {
    const stored = await this.backend.loadStored(id)
    if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
    try {
      const { meta, events, revision, tornMarker } = stored
      this.assertStoredId(id, meta)
      this.assertVersion(meta)
      const storedEvents = adoptStoredEvents(events, id)
      this.assertEventsSupported(meta, storedEvents)

      // Preserve complete interrupted events and synthesize only missing closers.
      const closers = interruptedTurnClosers(storedEvents).map(adoptSessionEvent)
      const balanced = [...storedEvents, ...closers]
      const session = this.ctx.sessions.prepare(id, {
        seed: balanced,
        meta,
        seedSource: 'persistence',
      })
      const inspection: SessionInspection = Object.freeze({
        meta: session.header,
        events: Object.freeze(balanced),
      })
      return {
        inspection,
        session,
        revision,
        sessionLength: session.seq,
        tornMarker,
        closers,
      }
    } catch (error: unknown) {
      // An unsupported format is a refusal over an intact log, not damage —
      // surface it unwrapped so callers can point at the raw artifact.
      if (error instanceof SessionFormatUnsupportedError) throw error
      throw new SessionPersistenceCorruptionError(
        `stored session "${id}" failed validation: ${String(error)}`,
        { cause: error },
      )
    }
  }

  /** Commit one prepared repair and establish its ownerless durable cursor. */
  private async commitPrepared(
    source: PreparedSessionSource<TornMarker>,
  ): Promise<{ source: PreparedSessionSource<TornMarker>; state: SessionState } | undefined> {
    const id = source.inspection.meta.id
    const cursor = source.inspection.events.length
    const existing = this.states.get(id)
    if (existing?.owner !== undefined) {
      throw new Error(`session "${id}" already has a live persistence owner`)
    }
    if (!await this.isPreparedSourceCurrent(source)) return undefined
    if (source.tornMarker !== undefined || source.closers.length > 0) {
      await this.backend.commitRepair(source.inspection.meta, source.tornMarker, source.closers)
      // The repair changed the durable revision. Reload the exact committed
      // graph instead of associating the old in-memory view with a newer revision.
      return undefined
    }
    const state = existing ?? {
      meta: source.inspection.meta,
      cursor,
      materialized: true,
    }
    state.meta = source.inspection.meta
    state.cursor = cursor
    state.materialized = true
    this.states.set(id, state)
    return {
      source,
      state,
    }
  }

  /** Whether one cached source still names the current durable log revision. */
  private async isPreparedSourceCurrent(
    source: PreparedSessionSource<TornMarker>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return await this.backend.readStoredRevision(source.inspection.meta.id, signal) === source.revision
  }

  /** Return one durable immutable view of an already-live Session. */
  private async loadLiveSnapshot(session: Session): Promise<SessionInspection> {
    const events = session.snapshotEvents()
    await this.flush(session)
    const state = this.states.get(session.id)
    /* v8 ignore next -- successful flush always publishes this live session's durable state */
    if (state === undefined) throw new Error(`session "${session.id}" lost persistence state during load`)
    if (events.length === 0 && !state.materialized) throw new Error(`session "${session.id}" not found`)
    if (interruptedTurnClosers(events).length > 0) {
      throw new Error(`cannot load session "${session.id}" while its live turn is open; use the live Session or wait for the turn to close`)
    }
    return Object.freeze({ meta: state.meta, events })
  }

  /** Borrow one immutable view from an already-live Session. */
  private inspectLive(session: Session): SessionInspection {
    return Object.freeze({ meta: session.header, events: session.snapshotEvents() })
  }

  /** Await one retiring lifecycle with caller cancellation. */
  private waitForRetirement(id: SessionId, signal?: AbortSignal): Promise<void> {
    const retired = Promise.resolve(this.retirements.get(id))
    return signal === undefined
      ? retired
      : observeQueuedAbort(retired, signal, () => false)
  }

  // Listing is a direct backend read and needs no coordinator state.

  // --- per-id serialization + adoption helpers ---

  /**
   * Run `op` after any in-flight operation for the same session id, so writes for
   * one session never interleave. Errors do not poison the chain. NOTE: serialized
   * public methods must NOT call each other (deadlock); they call the unserialized
   * `*Core` helpers instead.
   */
  private serialize<T>(
    id: SessionId,
    op: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve()
    let started = false
    const run = (): Promise<T> | T => {
      signal?.throwIfAborted()
      started = true
      return op()
    }
    const next = prior.then(run, run)
    // Keep the chain alive but swallow this op's rejection for the NEXT waiter
    // (the caller still sees the real rejection via `next`).
    const tail = next.then(() => undefined, () => undefined)
    this.chains.set(id, tail)
    // Settled tails carry no serialization value. Delete only the exact tail
    // installed above: a later operation may already have replaced it.
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id)
    })
    return signal === undefined ? next : observeQueuedAbort(next, signal, () => started)
  }

  /** Build a state for a session discovered in storage but not yet in memory. */
  private async adopt(id: SessionId): Promise<SessionState> {
    // This runs inside the id's serialization chain, so it uses core helpers
    // instead of re-entering through public prepare/load methods.
    for (;;) {
      const source = this.preparations.takeReady(id) ?? await this.prepareCore(id)
      const committed = await this.commitPrepared(source)
      if (committed !== undefined) return committed.state
    }
  }

  private assertVersion(meta: SessionHeader): void {
    if (meta.version === SESSION_FORMAT_VERSION) return
    throw this.unsupported(meta, sessionFormatVersionRefusal(meta.id, meta.version))
  }

  /**
   * Refuse a log containing an event type this build does not know, unless the
   * writer marked the event ignorable: an unrecognized required event may
   * change how the rest of the log must be interpreted, so silently skipping
   * it would reconstruct a wrong session (the envelope contract on
   * `SessionEvent.ignorable`). Runs on NORMALIZED events — after
   * `snapshotStoredEvents`/`adoptStoredEvents` has upgraded the legacy shapes
   * this build still reads and rejected the ones it does not, so those keep
   * their specific diagnostics.
   */
  private assertEventsSupported(meta: SessionHeader, events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue
      throw this.unsupported(meta, `session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`)
    }
  }

  /** Build a format refusal that points at the raw artifact when the backend has one. */
  private unsupported(meta: SessionHeader, reason: string): SessionFormatUnsupportedError {
    const location = this.backend.locate?.(meta)
    return new SessionFormatUnsupportedError(
      location === undefined ? reason : `${reason} (raw log: ${location.path})`,
      location,
    )
  }

  /** Reject backend metadata that is not bound to the requested session id. */
  private assertStoredId(id: SessionId, meta: SessionHeader): void {
    if (meta.id !== id) {
      throw new Error(`stored session identity mismatch: requested "${id}", header contains "${meta.id}"`)
    }
  }

  // --- write path (session/event → flush drain) ---

  private installWritePath(): void {
    const ctx = this.ctx

    // Register the disposer BEFORE the listeners. Cordis tears effects down in
    // reverse registration order, so event admission closes before this final
    // drain reaches quiescence and closes the backend.
    ctx.effect(() => async () => {
      let disposeError: unknown
      try {
        const errors = await settledErrors([...this.live.keys()].map(session => this.flush(session)))
        while (this.chains.size > 0) await Promise.allSettled([...this.chains.values()])
        if (errors.length > 0) {
          throw new AggregateError(errors, `${this.backend.name} dispose failed`)
        }
      } catch (error: unknown) {
        disposeError = error
        throw error
      } finally {
        try {
          await this.backend.close?.()
        } catch (closeError: unknown) {
          // A close failure can only add teardown context; keep the already-
          // captured drain AggregateError as the primary failure rather than
          // masking it. Only surface the close error if the drain succeeded.
          /* v8 ignore start -- close failure racing disposal is a defensive teardown edge */
          if (disposeError === undefined) throw closeError
          /* v8 ignore stop */
        }
      }
    }, `${this.backend.name} write path`)

    // Capture the header on creation and persist a fork's seed once.
    ctx.on('session/created', (session) => {
      void this.initFor(session)
    })

    // Keep a persistence-owned copy of each frozen event and start its bounded window.
    ctx.on('session/event', (session, event) => {
      const live = this.initFor(session)
      live.writes.enqueue(event)
    })

    // Callers use flush as the immediate durability barrier for buffered writes.
    ctx.on('session/flush', session => this.flush(session))

    // Session disposal is observe-only, so retirement contains its own failure.
    ctx.on('session/disposed', (session) => { this.retire(session) })

    // HMR does not replay session/created, so seed existing live sessions.
    for (const session of ctx.sessions.list()) void this.initFor(session)
  }

  /** Start and observe one disposed session's final drain. */
  private retire(session: Session): void {
    if (!this.live.has(session)) return
    const retirement = this.retireCore(session)
    this.retirements.set(session.id, retirement)
    const forget = (): void => {
      if (this.retirements.get(session.id) === retirement) this.retirements.delete(session.id)
    }
    void retirement.then(forget, forget)
    void retirement.catch((error: unknown) => {
      this.ctx.logger.warn(`${this.backend.name}: session "${session.id}" retirement failed: ${String(error)}`)
    })
  }

  /** Drain and release state owned by one exact disposed Session lifecycle. */
  private async retireCore(session: Session): Promise<void> {
    await this.flush(session)
    const id = session.header.id
    await this.serialize(id, () => {
      this.live.delete(session)
      if (this.states.get(id)?.owner === session) this.states.delete(id)
    })
  }

  /** Return the one lifecycle controller for a live session, creating it if needed. */
  private initFor(session: Session): LiveSessionState {
    const existing = this.live.get(session)
    if (existing) return existing
    const reservation = this.preparations.reservationFor(session)
    if (reservation !== undefined) {
      const restored = this.attachPrepared(session, reservation)
      this.live.set(session, restored)
      return restored
    }
    // Session owns this stable deep-frozen snapshot; backends only serialize it.
    const seed = session.snapshotEvents()
    const live: LiveSessionState = {
      init: Promise.resolve(),
      writes: this.createWriteBehind(session, () => live.init),
    }
    this.live.set(session, live)
    live.init = this.serialize(session.header.id, () => this.onCreated(session, seed))
    live.init.catch(() => { /* observed by flush/dispose through the controller */ })
    return live
  }

  /** Bind one exact prepared Session and persist only its unpublished suffix. */
  private attachPrepared(
    session: Session,
    reservation: SessionPreparationReservation<PreparedSessionSource<TornMarker>, SessionState>,
  ): LiveSessionState {
    const { source, state } = reservation
    if (source.session !== session || state.owner !== undefined
      || state.cursor !== source.inspection.events.length
      || session.firstLiveSeq !== state.cursor) {
      throw new Error(`session "${session.id}" preparation no longer matches its persistence state`)
    }
    const suffix = session.snapshotEvents(state.cursor).map(event => structuredClone(event))
    this.preparations.attach(reservation)
    state.owner = session
    const live: LiveSessionState = {
      init: Promise.resolve(),
      writes: this.createWriteBehind(session, () => live.init),
    }
    if (suffix.length > 0) {
      live.init = this.serialize(session.id, () => this.appendCore(session.id, suffix))
      live.init.catch(() => { /* observed by flush/dispose through the controller */ })
    }
    return live
  }

  /**
   * Whether a live session's `seed` reproduces the first `cursor` persisted
   * events. A `cursor` of 0 (nothing persisted yet) trivially matches. Used when
   * a live session claims ownerless state left by a prior `load()`/`create()`.
   */
  private async seedMatchesPersisted(id: SessionId, seed: readonly SessionEvent[], cursor: number): Promise<boolean> {
    if (cursor === 0) return true
    const stored = await this.backend.loadStored(id)
    /* v8 ignore next -- a cursor > 0 means the session was materialized, so it exists */
    if (stored === undefined) return false
    this.assertStoredId(id, stored.meta)
    return seedCoversPrefix(seed, snapshotStoredEvents(stored.events, id).slice(0, cursor))
  }

  /**
   * On session/created: sync the backend's in-memory state to a live Session.
   *
   * Cases, by whether this backend tracks the id and whether an artifact exists:
   *   1. Already tracked → no-op (or claim ownerless state if the seed matches,
   *      or reclaim a truly-abandoned id, else reject as a collision).
   *   2. Not tracked, an artifact EXISTS at the same cwd and is a seq-aligned
   *      PREFIX of the live events → ADOPT it, persisting any live suffix.
   *   3. Not tracked, an artifact EXISTS at another cwd or is NOT a prefix →
   *      REJECT (collision).
   *   4. Not tracked and NO artifact → a genuinely new session: register meta
   *      (lazy) and persist its seed once.
   */
  private async onCreated(session: Session, seed: readonly SessionEvent[]): Promise<void> {
    const id = session.header.id
    const tracked = this.states.get(id)
    if (tracked !== undefined) {
      // case 1: already tracked.
      /* v8 ignore next -- initFor dedupes per session object; same-object re-entry can't occur */
      if (tracked.owner === session) return
      if (tracked.owner === undefined) {
        // Ownerless state from the public create()/load() API. The FIRST live
        // session claims it — but ONLY if BOTH the cwd scope and the seed match.
        // A same-id ownerless artifact at a different cwd is a collision, not a
        // claim: accepting it would append this live session's events through
        // the stored header's cwd. The seed guard then ensures the live events
        // reproduce the persisted prefix; otherwise a fresh session reusing the
        // id could have its leading events filtered as already written.
        if (tracked.meta.cwd !== session.header.cwd) {
          throw new Error(`session "${id}" is already persisted at a different cwd (persisted: ${String(tracked.meta.cwd)}, live: ${String(session.header.cwd)}) (id collision)`)
        }
        if (!await this.seedMatchesPersisted(id, seed, tracked.cursor)) {
          throw new Error(`session "${id}" is already persisted with ${tracked.cursor} event(s) that do not match this live session (id collision)`)
        }
        tracked.owner = session
        // Persist the seed SUFFIX beyond the persisted prefix. Constructor seed
        // events never emit session/event, so the buffer never sees them.
        const suffix = seed.slice(tracked.cursor)
        if (suffix.length > 0) await this.appendCore(id, suffix)
        return
      }
      const owner = this.live.get(tracked.owner)
      if (!tracked.materialized && !owner?.writes.hasWork) {
        this.states.delete(id)
      } else {
        throw new Error(`session "${id}" is already bound to a different live session in this backend (id collision)`)
      }
    }

    // case 2/3: resolve the id once across storage, then let adoption reject a
    // cwd mismatch before repair or state publication.
    const live = await this.backend.loadStored(id)
    if (live !== undefined) {
      // Do NOT route through cold preparation: that crash-repairs open turns as
      // interrupted, which is wrong for HMR while the live Session is still the
      // authority and may append the real step/turn end later.
      await this.adoptLivePrefix(session, seed, live)
      return
    }

    // case 4: a genuinely new session. Register its meta (lazy), then persist its
    // seed (events present at creation time) once.
    const meta: SessionHeader = { ...session.header }
    await this.createCore(meta)
    // Bind this state to the live session so a later DIFFERENT session reusing
    // the id is detected as a collision (case 1) rather than silently no-opped.
    const created = this.states.get(id)
    /* v8 ignore next -- create() always sets the state for the id */
    if (created !== undefined) created.owner = session
    if (seed.length > 0) await this.appendCore(id, seed)
  }

  /**
   * Adopt a stored prefix as a live session's history (HMR/reload): verify the
   * seed covers the stored prefix, truncate any torn tail (NOT the open turn —
   * the live Session is still the authority), bind ownership, and persist the
   * live suffix that was ahead of the stored prefix.
   */
  private async adoptLivePrefix(session: Session, seed: readonly SessionEvent[], stored: StoredPrefix<TornMarker>): Promise<void> {
    const { meta, events, tornMarker } = stored
    this.assertStoredId(session.header.id, meta)
    if (meta.cwd !== session.header.cwd) {
      throw new Error(`session "${session.header.id}" is already persisted at a different cwd (persisted: ${String(meta.cwd)}, live: ${String(session.header.cwd)}) (id collision)`)
    }
    this.assertVersion(meta)
    const storedEvents = snapshotStoredEvents(events, session.header.id)
    this.assertEventsSupported(meta, storedEvents)
    if (!seedCoversPrefix(seed, storedEvents)) {
      throw new Error(`session "${session.header.id}" already has a persisted log on disk that does not match this live session (id collision)`)
    }
    // Truncate-only repair (no closers): the open turn is NOT closed here.
    if (tornMarker !== undefined) await this.backend.commitRepair(meta, tornMarker, [])
    this.states.set(session.header.id, {
      meta: { ...meta },
      cursor: storedEvents.length,
      materialized: true,
      owner: session,
    })
    const suffix = seed.slice(storedEvents.length)
    if (suffix.length > 0) await this.appendCore(session.header.id, suffix)
  }

  private async flush(session: Session): Promise<void> {
    const live = this.initFor(session)
    live.writes.cancelAutomaticWait()
    try {
      await live.init
    } catch (error: unknown) {
      // Admission is closed during retirement/teardown, but an ordinary flush
      // may have raced one last enqueue while initialization was pending.
      live.writes.cancelAutomaticWait()
      throw error
    }
    await live.writes.flush()
  }

  /** Build one package-private write controller around initialization and id serialization. */
  private createWriteBehind(session: Session, ready: () => Promise<void>): SessionWriteBehind {
    return new SessionWriteBehind({
      maxDelayMs: this.writeBatchMaxDelayMs,
      write: async (batch) => {
        await ready()
        await this.serialize(session.header.id, () => this.appendLiveBatch(session.header.id, batch))
      },
      reportBackgroundFailure: (error) => {
        this.ctx.logger.warn(`${this.backend.name}: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`)
      },
    })
  }

  /** Append one controller-owned prefix after filtering events initialization already stored. */
  private async appendLiveBatch(id: SessionId, batch: readonly SessionEvent[]): Promise<void> {
    const state = this.states.get(id)
    /* v8 ignore next -- state is always set by the awaited initialization */
    const cursor = state?.cursor ?? 0
    const fresh = batch.filter(e => e.seq >= cursor)
    await this.appendCore(id, fresh)
  }
}
