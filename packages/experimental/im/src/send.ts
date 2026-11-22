/**
 * Outbound publication (`ctx.im.send` / `ctx.im.stream`): write-grant verification, durable receipts keyed by
 * `operationId`, and own-message attribution.
 *
 * Contract:
 * - **Grants.** A publication with `options.session` needs a *writable* binding of the chat on that session or on one
 *   of its hosted ancestors (`record.parent` chain); anything else is an `ImError('access')`. Without a session the
 *   publication is host- or plugin-originated (the session command plugin's replies and notices, an event's own
 *   `reply`), so only the chat's admission gates it: `sources[].writable` is a property of a session's binding, not a
 *   chat-wide permission.
 * - **Target.** `target()` resolves the chat ref of an admitted chat, re-verifies that the chat's stored `source` rule in
 *   `config.sources` still exists and admits it (else `ImError('access')`), and applies the caller's thread wish; `quote`
 *   becomes the content's `<quote id>` envelope element, so the platform reply rides the normal transform/fallback path,
 *   and the quoted stored message's adapter referrer becomes `Target.referrer` (passive replies, thread placement) — for
 *   a stream on every state, because the target is resolved once. An explicit `options.referrer` (the adapter-opaque
 *   reply context of an interaction the caller answers, such as a QQ button click's `event_id`) replaces the one the
 *   quote or thread would supply: the caller names the event it answers, which a stored message cannot. It carries no
 *   grant of its own and is not part of a receipt's digest.
 * - **Receipts.** A publication with `options.operationId` records `pending` *before* it reaches the platform and the
 *   observed outcome after it: `confirmed`, `failed` (the platform answered and published nothing —
 *   `PlatformError.published === 'no'`, `StrictRenderError`, or a stream whose message was never opened or was
 *   confirmed recalled via `StreamLimitError` / `StreamAbortError.recalled`), `partial` (`PartialSendError` or a
 *   stream whose handle still sits in the chat after a later failure) or `uncertain` (anything else — transport
 *   errors, timeouts, cancellation without confirmed recall). Replaying one operation id returns the recorded outcome and never
 *   sends again: an operation whose dispatch has no recorded outcome reads as `uncertain`, because the only safe
 *   statement about it is "inspect the chat". A reused operation id with *different* content is a `conflict`. A stream
 *   cannot be replayed: an operation id that already opened one is a `conflict` whatever its content.
 * - **Own messages.** The first stored platform message of each publication is attributed to the sending session
 *   (`sessionOf`, button routing) and named in the receipt, so a later button click can find its owner.
 * - **Rewrites.** `send()` runs the `im/before-send` waterfall on the caller's content (before the reply envelope) once
 *   the grants check passed: a listener may replace `content` or set `drop` (the result is then `failed` with
 *   `dropped: true`). With an operation id it runs after the replay check, so a replay never rewrites again, and the
 *   receipt digest covers the caller's content, not the rewrite. Streams are not rewritten.
 * - **Streams.** `stream()` runs the same grants check; with an operation id the receipt starts `pending` and settles
 *   with the stream's own outcome, and the platform stream is opened only after that receipt is reserved. A reply
 *   quote is applied to every state the caller publishes.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import {
  h, isElement, PartialSendError, PlatformError, StreamAbortError, StreamLimitError, StrictRenderError, type Bot,
  type Fragment, type MessageHandle, type MessageStream, type SendResult, type StreamOptions, type Target,
} from '@deepseek-ai/cordis-plugin-im-core'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  ImChatKey, ImMessageKey, splitKey, type ImConfig, type ImMessage, type ImOutgoing, type ImSendOptions,
  type ImSendResult, type ImSessionRecord, type ImSessions,
} from './api.ts'
import { ImError } from './error.ts'
import { admitsChat } from './intake.ts'
import { runKeyed, WriteQueue } from './serial.ts'
import { storedChatKey, storedMessageKey, storedSessionId } from './state.ts'
import type { ImStore } from './store.ts'

/** What the sender writes through and checks grants against: the message store and the session lookups. */
export interface ImSenderDeps {
  store: ImStore
  /** The three lookups of the grants check and of the placement: session record, parent chain, last answered message. */
  sessions: Pick<ImSessions, 'of' | 'get' | 'trigger'>
  /**
   * The own message one publication is being stored as. The core announces a publication on its `send` event and does
   * not await the listener that stores it, so without this the receipt raced the store and lost `message` and `seq`.
   */
  announced?: (key: ImMessageKey) => Promise<ImMessage | undefined>
  /** Fallback announcement hook used during teardown once Cordis has unregistered the plugin-scoped `send` listener. */
  onResult?: (bot: Bot, result: SendResult) => void
}

