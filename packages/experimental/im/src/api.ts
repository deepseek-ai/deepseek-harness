/**
 * Public contract of `@deepseek-ai/dsh-im`: the platform-neutral IM host. Platform output is never produced by the
 * core — sessions publish through output renderers (`ctx.im.outputs`) or tools; inbound messages are routed by
 * plugins listening to the `im/message` waterfall.
 */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type {
  Bot, ButtonEvent, ChatRef, CheckEvent, Element, Fragment, InboundMessage, MembersPage, MessageHandle,
  MessageStream, RenderReport, SelectEvent, SendOptions, StreamOptions, UserRef,
} from '@deepseek-ai/cordis-plugin-im-core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

// ---------------------------------------------------------------------------------------------------------------
// Identities

/** Operator-configured admission source id. */
export type ImSourceId = Branded<'ImSourceId'>
/** Global chat identity: `${botId}|${chat.id}`. */
export type ImChatKey = Branded<'ImChatKey'>
/** Global message identity: `${botId}|${message.id}`. */
export type ImMessageKey = Branded<'ImMessageKey'>

/**
 * Brand a configured source id, so an operator-configured `sources[].id` becomes the value `ImChat.source` carries.
 * @param value - the configured source id.
 * @returns the same text, branded as an {@link ImSourceId}.
 */
export function ImSourceId(value: string): ImSourceId { return brandString<ImSourceId>(value) }

/**
 * The global key of one chat.
 * @param bot - Bot id (`lark:cli_xxx`, `qq:102106848`).
 * @param chat - Platform chat id (`ChatRef.id`).
 * @returns the `${bot}|${chat}` key every chat-addressed API takes.
 */
export function ImChatKey(bot: string, chat: string): ImChatKey { return brandString<ImChatKey>(`${bot}|${chat}`) }

/**
 * The global key of one platform message.
 * @param bot - Bot id.
 * @param message - Platform message id.
 * @returns the `${bot}|${message}` key receipts, quotes and attribution are recorded under.
 */
export function ImMessageKey(bot: string, message: string): ImMessageKey { return brandString<ImMessageKey>(`${bot}|${message}`) }

/**
 * Split a chat or message key into its bot id and platform id (the bot id never contains `|`).
 * @param key - a key built by {@link ImChatKey} or {@link ImMessageKey}.
 * @returns the bot id (`''` for an unkeyed text) and the platform id the adapter understands.
 */
export function splitKey(key: ImChatKey | ImMessageKey): { bot: string; id: string } {
  const at = key.indexOf('|')
  return at < 0 ? { bot: '', id: key } : { bot: key.slice(0, at), id: key.slice(at + 1) }
}

// ---------------------------------------------------------------------------------------------------------------
// Messages and the `im/message` waterfall

/** One admitted chat: its global key, the bot that serves it, the adapter's chat ref and the rule that admitted it. */
export interface ImChat {
  key: ImChatKey
  /** Bot id owning the chat. */
  bot: string
  ref: ChatRef
  /** The admitting source (first matching rule). */
  source: ImSourceId
}

/**
 * One stored message — inbound or an own outbound publication — as the store keeps it: the per-chat sequence number
 * that history and media ids are addressed by, plus the admission facts (addressed, command, referrer) later readers
 * need.
 */
export interface ImMessage {
  key: ImMessageKey
  /** Alternative platform message ids for the same message (e.g. QQ `msg_idx`), indexed for quote/read lookup. */
  aliases?: readonly string[]
  /** Per chat, monotonic, assigned at store time (inbound and own outbound). */
  seq: number
  chat: ImChat
  thread?: { id: string; root?: string }
  sender: UserRef & { self: boolean }
  content: Element<'message'>
  /** `toText(content)`, mentions rendered as `@name`. */
  text: string
  quote?: { key: ImMessageKey; sender?: UserRef; text?: string }
  mentions: InboundMessage['mentions']
  /** Direct chat or `mentions.self`. */
  addressed: boolean
  /** Leading self-mentions stripped; set when the remaining text is a slash command. */
  command?: ImCommand
  time: number
  via: 'platform' | 'self'
  /**
   * Adapter-private reply context of the platform event that delivered this message (`InboundMessage.referrer`): the
   * passive-reply key of a QQ event, the thread placement of a Lark event. The IM host never inspects it — it is stored
   * as-is (JSON) and handed back as `Target.referrer` when a publication answers this message.
   */
  referrer?: unknown
}

