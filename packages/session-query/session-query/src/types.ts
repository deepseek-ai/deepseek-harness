/**
 * Public records for exact reads and relationship traces over the
 * live-preferred logical session corpus.
 *
 * @module @deepseek-ai/dsh-session-query/types
 */

import type {
  SessionEvent,
  SessionEventType,
  SessionHeader,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  OptionalSessionSeq,
  SurfaceEvent,
} from '@deepseek-ai/dsh-session'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import type { SessionSearchCursor } from './cursor.ts'

export type { SessionSearchCursor } from './cursor.ts'

/** Whether an event is current model context, replaced context, or raw-log-only. */
export type SessionEventSurface = 'current' | 'shadowed' | 'log-only'

/** Lightweight identity and source availability for one logical session. */
export interface SessionRecord {
  /** Cloned session header selected from the live-preferred corpus. */
  header: SessionHeader
  /** Whether the id currently exists in `ctx.sessions`. */
  live: boolean
  /** Whether the active persistence backend currently lists the id, including a created-but-unmaterialized session it already observes. */
  persisted: boolean
}

/** One atomic live-preferred observation of a session's current model surface. */
export interface SessionSurfaceSnapshot {
  /** Cloned session header selected from the same corpus observation as `events`. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Highest raw-log seq included in the observation, or `null` for an empty log. */
  capturedThroughSeq: OptionalSessionSeq
  /** Cloned current surface events in model-history order. */
  events: SurfaceEvent[]
}

/** One validated detached observation of a logical session's complete raw log. */
export interface SessionLogSnapshot {
  /** Cloned session header selected from the same observation as `events`. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Cloned contiguous raw events after in-memory interrupted-turn balancing and replay validation. */
  events: SessionEvent[]
}

/** Lightweight metadata for one event within a logical session. */
export interface SessionEventRecord {
  /** Session that owns the event. */
  sessionId: SessionId
  /** Monotonic event seq within the session. */
  seq: SessionSeq
  /** Discriminant of the session event. */
  type: SessionEventType
  /** Event timestamp in Unix epoch milliseconds. */
  time: number
  /** Event placement in the folded session surface. */
  surface: SessionEventSurface
}

/** Recursive descendant node in a session-lineage trace. */
export interface SessionLineageNode {
  /** Detached logical-corpus record for this descendant. */
  session: SessionRecord
  /** Direct children, each carrying its own recursive descendants. */
  descendants: SessionLineageNode[]
}

/** Known ancestry and descendants for one logical session. */
export type SessionLineageTrace = {
  /** Detached record for the session that was traced. */
  target: SessionRecord
  /** Known parents from the immediate parent outward. */
  ancestors: SessionRecord[]
  /** Complete known descendant trees rooted at the target's direct children. */
  descendants: SessionLineageNode[]
} & (
  | {
    /** The complete parent chain is present in the logical corpus. */
    complete: true
    /** Detached record at the top of the complete lineage. */
    root: SessionRecord
  }
  | {
    /** The parent chain leaves the visible logical corpus. */
    complete: false
    /** First parent id that is not present in the logical corpus. */
    unresolvedParentId: SessionId
  }
)

/** Request for direct surface replacements and relationships to cited source events around one event. */
export interface SessionEventTraceRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: SessionSeq
}

/** Direct surface replacements and relationships to cited source events for one event. */
export interface SessionEventTrace {
  /** Lightweight target record. */
  target: SessionEventRecord
  /** Immediate positional replacement event, when the target was shadowed. */
  replacedBy?: SessionSeq
  /** Positional replacers from the immediate replacement to the final replacement. */
  replacementChain: SessionSeq[]
  /** Surface nodes directly removed when the target itself performed a replacement. */
  replacedEventSeqs: SessionSeq[]
  /** Earlier events cited directly as sources, in their recorded order. */
  sourceEventSeqs: SessionSeq[]
  /** Later events that directly cite the target as a source, in log order. */
  derivedEventSeqs: SessionSeq[]
}

/** Event relationships bound to the same session-header observation. */
export interface SessionEventTraceObservation extends SessionEventTrace {
  /** Cloned header selected with the event log used for the trace. */
  session: SessionHeader
}

/** Request for one event plus raw neighboring log context. */
export interface SessionEventReadRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: SessionSeq
  /** Number of preceding raw events to include. */
  before?: number
  /** Number of following raw events to include. */
  after?: number
}