/** One durable receipt, keyed by the operation id of one publication. */
export interface StoredReceipt {
  /** Chat the publication went to. */
  chat: ImChatKey
  /** Session that asked for it (button attribution); absent when core code sent without a session. */
  session?: SessionId
  /** `sha256` of the request: one operation id may never describe two different publications. */
  digest: string
  status: 'pending' | 'confirmed' | 'failed' | 'uncertain' | 'partial'
  /** First platform message of the publication, once the platform answered (partial sends included). */
  message?: ImMessageKey
  /** Why the publication failed, is partial, or is uncertain. */
  error?: string
  createdAt: number
}

const receiptSchema = z.looseObject({
  chat: storedChatKey,
  session: z.exactOptional(storedSessionId),
  digest: z.string(),
  status: z.enum(['pending', 'confirmed', 'failed', 'uncertain', 'partial']),
  message: z.exactOptional(storedMessageKey),
  error: z.exactOptional(z.string()),
  createdAt: z.number(),
})

/** The `im_receipts` storage domain: one record per operation id. */
export const imReceiptsDomain = defineDomain({
  name: 'im_receipts',
  version: 1,
  tables: {
    receipts: domainTable<string, StoredReceipt>(receiptSchema),
  },
})

/** The `im_receipts` domain type: one stored receipt per operation id, reopened by `start` to replay outcomes. */
export type ImReceiptsDomain = Domain<typeof imReceiptsDomain>

/** Stand-in outcome of a dispatch that never recorded one (crash, or a write that failed). */
const UNKNOWN_OUTCOME = 'A previous dispatch of this operation has no durable receipt; inspect the chat and send '
  + 'again intentionally if it did not arrive.'

/** Outcome of a publication whose caller cancelled it before anything reached the platform. */
const CANCELLED = 'The publication was cancelled before dispatch; no message was sent.'

/** Why the platform says nothing was published. */
const REFUSED = 'The chat platform refused the publication: '

/** Deadline passed (or cancellation after dispatch): the message may or may not have reached the chat. */
const TIMEOUT = 'The IM publication did not finish in time; the message may or may not have reached the chat.'

/** Prefix of the outcome of a publication an `im/before-send` listener dropped. */
const DROPPED = 'The publication was dropped before dispatch; no message was sent: '

/**
 * Outbound sender of one IM host.
 *
 * Every write goes through one chain, so a receipt's pending record always precedes its dispatch and its outcome
 * record follows it without interleaving with another operation's writes. Dispatches of *one* operation id are
 * serialized on a per-operation chain; different operations run concurrently.
 */
export class ImSender {
  /** Open domain; set by {@link start}. */
  private domain: ImReceiptsDomain | undefined
  private readonly receipts = new Map<string, StoredReceipt>()
  /** Own stored message → session whose send produced it (button attribution). */
  private readonly attribution = new Map<ImMessageKey, SessionId>()
  /** Per-operation dispatch chain (see {@link serial}). */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** In-flight un-receipted sends awaited by {@link dispose}. */
  private readonly inflight = new Set<Promise<unknown>>()
  /** In-flight stream receipt settlement tasks awaited by {@link dispose}. */
  private readonly settlements = new Set<Promise<void>>()
  /** Open streams; aborted on {@link dispose} so settlements cannot hang forever. */
  private readonly openStreams = new Set<MessageStream>()
  /** The receipt write chain. */
  private readonly writes = new WriteQueue()

  constructor(readonly ctx: Context, readonly config: ImConfig, readonly deps: ImSenderDeps) {}

  /** Open the receipts domain and load what earlier processes recorded. */
  async start(): Promise<void> {
    const domain = await this.ctx.storageDomain.open(imReceiptsDomain)
    this.domain = domain
    for (const [id, receipt] of domain.table('receipts').entries()) this.index(id, receipt)
  }