/** A slash command parsed from a message: `/name rawInput`. */
export interface ImCommand {
  /** Command name without the leading slash, e.g. `stop`, `ai`, `ai.reset`. */
  name: string
  /** Everything after the name (leading whitespace kept for exact passthrough). */
  rawInput: string
}

/** What the `im/message` waterfall settled on: a listener handled the message, or nobody did. */
export type ImOutcome =
  | { kind: 'handled'; by: string; sessions?: SessionId[] }
  | { kind: 'ignored'; reason?: string }

/** Argument of the `im/message` waterfall: one admitted inbound message plus chat-bound helpers. */
export interface ImMessageEvent {
  readonly message: ImMessage
  /** The admitting source configuration (strategies read `writable`). */
  readonly source: ImSourceConfig
  readonly bot: Bot
  /**
   * Send into the chat quoting this message (and in its thread, if any); its adapter referrer rides on the target.
   * `quote` is attached only while this message remains stored in `im_messages`: if `maxRecords` or `retentionMs`
   * removed it, the reply still publishes into the same chat (and thread) without a quote instead of failing.
   * The publication carries no session, so the chat's admission is its only gate (`sources[].writable` governs the
   * publications a session claims).
   */
  reply(content: Fragment, options?: ImSendOptions): Promise<ImSendResult>
  /** Send into the same chat without quote, under the same gates as {@link reply}. */
  send(content: Fragment, options?: ImSendOptions): Promise<ImSendResult>
  /**
   * Convenience: deliver this message into a session. `id` defaults to the message key (idempotent on
   * re-dispatch), `content` to `[message]` (formatted with `ctx.im.format`), `trigger` to the last delivered message.
   */
  deliver(target: SessionId | string, options: ImEventDelivery): Promise<void>
}

/** Options of {@link ImMessageEvent.deliver}. */
export type ImEventDelivery = Omit<ImDelivery, 'id' | 'content'> & { id?: string; content?: ImDelivery['content'] }

/** A button click in an admitted chat (`button[type=action]`), re-emitted by the core as `im/button`. */
export interface ImButtonEvent {
  /** `button.id` as rendered by the plugin that published the control. */
  readonly id: string
  readonly data?: unknown
  /** Values of the `<form>` a submit button stood in, keyed by control name. */
  readonly values?: ButtonEvent['values']
  readonly chat: ImChat
  readonly user: UserRef
  readonly bot: Bot
  /** The own stored message that carried the button, when known. */
  readonly message?: ImMessage
  /** The session whose send/output produced that message, when known. */
  readonly session?: SessionId
  readonly time: number
  /** The raw core interaction event. */
  readonly raw: ButtonEvent
}

/** A `<select>` pick in an admitted chat, re-emitted by the core as `im/select`. */
export interface ImSelectEvent {
  /** `select.id` as rendered. */
  readonly id: string
  /** Chosen option values, one for a single select, in option order for a multiple one. */
  readonly values: string[]
  readonly data?: unknown
  readonly chat: ImChat
  readonly user: UserRef
  readonly bot: Bot
  /** The own stored message that carried the control, when known. */
  readonly message?: ImMessage
  /** The session whose send/output produced that message, when known. */
  readonly session?: SessionId
  readonly time: number
  /** The raw core interaction event. */
  readonly raw: SelectEvent
}

