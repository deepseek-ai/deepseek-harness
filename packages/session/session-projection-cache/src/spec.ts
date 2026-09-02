/**
 * The projection-cache domain declaration: one `sessions` table keyed by
 * {@link SessionId}, each record the full projection checkpoint for one
 * session (`key → {ver, seq, val}` rows). The spec object is the single
 * source of the domain's identity, version, layout, and record schema; the
 * storage-domain routing decides the medium (the shipped composition's json
 * backend stores the domain `per-record`: one document per session under
 * `<root>/session_projcache/sessions/`, so a checkpoint write rewrites one
 * session's document instead of the whole unit).
 * @module @deepseek-ai/dsh-session-projection-cache/src/spec
 */

import { z } from 'zod'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * One persisted checkpoint row (the RFC's `(sessionId, key, ver, seq, val)`
 * minus the two record keys). `val` is the unit's internal state — plain
 * JSON by the unit contract; `z.json()` enforces that at the durable
 * boundary. A row is never wrong, only possibly stale: `seq` says exactly
 * how stale, and a `ver` mismatch against the live unit's `stateVersion`
 * discards it at read time (never a migration).
 */
export const checkpointRow = z.object({
  ver: z.number().int().nonnegative(),
  seq: z.number().int().gte(-1).transform((value): SessionSeqCursor =>
    value === -1 ? -1 : SessionSeq(value)),
  val: z.json(),
})

/**
 * The stored-log identity a record is bound to: the immutable header fields
 * that distinguish one session lifecycle from another under the same id. A
 * session id names a slot, not a lifecycle — a deleted-then-recreated id, or
 * a persistence root swapped under a surviving cache, would otherwise let an
 * old record pass every watermark check and seed state folded from an
 * unrelated log. Reads validate this against the live header (listing) or
 * the stored header (cold read) before accepting any record.
 */
export const checkpointIdentity = z.object({
  createdAt: z.number().int().nonnegative(),
  cwd: z.string().optional(),
  isSeeded: z.boolean(),
  inheritedEventCount: z.number().int().nonnegative().transform(SessionLogOffset),
})

/** The identity fields a record is bound to, inferred from {@link checkpointIdentity}. */
export type CheckpointIdentity = z.infer<typeof checkpointIdentity>

/**
 * One session's stored record: the log identity it was folded from plus its
 * checkpoint rows keyed by projection key. The whole record is replaced on
 * every write (whole-value discipline — the registry checkpoint is always
 * the complete per-session cut).
 */
export const checkpointRecord = z.object({
  identity: checkpointIdentity,
  rows: z.record(z.string(), checkpointRow),
})

/** One stored per-session checkpoint record, inferred from {@link checkpointRecord}. */
export type CheckpointRecord = z.infer<typeof checkpointRecord>

/**
 * The session-projcache domain spec. The `per-record` layout scopes version
 * bumps per session: after a bump, a stale session document is discarded on
 * open (cache semantics — a stale or unreadable cache costs a longer tail
 * replay, never a wrong value) while the rest of the domain stays usable,
 * instead of rejecting the whole medium.
 */
export const projectionCacheDomainSpec = defineDomain({
  name: 'session_projcache',
  version: 5,
  layout: 'per-record',
  tables: { sessions: domainTable<SessionId, CheckpointRecord>(checkpointRecord) },
})
