/** Message store with per-chat monotonic `seq`, retention, and `ctx.im.history`. */
import type { Context } from '@deepseek-ai/cordis'
import {
  ImMessageKey, ImSourceId, type ImChat, type ImChatKey, type ImConfig, type ImHistory, type ImMessage, type ImOutcome,
} from './api.ts'
import { ImError } from './error.ts'
import { imDomain, type ImDomain, type StoredChat, type StoredEvent, type StoredMessage } from './state.ts'

/** A message about to be stored; the store assigns `seq` (and keeps `key` stable on redelivery). */
export type ImMessageDraft = Omit<ImMessage, 'seq'>

/** Dispatch bookkeeping of one stored inbound message. */
export interface ImDispatchState {
  message: ImMessage
  dispatch: 'pending' | 'done' | 'none'
  outcome?: ImOutcome
}

/** Outcomes kept in memory for `ctx.im.status().recent` (diagnostics only, never persisted). */
const RECENT_OUTCOMES = 100

const noop = () => {}

/**
 * Byte size of one message-shaped value, the one unit `maxInputBytes` bounds: the draft the intake accepts and the
 * delivery intent a session records. Both measure the JSON they are going to store. An intent repeats the messages it
 * carries in addition to its own fields, so the intake reserves that overhead when it measures a draft.
 * @param value - the draft, intent or stored record to measure.
 * @returns its UTF-8 JSON size in bytes.
 */
export function inputBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

/**
 * Durable message store.
 *
 * Every write goes through {@link ImStore.serialize}, so the check-then-write sequences (idempotency per key, the
 * per-chat `seq` counter, `maxRecords` eviction) never interleave even when two callers race a redelivery. Reads are
 * synchronous against the in-memory mirror of the `im_messages` domain, which is what `ctx.im.history` needs.
 *
 * Invariants:
 * - `seq` is assigned from the durable per-chat counter and the counter is written before the message, so a crash
 *   between the two writes leaves a gap but never a duplicate.
 * - A message key is stored at most once: a redelivery (or a repeated `send` announcement) returns the stored record.
 * - `pending` records are never evicted or expired — the dispatch loop re-dispatches them after a restart.
 */
export class ImStore implements ImHistory {
  /** Open domain; set by {@link start}. */
  domain: ImDomain | undefined

  private readonly chats = new Map<ImChatKey, StoredChat>()
  private readonly events = new Map<string, StoredEvent>()
  private readonly records = new Map<ImMessageKey, StoredMessage>()
  /** Maps `${botId}|${alias}` to the canonical `ImMessageKey` for platforms with dual message ids (e.g. QQ `msg_idx`). */
  private readonly aliases = new Map<ImMessageKey, ImMessageKey>()
  /** Per chat, seq-ascending; every entry has a record in {@link records}. */
  private readonly chatMessages = new Map<ImChatKey, ImMessage[]>()
  private readonly recentOutcomes: { key: ImMessageKey; outcome: ImOutcome; at: number }[] = []
  /** The single write chain (see {@link serialize}). */
  private chain: Promise<void> = Promise.resolve()

  constructor(readonly ctx: Context, readonly config: ImConfig) {}

  /** Open `imDomain` via `ctx.storageDomain` and load chats/counters (called once from `ImService[Service.init]`). */
  async start(): Promise<void> {
    const domain = await this.ctx.storageDomain.open(imDomain)
    this.domain = domain
    for (const [key, chat] of domain.table('chats').entries()) this.chats.set(key, chat)
    for (const [key, event] of domain.table('events').entries()) this.events.set(key, event)
    for (const [key, record] of domain.table('messages').entries()) {
      this.records.set(key, record)
      this.indexAliases(record.message)
      const messages = this.chatMessages.get(record.message.chat.key)
      if (messages) messages.push(record.message)
      else this.chatMessages.set(record.message.chat.key, [record.message])
    }
    // The medium keeps insertion order, not seq order: a redelivered-after-restart chat must still be seq-ascending.
    for (const messages of this.chatMessages.values()) messages.sort((left, right) => left.seq - right.seq)
  }

