/**
 * Intake and dispatch loop: `satori/receive` → dedupe (bot, platform event id; a known id is the delivery already
 * recorded) → admission by `sources` → durable store → ACK; own outbound `send` events are stored too; the dispatch
 * loop emits the `im/message` waterfall once per admitted message, serialized per chat, and records the outcome.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { h, toText } from '@deepseek-ai/cordis-plugin-im-core'
import type { Bot, ChatRef, Element, InboundMessage, SendResult, SentPart, Session } from '@deepseek-ai/cordis-plugin-im-core'
import {
  ImChatKey, ImMessageKey, ImSourceId, splitKey, type ImChat, type ImCommand, type ImConfig, type ImMessage,
  type ImMessageEvent, type ImOutcome, type ImSourceConfig,
} from './api.ts'
import { ImError } from './error.ts'
import type { ImDispatchState, ImMessageDraft, ImStore } from './store.ts'
import { inputBytes } from './store.ts'

/** What the dispatch loop needs from the service to build waterfall events. */
export interface ImIntakeHost {
  /** Build the `im/message` argument (bot, reply/send/deliver bound to the chat). */
  event(message: ImMessage, source: ImSourceConfig): ImMessageEvent
  /** The innermost `im/message` listener (the default dispatcher); absent, an unhandled message is ignored. */
  readonly unhandled?: (event: ImMessageEvent) => Promise<ImOutcome>
}

const noop = () => {}

/** Bytes of one stored draft that are not its text: identity, sender, chat, timestamps and the JSON punctuation. */
const OWN_ENVELOPE_BYTES = 1024

/**
 * Bytes the delivery intent of one stored message adds to it: its id, mode, media flags, the chat header and the JSON
 * around the messages it repeats, plus the fields the store adds to a draft. A message admitted at the very edge of
 * `maxInputBytes` would otherwise be stored, acknowledged and then refused when it is delivered, which the intake
 * reports as ignored. The default dispatcher's intent for a message with real Feishu identifiers adds about 240 bytes
 * (pinned in `intake.spec.ts`); the reserve doubles that, for a routing plugin's longer header.
 */
export const DELIVERY_ENVELOPE_BYTES = 512

/**
 * One own draft with only the head of its text that fits a byte budget.
 * @param draft - the draft to shorten.
 * @param room - UTF-8 bytes the text may take.
 * @returns the draft with its content and text cut to that head.
 */
function headed(draft: ImMessageDraft, room: number): ImMessageDraft {
  let used = 0
  let end = 0
  for (const character of draft.text) {
    used += Buffer.byteLength(character)
    if (used > room) break
    end += character.length
  }
  const text = draft.text.slice(0, end)
  return { ...draft, content: h('message', h.text(text)), text }
}

/**
 * Whether the platform handed this message as a card. A card arrives as a projection of itself, which is only the part
 * the platform is willing to describe: the card as it was sent is a platform read away.
 * @param content - the decoded message content.
 * @returns true for a card message.
 */
function isCard(content: Element<'message'>): boolean {
  return content.children.some(child => child.type === 'raw' && child.attrs.type === 'interactive')
}

/**
 * Whether the content carries a merged forward whose entries never arrived. An event hands the container alone, so its
 * contents are one platform read away; a read fills them in and the element is no longer empty.
 * @param content - the decoded message content.
 * @returns true when a `<forward>` has no entries.
 */
export function hasUnreadForward(content: Element<'message'>): boolean {
  return content.children.some(carriesUnreadForward)
}

/** {@link hasUnreadForward} over one node, so a forward nested inside another one is found too. */
function carriesUnreadForward(node: Element): boolean {
  return node.type === 'forward' ? node.children.length === 0 : node.children.some(carriesUnreadForward)
}

/** The innermost `im/message` listener without a dispatcher: a message nobody handled is ignored. */
const ignore = (): Promise<ImOutcome> => Promise.resolve({ kind: 'ignored' })

