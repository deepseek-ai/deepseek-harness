/**
 * The Lark long connection: the gateway handshake, protobuf frames and fragment reassembly, the ACK rules for events,
 * and `card.action.trigger` → `interaction/button` with its single answer (a `respond()` toast, else `{}`).
 *
 * Every socket is a local stand-in delivered through the `http/websocket` hook and every request goes through the
 * `http/fetch` hook, so nothing leaves the process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import { Satori, Status, type WebSocket } from '@deepseek-ai/cordis-plugin-im-core'
import LarkBot, {
  Config,
  cardActionSession,
  FrameType,
  isAdmittedEvent,
  MessageType,
  parseEventEnvelope,
  WsClient,
  type LarkConfig,
} from '@deepseek-ai/cordis-plugin-im-adapter-lark'

/** One protobuf frame as the platform sends it. */
interface RawFrame {
  method: number
  service: number
  SeqID: number
  LogID: number
  headers: { key: string; value: string }[]
  payload?: Uint8Array
}

/** Minimal stand-in for the platform socket: it records what the adapter sends and replays what the tests feed it. */
class Socket extends EventTarget {
  url = 'wss://open.feishu.cn/callback/ws'
  protocol = ''
  readyState = 1
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer'
  /** Encoded frames the adapter sent, newest last. */
  sent: ArrayBuffer[] = []
  closed = false
  closeCode: number | undefined

  send(data: unknown) {
    if (!(data instanceof Uint8Array)) throw new TypeError('the adapter must send protobuf bytes')
    this.sent.push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
  }

  close(code = 1000, reason = '') {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException(`Invalid close code: ${code}`, 'InvalidAccessError')
    }
    if (this.closed) return
    this.closed = true
    this.closeCode = code
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }))
  }

  /** The transport is open; the adapter starts the protocol as soon as it is. */
  open() {
    this.dispatchEvent(new Event('open'))
  }

  /** Deliver one encoded frame to the adapter. */
  receive(data: ArrayBuffer) {
    this.dispatchEvent(Object.assign(new Event('message'), { data }))
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

/** Answer the routes the handshake and the card-callback chat probe need. */
function router(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const requests: string[] = []
  const handler = async (url: URL): Promise<Response> => {
    requests.push(url.pathname)
    const override = overrides[url.pathname]
    if (override) return await override()
    if (url.pathname.endsWith('/callback/ws/endpoint')) {
      return Response.json({
        code: 0,
        data: {
          URL: 'wss://open.feishu.cn/callback/ws/open?service_id=7&device_id=dev',
          ClientConfig: { PingInterval: 120 },
        },
      })
    }
    if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't-token', expire: 7200 })
    }
    if (url.pathname.endsWith('/bot/v3/info')) {
      return Response.json({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Lark Bot', avatar_url: 'https://a/1.png' } })
    }
    if (url.pathname.startsWith('/open-apis/im/v1/chats/')) {
      return Response.json({ code: 0, data: { chat_mode: 'group', chat_id: 'oc_chat' } })
    }
    throw new Error(`Unexpected request: ${url.pathname}`)
  }
  return { requests, handler }
}

async function mount(input: Record<string, unknown> = {}, overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  const sockets: Socket[] = []
  const routes = router(overrides)
  // The plugin's hook types speak undici's `WebSocket`; this fake implements the surface the protocol touches.
  ctx.on('http/websocket', (() => {
    const socket = new Socket()
    sockets.push(socket)
    return socket as unknown as WebSocket
  }) as never)
  ctx.on('http/fetch', async (url: URL) => await routes.handler(url))
  const config: LarkConfig = Config({ appId: 'cli_lark', appSecret: 'secret', ...input } as LarkConfig)
  await ctx.plugin(LarkBot, config)
  const bot = ctx.bots[0] as LarkBot
  return {
    ctx,
    bot,
    config,
    sockets,
    requests: routes.requests,
    get adapter() {
      return bot.adapter as WsClient
    },
  }
}

type Mounted = Awaited<ReturnType<typeof mount>>

