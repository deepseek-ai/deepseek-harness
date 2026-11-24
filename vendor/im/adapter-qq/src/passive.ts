/**
 * Passive replies of the QQ official bot: the window and the budget the platform grants to *answer* an inbound event.
 *
 * The platform only accepts a reply without a quota when it carries the id of the event it answers: `msg_id` of a
 * 群聊/单聊 message, or `event_id` of a button click (`INTERACTION_CREATE`). That id is good for a fixed window and a
 * fixed number of replies — 5 minutes / 5 replies for a group, 60 minutes / 4 replies for C2C — and every reply must
 * be numbered with a `msg_seq` that is unique per id, because the platform deduplicates `(msg_id, msg_seq)` and
 * answers the second use with `40054005`.
 *
 * {@link PassiveManager} books that per-event state: `{ receivedAt, used }` keyed by the passive id, `msg_seq =
 * seqBase + used++`, and the window/budget coming from `config.passive`. Two consequences the rest of the adapter
 * follows:
 *
 * - When the window is closed or the budget spent, {@link PassiveManager.claim} answers `undefined` and
 * `sendPayload` sends *actively* (no `msg_id`) — the platform then applies its 主动 quota instead, and the errors
 * of that path (`22009`, `40034100`, `40054002` …) classify into `rate-limit` / `permission`.
 * - `msg_seq` must survive a retry: the sequence is the only idempotency primitive QQ offers (there is no `uuid`
 * like Lark's), so the same logical part re-claims the sequence it was given the first time
 * ({@link PassiveTicket.reused}), and only a genuine `40054005` moves on to the next one.
 *
 * Local decision: `receivedAt` is the moment this process decoded the event, while the platform starts the window at
 * the event's own timestamp — the two differ by the intake latency (one gateway round trip, normally well under a
 * second). The manager therefore closes the window {@link WINDOW_MARGIN_MS} early, exactly like the reference
 * implementation (`adapter-qq`'s `MSG_TIMEOUT = 5 min - 2 s`), so a reply is never attempted against an id the
 * platform has already forgotten (that would answer `304103` / `40034005` and be lost).
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/passive
 */

import type { Target } from '@deepseek-ai/cordis-plugin-im-core'
import type { PassiveConfig } from './config.ts'
import { passiveKey, readQQReferrer, type QQReferrer } from './decode.ts'

/**
 * Head start with which a passive window is closed, in milliseconds: the platform counts from the inbound event's
 * timestamp, this process from the moment it decoded it (module documentation).
 */
export const WINDOW_MARGIN_MS = 2 * 1000

/** Chat types of v1 : 群聊 and 单聊 only, each with its own window and budget. */
export type PassiveChatType = 'group' | 'direct'

/** One booked passive reply: the body fields `sendPayload` fills in . */
export interface PassiveTicket {
  /** `group` or `direct`, which selects the window and the budget. */
  chatType: PassiveChatType
  /** `ChatRef.id` of the chat the id belongs to (`group:<openid>` / `user:<openid>`, ). */
  chatId: string
  /** The passive id itself: `msg_id` of the inbound message, or `event_id` of the click. */
  key: string
  /** Body field that carries {@link PassiveTicket.key} . */
  field: 'msg_id' | 'event_id'
  /** `msg_seq` of this reply: strictly increasing per {@link PassiveTicket.key}. */
  seq: number
  /** Epoch ms after which the platform no longer accepts this id. */
  until: number
  /**
 * Whether the sequence was already booked for the same idempotency key, i.e. this is a retry of a part that was
 * attempted before: the send reuses the sequence instead of spending a new one.
 */
  reused: boolean
}

/** Options of {@link PassiveManager.claim}. */
export interface PassiveClaimOptions {
  /** Idempotency key of the logical part (`<key>:<index>`); a repeated claim returns the same sequence. */
  idempotencyKey?: string
  /** Book the *next* sequence even when the idempotency key already has one (the `40054005` retry, ). */
  fresh?: boolean
}

