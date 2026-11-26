/**
 * `ctx.im.sessions`: session records keyed by owner-defined keys (storage domain `im_sessions`), durable delivery
 * intents with inbox dedupe and restart recovery, bindings, reset, stop, parent-chain lookup, and ephemeral disposal.
 *
 * Delivery protocol: the intent is recorded (`admitted: false`) before anything touches an agent; admission opens
 * the agent, checks the durable session log for an inbox insertion with the delivery's message id (only for intents
 * that may predate this process), inserts it with the delivery's mode, flushes the log and marks the intent admitted.
 * A crash anywhere in between re-runs admission on {@link ImSessionHost.start}/{@link ImSessionHost.retry}, and the log
 * check keeps the inbox free of duplicates.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type {
  ImBinding, ImChatKey, ImConfig, ImDelivery, ImMessage, ImResetOptions, ImSessionFilter, ImSessionRecord, ImSessions,
  ImSessionSpec,
} from './api.ts'
import { ImError } from './error.ts'
import type { ImFormatter } from './format.ts'
import { sessionIdOf, type ImAgentHost } from './hosting.ts'
import { runKeyed, WriteQueue } from './serial.ts'
import { isStoredMessage, isStoredRecord, storedChatKey, storedSessionId } from './state.ts'
import { inputBytes } from './store.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** IM input admitted by `ctx.im.sessions.deliver`. @persistenceAttribution */
    im: { kind: 'im' } & ContextFormed
  }
}

/** What the session host needs: the agent host that opens live agents and the formatter of delivered messages. */
export interface ImSessionHostDeps {
  agents: ImAgentHost
  /** The one formatting call the delivery path makes (style `xml`, media per `delivery.media`). */
  formatter: Pick<ImFormatter, 'format'>
}

/** One durable delivery intent, keyed `${sessionId}|${delivery.id}`. */
export interface StoredDelivery {
  session: SessionId
  delivery: ImDelivery
  createdAt: number
  admitted: boolean
}

/** One durable reset receipt, keyed `${key}|${operationId}`. */
export interface StoredReset {
  /** Session id of the generation this reset targeted for replacement. */
  replaced: SessionId
  /** Generation `replaced` belonged to, so an unfinished advance completes on replay while a committed one is not repeated. */
  fromGeneration: number
  createdAt: number
}

/** One stored binding: the chat, its write grant and the two placement flags. */
const bindingSchema = z.object({
  chat: storedChatKey, writable: z.boolean(),
  home: z.exactOptional(z.boolean()), thread: z.exactOptional(z.string()),
})

/** Stored composition: the agent preset a session runs, plus its optional tool restriction. */
const compositionSchema = z.object({
  agentPreset: z.string(), cwd: z.string(), provider: z.string(), model: z.string(),
  restrict: z.exactOptional(z.object({
    allow: z.exactOptional(z.array(z.string())), deny: z.exactOptional(z.array(z.string())),
  })),
})

/**
 * Whether a stored value is one delivery intent: its idempotency id, mode, content array and optional trigger, kept as
 * the JSON the recovery path reads back.
 */
function isStoredDelivery(value: unknown): value is ImDelivery {
  if (!isStoredRecord(value)) return false
  return typeof value.id === 'string'
    && (value.mode === 'steer' || value.mode === 'followup' || value.mode === 'inject')
    && Array.isArray(value.content)
    && (value.trigger === undefined || isStoredMessage(value.trigger))
    && (value.media === undefined || typeof value.media === 'boolean')
    && (value.header === undefined || typeof value.header === 'string')
}