/** Wait for the socket to be owned, open it, and wait for the adapter's first ping. */
async function dial(mounted: Mounted) {
  await vi.waitFor(() => { expect(mounted.bot.adapter).toBeInstanceOf(WsClient) })
  await vi.waitFor(() => { expect(mounted.sockets.length).toBeGreaterThan(0) })
  const socket = mounted.sockets[0]!
  await vi.waitFor(() => { expect(Reflect.get(mounted.adapter, 'socket')).toBe(socket) })
  socket.open()
  await vi.waitFor(() => { expect(socket.sent.length).toBeGreaterThanOrEqual(1) })
  return socket
}

/** Decode everything the adapter sent. */
function sentFrames(mounted: Mounted, socket: Socket): RawFrame[] {
  return socket.sent.map(frame => mounted.adapter._frame.decode(new Uint8Array(frame)) as unknown as RawFrame)
}

/** The data frames (i.e. acknowledgements), in order. */
function acks(mounted: Mounted, socket: Socket) {
  return sentFrames(mounted, socket).filter(frame => frame.method === FrameType.data)
}

/** Encode one frame the way the platform does. */
function encode(mounted: Mounted, frame: RawFrame): ArrayBuffer {
  const bytes = mounted.adapter._frame.encode(frame).finish()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** One event delivery of `body`, optionally fragmented. */
function eventFrame(
  mounted: Mounted,
  body: unknown,
  { messageId = 'frame-1', sum = 1, seq = 0, payload }: { messageId?: string; sum?: number; seq?: number; payload?: Uint8Array } = {},
): ArrayBuffer {
  return encode(mounted, {
    method: FrameType.data,
    service: 7,
    SeqID: 1,
    LogID: 0,
    headers: [
      { key: 'type', value: MessageType.event },
      { key: 'message_id', value: messageId },
      { key: 'sum', value: String(sum) },
      { key: 'seq', value: String(seq) },
    ],
    payload: payload ?? new TextEncoder().encode(JSON.stringify(body)),
  })
}

/** A schema-2.0 event envelope of one family. */
function envelope(type: string, event: unknown, appId = 'cli_lark') {
  return {
    schema: '2.0',
    header: {
      event_type: type,
      event_id: 'ev_1',
      app_id: appId,
      create_time: '2026-10-25T02:00:00Z',
      tenant_key: 'tk',
      token: '',
    },
    event,
  }
}

/** The JSON body of one acknowledgement. */
function ackBody(frame: RawFrame) {
  return JSON.parse(Buffer.from(frame.payload ?? new Uint8Array()).toString('utf8'))
}

/** The transport envelope and base64-decoded JSON business body of one card callback answer. */
function cardAckBody(frame: RawFrame): { code: unknown; data: unknown } {
  const envelope = ackBody(frame) as Record<string, unknown>
  expect(envelope.code).toBe(200)
  expect(typeof envelope.data).toBe('string')
  return { code: envelope.code, data: JSON.parse(Buffer.from(envelope.data as string, 'base64').toString('utf8')) }
}

/** One header of a decoded frame. */
function headerOf(frame: RawFrame, key: string) {
  return frame.headers.find(header => header.key === key)?.value
}

describe('Lark gateway handshake', () => {
  it('opens the socket the endpoint announced and starts heartbeating', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    expect(mounted.requests).toContain('/callback/ws/endpoint')
    expect(mounted.adapter._serviceId).toBe(7)
    expect(mounted.adapter._pingInterval).toBe(120_000)
    const frames = sentFrames(mounted, socket)
    expect(frames[0]!).toMatchObject({ method: FrameType.control, service: 7 })
    expect(headerOf(frames[0]!, 'type')).toBe(MessageType.ping)
    // The handshake learns the bot identity before the first event.
    expect(mounted.bot.status).toBe(Status.ONLINE)
    expect(mounted.bot.selfId).toBe('ou_bot')
    expect(mounted.bot.user).toEqual({ id: 'ou_bot', name: 'Lark Bot', avatar: 'https://a/1.png', isBot: true })
    await mounted.bot.disconnect()
  })

  it('rejects a gateway answer that carries no usable configuration', async () => {
    const mounted = await mount({ ws: { retryTimes: 0 } }, {
      '/callback/ws/endpoint': () => Response.json({ code: 0, data: { URL: 'wss://x/y', ClientConfig: {} } }),
    })
    await vi.waitFor(() => { expect(mounted.bot.status).toBe(Status.OFFLINE) })
    expect((mounted.bot.error as Error).message).toMatch(/Invalid Lark gateway configuration/)
  })

  it('answers a gateway ping with a pong', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    socket.receive(encode(mounted, {
      method: FrameType.control,
      service: 7,
      SeqID: 0,
      LogID: 0,
      headers: [{ key: 'type', value: MessageType.ping }],
    }))
    await vi.waitFor(() => {
      expect(sentFrames(mounted, socket).at(-1)?.['headers']).toEqual([{ key: 'type', value: MessageType.pong }])
    })
    await mounted.bot.disconnect()
  })
})