/**
 * Durable intake and dispatch loop.
 *
 * Contract:
 * - {@link receive} resolves only after the message record *and* the event receipt are durable; the adapter ACKs
 *   afterwards. A rejection — a storage failure, or a frame arriving after {@link dispose} — therefore leaves the
 *   platform event unacked and a redelivery is
 *   expected. A message over `maxInputBytes` is remembered and acknowledged instead: refusing it would have the
 *   platform redeliver a message that can never be accepted. The platform reads of a frame (a card, a merged forward,
 *   the text of a quoted reply) happen outside the store chain and in arrival order per chat, so a slow read delays
 *   only its own chat and never lets a later message of that chat take a smaller `seq`.
 * - A `(bot, event id)` the intake already recorded is one delivery: the record the first delivery stored stands, a
 *   payload that drifted from it is logged once, and the redelivered frame is ACKed like any duplicate.
 * - A chat matched by no `sources` rule is neither stored nor emitted.
 * - {@link pump} dispatches pending records through `ctx.waterfall('im/message', …)` — chats in parallel, one message
 *   at a time inside a chat — then records the outcome. A throwing listener leaves the record pending, so the retry
 *   timer and the next start re-dispatch it; listeners must be idempotent.
 * - A message no listener handled settles on `host.unhandled` (the default dispatcher) when the host has one, else as
 *   `ignored`.
 */
export class ImIntake {
  /** The store chain: recording and storing one frame never interleave with another's; platform reads stay outside. */
  private chain: Promise<void> = Promise.resolve()
  /**
   * Per chat, the chain of the platform reads one frame needs: a slow read of one message finishes before the next
   * message of the same chat is read, so arrival order decides `seq`. Chats never wait for each other.
   */
  private readonly reading = new Map<ImChatKey, Promise<void>>()
  /** Frames already accepted and not finished yet, so {@link dispose} can wait for the ones still reading. */
  private readonly receiving = new Set<Promise<void>>()
  /** Own publications in flight, by message key, so a receipt can wait for the record one of them stores. */
  private readonly announcing = new Map<string, Promise<ImMessage | undefined>>()
  /** Per chat, the drain pass currently dispatching. */
  private readonly draining = new Map<ImChatKey, Promise<void>>()
  /** Chats that received a pump request while their drain was already running. */
  private readonly more = new Set<ImChatKey>()
  private disposed = false
  /** Dispatch is held until the composition is complete ({@link hold}, {@link release}); frames are still stored. */
  private held = false

  constructor(readonly ctx: Context, readonly config: ImConfig, readonly store: ImStore, readonly host: ImIntakeHost) {}

  /**
   * `satori/receive` listener; resolves after the record is durable (the adapter ACKs afterwards).
   * @param session - the adapter session of one received platform message.
   */
  async receive(session: Session): Promise<void> {
    const running = this.receiveFrame(session)
    this.receiving.add(running)
    try {
      await running
    } finally {
      this.receiving.delete(running)
    }
  }

  /**
   * Record, store and pump one received frame.
   * @param session - the adapter session of one received platform message.
   */
  private async receiveFrame(session: Session): Promise<void> {
    // A frame that arrives while this intake is shutting down rejects instead of returning: a listener that returns
    // is an accepted frame, so the adapter would acknowledge a message this process never stored and the platform
    // would never redeliver it.
    if (this.disposed) throw new ImError('unavailable', 'The IM intake is shutting down; this frame was not stored.')
    if (session.type !== 'message' || session.message === undefined) return
    const message = session.message
    const bot = session.bot
    // Some platforms echo the bot's own messages back; those are recorded through `outbound`, not intake.
    if (message.sender.id === bot.selfId) return
    const key = `${bot.id}|${session.event.id ?? message.id}`
    const digest = digestOf(message)
    const known = this.store.event(key)
    if (known !== undefined) {
      // The message ID is the identity a redelivery repeats. The platform hands the same message back with a drifted
      // payload (an edited body, a mention list, a timestamp), and refusing that frame leaves it unacknowledged — so
      // the platform redelivers it again, forever. Report the drift once and treat the message as the duplicate it is.
      if (known.digest !== digest) {
        this.ctx.logger.warn('IM event %s was redelivered with a different payload; the first delivery stands', key)
      }
      this.pump()
      return
    }
    const receivedAt = Date.now()
    // The platform reads of one draft — a card, a merged forward, the text of a quoted reply — happen BEFORE the intake
    // chain, because that chain is what the rest of this listener's callers wait on to acknowledge: a slow read inside
    // it delayed the acknowledgement of every other chat. They stay in arrival order inside one chat, so a slow read
    // cannot hand a later message a smaller `seq`; a frame that races another copy of itself may read twice, and the
    // store keeps one record per key either way.
    const chat = ImChatKey(bot.id, message.chat.id)
    const draft = await this.readInOrder(chat, () => this.inspect(bot, message))
    const accepted = this.chain.then(() => this.accept(key, digest, receivedAt, draft))
    this.chain = accepted.then(noop, noop)
    await accepted
    this.pump()
  }

