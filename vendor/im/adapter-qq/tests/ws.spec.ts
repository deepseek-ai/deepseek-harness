/**
 * Gateway lifecycle of the QQ adapter : identify on `HELLO`, heartbeats and zombie detection,
 * dispatch → decoder → intake, `RECONNECT` / `INVALID_SESSION`, and resuming with the last sequence number.
 *
 * Every test drives a fake socket through the `http/websocket` hook, so nothing leaves the process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Events } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import { Satori, Status } from '@deepseek-ai/cordis-plugin-im-core'
import QQBot, {
  Config,
  DEFAULT_INTENTS,
  Opcode,
  parsePayload,
  WsClient,
  type GatewayDispatch,
  type GatewayPayload,
  type QQConfig,
} from '@deepseek-ai/cordis-plugin-im-adapter-qq'

/** The `HELLO` every test opens with; a long interval keeps the automatic heartbeat out of the way. */
const HELLO: GatewayPayload = { op: Opcode.HELLO, d: { heartbeat_interval: 60_000 } }

/** Minimal stand-in for the platform socket: it records what the adapter sends and replays what the tests feed it. */
class Socket extends EventTarget {
  url = 'wss://api.sgroup.qq.com/websocket'
  protocol = ''
  readyState = 1
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer'
  /** Frames the adapter sent, parsed back so tests compare protocol payloads instead of JSON text. */
  sent: GatewayPayload[] = []
  closed = false
  closeCode: number | undefined

  send(data: unknown) {
    this.sent.push(parsePayload(String(data)))
  }

  close(code = 1000, reason = '') {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException(`Invalid close code: ${code}`, 'InvalidAccessError')
    }
    this.drop(code, reason)
  }

  drop(code = 1006, reason = '') {
    if (this.closed) return
    this.closed = true
    this.closeCode = code
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }))
  }

  /** The transport is open; the adapter starts the protocol as soon as it is. */
  open() {
    this.dispatchEvent(new Event('open'))
  }

  /** Deliver one frame to the adapter. */
  receive(payload: GatewayPayload | string) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    this.dispatchEvent(Object.assign(new Event('message'), { data }))
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

/** Mount the adapter with a fake gateway; the bot connects on plugin load. */
async function mount(input: Record<string, unknown> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  const sockets: Socket[] = []
  const requests: string[] = []
  const openSocket: Events['http/websocket'] = () => {
    const socket = new Socket()
    sockets.push(socket)
    return socket as unknown as ReturnType<Events['http/websocket']>
  }
  ctx.on('http/websocket', openSocket)
  ctx.on('http/fetch', async (url) => {
    requests.push(url.pathname)
    if (url.pathname.endsWith('/gateway')) return Response.json({ url: 'wss://api.sgroup.qq.com/websocket' })
    if (url.pathname.endsWith('/app/getAppAccessToken')) return Response.json({ access_token: 'access-token', expires_in: 7200 })
    throw new Error(`Unexpected request: ${url.pathname}`)
  })
  const config = Config({
    appId: '102106848',
    secret: 'secret',
    ws: { retryInterval: 1, retryLazy: 1 },
    ...input,
  } as QQConfig)
  await ctx.plugin(QQBot, config)
  const bot = ctx.bots[0] as QQBot
  return {
    ctx,
    bot,
    sockets,
    requests,
    /** The gateway client the bot installed for `transport: 'ws'`. */
    get adapter() {
      return bot.adapter as WsClient
    },
  }
}

type Mounted = Awaited<ReturnType<typeof mount>>

/** Wait for the n-th socket to be owned by the client, open it and deliver `HELLO`, which makes the adapter speak. */
async function dial(mounted: Mounted, index = 0, hello: GatewayPayload = HELLO) {
  await vi.waitFor(() => { expect(mounted.bot.adapter).toBeInstanceOf(WsClient) })
  await vi.waitFor(() => { expect(mounted.sockets.length).toBeGreaterThan(index) })
  const socket = mounted.sockets[index]
  if (socket === undefined) throw new Error(`the gateway client opened no socket ${index}`)
  await vi.waitFor(() => { expect(Reflect.get(mounted.adapter, 'socket')).toBe(socket) })
  socket.open()
  socket.receive(hello)
  await vi.waitFor(() => { expect(socket.sent.length).toBeGreaterThanOrEqual(1) })
  return socket
}

