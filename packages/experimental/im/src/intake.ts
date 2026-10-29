/**
 * Intake and dispatch loop: `satori/receive` → dedupe (bot, platform event id; a known id is the delivery already
 * recorded) → admission by `sources` → durable store → ACK; own outbound `send` events are stored too; the dispatch
 * loop emits the `im/message` waterfall once per admitted message, serialized per chat, and records the outcome.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { toText } from '@deepseek-ai/cordis-plugin-im-core'
import type { Bot, ChatRef, Element, InboundMessage, SendResult, Session } from '@deepseek-ai/cordis-plugin-im-core'
import {
  ImChatKey, ImMessageKey, ImSourceId, splitKey, type ImChat, type ImCommand, type ImConfig, type ImMessage,
  type ImMessageEvent, type ImOutcome, type ImSourceConfig,
} from './api.ts'
import { ImError } from './error.ts'
import type { ImDispatchState, ImMessageDraft, ImStore } from './store.ts'

/** What the dispatch loop needs from the service to build waterfall events. */
export interface ImIntakeHost {
  /** Build the `im/message` argument (bot, reply/send/deliver bound to the chat). */
  event(message: ImMessage, source: ImSourceConfig): ImMessageEvent
  /** The innermost `im/message` listener (the default dispatcher); absent, an unhandled message is ignored. */
  readonly unhandled?: (event: ImMessageEvent) => Promise<ImOutcome>
}

const noop = () => {}

/** The innermost `im/message` listener without a dispatcher: a message nobody handled is ignored. */
const ignore = (): Promise<ImOutcome> => Promise.resolve({ kind: 'ignored' })

