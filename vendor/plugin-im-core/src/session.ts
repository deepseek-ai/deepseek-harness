/**
 * Event wrapper: `session.message` (`InboundMessage`), `session.button` (`ButtonEvent`), plus the per-bot `onClick`
 * callback registry used by `interaction/button` routing.
 */

import type { ButtonCallback, ButtonEvent } from '@deepseek-ai/satori-element'
import type { Context } from '@deepseek-ai/cordis'
import { defineProperty, Time } from '@deepseek-ai/cosmokit'
import type { Bot } from './bot.ts'
import type { InboundMessage, Login, MessageRef, UserRef } from './protocol.ts'

export interface SessionEvent {
  /** Event name: `message`, `message-deleted`, `interaction/button`, `reaction-added`, `login-added`, `internal` … */
  type: string
  /** Platform event id (intake dedupe key). */
  id?: string
  timestamp: number
  /** `message` */
  message?: InboundMessage
  /** `interaction/button` */
  button?: ButtonEvent
  /** `message-deleted` */
  deleted?: MessageRef & { operator?: UserRef }
  /** `reaction-added` / `reaction-removed` */
  reaction?: { message: MessageRef; emoji: string; user?: UserRef }
  /** `login-*` */
  login?: Login
  /** Passive-reply context (also on `message.referrer` / `button.referrer`). */
  referrer?: unknown
  /** `type === 'internal'`: re-emitted by `bot.dispatch` as `ctx.emit(internal.type, internal.data, bot)`. */
  internal?: { type: string; data: unknown }
  /** Raw platform payload (byte-identical redelivery checks, debugging). */
  raw?: unknown
}

export class Session {
  public readonly sn: number
  public declare readonly bot: Bot
  /** The bot's context (`bot.ctx`): the scope the event was received in. */
  public declare readonly ctx: Context
  /** The root context. */
  public declare readonly app: Context
  public event: SessionEvent

  constructor(bot: Bot, event: Partial<SessionEvent> = {}) {
    this.event = { type: '', timestamp: Date.now(), ...event }
    this.sn = ++bot.ctx.satori._sessionSeq
    // Deliberately NOT `[Service.tracker]`: cordis' tracer wraps tracked objects for event listeners
    // (`ctx.reflect.bind` traces every argument), so `session.bot` inside a listener would be a proxy of the bot and
    // every `session.bot === bot` identity check would fail. The envelope is a plain value object; `ctx`/`app` are
    // defined here so callers still reach the context.
    defineProperty(this, 'bot', bot)
    defineProperty(this, 'ctx', bot.ctx)
    defineProperty(this, 'app', bot.ctx.root)
  }

  get type() {
    return this.event.type
  }

  set type(value: string) {
    this.event.type = value
  }

  get timestamp() {
    return this.event.timestamp
  }

  get message() {
    return this.event.message
  }

  get button() {
    return this.event.button
  }

  get referrer() {
    return this.event.referrer ?? this.event.message?.referrer ?? this.event.button?.referrer
  }

  /**
   * JSON view for logs, `internal/session` observers and the `/satori/v1/events`-style transports: the event envelope
   * plus this session's sequence number and the bot's current {@link Login}. `message.content` is already a plain
   * element tree, so the result serializes without conversion.
   */
  toJSON(): SessionEvent & { sn: number; login: Login } {
    return {
      ...this.event,
      sn: this.sn,
      login: this.bot.toJSON(),
    }
  }
}

export interface CallbackRegistryOptions {
  /** Default TTL of a registered callback, default 24 h. */
  ttlMs?: number
  /** Clock used for expiry checks; default `Date.now` (tests inject a fake one). */
  now?: () => number
}

/** In-memory `onClick` registry keyed by button id, with TTL. */
export class CallbackRegistry {
  private readonly entries = new Map<string, { callback: ButtonCallback; until: number }>()

  constructor(readonly options: CallbackRegistryOptions = {}) {}

  private get now() {
    return this.options.now?.() ?? Date.now()
  }

  private get ttlMs() {
    return this.options.ttlMs ?? Time.day
  }

  /** Register (or replace) a callback; returns its disposer. */
  register(id: string, callback: ButtonCallback, ttlMs?: number): () => void {
    const entry = { callback, until: this.now + (ttlMs ?? this.ttlMs) }
    this.entries.set(id, entry)
    return () => {
      if (this.entries.get(id) === entry) this.entries.delete(id)
    }
  }

  get(id: string): ButtonCallback | undefined {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.until <= this.now) {
      this.entries.delete(id)
      return
    }
    return entry.callback
  }

  /** Invoke the callback of `event.id` if registered and unexpired; resolves whether one ran. */
  async dispatch(event: ButtonEvent): Promise<boolean> {
    const callback = this.get(event.id)
    if (!callback) return false
    await callback(event)
    return true
  }

  clear(): void {
    this.entries.clear()
  }
}