/** A checkbox toggle in an admitted chat, re-emitted by the core as `im/check`. */
export interface ImCheckEvent {
  /** `input.id` as rendered. */
  readonly id: string
  /** State after the toggle. */
  readonly checked: boolean
  readonly data?: unknown
  readonly chat: ImChat
  readonly user: UserRef
  readonly bot: Bot
  /** The own stored message that carried the checkbox, when known. */
  readonly message?: ImMessage
  /** The session whose send/output produced that message, when known. */
  readonly session?: SessionId
  readonly time: number
  /** The raw core interaction event. */
  readonly raw: CheckEvent
}

/** A reaction added to or removed from a stored message in an admitted chat, re-emitted by the core as `im/reaction`. */
export interface ImReactionEvent {
  readonly action: 'added' | 'removed'
  /** Platform emoji identity (for example Feishu `THUMBSUP`, `SMILE`). */
  readonly emoji: string
  readonly chat: ImChat
  readonly user: UserRef
  readonly bot: Bot
  /** The stored message that received the reaction. */
  readonly message: ImMessage
  /** The session whose send/output produced that message, when known. */
  readonly session?: SessionId
  readonly time: number
  /** Platform event id when provided by the adapter. */
  readonly id?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An admitted inbound message; listeners call `next()` to pass it on and the default outcome ignores it.
     * @param event - the admitted message with its chat, source and renderer state.
     * @param next - the rest of the waterfall; call it to let the next listener decide the outcome.
     * @mode waterfall
     */
    'im/message'(event: ImMessageEvent, next: () => Promise<ImOutcome>): Promise<ImOutcome>
    /**
     * A message was stored: an admitted inbound message or an own outbound publication.
     * @param message - the stored record with its per-chat sequence number.
     * @mode emit
     */
    'im/stored'(message: ImMessage): void
    /**
     * One `ctx.im.send` publication is about to be dispatched (grants already checked): listeners may replace
     * `outgoing.content` or set `outgoing.drop`, then call `next()`. Not run for streams or for replayed operations.
     * @param outgoing - the mutable draft: chat, caller options, the caller's original content and the current content.
     * @param next - the rest of the waterfall.
     * @mode waterfall
     */
    'im/before-send'(outgoing: ImOutgoing, next: () => Promise<void>): Promise<void>
    /**
     * A button of a published message was clicked, with the chat, sender and producing session.
     * @param event - the click, its message and the raw platform interaction.
     * @mode emit
     */
    'im/button'(event: ImButtonEvent): void
    /**
     * A `<select>` of a published message was used, with the chat, sender, picked values and producing session.
     * @param event - the pick, its message and the raw platform interaction.
     * @mode emit
     */
    'im/select'(event: ImSelectEvent): void
    /**
     * A checkbox of a published message was toggled, with the chat, sender, new state and producing session.
     * @param event - the toggle, its message and the raw platform interaction.
     * @mode emit
     */
    'im/check'(event: ImCheckEvent): void
    /**
     * A reaction was added to or removed from a stored message in an admitted chat.
     * @param event - the reaction, its target message, actor, and producing session when known.
     * @mode emit
     */
    'im/reaction'(event: ImReactionEvent): void
    /**
     * A hosted session's turn activity changed; output renderers subscribe to redraw their message.
     * @param activity - the whole activity of the turn, with every segment so far.
     * @param change - which part changed: start, a segment delta, a tool update, or the end.
     * @mode emit
     */
    'im/activity'(activity: ImActivity, change: ImActivityChange): void
    /**
     * A hosted session record was created, including the new record a reset creates.
     * @param record - the created record with its session id and generation.
     * @mode emit
     */
    'im/session/created'(record: ImSessionRecord): void
    /**
     * A hosted session was reset: its generation advanced and a fresh session id was issued.
     * @param record - the record that was just replaced; the new record arrives through `im/session/created`.
     * @param reason - why the reset happened, as the caller reported it.
     * @mode emit
     */
    'im/session/reset'(record: ImSessionRecord, reason: string): void
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Config — the schemastery value lives in config.ts

/**
 * One ordered admission rule: the first rule matching a chat admits it, and a chat matched by no rule is neither
 * stored nor emitted. `writable` grants sessions the right to publish into the chat.
 */
export interface ImSourceConfig {
  /** Stable operator id (branded as {@link ImSourceId} on `ImChat.source`). */
  id: string
  /** Bot id `lark:cli_xxx` | `qq:102106848` | `*`. */
  bot: string
  /** Platform chat ids; absent or empty = any chat of the bot. */
  chats?: string[]
  /** Sender allowlist (platform user ids); absent or empty = any. */
  users?: string[]
  /** Sessions may publish into these chats. */
  writable: boolean
  /** `all` (default; history needs non-addressed messages) or only addressed messages. */
  store: 'all' | 'addressed'
}

/**
 * Deployment configuration of the IM host: the admission rules plus the limits the store, the send pipeline and the
 * `im_*` tools enforce. The schemastery value with the field defaults lives in `config.ts`.
 */
export interface ImConfig {
  /** Ordered admission rules; the first match admits. Chats matched by no source are neither stored nor emitted. */
  sources: ImSourceConfig[]
  /** Minimum age before settled records may expire, ms. */
  retentionMs: number
  /** Maximum retained message records per chat. */
  maxRecords: number
  /** Maximum UTF-8 bytes of one stored inbound record. */
  maxInputBytes: number
  /** Interval of the dispatch loop, delivery recovery and retention sweep, ms. */
  retryIntervalMs: number
  /** Deadline of one platform request this service makes (a message re-read, the text of a quoted reply), ms. */
  platformTimeoutMs: number
  /**
   * Delay in ms before logging a warning when the Loader composition has not settled and IM intake and delivery
   * recovery remain held (default 30 s).
   */
  compositionWarnMs: number
  /** Inbound media admission: whether admitted images and files are downloaded for the model, and their bounds. */
  media: {
    /** Download admitted images and files so the model can read them; `false` keeps only their labels. */
    download: boolean
    /** Maximum bytes of one downloaded resource (default 10 MiB). */
    maxBytes: number
    /** Maximum resources downloaded for one message (default 9). */
    maxItems: number
    /** Deadline of the address lookup of one inbound fetch, and then of the fetch with its body, ms (default 30 s). */
    timeoutMs: number
    /**
     * Sources a received message may make this host fetch. A message is written by a chat member, not by the session
     * that reads it, so the two sources that reach past the platform are off by default.
     */
    source: {
      /** Accept a `file:` source, which names a path of this host the chat member chose (default off). */
      file: boolean
      /** Accept an http(s) source whose host is, or resolves to, a loopback, private, link-local or multicast
       * address (default off). */
      internal: boolean
    }
  }
  /** Outbound publication limits. */
  send: {
    /** Maximum bytes inlined for a media file of another execution world (default 10 MiB). */
    maxMediaBytes: number
    /** Deadline of one publication operation in milliseconds (default 30 s). */
    operationTimeoutMs: number
  }
  /** `im_*` tools (registered when the `tools` service exists). */
  tools: {
    /** Register only the read tools, so the session never publishes or records a task status. */
    readOnly: boolean
    /** Maximum UTF-8 bytes of one tool result text (default 64 KiB). */
    maxReadBytes: number
    /** Maximum messages of one `im_history` page (default 50). */
    maxHistoryItems: number
    /** Maximum members one `im_members` call lists, across platform pages (default 200). */
    maxMembers: number
    /** Maximum platform roster pages one `im_members` call reads before stopping (default 10). */
    maxMemberPages: number
    /**
     * Session-relative directory `im_read_file` writes a downloaded file into (default
     * `.dsh/im`); the path a chat file is staged at stays inside the working directory so
     * the model's own file tools and its subagents can read it.
     */
    fileDir: string
  }
  /**
   * Default dispatcher: the innermost `im/message` listener. Absent, a message no listener handled is ignored;
   * present, every addressed message no listener handled reaches one shared hosted session (`im:dispatcher`).
   */
  defaultDispatch?: ImDispatcherConfig | undefined
}

/**
 * The default dispatcher of messages no other listener handled: one hosted session (key `im:dispatcher`, owner
 * `dispatcher`) that accumulates a binding per chat it hears and reads every message with a chat header.
 */
export interface ImDispatcherConfig {
  /** Agent preset of the dispatcher session. */
  agentPreset: string
  /** Explicit model-provider route. */
  provider: string
  /** Model id on the configured provider route. */
  model: string
  /** Absolute working directory of the dispatcher session. */
  cwd: string
  /** Output renderer id (default `none`: only the agent's own IM tools publish). */
  output: string
  /** How a dispatched message reaches the agent (default `steer`). */
  delivery: ImDeliveryMode
  /**
   * Global tools the dispatcher session keeps visible (the composition's `restrict`). The dispatcher answers chats
   * that share one history, so an operator can withdraw tools that must not act for every chat at once.
   */
  restrict?: {
    /** Global tool names that stay visible; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from visibility. */
    deny?: string[]
  } | undefined
  /** The prompt section rendered for the dispatcher session only. */
  prompt: {
    /** Unique section name in the system prompt (default `im:dispatcher`). */
    name: string
    /** Position among the sections (default 81, right after `tool:im`). */
    order: number
    /** Guidance text of the dispatcher session. */
    text: string
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions

/** What a hosted agent is made of; stored with the session record and used for create and resume. */
export interface ImComposition {
  agentPreset: string
  cwd: string
  provider: string
  model: string
  restrict?: ToolRestriction
}

/** What one hosted session may do in one chat: publish into it, and whether the chat is its default (home) chat. */
export interface ImBinding {
  chat: ImChatKey
  writable: boolean
  /** The chat output renderers and tools without an explicit chat use. */
  home?: boolean
  /** Confine the session to one thread of the chat. */
  thread?: string
}

/** What an owner asks for when it opens a hosted session; `ensure` creates it or refreshes the live record. */
export interface ImSessionSpec {
  /** Owner-defined stable key (`conversation:<chatKey>`, `task:<id>`, `oneshot:<msgKey>`); one live session per key. */
  key: string
  /** Plugin name, for diagnostics and guards. */
  owner: string
  composition: ImComposition
  bindings: ImBinding[]
  /** Output renderer id; default `none`. */
  output?: string
  /** Parent session (tasks and child sessions); grants inheritance and root lookup. */
  parent?: SessionId
  /** Dispose the agent after its first idle (one-shot). */
  ephemeral?: boolean
  /** Owner data (task id, conversation metadata, etc.). */
  meta?: Record<string, unknown>
}

/** A stored session: its spec plus the session id and generation that a reset advances to dispose and replace the agent. */
export interface ImSessionRecord extends ImSessionSpec {
  /** `im-${sha256(key + '#' + generation)[0..32]}`. */
  sessionId: SessionId
  generation: number
  createdAt: number
  lastActiveAt: number
}

/** How a delivery reaches the session's agent: wake or join the running turn, queue a turn, or add context without waking. */
export type ImDeliveryMode = 'steer' | 'followup' | 'inject'

/**
 * One durable delivery intent into a hosted session: recorded before the agent is touched, deduped by `id` in the
 * session's inbox, and re-run after a restart until it is admitted.
 */
export interface ImDelivery {
  /** Idempotency key (message key, or owner-minted). */
  id: string
  mode: ImDeliveryMode
  /** Messages are formatted by `ctx.im.format` (style `xml`) at admission time. */
  content: UserMessage['content'] | readonly ImMessage[]
  /** Output reply target and thread for this turn (renderers quote it). */
  trigger?: ImMessage
  /** Download media of the delivered messages (subject to config). */
  media?: boolean
  /** Envelope text placed before formatted messages (`ImFormatOptions.header`); ignored for preformatted content. */
  header?: string
}

/** Narrows `sessions.list()`: by owner, by bound chat, or by parent session; every absent field matches anything. */
export interface ImSessionFilter {
  owner?: string
  chat?: ImChatKey
  parent?: SessionId
}

/**
 * Idempotency and generation guard for {@link ImSessions.reset}.
 */
export interface ImResetOptions {
  /**
   * Caller-supplied idempotency key (for example, a command message key). Within `retentionMs`, repeating `reset` for
   * the same `(key, operationId)` returns the originally replaced `SessionId` without advancing a newer generation.
   */
  operationId?: string
  /**
   * Generation the caller observed and intends to replace. When `key` has already advanced past `expectedGeneration`,
   * `reset` leaves the newer generation untouched instead of resetting subsequent work.
   */
  expectedGeneration?: number
}

/**
 * Hosted sessions (`ctx.im.sessions`): records keyed by an owner-defined key, their live agents, bindings, durable
 * deliveries and the reset/stop lifecycle. Plugins own their keys and interpret the records they created.
 */
export interface ImSessions {
  /** Create-or-get by key (updates composition/bindings/output/meta of the live record). */
  ensure(spec: ImSessionSpec): Promise<ImSessionRecord>
  get(keyOrId: string | SessionId): ImSessionRecord | undefined
  list(filter?: ImSessionFilter): ImSessionRecord[]
  /** Sessions whose bindings include the chat (commands plugin, /stop). */
  forChat(chat: ImChatKey): ImSessionRecord[]
  /**
   * Durable: recorded first, admitted into the agent inbox (dedupe by id), retried on restart. Throws
   * `ImError('unavailable')` if a concurrent `reset()` discards the pending intent before admission completes so
   * callers can re-deliver into the replacement generation.
   */
  deliver(target: SessionId | string, delivery: ImDelivery): Promise<void>
  /**
   * Session id of any generation of `key` (including generations retired by reset) that already admitted
   * `deliveryId`, or `undefined` when none did. Dedupe window equals `config.retentionMs`, after which `recover()`
   * prunes admitted delivery intents.
   */
  deliveredTo(key: string, deliveryId: string): SessionId | undefined
  /**
   * Cancel + dispose the live agent and bump generation so the next `ensure()` creates a fresh session. Returns the
   * replaced `SessionId`, or `undefined` when `key` is not hosted (or already advanced past `expectedGeneration`).
   */
  reset(key: string, reason: string, options?: ImResetOptions): Promise<SessionId | undefined>
  bind(target: SessionId | string, bindings: ImBinding[]): Promise<void>
  /**
   * Live agent (created/resumed with the stored composition). Serializes on the session's stable `key` behind any
   * in-flight `reset()` / `admit()`, then re-resolves: rejects with `ImError('unavailable')` if `target` is a
   * `SessionId` retired by `reset()` (re-resolve by `key` or `forChat()` — retrying the retired id keeps failing)
   * or if the current generation has an uncommitted reset receipt (retryable with the same `target` after recovery
   * when `target` is the stable `key`; a `SessionId` is retired by that advance, so re-resolve by `key` /
   * `forChat()`); opens the new generation when called by stable `key`; rejects with `ImError('access')` if
   * `target` is unhosted.
   */
  agent(target: SessionId | string): Promise<Agent>
  /** Session for a calling agent (tools): walks the parent chain to the nearest hosted record. */
  of(sessionId: SessionId): ImSessionRecord | undefined
  /** `agent.cancel({ kind: 'user' })` if running; false when nothing was running. */
  stop(target: SessionId | string): Promise<boolean>
  /** The message whose delivery started the session's current turn (renderers and task placements read it). */
  trigger(sessionId: SessionId): ImMessage | undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Outbound publication, history, formatting

/** Options of one publication (`ctx.im.send` / `ctx.im.stream`): reply target, thread, attribution and receipt key. */
export interface ImSendOptions extends SendOptions {
  /** Durable receipt key (tools pass sha256(sessionId, toolCallId)); absent = fire-and-forget. */
  operationId?: string
  /**
   * Message the publication answers: must name a message stored in `im_messages` for the target chat (keys from
   * another bot, another chat, or unstored/expired keys are rejected with `ImError('access')`). Rendered as the
   * content's `<quote>` envelope, and its stored `referrer` becomes the target's for passive replies and thread placement.
   */
  quote?: ImMessageKey
  /**
   * Thread placement: a `string` targets that explicit thread id; `true` answers inside `quote`'s thread. When both
   * `thread` and `quote` are omitted for a `session`, defaults to the thread of the message `ImSessions.trigger(session)`
   * answered last in memory (falling back to the chat's main timeline when none exists or after a restart).
   */
  thread?: string | true
  /**
   * Adapter-opaque reply context of the interaction this publication answers (`Target.referrer`), e.g. the referrer of
   * a QQ button click so the answer is a passive reply to that click. Replaces the referrer `quote` or `thread` would
   * supply; grants no access of its own.
   */
  referrer?: unknown
  /** For grants check + attribution. */
  session?: SessionId
}

/** Outcome of one publication: the durable receipt status, the platform handle and the render report of every part. */
export interface ImSendResult {
  status: 'confirmed' | 'failed' | 'uncertain' | 'partial'
  handle?: MessageHandle
  report?: RenderReport
  error?: string
  /** Stored own message (when confirmed/partial). */
  message?: ImMessage
  /** An `im/before-send` listener dropped the publication (`status` is `failed`, `error` carries its reason). */
  dropped?: true
}

/** The mutable draft of one publication the `im/before-send` waterfall passes along. */
export interface ImOutgoing {
  /** Target chat. */
  readonly chat: ImChatKey
  /** The caller's options: session, quote, thread, operation id. */
  readonly options: Readonly<ImSendOptions>
  /** The caller's content, untouched by earlier listeners. */
  readonly original: Fragment
  /** What will be published; a listener replaces it to rewrite the message. */
  content: Fragment
  /** Set to a reason to publish nothing. */
  drop?: string
}

/** Read side of the message store, addressed by the per-chat sequence number (`ctx.im.history`). */
export interface ImHistory {
  /**
   * Up to `limit` messages with seq > `seq`, oldest first, keeping only the messages `keep` accepts. A reader of one
   * conversation passes the test that names it (that thread, or the main timeline), so the limit counts messages of
   * that conversation instead of whatever the chat happened to put in between.
   */
  after(chat: ImChatKey, seq: number, limit: number, keep?: (message: ImMessage) => boolean): ImMessage[]
  /** The same walk backwards: up to `limit` messages with seq < `seq`, oldest first. */
  before(chat: ImChatKey, seq: number, limit: number, keep?: (message: ImMessage) => boolean): ImMessage[]
  /**
   * Look up a stored message by canonical `key` or by any recorded platform `aliases` key (`bot|alias`).
   * Callers scoping lookups to one chat must verify `message.chat.key`.
   */
  get(key: ImMessageKey): ImMessage | undefined
  latest(chat: ImChatKey): ImMessage | undefined
}

/** How `ctx.im.format` renders stored messages for a model: one transcript style, plus media and header options. */
export interface ImFormatOptions {
  /** `xml` (default): `<im-message seq from time quote>text [图片 #k]</im-message>`; `line`: compact one-liners. */
  style?: 'xml' | 'line'
  /** Attach images as image blocks (bounded by `config.media`). */
  media?: boolean
  /** Optional envelope text placed before the messages. */
  header?: string
  signal?: AbortSignal
}

/** Registry of the output renderers a session may name in `spec.output` (`ctx.im.outputs`). */
export interface ImOutputs {
  /** Register a renderer; ids are unique (`none` is reserved). */
  register(renderer: ImOutputRenderer): () => void
  get(id: string): ImOutputRenderer | undefined
}

/**
 * The IM facade the `im` service implements: sessions, history and outputs of the host, plus publication, formatting,
 * and status calls. Plugins and tools consume this interface rather than the concrete service.
 */
export interface ImApi {
  readonly sessions: ImSessions
  readonly history: ImHistory
  readonly outputs: ImOutputs
  send(chat: ImChatKey, content: Fragment, options?: ImSendOptions): Promise<ImSendResult>
  stream(chat: ImChatKey, options?: ImSendOptions & StreamOptions): Promise<MessageStream>
  format(messages: readonly ImMessage[], options?: ImFormatOptions): Promise<UserMessage['content']>
  /** Bot owning the chat; throws `ImError('unavailable')` when the bot is not mounted. */
  bot(chat: ImChatKey): Bot
  chat(key: ImChatKey): ImChat | undefined
  /**
   * One message of one chat: the stored message when this deployment received it, and a platform read otherwise, so a
   * reference to a message that never reached this deployment still resolves. A platform read is stored like any
   * other message, which gives it a sequence number and keeps a later read of it local.
   */
  readMessage(chat: ImChatKey, id: string, signal?: AbortSignal): Promise<ImMessage>
  /**
   * One page of the people a chat lists as its members: the id a mention addresses and the name to show. The platform
   * decides the page size; `cursor` is the previous page's `next`.
   */
  members(chat: ImChatKey, cursor?: string, limit?: number, signal?: AbortSignal): Promise<MembersPage>
  /** Read-only diagnostics. */
  status(): ImStatus
}

/** Read-only snapshot of the deployment: mounted bots, configured sources, sessions and the work still pending. */
export interface ImStatus {
  bots: { id: string; platform: string; sid: string; status: number }[]
  sources: ImSourceConfig[]
  sessions: ImSessionRecord[]
  pendingDeliveries: number
  pendingMessages: number
  recent: { key: ImMessageKey; outcome: ImOutcome; at: number }[]
}

// ---------------------------------------------------------------------------------------------------------------
// Activity model and output renderers

/**
 * One segment of a turn's activity: accumulated assistant text or reasoning, or one tool call with its bounded
 * argument/result previews and its state.
 */
export type ImSegment =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; callId: string; name: string; args: string; status: 'running' | 'done' | 'error'; result?: string }

/**
 * The whole activity of one turn of a hosted session, published as an `im/activity` snapshot: the trigger, every
 * segment so far, and how the turn settled.
 */
export interface ImActivity {
  session: ImSessionRecord
  turn: number
  status: 'running' | 'done' | 'cancelled' | 'error'
  segments: readonly ImSegment[]
  trigger?: ImMessage
  /** Error message when `status === 'error'`. */
  error?: string
  startedAt: number
  updatedAt: number
}

/** Which part of a turn's activity changed: the turn started, a text/reasoning delta, a tool update, or the end. */
export type ImActivityChange = 'start' | 'delta' | 'tool' | 'end'

/** A plugin that publishes a session's turns itself (e.g. `summary`, `trace`) instead of leaving `output: 'none'`. */
export interface ImOutputRenderer {
  /** `summary` | `trace` | custom. */
  readonly id: string
  /**
   * Called once per turn for sessions whose `spec.output === id` and that may publish into the turn's target chat:
   * the trigger's chat when a writable binding covers it, else the writable home binding.
   */
  begin(activity: ImActivity, io: ImOutputIO): ImTurnOutput
}

/** What one rendered turn publishes through: the bound chat and sends quoting the turn's trigger. */
export interface ImOutputIO {
  /** Target chat of the turn (the trigger's chat when writable for the session, else the home chat). */
  chat: ImChatKey
  /** Quote/thread from `activity.trigger` when it belongs to {@link chat}; attributed to the session. */
  stream(options?: StreamOptions): Promise<MessageStream>
  send(content: Fragment): Promise<ImSendResult>
}

/** Per-turn output of a renderer: updates while the turn runs, one `end` when it settles. */
export interface ImTurnOutput {
  update(activity: ImActivity, change: ImActivityChange): void
  end(activity: ImActivity): Promise<void>
}