const sessionSchema = z.looseObject({
  key: z.string(), owner: z.string(), sessionId: storedSessionId, generation: z.number().int().nonnegative(),
  composition: compositionSchema, bindings: z.array(bindingSchema),
  output: z.exactOptional(z.string()), parent: z.exactOptional(storedSessionId),
  ephemeral: z.exactOptional(z.boolean()), meta: z.exactOptional(z.record(z.string(), z.unknown())),
  createdAt: z.number(), lastActiveAt: z.number(),
})
const deliverySchema = z.object({
  session: storedSessionId, delivery: z.custom<ImDelivery>(isStoredDelivery, {
    message: 'stored delivery intent is malformed',
  }),
  createdAt: z.number(), admitted: z.boolean(),
})
const resetSchema = z.object({
  replaced: storedSessionId,
  fromGeneration: z.number().int().nonnegative(),
  createdAt: z.number(),
})

/** The `im_sessions` storage domain: records by key, delivery intents, and idempotent reset receipts. */
export const imSessionsDomain = defineDomain({
  name: 'im_sessions', version: 1,
  tables: {
    sessions: domainTable<string, ImSessionRecord>(sessionSchema),
    deliveries: domainTable<string, StoredDelivery>(deliverySchema),
    resets: domainTable<string, StoredReset>(resetSchema),
  },
})
/** The `im_sessions` domain type: session records, delivery intents, and reset receipts. */
export type ImSessionsDomain = Domain<typeof imSessionsDomain>

/**
 * Inbox message id of one delivery into one session (stable across restarts).
 * @param sessionId - the session the delivery goes to.
 * @param deliveryId - the owner-minted idempotency id of the delivery.
 * @returns the user-message id the inbox insertion carries, which is what the log check dedupes on.
 */
export function deliveryMessageId(sessionId: SessionId, deliveryId: string): MessageId {
  return MessageId(`im-${createHash('sha256').update(`${sessionId}|${deliveryId}`).digest('hex').slice(0, 32)}`)
}

function isMessages(content: ImDelivery['content']): content is readonly ImMessage[] {
  const [first] = content
  return first !== undefined && !('type' in first)
}

/**
 * `ctx.im.sessions`: session records keyed by owner-defined keys, their bindings and durable delivery intents, plus
 * the reset/stop lifecycle and the parent-chain lookup tools and renderers use.
 */
export class ImSessionHost implements ImSessions {
  private domain: ImSessionsDomain | undefined
  /** Current record per key. */
  private readonly records = new Map<string, ImSessionRecord>()
  /** Current generation's session id → key. */
  private readonly ids = new Map<SessionId, string>()
  private readonly deliveries = new Map<string, StoredDelivery>()
  private readonly resets = new Map<string, StoredReset>()
  /** Session ids a reset retired: nothing recorded for one of them can be admitted any more. */
  private readonly retired = new Set<SessionId>()
  private readonly triggers = new Map<SessionId, ImMessage>()
  /** Per-session admission order. */
  private readonly chains = new Map<SessionId, Promise<unknown>>()
  private readonly writes = new WriteQueue()
  private recovering: Promise<void> | undefined
  private held = false
  private disposed = false

  constructor(readonly ctx: Context, readonly config: ImConfig, readonly deps: ImSessionHostDeps) {}

  /** Open the domain, load records, start recovery of pending deliveries unless held. */
  async start(): Promise<void> {
    this.disposed = false
    const domain = await this.ctx.storageDomain.open(imSessionsDomain)
    this.domain = domain
    for (const [, record] of domain.table('sessions').entries()) {
      this.index(record)
      for (let g = 0; g < record.generation; g += 1) this.retired.add(sessionIdOf(record.key, g))
    }
    for (const [id, stored] of domain.table('deliveries').entries()) this.deliveries.set(id, stored)
    for (const [id, stored] of domain.table('resets').entries()) this.resets.set(id, stored)
    this.retry()
  }

  /**
   * Hold recovery passes until {@link release}, so persisted deliveries do not open agents before sibling plugins
   * (`im_*` tools, prompt sections, routing listeners) have finished starting.
   */
  hold(): void {
    this.held = true
  }

  /** End a {@link hold} and start recovery of pending deliveries unless shutting down. */
  release(): void {
    if (!this.held || this.disposed) return
    this.held = false
    this.retry()
  }