export interface PassiveManagerOptions {
  /** Windows, budgets and `msg_seq` base of `config.passive` . */
  config: PassiveConfig
  /** Clock; injected by tests. */
  now?: () => number
  /**
   * Soft bound on booked windows kept at once (default 256): expired windows are reaped first, then the oldest
   * un-ticketed windows are evicted above this limit. Live windows holding `idempotencyKey` tickets are retained until
   * `until` expires, so active memory is bounded by window lifetime (5 min group / 60 min C2C).
   */
  max?: number
}

/** The booked state of one passive id . */
interface PassiveEntry {
  chatType: PassiveChatType
  chatId: string
  key: string
  field: 'msg_id' | 'event_id'
  /** Epoch ms after which the window is closed. */
  until: number
  /** Replies already booked. */
  used: number
  /** Idempotency key → the sequence it was given, so a retried part reuses it. */
  tickets: Map<string, number>
}

/** Default soft bound of booked windows (`PassiveManagerOptions.max`); ticketed live windows are retained until `until`. */
const DEFAULT_MAX_WINDOWS = 256

/** The map key of one passive id: ids are chat-scoped in the platform's dedupe, so the chat is part of it. */
function entryId(chatId: string, key: string) {
  return `${chatId}|${key}`
}

/**
 * Passive-reply bookkeeping of one adapter.
 *
 * Every method is synchronous and side-effect free apart from the booking itself: {@link PassiveManager.remaining}
 * answers without consuming budget, and only {@link PassiveManager.claim} — called by `sendPayload` right before the
 * request — spends a reply.
 */
export class PassiveManager {
  private readonly entries = new Map<string, PassiveEntry>()
  private readonly config: PassiveConfig
  private readonly now: () => number
  private readonly max: number

  constructor(options: PassiveManagerOptions) {
    this.config = options.config
    this.now = options.now ?? Date.now
    this.max = options.max ?? DEFAULT_MAX_WINDOWS
  }

  /** Booked windows currently kept (diagnostics and tests). */
  get size(): number {
    return this.entries.size
  }

  /**
   * Replies the platform still accepts for one referrer, without booking anything.
   *
   * @param referrer - the decoded referrer, or `undefined` when the target carries none.
   * @returns the replies left inside the open window; `0` when the window is closed, its budget is spent, or the
   * referrer carries no passive id.
   */
  remaining(referrer: QQReferrer | undefined): number {
    if (!referrer) return 0
    const key = passiveKey(referrer)
    if (!key) return 0
    if (this.now() >= this.until(referrer)) return 0
    const entry = this.entries.get(entryId(referrer.chatId, key))
    return Math.max(0, this.budget(referrer.chatType) - (entry?.used ?? 0))
  }

  /**
   * Whether `claim(referrer, { idempotencyKey })` would produce a passive ticket (carrying `(msg_id, msg_seq)` dedupe)
   * without mutating state. Active sends (when no passive ticket is available) have no platform dedupe field.
   */
  canClaim(referrer: QQReferrer | undefined, idempotencyKey: string | undefined): boolean {
    if (!referrer || idempotencyKey === undefined) return false
    const key = passiveKey(referrer)
    if (!key) return false
    if (this.now() >= this.until(referrer)) return false
    const entry = this.entries.get(entryId(referrer.chatId, key))
    if (entry?.tickets.has(idempotencyKey)) return true
    return (entry?.used ?? 0) < this.budget(referrer.chatType)
  }

