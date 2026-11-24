/**
 * Wire-level and addressing types of the IM core: Login, User, Status, Meta, ChatRef, Target, InboundMessage,
 * ButtonEvent, and WebSocket.
 */

import type { Element } from '@deepseek-ai/satori-element'
import type { Bot } from './bot.ts'

// ---------------------------------------------------------------------------------------------------------------
// Login / status

/** Connection status of a bot (numeric values kept from the Satori protocol). */
export const Status = {
  OFFLINE: 0,
  ONLINE: 1,
  CONNECT: 2,
  DISCONNECT: 3,
  RECONNECT: 4,
} as const
export type Status = typeof Status[keyof typeof Status]

/** The bot's own platform identity. */
export interface User {
  id: string
  name?: string
  avatar?: string
  isBot?: boolean
}

/** Serializable bot description (`bot.toJSON()`, `login-*` events, `satori.toJSON()`). */
export interface Login {
  /** Process-local login sequence number. */
  sn: number
  /** Stable configured bot id (`lark:<appId>`, `qq:<appId>`). */
  id: string
  /** Platform name reported to users (`feishu` | `lark` | `qq` …). */
  platform: string
  /** Adapter name (`lark`, `qq`, `fake` …). */
  adapter: string
  /** Platform user id of the bot itself; empty until known. */
  selfId: string
  user?: User
  status: Status
  hidden?: boolean
}

export interface Meta {
  logins: Login[]
  proxyUrls: string[]
}

// ---------------------------------------------------------------------------------------------------------------
// Addressing

export type ChatType = 'direct' | 'group' | 'topic'

export interface ChatRef {
  id: string
  type: ChatType
  name?: string
}

export interface Target {
  chat: ChatRef
  /** Thread id, or `true` = "follow the referrer's thread". */
  thread?: string | true
  /** Inbound context enabling passive replies / thread inference (adapter-defined). */
  referrer?: unknown
}

// ---------------------------------------------------------------------------------------------------------------
// Inbound

export interface UserRef {
  id: string
  name?: string
  isBot?: boolean
  role?: 'owner' | 'admin' | 'member'
}

/** One page of a chat's member list; `next` is the cursor of the page after it. */
export interface MembersPage {
  data: UserRef[]
  next?: string
}

export interface MessageRef {
  id: string
  chat: ChatRef
}

export interface InboundMessage {
  /** Platform message id. */
  id: string
  /** Platform-local alternative ids for the same message (e.g. QQ `msg_idx` alongside `msg_id`). */
  aliases?: string[]
  chat: ChatRef
  thread?: { id: string; root?: string }
  sender: UserRef
  /** Element vocabulary (+ inbound-only `forward` / `raw`), never flattened, never empty. */
  content: Element<'message'>
  quote?: { id: string; sender?: UserRef; content?: Element<'message'> }
  mentions: { self: boolean; all: boolean; users: UserRef[] }
  time: number
  /** Passed back as `Target.referrer` for passive replies / thread inference. */
  referrer: unknown
  raw?: unknown
}

declare module '@deepseek-ai/satori-element' {
  /** Platform context of a `button[type=action]` interaction; augments the vocabulary's forward declaration. */
  interface ButtonEvent {
    bot: Bot
    user: UserRef
    chat: ChatRef
    /** The platform message that carried the button. */
    message?: MessageRef
  }

  /** Platform context of a `<select>` interaction; augments the vocabulary's forward declaration. */
  interface SelectEvent {
    bot: Bot
    user: UserRef
    chat: ChatRef
    /** The platform message that carried the control. */
    message?: MessageRef
  }

  /** Platform context of a checkbox toggle; augments the vocabulary's forward declaration. */
  interface CheckEvent {
    bot: Bot
    user: UserRef
    chat: ChatRef
    /** The platform message that carried the checkbox. */
    message?: MessageRef
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Platform-neutral WebSocket (kept from satori-protocol; used by ws.ts)

export namespace WebSocket {
  export type BinaryType = 'blob' | 'arraybuffer'
  export type Data = string | Blob | ArrayBuffer
  export type SendData = string | Blob | ArrayBufferLike | ArrayBufferView

  /** The connection is not yet open. */
  export const CONNECTING = 0
  /** The connection is open and ready to communicate. */
  export const OPEN = 1
  /** The connection is in the process of closing. */
  export const CLOSING = 2
  /** The connection is closed. */
  export const CLOSED = 3

  export type ReadyState =
    | typeof CONNECTING
    | typeof OPEN
    | typeof CLOSING
    | typeof CLOSED

  export interface EventMap {
    open: Event
    error: ErrorEvent
    message: MessageEvent
    close: CloseEvent
  }

  export interface EventListener {
    (event: Event): void
  }

  export interface Event {
    type: string
    target: WebSocket
  }

  export interface CloseEvent extends Event {
    code: number
    reason: string
  }

  export interface MessageEvent extends Event {
    data: Data
  }

  export interface ErrorEvent extends Event {
    message?: string
  }
}

export interface WebSocket {
  readonly url: string
  readonly protocol?: string
  readonly readyState?: number
  binaryType: WebSocket.BinaryType
  close(code?: number, reason?: string): void
  send(data: WebSocket.SendData): void
  dispatchEvent?(event: any): boolean
  addEventListener<K extends keyof WebSocket.EventMap>(type: K, listener: (event: WebSocket.EventMap[K]) => void): void
  removeEventListener<K extends keyof WebSocket.EventMap>(type: K, listener: (event: WebSocket.EventMap[K]) => void): void
}