  /**
   * Retry pending deliveries (service timer). Never throws: a delivery that cannot be admitted stays recorded and
   * pending for the next pass, and a failing retention write is reported.
   */
  retry(): void {
    if (!this.domain || this.held || this.recovering) return
    const run = this.recover().catch((error: unknown) => {
      this.ctx.logger.error('IM deliveries remain pending; inspect persistence, presets and compositions: %s', error)
    }).finally(() => { this.recovering = undefined })
    this.recovering = run
  }

  /** Resolution after the in-flight (or the next) recovery pass, for shutdown ordering and tests. */
  async whenRecovered(): Promise<void> {
    await this.recovering
  }

  /** Close the domain (agents are disposed by the host). */
  async dispose(): Promise<void> {
    this.disposed = true
    this.held = true
    await this.recovering
    await Promise.allSettled([...this.chains.values()])
    await this.writes.drain()
    const domain = this.domain
    this.domain = undefined
    await domain?.close()
  }

  /**
   * Exact hosted record of a session id (no parent walk) — activity tracking.
   * @param sessionId - the session id to look up.
   * @returns the record whose current generation carries that id, or undefined when no record owns it.
   */
  hosted(sessionId: SessionId): ImSessionRecord | undefined {
    const key = this.ids.get(sessionId)
    return key === undefined ? undefined : this.records.get(key)
  }

  /** Trigger of the delivery that started the session's current turn (renderers quote it). */
  trigger(sessionId: SessionId): ImMessage | undefined {
    return this.triggers.get(sessionId)
  }

  /**
   * Recorded deliveries not yet admitted into an inbox.
   * @returns how many intents still await their inbox insertion (`ctx.im.status().pendingDeliveries`).
   */
  pendingDeliveries(): number {
    let count = 0
    for (const stored of this.deliveries.values()) if (!stored.admitted) count++
    return count
  }

  async ensure(spec: ImSessionSpec): Promise<ImSessionRecord> {
    if (!spec.key.trim() || !spec.owner.trim()) throw new ImError('configuration', 'IM sessions require a nonempty key and owner.')
    const { record, created } = await this.write(async () => {
      const known = this.records.get(spec.key)
      if (known) {
        if (known.owner !== spec.owner) {
          throw new ImError('ownership', `IM session ${spec.key} belongs to ${known.owner}, not ${spec.owner}.`)
        }
        const updated: ImSessionRecord = {
          ...spec, sessionId: known.sessionId, generation: known.generation, createdAt: known.createdAt,
          lastActiveAt: known.lastActiveAt,
        }
        await this.save(updated)
        return { record: updated, created: false }
      }
      const sessionId = sessionIdOf(spec.key, 0)
      await this.reserve(sessionId)
      const now = Date.now()
      const fresh: ImSessionRecord = { ...spec, sessionId, generation: 0, createdAt: now, lastActiveAt: now }
      await this.save(fresh)
      return { record: fresh, created: true }
    })
    // Announced after the write settled: a listener may call back into this host.
    if (created) this.ctx.emit('im/session/created', record)
    return record
  }

  get(keyOrId: string | SessionId): ImSessionRecord | undefined {
    return this.records.get(keyOrId) ?? this.hosted(keyOrId as SessionId)
  }

  list(filter: ImSessionFilter = {}): ImSessionRecord[] {
    return [...this.records.values()].filter(record => (filter.owner === undefined || record.owner === filter.owner)
      && (filter.parent === undefined || record.parent === filter.parent)
      && (filter.chat === undefined || record.bindings.some(binding => binding.chat === filter.chat)))
  }

  forChat(chat: ImChatKey): ImSessionRecord[] {
    return this.list({ chat })
  }

  /**
   * Session id of any generation of `key` (including generations retired by reset) that already admitted
   * `deliveryId`, or `undefined` when none did. Dedupe window equals `config.retentionMs`, after which `recover()`
   * prunes admitted delivery intents.
   */
  deliveredTo(key: string, deliveryId: string): SessionId | undefined {
    const current = this.records.get(key)
    if (!current) return undefined
    for (let generation = current.generation; generation >= 0; generation -= 1) {
      const sessionId = sessionIdOf(key, generation)
      if (this.deliveries.get(`${sessionId}|${deliveryId}`)?.admitted) return sessionId
    }
    return undefined
  }