  /** Finish the dispatches in flight and close the domain. */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.chains.values(), ...this.inflight])
    await Promise.allSettled([...this.openStreams].map(stream => stream.abort({ reason: 'IM sender disposed' })))
    await Promise.allSettled([...this.settlements])
    await this.writes.drain()
    const domain = this.domain
    this.domain = undefined
    this.receipts.clear()
    this.attribution.clear()
    await domain?.close()
  }

  /**
   * Publish one message.
   * @param chat - admitted chat key.
   * @param content - normalized-on-send content; a `quote` wraps it in the reply envelope.
   * @param options - send options; `operationId` makes the publication durable and idempotent.
   * @returns the durable outcome; `uncertain` and `partial` must be checked in the chat before sending again.
   */
  send(chat: ImChatKey, content: Fragment, options: ImSendOptions = {}): Promise<ImSendResult> {
    return this.publishNow(chat, content, options)
  }

  /** The body of {@link send}, async so every refusal is a rejection rather than a synchronous throw. */
  private async publishNow(chat: ImChatKey, content: Fragment, options: ImSendOptions): Promise<ImSendResult> {
    const confinedThread = this.grant(chat, options.session, options)
    const target = this.target(chat, confinedThread === undefined ? options : { ...options, thread: confinedThread })
    const quoteId = this.quoteId(chat, options.quote)
    const id = options.operationId
    if (id === undefined) {
      const result = await this.track(this.prepared(chat, content, options).then(draft => draft.drop === undefined
        ? this.dispatch(this.botOf(chat), target, withQuote(draft.content, quoteId), options)
        : dropped(draft.drop)))
      if (result.status !== 'confirmed' && result.dropped !== true) {
        this.ctx.logger.warn('IM publication to %s of session %s was not confirmed (%s): %s',
          chat, options.session ?? '-', result.status, result.error)
      }
      return result
    }
    return this.serial(id, () => this.publish(id, chat, target, content, quoteId, options))
  }

  /**
   * Run the `im/before-send` waterfall over one publication: listeners may rewrite `content` or set `drop`.
   *
   * A listener that throws is logged and skipped as if it had passed the draft on unchanged: a broken rewriter must
   * never cost the agent its message.
   * @param chat - admitted chat key.
   * @param content - the caller's content, before the reply envelope.
   * @param options - caller options (read-only to listeners).
   * @returns the settled draft.
   */
  private async prepared(chat: ImChatKey, content: Fragment, options: ImSendOptions): Promise<ImOutgoing> {
    const draft: ImOutgoing = { chat, content, options, original: content }
    try {
      await this.ctx.waterfall('im/before-send', draft, async () => {})
    } catch (error) {
      this.ctx.logger.warn('IM before-send listener failed for %s; sending as is: %s', chat, messageOf(error))
      return { chat, content, options, original: content }
    }
    return draft
  }

  /**
   * Open a streamed message. The caller owns the states; a `quote` is applied to each of them.
   *
   * A stream cannot be replayed: an `operationId` that already opened one is a `conflict`, whatever its content.
   * @param chat - admitted chat key.
   * @param options - send and stream options; `operationId` records a durable receipt for the publication.
   * @returns the stream, already gated on the grants check.
   */
  async stream(chat: ImChatKey, options: ImSendOptions & StreamOptions = {}): Promise<MessageStream> {
    const confinedThread = this.grant(chat, options.session, options)
    const target = this.target(chat, confinedThread === undefined ? options : { ...options, thread: confinedThread })
    const bot = this.botOf(chat)
    const quoteId = this.quoteId(chat, options.quote)
    const id = options.operationId
    if (id === undefined) {
      const stream = bot.stream(target, options)
      this.openStreams.add(stream)
      return this.watched(this.quoted(stream, quoteId), bot, chat, options.session, stream)
    }
    return await this.serial(id, async () => {
      const previous = this.receipts.get(id)
      if (previous !== undefined) {
        throw new ImError('conflict', `IM operation ${id} already opened a stream (${previous.status}).`)
      }
      const pending: StoredReceipt = {
        chat, ...options.session === undefined ? {} : { session: options.session },
        digest: fingerprint(undefined, options), status: 'pending', createdAt: Date.now(),
      }
      await this.reservePending(id, pending)
      // The platform stream is opened only once its pending receipt holds a reserved slot: a refusal (a conflict, a
      // full store) never opens a platform stream, and a synchronous open failure settles that receipt.
      let stream: MessageStream
      try {
        stream = bot.stream(target, { ...options, idempotencyKey: options.idempotencyKey ?? id })
      } catch (error) {
        await this.settle(id, pending, { status: 'failed', error: messageOf(error) })
        throw error
      }
      this.openStreams.add(stream)
      const settlement = stream.done.then(
        async (result) => {
          this.attribute(result.handle, options.session)
          await this.settle(id, pending, await this.confirmed(result))
        },
        (error: unknown) => {
          const result = this.failure(error, stream.handle)
          if (result.handle !== undefined) this.attribute(result.handle, options.session)
          return this.settle(id, pending, result)
        },
      ).catch((error: unknown) => {
        this.ctx.logger.error('IM stream receipt %s could not be saved; inspect the chat: %s', id, error)
      }).finally(() => {
        this.openStreams.delete(stream)
        this.settlements.delete(settlement)
      })
      this.settlements.add(settlement)
      return this.watched(this.quoted(stream, quoteId), bot, chat)
    })
  }

  /**
   * Attribute a completed (or partially opened) stream to its session and log a warning when `stream.done` rejects so
   * an unobserved stream failure remains visible in diagnostics.
   * @param stream - the stream handed to the caller.
   * @param bot - bot that opened the stream.
   * @param chat - the admitted chat, for the message.
   * @param session - publishing session, for un-receipted streams whose attribution is not handled by `settlement`.
   * @returns that stream.
   */
  private watched(
    stream: MessageStream, bot: Bot, chat: ImChatKey, session?: SessionId, rawStream?: MessageStream,
  ): MessageStream {
    const done = stream.done.then(
      (result) => {
        this.deps.onResult?.(bot, result)
        this.attribute(result.handle, session)
      },
      (error: unknown) => {
        if (stream.handle !== undefined) this.attribute(stream.handle, session)
        this.ctx.logger.warn('IM stream to %s failed: %s', chat, messageOf(error))
      },
    ).finally(() => {
      if (rawStream !== undefined) this.openStreams.delete(rawStream)
      this.settlements.delete(done)
    })
    if (rawStream !== undefined) this.settlements.add(done)
    return stream
  }

  /** Track an un-receipted dispatch so {@link dispose} drains it before tearing down. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work)
    void work.then(() => undefined, () => undefined).then(() => { this.inflight.delete(work) })
    return work
  }

  /**
   * Core target of one publication: the chat ref of an admitted chat (re-verifying the chat's stored `source` rule in
   * current `config.sources`), the caller's thread wish and — when the publication answers a stored message or stored
   * thread of this chat — that message's adapter referrer (see {@link referrerOf}).
   * @param chat - chat key.
   * @param options - `thread`, `quote` and `referrer`; a `quote` is applied to the content (see {@link send}), an
   *   explicit `referrer` replaces the quote's or thread's.
   * @returns the target handed to `bot.send` / `bot.stream`.
   * @throws ImError `access` when `chat` was never admitted or its stored `source` rule was removed or narrowed so it
   *   no longer admits `chat`.
   */
  target(chat: ImChatKey, options: Pick<ImSendOptions, 'thread' | 'quote' | 'referrer'> = {}): Target {
    const known = this.deps.store.chat(chat)
    if (known === undefined) throw new ImError('access', `Chat ${chat} is not admitted to IM.`)
    const source = this.config.sources.find(candidate => candidate.id === known.source)
    if (source === undefined || !admitsChat(source, known.bot, known.ref)) {
      throw new ImError('access', `Chat ${chat} is no longer admitted to IM.`)
    }
    const thread = options.thread
    // An explicit referrer names the event being answered; it wins over the one a quote or thread would supply.
    const referrer = options.referrer !== undefined ? options.referrer : this.referrerOf(chat, options.quote, thread)
    return {
      chat: { ...known.ref },
      ...thread === undefined ? {} : { thread },
      ...referrer === undefined ? {} : { referrer },
    }
  }

  /**
   * Adapter-private reply context of the message or thread a publication answers (`Target.referrer`): the stored
   * `referrer` of the quoted message (or, when no quote is given, a stored message of the requested thread in the same
   * chat), so a QQ group bot can reply passively and a Lark publication keeps its thread without an extra lookup.
   * @param chat - chat the publication goes to.
   * @param quote - the message being answered, if any.
   * @param thread - explicit thread request, if any.
   * @returns the referrer, when the quote or thread names a stored message of the same chat.
   */
  referrerOf(chat: ImChatKey, quote: ImMessageKey | undefined, thread?: boolean | string): unknown {
    if (quote !== undefined) {
      const quoted = this.deps.store.get(quote)
      // A quote outside the chat it is sent to cannot be that chat's passive context; the adapter would send it wrong.
      if (quoted === undefined || quoted.chat.key !== chat) return undefined
      return quoted.referrer
    }
    if (typeof thread === 'string') {
      const id = thread.trim()
      if (id.length === 0) return undefined
      return this.deps.store.before(
        chat,
        Number.MAX_SAFE_INTEGER,
        1,
        message => (message.thread?.id === id || message.thread?.root === id) && message.referrer !== undefined,
      )[0]?.referrer
    }
    return undefined
  }

  /**
   * Session whose send produced a stored own message (button attribution).
   * @param message - stored own message key.
   * @returns the sending session, when this process (or a receipt it loaded) knows it.
   */
  sessionOf(message: ImMessageKey): SessionId | undefined {
    return this.attribution.get(message)
  }

  // -------------------------------------------------------------------------------------------------------------

  /**
   * The receipt protocol of one publication: dedupe by operation id, record `pending`, dispatch, record the outcome.
   * @param id - operation id (unique per intended publication).
   * @param chat - admitted chat key.
   * @param target - resolved target.
   * @param content - the caller's content; the digest covers it before `im/before-send` rewrites it, so a replay of
   *   the same request matches whatever a rewriter made of it the first time.
   * @param quoteId - platform id of the quoted message, wrapped around the content after the rewrite.
   * @param options - caller options.
   * @returns the live outcome, or the recorded one when this call replays the operation.
   */
  private async publish(
    id: string, chat: ImChatKey, target: Target, content: Fragment, quoteId: string | undefined,
    options: ImSendOptions,
  ): Promise<ImSendResult> {
    const digest = fingerprint(withQuote(content, quoteId), options)
    const previous = this.receipts.get(id)
    if (previous !== undefined) {
      if (previous.digest !== digest || previous.chat !== chat) {
        throw new ImError('conflict', `IM operation ${id} was already used for a different publication.`)
      }
      return this.receiptResult(previous)
    }
    const bot = this.botOf(chat)
    const pending: StoredReceipt = {
      chat, ...options.session === undefined ? {} : { session: options.session },
      digest, status: 'pending', createdAt: Date.now(),
    }
    await this.reservePending(id, pending)
    const draft = await this.prepared(chat, content, options)
    const result = draft.drop === undefined
      ? await this.dispatch(bot, target, withQuote(draft.content, quoteId), options)
      : dropped(draft.drop)
    try {
      await this.settle(id, pending, result)
    } catch (error) {
      this.ctx.logger.error('IM publication %s could not save its outcome; inspect the chat before sending again: %s',
        id, error)
      return { status: 'uncertain', error: UNKNOWN_OUTCOME }
    }
    return result
  }

  /**
   * One platform publication; failures become the receipt status they justify (never a claim of delivery).
   * @param bot - mounted bot of the target chat.
   * @param target - resolved target.
   * @param content - content to publish.
   * @param options - caller options.
   * @returns the outcome of this dispatch.
   */
  private async dispatch(
    bot: Bot, target: Target, content: Fragment, options: ImSendOptions,
  ): Promise<ImSendResult> {
    const deadline = this.deadline(options.signal)
    try {
      if (deadline.signal.aborted) return { status: 'failed', error: CANCELLED }
      const key = options.idempotencyKey ?? options.operationId
      const result = await bot.send(target, content, {
        ...options, ...key === undefined ? {} : { idempotencyKey: key }, signal: deadline.signal,
      })
      this.deps.onResult?.(bot, result)
      this.attribute(result.handle, options.session)
      return await this.confirmed(result)
    } catch (error) {
      const result = this.failure(error)
      if (result.handle !== undefined) this.attribute(result.handle, options.session)
      return result
    } finally {
      deadline.clear()
    }
  }

  /** The core's send result as an `ImSendResult` (a stream's final state settles through it too). */
  private async confirmed(result: SendResult): Promise<ImSendResult> {
    const part = result.handle.parts[0]
    const key = part === undefined ? undefined : ImMessageKey(result.handle.bot, part.id)
    let message = key === undefined ? undefined : this.deps.store.get(key)
    // The own message is stored by the `send` listener, which the core does not await: without waiting for that write
    // the receipt raced it and carried no `message` and no `seq`.
    if (message === undefined && key !== undefined) {
      try {
        message = await this.deps.announced?.(key)
      } catch (error) {
        // The platform published and answered; only this host's own copy is missing. A local write failure cannot turn
        // a confirmed publication into an uncertain one, and the handle stays known.
        this.ctx.logger.warn('IM own message %s was not stored: %s', key, messageOf(error))
      }
    }
    return {
      status: 'confirmed', handle: result.handle, report: result.report,
      ...message === undefined ? {} : { message },
    }
  }

  /**
   * The receipt status one thrown publication justifies (`PlatformError.published`), or `partial` when a stream
   * already published its initial handle before failing.
   * @param error - whatever the core raised.
   * @param streamHandle - the handle already published by a stream, if any.
   * @returns `partial`, `failed` or `uncertain` — never `confirmed`.
   */
  private failure(error: unknown, streamHandle?: MessageHandle): ImSendResult {
    if (error instanceof PartialSendError) {
      return {
        status: 'partial', handle: error.handle, ...error.report === undefined ? {} : { report: error.report },
        error: messageOf(error.cause),
      }
    }
    if (streamHandle !== undefined) {
      return { status: 'partial', handle: streamHandle, error: messageOf(error) }
    }
    if (error instanceof StrictRenderError) {
      return { status: 'failed', report: error.report, error: error.message }
    }
    if (error instanceof StreamLimitError || (error instanceof StreamAbortError && error.recalled)) {
      return { status: 'failed', error: error.message }
    }
    if (error instanceof PlatformError && error.published === 'no') {
      return { status: 'failed', error: `${REFUSED}${error.message}` }
    }
    return { status: 'uncertain', error: messageOf(error) }
  }

  /** The stored receipt as a send result: a recorded `pending` dispatch reads as `uncertain`. */
  private receiptResult(receipt: StoredReceipt): ImSendResult {
    const message = receipt.message === undefined ? undefined : this.deps.store.get(receipt.message)
    if (receipt.status === 'pending') {
      return { status: 'uncertain', error: UNKNOWN_OUTCOME, ...message === undefined ? {} : { message } }
    }
    return {
      status: receipt.status,
      ...receipt.error === undefined ? {} : { error: receipt.error },
      ...message === undefined ? {} : { message },
    }
  }

  /** Record the observed outcome of one operation (also the stream's settle path). */
  private settle(id: string, pending: StoredReceipt, result: ImSendResult): Promise<void> {
    const handle = result.handle
    const part = handle?.parts[0]
    return this.put(id, {
      ...pending,
      status: result.status,
      ...handle === undefined || part === undefined ? {} : { message: ImMessageKey(handle.bot, part.id) },
      ...result.error === undefined ? {} : { error: result.error },
    })
  }

  /** Remember the first stored platform message of one publication (button attribution). */
  private attribute(handle: MessageHandle, session: SessionId | undefined): void {
    const part = handle.parts[0]
    if (part === undefined) return
    if (session !== undefined) this.attribution.set(ImMessageKey(handle.bot, part.id), session)
  }

  /** The bounded publication deadline of one dispatch (its own alarm, fused with the caller's signal). */
  private deadline(caller: AbortSignal | undefined): { signal: AbortSignal; clear: () => void } {
    const controller = new AbortController()
    const forward = (): void => { controller.abort(caller?.reason) }
    if (caller?.aborted) forward()
    else caller?.addEventListener('abort', forward, { once: true })
    const timer = setTimeout(() => { controller.abort(new Error(TIMEOUT)) }, this.config.send.operationTimeoutMs)
    timer.unref()
    return {
      signal: controller.signal,
      clear: () => {
        clearTimeout(timer)
        caller?.removeEventListener('abort', forward)
      },
    }
  }

  /**
   * Grants: `session` (or a hosted ancestor) must hold a writable binding of the chat, and if all writable bindings
   * for `chat` are confined to specific threads (`binding.thread`), the publication must target one of them.
   * @returns the thread a publication that names none belongs in — the thread of the message this session answered
   *   last, which is where its own answers go — or a thread id to forward to `target()` when a confined session quotes
   *   a thread root whose stored record carries no `thread` field, else `undefined`.
   */
  private grant(
    chat: ImChatKey,
    session: SessionId | undefined,
    options: Pick<ImSendOptions, 'thread' | 'quote'>,
  ): string | undefined {
    if (session === undefined) return undefined
    const writable = grantChain(this.deps.sessions, session)
      .flatMap(record => record.bindings)
      .filter(binding => binding.chat === chat && binding.writable)
    if (writable.length === 0) {
      throw new ImError('access', `Chat ${chat} is not writable for session ${session}.`)
    }
    const confined = writable.filter(
      (binding): binding is typeof binding & { thread: string } => binding.thread !== undefined,
    )
    const allowedThreads = new Set(confined.map(binding => binding.thread))
    const explicit = typeof options.thread === 'string' ? options.thread.trim() : undefined
    const quoted = options.quote === undefined ? undefined : this.deps.store.get(options.quote)
    const fromQuote = quoted?.chat.key === chat ? quoted : undefined
    // A publication that names neither a thread nor a message stays in the thread this session is talking in: its
    // output renderers quote the trigger and inherit that thread, so the chat's own timeline is not where its work is.
    const answered = explicit === undefined && fromQuote === undefined ? this.answeredMessage(chat, session) : undefined
    // An open chat binds the session to the whole conversation, so any of its threads is allowed.
    if (confined.length < writable.length) return answered?.thread?.id
    if (explicit !== undefined) {
      if (!allowedThreads.has(explicit)) throw this.threadAccessError(chat, session, allowedThreads)
      return undefined
    }
    if (fromQuote !== undefined) {
      if (!messageInThreads(fromQuote, allowedThreads)) throw this.threadAccessError(chat, session, allowedThreads)
      return fromQuote.thread === undefined ? splitKey(fromQuote.key).id : undefined
    }
    if (answered === undefined || !messageInThreads(answered, allowedThreads)) {
      throw this.threadAccessError(chat, session, allowedThreads)
    }
    return answered.thread?.id ?? splitKey(answered.key).id
  }

  private threadAccessError(chat: ImChatKey, session: SessionId, allowedThreads: ReadonlySet<string>): ImError {
    return new ImError(
      'access',
      `Chat ${chat} is confined to thread(s) ${[...allowedThreads].join(', ')} for session ${session}; pass an allowed thread.`,
    )
  }

  /**
   * The message a session answered last (`ImSessions.trigger`), when that message belongs to `chat`.
   * @param chat - chat the publication goes to.
   * @param session - publishing session.
   * @returns the trigger message, or `undefined` when none exists or it belongs to another chat.
   */
  private answeredMessage(chat: ImChatKey, session: SessionId): ImMessage | undefined {
    const trigger = this.deps.sessions.trigger(session)
    return trigger?.chat.key === chat ? trigger : undefined
  }

  /** The bot of a chat (`ImError('unavailable')` when it is not mounted). */
  private botOf(chat: ImChatKey): Bot {
    const { bot: id } = splitKey(chat)
    const bot = this.ctx.bots.find(candidate => candidate.id === id)
    if (bot === undefined) throw new ImError('unavailable', `No bot ${id} is mounted for chat ${chat}.`)
    return bot
  }

  /**
   * Resolve the platform-facing `<quote id>` for a quoted message key: uses the first recorded alias (e.g. QQ
   * `msg_idx`) when present, falling back to the key's message id. Rejects quotes belonging to another bot or not
   * stored in `chat` so cross-chat/cross-bot quote spoofing (including unstored or expired messages from another
   * chat) fails with `ImError('access')`.
   */
  private quoteId(chat: ImChatKey, quote: ImMessageKey | undefined): string | undefined {
    if (quote === undefined) return undefined
    if (splitKey(quote).bot !== splitKey(chat).bot) {
      throw new ImError('access', `Quoted message ${quote} belongs to another bot and cannot be quoted in ${chat}.`)
    }
    const stored = this.deps.store.get(quote)
    if (stored === undefined || stored.chat.key !== chat) {
      throw new ImError('access', `Quoted message ${quote} is not stored in chat ${chat} and cannot be quoted.`)
    }
    return stored.aliases?.[0] ?? splitKey(quote).id
  }

  /** The same stream with the reply quote wrapped around every state the caller publishes. */
  private quoted(stream: MessageStream, quoteId: string | undefined): MessageStream {
    if (quoteId === undefined) return stream
    return {
      update: (content) => { stream.update(withQuote(content, quoteId)) },
      close: final => final === undefined ? stream.close() : stream.close(withQuote(final, quoteId)),
      abort: options => stream.abort(options),
      get state() { return stream.state },
      get handle() { return stream.handle },
      get strategy() { return stream.strategy },
      get done() { return stream.done },
    }
  }

  /**
   * Atomically bound the receipt table and persist `pending` inside one serialized write step: settled records are
   * dropped oldest-first, unresolved ones never are, and concurrent operations with distinct ids cannot both pass the
   * last slot before writing.
   * @throws ImError `capacity` when every record is still pending.
   */
  private reservePending(id: string, pending: StoredReceipt): Promise<void> {
    return this.writes.run(async () => {
      const table = this.domainOf().table('receipts')
      while (table.size >= this.config.maxRecords) {
        const victim = [...table.entries()]
          .filter(([, receipt]) => receipt.status !== 'pending')
          .sort(([, left], [, right]) => left.createdAt - right.createdAt)[0]
        if (victim === undefined) {
          throw new ImError('capacity', 'IM receipts are full of unresolved operations; inspect the chats before '
            + 'sending again.')
        }
        await table.delete(victim[0])
        this.forget(victim[0])
      }
      await table.put(id, pending)
      this.index(id, pending)
    })
  }

  private index(id: string, receipt: StoredReceipt): void {
    this.receipts.set(id, receipt)
    if (receipt.message !== undefined && receipt.session !== undefined) {
      this.attribution.set(receipt.message, receipt.session)
    }
  }

  private forget(id: string): void {
    const receipt = this.receipts.get(id)
    this.receipts.delete(id)
    if (receipt?.message !== undefined) this.attribution.delete(receipt.message)
  }

  private put(id: string, receipt: StoredReceipt): Promise<void> {
    return this.writes.run(async () => {
      await this.domainOf().table('receipts').put(id, receipt)
      this.index(id, receipt)
    })
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return runKeyed(this.chains, id, operation)
  }

  private domainOf(): ImReceiptsDomain {
    if (!this.domain) throw new ImError('unavailable', 'The IM receipt store is not open.')
    return this.domain
  }
}

