/**
 * The IM host plugin as an operator mounts it: `ctx.im`. Per-concern behaviour keeps its own suites; this one pins
 * the service wiring — configuration validation, the `[Service.init]` lifecycle, and the facade methods every other
 * IM plugin calls through `ctx.im`.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PlatformError, Satori, h } from '@deepseek-ai/cordis-plugin-im-core'
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
import { sessionIdOf } from '../src/hosting.ts'
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
async function mount(options: {
  retryIntervalMs?: number
  compositionWarnMs?: number
  maxInputBytes?: number
  platformTimeoutMs?: number
  beforeMount?: (ctx: Context) => Promise<void>
} = {}): Promise<Harness> {
  const retryIntervalMs = options.retryIntervalMs ?? 60_000
  const configPatch = {
    sources: SOURCES,
    retryIntervalMs,
    ...options.compositionWarnMs === undefined ? {} : { compositionWarnMs: options.compositionWarnMs },
    ...options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes },
    ...options.platformTimeoutMs === undefined ? {} : { platformTimeoutMs: options.platformTimeoutMs },
  }
  // `withoutStart` leaves the harness's own sessions host inert: this context hosts exactly one IM service.
  const base = await boot({ withoutStart: true, config: configPatch })
  const ctx = base.ctx
  await ctx.plugin(Satori)
  await ctx.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'bot-user' })
  // The media bridge only reaches attachments for images it stores; the facade never saves one here.
  ctx.provide('attachments', { saveImages: async () => [] } as never)
  await options.beforeMount?.(ctx)
  await ctx.plugin(ImService, Config(configPatch))
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
    // Still unread, failing with Error, or failing with a raw value all leave the stored placeholder readable.
    bot.getMessage = async () => inbound('m1', { content: h('message', h('forward', { id: 'm1' })) })
    expect((await service.readMessage(CHAT, 'm1')).content).toEqual(h('message', h('forward', { id: 'm1' })))
    bot.getMessage = async () => { throw new Error('platform timeout') }
    expect((await service.readMessage(CHAT, 'm1')).seq).toBe(1)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error rejection exercises String(error).
    bot.getMessage = () => Promise.reject('raw expand failure')
    expect((await service.readMessage(CHAT, 'm1')).seq).toBe(1)

    // The store keeps the reference the event carried; the read is what brings its contents.
    bot.getMessage = async () => inbound('m1', {
      content: h('message', h('forward', { id: 'm1' }, h.text('user-1: 原文'))),
    })
    const message = await service.readMessage(CHAT, 'm1')
    expect(message.text).toBe('user-1: 原文')
    expect(message.seq).toBe(1)
  })

  it('enforces admission and adapter capability on readMessage and members', async () => {
    const base = await boot({
      withoutStart: true,
      config: { sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all', users: ['allowed'] }] },
    })
    const ctx = base.ctx
    await ctx.plugin(Satori)
    await ctx.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'bot-user' })
    ctx.provide('attachments', { saveImages: async () => [] } as never)
    await ctx.plugin(ImService, Config({
      sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all', users: ['allowed'] }],
      retryIntervalMs: 60_000,
    }))
    const bot = ctx.bots.find(candidate => candidate instanceof FakeAdapter) as FakeAdapter
    const service = ctx.im
    booted.push({ base, service, bot })

    const unadmitted = ImChatKey('fake:bot', 'unadmitted')
    await expect(service.readMessage(unadmitted, 'm-none')).rejects.toThrow(/was never admitted/)
    await expect(service.members(unadmitted)).rejects.toThrow(/was never admitted/)

    await deliver(bot, inbound('m1', { sender: { id: 'allowed', name: 'Allowed' } }))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })

    await expect(service.readMessage(CHAT, 'm-missing')).rejects.toThrow(/cannot read one message/)
    bot.getMessage = async () => inbound('m-denied', { sender: { id: 'stranger', name: 'Stranger' } })
    await expect(service.readMessage(CHAT, 'm-denied')).rejects.toThrow(/admitted by no source/)

    await expect(service.members(CHAT)).rejects.toThrow(/cannot list the members/)
    bot.members = async (_ref, next, size) => ({ data: [{ id: 'allowed', name: `${next ?? 'first'}:${size ?? 0}` }] })
    await expect(service.members(CHAT, 'p2', 5)).resolves.toEqual({ data: [{ id: 'allowed', name: 'p2:5' }] })
  })

  it('rejects platform readMessage records that exceed maxInputBytes without storing them', async () => {
    const { service, bot } = await mount({ maxInputBytes: 1_000 })
    await deliver(bot, inbound('m1'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })

    bot.getMessage = async () => inbound('m-huge', { content: h('message', h.text('x'.repeat(2_000))) })
    await expect(service.readMessage(CHAT, 'm-huge')).rejects.toMatchObject({ code: 'capacity' })
    expect(service.history.get(ImMessageKey('fake:bot', 'm-huge'))).toBeUndefined()
  })

  it('bounds platform readMessage and members by platformTimeoutMs and AbortSignal', async () => {
    const { service, bot } = await mount({ platformTimeoutMs: 25 })
    await deliver(bot, inbound('m1'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })

    bot.getMessage = () => new Promise(() => {})
    bot.members = () => new Promise(() => {})

    await expect(service.readMessage(CHAT, 'm-slow')).rejects.toMatchObject({ code: 'unavailable' })
    await expect(service.members(CHAT)).rejects.toMatchObject({ code: 'unavailable' })

    const controller = new AbortController()
    const pendingRead = service.readMessage(CHAT, 'm-abort', controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(pendingRead).rejects.toMatchObject({ code: 'unavailable' })

    const preAborted = new AbortController()
    preAborted.abort(new Error('already cancelled'))
    bot.getMessage = () => Promise.reject(new Error('late platform failure'))
    await expect(service.readMessage(CHAT, 'm-pre-aborted', preAborted.signal)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('converts classified platform readMessage and members failures into ImError with cause', async () => {
    const { service, bot } = await mount()
    await deliver(bot, inbound('m1'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })

    const denied = new PlatformError('permission', 'missing roster scope', { code: 99991672 })
    bot.members = () => Promise.reject(denied)
    await expect(service.members(CHAT)).rejects.toMatchObject({ code: 'access', message: 'missing roster scope', cause: denied })

    const rawRateLimit = Object.assign(new Error('too many requests'), { status: 429 })
    bot.classify = () => new PlatformError('rate-limit', 'rate limited by platform', { cause: rawRateLimit })
    bot.getMessage = () => Promise.reject(rawRateLimit)
    await expect(service.readMessage(CHAT, 'm-rate')).rejects.toMatchObject({
      code: 'unavailable', message: 'rate limited by platform', cause: rawRateLimit,
    })

    // Bots without classify() fall back to unavailable with Error.message or String(error).
    Object.defineProperty(bot, 'classify', { value: undefined, configurable: true })
    const plainError = new Error('plain adapter boom')
    bot.getMessage = () => Promise.reject(plainError)
    await expect(service.readMessage(CHAT, 'm-plain')).rejects.toMatchObject({
      code: 'unavailable', message: 'plain adapter boom', cause: plainError,
    })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- covers an adapter that rejects with a non-Error reason
    bot.members = () => Promise.reject('raw string failure')
    await expect(service.members(CHAT)).rejects.toMatchObject({
      code: 'unavailable', message: 'raw string failure', cause: 'raw string failure',
    })
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

  it('keeps the send listener active during teardown so in-flight sends still store their own message', async () => {
    const { base, service, bot } = await mount()
    await deliver(bot, inbound('m1'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })

    let releaseSend!: () => void
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
    let enteredSend!: () => void
    const sendStarted = new Promise<void>((resolve) => { enteredSend = resolve })
    const origSend = bot.sendPayload.bind(bot)
    bot.sendPayload = async (payload, target, sendCtx) => {
      enteredSend()
      await sendGate
      return origSend(payload, target, sendCtx)
    }

    const sending = service.send(CHAT, h('message', h.text('during-teardown')), { operationId: 'op-teardown' })
    await sendStarted
    const disposing = base.ctx.fiber.dispose()
    await Promise.resolve()
    releaseSend()

    const [result] = await Promise.all([sending, disposing])
    expect(result.status).toBe('confirmed')
    expect(result.message?.text).toBe('during-teardown')
    expect(result.message?.seq).toBe(2)
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
    const { base, bot, service } = await mount()
    const handled: string[] = []
    base.ctx.on('im/message', async (event: ImMessageEvent): Promise<ImOutcome> => {
      handled.push(event.message.key)
      const tag = event.message.key
      if (tag === ImMessageKey('fake:bot', 'm2')) {
        // Simulate the trigger being evicted from store before `event.reply` runs: reply still sends without quote.
        vi.spyOn(service.store, 'get').mockReturnValueOnce(undefined)
      }
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
    const { base, service, bot } = await mount({ retryIntervalMs: 20 })
    const warnings: string[] = []
    vi.spyOn(base.ctx.logger, 'warn').mockImplementation((fmt: unknown) => { warnings.push(String(fmt)) })
    const sweeps: number[] = []
    const sweep = service.store.sweep.bind(service.store)
    let failedSweep = false
    vi.spyOn(service.store, 'sweep').mockImplementation(async (now) => {
      sweeps.push(now)
      if (!failedSweep) {
        failedSweep = true
        throw new Error('sweep glitch')
      }
      return sweep(now)
    })
    // One maintenance tick re-pumps the intake, retries deliveries and logs a failed sweep without crashing.
    await vi.waitFor(() => { expect(sweeps.length).toBeGreaterThan(1) })
    expect(warnings.some(msg => msg.includes('IM store sweep failed'))).toBe(true)

    vi.spyOn(service.intake, 'outbound').mockRejectedValueOnce(new Error('outbound glitch'))
    await service.send(CHAT, h('message', h.text('probe'))).catch(() => {})
    base.ctx.emit('send', bot, await bot.send({ chat: { id: 'chat', type: 'group' } }, h('message', h.text('probe'))))
    await vi.waitFor(() => { expect(warnings.some(msg => msg.includes('IM outbound message of bot'))).toBe(true) })
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

  it('holds persisted delivery recovery alongside intake until the Loader settles, with IM tools registered', async () => {
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const key = `conv:${CHAT}`
    const sessionId = sessionIdOf(key, 0)
    const { base, service } = await mount({
      retryIntervalMs: 1,
      beforeMount: async (ctx) => {
        provideByName(ctx, 'loader', { await: () => settled })
        ctx.provide('fs', { resolve: async () => ({}), processPath: () => '', writeBytes: async () => ({}) } as never)
        ctx.provide('workingDirectory', { ensure: async () => process.cwd() } as never)
        const domain = await ctx.storageDomain.open(imSessionsDomain)
        await domain.table('sessions').put(key, {
          key,
          owner: 'conversation',
          sessionId,
          generation: 0,
          composition: COMPOSITION,
          bindings: [{ chat: CHAT, writable: true, home: true }],
          createdAt: 1000,
          lastActiveAt: 1000,
        })
        await domain.table('deliveries').put(`${sessionId}|evt-recover`, {
          session: sessionId,
          delivery: { id: 'evt-recover', mode: 'followup', content: [{ type: 'text', text: 'recover me' }] },
          createdAt: 1000,
          admitted: false,
        })
        await domain.close()
      },
    })

    await new Promise(resolve => setTimeout(resolve, 30))
    expect(service.sessions.pendingDeliveries()).toBe(1)
    expect(base.model.requests).toEqual([])

    settle()
    await vi.waitFor(() => { expect(base.model.requests).toHaveLength(1) })
    const agent = await service.sessions.agent(sessionId)
    await agent.whenIdle()
    await service.sessions.whenRecovered()
    expect(service.sessions.pendingDeliveries()).toBe(0)
    expect(base.model.promptText(0)).toContain('recover me')
    const toolNames = (base.model.requests[0]?.tools ?? []).map(tool => tool.name)
    expect(toolNames).toContain('im_send')
    expect(toolNames).toContain('im_read_file')
  })

  it('warns when the Loader stays unsettled past compositionWarnMs and releases when it rejects', async () => {
    let rejectSettled!: (error: Error) => void
    const settled = new Promise<void>((_resolve, reject) => { rejectSettled = reject })
    const warnings: string[] = []
    const { base, bot } = await mount({
      compositionWarnMs: 10,
      beforeMount: async (ctx) => {
        vi.spyOn(ctx.logger, 'warn').mockImplementation((fmt: unknown) => { warnings.push(String(fmt)) })
        provideByName(ctx, 'loader', { await: () => settled })
      },
    })
    const seen: string[] = []
    base.ctx.on('im/message', async (event) => {
      seen.push(event.message.key)
      return { kind: 'handled', by: 'probe' }
    })
    await deliver(bot, inbound('m-warn'))
    await vi.waitFor(() => {
      expect(warnings.some(msg => msg.includes('still waiting after %dms'))).toBe(true)
    })
    expect(seen).toEqual([])

    rejectSettled(new Error('plugin hang'))
    await vi.waitFor(() => { expect(seen).toEqual([ImMessageKey('fake:bot', 'm-warn')]) })
    expect(warnings.some(msg => msg.includes('although the composition did not settle'))).toBe(true)

    // Non-Loader values under the `loader` service name release immediately like a hand-composed context.
    const nonObject = await mount({ beforeMount: async (ctx) => { provideByName(ctx, 'loader', null) } })
    const nonLoader = await mount({ beforeMount: async (ctx) => { provideByName(ctx, 'loader', {}) } })
    expect(nonObject.service.status().sources).toHaveLength(1)
    expect(nonLoader.service.status().sources).toHaveLength(1)
  })

  it('gates satori/receive while storage domains are opening and rejects frames when startup fails', async () => {
    const base = await boot({ withoutStart: true, config: { sources: SOURCES } })
    const ctx = base.ctx
    await ctx.plugin(Satori)
    await ctx.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'bot-user' })
    ctx.provide('attachments', { saveImages: async () => [] } as never)
    const bot = ctx.bots.find(candidate => candidate instanceof FakeAdapter) as FakeAdapter

    const realOpen = ctx.storageDomain.open.bind(ctx.storageDomain)
    let enteredOpen!: () => void
    const entered = new Promise<void>((resolve) => { enteredOpen = resolve })
    let releaseOpen!: () => void
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve })
    const openSpy = vi.spyOn(ctx.storageDomain, 'open').mockImplementationOnce(async (spec) => {
      enteredOpen()
      await openGate
      return realOpen(spec)
    })

    const mounting = ctx.plugin(ImService, Config({ sources: SOURCES }))
    await entered

    let acked = false
    const receiving = deliver(bot, inbound('m-during-open')).then(() => { acked = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(acked).toBe(false)

    releaseOpen()
    await Promise.all([mounting, receiving])
    expect(acked).toBe(true)
    expect(ctx.im.store.get(ImMessageKey('fake:bot', 'm-during-open'))?.text).toBe('hello m-during-open')
    openSpy.mockRestore()
    await base.close()

    // When domain startup fails, any frame waiting on the receive gate rejects rather than acknowledging unstored input.
    const failedBase = await boot({ withoutStart: true, config: { sources: SOURCES } })
    const failedCtx = failedBase.ctx
    await failedCtx.plugin(Satori)
    await failedCtx.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'bot-user' })
    failedCtx.provide('attachments', { saveImages: async () => [] } as never)
    const failedBot = failedCtx.bots.find(candidate => candidate instanceof FakeAdapter) as FakeAdapter
    let enteredFail!: () => void
    const failEntered = new Promise<void>((resolve) => { enteredFail = resolve })
    let rejectOpen!: (error: Error) => void
    const failGate = new Promise<never>((_resolve, reject) => { rejectOpen = reject })
    vi.spyOn(failedCtx.storageDomain, 'open').mockImplementationOnce(async () => {
      enteredFail()
      return failGate
    })

    const failingMount = failedCtx.plugin(ImService, Config({ sources: SOURCES }))
    await failEntered
    const failingReceive = deliver(failedBot, inbound('m-failed-open'))
    rejectOpen(new Error('disk offline'))

    await expect(failingMount).rejects.toThrow(/disk offline/)
    await expect(failingReceive).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'disk offline' })],
    })
    await failedBase.close()
  })

  it('cancels pending composition release and suppresses recovery when disposed before the Loader settles', async () => {
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const key = `conv:${CHAT}`
    const sessionId = sessionIdOf(key, 0)
    const first = await mount({
      beforeMount: async (ctx) => {
        provideByName(ctx, 'loader', { await: () => settled })
        const domain = await ctx.storageDomain.open(imSessionsDomain)
        await domain.table('sessions').put(key, {
          key,
          owner: 'conversation',
          sessionId,
          generation: 0,
          composition: COMPOSITION,
          bindings: [{ chat: CHAT, writable: true, home: true }],
          createdAt: 1000,
          lastActiveAt: 1000,
        })
        await domain.table('deliveries').put(`${sessionId}|evt-teardown`, {
          session: sessionId,
          delivery: { id: 'evt-teardown', mode: 'followup', content: [{ type: 'text', text: 'do not run' }] },
          createdAt: 1000,
          admitted: false,
        })
        await domain.close()
      },
    })
    const disposing = first.base.ctx.fiber.dispose()
    settle()
    await disposing
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(first.base.model.requests).toEqual([])

    let rejectSettled!: (error: Error) => void
    const rejected = new Promise<void>((_resolve, reject) => { rejectSettled = reject })
    const warnings: string[] = []
    const second = await mount({
      beforeMount: async (ctx) => {
        vi.spyOn(ctx.logger, 'warn').mockImplementation((fmt: unknown) => { warnings.push(String(fmt)) })
        provideByName(ctx, 'loader', { await: () => rejected })
      },
    })
    const disposingSecond = second.base.ctx.fiber.dispose()
    rejectSettled(new Error('teardown'))
    await disposingSecond
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(warnings.some(msg => msg.includes('although the composition did not settle'))).toBe(false)
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
    } catch (_refusedLoad) {
      // A refused load is the scenario; what it leaves behind is what this test pins.
    }
    await vi.waitFor(() => { expect(released).toHaveBeenCalled() })

    // The failed load holds no domain, so the same profile can mount again once the real problem is fixed.
    await expect(ctx.storageDomain.open(imDomain)).resolves.toBeDefined()
    await taken.close()
    released.mockRestore()
  })

  it('drains in-flight session admissions before disposing hosted agents on shutdown and warns on secondary release errors', async () => {
    const base = await boot({ withoutStart: true, config: { sources: SOURCES } })
    const ctx = base.ctx
    await ctx.plugin(Satori)
    await ctx.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'bot-user' })
    ctx.provide('attachments', { saveImages: async () => [] } as never)
    const imFiber = await ctx.plugin(ImService, Config({ sources: SOURCES }))
    const service = ctx.im
    const bot = ctx.bots.find(candidate => candidate instanceof FakeAdapter) as FakeAdapter

    await deliver(bot, inbound('m-drain'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })
    const msg = service.history.get(ImMessageKey('fake:bot', 'm-drain'))!
    const record = await service.sessions.ensure({
      key: 'drain-test',
      owner: 'test',
      composition: COMPOSITION,
      bindings: [{ chat: CHAT, writable: true }],
    })

    let enteredCreate!: () => void
    const createEntered = new Promise<void>((resolve) => { enteredCreate = resolve })
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    const realCreate = ctx.agents.create.bind(ctx.agents)
    vi.spyOn(ctx.agents, 'create').mockImplementationOnce(async (opts) => {
      const handle = await realCreate(opts)
      enteredCreate()
      await createGate
      return handle
    })

    const warnings: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation((fmt: unknown) => { warnings.push(String(fmt)) })
    vi.spyOn(service.outputs, 'dispose').mockRejectedValueOnce(new Error('outputs close glitch'))

    const delivering = service.sessions.deliver(record.sessionId, { id: 'del-drain', mode: 'followup', content: [msg] })
    await createEntered
    expect(ctx.agents.get(record.sessionId)).toBeDefined()

    const disposing = imFiber.dispose()
    releaseCreate()
    await Promise.allSettled([delivering, disposing])

    // `sessions.dispose()` drained `deliver` before `agentHost.disposeAll()` ran, so the newly created agent was closed.
    expect(ctx.agents.get(record.sessionId)).toBeUndefined()
    expect(warnings.some(line => line.includes('IM shutdown left'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('closes opened domains and rejects buffered satori/receive frames when unloaded while startup is still awaiting storage', async () => {
    const base = await boot({ withoutStart: true, config: { sources: SOURCES } })
    const ctx = base.ctx
    await ctx.plugin(Satori)
    await ctx.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'bot-user' })
    ctx.provide('attachments', { saveImages: async () => [] } as never)
    const bot = ctx.bots.find(candidate => candidate instanceof FakeAdapter) as FakeAdapter

    const realOpen = ctx.storageDomain.open.bind(ctx.storageDomain)
    let enteredReceiptsOpen!: () => void
    const receiptsOpenEntered = new Promise<void>((resolve) => { enteredReceiptsOpen = resolve })
    let releaseReceiptsOpen!: () => void
    const receiptsOpenGate = new Promise<void>((resolve) => { releaseReceiptsOpen = resolve })
    let blockReceiptsOnce = true
    vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (spec) => {
      const opened = await realOpen(spec)
      if (blockReceiptsOnce && spec.name === 'im_receipts') {
        blockReceiptsOnce = false
        enteredReceiptsOpen()
        await receiptsOpenGate
      }
      return opened
    })

    const sub = ctx.plugin(ImService, Config({ sources: SOURCES }))
    await receiptsOpenEntered
    const earlyReceive = deliver(bot, inbound('m-during-cancel'))
    const earlyRejected = expect(earlyReceive).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'The IM service was disposed before startup finished.' })],
    })

    const disposing = sub.dispose()
    releaseReceiptsOpen()
    await Promise.all([disposing, earlyRejected])

    // Every domain opened before cancellation (`im_messages`, `im_sessions`, `im_receipts`) was closed cleanly.
    const remounted = await ctx.plugin(ImService, Config({ sources: SOURCES }))
    expect(ctx.im).toBeDefined()
    await remounted.dispose()
    await ctx.fiber.dispose()
  })

  it('drains in-flight outbound announcements before closing the message store during teardown', async () => {
    const { base, bot, service } = await mount()
    await deliver(bot, inbound('m-admit'))
    await vi.waitFor(() => { expect(service.chat(CHAT)).toBeDefined() })

    let enteredPut!: () => void
    const putEntered = new Promise<void>((resolve) => { enteredPut = resolve })
    let releasePut!: () => void
    const putGate = new Promise<void>((resolve) => { releasePut = resolve })
    const originalPut = service.store.put.bind(service.store)
    vi.spyOn(service.store, 'put').mockImplementationOnce(async (...args) => {
      enteredPut()
      await putGate
      return await originalPut(...args)
    })

    // Trigger an announcement via `bot.send()` directly so `sender.dispose()` has no pending dispatch/settlement
    // waiting on it — only `intake.drainAnnouncements()` keeps `store.dispose()` from closing the domain early.
    const directSend = bot.send({ chat: { id: 'chat', type: 'group' } }, h('message', h.text('direct-bot-send')))
    await putEntered
    const disposing = base.ctx.fiber.dispose()
    releasePut()
    await Promise.all([directSend, disposing])

    expect(base.pool.media.get('im_messages')?.tables.get('messages')?.size).toBe(2)
  })
})
