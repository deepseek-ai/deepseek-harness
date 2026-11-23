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
  ImChatKey, ImMessageKey, ImSourceId, type ImConfig, type ImDelivery, type ImMessage, type ImSourceConfig,
} from '../src/api.ts'
import { Config } from '../src/config.ts'
import { ImError } from '../src/error.ts'
import { ImDispatcher } from '../src/dispatcher.ts'
import { admit, DELIVERY_ENVELOPE_BYTES, draftOf, ImIntake, parseCommand } from '../src/intake.ts'
import { sessionIdOf } from '../src/hosting.ts'
import { ImStore, inputBytes } from '../src/store.ts'

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
async function boot(options: { config?: Partial<ImConfig>; pool?: MemoryMediaPool; bot?: string } = {}): Promise<Harness> {
  const pool = options.pool ?? new MemoryMediaPool()
  const botId = options.bot ?? 'fake:bot'
  const { ctx, bot } = await mountFakeAdapter({ modes: { text: createTextMode() }, selfId: 'bot-user', id: botId })
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const config = Config({ sources: [{ id: 'team', bot: botId, writable: true, store: 'all' }], ...options.config })
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
    await Promise.all([deliver(bot, 'evt-1', inbound()), deliver(bot, 'evt-1', inbound())])
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

  it('acknowledges another chat while one frame waits for a platform read', async () => {
    const { bot, store, intake } = await boot()
    const held = Promise.withResolvers<undefined>()
    let reads = 0
    bot.getMessage = async (chat: { id: string }) => {
      reads += 1
      await held.promise
      return inbound({ id: 'm-slow', chat: { id: chat.id, type: 'group' }, content: h('message', h.text('read back')) })
    }
    const card = h('message', h('raw', { platform: 'lark', type: 'interactive', data: {} }, h.text('[image]')))
    const slow = deliver(bot, 'evt-slow', inbound({ id: 'm-slow', chat: { id: 'slow', type: 'group' }, content: card }))
    await vi.waitFor(() => { expect(reads).toBe(1) })

    // The other chat is acknowledged although that read is still open: the reads are outside the store chain.
    await deliver(bot, 'evt-fast', inbound({ id: 'm-fast' }))
    expect(store.get(ImMessageKey('fake:bot', 'm-fast'))).toBeDefined()

    held.resolve(undefined)
    await slow
    await intake.idle()
    expect(store.get(ImMessageKey('fake:bot', 'm-slow'))?.text).toBe('read back')
  })

  it('rejects a frame that arrives after it stopped, so the platform redelivers it', async () => {
    const { bot, store, intake } = await boot()
    await intake.dispose()
    // A listener that returns is an accepted frame — the adapter acknowledges it — so this one rejects instead.
    await expect(deliver(bot, 'evt-late', inbound({ id: 'm-late' }))).rejects.toThrow()
    expect(store.get(ImMessageKey('fake:bot', 'm-late'))).toBeUndefined()
  })

  it('keeps reading a chat after a platform read failed', async () => {
    const { bot, store, intake } = await boot()
    let calls = 0
    bot.getMessage = async () => {
      calls += 1
      if (calls === 1) throw new Error('the platform is gone')
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error rejection exercises String(error).
      return Promise.reject('raw reread failure')
    }
    const card = h('message', h('raw', { platform: 'lark', type: 'interactive', data: {} }, h.text('[image]')))
    const first = deliver(bot, 'evt-card', inbound({ id: 'm-card', content: card }))
    const second = deliver(bot, 'evt-card-2', inbound({ id: 'm-card-2', content: card }))
    const third = deliver(bot, 'evt-next', inbound({ id: 'm-next' }))
    await Promise.all([first, second, third])
    await intake.idle()
    // The failed reads leave the references as they arrived, and the next frame of the same chat is still stored.
    expect(store.get(ImMessageKey('fake:bot', 'm-card'))?.text).toBe('[image]')
    expect(store.get(ImMessageKey('fake:bot', 'm-card-2'))?.text).toBe('[image]')
    expect(store.get(ImMessageKey('fake:bot', 'm-next'))?.text).toBe('hello')
  })

  it('fills quoted reply text from the store or platform and tolerates missing or failing quote reads', async () => {
    const { bot, store, intake } = await boot()
    intake.release()
    await deliver(bot, 'evt-base', inbound({ id: 'm-base', content: h('message', h.text('stored original')) }))
    await deliver(bot, 'evt-inline', inbound({
      id: 'm-inline',
      quote: { id: 'q-inline', content: h('message', h.text('inline original')) },
    }))
    await deliver(bot, 'evt-from-store', inbound({ id: 'm-from-store', quote: { id: 'm-base' } }))
    await deliver(bot, 'evt-no-reader', inbound({ id: 'm-no-reader', quote: { id: 'q-missing' } }))

    bot.getMessage = async (_chat, id) => {
      if (id === 'q-remote') return inbound({ id, content: h('message', h.text('remote original')) })
      if (id === 'q-error') throw new Error('quote vanished')
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error rejection exercises String(error).
      return Promise.reject('raw quote failure')
    }
    await deliver(bot, 'evt-remote', inbound({ id: 'm-remote', quote: { id: 'q-remote' } }))
    await deliver(bot, 'evt-err', inbound({ id: 'm-err', quote: { id: 'q-error' } }))
    await deliver(bot, 'evt-raw', inbound({ id: 'm-raw', quote: { id: 'q-raw' } }))
    await intake.idle()

    expect(store.get(ImMessageKey('fake:bot', 'm-inline'))?.quote?.text).toBe('inline original')
    expect(store.get(ImMessageKey('fake:bot', 'm-from-store'))?.quote?.text).toBe('stored original')
    expect(store.get(ImMessageKey('fake:bot', 'm-no-reader'))?.quote?.text).toBeUndefined()
    expect(store.get(ImMessageKey('fake:bot', 'm-remote'))?.quote?.text).toBe('remote original')
    expect(store.get(ImMessageKey('fake:bot', 'm-err'))?.quote?.text).toBeUndefined()
    expect(store.get(ImMessageKey('fake:bot', 'm-raw'))?.quote?.text).toBeUndefined()

    // A platform with dual ids (e.g. QQ `msg_id` + `msg_idx` alias) resolves quotes against the local store.
    await deliver(bot, 'evt-aliased', inbound({
      id: 'm-aliased',
      aliases: ['REFIDX_orig'],
      referrer: { ref: 'chat-1-ref' },
      content: h('message', h.text('aliased original')),
    }))
    bot.getMessage = async () => { throw new Error('should not reread stored aliased message') }
    await deliver(bot, 'evt-reply-alias', inbound({ id: 'm-reply-alias', quote: { id: 'REFIDX_orig' } }))
    await intake.idle()
    expect(store.get(ImMessageKey('fake:bot', 'm-reply-alias'))?.quote?.text).toBe('aliased original')

    // Another chat on the same bot must not inherit quote text or referrer from chat-1's alias.
    const otherChat = { id: 'chat-2', type: 'group' as const }
    delete bot.getMessage
    await deliver(bot, 'evt-other-chat', inbound({
      id: 'm-other-chat',
      chat: otherChat,
      quote: { id: 'REFIDX_orig' },
    }))
    await intake.idle()
    expect(store.get(ImMessageKey('fake:bot', 'm-other-chat'))?.quote?.text).toBeUndefined()

    await bot.send({ chat: otherChat }, h('message', h('quote', { id: 'REFIDX_orig' }), h.text('own reply')))
    await intake.idle()
    const ownReply = store.latest(ImChatKey('fake:bot', 'chat-2'))
    expect(ownReply?.referrer).toBeUndefined()

    // Own outbound parts carrying platform aliases (e.g. QQ ext_info.ref_idx) are indexed so replies can quote them.
    const sent = await bot.send({ chat: { id: 'chat', type: 'group' } }, h('message', h.text('own aliased')))
    await intake.outbound(bot, {
      ...sent,
      handle: {
        ...sent.handle,
        parts: [{ id: 'ROBOT1.0_own', kind: 'text', time: 1000, aliases: ['REFIDX_own'] }],
      },
    })
    expect(store.get(ImMessageKey('fake:bot', 'REFIDX_own'))).toMatchObject({
      key: ImMessageKey('fake:bot', 'ROBOT1.0_own'),
      aliases: ['REFIDX_own'],
    })
  })

  it('stops waiting for a platform read that never answers', async () => {
    const { bot, store, intake } = await boot({ config: { platformTimeoutMs: 20 } })
    bot.getMessage = () => new Promise(() => {})
    const card = h('message', h('raw', { platform: 'lark', type: 'interactive', data: {} }, h.text('[image]')))
    await deliver(bot, 'evt-stuck', inbound({ id: 'm-stuck', content: card }))
    await intake.idle()
    // The deadline leaves the reference the event carried, and the chat is free for the next message.
    expect(store.get(ImMessageKey('fake:bot', 'm-stuck'))?.text).toBe('[image]')
  })
  it('keeps the arrival order of one chat when a platform read is slow', async () => {
    const { bot, store, intake } = await boot()
    const held = Promise.withResolvers<undefined>()
    let reads = 0
    bot.getMessage = async () => {
      reads += 1
      await held.promise
      return inbound({ id: 'm-card', content: h('message', h.text('card body')) })
    }
    const card = h('message', h('raw', { platform: 'lark', type: 'interactive', data: {} }, h.text('[image]')))
    const slow = deliver(bot, 'evt-card', inbound({ id: 'm-card', content: card }))
    await vi.waitFor(() => { expect(reads).toBe(1) })

    // The next message of the same chat arrives while that read is open: it waits, so it cannot take the smaller seq.
    const next = deliver(bot, 'evt-next', inbound({ id: 'm-next', content: h('message', h.text('算了，不用了')) }))
    held.resolve(undefined)
    await Promise.all([slow, next])
    await intake.idle()

    expect(store.after(CHAT, 0, 10).map(message => message.text)).toEqual(['card body', '算了，不用了'])
  })

  it('finishes a frame that is still reading the platform before it stops', async () => {
    const { bot, store, intake } = await boot()
    const held = Promise.withResolvers<undefined>()
    bot.getMessage = async () => {
      await held.promise
      return inbound({ id: 'm-card', content: h('message', h.text('card body')) })
    }
    const card = h('message', h('raw', { platform: 'lark', type: 'interactive', data: {} }, h.text('[image]')))
    void deliver(bot, 'evt-card', inbound({ id: 'm-card', content: card }))
    await vi.waitFor(() => { expect(store.get(ImMessageKey('fake:bot', 'm-card'))).toBeUndefined() })

    // The store is closed after the reads of the frames already accepted: a frame that read too late would write into
    // a closed domain and lose its acknowledgement.
    const stopped = intake.dispose()
    held.resolve(undefined)
    await stopped
    expect(store.get(ImMessageKey('fake:bot', 'm-card'))?.text).toBe('card body')
  })

  it('acknowledges a message the delivery budget could never carry', async () => {
    const { bot, store, intake } = await boot({ config: { maxInputBytes: 4096 } })
    // The record fits, but the delivery intent that repeats it does not: storing it would be acknowledged here and
    // refused later, where nothing can report it to the chat.
    await deliver(bot, 'evt-big', inbound({ id: 'm-big', content: h('message', h.text('x'.repeat(1800))) }))
    await intake.idle()
    expect(store.get(ImMessageKey('fake:bot', 'm-big'))).toBeUndefined()
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

  it('dispatches a newly arriving chat immediately even when another chat is blocked in the waterfall', async () => {
    const { ctx, bot, intake } = await boot()
    const order: string[] = []
    const chatAStarted = Promise.withResolvers<undefined>()
    const releaseChatA = Promise.withResolvers<undefined>()
    const chatBEntered = Promise.withResolvers<undefined>()
    ctx.on('im/message', async (event) => {
      const id = event.message.key.split('|')[1]
      order.push(`${event.message.chat.ref.id}:${id}`)
      if (event.message.chat.ref.id === 'chat-a' && id === 'a1') {
        chatAStarted.resolve(undefined)
        await releaseChatA.promise
      }
      if (event.message.chat.ref.id === 'chat-b') chatBEntered.resolve(undefined)
      return { kind: 'ignored' }
    }, { prepend: true })

    await deliver(bot, 'evt-a1', inbound({ id: 'a1', chat: { id: 'chat-a', type: 'group' } }))
    await chatAStarted.promise
    // Second message in chat-a queues behind a1; chat-b enters the waterfall immediately without waiting for a1.
    await deliver(bot, 'evt-a2', inbound({ id: 'a2', chat: { id: 'chat-a', type: 'group' } }))
    await deliver(bot, 'evt-b1', inbound({ id: 'b1', chat: { id: 'chat-b', type: 'group' } }))
    await chatBEntered.promise
    expect(order).toEqual(['chat-a:a1', 'chat-b:b1'])

    releaseChatA.resolve(undefined)
    await intake.idle()
    expect(order).toEqual(['chat-a:a1', 'chat-b:b1', 'chat-a:a2'])
  })

  it('does not cross-trigger an unbounded retry loop when two failing chats are pumped twice', async () => {
    const { ctx, bot, intake } = await boot()
    let calls = 0
    const bothStarted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('im/message', async () => {
      calls += 1
      if (calls === 2) bothStarted.resolve(undefined)
      await release.promise
      throw new Error('transient failure')
    }, { prepend: true })

    await deliver(bot, 'evt-a1', inbound({ id: 'a1', chat: { id: 'chat-a', type: 'group' } }))
    await deliver(bot, 'evt-b1', inbound({ id: 'b1', chat: { id: 'chat-b', type: 'group' } }))
    await bothStarted.promise
    // A second external pump marks both active chats as `more` while both are in flight.
    intake.pump()
    release.resolve(undefined)
    await intake.idle()
    // Each chat runs its initial pass + at most one `more` continuation (4 total), never ping-ponging.
    expect(calls).toBe(4)
  })

  it('leaves room for the delivery of a message admitted at the very edge of maxInputBytes', async () => {
    // Real Feishu identifiers, which every key, the chat header and the delivery id repeat: the intake reserves a fixed
    // envelope for the delivery intent, and this pins that the reserve covers the real `ImDispatcher.handle` intent.
    const maxInputBytes = 8192
    const larkBot = 'lark:cli_a5f1e2d3c4b5a697'
    const defaultDispatch = {
      agentPreset: 'im', cwd: process.cwd(), provider: 'mock', model: 'mock',
      output: 'none', delivery: 'steer' as const, prompt: { name: 'im:dispatcher', order: 81, text: '' },
    }
    const { ctx, bot, store, intake, dispatched } = await boot({
      config: { maxInputBytes, defaultDispatch },
      bot: larkBot,
    })
    const captured: ImDelivery[] = []
    let hosted: ReturnType<typeof sessionIdOf> | undefined
    const dispatcher = new ImDispatcher(intake.config.defaultDispatch!, {
      get: () => undefined,
      of: () => undefined,
      deliveredTo: () => undefined,
      ensure: async (spec) => {
        hosted = sessionIdOf(spec.key, 0)
        return { ...spec, sessionId: hosted, generation: 0, createdAt: 0, lastActiveAt: 0 }
      },
    })
    ctx.on('im/message', event => dispatcher.handle({
      ...event,
      deliver: async (_target, options) => {
        captured.push({
          ...options,
          id: options.id ?? event.message.key,
          content: options.content ?? [event.message],
        })
      },
    }))
    const source = intake.config.sources[0]!
    const chat = { id: `oc_${'a1b2c3d4'.repeat(4)}`, type: 'group' as const }
    const shaped = (length: number) => inbound({
      id: `om_${'e5f6a7b8'.repeat(4)}`,
      chat,
      sender: { id: `ou_${'c9d0e1f2'.repeat(4)}`, name: '张三' },
      mentions: { self: true, all: false, users: [] },
      content: h('message', h.text('字'.repeat(length))),
    })
    // The longest body the intake still admits: one more character and it is acknowledged without dispatching.
    let length = 0
    while (inputBytes(draftOf(bot, shaped(length + 1), source, 'platform')) + DELIVERY_ENVELOPE_BYTES <= maxInputBytes) length++
    await deliver(bot, '0123abcd'.repeat(4), shaped(length))
    await intake.idle()
    const [message] = dispatched
    expect(message).toBeDefined()
    expect(store.state(message!.key)?.dispatch).toBe('done')
    expect(captured).toHaveLength(1)
    expect(inputBytes(captured[0]!)).toBeLessThanOrEqual(maxInputBytes)
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

  it('settles a message no delivery can fit and keeps the chat draining', async () => {
    const harness = await boot()
    const { ctx, intake, dispatched, store } = harness
    ctx.on('im/message', async (event, next) => {
      if (event.message.text === 'huge') {
        throw new ImError('capacity', 'IM delivery exceeds the configured byte limit.', { permanent: true })
      }
      return next()
    })
    await record(harness, inbound({ id: 'huge', content: h('message', h.text('huge')) }))
    await record(harness, inbound({ id: 'small', content: h('message', h.text('small')) }))

    intake.pump()
    await intake.idle()

    // Dropped rather than retried forever: the message behind it is dispatched in the same pass (the pump used to stop
    // the chat at the first failure, so `small` never got an event at all).
    expect(store.state(ImMessageKey('fake:bot', 'huge'))?.dispatch).toBe('done')
    expect(dispatched.map(message => message.text)).toEqual(['huge', 'small'])

    // If settling the dropped message itself fails, the chat stops and leaves it pending for retry.
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    vi.spyOn(store, 'settle').mockRejectedValueOnce(new Error('storage offline'))
    await record(harness, inbound({ id: 'huge-2', content: h('message', h.text('huge')) }))
    intake.pump()
    await intake.idle()
    expect(store.state(ImMessageKey('fake:bot', 'huge-2'))?.dispatch).toBe('pending')
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('keeps transient capacity errors pending instead of settling them as ignored', async () => {
    const harness = await boot()
    const { ctx, intake, dispatched, store } = harness
    let fail = true
    ctx.on('im/message', async (_event, next) => {
      if (fail) {
        fail = false
        throw new ImError('capacity', 'IM receipts are full of unresolved operations.')
      }
      return next()
    })
    await record(harness, inbound({ id: 'cmd-1', content: h('message', h.text('/help')) }))

    intake.pump()
    await intake.idle()
    const key = ImMessageKey('fake:bot', 'cmd-1')
    expect(store.state(key)?.dispatch).toBe('pending')

    intake.pump()
    await intake.idle()
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
    const key = ImMessageKey(bot.id, result.handle.parts[0]!.id)
    expect(await intake.announced(ImMessageKey('fake:bot', 'never-sent'))).toBeUndefined()
    const first = intake.outbound(bot, result)
    const second = intake.outbound(bot, result)
    const viaAnnounced = intake.announced(key)
    const [message] = await Promise.all([first, second, viaAnnounced])
    expect(await viaAnnounced).toBe(message)
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
    const { bot, intake, store } = await boot()
    const quoted = await intake.outbound(bot, await bot.send({ ...target, thread: 't1' }, content))
    expect(quoted?.thread).toEqual({ id: 't1' })
    const chained = await intake.outbound(bot, await bot.send({ ...target, thread: true }, content))
    expect(chained?.thread).toBeUndefined()
    expect(chained?.sender.name).toBeUndefined()

    const parent = await store.put({
      key: ImMessageKey('fake:bot', 'm-threaded'),
      chat: { key: CHAT, bot: 'fake:bot', ref: target.chat, source: ImSourceId('team') },
      sender: { id: 'u1', self: false },
      content: h('message', h.text('hi')),
      text: 'hi',
      mentions: { self: false, all: false, users: [] },
      addressed: true,
      time: 1000,
      via: 'platform',
      thread: { id: 'omt_1', root: 'om_root' },
      referrer: { threadId: 'omt_1', messageId: 'm-threaded' },
    }, 'none')
    const replyResult = await bot.send(
      { ...target, thread: true, referrer: parent.referrer },
      h('message', h('quote', { id: 'm-threaded' }), h.text('reply')),
    )
    const ownReply = await intake.outbound(bot, replyResult)
    expect(ownReply?.thread).toEqual({ id: 'omt_1', root: 'om_root' })
    expect(ownReply?.referrer).toEqual({ threadId: 'omt_1', messageId: 'm-threaded' })

    const explicitReply = await bot.send(
      { ...target, thread: 'omt_1', referrer: parent.referrer },
      h('message', h('quote', { id: 'm-threaded' }), h.text('explicit')),
    )
    const ownExplicit = await intake.outbound(bot, explicitReply)
    expect(ownExplicit?.thread).toEqual({ id: 'omt_1', root: 'om_root' })

    // A platform that reports the thread of the sent part without its root keeps the thread id alone.
    const rootlessResult = await bot.send({ ...target, thread: true }, content)
    rootlessResult.handle.parts[0]!.thread = { id: 'omt_rootless' }
    expect((await intake.outbound(bot, rootlessResult))?.thread).toEqual({ id: 'omt_rootless' })

    // When replying with `thread: true` to an unthreaded root message creates a new platform thread,
    // `SentPart.thread` and `SentPart.referrer` override the unthreaded quote/target defaults.
    const createdThreadResult = await bot.send({ ...target, thread: true, referrer: { messageId: 'om_root' } }, content)
    createdThreadResult.handle.parts[0]!.thread = { id: 'omt_created', root: 'om_root' }
    createdThreadResult.handle.parts[0]!.referrer = { messageId: createdThreadResult.handle.parts[0]!.id, threadId: 'omt_created', rootId: 'om_root' }
    const ownCreated = await intake.outbound(bot, createdThreadResult)
    expect(ownCreated?.thread).toEqual({ id: 'omt_created', root: 'om_root' })
    expect(ownCreated?.referrer).toEqual({
      messageId: createdThreadResult.handle.parts[0]!.id,
      threadId: 'omt_created',
      rootId: 'om_root',
    })
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

  it('stores only the text of an own publication that is over the budget', async () => {
    const { bot, intake } = await boot({ config: { maxInputBytes: 4096 } })

    // An inline resource: the platform holds the bytes, and the record keeps neither them nor a copy of the URL.
    const inline = await intake.outbound(bot, await bot.send(target, h('message', h.text('look '),
      h('img', { src: `data:image/png;base64,${'A'.repeat(20000)}` }))))
    expect(JSON.stringify(inline)).not.toContain('base64')
    expect(Buffer.byteLength(JSON.stringify(inline))).toBeLessThanOrEqual(4096)

    // A long body is cut to the budget rather than dropped.
    const long = await intake.outbound(bot, await bot.send(target, h('message', h.text('x'.repeat(6000)))))
    expect(long?.text.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(long))).toBeLessThanOrEqual(4096)

    // JSON escapes part of that body ('\n' is two bytes, '\u0001' is six), so the cut is measured again and shrunk.
    const escaped = await intake.outbound(bot, await bot.send(target, h('message', h.text('\n'.repeat(6000)))))
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThanOrEqual(4096)
    const control = await intake.outbound(bot, await bot.send(target, h('message', h.text('\u0001'.repeat(2000)))))
    expect(Buffer.byteLength(JSON.stringify(control))).toBeLessThanOrEqual(4096)

    // Even when maxInputBytes is smaller than the envelope itself, room stops shrinking at 1 character.
    const tiny = await boot({ config: { maxInputBytes: 64 } })
    const clamped = await tiny.intake.outbound(tiny.bot, await tiny.bot.send(target, h('message', h.text('abcdef'))))
    expect(clamped?.text.length).toBe(1)
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
    // Paths and calls without a whitespace/end boundary after the token are plain text, not commands.
    expect(command(h('message', h.text('/new/project')))).toBeUndefined()
    expect(command(h('message', h.text('/clear()')))).toBeUndefined()
    expect(command(h('message', h.text('/stop()')))).toBeUndefined()
    // A command's arguments keep further mentions and text after the first run.
    expect(command(h('message', h.text('/ai'), at('user-9'), h.text('rest'))))
      .toEqual({ name: 'ai', rawInput: '@user-9rest' })
  })
})
