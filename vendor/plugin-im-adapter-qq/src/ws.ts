/**
 * WebSocket gateway of the QQ official bot.
 *
 * The gateway is a Discord-like JSON protocol on one socket per shard:
 *
 * | op | name | direction | meaning |
 * |---|---|---|---|
 * | 10 | `HELLO` | ← | announces `heartbeat_interval`; the socket must identify or resume right away |
 * | 2 | `IDENTIFY` | → | `{ token, intents, shard: [0, 1] }` — opens a session |
 * | 6 | `RESUME` | → | `{ token, session_id, seq }` — re-attaches to the session of the previous socket |
 * | 1 | `HEARTBEAT` | → | `{ d }` (`seq` or `null`), at the announced interval |
 * | 11 | `HEARTBEAT_ACK` | ← | proves the connection is alive; a missing ack makes the socket a zombie |
 * | 0 | `DISPATCH` | ← | one event plus the **sequence number `s`** that `RESUME` echoes |
 * | 7 | `RECONNECT` | ← | the server wants a new socket; the session stays resumable |
 * | 9 | `INVALID_SESSION` | ← | the session is gone; the next socket must identify again |
 *
 * This class owns that state machine (session id, last sequence number, heartbeat liveness) and hands every dispatch
 * to the decoder — {@link QQBot.decodeDispatch} — awaiting `bot.receive` for each returned session before the next
 * frame is handled, so the intake gate runs before anything else observes the event. `READY` / `RESUMED` are
 * transport-level: they publish the bot identity and online status here.
 *
 * Everything else — backoff, `bot-connect` / `bot-disconnect` status, disposal — is the core's
 * {@link WsClientBase} retry policy; `prepare()` runs again on every (re)connection, which is what makes `RESUME`
 * work after a transport failure. `transport: 'none'` never installs this client at all ({@link QQBot.isRestOnly}).
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/ws
 */

import { type Context } from '@deepseek-ai/cordis'
import { Status, WsClientBase, type WebSocket } from '@deepseek-ai/cordis-plugin-im-core'
import {} from '@deepseek-ai/cordis-plugin-http'
import { type GatewayDispatch, type QQBot } from './bot.ts'

/** Gateway op codes. */
export const Opcode = {
  /** Event dispatch; the frame carries `t`, `d` and the sequence number `s`. */
  DISPATCH: 0,
  /** Heartbeat, at the interval `HELLO` announced. */
  HEARTBEAT: 1,
  /** Open a session. */
  IDENTIFY: 2,
  /** Re-attach to the session of the previous socket. */
  RESUME: 6,
  /** The server asks for a new socket; the session stays resumable. */
  RECONNECT: 7,
  /** The session is unusable; identify again. */
  INVALID_SESSION: 9,
  /** First frame of every socket: `d.heartbeat_interval`. */
  HELLO: 10,
  /** Answer to a heartbeat. */
  HEARTBEAT_ACK: 11,
} as const

/** One gateway frame in either direction. */
export interface GatewayPayload {
  op: number
  /** Frame body; shape depends on `op` and (for dispatches) on `t`. */
  d?: unknown
  /** Sequence number of a dispatch; `RESUME` (`seq`) and `HEARTBEAT` (`d`) echo the latest one. */
  s?: number | undefined
  /** Event name of a dispatch (`READY`, `GROUP_AT_MESSAGE_CREATE`, `INTERACTION_CREATE` …). */
  t?: string | undefined
  /** Outer event id of a dispatch. */
  id?: string | undefined
}

/** Heartbeat period used when `HELLO` does not announce a usable one. */
export const DEFAULT_HEARTBEAT_INTERVAL = 45_000

/** Close codes of the gateway; 4008 (rate limited) and 4009 (session timed out) keep the session resumable. */
const RESUMABLE_CLOSE_CODES = [4008, 4009]

/** Read a JSON object, or `undefined` for anything else. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Read a non-empty string, or `undefined`. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** Text of one frame body; the gateway speaks JSON, so anything but text or bytes is a protocol error. */
function textOf(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  throw new TypeError('QQ gateway frames must be text')
}

/**
 * Validate one received frame.
 *
 * @param text - frame body.
 * @returns the frame with only the fields the protocol defines.
 * @throws TypeError when the body is not a gateway frame.
 */
export function parsePayload(text: string): GatewayPayload {
  const frame = asObject(JSON.parse(text))
  if (!frame || typeof frame.op !== 'number') throw new TypeError('Invalid QQ gateway frame')
  const payload: GatewayPayload = { op: frame.op }
  if (typeof frame.s === 'number') payload.s = frame.s
  if (typeof frame.t === 'string') payload.t = frame.t
  if (typeof frame.id === 'string') payload.id = frame.id
  if (frame.d !== undefined) payload.d = frame.d
  return payload
}