/**
 * The hosted record of one session and its hosted ancestors, nearest first (the grants chain).
 * @param sessions - the session host.
 * @param sessionId - the calling session (a hosted descendant resolves to its nearest hosted ancestor).
 * @returns the chain, bounded against a record whose `parent` points back into it.
 */
export function grantChain(sessions: Pick<ImSessions, 'of' | 'get'>, sessionId: SessionId): ImSessionRecord[] {
  const chain: ImSessionRecord[] = []
  let record = sessions.of(sessionId)
  while (record !== undefined) {
    chain.push(record)
    const parent = record.parent === undefined ? undefined : sessions.get(record.parent)
    if (parent === undefined || chain.some(entry => entry.sessionId === parent.sessionId)) return chain
    record = parent
  }
  return chain
}

/**
 * Receipt key tools use: `sha256(sessionId + '\0' + toolCallId)`.
 * @param sessionId - the session whose agent made the tool call.
 * @param toolCallId - the trusted call id of that tool invocation.
 * @returns the operation id that makes a replayed call return the recorded receipt instead of publishing again.
 */
export function operationId(sessionId: SessionId, toolCallId: string): string {
  return createHash('sha256').update(`${sessionId}\u0000${toolCallId}`).digest('hex')
}

/**
 * Whether `message` belongs to one of the granted `threads` (by thread id, root id, or root message id).
 * @param message - stored message to test.
 * @param threads - allowed thread ids for the target chat.
 * @returns `true` when the message belongs to one of `threads`.
 */
