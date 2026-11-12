/**
 * The IM host plugin as an operator mounts it: `ctx.im`. Per-concern behaviour keeps its own suites; this one pins
 * the service wiring — configuration validation, the `[Service.init]` lifecycle, and the facade methods every other
 * IM plugin calls through `ctx.im`.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Satori, h } from '@deepseek-ai/cordis-plugin-im-core'
import type { InboundMessage } from '@deepseek-ai/cordis-plugin-im-core'
import { createTextMode, FakeAdapter } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  ImChatKey, ImMessageKey, ImSourceId, type ImChat, type ImConfig, type ImMessageEvent,
  type ImOutcome,
} from '../src/api.ts'
import { Config } from '../src/config.ts'
import { ImError } from '../src/error.ts'
import { ImService } from '../src/index.ts'
import { imSessionsDomain } from '../src/sessions.ts'
import { imDomain } from '../src/state.ts'
import { ImStore, type ImMessageDraft } from '../src/store.ts'
import { boot, cleanRoots, COMPOSITION, type SessionsHarness } from './support/sessions-harness.ts'

/** The chat every facade test admits. */
const CHAT = ImChatKey('fake:bot', 'chat')
/** The admission rule every boot configures. */
const SOURCES: ImConfig['sources'] = [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all' }]

interface Harness {
  base: SessionsHarness
  service: ImService
  bot: FakeAdapter
}

const booted: Harness[] = []

/**
 * Boot one context with the real plugin mounted as the only IM host.
 * @param options - `retryIntervalMs` to make the maintenance timer observable inside one test; `beforeMount` to seed
 *   stored state the way an earlier process leaves it.
 * @returns the context, the mounted `ctx.im` and the platform fake it runs on.
 */
async function mount(options: { retryIntervalMs?: number; beforeMount?: (ctx: Context) => Promise<void> } = {}): Promise<Harness> {
  const retryIntervalMs = options.retryIntervalMs ?? 60_000
  // `withoutStart` leaves the harness's own sessions host inert: this context hosts exactly one IM service.
  const base = await boot({ withoutStart: true, config: { sources: SOURCES, retryIntervalMs } })
  const ctx = base.ctx
  await ctx.plugin(Satori)
  await ctx.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'bot-user' })
  // The media bridge only reaches attachments for images it stores; the facade never saves one here.
  ctx.provide('attachments', { saveImages: async () => [] } as never)
  await options.beforeMount?.(ctx)
  await ctx.plugin(ImService, Config({ sources: SOURCES, retryIntervalMs }))
  const bot = ctx.bots.find(candidate => candidate instanceof FakeAdapter) as FakeAdapter
  const harness: Harness = { base, service: ctx.im, bot }
  booted.push(harness)
  return harness
}

/** One inbound platform message from a human sender. */
function inbound(id: string, patch: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id,
    chat: { id: 'chat', type: 'group' },
    sender: { id: 'user-1', name: 'User' },
    content: h('message', h.text(`hello ${id}`)),
    mentions: { self: true, all: false, users: [] },
    time: 1000,
    referrer: undefined,
    raw: null,
    ...patch,
  }
}

/** Deliver one platform event the way an adapter does; the intake pumps it asynchronously. */
function deliver(bot: FakeAdapter, message: InboundMessage): Promise<void> {
  return bot.receive(bot.session({ type: 'message', id: message.id, timestamp: message.time, message }))
}

/**
 * Install a stand-in for a service this package does not type (the Loader), through the Context API's untyped name
 * overload: the typed `provide` demands the real service class.
 * @param ctx - context the stand-in is provided on.
 * @param name - service name.
 * @param value - the stand-in.
 */
function provideByName(ctx: Context, name: string, value: unknown): void {
  ctx.provide(name, value)
}

afterEach(async () => {
  for (const harness of booted.splice(0)) await harness.base.ctx.fiber.dispose().catch(() => {})
})

afterAll(cleanRoots)