/** A `READY` dispatch: it publishes the identity and, importantly, the session a reconnect resumes. */
function ready(sessionId = 'session-1', seq = 7) {
  return {
    op: Opcode.DISPATCH,
    s: seq,
    t: 'READY',
    d: { session_id: sessionId, user: { id: 'bot-1', username: 'QQ Bot' } },
  } satisfies GatewayPayload
}

describe('QQ gateway handshake', () => {
  it('identifies with the application token, the configured intents and one shard', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    expect(mounted.requests).toContain('/gateway')
    expect(socket.sent[0]).toEqual({
      op: Opcode.IDENTIFY,
      d: { token: 'QQBot access-token', intents: DEFAULT_INTENTS, shard: [0, 1] },
    })
    // No session yet, so nothing to resume.
    expect(socket.sent.some(payload => payload.op === Opcode.RESUME)).toBe(false)
    expect(mounted.adapter.heartbeatInterval).toBe(60_000)
  })

  it('uses the intents of the configuration', async () => {
    const mounted = await mount({ intents: 1 << 25 })
    const socket = await dial(mounted)
    expect(socket.sent[0]?.d).toMatchObject({ intents: 1 << 25 })
  })

  it('rejects bodies that are not gateway frames', () => {
    expect(() => parsePayload('not json')).toThrow()
    expect(() => parsePayload('{"op":"0"}')).toThrow(/Invalid QQ gateway frame/)
    expect(() => parsePayload('[]')).toThrow(/Invalid QQ gateway frame/)
    expect(parsePayload('{"op":0,"t":"READY","s":3,"d":{"session_id":"s"}}')).toEqual({
      op: 0, t: 'READY', s: 3, d: { session_id: 's' },
    })
    // The frame keeps only the fields the protocol defines.
    expect(parsePayload('{"op":11,"s":"x","extra":true}')).toEqual({ op: 11 })
  })
})

describe('QQ gateway session', () => {
  it('takes the bot online and publishes its identity from READY', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    socket.receive(ready())
    await vi.waitFor(() => { expect(mounted.bot.status).toBe(Status.ONLINE) })
    expect(mounted.bot.selfId).toBe('bot-1')
    expect(mounted.bot.user).toEqual({ id: 'bot-1', name: 'QQ Bot', isBot: true })
    expect(mounted.adapter.sessionId).toBe('session-1')
    expect(mounted.adapter.seq).toBe(7)
  })

  it('hands dispatches to the decoder and awaits the intake gate in arrival order', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    const gate = Promise.withResolvers<void>()
    const decoded: GatewayDispatch[] = []
    const received: string[] = []
    vi.spyOn(mounted.bot, 'decodeDispatch').mockImplementation(async (frame) => {
      decoded.push(frame)
      return [mounted.bot.session({ type: 'message', id: String(frame.id) })]
    })
    mounted.ctx.on('satori/receive', async (session) => {
      received.push(String(session.event.id))
      if (session.event.id === 'event-1') await gate.promise
    })
    socket.receive({ op: Opcode.DISPATCH, s: 1, id: 'event-1', t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm1' } })
    socket.receive({ op: Opcode.DISPATCH, s: 2, id: 'event-2', t: 'C2C_MESSAGE_CREATE', d: { id: 'm2' } })
    await vi.waitFor(() => { expect(received).toEqual(['event-1']) })
    // The second dispatch waits for the first intake to accept, so nothing can overtake it.
    expect(decoded).toHaveLength(1)
    // The resume cursor only advances once intake persists the frame, so a reconnect while intake is busy or failing
    // replays the unpersisted frame instead of skipping it.
    expect(mounted.adapter.seq).toBeUndefined()
    gate.resolve()
    await vi.waitFor(() => { expect(received).toEqual(['event-1', 'event-2']) })
    await vi.waitFor(() => { expect(mounted.adapter.seq).toBe(2) })
    expect(decoded.map(frame => frame.t)).toEqual(['GROUP_AT_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE'])
    expect(decoded[1]).toMatchObject({ op: 0, s: 2, id: 'event-2', d: { id: 'm2' } })
  })

  it('records the last sequence number of every dispatch', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    vi.spyOn(mounted.bot, 'decodeDispatch').mockResolvedValue([])
    socket.receive({ op: Opcode.DISPATCH, s: 42, t: 'GROUP_AT_MESSAGE_CREATE', d: {} })
    await vi.waitFor(() => { expect(mounted.adapter.seq).toBe(42) })
  })

  it('ignores dispatches without an event name', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    const decode = vi.spyOn(mounted.bot, 'decodeDispatch')
    socket.receive({ op: Opcode.DISPATCH, s: 3, d: {} })
    await vi.waitFor(() => { expect(mounted.adapter.seq).toBe(3) })
    expect(decode).not.toHaveBeenCalled()
  })
})