  async deliver(target: SessionId | string, delivery: ImDelivery): Promise<void> {
    const record = this.resolve(target)
    const id = `${record.sessionId}|${delivery.id}`
    const known = this.deliveries.get(id)
    if (known) {
      if (!known.admitted) {
        await this.admit(known.session, id)
        if (!this.deliveries.has(id)) {
          throw new ImError('unavailable', `IM delivery ${delivery.id} was discarded by a session reset.`)
        }
      }
      return
    }
    const stored: StoredDelivery = { session: record.sessionId, delivery, createdAt: Date.now(), admitted: false }
    // The same budget the intake applied to the message, measured on the same payload: the intent repeats the messages
    // it carries, not a second copy of each (`trigger` is derived at admission).
    if (inputBytes(delivery) > this.config.maxInputBytes) {
      throw new ImError('capacity', 'IM delivery exceeds the configured byte limit.', { permanent: true })
    }
    await this.write(() => {
      if (this.hosted(record.sessionId) === undefined) {
        throw new ImError('unavailable', `IM delivery ${delivery.id} was discarded by a session reset.`)
      }
      return this.domainOf().table('deliveries').put(id, stored)
    })
    this.deliveries.set(id, stored)
    await this.admit(record.sessionId, id, true)
    // A reset that ran while this intent was being recorded drops the undelivered intents of the generation it
    // replaced, this one included: refuse, so the caller re-delivers into the generation that replaced it.
    if (!this.deliveries.has(id)) {
      throw new ImError('unavailable', `IM delivery ${delivery.id} was discarded by a session reset.`)
    }
  }

  async reset(key: string, reason: string, options: ImResetOptions = {}): Promise<SessionId | undefined> {
    this.domainOf()
    const receiptKey = options.operationId === undefined ? undefined : `${key}|${options.operationId}`
    const known = this.records.get(key)
    if (!known) return receiptKey === undefined ? undefined : this.resets.get(receiptKey)?.replaced
    if (receiptKey !== undefined) {
      const recorded = this.resets.get(receiptKey)
      if (recorded !== undefined && known.generation > recorded.fromGeneration) return recorded.replaced
    }
    // The whole lifecycle of the generation being replaced — cancel, dispose, and the record advance that publishes
    // the next one — runs as ONE serial operation for that session key, because `admit()` queues on the same chain.
    // Releasing the chain between the dispose and the write let a queued admission read the disposed generation and
    // write its stale record back, which rolled the counter back and made the cleared session current again.
    const outcome = await this.serial<{
      replaced: SessionId | undefined
      advanced?: { old: ImSessionRecord; record: ImSessionRecord }
    }>(key, async () => {
      const current = this.resolve(key)
      const recorded = receiptKey === undefined ? undefined : this.resets.get(receiptKey)
      if (recorded !== undefined) {
        if (current.generation > recorded.fromGeneration) return { replaced: recorded.replaced }
      } else if (options.expectedGeneration !== undefined && current.generation !== options.expectedGeneration) {
        return { replaced: undefined }
      }
      this.deps.agents.live(current.sessionId)?.cancel({ kind: 'user' })
      await this.deps.agents.dispose(current.sessionId)
      return await this.write(async () => {
        // Re-read inside the write: disposing the agent awaited, and an ensure()/bind() may have committed a newer
        // record (another chat's binding) meanwhile. Advancing the generation from the stale copy would drop it.
        const latest = this.resolve(key)
        const now = Date.now()
        // Persist the reset receipt with `fromGeneration` BEFORE advancing `sessions`: if `save(next)` fails or the
        // process exits in between, a replay finishes the advance to `fromGeneration + 1`, whereas a replay after
        // `save(next)` committed sees `latest.generation > fromGeneration` and returns `replaced` without resetting again.
        if (receiptKey !== undefined && recorded === undefined) {
          const receipt: StoredReset = {
            replaced: latest.sessionId,
            fromGeneration: latest.generation,
            createdAt: now,
          }
          await this.domainOf().table('resets').put(receiptKey, receipt)
          this.resets.set(receiptKey, receipt)
        }
        const advanced = await this.advanceGeneration(latest, now)
        return { replaced: latest.sessionId, advanced }
      })
    })
    // Announced after the serial operation settled: a listener may call back into this host.
    if (outcome.advanced !== undefined) {
      this.ctx.emit('im/session/reset', outcome.advanced.old, reason)
      this.ctx.emit('im/session/created', outcome.advanced.record)
    }
    return outcome.replaced
  }