  /** Close the domain. */
  async dispose(): Promise<void> {
    await this.chain
    const domain = this.domain
    this.domain = undefined
    if (domain) await domain.close()
    this.chats.clear()
    this.events.clear()
    this.records.clear()
    this.aliases.clear()
    this.chatMessages.clear()
  }

  /**
   * Register or refresh a chat identity (source attribution of the first admitting rule).
   * @param chat - the chat identity to persist; an unchanged record is not rewritten.
   */
  async touchChat(chat: ImChat): Promise<void> {
    if (this.isCurrent(chat)) return
    await this.serialize(async () => {
      // Re-check and read the counter inside the serialized job: a queued put() advances it, and writing a seq read
      // before the queue would roll the chat's counter back so the next put reuses a number already handed out.
      if (this.isCurrent(chat)) return
      const known = this.chats.get(chat.key)
      const record: StoredChat = {
        key: chat.key,
        bot: chat.bot,
        ref: { ...chat.ref },
        source: chat.source,
        seq: known?.seq ?? 0,
        updatedAt: Date.now(),
      }
      await this.domainOf().table('chats').put(chat.key, record)
      this.chats.set(chat.key, record)
    })
  }

  /**
   * The retained identity of one admitted chat.
   * @param key - the chat key.
   * @returns the chat record rebuilt from the stored chat, or undefined when the chat was never admitted.
   */
  chat(key: ImChatKey): ImChat | undefined {
    const record = this.chats.get(key)
    if (!record) return undefined
    return { key: record.key, bot: record.bot, ref: { ...record.ref }, source: ImSourceId(record.source) }
  }

  /**
   * Store a message (inbound with `dispatch: 'pending'`, own outbound/edits with `'none'`), assigning the next seq
   * of its chat; idempotent per key (returns the stored record). Emits `im/stored`. Enforces `maxRecords`.
   * @param draft - the message without its seq; the store assigns the next seq of the chat.
   * @param dispatch - `pending` for an inbound message awaiting the waterfall, `none` for own outbound messages.
   * @returns the stored message (with its seq), including the already-stored record on a redelivery.
   */
  put(draft: ImMessageDraft, dispatch: 'pending' | 'none'): Promise<ImMessage> {
    return this.serialize(async () => {
      const known = this.records.get(draft.key)
      if (known) {
        if (dispatch === 'pending' && known.dispatch === 'none' && known.message.via !== 'self') {
          const promoted: StoredMessage = { ...known, dispatch: 'pending' }
          await this.domainOf().table('messages').put(draft.key, promoted)
          this.records.set(draft.key, promoted)
        }
        return known.message
      }
      const domain = this.domainOf()
      await this.evict(domain, draft.chat.key)
      const storedAt = Date.now()
      const seq = (this.chats.get(draft.chat.key)?.seq ?? 0) + 1
      const message: ImMessage = { ...draft, seq }
      const chat: StoredChat = {
        key: draft.chat.key,
        bot: draft.chat.bot,
        ref: { ...draft.chat.ref },
        source: draft.chat.source,
        seq,
        updatedAt: storedAt,
      }
      // Counter first: a crash in between leaves a seq gap, never a duplicate.
      await domain.table('chats').put(chat.key, chat)
      this.chats.set(chat.key, chat)
      const record: StoredMessage = { message, dispatch, storedAt }
      await domain.table('messages').put(draft.key, record)
      this.records.set(draft.key, record)
      this.indexAliases(message)
      const messages = this.chatMessages.get(draft.chat.key)
      if (messages) messages.push(message)
      else this.chatMessages.set(draft.chat.key, [message])
      this.ctx.emit('im/stored', message)
      return message
    })
  }

