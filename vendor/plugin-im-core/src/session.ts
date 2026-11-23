/**
 * Event wrapper: `session.message` (`InboundMessage`), `session.button` (`ButtonEvent`), `session.select`
 * (`SelectEvent`), `session.check` (`CheckEvent`), plus the per-bot interaction callback registry used by
 * `interaction/button`, `interaction/select` and `interaction/check` routing.
 */

import type {
  ButtonCallback, ButtonEvent, CheckCallback, CheckEvent, SelectCallback, SelectEvent,
} from '@deepseek-ai/satori-element'
import { Context } from '@deepseek-ai/cordis'
import { defineProperty, Time } from '@deepseek-ai/cosmokit'
import type { Bot } from './bot.ts'
import type { ChatRef, InboundMessage, Login, MessageRef, UserRef } from './protocol.ts'

export interface SessionEvent {
  /** Event name: `message`, `interaction/button`, `interaction/select`, `interaction/check`, `reaction-added`, … */
  type: string
  /** Platform event id (intake dedupe key). */
  id?: string
  timestamp: number
  /** `message` */
  message?: InboundMessage
  /** `interaction/button` */
  button?: ButtonEvent
  /** `interaction/select` */
  select?: SelectEvent
  /** `interaction/check` */
  check?: CheckEvent
  /** `message-deleted` */
  deleted?: MessageRef & { operator?: UserRef }
  /** `reaction-added` / `reaction-removed`; `chat` is omitted on platforms whose event only names `message.id`. */
  reaction?: { message: { id: string; chat?: ChatRef }; emoji: string; user?: UserRef }
  /** `login-*` */
  login?: Login
  /** Passive-reply context (also on `message.referrer` / `button.referrer` / `select.referrer` / `check.referrer`). */
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
    defineProperty(this, 'app', bot.ctx[Context.root])
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

  get select() {
    return this.event.select
  }

  get check() {
    return this.event.check
  }

  get reaction() {
    return this.event.reaction
  }

  get referrer() {
    return this.event.referrer ?? this.event.message?.referrer ?? this.event.button?.referrer
      ?? this.event.select?.referrer ?? this.event.check?.referrer
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

/** What one registry entry holds, with its expiry. */
interface Entry<C> { callback: C; until: number }

/** In-memory interaction registry keyed by control id, with TTL. Buttons, selects and checkboxes are separate. */
export class CallbackRegistry {
  private readonly buttons = new Map<string, Entry<ButtonCallback>>()
  private readonly selects = new Map<string, Entry<SelectCallback>>()
  private readonly checks = new Map<string, Entry<CheckCallback>>()

  constructor(readonly options: CallbackRegistryOptions = {}) {}

  private get now() {
    return this.options.now?.() ?? Date.now()
  }

  private get ttlMs() {
    return this.options.ttlMs ?? Time.day
  }

  private put<C>(map: Map<string, Entry<C>>, id: string, callback: C, ttlMs?: number): () => void {
    const entry = { callback, until: this.now + (ttlMs ?? this.ttlMs) }
    map.set(id, entry)
    return () => {
      if (map.get(id) === entry) map.delete(id)
    }
  }

  /** The live callback of `id`; an expired entry is dropped on the way. */
  private live<C>(map: Map<string, Entry<C>>, id: string): C | undefined {
    const entry = map.get(id)
    if (!entry) return
    if (entry.until <= this.now) {
      map.delete(id)
      return
    }
    return entry.callback
  }

  /** Register (or replace) a button callback; returns its disposer. */
  registerButton(id: string, callback: ButtonCallback, ttlMs?: number): () => void {
    return this.put(this.buttons, id, callback, ttlMs)
  }

  /** Register (or replace) a select callback; returns its disposer. */
  registerSelect(id: string, callback: SelectCallback, ttlMs?: number): () => void {
    return this.put(this.selects, id, callback, ttlMs)
  }

  /** Register (or replace) a checkbox callback; returns its disposer. */
  registerCheck(id: string, callback: CheckCallback, ttlMs?: number): () => void {
    return this.put(this.checks, id, callback, ttlMs)
  }

  getButton(id: string): ButtonCallback | undefined {
    return this.live(this.buttons, id)
  }

  getSelect(id: string): SelectCallback | undefined {
    return this.live(this.selects, id)
  }

  getCheck(id: string): CheckCallback | undefined {
    return this.live(this.checks, id)
  }

  /** Invoke the button callback of `event.id` if registered and unexpired; resolves whether one ran. */
  async dispatchButton(event: ButtonEvent): Promise<boolean> {
    const callback = this.getButton(event.id)
    if (!callback) return false
    await callback(event)
    return true
  }

  /** Invoke the select callback of `event.id` if registered and unexpired; resolves whether one ran. */
  async dispatchSelect(event: SelectEvent): Promise<boolean> {
    const callback = this.getSelect(event.id)
    if (!callback) return false
    await callback(event)
    return true
  }

  /** Invoke the checkbox callback of `event.id` if registered and unexpired; resolves whether one ran. */
  async dispatchCheck(event: CheckEvent): Promise<boolean> {
    const callback = this.getCheck(event.id)
    if (!callback) return false
    await callback(event)
    return true
  }

  clear(): void {
    this.buttons.clear()
    this.selects.clear()
    this.checks.clear()
  }
}