  async bind(target: SessionId | string, bindings: ImBinding[]): Promise<void> {
    await this.write(async () => {
      // Resolved inside the write: a concurrent reset replaces the record under the same key.
      const current = this.resolve(target)
      await this.save({ ...current, bindings })
    })
  }

  async agent(target: SessionId | string): Promise<Agent> {
    if (this.retired.has(target as SessionId)) {
      throw new ImError('unavailable', `IM session ${target} was replaced by a reset.`)
    }
    const initial = this.resolve(target)
    return await this.serial(initial.key, async () => {
      // Re-resolve inside `serial(key)` after any in-flight `reset()` finishes so a retired `SessionId` or a
      // generation with an uncommitted reset receipt is never reopened after disposal.
      const current = this.resolve(initial.key)
      if (target !== initial.key && current.sessionId !== target) {
        throw new ImError('unavailable', `IM session ${target} was replaced by a reset.`)
      }
      if (this.hasPendingReset(current.sessionId)) {
        throw new ImError('unavailable', `IM session ${current.sessionId} has an uncommitted reset; retry after recovery.`)
      }
      return await this.deps.agents.open(current)
    })
  }

  of(sessionId: SessionId): ImSessionRecord | undefined {
    const seen = new Set<SessionId>()
    let id: SessionId | undefined = sessionId
    while (id !== undefined && !seen.has(id)) {
      const record = this.hosted(id)
      if (record) return record
      seen.add(id)
      // Only a delegated subagent inherits its creator's chat; a side conversation or an ordinary fork that
      // retained its source id was never delegated one.
      const header: SessionHeader | undefined = this.ctx.agents.get(id)?.session.header
      id = header?.origin === 'subagent' ? header.parentSession : undefined
    }
    return undefined
  }

  // oxlint-disable-next-line typescript/require-await -- async keeps an unknown target a rejection, not a synchronous throw
  async stop(target: SessionId | string): Promise<boolean> {
    const agent = this.deps.agents.live(this.resolve(target).sessionId)
    if (agent?.status !== 'running') return false
    agent.cancel({ kind: 'user' })
    return true
  }

  // -------------------------------------------------------------------------------------------------------------

  private async advanceGeneration(
    latest: ImSessionRecord,
    now: number,
  ): Promise<{ old: ImSessionRecord; record: ImSessionRecord }> {
    const undelivered: string[] = []
    for (const [id, stored] of this.deliveries) {
      if (stored.session === latest.sessionId && !stored.admitted) undelivered.push(id)
    }
    if (undelivered.length > 0) {
      await this.domainOf().table('deliveries').deleteMany(undelivered)
      for (const id of undelivered) this.deliveries.delete(id)
    }
    const generation = latest.generation + 1
    const sessionId = sessionIdOf(latest.key, generation)
    const next: ImSessionRecord = { ...latest, sessionId, generation, createdAt: now, lastActiveAt: now }
    await this.save(next)
    this.ids.delete(latest.sessionId)
    this.retired.add(latest.sessionId)
    this.triggers.delete(latest.sessionId)
    return { old: latest, record: next }
  }