describe('Lark event acknowledgement', () => {
  it('acknowledges a message event only after intake accepted it', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    const gate = Promise.withResolvers<void>()
    const received: string[] = []
    vi.spyOn(mounted.bot, 'decodeEvent').mockResolvedValue([
      mounted.bot.session({ type: 'message', id: 'ev_1' }),
    ])
    mounted.ctx.on('satori/receive', async (session) => {
      received.push(String(session.event.id))
      await gate.promise
    })
    socket.receive(eventFrame(mounted, envelope('im.message.receive_v1', {})))
    await vi.waitFor(() => { expect(received).toEqual(['ev_1']) })
    // The store has not accepted the event yet, so no success ACK may be sent.
    expect(acks(mounted, socket)).toHaveLength(0)
    gate.resolve()
    await vi.waitFor(() => { expect(acks(mounted, socket)).toHaveLength(1) })
    const ack = acks(mounted, socket)[0]!
    expect(ackBody(ack)).toEqual({ code: 200 })
    expect(headerOf(ack, 'biz_rt')).toBe('0')
    expect(headerOf(ack, 'message_id')).toBe('frame-1')
    await mounted.bot.disconnect()
  })

  it('withholds the ACK when intake fails, so the platform redelivers', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    const decode = vi.spyOn(mounted.bot, 'decodeEvent').mockRejectedValue(new Error('decode failed'))
    socket.receive(eventFrame(mounted, envelope('im.message.receive_v1', {})))
    await vi.waitFor(() => { expect(decode).toHaveBeenCalled() })
    await mounted.bot.disconnect()
    expect(acks(mounted, socket)).toHaveLength(0)
    expect(socket.closed).toBe(true)
  })

  it('acknowledges an unselected family without admitting it', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    const decode = vi.spyOn(mounted.bot, 'decodeEvent')
    socket.receive(eventFrame(mounted, envelope('application.bot.menu_v6', { event_key: 'command:x' })))
    await vi.waitFor(() => { expect(acks(mounted, socket)).toHaveLength(1) })
    expect(ackBody(acks(mounted, socket)[0]!)).toEqual({ code: 200 })
    expect(decode).not.toHaveBeenCalled()
    await mounted.bot.disconnect()
  })

  it('rejects an event of another application', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    socket.receive(eventFrame(mounted, envelope('im.message.receive_v1', {}, 'cli_other')))
    await mounted.bot.disconnect()
    expect(acks(mounted, socket)).toHaveLength(0)
  })

  it('ignores frames that are not event data', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    socket.receive(encode(mounted, {
      method: FrameType.data,
      service: 7,
      SeqID: 0,
      LogID: 0,
      headers: [{ key: 'type', value: MessageType.card }],
      payload: new TextEncoder().encode('{}'),
    }))
    socket.receive('not a frame' as unknown as ArrayBuffer)
    await mounted.bot.disconnect()
    expect(acks(mounted, socket)).toHaveLength(0)
  })
})

