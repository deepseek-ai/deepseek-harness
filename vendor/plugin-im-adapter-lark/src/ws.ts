/**
 * WebSocket long connection of the Lark / Feishu adapter.
 *
 * The platform hands out a gateway URL (`POST /callback/ws/endpoint`) and then speaks protobuf frames over it: a
 * control frame for heartbeats and one data frame per callback, whose payload is the JSON event envelope of
 * {@link ./api/events.ts}. Large events are split into fragments that share a `message_id` and carry `sum`/`seq`.
 *
 * Accepted families:
 * - `im.message.receive_v1` and `im.message.recalled_v1`: decoded to sessions by {@link LarkBot.decodeEvent},
 *   each awaited through `bot.receive` (the intake gate) **before** the frame is acknowledged;
 * - `card.action.trigger`: published as an `interaction/button` session (a click or a form submit) or an
 *   `interaction/select` session (a pick in a `<select>`) and answered **once**, before intake is awaited to the end —
 *   with the toast a listener passes to `respond()`, else `{}` when intake settles or `config.callbackAnswerMs`
 *   elapses — because the platform gives a card callback 3 seconds while the intake store may be slower;
 * - `im.message.reaction.created_v1` / `deleted_v1`: admitted like messages when they arrive.
 *
 * Any other family, and `card.action.trigger` when `config.callbacks` is off, is acknowledged **without** admission:
 * the platform must not redeliver an event this adapter does not serve.
 *
 * ACK semantics: an event gets its acknowledgement only after every session was accepted (a failed intake leaves no
 * success ACK, so the platform redelivers), while a card callback is answered by its deadline at the latest and its
 * intake failure is logged — the user's click must never wait for storage.
 *
 * Everything else — backoff, `bot-connect`/`bot-disconnect` status, disposal — is the core {@link WsClientBase};
 * `prepare()` runs again on every reconnect, and {@link LarkBot.initialize} re-learns the token and identity there.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/ws
 */

import { type Context } from '@deepseek-ai/cordis'
import {
  type ButtonAnswer, type ButtonEvent, type ChatRef, type CheckEvent, type SelectEvent, type Session, Status,
  type UserRef, WsClientBase, type WebSocket,
} from '@deepseek-ai/cordis-plugin-im-core'
import {} from '@deepseek-ai/cordis-plugin-http'
import pb from 'protobufjs/light.js'
import {
  type LarkCardActionEvent, cardFormValues, cardOptionValues, decodeTimestamp, isDict, nonEmpty,
  parseEventEnvelope, type LarkRawEvent, type LarkReferrer,
} from './api/events.ts'
import { type LarkBot } from './bot.ts'
import { resolveBaseUrl } from './config.ts'

/** Frame method: control frames carry the protocol itself, data frames carry one callback. */
export enum FrameType {
  control = 0,
  data = 1,
}

/** `type` header of a frame. */
export enum MessageType {
  event = 'event',
  card = 'card',
  ping = 'ping',
  pong = 'pong',
}

/** The fragment bookkeeping one frame carries. */
export interface FrameSegment {
  message_id: string
  sum: number
  seq: number
  data: Uint8Array
}

/** One decoded protobuf frame. */
export interface Frame {
  headers: { key: string; value: string }[]
  method: FrameType
  service: number
  SeqID: number
  LogID: number
  payload?: Uint8Array
}

/** Confirmation the platform accepts as the answer of an ordinary event. */
const EVENT_ACK = { code: 200 }

/**
 * Whether an event family is admitted (and so decoded and acknowledged after intake), as opposed to merely
 * acknowledged.
 *
 * @param type - `header.event_type` of the envelope.
 * @param callbacks - `config.callbacks`: without it a card callback is not an interaction this bot serves.
 * @returns whether the family is admitted.
 */
export function isAdmittedEvent(type: string, callbacks: boolean): boolean {
  switch (type) {
    case 'im.message.receive_v1':
    case 'im.message.recalled_v1':
    case 'im.message.reaction.created_v1':
    case 'im.message.reaction.deleted_v1':
      return true
    case 'card.action.trigger':
      return callbacks
    default:
      return false
  }
}

/** A decoded JSON object of a wire body. */
type Dict = Record<string, unknown>

/** Build a required string, or throw. */
function requiredString(value: unknown, field: string): string {
  const text = nonEmpty(value)
  if (!text) throw new TypeError(`Invalid Lark ${field}`)
  return text
}