describe('ImService configuration', () => {
  it('refuses a source with a blank id', () => {
    const ctx = new Context()
    expect(() => new ImService(ctx, Config({ sources: [{ id: '   ', bot: 'fake:bot' }] }))).toThrow(ImError)
  })

  it('refuses a source with a blank bot', () => {
    const ctx = new Context()
    expect(() => new ImService(ctx, Config({ sources: [{ id: 'team', bot: ' ' }] }))).toThrow(ImError)
  })

  it('refuses two sources claiming the same id', () => {
    const ctx = new Context()
    const sources = [{ id: 'team', bot: 'fake:bot' }, { id: 'team', bot: 'fake:other' }]
    expect(() => new ImService(ctx, Config({ sources }))).toThrow(ImError)
  })
})

describe('ImService facade', () => {
  it('reports its configured sources by id', async () => {
    const { service } = await mount()
    expect(service.source('team')?.bot).toBe('fake:bot')
    expect(service.source('unknown')).toBeUndefined()
  })

  it('resolves the mounted bot of a chat and refuses an unmounted one', async () => {
    const { service, bot } = await mount()
    expect(service.bot(CHAT).id).toBe(bot.id)
    expect(() => service.bot(ImChatKey('other:bot', 'chat'))).toThrow(ImError)
  })

  it('keeps a chat out of its history until the intake admits it', async () => {
    const { service, bot } = await mount()
    expect(service.chat(CHAT)).toBeUndefined()

    await deliver(bot, inbound('m1'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })
  })

  it('refuses a stored message that belongs to another chat of the same bot', async () => {
    const { service, bot } = await mount()
    const other = ImChatKey('fake:bot', 'other')
    await deliver(bot, inbound('m1', { chat: { id: 'other', type: 'group' } }))
    await vi.waitFor(() => { expect(service.chat(other)).toBeDefined() })
    // The message is stored under this bot, so a lookup by key alone would hand it to any chat of the bot.
    expect(service.history.get(ImMessageKey('fake:bot', 'm1'))).toBeDefined()
    await expect(service.readMessage(CHAT, 'm1')).rejects.toMatchObject({ code: 'access' })
    await expect(service.readMessage(other, 'm1')).resolves.toMatchObject({ key: ImMessageKey('fake:bot', 'm1') })
  })

  it('reads a message the store does not hold from the platform, and keeps it', async () => {
    const { service, bot } = await mount()
    await deliver(bot, inbound('m1'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })
    bot.getMessage = async () => inbound('m-late', { content: h('message', h.text('read back')) })

    const message = await service.readMessage(CHAT, 'm-late')
    expect(message.text).toBe('read back')
    // The read is admitted and stored like any other, so a second read stays local.
    expect(service.history.get(ImMessageKey('fake:bot', 'm-late'))).toBeDefined()
  })

  it('refuses a platform read that answers with another chat\'s message', async () => {
    const { service, bot } = await mount()
    await deliver(bot, inbound('m1'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })
    // `getMessage` is handed the chat as a routing hint; a bot that serves several chats resolves an id globally.
    bot.getMessage = async () => inbound('m-foreign', { chat: { id: 'elsewhere', type: 'group' } })

    await expect(service.readMessage(CHAT, 'm-foreign'))
      .rejects.toThrow('Message m-foreign belongs to chat elsewhere, not chat.')
    expect(service.history.get(ImMessageKey('fake:bot', 'm-foreign'))).toBeUndefined()
  })

  it('fills a merged forward stored as a bare reference with the entries a read returns', async () => {
    const { service, bot } = await mount()
    await deliver(bot, inbound('m1', { content: h('message', h('forward', { id: 'm1' })) }))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })
    // The store keeps the reference the event carried; the read is what brings its contents.
    bot.getMessage = async () => inbound('m1', {
      content: h('message', h('forward', { id: 'm1' }, h.text('user-1: 原文'))),
    })
    const message = await service.readMessage(CHAT, 'm1')
    expect(message.text).toBe('user-1: 原文')
    expect(message.seq).toBe(1)
  })

  it('publishes and streams through the send funnel of its sender', async () => {
    const { service, bot } = await mount()
    await deliver(bot, inbound('m1'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })

    await expect(service.send(CHAT, h('message', h.text('published')))).resolves.toBeDefined()
    const stream = await service.stream(CHAT)
    stream.update(h('message', h.text('streamed')))
    await stream.close()
    expect(bot.sentPayloads().length).toBeGreaterThanOrEqual(2)
  })

  it('formats messages through its formatter', async () => {
    const { service } = await mount()
    // No messages is an empty text block, the shape every user-message content takes.
    await expect(service.format([], { media: false })).resolves.toEqual([{ type: 'text', text: '' }])
  })

  it('snapshots bots, sources, sessions and recent outcomes for diagnostics', async () => {
    const { service, bot } = await mount()
    await deliver(bot, inbound('m1'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })

    const status = service.status()
    expect(status.bots.map(entry => entry.id)).toContain('fake:bot')
    expect(status.sources.map(source => source.id)).toEqual(['team'])
    expect(status.pendingMessages).toBeTypeOf('number')
    expect(Array.isArray(status.recent)).toBe(true)
  })

  it('binds reply and send to the chat of the message it dispatches', async () => {
    const { base, bot } = await mount()
    const handled: string[] = []
    base.ctx.on('im/message', async (event: ImMessageEvent): Promise<ImOutcome> => {
      handled.push(event.message.key)
      const tag = event.message.key
      await event.reply(h('message', h.text(`reply ${tag}`)))
      await event.send(h('message', h.text(`direct ${tag}`)))
      return { kind: 'handled', by: 'facade-spec' }
    })

    // A plain message replies into the chat; a thread message carries its thread onto the reply options.
    await deliver(bot, inbound('m1'))
    await deliver(bot, inbound('m2', { thread: { id: 'th-1' } }))
    // Both dispatches reach the bot, and each one publishes twice: the reply rides a `<quote>` envelope — which a
    // `<message>` root keeps, the quote sitting among its children — and then the direct send.
    await vi.waitFor(() => { expect(bot.sentPayloads()).toHaveLength(4) })
    expect(handled).toEqual([ImMessageKey('fake:bot', 'm1'), ImMessageKey('fake:bot', 'm2')])
    const sent = bot.sentPayloads().map(payload => bot.payloadText(payload))
    expect(sent).toEqual([
      `reply ${handled[0]}`, `direct ${handled[0]}`, `reply ${handled[1]}`, `direct ${handled[1]}`,
    ])
  })

  it('surfaces a delivery to a session that is not hosted', async () => {
    const { base, bot } = await mount()
    const failures: unknown[] = []
    base.ctx.on('im/message', async (event: ImMessageEvent): Promise<ImOutcome> => {
      // The defaults (message key, the message itself) and explicit overrides both reach the sessions host.
      await event.deliver(SessionId('im-absent'), { mode: 'inject' }).catch((error: unknown) => { failures.push(error) })
      await event.deliver(SessionId('im-absent'), {
        mode: 'inject', id: `op-${event.message.key}`, content: [{ type: 'text', text: 'explicit' }], trigger: event.message,
      }).catch((error: unknown) => { failures.push(error) })
      return { kind: 'handled', by: 'facade-spec' }
    })

    await deliver(bot, inbound('m1'))
    await vi.waitFor(() => { expect(failures).toHaveLength(2) })
    for (const failure of failures) expect(failure).toBeInstanceOf(ImError)
  })

  it('announces the activity of the sessions it hosts', async () => {
    const { base, service } = await mount()
    const record = await service.sessions.ensure({
      key: `conv:${CHAT}`,
      owner: 'conversation',
      composition: COMPOSITION,
      bindings: [{ chat: CHAT, writable: true, home: true }],
    })
    const changes: string[] = []
    base.ctx.on('im/activity', (_activity, change) => { changes.push(change) })
    // A real turn of the hosted session: the tracker resolves the record and the turn's trigger through this service.
    await service.sessions.deliver(record.key, {
      id: 'evt-activity', mode: 'followup', content: [{ type: 'text', text: 'go' }],
    })
    await (await service.sessions.agent(record.sessionId)).whenIdle()
    expect(changes).toContain('start')
  })

  it('keeps intake, recovery and retention running on its retry interval', async () => {
    const { service } = await mount({ retryIntervalMs: 20 })
    const sweeps: number[] = []
    const sweep = service.store.sweep.bind(service.store)
    vi.spyOn(service.store, 'sweep').mockImplementation(async (now) => {
      sweeps.push(now)
      return sweep(now)
    })
    // One maintenance tick re-pumps the intake, retries deliveries and sweeps expired records.
    await vi.waitFor(() => { expect(sweeps.length).toBeGreaterThan(0) })
  })

  it('dispatches a stored message only after every routing plugin is mounted', async () => {
    // A command a previous process left pending: dispatching it inside this load would run it before the plugins that
    // listen to `im/message` exist, and it would settle as an ordinary message instead of running the command.
    const { base, service } = await mount({
      retryIntervalMs: 20,
      beforeMount: async (ctx) => {
        const seeded = new ImStore(ctx, Config({ sources: SOURCES }))
        await seeded.start()
        const chat: ImChat = {
          key: CHAT, bot: 'fake:bot', ref: { id: 'chat', type: 'group' }, source: ImSourceId('team'),
        }
        await seeded.touchChat(chat)
        const draft: ImMessageDraft = {
          key: ImMessageKey('fake:bot', 'm-pending'),
          chat,
          sender: { id: 'user-1', name: 'User', self: false },
          content: h('message', h.text('/clear')),
          text: '/clear',
          mentions: { self: true, all: false, users: [] },
          addressed: true,
          command: { name: 'clear', rawInput: '' },
          time: 1000,
          via: 'platform',
        }
        await seeded.put(draft, 'pending')
        await seeded.dispose()
      },
    })
    const seen: string[] = []
    // Mounted after the service, which is how a routing plugin or the session command plugin arrives.
    base.ctx.on('im/message', async (event) => {
      seen.push(event.message.key)
      return { kind: 'handled', by: 'probe' }
    })
    await vi.waitFor(() => { expect(service.store.pending()).toHaveLength(0) })
    expect(seen).toEqual([ImMessageKey('fake:bot', 'm-pending')])
  })

  it('holds every dispatch until the Loader that composed it has settled, then dispatches what it stored', async () => {
    // Under a Loader the plugins that listen to `im/message` may start long after the maintenance interval first
    // fires; the Loader settling, not a tick, is what says the composition is complete.
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const { base, bot, service } = await mount({
      retryIntervalMs: 1,
      beforeMount: async (ctx) => { provideByName(ctx, 'loader', { await: () => settled }) },
    })
    const seen: string[] = []
    base.ctx.on('im/message', async (event) => {
      seen.push(event.message.key)
      return { kind: 'handled', by: 'probe' }
    })
    // A frame arriving meanwhile is stored and acknowledged, but nobody hears it yet.
    await deliver(bot, inbound('m-early'))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(service.store.pending()).toHaveLength(1)
    expect(seen).toEqual([])
    settle()
    await vi.waitFor(() => { expect(seen).toEqual([ImMessageKey('fake:bot', 'm-early')]) })
  })

  it('unmounts its service when the plugin is disposed', async () => {
    const { base } = await mount()
    expect(base.ctx.im).toBeDefined()
    await base.ctx.fiber.dispose()
    expect(base.ctx.get('im')).toBeUndefined()
  })

  it('releases the message domain when a later store cannot open', async () => {
    const base = await boot({ withoutStart: true, config: { sources: SOURCES } })
    const ctx = base.ctx
    await ctx.plugin(Satori)
    await ctx.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'bot-user' })
    ctx.provide('attachments', { saveImages: async () => [] } as never)
    // Occupy `im_sessions`: the host opens `im_messages` first and fails on this one.
    const taken = await ctx.storageDomain.open(imSessionsDomain)
    const released = vi.spyOn(ImStore.prototype, 'dispose')

    try {
      await ctx.plugin(ImService, Config({ sources: SOURCES }))
    } catch {
      // A refused load is the scenario; what it leaves behind is what this test pins.
    }
    await vi.waitFor(() => { expect(released).toHaveBeenCalled() })

    // The failed load holds no domain, so the same profile can mount again once the real problem is fixed.
    await expect(ctx.storageDomain.open(imDomain)).resolves.toBeDefined()
    await taken.close()
    released.mockRestore()
  })
})
