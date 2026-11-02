/**
 * Intake, dedupe and the `im/message` dispatch loop: admission by `sources`, redelivery idempotency, per-chat dispatch
 * order, outcome recording, own-outbound storage and restart re-dispatch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import type { Bot, InboundMessage } from '@deepseek-ai/cordis-plugin-im-core'
import { createTextMode, mountFakeAdapter, type FakeAdapter } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import {
  ImChatKey, ImMessageKey, ImSourceId, type ImConfig, type ImMessage, type ImSourceConfig,
} from '../src/api.ts'
import { Config } from '../src/config.ts'
import { admit, draftOf, ImIntake, parseCommand } from '../src/intake.ts'
import { ImStore } from '../src/store.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

interface Harness {
  ctx: Context
  bot: FakeAdapter
  store: ImStore
  intake: ImIntake
  /** Messages the pump built a waterfall event for, in dispatch order. */
  dispatched: ImMessage[]
  pool: MemoryMediaPool
}

/** A FakeAdapter bot plus a real store over an in-memory storage domain, wired like `ImService[Service.init]`. */
async function boot(options: { config?: Partial<ImConfig>; pool?: MemoryMediaPool } = {}): Promise<Harness> {
  const pool = options.pool ?? new MemoryMediaPool()
  const { ctx, bot } = await mountFakeAdapter({ modes: { text: createTextMode() }, selfId: 'bot-user' })
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const config = Config({ sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all' }], ...options.config })
  const store = new ImStore(ctx, config)
  await store.start()
  const dispatched: ImMessage[] = []
  const intake = new ImIntake(ctx, config, store, {
    event: (message, source) => {
      dispatched.push(message)
      // The pump only hands the event to the waterfall; this harness publishes nothing through it.
      return {
        message,
        source,
        bot,
        reply: async () => { throw new Error('intake harness: no reply') },
        send: async () => { throw new Error('intake harness: no send') },
        deliver: async () => { throw new Error('intake harness: no delivery') },
      }
    },
  })
  ctx.on('satori/receive', session => intake.receive(session))
  return { ctx, bot, store, intake, dispatched, pool }
}

function inbound(patch: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'm1',
    chat: { id: 'chat', type: 'group' },
    sender: { id: 'user-1', name: 'User' },
    content: h('message', h.text('hello')),
    mentions: { self: false, all: false, users: [] },
    time: 1000,
    referrer: undefined,
    raw: null,
    ...patch,
  }
}

/** Deliver one platform event the way an adapter does: `bot.receive` awaits intake before ACKing. */
function deliver(bot: FakeAdapter, eventId: string, message: InboundMessage): Promise<void> {
  return bot.receive(bot.session({ type: 'message', id: eventId, timestamp: 1000, message }))
}

const CHAT = ImChatKey('fake:bot', 'chat')

describe('ImIntake admission', () => {
  it('stores an admitted message and dispatches it once through im/message', async () => {
    const { ctx, bot, store, intake, dispatched } = await boot()
    const stored: ImMessage[] = []
    ctx.on('im/stored', (message) => { stored.push(message) })

    await deliver(bot, 'evt-1', inbound())
    await intake.idle()

    expect(dispatched).toHaveLength(1)
    const message = dispatched[0]!
    expect(message.key).toBe(ImMessageKey('fake:bot', 'm1'))
    expect(message.seq).toBe(1)
    expect(message.chat.key).toBe(CHAT)
    expect(message.chat.source).toBe('team')
    expect(message.chat.ref.type).toBe('group')
    expect(message.text).toBe('hello')
    expect(message.via).toBe('platform')
    expect(message.sender).toEqual({ id: 'user-1', name: 'User', self: false })
    expect(message.addressed).toBe(false)
    expect(stored.map(entry => entry.key)).toEqual([message.key])
    expect(store.chat(CHAT)?.ref.id).toBe('chat')
    expect(store.state(message.key)?.dispatch).toBe('done')
    expect(store.state(message.key)?.outcome).toEqual({ kind: 'ignored' })
  })

  it('stores the adapter referrer so a later reply can answer passively', async () => {
    const { bot, store, intake, dispatched } = await boot()
    const referrer = { msg_id: 'ROBOT.1.abc', event_id: 'evt-1', receivedAt: 1000, chatType: 'group', chatId: 'chat' }
    await deliver(bot, 'evt-1', inbound({ referrer }))
    await intake.idle()
    expect(dispatched[0]!.referrer).toEqual(referrer)
    expect(store.get(ImMessageKey('fake:bot', 'm1'))?.referrer).toEqual(referrer)
  })

  it('treats a redelivery of the same event as a no-op', async () => {
    const { bot, store, intake, dispatched } = await boot()
    await deliver(bot, 'evt-1', inbound())
    await deliver(bot, 'evt-1', inbound())
    await intake.idle()
    expect(dispatched).toHaveLength(1)
    expect(store.after(CHAT, 0, 10)).toHaveLength(1)
    // A rebuilt payload with the same fields in another order is the same delivery, not a conflict.
    const reordered = Object.fromEntries(Object.entries(inbound()).reverse()) as InboundMessage
    await deliver(bot, 'evt-1', reordered)
    await intake.idle()
    expect(store.after(CHAT, 0, 10)).toHaveLength(1)
  })

  it('acknowledges a changed payload under a delivered event id instead of failing the frame', async () => {
    const { bot, store, intake } = await boot()
    await deliver(bot, 'evt-1', inbound())
    await intake.idle()
    // The platform hands the same message back with a drifted payload; refusing it would leave the frame
    // unacknowledged, and the platform would redeliver it forever.
    await deliver(bot, 'evt-1', inbound({ content: h('message', h.text('changed')) }))
    await intake.idle()
    expect(store.after(CHAT, 0, 10)).toHaveLength(1)
    await deliver(bot, 'evt-2', inbound({ id: 'm2' }))
    await intake.idle()
    expect(store.after(CHAT, 0, 10)).toHaveLength(2)
  })

  it('reads a card the platform would only describe with a placeholder', async () => {
    const { bot, store, intake } = await boot()
    // A card reaches an API client as the placeholder; a read with user_card_content returns the card itself.
    bot.getMessage = async () => ({
      ...inbound({ id: 'm-card' }),
      content: h('message', h.text('balance-alerter 1 条 CRITICAL 用户的 C 余额低于阈值')),
    })
    await deliver(bot, 'evt-card', inbound({
      id: 'm-card',
      content: h('message', h('raw', { platform: 'lark', type: 'interactive', data: {} }, h.text('[image]'))),
    }))
    await intake.idle()
    expect(store.get(ImMessageKey('fake:bot', 'm-card'))?.text).toContain('balance-alerter')
  })

  it('reads the entries of a merged forward the event could only reference', async () => {
    const { bot, store, intake } = await boot()
    // An event hands the container alone; the platform answers a read of it with the entries.
    bot.getMessage = async () => ({
      ...inbound({ id: 'm-forward' }),
      content: h('message', h('forward', { id: 'm-forward' }, h.text('user-1: 早上好'), h('br'), h.text('user-1: 400 是哪个接口'))),
    })
    await deliver(bot, 'evt-forward', inbound({ id: 'm-forward', content: h('message', h('forward', { id: 'm-forward' })) }))
    await intake.idle()
    expect(store.get(ImMessageKey('fake:bot', 'm-forward'))?.text).toBe('user-1: 早上好\nuser-1: 400 是哪个接口')
  })

  it('keeps the reference when the entries would push the message past maxInputBytes', async () => {
    const { bot, store, intake } = await boot({ config: { maxInputBytes: 1024 } })
    bot.getMessage = async () => ({
      ...inbound({ id: 'm-forward' }),
      content: h('message', h('forward', { id: 'm-forward' }, h.text('x'.repeat(4000)))),
    })
    await deliver(bot, 'evt-forward', inbound({ id: 'm-forward', content: h('message', h('forward', { id: 'm-forward' })) }))
    await intake.idle()
    // A message over the bound is refused whole, so the reference the event carried is what gets stored.
    expect(store.get(ImMessageKey('fake:bot', 'm-forward'))?.text).toBe('[forward]')
  })

  it('ignores the bot\'s own echo and non-message sessions', async () => {
    const { bot, store, intake, dispatched } = await boot()
    await deliver(bot, 'evt-1', inbound({ sender: { id: 'bot-user' } }))
    await bot.receive(bot.session({ type: 'message-deleted', timestamp: 1 }))
    await bot.receive(bot.session({ type: 'message', timestamp: 1 }))
    await intake.idle()
    expect(dispatched).toEqual([])
    expect(store.after(CHAT, 0, 10)).toEqual([])
  })

  it('neither stores nor emits a message from a chat no source admits', async () => {
    const { bot, store, intake, dispatched } = await boot({
      config: { sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all', chats: ['elsewhere'] }] },
    })
    await deliver(bot, 'evt-1', inbound())
    await intake.idle()
    expect(dispatched).toEqual([])
    expect(store.after(CHAT, 0, 10)).toEqual([])
    expect(store.chat(CHAT)).toBeUndefined()
    // Remembered, so a redelivery of the same event stays a no-op instead of being stored later.
    await deliver(bot, 'evt-1', inbound())
    await intake.idle()
    expect(dispatched).toEqual([])
  })

  it('honours the sender allowlist of a source', async () => {
    const { bot, store, intake } = await boot({
      config: { sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all', users: ['allowed'] }] },
    })
    await deliver(bot, 'evt-1', inbound())
    await intake.idle()
    expect(store.after(CHAT, 0, 10)).toEqual([])
    await deliver(bot, 'evt-2', inbound({ id: 'm2', sender: { id: 'allowed' } }))
    await intake.idle()
    expect(store.after(CHAT, 0, 10).map(message => message.sender.id)).toEqual(['allowed'])
  })

  it('stores only addressed messages when the source asks for it', async () => {
    const { bot, store, intake } = await boot({
      config: { sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'addressed' }] },
    })
    await deliver(bot, 'evt-1', inbound())
    await deliver(bot, 'evt-2', inbound({ id: 'm2', mentions: { self: true, all: false, users: [] } }))
    await intake.idle()
    expect(store.after(CHAT, 0, 10).map(message => message.key)).toEqual([ImMessageKey('fake:bot', 'm2')])
  })

  it('marks direct chats and self-mentions as addressed and parses the trailing command', async () => {
    const { bot, intake, dispatched } = await boot()
    const content = h('message', h('at', { type: 'user', id: 'bot-user', name: 'Bot' }), h.text(' /stop now'))
    await deliver(bot, 'evt-1', inbound({
      content, chat: { id: 'dm', type: 'direct' }, mentions: { self: true, all: false, users: [] },
    }))
    await intake.idle()
    expect(dispatched[0]!.addressed).toBe(true)
    expect(dispatched[0]!.command).toEqual({ name: 'stop', rawInput: ' now' })
  })

  it('acknowledges an input over maxInputBytes instead of leaving it unacknowledged', async () => {
    const { bot, store, intake } = await boot({ config: { maxInputBytes: 64 } })
    const oversized = inbound({ content: h('message', h.text('x'.repeat(200))) })
    await deliver(bot, 'evt-1', oversized)
    await intake.idle()
    // Refusing the frame would leave it unacknowledged, and the platform would redeliver it forever.
    expect(store.after(CHAT, 0, 10)).toEqual([])
    expect(store.event('fake:bot|evt-1')).toBeDefined()
    // The redelivery is a cheap no-op rather than a second admission.
    await deliver(bot, 'evt-1', oversized)
    await intake.idle()
    expect(store.after(CHAT, 0, 10)).toEqual([])
  })
})

describe('ImIntake pump', () => {
  /** Store a pending record without the pump, so one pass sees every message at once. */
  async function record(harness: Harness, message: InboundMessage): Promise<ImMessage> {
    const source = harness.intake.config.sources[0]!
    return harness.store.put(draftOf(harness.bot, message, source, 'platform'), 'pending')
  }

  it('serializes one chat while another chat dispatches in parallel', async () => {
    const harness = await boot()
    const { ctx, intake, dispatched } = harness
    const gate = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.on('im/message', async (event, next) => {
      order.push(event.message.text)
      if (event.message.text === 'a1') {
        started.resolve(undefined)
        await gate.promise
      }
      return next()
    })
    await record(harness, inbound({ id: 'a1', content: h('message', h.text('a1')) }))
    await record(harness, inbound({ id: 'a2', content: h('message', h.text('a2')) }))
    await record(harness, inbound({ id: 'b1', chat: { id: 'other', type: 'group' }, content: h('message', h.text('b1')) }))

    intake.pump()
    await started.promise
    // The second message of chat `chat` waits for the first; the other chat is already running.
    await vi.waitFor(() => { expect(order).toContain('b1') })
    expect(order).not.toContain('a2')
    gate.resolve(undefined)
    await intake.idle()
    expect(order.filter(text => text !== 'b1')).toEqual(['a1', 'a2'])
    expect(dispatched.map(message => message.text).sort()).toEqual(['a1', 'a2', 'b1'])
  })

  it('runs prepended listeners first and records the default ignored outcome', async () => {
    const { ctx, bot, store, intake } = await boot()
    const order: string[] = []
    ctx.on('im/message', async (_event, next) => { order.push('normal'); return next() })
    ctx.on('im/message', async (_event, next) => { order.push('prepend'); return next() }, { prepend: true })
    await deliver(bot, 'evt-1', inbound())
    await intake.idle()
    expect(order).toEqual(['prepend', 'normal'])
    expect(store.state(ImMessageKey('fake:bot', 'm1'))?.outcome).toEqual({ kind: 'ignored' })
  })

  it('records a handled outcome with its owner', async () => {
    const { ctx, store, intake, bot } = await boot()
    ctx.on('im/message', async () => ({ kind: 'handled', by: 'test-strategy' }))
    await deliver(bot, 'evt-1', inbound())
    await intake.idle()
    const key = ImMessageKey('fake:bot', 'm1')
    expect(store.state(key)?.outcome).toEqual({ kind: 'handled', by: 'test-strategy' })
    expect(store.recent(5).map(entry => entry.key)).toEqual([key])
  })

  it('leaves the record pending when a listener throws and retries it on the next pass', async () => {
    const { ctx, bot, store, intake, dispatched } = await boot()
    let attempts = 0
    ctx.on('im/message', async (_event, next) => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return next()
    })
    await deliver(bot, 'evt-1', inbound())
    await intake.idle()
    const key = ImMessageKey('fake:bot', 'm1')
    expect(store.state(key)?.dispatch).toBe('pending')
    expect(dispatched).toHaveLength(1)
    intake.pump()
    await intake.idle()
    expect(attempts).toBe(2)
    expect(store.state(key)?.dispatch).toBe('done')
    expect(dispatched).toHaveLength(2)
  })

  it('stops draining a chat whose first message failed and resumes in order', async () => {
    const harness = await boot()
    const { ctx, intake, dispatched } = harness
    let failing = true
    ctx.on('im/message', async (event, next) => {
      if (event.message.text === 'a1' && failing) throw new Error('transient')
      return next()
    })
    await record(harness, inbound({ id: 'a1', content: h('message', h.text('a1')) }))
    await record(harness, inbound({ id: 'a2', content: h('message', h.text('a2')) }))

    intake.pump()
    await intake.idle()
    // The second message of the chat must not overtake the one that stays pending.
    expect(dispatched.map(message => message.text)).toEqual(['a1'])

    failing = false
    intake.pump()
    await intake.idle()
    expect(dispatched.map(message => message.text)).toEqual(['a1', 'a1', 'a2'])
  })

  it('settles a pending record whose admitting source was removed', async () => {
    const harness = await boot()
    const source = harness.intake.config.sources[0]!
    const ghost = draftOf(harness.bot, inbound({ id: 'ghost' }), source, 'platform')
    await harness.store.put({
      ...ghost,
      chat: {
        ...ghost.chat,
        key: ImChatKey('fake:bot', 'ghost'),
        ref: { id: 'ghost', type: 'group' },
        source: ImSourceId('gone'),
      },
    }, 'pending')
    harness.intake.pump()
    await harness.intake.idle()
    expect(harness.store.state(ImMessageKey('fake:bot', 'ghost'))?.outcome)
      .toEqual({ kind: 'ignored', reason: 'source gone removed' })
    expect(harness.dispatched).toEqual([])
  })

  it('re-dispatches records left pending by an earlier process', async () => {
    const pool = new MemoryMediaPool()
    const first = await boot({ pool })
    first.ctx.on('im/message', () => { throw new Error('nope') })
    await deliver(first.bot, 'evt-1', inbound())
    await first.intake.idle()
    const key = ImMessageKey('fake:bot', 'm1')
    expect(first.store.state(key)?.dispatch).toBe('pending')
    await first.intake.dispose()
    await first.store.dispose()

    const second = await boot({ pool })
    second.intake.pump()
    await second.intake.idle()
    expect(second.dispatched.map(message => message.key)).toEqual([key])
    expect(second.store.state(key)?.dispatch).toBe('done')
    expect(second.store.state(key)?.message.seq).toBe(1)
  })

  it('keys an event with a platform id on the message id when the envelope carries none', async () => {
    const { bot, store, intake, dispatched } = await boot()
    const message = inbound()
    await bot.receive(bot.session({ type: 'message', timestamp: 1000, message }))
    await bot.receive(bot.session({ type: 'message', timestamp: 1000, message }))
    await intake.idle()
    expect(dispatched).toHaveLength(1)
    expect(store.after(CHAT, 0, 10)).toHaveLength(1)
  })

  it('stops pumping once disposed', async () => {
    const harness = await boot()
    await record(harness, inbound({ id: 'a1' }))
    await harness.intake.dispose()
    harness.intake.pump()
    await harness.intake.idle()
    expect(harness.dispatched).toEqual([])
    expect(harness.store.pending()).toHaveLength(1)
    await harness.intake.dispose()
  })

  it('finishes the in-flight dispatch on dispose and leaves the rest pending', async () => {
    const harness = await boot()
    const gate = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    let calls = 0
    harness.ctx.on('im/message', async (_event, next) => {
      calls += 1
      started.resolve(undefined)
      await gate.promise
      return next()
    })
    await record(harness, inbound({ id: 'a1' }))
    await record(harness, inbound({ id: 'a2' }))
    harness.intake.pump()
    await started.promise
    harness.intake.pump()
    const disposing = harness.intake.dispose()
    gate.resolve(undefined)
    await disposing
    expect(calls).toBe(1)
    expect(harness.store.pending().map(state => state.message.key)).toEqual([ImMessageKey('fake:bot', 'a2')])
  })
})

