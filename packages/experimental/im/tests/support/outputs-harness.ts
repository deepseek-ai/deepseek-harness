/**
 * Output-registry harness: {@link ImOutputRegistry} over a recording fake sender and a fake `ImApi` slice, so
 * `im/activity` and `interaction/button` can be driven without a platform adapter, a session host or durable receipts.
 */
import { Context } from '@deepseek-ai/cordis'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import type {
  Bot, ChatRef, Fragment, MessageStream, Session, SessionEvent, StreamOptions,
} from '@deepseek-ai/cordis-plugin-im-core'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  ImChatKey, ImMessageKey, ImSourceId,
  type ImActivity, type ImButtonEvent, type ImChat, type ImCheckEvent, type ImMessage, type ImReactionEvent,
  type ImSelectEvent, type ImSendOptions,
  type ImSendResult, type ImSessionRecord, type ImSourceConfig,
} from '../../src/api.ts'
import { ImOutputRegistry, type ImOutputDeps } from '../../src/outputs.ts'
import type { ImMessageDraft } from '../../src/store.ts'

/** The bot id every fake chat and click belongs to. */
export const BOT = { id: 'fake:bot', selfId: 'bot-user' } as Bot

/** One `io.send` call. */
export interface Send {
  chat: ImChatKey
  content: Fragment
  options: ImSendOptions | undefined
}

/** One `io.stream` call. */
export interface Stream {
  chat: ImChatKey
  options: (ImSendOptions & StreamOptions) | undefined
}

/** Recording stand-in for the send funnel. */
export class FakeSender {
  readonly sends: Send[] = []
  readonly streams: Stream[] = []
  /** Session attributed to a stored own message. */
  readonly owners = new Map<ImMessageKey, SessionId>()

  sessionOf(key: ImMessageKey): SessionId | undefined {
    return this.owners.get(key)
  }

  async send(chat: ImChatKey, content: Fragment, options?: ImSendOptions): Promise<ImSendResult> {
    this.sends.push({ chat, content, options })
    return { status: 'confirmed' }
  }

  async stream(chat: ImChatKey, options?: ImSendOptions & StreamOptions): Promise<MessageStream> {
    this.streams.push({ chat, options })
    return {} as MessageStream
  }
}

/** A chat identity of the fake bot. */
export function chatOf(id = 'chat', type: ChatRef['type'] = 'group'): ImChat {
  return { key: ImChatKey(BOT.id, id), bot: BOT.id, ref: { id, type }, source: ImSourceId('team') }
}

/** A hosted session record with one writable home binding. */
export function record(patch: Partial<ImSessionRecord> = {}): ImSessionRecord {
  const chat = chatOf()
  return {
    key: `conv:${chat.key}`,
    owner: 'conversation',
    composition: { agentPreset: 'im', cwd: '/tmp', provider: 'mock', model: 'mock' },
    bindings: [{ chat: chat.key, writable: true, home: true }],
    sessionId: 'im-session' as SessionId,
    generation: 0,
    createdAt: 1,
    lastActiveAt: 2,
    ...patch,
  }
}

/** One activity snapshot of a turn. */
export function activity(session: ImSessionRecord, patch: Partial<ImActivity> = {}): ImActivity {
  return { session, turn: 1, status: 'running', segments: [], startedAt: 10, updatedAt: 10, ...patch }
}

/** A stored inbound message the activity can trigger on. */
export function inbound(thread?: string): ImMessage {
  const chat = chatOf()
  return {
    key: ImMessageKey(BOT.id, 'm1'),
    seq: 1,
    chat,
    ...thread === undefined ? {} : { thread: { id: thread } },
    sender: { id: 'user-1', self: false },
    content: h('message', h.text('hello')),
    text: 'hello',
    mentions: { self: false, all: false, users: [] },
    addressed: true,
    time: 1000,
    via: 'platform',
  }
}

/** The draft of {@link inbound} (a message as the store receives it), carrying an adapter referrer. */
export function inboundDraft(referrer: unknown): ImMessageDraft {
  const message = inbound()
  return {
    key: message.key,
    chat: message.chat,
    sender: message.sender,
    content: message.content,
    text: message.text,
    mentions: message.mentions,
    addressed: message.addressed,
    time: message.time,
    via: message.via,
    referrer,
  }
}

/** One `interaction/button` session of the fake bot. */
export function click(
  id: string,
  patch: { message?: string; data?: string; chat?: string; values?: Record<string, unknown> } = {},
): Session {
  const chat = chatOf(patch.chat).ref
  const button = {
    bot: BOT,
    id,
    referrer: {},
    time: 1000,
    user: { id: 'user-1' },
    chat,
    ...patch.message === undefined ? {} : { message: { id: patch.message, chat } },
    ...patch.data === undefined ? {} : { data: patch.data },
    ...patch.values === undefined ? {} : { values: patch.values },
  }
  return { button, bot: BOT, timestamp: 1000 } as Session
}