describe('QQ gateway heartbeat', () => {
  it('heartbeats at the interval HELLO announced', async () => {
    const mounted = await mount()
    const socket = await dial(mounted, 0, { op: Opcode.HELLO, d: { heartbeat_interval: 20 } })
    expect(mounted.adapter.heartbeatInterval).toBe(20)
    await vi.waitFor(() => { expect(socket.sent.map(payload => payload.op)).toContain(Opcode.HEARTBEAT) })
    // Nothing acknowledged them, so the next beat drops the half-open socket (see the zombie test).
    await vi.waitFor(() => { expect(socket.closed).toBe(true) })
  })

  it('keeps the connection while heartbeats are acknowledged', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    mounted.adapter.heartbeat()
    expect(socket.sent.at(-1)).toEqual({ op: Opcode.HEARTBEAT, d: null })
    expect(mounted.adapter.acked).toBe(false)
    socket.receive({ op: Opcode.HEARTBEAT_ACK })
    await vi.waitFor(() => { expect(mounted.adapter.acked).toBe(true) })
    mounted.adapter.heartbeat()
    await vi.waitFor(() => { expect(mounted.adapter.acked).toBe(false) })
    expect(socket.sent.filter(payload => payload.op === Opcode.HEARTBEAT)).toHaveLength(2)
    expect(socket.closed).toBe(false)
  })

  it('treats a heartbeat without an ack as a zombie socket', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    socket.receive(ready())
    await vi.waitFor(() => { expect(mounted.adapter.seq).toBe(7) })
    mounted.adapter.heartbeat()
    // The heartbeat echoes the last sequence number in `d`, and no HEARTBEAT_ACK follows this time.
    expect(socket.sent.at(-1)).toEqual({ op: Opcode.HEARTBEAT, d: 7 })
    mounted.adapter.heartbeat()
    expect(socket.closed).toBe(true)
    expect(socket.closeCode).toBe(3000)
  })

  it('answers a heartbeat request from the platform', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    socket.receive({ op: Opcode.HEARTBEAT })
    await vi.waitFor(() => { expect(socket.sent.at(-1)).toEqual({ op: Opcode.HEARTBEAT, d: null }) })
    expect(mounted.adapter.acked).toBe(false)
  })
})