  private async recover(): Promise<void> {
    // Finish any committed reset receipt whose generation advance never persisted before admitting pending deliveries,
    // so deliveries queued for the replaced generation are discarded instead of executing in the old session.
    const blocked = new Set<SessionId>()
    for (const [receiptKey, stored] of [...this.resets]) {
      const current = this.hosted(stored.replaced)
      if (current === undefined) continue
      try {
        await this.reset(current.key, 'recover', { operationId: receiptKey.slice(current.key.length + 1) })
      } catch (error: unknown) {
        // One failing reset must not starve other sessions' deliveries or retention pruning,
        // and its own queued deliveries must stay un-admitted until the reset finishes.
        blocked.add(stored.replaced)
        this.ctx.logger.warn('IM reset %s remains pending: %s', receiptKey, error)
      }
      if (this.held) return
    }
    for (const [id, stored] of [...this.deliveries]) {
      if (stored.admitted || blocked.has(stored.session)) continue
      try {
        await this.admit(stored.session, id)
      } catch (error: unknown) {
        // One unadmittable delivery must not starve the others; the next pass retries from the top.
        this.ctx.logger.warn('IM delivery %s remains pending: %s', id, error)
      }
      if (this.held) return
    }
    const cutoff = Date.now() - this.config.retentionMs
    const expiredDeliveries: string[] = []
    for (const [id, stored] of this.deliveries) {
      if (stored.admitted && stored.createdAt < cutoff) expiredDeliveries.push(id)
    }
    const expiredResets: string[] = []
    for (const [id, stored] of this.resets) {
      // Never prune an uncommitted reset receipt: its replaced generation is still hosted, so dropping the receipt
      // before advance completes would allow stale deliveries of that generation to be admitted on the next pass.
      if (this.hosted(stored.replaced) !== undefined || stored.createdAt >= cutoff) continue
      expiredResets.push(id)
    }
    if (expiredDeliveries.length > 0 || expiredResets.length > 0) {
      await this.write(async () => {
        if (expiredDeliveries.length > 0) {
          await this.domainOf().table('deliveries').deleteMany(expiredDeliveries)
          for (const id of expiredDeliveries) this.deliveries.delete(id)
        }
        if (expiredResets.length > 0) {
          await this.domainOf().table('resets').deleteMany(expiredResets)
          for (const id of expiredResets) this.resets.delete(id)
        }
      })
    }
  }