  /**
   * Record the waterfall outcome (exactly-once bookkeeping).
   * @param key - the stored message the outcome belongs to.
   * @param outcome - what the `im/message` waterfall settled on.
   */
  settle(key: ImMessageKey, outcome: ImOutcome): Promise<void> {
    return this.serialize(async () => {
      const record = this.records.get(key)
      if (!record) throw new ImError('persistence', `IM message ${key} is no longer stored.`)
      const next: StoredMessage = { ...record, dispatch: 'done', outcome }
      await this.domainOf().table('messages').put(key, next)
      this.records.set(key, next)
      this.recentOutcomes.push({ key, outcome, at: Date.now() })
      if (this.recentOutcomes.length > RECENT_OUTCOMES) {
        this.recentOutcomes.splice(0, this.recentOutcomes.length - RECENT_OUTCOMES)
      }
    })
  }

  /**
   * Inbound messages still awaiting dispatch, in (chat, seq) order — re-dispatched after restart.
   * @returns the pending dispatch states the pump drains, chats in parallel and seq-ascending inside a chat.
   */
  pending(): ImDispatchState[] {
    const states: ImDispatchState[] = []
    for (const record of this.records.values()) {
      if (record.dispatch === 'pending') states.push({ message: record.message, dispatch: record.dispatch })
    }
    return states.sort((left, right) =>
      left.message.chat.key.localeCompare(right.message.chat.key) || left.message.seq - right.message.seq)
  }

  /**
   * Dispatch state of one stored message.
   * @param key - the message key.
   * @returns its dispatch state and outcome so far, or undefined when the record was evicted or expired.
   */
  state(key: ImMessageKey): ImDispatchState | undefined {
    return this.records.get(key)
  }

  /**
   * Recent outcomes for `status()`.
   * @param limit - the newest outcomes to return.
   * @returns up to `limit` recorded outcomes, oldest first (diagnostics only, never persisted).
   */
  recent(limit: number): { key: ImMessageKey; outcome: ImOutcome; at: number }[] {
    return this.recentOutcomes.slice(Math.max(0, this.recentOutcomes.length - limit))
  }

  /**
   * Dedupe record of one platform event (`undefined` before its first delivery).
   * @param key - the event key `${botId}|${eventId ?? messageId}`.
   * @returns the recorded event, whose digest says whether a redelivery drifted from the delivery it recorded.
   */
  event(key: string): StoredEvent | undefined {
    return this.events.get(key)
  }

  /**
   * Remember one platform event durably; the intake ACKs only after this resolves.
   * @param key - the event key `${botId}|${eventId ?? messageId}`.
   * @param event - the digest, optional stored message key and receipt time to keep.
   */
  remember(key: string, event: StoredEvent): Promise<void> {
    return this.serialize(async () => {
      await this.domainOf().table('events').put(key, event)
      this.events.set(key, event)
    })
  }

  /**
   * Expire records older than `retentionMs` (never pending ones).
   * @param now - the current time in ms; records stored before `now - retentionMs` are dropped.
   */
  sweep(now: number): Promise<void> {
    return this.serialize(async () => {
      const domain = this.domainOf()
      const cutoff = now - this.config.retentionMs
      const expiredMessages: ImMessage[] = []
      for (const record of this.records.values()) {
        if (record.dispatch !== 'pending' && record.storedAt < cutoff) expiredMessages.push(record.message)
      }
      if (expiredMessages.length > 0) {
        await domain.table('messages').deleteMany(expiredMessages.map(message => message.key))
        for (const message of expiredMessages) {
          this.records.delete(message.key)
          this.dropAliases(message)
        }
        // Rebuild the per-chat indexes from the survivors; they are short (bounded by maxRecords) and seq-ascending.
        for (const messages of this.chatMessages.values()) {
          const kept = messages.filter(message => this.records.has(message.key))
          if (kept.length === messages.length) continue
          messages.length = 0
          messages.push(...kept)
        }
      }
      // Dedupe receipts outlive nothing: once their retention passed, a redelivery is a new delivery.
      const expiredEvents: string[] = []
      for (const [key, event] of this.events) {
        if (event.receivedAt < cutoff) expiredEvents.push(key)
      }
      if (expiredEvents.length > 0) {
        await domain.table('events').deleteMany(expiredEvents)
        for (const key of expiredEvents) this.events.delete(key)
      }
    })
  }