/** A click session that carries no button at all (a redelivered envelope). */
export function noClick(): Session {
  return { bot: BOT, timestamp: 1000 } as Session
}

/** One `interaction/select` session of the fake bot. */
export function pick(
  id: string,
  values: string[],
  patch: { message?: string; data?: string; chat?: string } = {},
): Session {
  const chat = chatOf(patch.chat).ref
  const select = {
    bot: BOT,
    id,
    values,
    referrer: {},
    time: 1000,
    user: { id: 'user-1' },
    chat,
    ...patch.message === undefined ? {} : { message: { id: patch.message, chat } },
    ...patch.data === undefined ? {} : { data: patch.data },
  }
  return { select, bot: BOT, timestamp: 1000 } as Session
}

/** One `interaction/check` session of the fake bot. */
export function toggle(
  id: string,
  checked: boolean,
  patch: { message?: string; data?: string; chat?: string } = {},
): Session {
  const chat = chatOf(patch.chat).ref
  const check = {
    bot: BOT,
    id,
    checked,
    referrer: {},
    time: 1000,
    user: { id: 'user-1' },
    chat,
    ...patch.message === undefined ? {} : { message: { id: patch.message, chat } },
    ...patch.data === undefined ? {} : { data: patch.data },
  }
  return { check, bot: BOT, timestamp: 1000 } as Session
}

/** One `reaction-added` / `reaction-removed` session of the fake bot. */
export function react(
  messageId: string,
  emoji: string,
  patch: { user?: { id: string; name?: string; isBot?: boolean }; chat?: string; id?: string; time?: number } = {},
): Session {
  const timestamp = patch.time ?? 1000
  const message = patch.chat === undefined
    ? { id: messageId }
    : { id: messageId, chat: chatOf(patch.chat).ref }
  const user = patch.user ?? { id: 'user-1' }
  const event: SessionEvent = {
    type: 'reaction-added',
    timestamp,
    ...patch.id === undefined ? {} : { id: patch.id },
    reaction: { message, emoji, user },
  }
  return { bot: BOT, timestamp, event, reaction: event.reaction } as Session
}

/** One reaction session with an arbitrary (possibly incomplete) payload, for malformed platform events. */
export function rawReaction(reaction: SessionEvent['reaction'], id?: string): Session {
  const event: SessionEvent = {
    type: 'reaction-added',
    timestamp: 1000,
    ...id === undefined ? {} : { id },
    ...reaction === undefined ? {} : { reaction },
  }
  return { bot: BOT, timestamp: 1000, event, reaction: event.reaction } as Session
}

/** Everything one registry test needs. */
export class OutputsHarness {
  readonly ctx = new Context()
  readonly registry: ImOutputRegistry
  readonly sender = new FakeSender()
  /** Every `im/button` emission. */
  readonly buttons: ImButtonEvent[] = []
  /** Every `im/select` emission. */
  readonly selects: ImSelectEvent[] = []
  /** Every `im/check` emission. */
  readonly checks: ImCheckEvent[] = []
  /** Every `im/reaction` emission. */
  readonly reactions: ImReactionEvent[] = []
  /** Chats `chat()` knows. */
  readonly chats = new Map<ImChatKey, ImChat>()
  /** Stored messages by key (`history.get`). */
  readonly messages = new Map<ImMessageKey, ImMessage>()
  /** Hosted sessions by key and by id (`sessions.get`). */
  readonly hosted = new Map<string, ImSessionRecord>()
  /** Configured admission rules by id (`source`); a click must pass the rule's `users`. */
  readonly sources = new Map<string, ImSourceConfig>()

  constructor() {
    this.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all' })
    const im = {
      chat: (key: ImChatKey): ImChat | undefined => this.chats.get(key),
      source: (id: string): ImSourceConfig | undefined => this.sources.get(id),
      history: { get: (key: ImMessageKey) => this.messages.get(key) },
    } satisfies ImOutputDeps['im']
    this.registry = new ImOutputRegistry(this.ctx, { im, sender: this.sender })
    this.ctx.on('im/button', (event) => { this.buttons.push(event) })
    this.ctx.on('im/select', (event) => { this.selects.push(event) })
    this.ctx.on('im/check', (event) => { this.checks.push(event) })
    this.ctx.on('im/reaction', (event) => { this.reactions.push(event) })
    this.registry.start()
  }

  /** Host one record (by key and by session id) and admit its home chat. */
  host(patch: Partial<ImSessionRecord> = {}): ImSessionRecord {
    const hosted = record(patch)
    this.hosted.set(hosted.key, hosted)
    this.hosted.set(hosted.sessionId, hosted)
    for (const binding of hosted.bindings) this.chats.set(binding.chat, chatOf(binding.chat.slice(BOT.id.length + 1)))
    return hosted
  }

  async close(): Promise<void> {
    await this.registry.dispose()
    await this.ctx.fiber.dispose()
  }
}

/** Let every queued begin/update/end step of the registry run. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}