  /**
   * Insert one recorded delivery into its session's inbox unless the log already holds it, then mark it admitted.
   * Public because admission is a protocol step of its own: `deliver`, `start` and `retry` queue it, and an
   * admission whose record disappeared meanwhile (`reset` discards pending intents) resolves to nothing.
   * @param sessionId - session of the delivery (it also orders admissions per session).
   * @param id - delivery record key `${sessionId}|${delivery.id}`.
   * @param fresh - recorded by this very call, so the log cannot hold it yet and no read is needed.
   */
  admit(sessionId: SessionId, id: string, fresh: boolean = false): Promise<void> {
    return this.serial(this.hosted(sessionId)?.key ?? sessionId, async () => {
      const stored = this.deliveries.get(id)
      if (stored === undefined || stored.admitted) return
      const record = this.hosted(sessionId)
      if (!record) {
        // A reset replaced this generation, so nothing can ever admit the intent: forget it, so recovery does not warn
        // about it forever, and refuse, so the caller re-delivers into the generation that replaced it. A record that is
        // merely unknown (a store this process has not loaded) keeps its intents pending.
        if (this.retired.has(sessionId)) await this.discard(id)
        throw new ImError('unavailable', `IM session ${sessionId} of delivery ${id} is no longer hosted.`)
      }
      if (this.hasPendingReset(sessionId)) {
        throw new ImError('unavailable', `IM session ${sessionId} has an uncommitted reset; delivery ${id} remains pending.`)
      }
      const { delivery } = stored
      const agent = await this.deps.agents.open(record)
      const messageId = deliveryMessageId(sessionId, delivery.id)
      await this.ctx.agents.withInitiator(agent, async () => {
        await this.flush(agent)
        if (fresh || !await this.inserted(sessionId, messageId)) {
          const content = isMessages(delivery.content)
            ? await this.deps.formatter.format(delivery.content, {
              media: delivery.media === true, ...delivery.header === undefined ? {} : { header: delivery.header },
            })
            : delivery.content
          // A delivery that names no trigger quotes the message it delivered last: the intent already carries those
          // messages, and repeating one of them as `trigger` doubled what a delivery had to fit into the budget.
          const trigger = delivery.trigger ?? (isMessages(delivery.content) ? delivery.content.at(-1) : undefined)
          if (delivery.mode !== 'inject' && trigger !== undefined) this.triggers.set(sessionId, trigger)
          const message: UserMessage = {
            id: messageId, role: 'user', content,
            source: { kind: 'im', form: 'relay' },
          }
          agent[delivery.mode](message)
        }
        await this.flush(agent)
      })
      const admitted: StoredDelivery = { ...stored, admitted: true }
      await this.write(async () => {
        // Re-read inside the write: admission awaited the agent, and a concurrent ensure()/bind() may have committed a
        // newer record (another chat's binding) meanwhile; reset() waits on this.serial(sessionId).
        const current = this.resolve(sessionId)
        await this.domainOf().table('deliveries').put(id, admitted)
        this.deliveries.set(id, admitted)
        await this.save({ ...current, lastActiveAt: Date.now() })
      })
      if (record.ephemeral && delivery.mode !== 'inject') {
        void agent.whenIdle().then(() => this.deps.agents.dispose(sessionId)).catch((error: unknown) => {
          this.ctx.logger.warn('IM ephemeral session %s could not be disposed: %s', sessionId, error)
        })
      }
    })
  }

  private async flush(agent: Agent): Promise<void> {
    if (!await this.ctx.sessions.flush(agent.session)) {
      throw new ImError('persistence', 'IM admission requires an active session persistence listener.')
    }
  }

  /** Whether the durable log of one session already holds an inbox insertion with this message id. */
  private async inserted(sessionId: SessionId, messageId: MessageId): Promise<boolean> {
    const reader = await this.ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await reader.read()
      return events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === messageId))
    } finally {
      await reader.close()
    }
  }

  /** Refuse a new session id that already exists outside the IM store. */
  private async reserve(sessionId: SessionId): Promise<void> {
    if (this.ctx.agents.get(sessionId) || await this.ctx.sessionPersistence.stat(sessionId)) {
      throw new ImError('ownership', `Session ${sessionId} already exists outside the IM store.`)
    }
  }

  private resolve(target: SessionId | string): ImSessionRecord {
    const record = this.get(target)
    if (!record) throw new ImError('access', `No IM session ${target} is hosted.`)
    return record
  }

  private index(record: ImSessionRecord): void {
    this.records.set(record.key, record)
    this.ids.set(record.sessionId, record.key)
  }

  private async save(record: ImSessionRecord): Promise<void> {
    await this.domainOf().table('sessions').put(record.key, record)
    this.index(record)
  }

  /**
   * Whether `sessionId` has an uncommitted reset receipt (`replaced === sessionId`), so `admit()` refuses with
   * `unavailable` and keeps the intent pending until the reset advances.
   */
  private hasPendingReset(sessionId: SessionId): boolean {
    for (const stored of this.resets.values()) {
      if (stored.replaced === sessionId) return true
    }
    return false
  }

  /** Forget one delivery intent whose generation is gone, so no recovery pass retries it. */
  private async discard(id: string): Promise<void> {
    await this.write(async () => {
      await this.domainOf().table('deliveries').delete(id)
      this.deliveries.delete(id)
    })
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    return this.writes.run(operation)
  }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return runKeyed(this.chains, key, operation)
  }

  private domainOf(): ImSessionsDomain {
    if (!this.domain) throw new ImError('unavailable', 'The IM session store is not open.')
    return this.domain
  }
}
