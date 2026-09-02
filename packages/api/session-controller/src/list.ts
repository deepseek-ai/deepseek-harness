/** Cold-safe Session list and search projection. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { SessionQueryError, type SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './types.ts'
import type {
  SessionListMetadata, SessionProjectionHints, SessionProjectionValues, SessionSearchItem,
  SessionSearchValue, SessionSummary,
} from './types.ts'

/** Default maximum stat-reported event count eligible for one cold projection observation. */
export const DEFAULT_COLD_BLANK_PROBE_MAX_EVENTS = 16

/** Default maximum stat-reported artifact size eligible for one cold projection observation. */
export const DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024

/** Resolved cold-blank probe policy: each threshold gates its stat metric; `0` disables that gate. */
export interface ColdBlankProbePolicy {
  /** Maximum stat-reported `eventCount` eligible for a full observation. */
  readonly coldBlankProbeMaxEvents: number
  /** Maximum stat-reported `sizeBytes` eligible for a full observation. */
  readonly coldBlankProbeMaxBytes: number
}

const COLD_SUMMARY_BATCH_SIZE = 16
const SEARCH_PROVIDER_CALL_LIMIT = 100
const SESSION_SEARCH_QUERY_MAX_CHARS = 500
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

const imageLimitsSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.string()),
}) as unknown as z.ZodType<ImageAttachmentLimits>

/**
 * Advance the Session-list metadata projection by one committed event.
 * @param state - metadata before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced metadata value.
 */
export function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - source text.
 * @param maximum - maximum number of Unicode code points.
 * @returns the source text or its longest allowed prefix.
 */