/**
 * Decode one `card.action.trigger` into an `interaction/button` or `interaction/select` session, if it carries one of
 * this adapter's controls.
 *
 * A card control sends `value: { v4: { id, data } }`, so an older card (or another application's value) simply
 * carries no interaction this process can route and yields no session. `action.tag` says which control fired: a
 * `select_static` / `multi_select_static` reports its picked option(s) as a select event, anything else (a button,
 * including a form submit) as a button event — and a submit also carries `action.form_value`, the values of the form
 * the button stands in. The chat kind is probed through {@link LarkBot.chatTypeOf} because the callback does not say
 * whether it happened in a group or a direct chat.
 *
 * @param bot - receiving bot.
 * @param raw - validated event envelope.
 * @param signal - cancellation of the chat probe.
 * @param now - clock used for `referrer.receivedAt` and the timestamp fallback.
 * @returns the interaction as a session, or `undefined` when the value is not one of this adapter's controls.
 */
export async function cardActionSession(
  bot: LarkBot,
  raw: LarkRawEvent,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<Session | undefined> {
  const event = raw.event as LarkCardActionEvent
  const action: Dict = isDict(event.action) ? event.action : {}
  const value = isDict(action.value) ? action.value : {}
  const v4 = isDict(value.v4) ? value.v4 : {}
  const id = nonEmpty(v4.id)
  if (!id) return
  const context: Dict = isDict(event.context) ? event.context : {}
  const chatId = nonEmpty(context.open_chat_id)
  if (!chatId) return
  const messageId = nonEmpty(context.open_message_id)
  const chatType = await bot.chatTypeOf(chatId, signal)
  const chat: ChatRef = { id: chatId, type: chatType }
  const operator: Dict = isDict(event.operator) ? event.operator : {}
  const user: UserRef = { id: nonEmpty(operator.open_id) ?? '' }
  const time = decodeTimestamp(raw.header.create_time, now)
  const referrer: LarkReferrer = {
    event_id: raw.header.event_id,
    receivedAt: now,
    chatType,
    chatId,
  }
  if (messageId) referrer.messageId = messageId
  const tag = nonEmpty(action.tag)
  if (tag === 'select_static' || tag === 'multi_select_static') {
    const select: SelectEvent & { user: UserRef; chat: ChatRef } = {
      bot,
      id,
      values: cardOptionValues(action),
      referrer,
      time,
      user,
      chat,
    }
    const data = v4.data
    if (typeof data === 'string' && data) select.data = data
    else if (data !== undefined && data !== null) select.data = JSON.stringify(data)
    if (messageId) select.message = { id: messageId, chat }
    return bot.session({ type: 'interaction/select', id: raw.header.event_id, timestamp: time, select, referrer })
  }
  if (tag === 'checker') {
    // A checkbox reports its own toggles (`勾选器回调示例`: `action.checked`), unlike a text input.
    const check: CheckEvent & { user: UserRef; chat: ChatRef } = {
      bot,
      id,
      checked: action.checked === true,
      referrer,
      time,
      user,
      chat,
    }
    const data = v4.data
    if (typeof data === 'string' && data) check.data = data
    else if (data !== undefined && data !== null) check.data = JSON.stringify(data)
    if (messageId) check.message = { id: messageId, chat }
    return bot.session({ type: 'interaction/check', id: raw.header.event_id, timestamp: time, check, referrer })
  }
  const button: ButtonEvent & { user: UserRef; chat: ChatRef } = { bot, id, referrer, time, user, chat }
  const data = v4.data
  if (typeof data === 'string' && data) button.data = data
  else if (data !== undefined && data !== null) button.data = JSON.stringify(data)
  const values = cardFormValues(action.form_value)
  if (values) button.values = values
  if (messageId) button.message = { id: messageId, chat }
  return bot.session({ type: 'interaction/button', id: raw.header.event_id, timestamp: time, button, referrer })
}

/** Heartbeat period of the gateway; the platform announces its own in `ClientConfig.PingInterval`. */
const DEFAULT_PING_INTERVAL = 90_000

/**
 * The callback answer body of one {@link ButtonAnswer}: `{ toast: { type, content } }`, or `{}` without a toast.
 *
 * @param answer - the listener's answer.
 * @returns the JSON body the frame is answered with.
 */
export function cardAnswerBody(answer: ButtonAnswer): Record<string, unknown> {
  return answer.toast ? { toast: { type: answer.toast.type, content: answer.toast.content } } : {}
}

/**
 * The long connection of one application (`bot.adapter`).
 *
 * A single instance lives as long as the bot; the adapter's route table, callback intents and frame limits come from
 * `bot.config` on every connection attempt, so a reloaded configuration applies on the next reconnect.
 */
export class WsClient extends WsClientBase<LarkBot> {
  /** `service_id` of the gateway URL; it must be echoed in every control frame. */
  _serviceId = 0

  /** Heartbeat period (ms) announced by the gateway. */
  _pingInterval = DEFAULT_PING_INTERVAL

  /** Protobuf `Frame` type of the wire protocol. */
  _frame: pb.Type

  private pendingEvents = 0
  private readonly cache = new Map<string, { sum: number; parts: Map<number, Uint8Array>; bytes: number; expires: number }>()

  constructor(ctx: Context, bot: LarkBot) {
    super(ctx, bot, bot.config.ws)
    bot.adapter = this
    this._frame = pb.Root.fromJSON({
      nested: {
        Header: {
          fields: {
            key: { rule: 'required', type: 'string', id: 1 },
            value: { rule: 'required', type: 'string', id: 2 },
          },
        },
        Frame: {
          fields: {
            SeqID: { rule: 'required', type: 'uint64', id: 1 },
            LogID: { rule: 'required', type: 'uint64', id: 2 },
            service: { rule: 'required', type: 'int32', id: 3 },
            method: { rule: 'required', type: 'int32', id: 4 },
            headers: { rule: 'repeated', type: 'Header', id: 5 },
            payloadEncoding: { type: 'string', id: 6 },
            payloadType: { type: 'string', id: 7 },
            payload: { type: 'bytes', id: 8 },
            LogIDNew: { type: 'string', id: 9 },
          },
        },
      },
    }).lookupType('Frame')
  }

  // -------------------------------------------------------------------------------------------------------------
  // Transport contract of the bot

  async connect() {
    await this.start()
  }

  async disconnect() {
    await this.stop()
  }

  // -------------------------------------------------------------------------------------------------------------
  // `WsClientBase` hooks

  protected getActive(): boolean {
    return this.bot.isActive
  }

  protected setStatus(status: Status, error?: Error): void {
    this.bot.status = status
    this.bot.error = error
  }

  /**
   * Ask the platform for a gateway URL and open the socket through the HTTP plugin, so proxy configuration and the
   * `http/websocket` hook apply.
   *
   * @param signal - cancellation of the whole connection attempt.
   * @returns the socket, before it is open.
   */
  protected async prepare(signal: AbortSignal): Promise<WebSocket> {
    const origin = new URL(resolveBaseUrl(this.bot.config)).origin
    const answer = await this.bot.ctx.http.post<{
      code?: number
      msg?: string
      data?: { URL?: string; ClientConfig?: { PingInterval?: number } }
    }>(`${origin}/callback/ws/endpoint`, {
      AppID: this.bot.config.appId,
      AppSecret: this.bot.config.appSecret,
    }, { signal })
    const data = isDict(answer?.data) ? answer.data as Dict : undefined
    const config = data && isDict(data.ClientConfig) ? data.ClientConfig as Dict : undefined
    if (answer?.code !== 0 || !data || !config) throw new Error('Lark gateway request failed')
    const url = requiredString(data.URL, 'gateway URL')
    const serviceId = Number(new URL(url).searchParams.get('service_id'))
    const pingInterval = Number(config.PingInterval)
    if (!Number.isInteger(serviceId) || !Number.isFinite(pingInterval) || pingInterval <= 0) {
      throw new Error('Invalid Lark gateway configuration')
    }
    this._serviceId = serviceId
    this._pingInterval = pingInterval * 1000
    signal.throwIfAborted()
    const socket = this.bot.ctx.http.ws(url) as unknown as WebSocket
    socket.binaryType = 'arraybuffer'
    return socket
  }

  /**
   * Wire the protocol onto one open socket: learn the bot identity, start the heartbeat and hand every frame to
   * {@link WsClient.receiveFrame}.
   *
   * @param socket - the open socket.
   * @param signal - aborted when this socket is done; the heartbeat and the listeners die with it.
   */
  protected async accept(socket: WebSocket, signal: AbortSignal) {
    await this.bot.initialize(signal)
    signal.throwIfAborted()
    let timer: ReturnType<typeof setTimeout>
    const cleanup = () => {
      clearTimeout(timer)
      this.cache.clear()
      socket.removeEventListener('message', receive)
    }
    const ping = () => {
      if (signal.aborted) return
      try {
        this.send(socket, {
          headers: [{ key: 'type', value: MessageType.ping }],
          service: this._serviceId,
          method: FrameType.control,
          SeqID: 0,
          LogID: 0,
        })
        timer = setTimeout(ping, this._pingInterval)
      } catch (error) {
        this.bot.ctx.logger.error('Lark heartbeat failed; reconnecting: %s', error)
        socket.close(3000, 'heartbeat failed')
      }
    }
    const receive = ({ data }: WebSocket.MessageEvent) => {
      if (signal.aborted) return
      if (this.pendingEvents >= this.bot.config.ws.maxPendingEvents) {
        socket.close(3000, 'intake capacity exceeded')
        return
      }
      this.pendingEvents++
      this.track(this.receiveFrame(socket, data, signal).catch((error) => {
        // No success ACK: the platform may redeliver, and the durable consumer owns deduplication.
        this.bot.ctx.logger.error('Lark event was not acknowledged; inspect intake/storage and retry: %s',
          describeIntakeFailure(error))
      }).finally(() => { this.pendingEvents-- }))
    }
    signal.addEventListener('abort', cleanup, { once: true })
    socket.addEventListener('message', receive)
    ping()
  }

  // -------------------------------------------------------------------------------------------------------------
  // Frames

  /**
   * One received frame: reassemble the message, then admit, acknowledge and publish its event.
   *
   * @param socket - socket the frame arrived on (the acknowledgement goes back through it).
   * @param data - frame body.
   * @param signal - connection signal.
   */
  private async receiveFrame(socket: WebSocket, data: unknown, signal: AbortSignal) {
    if (!(data instanceof ArrayBuffer)) throw new Error('Invalid Lark binary frame')
    if (data.byteLength > this.bot.config.ws.maxFrameBytes) throw new Error('Lark frame exceeds byte limit')
    // Protobuf owns wire decoding; the header/payload fields read below are checked individually.
    const frame = this._frame.decode(new Uint8Array(data)) as pb.Message & Frame
    const headers = Object.fromEntries(frame.headers.map(header => [header.key, header.value]))
    if (frame.method !== FrameType.data) {
      // A gateway ping is answered so the platform keeps this socket; every other control frame is transport noise.
      if (headers.type === MessageType.ping) {
        this.send(socket, {
          headers: [{ key: 'type', value: MessageType.pong }],
          service: this._serviceId,
          method: FrameType.control,
          SeqID: 0,
          LogID: 0,
        })
      }
      return
    }
    if (headers.type !== MessageType.event) return
    const payload = this.retrieve({
      message_id: requiredString(headers.message_id, 'frame message ID'),
      sum: Number(headers.sum),
      seq: Number(headers.seq),
      data: frame.payload ?? new Uint8Array(),
    })
    if (!payload) return
    const raw = parseEventEnvelope(JSON.parse(Buffer.from(payload).toString('utf8')))
    if (raw.header.app_id !== this.bot.config.appId) throw new Error('Lark event belongs to another application')
    const type = raw.header.event_type
    if (type === 'card.action.trigger' && this.bot.config.callbacks) {
      await this.answerCardAction(socket, frame, raw, signal)
      return
    }
    if (!isAdmittedEvent(type, this.bot.config.callbacks)) {
      this.acknowledge(socket, frame, EVENT_ACK)
      return
    }
    const sessions = await this.bot.decodeEvent(raw)
    for (const session of sessions) await this.bot.receive(session)
    if (!signal.aborted) this.acknowledge(socket, frame, EVENT_ACK)
  }

  /**
   * One `card.action.trigger`: decode the interaction, hand it to intake with `respond` attached, and answer the frame
   * once — with the listener's answer when it calls `respond`, else `{}` when intake settles or `config.callbackAnswerMs`
   * after arrival elapses, whichever comes first. The platform wants the answer within 3 s, so intake is never awaited
   * past that deadline; a failed intake still rejects and is logged by the caller.
   *
   * @param socket - socket the frame arrived on.
   * @param frame - the callback frame (answered in place).
   * @param raw - validated event envelope.
   * @param signal - connection signal; an aborted connection sends no answer.
   */
  private async answerCardAction(socket: WebSocket, frame: pb.Message & Frame, raw: LarkRawEvent, signal: AbortSignal) {
    let answered = false
    const answer = (body: unknown) => {
      if (answered) return
      answered = true
      clearTimeout(timer)
      if (!signal.aborted) {
        this.acknowledge(socket, frame, { code: 200, data: Buffer.from(JSON.stringify(body)).toString('base64') })
      }
    }
    const timer = setTimeout(() => answer({}), this.bot.config.callbackAnswerMs)
    let deferred = false
    try {
      const session = await cardActionSession(this.bot, raw, signal)
      if (!session) return
      const interaction = session.button ?? session.select ?? session.check
      if (!interaction) return
      interaction.respond = async (reply: ButtonAnswer) => { answer(cardAnswerBody(reply)) }
      // A listener that answers asynchronously claims the answer; the deadline still bounds it.
      interaction.defer = () => { deferred = true }
      await this.bot.receive(session)
    } finally {
      if (!deferred) answer({})
    }
  }

  /** Answer one frame: same frame back, plus the `biz_rt` header the platform expects and the response body. */
  private acknowledge(socket: WebSocket, frame: pb.Message & Frame, body: unknown) {
    this.send(socket, {
      ...frame,
      headers: [...frame.headers, { key: 'biz_rt', value: '0' }],
      payload: Buffer.from(JSON.stringify(body)),
    })
  }

  private send(socket: WebSocket, frame: Frame | (pb.Message & Frame)) {
    socket.send(this._frame.encode(frame).finish())
  }

  /**
   * Reassemble bounded, expiring fragments; duplicates cannot count as missing parts.
   *
   * @param seg - the fragment one frame carries.
   * @returns the complete payload once every fragment arrived, else `undefined`.
   */
  retrieve(seg: FrameSegment): Uint8Array | undefined {
    const { message_id: id, sum, seq, data } = seg
    const { maxFrameParts, maxFrameBytes, maxPendingFrames, frameTimeoutMs } = this.bot.config.ws
    const now = Date.now()
    for (const [key, value] of this.cache) if (value.expires <= now) this.cache.delete(key)
    if (!Number.isInteger(sum) || sum < 1 || sum > maxFrameParts || !Number.isInteger(seq) || seq < 0 || seq >= sum
      || data.byteLength > maxFrameBytes) throw new Error('Invalid Lark frame fragment')
    let entry = this.cache.get(id)
    if (!entry) {
      if (this.cache.size >= maxPendingFrames) throw new Error('Lark fragment cache is full')
      entry = { sum, parts: new Map(), bytes: 0, expires: now + frameTimeoutMs }
      this.cache.set(id, entry)
    }
    const prior = entry.parts.get(seq)
    if (entry.sum !== sum || (prior && !Buffer.from(prior).equals(data))) {
      this.cache.delete(id)
      throw new Error('Conflicting Lark fragments')
    }
    if (!prior) {
      entry.parts.set(seq, data)
      entry.bytes += data.byteLength
    }
    if (entry.bytes > maxFrameBytes) {
      this.cache.delete(id)
      throw new Error('Lark message exceeds byte limit')
    }
    if (entry.parts.size !== sum) return
    this.cache.delete(id)
    return Buffer.concat(Array.from({ length: sum }, (_, index) => entry.parts.get(index)!))
  }
}

/**
 * Every failure behind one rejected intake frame. A frame's rejection is an `AggregateError` over the listeners that
 * received it, and its own message is empty — logging it as it stands says "AggregateError" and names no listener, so
 * one line of intake errors is indistinguishable from the next. Each aggregated failure keeps its name and its `code`
 * (an `ImError` carries `persistence`, `access`, …), which is what says where the admission went wrong.
 * @param error - the rejection of one received frame.
 * @returns the error and each aggregated failure, one line.
 */
function describeIntakeFailure(error: unknown): string {
  const one = (reason: unknown): string => {
    if (!(reason instanceof Error)) return String(reason)
    const code = 'code' in reason ? reason.code : undefined
    return `${reason.name}${code === undefined ? '' : `(${String(code)})`}: ${reason.message}`
  }
  if (!(error instanceof AggregateError) || error.errors.length === 0) return one(error)
  return `${one(error)} [${error.errors.length}]: ${error.errors.map(one).join(' | ')}`
}