  /**
   * Run the platform reads of one frame behind the reads already queued for its chat.
   * @param chat - the chat the frame arrived in.
   * @param inspect - the reads and admission of that frame.
   * @returns what that frame stores, exactly as {@link inspect} answers.
   */
  private readInOrder(chat: ImChatKey, inspect: () => Promise<ImMessageDraft | undefined>): Promise<ImMessageDraft | undefined> {
    const previous = this.reading.get(chat) ?? Promise.resolve()
    // A read that failed must not stall the chat: the next frame reads whether or not the previous one succeeded.
    const running = previous.then(inspect, inspect)
    const settled = running.then(noop, noop)
    this.reading.set(chat, settled)
    void settled.then(() => { if (this.reading.get(chat) === settled) this.reading.delete(chat) })
    return running
  }

  /**
   * `send` listener: store the bot's own published message (`via: 'self'`) in admitted chats.
   *
   * Own messages are stored even for a source with `store: 'addressed'` (that rule filters what the chat hears), so a
   * session reading its own history sees what it already said.
   * @param bot - the bot that published.
   * @param result - the publication the core reported, whose first part identifies the stored message.
   * @returns the stored own message, or undefined when the chat is unadmitted or the result carries no part.
   */
  outbound(bot: Bot, result: SendResult): Promise<ImMessage | undefined> {
    // One logical message per send: the parts of a multi-part message share the content tree, and `parts[0]` is the
    // id later messages quote.
    const part = result.handle.parts[0]
    if (part === undefined) return Promise.resolve(undefined)
    const key = ImMessageKey(bot.id, part.id)
    // Registered before the first await, so a caller that asks right after the platform answered still finds it.
    const running = this.announce(bot, result, part)
    this.announcing.set(key, running)
    const settled = (): void => {
      if (this.announcing.get(key) === running) this.announcing.delete(key)
    }
    void running.then(settled, settled)
    return running
  }

  /**
   * The own message of one publication, once the announcement that stores it has finished.
   * @param key - message key of the platform message the publication produced.
   * @returns the stored message, or undefined when no chat admits it or nothing announces that key.
   */
  async announced(key: ImMessageKey): Promise<ImMessage | undefined> {
    const running = this.announcing.get(key)
    return running === undefined ? undefined : await running
  }

  /** Wait for every in-flight `outbound` announcement to finish storing its own message. */
  async drainAnnouncements(): Promise<void> {
    await Promise.allSettled([...this.announcing.values()])
  }