  /**
 * Book the next passive reply of one referrer, or answer that the adapter must publish actively.
 *
 * The first call of a window books `seqBase`, the next one `seqBase + 1`, and so on, so the sequence is never
 * reused inside one window (the platform deduplicates `(msg_id, msg_seq)`).
 *
 * @param referrer - the decoded referrer of the event being answered.
 * @param options - idempotency key (a retried part reuses its sequence) and `fresh` (the dedupe retry).
 * @returns the ticket, or `undefined` when the window is closed, the budget is spent, or the referrer has no
 * passive id at all.
 */
  claim(referrer: QQReferrer, options: PassiveClaimOptions = {}): PassiveTicket | undefined {
    const key = passiveKey(referrer)
    if (!key) return undefined
    const until = this.until(referrer)
    if (this.now() >= until) return undefined
 // `msg_id` wins when both exist (a click carries only `event_id`), matching `passiveKey`.
    const field: PassiveTicket['field'] = referrer.msg_id ? 'msg_id' : 'event_id'
    const entry = this.touch(referrer, key, field, until)
    if (options.idempotencyKey && !options.fresh) {
      const existing = entry.tickets.get(options.idempotencyKey)
      if (existing !== undefined) {
        return {
          chatType: entry.chatType,
          chatId: entry.chatId,
          key: entry.key,
          field: entry.field,
          seq: existing,
          until: entry.until,
          reused: true,
        }
      }
    }
    if (entry.used >= this.budget(entry.chatType)) return undefined
    entry.used += 1
    const seq = this.config.seqBase + entry.used - 1
    if (options.idempotencyKey) entry.tickets.set(options.idempotencyKey, seq)
    return {
      chatType: entry.chatType,
      chatId: entry.chatId,
      key: entry.key,
      field: entry.field,
      seq,
      until: entry.until,
      reused: false,
    }
  }

  /** Forget every booked window (a fresh token, a reconnect, or a test). */
  reset(): void {
    this.entries.clear()
  }

  /** Window length of a chat type, minus the safety margin (module documentation). */
  private windowMs(chatType: PassiveChatType) {
    const configured = chatType === 'group' ? this.config.groupWindowMs : this.config.c2cWindowMs
    return Math.max(0, configured - WINDOW_MARGIN_MS)
  }

  /** Replies the platform accepts per event of a chat type . */
  private budget(chatType: PassiveChatType) {
    return chatType === 'group' ? this.config.groupReplies : this.config.c2cReplies
  }

  /** Epoch ms at which the window of a referrer closes. */
  private until(referrer: QQReferrer) {
    return referrer.receivedAt + this.windowMs(referrer.chatType)
  }

  /** The booked state of a referrer, created on first use; refreshes its recency and prunes expired windows. */
  private touch(referrer: QQReferrer, key: string, field: PassiveTicket['field'], until: number) {
    const id = entryId(referrer.chatId, key)
    const existing = this.entries.get(id)
    if (existing) {
 // Insertion order is the recency order of the LRU bound below.
      this.entries.delete(id)
      this.entries.set(id, existing)
      return existing
    }
    const entry: PassiveEntry = {
      chatType: referrer.chatType,
      chatId: referrer.chatId,
      key,
      field,
      until,
      used: 0,
      tickets: new Map(),
    }
    this.entries.set(id, entry)
    this.shrink(id)
    return entry
  }

  /**
   * Drop closed windows, then the oldest un-ticketed ones above the bound. Live windows holding `idempotencyKey`
   * tickets are retained until their window expires so an in-flight retry never loses its `(msg_id, msg_seq)` dedupe.
   *
   * @param keep - the window that was just booked; it was inserted last, so it is the newest entry of the map and is
   * never the one dropped.
   */
  private shrink(keep: string) {
    const now = this.now()
    for (const [id, entry] of this.entries) {
      if (id !== keep && now >= entry.until) this.entries.delete(id)
    }
    if (this.entries.size <= this.max) return
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.max) break
      if (id === keep || entry.tickets.size > 0) continue
      this.entries.delete(id)
    }
  }
}

/**
 * The referrer of a target, when it belongs to that chat.
 *
 * A passive id is only valid in the chat it was received in (the platform scopes `msg_id` to the conversation), so a
 * referrer that names another chat is ignored instead of being sent to the wrong route.
 *
 * @param target - target chat and its adapter-private referrer.
 * @returns the referrer, or `undefined` when there is none or it belongs to another chat.
 */
export function referrerOf(target: Target): QQReferrer | undefined {
  const referrer = readQQReferrer(target.referrer)
  if (!referrer) return undefined
  return referrer.chatId === target.chat.id ? referrer : undefined
}