export function messageInThreads(message: ImMessage, threads: ReadonlySet<string>): boolean {
  const threadId = message.thread?.id
  const rootId = message.thread?.root
  const msgId = splitKey(message.key).id
  return (threadId !== undefined && threads.has(threadId))
    || (rootId !== undefined && threads.has(rootId))
    || threads.has(msgId)
}

/**
 * Prepend the reply `<quote>` element to one publication's content.
 *
 * When `content` is already a `<message>` root (as output renderers produce), the `<quote>` element is inserted as its
 * first child rather than wrapping a second `<message>` around it, because `<message>` is only valid at the root.
 */
function withQuote(content: Fragment, quoteId: string | undefined): Fragment {
  if (quoteId === undefined) return content
  const quoted = h('quote', { id: quoteId })
  if (isElement(content) && content.type === 'message') return { ...content, children: [quoted, ...content.children] }
  return h('message', quoted, content)
}

/** Identity of one request: one operation id may not describe two different publications. */
function fingerprint(content: Fragment | undefined, options: ImSendOptions): string {
  return createHash('sha256').update(JSON.stringify([
    content ?? null, options.quote ?? null, options.thread ?? null,
  ])).digest('hex')
}

/** The text of one thrown value, for a receipt a human reads. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Outcome of a publication an `im/before-send` listener dropped: nothing reached the platform.
 * @param reason - the listener's reason, shown to the caller.
 * @returns a `failed` result marked `dropped`.
 */
function dropped(reason: string): ImSendResult {
  return { status: 'failed', dropped: true, error: `${DROPPED}${reason}` }
}