  /**
   * Store one own publication (`via: 'self'`) in the chat it went to. Own messages are stored even for a source with
   * `store: 'addressed'` (that rule filters what the chat hears), so a session reading its own history sees what it
   * already said.
   * @param bot - the bot that published.
   * @param result - the publication the core reported.
   * @param part - the platform message that identifies it.
   * @returns the stored own message, or undefined when the chat is unadmitted.
   */
  private async announce(bot: Bot, result: SendResult, part: SentPart): Promise<ImMessage | undefined> {
    const target = result.handle.target
    const source = this.config.sources.find(candidate => admitsChat(candidate, bot.id, target.chat))
    if (source === undefined) return undefined
    const chat = chatOf(bot.id, target.chat, source)
    const quoteNode = result.handle.content.children.find(
      (child): child is Element<'quote'> => child.type === 'quote',
    )
    const quotedCandidate = quoteNode === undefined
      ? undefined
      : this.store.get(ImMessageKey(bot.id, quoteNode.attrs.id))
    const quoted = quotedCandidate?.chat.key === chat.key ? quotedCandidate : undefined
    const resolvedThread = part.thread !== undefined
      ? { id: part.thread.id, ...part.thread.root === undefined ? {} : { root: part.thread.root } }
      : typeof target.thread === 'string'
        ? { id: target.thread, ...quoted?.thread?.root === undefined ? {} : { root: quoted.thread.root } }
        : quoted?.thread === undefined
          ? undefined
          : { ...quoted.thread }
    const referrer = part.referrer ?? target.referrer ?? quoted?.referrer
    const time = part.time || Date.now()
    const draft: ImMessageDraft = {
      key: ImMessageKey(bot.id, part.id),
      chat,
      ...resolvedThread === undefined ? {} : { thread: resolvedThread },
      sender: { id: bot.selfId, ...bot.user?.name === undefined ? {} : { name: bot.user.name }, isBot: true, self: true },
      content: result.handle.content,
      text: toText(result.handle.content),
      mentions: { self: false, all: false, users: [] },
      addressed: false,
      time,
      ...part.aliases?.length ? { aliases: [...part.aliases] } : {},
      ...referrer === undefined ? {} : { referrer },
      via: 'self',
    }
    const bounded = this.boundedOwn(draft)
    await this.store.touchChat(bounded.chat)
    return this.store.put(bounded, 'none')
  }

  /**
   * One own publication, bounded by the budget the intake applies to inbound messages. A publication can carry an
   * inline resource (`data:`) or a body the model wrote, and `im_messages` keeps it for the whole retention window
   * while the platform already has it — a file sent this way used to leave a multi-megabyte record behind. Over the
   * budget, only the head of its text is stored.
   * @param draft - the draft of the message this host published.
   * @returns the draft to store.
   */
  private boundedOwn(draft: ImMessageDraft): ImMessageDraft {
    const budget = this.config.maxInputBytes
    if (inputBytes(draft) <= budget) return draft
    // The stored draft carries its text twice (`content` and `text`), and JSON escapes part of it (a newline or a quote
    // is two bytes, a control character six), so the estimate is measured again on the record it produced and shrunk
    // until that record fits.
    let room = Math.max(1, Math.floor((budget - OWN_ENVELOPE_BYTES) / 2))
    let bounded = headed(draft, room)
    while (inputBytes(bounded) > budget && room > 1) {
      room = Math.floor(room / 2)
      bounded = headed(draft, room)
    }
    this.ctx.logger.warn('IM own message %s is over maxInputBytes (%s); only its text is stored', draft.key, budget)
    return bounded
  }

  /**
   * Hold every dispatch until {@link release}. Receiving goes on — each frame is stored and acknowledged — but no
   * message reaches `im/message`, so a command a previous process left pending, or one arriving while the plugins that
   * listen to `im/message` are still starting, is not settled as an ordinary message by whoever listens first.
   */
  hold(): void {
    this.held = true
  }

  /** End a {@link hold} and dispatch everything stored meanwhile. */
  release(): void {
    if (!this.held) return
    this.held = false
    this.pump()
  }

  /** Kick the pump (new message, startup re-dispatch, retry timer). Chats drain in parallel without blocking each other. Never throws. */
  pump(): void {
    if (this.disposed || this.held) return
    const pending = this.store.pending()
    if (pending.length === 0) return
    const chats = new Map<ImChatKey, ImDispatchState[]>()
    for (const state of pending) {
      const chat = state.message.chat.key
      const group = chats.get(chat)
      if (group) group.push(state)
      else chats.set(chat, [state])
    }
    for (const [chat, group] of chats) {
      if (this.draining.has(chat)) {
        this.more.add(chat)
        continue
      }
      this.startDrain(chat, group)
    }
  }