export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/** Owns list projection registration, bounded cold summaries, and authorized search. */
export class ApiSessionList {
  /**
   * @param ctx - Host context carrying Session, query, persistence, and projection services.
   * @param probe - stat-metadata thresholds gating a full cold observation.
   */
  constructor(
    private readonly ctx: Context,
    private readonly probe: ColdBlankProbePolicy,
  ) {
    ctx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      stateSchema: sessionListMetadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataSchema, view: state => state },
      stateVersion: 1,
    })
    ctx.inject(['attachments'], (attachmentCtx) => {
      ctx.sessionProjections.register<'imageLimits', null>({
        key: 'imageLimits',
        stateSchema: z.null(),
        init: () => null,
        apply: state => state,
        wire: {
          viewSchema: imageLimitsSchema,
          view: () => attachmentCtx.attachments.imageLimits,
        },
        stateVersion: 1,
      })
    })
  }

  /**
   * Build one current attached-Session summary.
   * @param session - attached Session to summarize.
   * @returns current list metadata and available projections.
   */
  summaryFor(session: Session): SessionSummary {
    const projections = this.projectionsFor(session.header, session)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: session.id,
      updatedAt: updatedAt(session.header, metadata),
      running: this.ctx.agents.get(session.id)?.status === 'running',
      blank: metadata?.blank ?? session.seq === 0,
      ...listFields(session.header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Read every visible attached and persisted Session without activating an Agent.
   * @param signal - optional cancellation for persistence reads.
   * @returns visible Session summaries ordered by activity.
   */
  async list(signal?: AbortSignal): Promise<SessionSummary[]> {
    signal?.throwIfAborted()
    const records = await this.ctx.sessionQuery.listSessions(signal)
    signal?.throwIfAborted()
    const items: SessionSummary[] = []
    const cold: SessionHeader[] = []
    for (const record of records) {
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        items.push(this.summaryFor(live))
        continue
      }
      if (record.header.cwd === undefined) continue
      cold.push(record.header)
    }
    for (let offset = 0; offset < cold.length; offset += COLD_SUMMARY_BATCH_SIZE) {
      const settled = await Promise.allSettled(cold.slice(offset, offset + COLD_SUMMARY_BATCH_SIZE)
        .map(header => this.summarizeCold(header, signal)))
      for (const result of settled) {
        if (result.status === 'rejected') throw result.reason
        items.push(result.value)
      }
    }
    items.sort((left, right) => right.updatedAt - left.updatedAt)
    return items
  }

  private async summarizeCold(
    header: SessionHeader,
    signal: AbortSignal | undefined,
  ): Promise<SessionSummary> {
    const cached = this.projectionsFor(header, undefined)
    const projections = cached?.values.sessionListMetadata?.blank === false
      ? cached
      : await this.probeSmallCold(header, signal) ?? cached
    const raced = this.ctx.sessions.get(header.id)
    if (raced !== undefined) return this.summaryFor(raced)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: header.id,
      updatedAt: updatedAt(header, metadata),
      running: false,
      // A large, metadata-less, or inaccessible cache miss remains unknown and visible.
      blank: metadata?.blank ?? false,
      ...listFields(header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  private async probeSmallCold(
    header: SessionHeader,
    signal: AbortSignal | undefined,
  ): Promise<SessionProjectionHints | undefined> {
    const { coldBlankProbeMaxEvents, coldBlankProbeMaxBytes } = this.probe
    if (coldBlankProbeMaxEvents === 0 && coldBlankProbeMaxBytes === 0) return undefined
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    signal?.throwIfAborted()
    let snapshot: Awaited<ReturnType<typeof persistence.stat>>
    try {
      snapshot = await persistence.stat(header.id, signal === undefined ? {} : { signal })
    } catch (error: unknown) {
      // An unreadable single session degrades to unknown state instead of
      // failing the whole list request.
      signal?.throwIfAborted()
      this.ctx.logger.warn(
        `api-session.list: cold stat for "${header.id}" failed; serving it as visible: ${String(error)}`,
      )
      return undefined
    }
    if (snapshot === undefined) return undefined
    if (snapshot.eventCount !== undefined) {
      if (coldBlankProbeMaxEvents === 0 || snapshot.eventCount > coldBlankProbeMaxEvents) return undefined
    } else if (snapshot.sizeBytes !== undefined) {
      if (coldBlankProbeMaxBytes === 0 || snapshot.sizeBytes > coldBlankProbeMaxBytes) return undefined
    } else {
      // The backend offers no cheap size hint, so a full observation is unbounded work.
      return undefined
    }
    try {
      using observation = await this.ctx.sessionQuery.observeSession(header.id, {
        ...(signal === undefined ? {} : { signal }),
        projectionMode: 'all',
      })
      const block = observation.projections
      return block === undefined
        ? undefined
        : { asOfSeq: block.asOfSeq, values: block.values as SessionProjectionValues }
    } catch (error: unknown) {
      signal?.throwIfAborted()
      this.ctx.logger.warn(
        `api-session.list: small cold observation for "${header.id}" failed; serving it as visible: ${String(error)}`,
      )
      return undefined
    }
  }

  /**
   * Search current visible message content without activating any matching Session.
   * @param query - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  async search(query: string, signal: AbortSignal): Promise<SessionSearchValue> {
    const normalizedQuery = normalizeSearchQuery(query)
    signal.throwIfAborted()
    const provider = this.ctx.get('sessionQuery')
    if (provider === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
        {},
      )
    }
    try {
      const visible = await provider.listSessions(signal)
      signal.throwIfAborted()
      const visibleIds = new Set(visible
        .filter(record => record.header.cwd !== undefined)
        .map(record => record.header.id))
      if (visibleIds.size === 0) return { items: [], hasMore: false }
      const authorized: SessionSearchItem[] = []
      const acceptedIds = new Set<SessionId>()
      const seenCursors = new Set<SessionSearchCursor>()
      let cursor: SessionSearchCursor | undefined
      let providerCalls = 0
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT
      while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
        signal.throwIfAborted()
        if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
          throw new Error(`session search provider exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`)
        }
        providerCalls++
        const requestedCursor = cursor
        const requestedLimit = pageLimit
        let page
        try {
          page = await provider.searchSessions({
            query: normalizedQuery,
            eventFilters: [
              { kind: 'type', values: ['user/message', 'assistant/message'] },
              { kind: 'surface', values: ['current'] },
            ],
            limit: requestedLimit,
            ...(requestedCursor === undefined ? {} : { cursor: requestedCursor }),
          }, { signal })
          signal.throwIfAborted()
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (requestedCursor === undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_INVALID_LIMIT'
            && requestedLimit > 1) {
            pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
            continue
          }
          if (requestedCursor !== undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_STALE_CURSOR') {
            authorized.length = 0
            acceptedIds.clear()
            seenCursors.clear()
            cursor = undefined
            continue
          }
          throw error
        }
        if (page.items.length > requestedLimit) {
          throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`)
        }
        for (const hit of page.items) {
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
          if (!visibleIds.has(hit.header.id)
            || hit.bestMatch.sessionId !== hit.header.id
            || hit.bestMatch.surface !== 'current'
            || !MESSAGE_TYPES.has(hit.bestMatch.type)
            || acceptedIds.has(hit.header.id)) continue
          acceptedIds.add(hit.header.id)
          authorized.push({
            sessionId: hit.header.id,
            snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
          })
        }
        if (page.nextCursor !== undefined) {
          if (seenCursors.has(page.nextCursor)) {
            throw new Error('session search provider repeated a continuation cursor')
          }
          seenCursors.add(page.nextCursor)
        }
        if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return {
        items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
        hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'session search was aborted', {})
      }
      throw new RemoteError('gateway/internal', `session search failed: ${String(error)}`, {})
    }
  }

  private projectionsFor(
    header: SessionHeader,
    session: Session | undefined,
  ): SessionProjectionHints | undefined {
    try {
      const block = session === undefined
        ? header.isSeeded
          ? undefined
          : this.ctx.get('sessionProjectionCache')?.cachedSnapshot(header, SessionLogOffset(0))
        : this.ctx.sessionProjections.cachedSnapshot(session)
      return block !== undefined && Object.keys(block.values).length > 0
        ? {
          asOfSeq: block.asOfSeq,
          // Listing hints contain every currently cached wire value but remain
          // partial: missing cells and cache rows are never materialized here.
          values: block.values as SessionProjectionValues,
        }
        : undefined
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${header.id}" failed; serving the row without it: ${String(error)}`,
      )
      return undefined
    }
  }
}

function normalizeSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) {
    throw new RemoteError('gateway/bad-request', 'session search query must not be empty', {})
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new RemoteError(
      'gateway/bad-request',
      `session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`,
      {},
    )
  }
  if (normalized.includes('\0')) {
    throw new RemoteError('gateway/bad-request', 'session search query must not contain NUL', {})
  }
  return normalized
}

function updatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

function listFields(header: SessionHeader): {
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
} {
  return {
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  }
}