  after(chat: ImChatKey, seq: number, limit: number, keep?: (message: ImMessage) => boolean): ImMessage[] {
    const messages = this.chatMessages.get(chat)
    if (!messages || limit <= 0) return []
    const start = firstIndexAfter(messages, seq)
    if (keep === undefined) return messages.slice(start, start + limit)
    const out: ImMessage[] = []
    for (const message of messages.slice(start)) {
      if (keep(message)) out.push(message)
      if (out.length === limit) break
    }
    return out
  }

  before(chat: ImChatKey, seq: number, limit: number, keep?: (message: ImMessage) => boolean): ImMessage[] {
    const messages = this.chatMessages.get(chat)
    if (!messages || limit <= 0) return []
    const end = firstIndexAfter(messages, seq - 1)
    if (keep === undefined) return messages.slice(Math.max(0, end - limit), end)
    const out: ImMessage[] = []
    for (const message of messages.slice(0, end).reverse()) {
      if (keep(message)) out.unshift(message)
      if (out.length === limit) break
    }
    return out
  }

  /**
   * Look up a stored message by canonical `key` or by any recorded platform `aliases` key (`bot|alias`).
   * Callers scoping lookups to one chat must verify `message.chat.key`.
   */
  get(key: ImMessageKey): ImMessage | undefined {
    const direct = this.records.get(key)?.message
    if (direct !== undefined) return direct
    const canonical = this.aliases.get(key)
    return canonical === undefined ? undefined : this.records.get(canonical)?.message
  }

  latest(chat: ImChatKey): ImMessage | undefined {
    const messages = this.chatMessages.get(chat)
    if (!messages || messages.length === 0) return undefined
    return messages[messages.length - 1]
  }

  /** The open domain, or a typed failure when a write outlives {@link dispose} (or precedes {@link start}). */
  private domainOf(): ImDomain {
    if (!this.domain) throw new ImError('unavailable', 'The IM message store is not open.')
    return this.domain
  }

  /** Run one write on the store's chain; the chain itself never rejects. */
  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job)
    this.chain = result.then(noop, noop)
    return result
  }

  /** Drop the oldest settled messages of a chat until one more fits under `maxRecords`. */
  private async evict(domain: ImDomain, chat: ImChatKey): Promise<void> {
    const messages = this.chatMessages.get(chat)
    if (!messages) return
    while (messages.length >= this.config.maxRecords) {
      const victim = messages.find(message => this.records.get(message.key)?.dispatch !== 'pending')
      if (!victim) {
        throw new ImError(
          'capacity',
          `IM chat ${chat} holds ${messages.length} messages that are all awaiting dispatch; `
          + 'resolve the pending work or raise maxRecords.',
        )
      }
      await domain.table('messages').delete(victim.key)
      this.records.delete(victim.key)
      this.dropAliases(victim)
      messages.splice(messages.indexOf(victim), 1)
    }
  }

  private indexAliases(message: ImMessage): void {
    for (const alias of message.aliases ?? []) {
      this.aliases.set(ImMessageKey(message.chat.bot, alias), message.key)
    }
  }

  private dropAliases(message: ImMessage): void {
    for (const alias of message.aliases ?? []) {
      this.aliases.delete(ImMessageKey(message.chat.bot, alias))
    }
  }

  /** Whether the stored chat record already describes this identity. */
  private isCurrent(chat: ImChat): boolean {
    const known = this.chats.get(chat.key)
    return known !== undefined && known.bot === chat.bot && known.source === chat.source
      && known.ref.id === chat.ref.id && known.ref.type === chat.ref.type && known.ref.name === chat.ref.name
  }
}

/** Index of the first message whose seq is greater than `seq` (messages are seq-ascending, per chat and bounded). */
function firstIndexAfter(messages: readonly ImMessage[], seq: number): number {
  let index = 0
  for (const message of messages) {
    if (message.seq > seq) break
    index += 1
  }
  return index
}