  /**
   * Drain one chat's pending records and, if more work arrived for that same chat while draining, continue only that
   * chat without re-pumping unrelated chats (which would otherwise cross-trigger failing chats past `retryIntervalMs`).
   */
  private startDrain(chat: ImChatKey, group: readonly ImDispatchState[]): void {
    const running = this.drain(group)
    this.draining.set(chat, running)
    void running.then(() => {
      this.draining.delete(chat)
      if (!this.more.delete(chat) || this.disposed) return
      const next = this.store.pending().filter(state => state.message.chat.key === chat)
      this.startDrain(chat, next)
    })
  }

  /** Resolves when no dispatch is in flight (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.draining.size > 0) await Promise.all(this.draining.values())
  }

  /**
   * One platform read, ended at `config.platformTimeoutMs`. `bot.getMessage` takes no signal, so a request the platform
   * never answers would hold this chat's arrival order open — and with it {@link dispose}, which waits for the reads in
   * flight — for as long as the socket lives. The deadline only stops the waiting: the request itself is abandoned, not
   * cancelled, and stays open until the transport's own timeout (the bundle's `im-http` row) or the connection ends it.
   * @param read - the platform read to run.
   * @returns what the platform answered.
   */
  private readWithin<T>(read: Promise<T>): Promise<T> {
    return readWithin(read, this.config.platformTimeoutMs)
  }

  /**
   * Stop receiving and pumping. Frames already accepted finish first — one may still be reading the platform, and its
   * store write needs a store that is still open — then the in-flight waterfall finishes and undispatched records stay
   * pending for the next start.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.receiving])
    await this.chain
    await Promise.all(this.draining.values())
  }

  /**
   * The reply about to be stored, with the text of the message it quotes filled in. An event carries only the quoted
   * id, and an id is not something a reader can open: without this the model answers a reply about material it cannot
   * see, and guesses at the subject.
   * @param bot - the bot that delivered the reply.
   * @param draft - the reply as admission built it.
   * @returns the draft, with the quoted text when it could be read.
   */
  private async withQuoteText(bot: Bot, draft: ImMessageDraft): Promise<ImMessageDraft> {
    const quote = draft.quote
    if (quote === undefined || quote.text !== undefined) return draft
    const text = await this.quotedText(bot, draft.chat, quote.key)
    return text === undefined ? draft : { ...draft, quote: { ...quote, text } }
  }