describe('QQ gateway reconnect', () => {
  it('resumes with the last sequence number when the server asks for a reconnect', async () => {
    const mounted = await mount()
    const first = await dial(mounted)
    first.receive(ready('session-1', 7))
    await vi.waitFor(() => { expect(mounted.bot.status).toBe(Status.ONLINE) })
    first.receive({ op: Opcode.RECONNECT })
    expect(first.closed).toBe(true)
    // A clean close keeps the session: the next socket resumes instead of identifying.
    expect(mounted.adapter.sessionId).toBe('session-1')
    const second = await dial(mounted, 1)
    expect(second).not.toBe(first)
    expect(second.sent[0]).toEqual({
      op: Opcode.RESUME,
      d: { token: 'QQBot access-token', session_id: 'session-1', seq: 7 },
    })
  })

  it('resumes after a transport failure with the newest sequence number', async () => {
    const mounted = await mount()
    const first = await dial(mounted)
    first.receive(ready('session-9', 3))
    await vi.waitFor(() => { expect(mounted.adapter.sessionId).toBe('session-9') })
    vi.spyOn(mounted.bot, 'decodeDispatch').mockResolvedValue([])
    first.receive({ op: Opcode.DISPATCH, s: 11, t: 'GROUP_AT_MESSAGE_CREATE', d: {} })
    await vi.waitFor(() => { expect(mounted.adapter.seq).toBe(11) })
    // A socket closed by the network (1006) is not an invalid session, so the sequence survives.
    first.drop(1006)
    const second = await dial(mounted, 1)
    expect(second.sent[0]).toMatchObject({ op: Opcode.RESUME, d: { session_id: 'session-9', seq: 11 } })
  })

  it('identifies again after an invalid session', async () => {
    const mounted = await mount()
    const first = await dial(mounted)
    first.receive(ready('session-1', 7))
    await vi.waitFor(() => { expect(mounted.adapter.sessionId).toBe('session-1') })
    first.receive({ op: Opcode.INVALID_SESSION })
    expect(first.closed).toBe(true)
    expect(mounted.adapter.sessionId).toBe('')
    expect(mounted.adapter.seq).toBeUndefined()
    const second = await dial(mounted, 1)
    expect(second.sent[0]).toMatchObject({ op: Opcode.IDENTIFY })
  })

  it('drops the session and re-identifies after a non-resumable close code such as 4007', async () => {
    const mounted = await mount()
    const first = await dial(mounted)
    first.receive(ready('session-4007', 7))
    await vi.waitFor(() => { expect(mounted.adapter.sessionId).toBe('session-4007') })
    first.close(4007)
    expect(mounted.adapter.sessionId).toBe('')
    expect(mounted.adapter.seq).toBeUndefined()
    const second = await dial(mounted, 1)
    expect(second.sent[0]).toMatchObject({ op: Opcode.IDENTIFY })
  })

  it('survives a frame the decoder cannot handle', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    vi.spyOn(mounted.bot, 'decodeDispatch').mockRejectedValue(new Error('decode failed'))
    socket.receive({ op: Opcode.DISPATCH, s: 1, t: 'GROUP_AT_MESSAGE_CREATE', d: {} })
    socket.receive('{"op":')
    await vi.waitFor(() => { expect(mounted.adapter.seq).toBe(1) })
    // The platform cannot re-request a dispatch, so a decode/intake failure is reported and the socket stays up.
    expect(socket.closed).toBe(false)
    expect(mounted.requests.filter(path => path.endsWith('/gateway'))).toHaveLength(1)
  })

  it('does not advance seq and reconnects to resume from the last persisted seq when bot.receive fails', async () => {
    const mounted = await mount()
    const first = await dial(mounted)
    first.receive(ready('session-persist', 7))
    await vi.waitFor(() => { expect(mounted.adapter.seq).toBe(7) })
    vi.spyOn(mounted.bot, 'decodeDispatch').mockImplementation(async frame => [{ id: `msg-${frame.s}` } as never])
    const receiveSpy = vi.spyOn(mounted.bot, 'receive').mockRejectedValueOnce(new Error('disk full'))
    first.receive({ op: Opcode.DISPATCH, s: 8, t: 'GROUP_AT_MESSAGE_CREATE', d: {} })
    first.receive({ op: Opcode.DISPATCH, s: 9, t: 'GROUP_AT_MESSAGE_CREATE', d: {} })
    await vi.waitFor(() => { expect(first.closed).toBe(true) })
    expect(receiveSpy).toHaveBeenCalledTimes(1)
    expect(mounted.adapter.seq).toBe(7)
    const second = await dial(mounted, 1)
    expect(second.sent[0]).toMatchObject({ op: Opcode.RESUME, d: { session_id: 'session-persist', seq: 7 } })
  })
})

describe('QQ gateway transport switch', () => {
  it('installs no gateway client when the transport is none', async () => {
    const mounted = await mount({ transport: 'none' })
    expect(mounted.bot.adapter).toBeUndefined()
    expect(mounted.bot.status).toBe(Status.ONLINE)
    expect(mounted.sockets).toHaveLength(0)
    expect(mounted.requests).toEqual([])
  })

  it('closes the socket with the context', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    await mounted.ctx.fiber.dispose()
    contexts.length = 0
    expect(socket.closed).toBe(true)
  })
})