describe('Lark frame fragments', () => {
  it('reassembles a fragmented event before acknowledging it', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    const decode = vi.spyOn(mounted.bot, 'decodeEvent').mockResolvedValue([])
    const bytes = new TextEncoder().encode(JSON.stringify(envelope('im.message.receive_v1', { message: { message_id: 'om_1' } })))
    const half = Math.ceil(bytes.length / 2)
    socket.receive(eventFrame(mounted, null, { payload: bytes.slice(0, half), sum: 2, seq: 0, messageId: 'split-1' }))
    await vi.waitFor(() => { expect(sentFrames(mounted, socket).length).toBeGreaterThanOrEqual(1) })
    // One fragment is not a message: nothing is decoded and nothing is acknowledged yet.
    expect(decode).not.toHaveBeenCalled()
    expect(acks(mounted, socket)).toHaveLength(0)
    socket.receive(eventFrame(mounted, null, { payload: bytes.slice(half), sum: 2, seq: 1, messageId: 'split-1' }))
    await vi.waitFor(() => { expect(decode).toHaveBeenCalledTimes(1) })
    expect(acks(mounted, socket)).toHaveLength(1)
    await mounted.bot.disconnect()
  })

  it('bounds fragments, tolerates duplicate bytes and rejects conflicting ones', async () => {
    const mounted = await mount()
    await vi.waitFor(() => { expect(mounted.bot.adapter).toBeInstanceOf(WsClient) })
    const adapter = mounted.adapter
    const bytes = new Uint8Array([1, 2])
    // An impossible fragment count, sequence and oversized fragment are refused before any bookkeeping.
    expect(() => adapter.retrieve({ message_id: 'a', sum: 0, seq: 0, data: bytes })).toThrow(/Invalid Lark frame fragment/)
    expect(() => adapter.retrieve({ message_id: 'a', sum: 1000, seq: 0, data: bytes })).toThrow(/Invalid Lark frame fragment/)
    expect(() => adapter.retrieve({ message_id: 'a', sum: 2, seq: 2, data: bytes })).toThrow(/Invalid Lark frame fragment/)
    // A duplicate fragment is not an error and does not count twice.
    expect(adapter.retrieve({ message_id: 'b', sum: 2, seq: 0, data: bytes })).toBeUndefined()
    expect(adapter.retrieve({ message_id: 'b', sum: 2, seq: 0, data: bytes })).toBeUndefined()
    expect(adapter.retrieve({ message_id: 'b', sum: 2, seq: 1, data: new Uint8Array([3]) }))
      .toEqual(Buffer.from([1, 2, 3]))
    // A changed fragment count, or different bytes for an already seen sequence, drops the whole message.
    adapter.retrieve({ message_id: 'c', sum: 2, seq: 0, data: bytes })
    expect(() => adapter.retrieve({ message_id: 'c', sum: 3, seq: 1, data: bytes })).toThrow(/Conflicting Lark fragments/)
    adapter.retrieve({ message_id: 'd', sum: 2, seq: 0, data: bytes })
    expect(() => adapter.retrieve({ message_id: 'd', sum: 2, seq: 0, data: new Uint8Array([9]) })).toThrow(/Conflicting Lark fragments/)
    await mounted.bot.disconnect()
  })

  it('refuses a fragment cache beyond the configured entry limit', async () => {
    const mounted = await mount({ ws: { maxPendingFrames: 1 } })
    await vi.waitFor(() => { expect(mounted.bot.adapter).toBeInstanceOf(WsClient) })
    const adapter = mounted.adapter
    expect(adapter.retrieve({ message_id: 'a', sum: 2, seq: 0, data: new Uint8Array([1]) })).toBeUndefined()
    expect(() => adapter.retrieve({ message_id: 'b', sum: 2, seq: 0, data: new Uint8Array([1]) })).toThrow(/cache is full/)
    await mounted.bot.disconnect()
  })

  it('refuses a frame beyond the configured byte limit', async () => {
    const mounted = await mount({ ws: { maxFrameBytes: 64 } })
    const socket = await dial(mounted)
    const decode = vi.spyOn(mounted.bot, 'decodeEvent')
    socket.receive(eventFrame(mounted, envelope('im.message.receive_v1', { message: { message_id: 'om_1' } })))
    await mounted.bot.disconnect()
    expect(decode).not.toHaveBeenCalled()
    expect(acks(mounted, socket)).toHaveLength(0)
  })
})