/**
 * The Gateway client of one application (`bot.adapter`).
 *
 * A single instance lives as long as the bot: the session id and the last sequence number survive socket failures,
 * so a reconnect resumes instead of identifying. {@link heartbeat} is public because the liveness rule is part of
 * what the retry policy needs to be tested against.
 */
export class WsClient extends WsClientBase<QQBot> {
  /** Session id from `READY`; empty ⇒ the next `HELLO` identifies instead of resuming. */
  sessionId = ''

  /** Last dispatch sequence number (`s`); `RESUME` and every heartbeat echo it. */
  seq: number | undefined

  /** Heartbeat period announced by `HELLO` (ms); 0 until the first `HELLO`. */
  heartbeatInterval = 0

  /** Whether the platform acknowledged the last heartbeat; `false` means the socket may be a zombie. */
  acked = true

  private timer: ReturnType<typeof setInterval> | undefined

  /** Tail of the dispatch chain: transport frames are handled at once, dispatches in arrival order (see below). */
  private dispatches: Promise<void> = Promise.resolve()

  constructor(ctx: Context, bot: QQBot) {
    super(ctx, bot, bot.config.ws)
    bot.adapter = this
  }

 // -------------------------------------------------------------------------------------------------------------
 // Transport contract of `QQGatewayClient`

  async connect() {
    await this.start()
  }

  async disconnect() {
    await this.stop()
  }

 // -------------------------------------------------------------------------------------------------------------
 // `WsClientBase` hooks

  protected getActive() {
    return this.bot.isActive
  }

  protected setStatus(status: Status, error?: Error) {
    this.bot.status = status
    this.bot.error = error
  }

  /**
 * Resolve the socket for one connection attempt: `GET /gateway`, then the WebSocket the HTTP plugin opens (so
 * proxies and `http/websocket` interception apply).
 *
 * @param signal - cancellation of the whole connection attempt.
 * @returns the socket, before it is open.
 */
  protected async prepare(signal: AbortSignal): Promise<WebSocket> {
    const url = await this.bot.gatewayUrl(signal)
    signal.throwIfAborted()
    return this.bot.ctx.http.ws(url) as unknown as WebSocket
  }

  /**
 * Wire the protocol onto one open socket: every frame goes through {@link receiveFrame}, in order, inside a task
 * the transport drains before it reports the bot disconnected.
 *
 * @param socket - the open socket.
 * @param signal - aborted when this socket is done; the heartbeat and the listeners die with it.
 */
  protected async accept(socket: WebSocket, signal: AbortSignal) {
    const connection = new AbortController()
    const abort = () => connection.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    const receive = (event: WebSocket.MessageEvent) => {
      if (connection.signal.aborted) return
      this.track(this.receiveFrame(socket, event.data, connection).catch((error) => {
        // A decode failure is logged inside dispatch() and leaves the connection up; a receive() persistence
        // failure aborts the connection and closes the socket so RESUME replays the unpersisted frame.
        this.bot.ctx.logger.error('QQ gateway frame failed: %s', error)
      }))
    }
    const close = ({ code }: WebSocket.CloseEvent) => {
      socket.removeEventListener('close', close)
      this.stopHeartbeat()
      // 4006/4007 (bad session id / bad sequence) and the other 4xxx codes outside the resumable pair mean the
      // session is unusable: identify again on the next socket instead of resuming into the same failure.
      if (code >= 4000 && !RESUMABLE_CLOSE_CODES.includes(code)) this.dropSession()
    }
    const cleanup = () => {
      this.stopHeartbeat()
      socket.removeEventListener('message', receive)
      signal.removeEventListener('abort', abort)
    }
    connection.signal.addEventListener('abort', cleanup, { once: true })
    socket.addEventListener('message', receive)
    socket.addEventListener('close', close)
  }

 // -------------------------------------------------------------------------------------------------------------
 // Protocol

  /**
 * One heartbeat. A heartbeat the platform never acknowledged means a half-open connection, so the socket is
 * closed and the retry policy reconnects (and resumes).
 */
  heartbeat() {
    const socket = this.socket
    if (!socket) return
    if (!this.acked) {
      this.bot.ctx.logger.warn('QQ gateway heartbeat was not acknowledged; reconnecting')
      this.stopHeartbeat()
      socket.close(3000, 'heartbeat not acknowledged')
      return
    }
    this.send(socket, { op: Opcode.HEARTBEAT, d: this.seq ?? null })
    this.acked = false
  }