/** Full target event and a bounded raw-log window. */
export interface SessionEventWindow {
  /** Cloned header for the live-preferred source read. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Full cloned target event. */
  target: SessionEvent
  /** Full cloned events from `startSeq` through `endSeq`. */
  events: SessionEvent[]
  /** First seq included in `events`. */
  startSeq: SessionSeq
  /** Last seq included in `events`. */
  endSeq: SessionSeq
}

/** Latest folded title bound to the same session-header observation. */
export interface SessionTitleObservation {
  /** Cloned header selected with the event log used for the title fold. */
  session: SessionHeader
  /** Latest title snapshot, absent when the observed log has no title. */
  title?: SessionTitleSnapshot
}

/** One ordered result from a batch title observation. */
export type SessionTitleObservationResult =
  | {
    /** Requested session id. */
    sessionId: SessionId
    /** Successful atomic header/title observation. */
    status: 'fulfilled'
    /** Header and optional latest title from one logical source. */
    value: SessionTitleObservation
  }
  | {
    /** Requested session id. */
    sessionId: SessionId
    /** Operational failure isolated to this session. */
    status: 'rejected'
    /** Original failure from logical-source resolution or title folding. */
    reason: unknown
  }

/** Inclusive numeric interval used by time and sequence filters. */
export interface SessionResultRange {
  /** Inclusive lower bound. */
  from?: number
  /** Inclusive upper bound. */
  to?: number
}

/** Source availability predicates understood by logical-session filters. */
export type SessionAvailability = 'live' | 'persisted'

/**
 * One logical-session predicate. A filter array is ANDed; `values` within a
 * clause are ORed.
 */
export type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | ({ kind: 'created-at' } & SessionResultRange)
  | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly SessionAvailability[] }

/**
 * One event predicate. A filter array is ANDed; list-valued clauses are ORed.
 * Text is a literal, case-insensitive, whitespace-flexible semantic-text scan.
 */
export type SessionEventResultFilter =
  | ({ kind: 'seq' } & SessionResultRange)
  | ({ kind: 'time' } & SessionResultRange)
  | { kind: 'type'; values: readonly SessionEventType[] }
  | { kind: 'surface'; values: readonly SessionEventSurface[] }
  | { kind: 'text'; text: string }

/** Event predicates a full-text provider can apply before relevance ranking. */
export type SessionEventMetadataFilter = Exclude<SessionEventResultFilter, { kind: 'text' }>

/** Searchable semantic document derived from one session event. */
export interface SessionEventSearchDocument extends SessionEventRecord {
  /** First-party semantic text used by scan filters and full-text indexes. */
  text: string
}

/** One cursor-paginated result page. */
export interface SessionSearchPage<T> {
  /** Results for this page in contract-defined order. */
  items: readonly T[]
  /** Opaque continuation cursor, absent on the final page. */
  nextCursor?: SessionSearchCursor
}

/** Event-search results bound to the indexed target-session observation. */
export interface SessionEventSearchPage extends SessionSearchPage<SessionEventSearchHit> {
  /** Cloned target header from the same indexed generation as `items`. */
  session: SessionHeader
}

/** Controls shared by cross-session and within-session search calls. */
export interface SessionSearchExecContext {
  /** Abort caller waiting and interrupt provider work where supported. */
  signal?: AbortSignal
}

/** Cross-session full-text search request. */
export interface SessionSearchRequest {
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string
  /** Logical-session predicates applied before event ranking. */
  sessionFilters?: readonly SessionResultFilter[]
  /** Event predicates applied before event ranking. */
  eventFilters?: readonly SessionEventMetadataFilter[]
  /** Maximum sessions in this page. */
  limit?: number
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor
}

/** Within-session full-text search request. */
export interface SessionEventSearchRequest {
  /** Session whose live-preferred logical log is searched. */
  sessionId: SessionId
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string
  /** Event predicates applied before ranking. */
  filters?: readonly SessionEventMetadataFilter[]
  /** Maximum events in this page. */
  limit?: number
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor
}

/** One event full-text search hit with a bounded plain-text excerpt. */
export interface SessionEventSearchHit extends SessionEventRecord {
  /** Plain text excerpt selected around the match. */
  snippet: string
}

/** One grouped cross-session hit, ranked by its strongest matching event. */
export interface SessionSearchHit extends SessionRecord {
  /** Strongest matching event for this session. */
  bestMatch: SessionEventSearchHit
}