describe('Lark card callbacks', () => {
  const cardAction = envelope('card.action.trigger', {
    operator: { open_id: 'ou_user', tenant_key: 'tk' },
    action: { tag: 'button', value: { v4: { id: 'btn-1', data: 'payload-1' } }, name: 'approve' },
    context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
  })

  it('answers {} by the deadline when the click has not been admitted yet', async () => {
    const gate = Promise.withResolvers<Response>()
    const mounted = await mount({ callbackAnswerMs: 20 }, { '/open-apis/im/v1/chats/oc_chat': () => gate.promise })
    const socket = await dial(mounted)
    const received = vi.fn()
    mounted.ctx.on('satori/receive', received)
    socket.receive(eventFrame(mounted, cardAction))
    // The platform gives a card callback 3 seconds, so the empty answer must not wait for the chat probe/intake.
    await vi.waitFor(() => { expect(acks(mounted, socket)).toHaveLength(1) })
    expect(cardAckBody(acks(mounted, socket)[0]!)).toEqual({ code: 200, data: {} })
    expect(headerOf(acks(mounted, socket)[0]!, 'biz_rt')).toBe('0')
    expect(received).not.toHaveBeenCalled()
    gate.resolve(Response.json({ code: 0, data: { chat_mode: 'group' } }))
    await vi.waitFor(() => { expect(received).toHaveBeenCalledTimes(1) })
    const session = received.mock.calls[0]![0]
    expect(session.type).toBe('interaction/button')
    expect(session.event.id).toBe('ev_1')
    expect(session.button).toMatchObject({
      id: 'btn-1',
      data: 'payload-1',
      user: { id: 'ou_user' },
      chat: { id: 'oc_chat', type: 'group' },
      message: { id: 'om_card', chat: { id: 'oc_chat', type: 'group' } },
    })
    expect(session.button.referrer).toMatchObject({
      event_id: 'ev_1',
      chatId: 'oc_chat',
      chatType: 'group',
      messageId: 'om_card',
    })
    expect(session.button.bot.id).toBe('lark:cli_lark')
    // The deadline already answered: a late respond() sends nothing more.
    await session.button.respond({ toast: { type: 'info', content: 'late' } })
    expect(acks(mounted, socket)).toHaveLength(1)
    await mounted.bot.disconnect()
  })

  it('answers with the toast a listener passes to respond(), before the listener continues', async () => {
    const mounted = await mount({ callbackAnswerMs: 2_000 })
    const socket = await dial(mounted)
    const gate = Promise.withResolvers<void>()
    const seen: number[] = []
    mounted.ctx.on('satori/receive', async (session) => {
      await session.button!.respond!({ toast: { type: 'success', content: '已确认' } })
      // respond() resolves only after the answer frame was written, so an edit of the card may follow.
      seen.push(acks(mounted, socket).length)
      await session.button!.respond!({ toast: { type: 'error', content: 'second' } })
      await gate.promise
    })
    socket.receive(eventFrame(mounted, cardAction))
    await vi.waitFor(() => { expect(seen).toEqual([1]) })
    expect(cardAckBody(acks(mounted, socket)[0]!)).toEqual({ code: 200, data: { toast: { type: 'success', content: '已确认' } } })
    gate.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(acks(mounted, socket)).toHaveLength(1)
    await mounted.bot.disconnect()
  })

  it('answers {} as soon as intake settles without a respond() call', async () => {
    const mounted = await mount({ callbackAnswerMs: 2_000 })
    const socket = await dial(mounted)
    const received = vi.fn()
    mounted.ctx.on('satori/receive', received)
    const start = Date.now()
    socket.receive(eventFrame(mounted, cardAction))
    await vi.waitFor(() => { expect(acks(mounted, socket)).toHaveLength(1) })
    expect(Date.now() - start).toBeLessThan(1_000)
    expect(received).toHaveBeenCalledTimes(1)
    expect(cardAckBody(acks(mounted, socket)[0]!)).toEqual({ code: 200, data: {} })
    await mounted.bot.disconnect()
  })

  it('answers {} once and logs when intake fails', async () => {
    const mounted = await mount({ callbackAnswerMs: 2_000 })
    const socket = await dial(mounted)
    const error = vi.spyOn(mounted.ctx.logger, 'error')
    mounted.ctx.on('satori/receive', async () => { throw new Error('store down') })
    socket.receive(eventFrame(mounted, cardAction))
    await vi.waitFor(() => { expect(acks(mounted, socket)).toHaveLength(1) })
    expect(cardAckBody(acks(mounted, socket)[0]!)).toEqual({ code: 200, data: {} })
    await vi.waitFor(() => { expect(error).toHaveBeenCalled() })
    expect(acks(mounted, socket)).toHaveLength(1)
    await mounted.bot.disconnect()
  })

  it('does not admit a click when callbacks are off, but still answers the frame', async () => {
    const mounted = await mount({ callbacks: false })
    const socket = await dial(mounted)
    const received = vi.fn()
    mounted.ctx.on('satori/receive', received)
    socket.receive(eventFrame(mounted, cardAction))
    await vi.waitFor(() => { expect(acks(mounted, socket)).toHaveLength(1) })
    expect(ackBody(acks(mounted, socket)[0]!)).toEqual({ code: 200 })
    expect(received).not.toHaveBeenCalled()
    await mounted.bot.disconnect()
  })

  it('keeps the click even when the chat probe fails', async () => {
    const mounted = await mount({}, {
      '/open-apis/im/v1/chats/oc_chat': () => new Response('boom', { status: 500 }),
    })
    const socket = await dial(mounted)
    const received = vi.fn()
    mounted.ctx.on('satori/receive', received)
    socket.receive(eventFrame(mounted, cardAction))
    await vi.waitFor(() => { expect(received).toHaveBeenCalledTimes(1) })
    expect(received.mock.calls[0]![0].button.chat.type).toBe('group')
    await mounted.bot.disconnect()
  })

  it('ignores a callback that carries no v4 button value', async () => {
    const mounted = await mount()
    const socket = await dial(mounted)
    const received = vi.fn()
    mounted.ctx.on('satori/receive', received)
    socket.receive(eventFrame(mounted, envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: { tag: 'button', value: { _satori_type: 'callback', content: 'x' } },
      context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
    })))
    await vi.waitFor(() => { expect(acks(mounted, socket)).toHaveLength(1) })
    expect(received).not.toHaveBeenCalled()
    await mounted.bot.disconnect()
  })
})