describe('ImIntake outbound', () => {
  const target = { chat: { id: 'chat', type: 'group' as const } }
  const content = h('message', h.text('published'))

  it('stores the bot\'s own published message without dispatching it', async () => {
    const { bot, store, intake, dispatched } = await boot()
    bot.user = { id: 'bot-user', name: 'Bot' }
    const result = await bot.send(target, content)
    const message = await intake.outbound(bot, result)
    expect(message?.via).toBe('self')
    expect(message?.text).toBe('published')
    expect(message?.seq).toBe(1)
    expect(message?.sender).toEqual({ id: 'bot-user', name: 'Bot', isBot: true, self: true })
    expect(message?.addressed).toBe(false)
    expect(store.state(message!.key)?.dispatch).toBe('none')
    await intake.idle()
    expect(dispatched).toEqual([])
    // The same handle announced twice stays one record.
    expect(await intake.outbound(bot, result)).toBe(message)
  })

  it('keeps the thread of the published message', async () => {
    const { bot, intake } = await boot()
    const quoted = await intake.outbound(bot, await bot.send({ ...target, thread: 't1' }, content))
    expect(quoted?.thread).toEqual({ id: 't1' })
    const chained = await intake.outbound(bot, await bot.send({ ...target, thread: true }, content))
    expect(chained?.thread).toBeUndefined()
    expect(chained?.sender.name).toBeUndefined()
  })

  it('falls back to the local clock when the platform does not stamp the part', async () => {
    const { bot, intake } = await boot()
    const result = await bot.send(target, content)
    const before = Date.now()
    const message = await intake.outbound(bot, {
      ...result,
      handle: { ...result.handle, parts: [{ ...result.handle.parts[0]!, time: 0 }] },
    })
    expect(message!.time).toBeGreaterThanOrEqual(before)
  })

  it('ignores chats no source admits and empty handles', async () => {
    const { bot, intake, store } = await boot({
      config: { sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all', chats: ['chat'] }] },
    })
    const elsewhere = await bot.send({ chat: { id: 'elsewhere', type: 'group' } }, content)
    expect(await intake.outbound(bot, elsewhere)).toBeUndefined()
    expect(store.latest(ImChatKey('fake:bot', 'elsewhere'))).toBeUndefined()
    expect(await intake.outbound(bot, { ...elsewhere, handle: { ...elsewhere.handle, parts: [] } })).toBeUndefined()
  })
})

describe('admission and drafts', () => {
  const source: ImSourceConfig = { id: 'team', bot: 'fake:bot', writable: true, store: 'all' }

  it('matches the first admitting rule', () => {
    const any: ImSourceConfig = { id: 'any', bot: '*', writable: false, store: 'all' }
    const message = inbound()
    expect(admit([], 'fake:bot', message)).toBeUndefined()
    expect(admit([source], 'other:bot', message)).toBeUndefined()
    expect(admit([source], 'fake:bot', message)).toBe(source)
    expect(admit([any, source], 'fake:bot', message)).toBe(any)
    expect(admit([source], 'fake:bot', inbound({ chat: { id: 'chat', type: 'group' } }))).toBe(source)
    expect(admit([{ ...source, chats: [] }], 'fake:bot', message)).toBeDefined()
    expect(admit([{ ...source, chats: ['other'] }], 'fake:bot', message)).toBeUndefined()
    expect(admit([{ ...source, chats: ['chat'] }], 'fake:bot', message)).toBeDefined()
    expect(admit([{ ...source, users: ['user-1'] }], 'fake:bot', message)).toBeDefined()
    expect(admit([{ ...source, users: ['nobody'] }], 'fake:bot', message)).toBeUndefined()
  })

  it('builds the draft of a stored message', () => {
    const bot = { id: 'fake:bot', selfId: 'bot-user' } as Bot
    const quoted = inbound({
      thread: { id: 't1', root: 'r1' },
      quote: { id: 'q1', sender: { id: 'user-2' }, content: h('message', h.text('quoted')) },
      sender: { id: 'bot-user' },
      mentions: { self: true, all: false, users: [{ id: 'bot-user' }] },
    })
    expect(draftOf(bot, quoted, source, 'self')).toEqual({
      key: ImMessageKey('fake:bot', 'm1'),
      chat: { key: CHAT, bot: 'fake:bot', ref: quoted.chat, source: ImSourceId('team') },
      thread: { id: 't1', root: 'r1' },
      sender: { id: 'bot-user', self: true },
      content: quoted.content,
      text: 'hello',
      quote: { key: ImMessageKey('fake:bot', 'q1'), sender: { id: 'user-2' }, text: 'quoted' },
      mentions: quoted.mentions,
      addressed: true,
      time: 1000,
      via: 'self',
    })
    const bare = draftOf(bot, inbound({ quote: { id: 'q2' } }), source, 'platform')
    expect(bare.quote).toEqual({ key: ImMessageKey('fake:bot', 'q2') })
    expect(bare.thread).toBeUndefined()
    expect(bare.command).toBeUndefined()
    // The adapter's referrer is carried verbatim; a message without one gains no key at all.
    const referrer = { msg_id: 'ROBOT.1.abc', chatId: 'chat' }
    expect(draftOf(bot, inbound({ referrer }), source, 'platform').referrer).toBe(referrer)
    expect(bare.referrer).toBeUndefined()
    expect('referrer' in bare).toBe(false)
    expect(draftOf(bot, inbound({ chat: { id: 'dm', type: 'direct' } }), source, 'platform').addressed).toBe(true)
  })

  it('parses a slash command after the self-mentions', () => {
    const at = (id: string) => h('at', { type: 'user', id, name: id })
    const command = (content: InboundMessage['content'], selfId = 'bot-user') => parseCommand(content, selfId)
    expect(command(h('message', h.text('/stop')))).toEqual({ name: 'stop', rawInput: '' })
    expect(command(h('message', h.text('/ai.reset  hello world')))).toEqual({ name: 'ai.reset', rawInput: '  hello world' })
    expect(command(h('message', at('bot-user'), h.text(' /stop now')))).toEqual({ name: 'stop', rawInput: ' now' })
    expect(command(h('message', at('bot-user'), at('bot-user'), h.text('  /stop')))).toEqual({ name: 'stop', rawInput: '' })
    expect(command(h('message', h.text('  '), h.text('/stop')))).toEqual({ name: 'stop', rawInput: '' })
    // Mentions of somebody else stay in front of the command: not a command.
    expect(command(h('message', at('someone-else'), h.text('/stop')))).toBeUndefined()
    expect(command(h('message', h.text('plain text')))).toBeUndefined()
    expect(command(h('message', h.text('/ pass')))).toBeUndefined()
    expect(command(h('message', at('bot-user')))).toBeUndefined()
    expect(command(h('message', at('bot-user'), h.markdown('/stop')))).toBeUndefined()
    // A command's arguments keep further mentions and text after the first run.
    expect(command(h('message', h.text('/ai'), at('user-9'), h.text('rest'))))
      .toEqual({ name: 'ai', rawInput: '@user-9rest' })
  })
})