  /**
   * The text of one quoted message: the store when this deployment received it in the same chat, the platform otherwise.
   * @param bot - the bot of the chat being read.
   * @param chat - admitted chat the reply arrived in.
   * @param key - key of the quoted message.
   * @returns its text, or undefined when neither the store nor the platform can show it.
   */
  private async quotedText(bot: Bot, chat: ImChat, key: ImMessageKey): Promise<string | undefined> {
    const stored = this.store.get(key)
    if (stored !== undefined && stored.chat.key === chat.key) return stored.text
    if (bot.getMessage === undefined) return undefined
    try {
      return toText((await this.readWithin(bot.getMessage(chat.ref, splitKey(key).id))).content)
    } catch (error: unknown) {
      // The reply is still a deliverable message: a quote the platform will not hand back stays an id.
      this.ctx.logger.warn('IM quoted message %s could not be read: %s', key,
        error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /**
   * The draft of one inbound message, with the two things an event does not carry filled in: the text of the card it
   * renders or the entries of a merged forward, and the text of the message it quotes.
   * @param bot - the bot that delivered the message.
   * @param message - the inbound message.
   * @param source - the admitting source.
   * @returns the draft to store and dispatch.
   */
  private async readableDraft(bot: Bot, message: InboundMessage, source: ImSourceConfig): Promise<ImMessageDraft> {
    const draft = draftOf(bot, message, source, 'platform')
    const unreadable = isCard(message.content) || hasUnreadForward(message.content)
    const read = unreadable ? await this.reread(bot, message) : undefined
    // Only the content is taken from the read: the event owns the admission facts (mentions, addressed, thread,
    // quote), and neither a card nor a merged forward carries mentions of its own.
    const readable = read === undefined ? draft : this.enriched(draft, read)
    return await this.withQuoteText(bot, readable)
  }

  /**
   * The draft with the content of the message read back. A read that would push the message past `maxInputBytes` is
   * not used: {@link accept} refuses such a message entirely, and the reference the event carried is worth more than
   * losing the message.
   * @param draft - the draft as admission built it.
   * @param read - the message read back from the platform.
   * @returns the draft to store.
   */
  private enriched(draft: ImMessageDraft, read: InboundMessage): ImMessageDraft {
    const next: ImMessageDraft = { ...draft, content: read.content, text: toText(read.content) }
    return inputBytes(next) > this.config.maxInputBytes ? draft : next
  }

  /**
   * One message re-read for the part its event does not carry: a card as the JSON it was sent with rather than the
   * placeholder the platform projects, or the contents of a merged forward.
   * @param bot - the bot that delivered the message.
   * @param message - the inbound message to re-read.
   * @returns the re-read message, or undefined when the platform has nothing more to give.
   */
  private async reread(bot: Bot, message: InboundMessage): Promise<InboundMessage | undefined> {
    if (bot.getMessage === undefined) return undefined
    try {
      return await this.readWithin(bot.getMessage(message.chat, message.id))
    } catch (error: unknown) {
      // The reference is still a deliverable message: what the platform will not hand back stays unreadable.
      this.ctx.logger.warn('IM message %s could not be re-read: %s', message.id,
        error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /**
   * Admission and the platform reads of one received frame, outside the intake chain: the draft to store, or
   * `undefined` for a frame that is recorded but not stored.
   * @param bot - the bot that delivered the frame.
   * @param message - the inbound message.
   * @returns the draft to store and dispatch.
   */
  private async inspect(bot: Bot, message: InboundMessage): Promise<ImMessageDraft | undefined> {
    const source = admit(this.config.sources, bot.id, message)
    if (source === undefined) return undefined
    const draft = await this.readableDraft(bot, message, source)
    return source.store === 'addressed' && !draft.addressed ? undefined : draft
  }

  /**
   * Record and store one inspected frame. This is the chain's job, and the chain is the only place the event record and
   * the stored message are written.
   * @param key - `${bot}|${event id}`, the identity a redelivery repeats.
   * @param digest - payload digest of this frame.
   * @param receivedAt - when the frame arrived, kept across the chain.
   * @param draft - the inspected draft, or undefined for a frame that is only remembered.
   */
  private async accept(
    key: string, digest: string, receivedAt: number, draft: ImMessageDraft | undefined,
  ): Promise<void> {
    // A concurrent frame of the same event may have stored it while this one was reading the platform.
    if (this.store.event(key) !== undefined) return
    if (draft === undefined) {
      // Not admitted: remember the event so a redelivery is a cheap no-op, but neither store nor emit the message.
      await this.store.remember(key, { digest, receivedAt })
      return
    }
    const bytes = inputBytes(draft)
    // The delivery intent of this message carries it again plus the intent's own fields, and an over-budget delivery is
    // refused later, when nothing can be reported to the chat any more. Reserve that overhead here.
    if (bytes + DELIVERY_ENVELOPE_BYTES > this.config.maxInputBytes) {
      // Acknowledge and dedupe like a drifted redelivery: a refusal would leave the frame unacked, and the platform
      // would redeliver a message that can never be accepted.
      this.ctx.logger.warn(
        'IM message %s is %s bytes, over what maxInputBytes (%s) leaves for delivery; acknowledged without dispatching',
        draft.key, bytes, this.config.maxInputBytes)
      await this.store.remember(key, { digest, receivedAt })
      return
    }
    await this.store.touchChat(draft.chat)
    const stored = await this.store.put(draft, 'pending')
    await this.store.remember(key, { digest, message: stored.key, receivedAt })
  }

  /**
   * Dispatch one chat's pending records in seq order, stopping at the first one that fails: its record stays pending,
   * and the next message of that chat must wait for it instead of overtaking it.
   */
  private async drain(states: readonly ImDispatchState[]): Promise<void> {
    for (const state of states) {
      if (this.disposed) return
      if (!await this.dispatch(state)) return
    }
  }

  /**
   * Run the waterfall for one record and record its outcome; a failure leaves it pending for a retry.
   * @param state - the stored message and its dispatch state.
   * @returns true when the record settled, false when it stays pending for the next pass.
   */
  private async dispatch(state: ImDispatchState): Promise<boolean> {
    const { message } = state
    const source = this.config.sources.find(candidate => candidate.id === message.chat.source)
    try {
      if (source === undefined) {
        // The admitting rule is gone (config edit); retrying forever would never succeed.
        await this.store.settle(message.key, { kind: 'ignored', reason: `source ${message.chat.source} removed` })
        return true
      }
      const event = this.host.event(message, source)
      const unhandled = this.host.unhandled
      const fallback = unhandled === undefined ? ignore : () => unhandled(event)
      await this.store.settle(message.key, await this.ctx.waterfall('im/message', event, fallback))
      return true
    } catch (error) {
      if (error instanceof ImError && error.code === 'capacity' && error.permanent) {
        // The message can never be dispatched: it is over the size the delivery budget allows. Settling it keeps the
        // chat draining — one oversized message used to stay pending forever, so every later message of that chat
        // (including the `/stop` and `/clear` that would have unstuck it) waited behind it.
        this.ctx.logger.warn('IM message %s cannot be dispatched and was dropped: %s', message.key, String(error))
        try {
          await this.store.settle(message.key, { kind: 'ignored', reason: error.message })
        } catch (failure) {
          this.ctx.logger.error('IM message %s could not be settled: %s', message.key, String(failure))
          return false
        }
        return true
      }
      this.ctx.logger.warn('IM message %s was not dispatched and stays pending: %s', message.key, String(error))
      return false
    }
  }
}

/**
 * Bound one platform read by `timeout` ms and an optional caller `AbortSignal`.
 * @param read - the platform read promise to race.
 * @param timeout - deadline in milliseconds (`config.platformTimeoutMs`).
 * @param signal - optional cancellation signal from a tool call.
 * @returns what the platform answered.
 */
export async function readWithin<T>(read: Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
  // Attach a no-op handler immediately so a rejected platform request cannot trigger `unhandledRejection` if
  // `signal?.aborted` throws early or the deadline/abort wins the race.
  void read.catch(() => {})
  if (signal?.aborted) {
    throw new ImError('unavailable', 'the platform read was aborted', { cause: signal.reason })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const bounded = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ImError('unavailable', `the platform did not answer within ${timeout} ms`))
    }, timeout)
    timer.unref()
    if (signal) {
      onAbort = () => {
        reject(new ImError('unavailable', 'the platform read was aborted', { cause: signal.reason }))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([read, bounded])
  } finally {
    clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * First source admitting the message (bot `*` matches any bot); undefined = not stored, not emitted.
 * @param sources - the configured admission rules, in operator order.
 * @param bot - id of the bot that received the message.
 * @param message - the received platform message (its chat and sender are matched against the rule).
 * @returns the admitting source, or undefined when no rule matches.
 */
export function admit(sources: readonly ImSourceConfig[], bot: string, message: InboundMessage): ImSourceConfig | undefined {
  return sources.find(source => admitsChat(source, bot, message.chat) && allows(source.users, message.sender.id))
}

/**
 * Build the store draft of an inbound message (text via `toText`, addressed, command, quote key, referrer).
 * @param bot - the bot that received the message.
 * @param message - the received platform message.
 * @param source - the admitting rule, which names the chat's source id.
 * @param via - how the message reached the host: `platform` (received or read) or `self` (published by this host).
 * @returns the draft the store turns into an {@link ImMessage} by assigning the chat's next seq.
 */
export function draftOf(bot: Bot, message: InboundMessage, source: ImSourceConfig, via: ImMessage['via']): ImMessageDraft {
  const quote = message.quote === undefined ? undefined : {
    key: ImMessageKey(bot.id, message.quote.id),
    ...message.quote.sender === undefined ? {} : { sender: message.quote.sender },
    ...message.quote.content === undefined ? {} : { text: toText(message.quote.content) },
  }
  const command = parseCommand(message.content, bot.selfId)
  const referrer = message.referrer
  return {
    key: ImMessageKey(bot.id, message.id),
    ...message.aliases?.length ? { aliases: [...message.aliases] } : {},
    chat: chatOf(bot.id, message.chat, source),
    ...message.thread === undefined ? {} : { thread: message.thread },
    sender: { ...message.sender, self: message.sender.id === bot.selfId },
    content: message.content,
    text: toText(message.content),
    ...quote === undefined ? {} : { quote },
    mentions: message.mentions,
    addressed: message.chat.type === 'direct' || message.mentions.self,
    ...command === undefined ? {} : { command },
    time: message.time,
    via,
    // Adapter-owned reply context (QQ passive key, Lark thread); stored opaque and handed back as `Target.referrer`.
    ...referrer === undefined ? {} : { referrer },
  }
}

/**
 * Parse a slash command after stripping leading self-mentions: `@bot /stop` → `{ name: 'stop', rawInput: '' }`.
 * Only the leading text run is inspected; everything after the command name — further text, mentions rendered as
 * `@name` — becomes `rawInput` with its leading whitespace kept, so a passthrough command sees exactly what was typed.
 * @param content - Message content.
 * @param selfId - The bot's platform user id (mentions of it are stripped).
 * @returns the parsed command, or undefined when the message does not start with a `/name` token.
 */
export function parseCommand(content: InboundMessage['content'], selfId: string): ImCommand | undefined {
  const children = content.children
  const index = children.findIndex(child => !isLeadingDecoration(child, selfId))
  const head = children[index]
  if (head === undefined || head.type !== 'text') return undefined
  const text = head.attrs.content.replace(/^\s+/, '')
  const name = commandName(text)
  if (name === undefined) return undefined
  return { name, rawInput: text.slice(name.length + 1) + toText(children.slice(index + 1)) }
}

/** Whether a leading child is stripped before looking for the command: a self-mention or blank text. */
function isLeadingDecoration(child: Element, selfId: string): boolean {
  if (child.type === 'at') return child.attrs.id === selfId
  return child.type === 'text' && child.attrs.content.trim() === ''
}

/**
 * The name of a `/name` token (letters, digits, `_`, `.`, `-`) followed by whitespace or end-of-text; undefined when
 * `text` is plain text (such as `/new/project` or `/clear()`).
 */
function commandName(text: string): string | undefined {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_.-]*)(?=$|\s)/.exec(text)
  return match?.[1]
}

/** The chat identity of one bot+chat pair under an admitting source. */
function chatOf(bot: string, chat: ChatRef, source: ImSourceConfig): ImChat {
  return { key: ImChatKey(bot, chat.id), bot, ref: chat, source: ImSourceId(source.id) }
}

/**
 * Whether a source admits the bot and the chat (its `users` allowlist needs a sender and is checked separately).
 * @param source - one configured admission rule.
 * @param bot - id of the bot that received the message or the interaction.
 * @param chat - the platform chat the event belongs to.
 * @returns true when the rule names this bot (or any bot) and this chat (or every chat).
 */
export function admitsChat(source: ImSourceConfig, bot: string, chat: ChatRef): boolean {
  return (source.bot === '*' || source.bot === bot) && allows(source.chats, chat.id)
}

/**
 * Whether one allowlist admits a platform id; an absent or empty list admits anything.
 * @param list - configured ids of a source's `chats` or `users`, or undefined when not configured.
 * @param value - the platform id to test (a chat id or a user id).
 * @returns true when the list admits the value.
 */
export function allows(list: readonly string[] | undefined, value: string): boolean {
  return list === undefined || list.length === 0 || list.includes(value)
}

/** sha256 of a canonical (key-sorted) JSON projection: the redelivery comparison behind `StoredEvent.digest`. */
function digestOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

/** Deterministic JSON: object keys sorted, so an adapter's key order never reports a drift that did not happen. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