describe('Lark event envelope', () => {
  it('accepts only schema 2.0 envelopes with a header', () => {
    expect(() => parseEventEnvelope({ schema: '1.0', header: {} })).toThrow(TypeError)
    expect(() => parseEventEnvelope({ schema: '2.0' })).toThrow(/event header/)
    expect(() => parseEventEnvelope({ schema: '2.0', header: { event_type: 'x', event_id: 'y' } })).toThrow(/application ID/)
    const raw = parseEventEnvelope({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', event_id: 'ev', app_id: 'cli_lark', create_time: '2026-10-25T10:00:00Z' },
      event: { message: { message_id: 'om_1' } },
    })
    expect(raw.header).toMatchObject({ event_type: 'im.message.receive_v1', event_id: 'ev', app_id: 'cli_lark' })
    expect(raw.header.create_time).toBe('2026-10-25T10:00:00Z')
    expect(raw.event).toEqual({ message: { message_id: 'om_1' } })
    // A body the envelope does not model is still an admitted envelope shape.
    expect(parseEventEnvelope({ schema: '2.0', header: { event_type: 'x', event_id: 'y', app_id: 'z' } }).event).toEqual({})
  })

  it('admits the supported event families', () => {
    expect(isAdmittedEvent('im.message.receive_v1', false)).toBe(true)
    expect(isAdmittedEvent('im.message.recalled_v1', false)).toBe(true)
    expect(isAdmittedEvent('im.message.reaction.created_v1', false)).toBe(true)
    expect(isAdmittedEvent('im.message.reaction.deleted_v1', false)).toBe(true)
    expect(isAdmittedEvent('card.action.trigger', true)).toBe(true)
    expect(isAdmittedEvent('card.action.trigger', false)).toBe(false)
    expect(isAdmittedEvent('application.bot.menu_v6', true)).toBe(false)
  })
})