  private async receiveFrame(socket: WebSocket, data: unknown, connection: AbortController) {
    const payload = parsePayload(textOf(data))
    switch (payload.op) {
      case Opcode.HELLO:
        return await this.hello(socket, payload, connection.signal)
      case Opcode.HEARTBEAT_ACK:
        this.acked = true
        return
      case Opcode.HEARTBEAT:
        return void this.heartbeat()
      case Opcode.RECONNECT:
 // Keep the session: the next socket resumes from the sequence number we already have.
        this.bot.ctx.logger.warn('QQ gateway asked to reconnect')
        this.stopHeartbeat()
        socket.close(1000, 'server requested reconnect')
        return
      case Opcode.INVALID_SESSION:
        this.bot.ctx.logger.warn('QQ gateway session is invalid; identifying again')
        this.dropSession()
        this.stopHeartbeat()
        socket.close(1000, 'invalid session')
        return
      case Opcode.DISPATCH:
        return await this.enqueueDispatch(socket, payload, connection)
      default:
        return this.bot.ctx.logger.warn('QQ gateway opcode %d is not supported', payload.op)
    }
  }

  /** `HELLO`: pick the heartbeat period, then identify or resume. */
  private async hello(socket: WebSocket, payload: GatewayPayload, signal: AbortSignal) {
    const interval = Number(asObject(payload.d)?.heartbeat_interval)
    this.heartbeatInterval = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_HEARTBEAT_INTERVAL
    const token = await this.bot.authorization(signal)
    signal.throwIfAborted()
    if (this.sessionId) {
      this.send(socket, { op: Opcode.RESUME, d: { token, session_id: this.sessionId, seq: this.seq } })
    } else {
      this.send(socket, { op: Opcode.IDENTIFY, d: { token, intents: this.bot.config.intents, shard: [0, 1] } })
    }
    this.stopHeartbeat()
    this.acked = true
    const timer = this.timer = setInterval(() => this.heartbeat(), this.heartbeatInterval)
 // A heartbeat alone must not keep the host process alive; the socket keeps it alive instead.
    ;(timer as { unref?(): void }).unref?.()
  }

  /**
 * Run one dispatch behind the previous one.
 *
 * Transport frames (`HELLO`, heartbeats, reconnects) must never wait for intake — a slow durable write would
 * starve the heartbeat and turn the socket into a zombie — so only dispatches are serialized. Serializing them
 * keeps the order the platform sent them in, which is the order the intake store assigns its per-chat `seq` in.
 */
  private async enqueueDispatch(socket: WebSocket, payload: GatewayPayload, connection: AbortController) {
    const run = this.dispatches.then(async () => {
      if (connection.signal.aborted) return
      await this.dispatch(socket, payload, connection)
      if (!connection.signal.aborted && typeof payload.s === 'number') this.seq = payload.s
    })
    this.dispatches = run.then(() => {}, () => {})
    return await run
  }

  /** One `DISPATCH`: `READY`/`RESUMED` are transport-level, everything else is decoded and received. */
  private async dispatch(socket: WebSocket, payload: GatewayPayload, connection: AbortController) {
    const type = payload.t
    if (!type) return
    if (type === 'READY') {
      const data = asObject(payload.d)
      const sessionId = readString(data?.session_id)
      if (sessionId) this.sessionId = sessionId
      this.applyUser(asObject(data?.user))
      this.bot.online()
      return
    }
    if (type === 'RESUMED') {
      this.bot.online()
      return
    }
    const frame: GatewayDispatch = { op: 0, t: type, d: payload.d }
    if (payload.s !== undefined) frame.s = payload.s
    if (payload.id !== undefined) frame.id = payload.id
    let sessions: Awaited<ReturnType<QQBot['decodeDispatch']>>
    try {
      sessions = await this.bot.decodeDispatch(frame)
    } catch (error) {
      this.bot.ctx.logger.error('QQ gateway frame failed: %s', error)
      return
    }
    try {
      for (const session of sessions) {
        if (connection.signal.aborted) return
        await this.bot.receive(session)
      }
    } catch (error) {
      // Persistence failed: abort this connection synchronously so queued frames cannot advance `this.seq`,
      // then close so `WsClientBase` reconnects and `RESUME` replays from the last persisted frame.
      connection.abort(error)
      socket.close(3000, 'receive failed')
      throw error
    }
  }

  /** `READY` publishes the bot's own identity: a REST-only bot has none until then. */
  private applyUser(user: Record<string, unknown> | undefined) {
    const id = readString(user?.id)
    if (!id) return
    this.bot.selfId = id
    const name = readString(user?.username)
    this.bot.user = name ? { id, name, isBot: true } : { id, isBot: true }
  }

  private send(socket: WebSocket, payload: GatewayPayload) {
    socket.send(JSON.stringify(payload))
  }

  private dropSession() {
    this.sessionId = ''
    this.seq = undefined
  }

  private stopHeartbeat() {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