/**
 * Durable intake and dispatch loop.
 *
 * Contract:
 * - {@link receive} resolves only after the message record *and* the event receipt are durable; the adapter ACKs
 *   afterwards. A rejection (a message over `maxInputBytes`, a storage failure) therefore leaves the platform event
 *   unacked and a redelivery is expected.
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
  /** The intake chain: dedupe and store of one event never interleave with another's. */
  private chain: Promise<void> = Promise.resolve()
  /** The pass currently dispatching, if any. */
  private active: Promise<void> | undefined
  /** A pass was requested while one was running. */
  private more = false
  private disposed = false

  constructor(readonly ctx: Context, readonly config: ImConfig, readonly store: ImStore, readonly host: ImIntakeHost) {}

  /**
   * `satori/receive` listener; resolves after the record is durable (the adapter ACKs afterwards).
   * @param session - the adapter session of one received platform message.
   */
  async receive(session: Session): Promise<void> {
    const message = session.message
    if (session.type !== 'message' || message === undefined) return
    const bot = session.bot
    // Some platforms echo the bot's own messages back; those are recorded through `outbound`, not intake.
    if (message.sender.id === bot.selfId) return
    const key = `${bot.id}|${session.event.id ?? message.id}`
    const digest = digestOf(message)
    const accepted = this.chain.then(() => this.accept(bot, message, key, digest))
    this.chain = accepted.then(noop, noop)
    await accepted
    this.pump()
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
  async outbound(bot: Bot, result: SendResult): Promise<ImMessage | undefined> {
    // One logical message per send: the parts of a multi-part message share the content tree, and `parts[0]` is the
    // id later messages quote.
    const part = result.handle.parts[0]
    if (part === undefined) return undefined
    const target = result.handle.target
    const source = this.config.sources.find(candidate => admitsChat(candidate, bot.id, target.chat))
    if (source === undefined) return undefined
    const thread = target.thread
    const time = part.time || Date.now()
    const draft: ImMessageDraft = {
      key: ImMessageKey(bot.id, part.id),
      chat: chatOf(bot.id, target.chat, source),
      ...typeof thread === 'string' ? { thread: { id: thread } } : {},
      sender: { id: bot.selfId, ...bot.user?.name === undefined ? {} : { name: bot.user.name }, isBot: true, self: true },
      content: result.handle.content,
      text: toText(result.handle.content),
      mentions: { self: false, all: false, users: [] },
      addressed: false,
      time,
      via: 'self',
    }
    await this.store.touchChat(draft.chat)
    return this.store.put(draft, 'none')
  }

  /** Kick the pump (new message, startup re-dispatch, retry timer). Never throws. */
  pump(): void {
    if (this.disposed) return
    if (this.active) {
      this.more = true
      return
    }
    const running = this.run()
    this.active = running
    void running.then(() => {
      this.active = undefined
      if (!this.more || this.disposed) return
      this.more = false
      this.pump()
    })
  }

  /** Resolves when no dispatch is in flight (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.active) await this.active
  }

  /** Stop pumping; in-flight waterfalls finish, undispatched records stay pending for the next start. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.chain
    if (this.active) await this.active
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
    const text = await this.quotedText(bot, draft.chat.ref, quote.key)
    return text === undefined ? draft : { ...draft, quote: { ...quote, text } }
  }

  /**
   * The text of one quoted message: the store when this deployment received it, the platform otherwise.
   * @param bot - the bot of the chat being read.
   * @param chat - platform reference of the chat the reply arrived in.
   * @param key - key of the quoted message.
   * @returns its text, or undefined when neither the store nor the platform can show it.
   */
  private async quotedText(bot: Bot, chat: ChatRef, key: ImMessageKey): Promise<string | undefined> {
    const stored = this.store.get(key)
    if (stored !== undefined) return stored.text
    if (bot.getMessage === undefined) return undefined
    try {
      return toText((await bot.getMessage(chat, splitKey(key).id)).content)
    } catch (error: unknown) {
      // The reply is still a deliverable message: a quote the platform will not hand back stays an id.
      this.ctx.logger.warn('IM quoted message %s could not be read: %s', key,
        error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /** Dedupe, admit and store one inbound message; runs in the intake chain. */
  private async accept(bot: Bot, message: InboundMessage, key: string, digest: string): Promise<void> {
    const known = this.store.event(key)
    if (known) {
      // The message ID is the identity a redelivery repeats. The platform hands the same message back with a drifted
      // payload (an edited body, a mention list, a timestamp), and refusing that frame leaves it unacknowledged — so
      // the platform redelivers it again, forever. Report the drift once and treat the message as the duplicate it is.
      if (known.digest !== digest) {
        this.ctx.logger.warn('IM event %s was redelivered with a different payload; the first delivery stands', key)
      }
      return
    }
    const receivedAt = Date.now()
    const source = admit(this.config.sources, bot.id, message)
    if (source === undefined) {
      // Not admitted: remember the event so a redelivery is a cheap no-op, but neither store nor emit the message.
      await this.store.remember(key, { digest, receivedAt })
      return
    }
    const draft = await this.withQuoteText(bot, draftOf(bot, message, source, 'platform'))
    if (source.store === 'addressed' && !draft.addressed) {
      await this.store.remember(key, { digest, receivedAt })
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify(draft))
    if (bytes > this.config.maxInputBytes) {
      throw new ImError('capacity', `IM message ${draft.key} is ${bytes} bytes (maxInputBytes is ${this.config.maxInputBytes}).`)
    }
    await this.store.touchChat(draft.chat)
    const stored = await this.store.put(draft, 'pending')
    await this.store.remember(key, { digest, message: stored.key, receivedAt })
  }

  /** One pump pass: dispatch every pending record, chats in parallel. */
  private async run(): Promise<void> {
    const pending = this.store.pending()
    if (pending.length === 0) return
    const chats = new Map<ImChatKey, ImDispatchState[]>()
    for (const state of pending) {
      const group = chats.get(state.message.chat.key)
      if (group) group.push(state)
      else chats.set(state.message.chat.key, [state])
    }
    await Promise.all([...chats.values()].map(group => this.drain(group)))
  }

  /** Dispatch one chat's pending records in seq order. */
  private async drain(states: readonly ImDispatchState[]): Promise<void> {
    for (const state of states) {
      if (this.disposed) return
      await this.dispatch(state)
    }
  }

  /** Run the waterfall for one record and record its outcome; a failure leaves it pending for a retry. */
  private async dispatch(state: ImDispatchState): Promise<void> {
    const { message } = state
    const source = this.config.sources.find(candidate => candidate.id === message.chat.source)
    try {
      if (source === undefined) {
        // The admitting rule is gone (config edit); retrying forever would never succeed.
        await this.store.settle(message.key, { kind: 'ignored', reason: `source ${message.chat.source} removed` })
        return
      }
      const event = this.host.event(message, source)
      const unhandled = this.host.unhandled
      const fallback = unhandled === undefined ? ignore : () => unhandled(event)
      await this.store.settle(message.key, await this.ctx.waterfall('im/message', event, fallback))
    } catch (error) {
      this.ctx.logger.warn('IM message %s was not dispatched and stays pending: %s', message.key, String(error))
    }
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
 * @param via - how the message reached the host: `platform`, `button` or `self`.
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

/** The name of a `/name` token (letters, digits, `_`, `.`, `-`); undefined when `text` is not one. */
function commandName(text: string): string | undefined {
  if (!text.startsWith('/')) return undefined
  let name = ''
  for (const character of text.slice(1)) {
    if (!/[A-Za-z0-9_.-]/.test(character)) break
    name += character
  }
  // `/` alone, `/ stop` and `/.hidden` are plain text, not commands.
  return /^[A-Za-z0-9]/.test(name) ? name : undefined
}

/** The chat identity of one bot+chat pair under an admitting source. */
function chatOf(bot: string, chat: ChatRef, source: ImSourceConfig): ImChat {
  return { key: ImChatKey(bot, chat.id), bot, ref: chat, source: ImSourceId(source.id) }
}

/** Whether a source admits the bot and the chat (its `users` allowlist needs a sender and is checked separately). */
function admitsChat(source: ImSourceConfig, bot: string, chat: ChatRef): boolean {
  return (source.bot === '*' || source.bot === bot) && allows(source.chats, chat.id)
}

/** An absent or empty allowlist admits anything. */
function allows(list: readonly string[] | undefined, value: string): boolean {
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