describe('cardActionSession', () => {
  it('serializes object data and omits an absent message', async () => {
    const mounted = await mount()
    await vi.waitFor(() => { expect(mounted.bot.adapter).toBeInstanceOf(WsClient) })
    const session = await cardActionSession(mounted.bot, parseEventEnvelope(envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: { tag: 'button', value: { v4: { id: 'btn-2', data: { answer: 'yes' } } } },
      context: { open_chat_id: 'oc_chat' },
    })), undefined, 1_700_000_000_000)
    expect(session?.button).toMatchObject({ id: 'btn-2', data: '{"answer":"yes"}', time: Date.parse('2026-10-25T02:00:00Z') })
    expect(session?.button?.message).toBeUndefined()
    expect(session?.button?.chat).toEqual({ id: 'oc_chat', type: 'group' })
    await mounted.bot.disconnect()
  })

  it('returns nothing for a value it cannot route', async () => {
    const mounted = await mount()
    await vi.waitFor(() => { expect(mounted.bot.adapter).toBeInstanceOf(WsClient) })
    const noValue = await cardActionSession(mounted.bot, parseEventEnvelope(envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: { value: {} },
      context: { open_chat_id: 'oc_chat' },
    })))
    expect(noValue).toBeUndefined()
    const noChat = await cardActionSession(mounted.bot, parseEventEnvelope(envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: { value: { v4: { id: 'btn-3' } } },
      context: {},
    })))
    expect(noChat).toBeUndefined()
    await mounted.bot.disconnect()
  })

  it('decodes a select pick as an interaction/select session', async () => {
    const mounted = await mount()
    await vi.waitFor(() => { expect(mounted.bot.adapter).toBeInstanceOf(WsClient) })
    const single = await cardActionSession(mounted.bot, parseEventEnvelope(envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: { tag: 'select_static', value: { v4: { id: 'sel-size', data: 'step-2' } }, option: 'l' },
      context: { open_chat_id: 'oc_chat', open_message_id: 'om_card' },
    })), undefined, 1_700_000_000_000)
    expect(single?.type).toBe('interaction/select')
    expect(single?.button).toBeUndefined()
    expect(single?.select).toMatchObject({
      id: 'sel-size',
      values: ['l'],
      data: 'step-2',
      user: { id: 'ou_user' },
      chat: { id: 'oc_chat', type: 'group' },
      message: { id: 'om_card' },
    })
    const multiple = await cardActionSession(mounted.bot, parseEventEnvelope(envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: { tag: 'multi_select_static', value: { v4: { id: 'sel-tags' } }, options: ['a', 'b'] },
      context: { open_chat_id: 'oc_chat' },
    })))
    expect(multiple?.select?.values).toEqual(['a', 'b'])
    // A pick the platform reports without a value carries an empty selection instead of failing.
    const empty = await cardActionSession(mounted.bot, parseEventEnvelope(envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: { tag: 'select_static', value: { v4: { id: 'sel-size' } } },
      context: { open_chat_id: 'oc_chat' },
    })))
    expect(empty?.select?.values).toEqual([])
    await mounted.bot.disconnect()
  })

  it('decodes a checkbox toggle as an interaction/check session', async () => {
    const mounted = await mount()
    await vi.waitFor(() => { expect(mounted.bot.adapter).toBeInstanceOf(WsClient) })
    const on = await cardActionSession(mounted.bot, parseEventEnvelope(envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: { tag: 'checker', value: { v4: { id: 'chk-1' } }, checked: true },
      context: { open_chat_id: 'oc_chat', open_message_id: 'om_card' },
    })))
    expect(on?.type).toBe('interaction/check')
    expect(on?.check).toMatchObject({
      id: 'chk-1',
      checked: true,
      user: { id: 'ou_user' },
      chat: { id: 'oc_chat', type: 'group' },
      message: { id: 'om_card' },
    })
    const off = await cardActionSession(mounted.bot, parseEventEnvelope(envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: { tag: 'checker', value: { v4: { id: 'chk-1' } }, checked: false },
      context: { open_chat_id: 'oc_chat' },
    })))
    expect(off?.check?.checked).toBe(false)
    await mounted.bot.disconnect()
  })

  it('carries the submitted form values on the button event of a submit', async () => {
    const mounted = await mount()
    await vi.waitFor(() => { expect(mounted.bot.adapter).toBeInstanceOf(WsClient) })
    const session = await cardActionSession(mounted.bot, parseEventEnvelope(envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: {
        tag: 'button',
        value: { v4: { id: 'btn-submit' } },
        form_value: { title: 'Weekly report', agree: true, tags: ['a', 'b'], count: 3 },
      },
      context: { open_chat_id: 'oc_chat' },
    })))
    expect(session?.type).toBe('interaction/button')
    expect(session?.button?.values).toEqual({ title: 'Weekly report', agree: true, tags: ['a', 'b'], count: '3' })
    // A click that submitted nothing has no `values` at all.
    const plain = await cardActionSession(mounted.bot, parseEventEnvelope(envelope('card.action.trigger', {
      operator: { open_id: 'ou_user' },
      action: { tag: 'button', value: { v4: { id: 'btn-1' } } },
      context: { open_chat_id: 'oc_chat' },
    })))
    expect(plain?.button?.values).toBeUndefined()
    await mounted.bot.disconnect()
  })
})
