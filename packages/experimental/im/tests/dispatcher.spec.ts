/**
 * The default dispatcher (`config.defaultDispatch`): the innermost `im/message` listener that hands every addressed,
 * otherwise unhandled message to one shared hosted session, with a chat header and per-chat bindings.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Satori, h } from '@deepseek-ai/cordis-plugin-im-core'
import type { InboundMessage } from '@deepseek-ai/cordis-plugin-im-core'
import { createTextMode, FakeAdapter } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ImChatKey, ImMessageKey, ImSourceId, type ImConfig, type ImMessageEvent, type ImOutcome } from '../src/api.ts'
import { Config, DEFAULT_DISPATCHER_PROMPT } from '../src/config.ts'
import { chatHeader, DISPATCHER_KEY, DISPATCHER_OWNER, ImDispatcher } from '../src/dispatcher.ts'
import { ImError } from '../src/error.ts'
import { ImService } from '../src/index.ts'
import { boot, cleanRoots, COMPOSITION, insertions, type SessionsHarness } from './support/sessions-harness.ts'

const GROUP = ImChatKey('fake:bot', 'chat')
const DIRECT = ImChatKey('fake:bot', 'dm')
const SOURCES: ImConfig['sources'] = [
  { id: 'team', bot: 'fake:bot', chats: ['chat'], writable: true, store: 'all' },
  { id: 'readers', bot: 'fake:bot', writable: false, store: 'all' },
]
const DISPATCHER = {
  agentPreset: COMPOSITION.agentPreset, provider: COMPOSITION.provider, model: COMPOSITION.model, cwd: COMPOSITION.cwd,
}

interface Harness {
  base: SessionsHarness
  service: ImService
  bot: FakeAdapter
}

const booted: Harness[] = []

/** Boot the real IM service over the sessions harness, optionally with a dispatcher. */
async function mount(dispatcher?: Record<string, unknown>): Promise<Harness> {
  const base = await boot({ withoutStart: true, config: { sources: SOURCES, retryIntervalMs: 60_000 } })
  const ctx = base.ctx
  await ctx.plugin(Satori)
  await ctx.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'bot-user' })
  ctx.provide('attachments', { saveImages: async () => [] } as never)
  await ctx.plugin(ImService, Config({
    sources: SOURCES, retryIntervalMs: 60_000, ...dispatcher === undefined ? {} : { defaultDispatch: dispatcher },
  }))
  const bot = ctx.bots.find(candidate => candidate instanceof FakeAdapter) as FakeAdapter
  const harness: Harness = { base, service: ctx.im, bot }
  booted.push(harness)
  return harness
}

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

function deliver(bot: FakeAdapter, message: InboundMessage): Promise<void> {
  return bot.receive(bot.session({ type: 'message', id: message.id, timestamp: message.time, message }))
}

/** The outcome the store recorded for one message, once dispatch settled. */
async function outcomeOf(service: ImService, id: string): Promise<ImOutcome | undefined> {
  const key = ImMessageKey('fake:bot', id)
  await vi.waitFor(() => { expect(service.store.state(key)?.dispatch).toBe('done') }, { timeout: 5_000 })
  return service.store.state(key)?.outcome
}

afterEach(async () => {
  for (const harness of booted.splice(0)) await harness.base.ctx.fiber.dispose().catch(() => {})
})

afterAll(cleanRoots)

describe('default dispatcher configuration', () => {
  it('is absent by default and fills its defaults when configured', () => {
    expect(Config({}).defaultDispatch).toBeUndefined()
    expect(Config({ defaultDispatch: DISPATCHER }).defaultDispatch).toEqual({
      ...DISPATCHER, output: 'none', delivery: 'steer',
      prompt: { name: 'im:dispatcher', order: 81, text: DEFAULT_DISPATCHER_PROMPT },
    })
  })

  it('refuses a dispatcher without a composition field or with a relative cwd', () => {
    expect(() => Config({ defaultDispatch: { agentPreset: 'im' } })).toThrow()
    const config = Config({ defaultDispatch: { ...DISPATCHER, cwd: 'relative/dir' } }).defaultDispatch!
    expect(() => new ImDispatcher(config, { ensure: vi.fn(), get: vi.fn(), of: vi.fn(), deliveredTo: vi.fn() })).toThrow(ImError)
  })
})

describe('default dispatcher', () => {
  it('ignores an unhandled message when no dispatcher is configured', async () => {
    const { service, bot } = await mount()
    expect(service.dispatcher).toBeUndefined()
    await deliver(bot, inbound('m1'))
    expect(await outcomeOf(service, 'm1')).toEqual({ kind: 'ignored' })
    expect(service.sessions.list()).toEqual([])
  })

  it('hands addressed messages of every chat to one session that accumulates its bindings', async () => {
    const { base, service, bot } = await mount({ ...DISPATCHER, output: 'probe', restrict: { allow: ['im_send'] } })
    await deliver(bot, inbound('m1'))
    const first = await outcomeOf(service, 'm1')
    const record = service.sessions.get(DISPATCHER_KEY)!
    expect(record.owner).toBe(DISPATCHER_OWNER)
    expect(record.output).toBe('probe')
    expect(record.composition).toEqual({ ...COMPOSITION, restrict: { allow: ['im_send'], deny: [] } })
    expect(first).toEqual({ kind: 'handled', by: DISPATCHER_OWNER, sessions: [record.sessionId] })
    expect(record.bindings).toEqual([{ chat: GROUP, writable: true, home: true }])

    // A direct chat always addresses the bot; its read-only source keeps the new binding read-only.
    await deliver(bot, inbound('m2', { chat: { id: 'dm', type: 'direct' }, mentions: { self: false, all: false, users: [] } }))
    expect(await outcomeOf(service, 'm2')).toEqual({ kind: 'handled', by: DISPATCHER_OWNER, sessions: [record.sessionId] })
    expect(service.sessions.get(DISPATCHER_KEY)?.bindings).toEqual([
      { chat: GROUP, writable: true, home: true },
      { chat: DIRECT, writable: false },
    ])
    expect(service.sessions.list({ owner: DISPATCHER_OWNER })).toHaveLength(1)

    // A chat it already serves keeps its one binding.
    await deliver(bot, inbound('m3'))
    await outcomeOf(service, 'm3')
    expect(service.sessions.get(DISPATCHER_KEY)?.bindings).toHaveLength(2)

    // Each delivered message carries the header naming its chat.
    await vi.waitFor(async () => { expect(await insertions(base, record.sessionId)).toHaveLength(3) })
    const texts = (await insertions(base, record.sessionId))
      .map(message => message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join(''))
    const group = service.chat(GROUP)!
    expect(texts[0]?.startsWith(`${chatHeader(group)}\n<im-message`)).toBe(true)
    expect(texts[1]?.startsWith('<im-chat key="fake:bot|dm" source="readers" type="direct" />\n')).toBe(true)
  })

  it('leaves own, unaddressed and already handled messages alone', async () => {
    const { base, service, bot } = await mount(DISPATCHER)
    await deliver(bot, inbound('m1', { mentions: { self: false, all: false, users: [] } }))
    expect(await outcomeOf(service, 'm1')).toEqual({ kind: 'ignored' })

    base.ctx.on('im/message', async (event: ImMessageEvent, next): Promise<ImOutcome> =>
      (event.message.text.includes('claimed') ? { kind: 'handled', by: 'spec' } : next()))
    await deliver(bot, inbound('m2', { content: h('message', h.text('claimed')) }))
    expect(await outcomeOf(service, 'm2')).toEqual({ kind: 'handled', by: 'spec' })
    expect(service.sessions.get(DISPATCHER_KEY)).toBeUndefined()

    // The intake never stores the bot's own platform echo, so an own message only reaches the listener directly.
    const own = service.store.get(ImMessageKey('fake:bot', 'm1'))!
    const self = { message: { ...own, addressed: true, sender: { ...own.sender, self: true } } } as ImMessageEvent
    expect(await service.dispatcher!.handle(self)).toEqual({ kind: 'ignored' })
  })

  it('renders its prompt section for the dispatcher session only', async () => {
    const { base, service, bot } = await mount({ ...DISPATCHER, prompt: { text: 'dispatcher guidance' } })
    await deliver(bot, inbound('m1'))
    await outcomeOf(service, 'm1')
    const dispatcher = await service.sessions.agent(DISPATCHER_KEY)
    const other = await service.sessions.ensure({
      key: `conversation:${GROUP}`, owner: 'conversation', composition: COMPOSITION,
      bindings: [{ chat: GROUP, writable: true, home: true }],
    })
    const conversation = await service.sessions.agent(other.sessionId)
    const prompt = async (agent: typeof dispatcher) => renderPrompt(await base.ctx.systemPrompt.assemble({ agent }))
    expect(await prompt(dispatcher)).toContain('dispatcher guidance')
    expect(await prompt(conversation)).not.toContain('dispatcher guidance')
    expect(service.dispatcher!.guidance(undefined)).toBe('')
  })

  it('keeps a message pending while its session key belongs to another owner', async () => {
    const { service, bot } = await mount(DISPATCHER)
    await service.sessions.ensure({ key: DISPATCHER_KEY, owner: 'squatter', composition: COMPOSITION, bindings: [] })
    await deliver(bot, inbound('m1'))
    await service.intake.idle()
    expect(service.store.state(ImMessageKey('fake:bot', 'm1'))?.dispatch).toBe('pending')

    // A failed binding update does not block the next one: each call reports the conflict again.
    const own = service.store.get(ImMessageKey('fake:bot', 'm1'))!
    const event = { message: own, source: SOURCES[0]! } as ImMessageEvent
    await expect(service.dispatcher!.handle(event)).rejects.toThrow(ImError)
    await expect(service.dispatcher!.handle(event)).rejects.toThrow(/belongs to squatter/)
  })

  it('does not re-deliver an already admitted message into a newer generation after reset', async () => {
    const { service, bot } = await mount(DISPATCHER)
    expect(service.sessions.deliveredTo('unhosted', 'm-none')).toBeUndefined()

    await deliver(bot, inbound('m1'))
    await outcomeOf(service, 'm1')
    const gen0 = service.sessions.get(DISPATCHER_KEY)!.sessionId

    await service.sessions.reset(DISPATCHER_KEY, 'clear')
    const gen1 = service.sessions.get(DISPATCHER_KEY)!.sessionId
    expect(gen1).not.toBe(gen0)

    const stored = service.store.get(ImMessageKey('fake:bot', 'm1'))!
    const deliverSpy = vi.fn().mockResolvedValue(undefined)
    const retry = await service.dispatcher!.handle({
      message: stored, source: SOURCES[0]!, bot, reply: vi.fn(), send: vi.fn(), deliver: deliverSpy,
    })
    expect(retry).toEqual({ kind: 'handled', by: DISPATCHER_OWNER, sessions: [gen0] })
    expect(deliverSpy).not.toHaveBeenCalled()
  })
})

describe('chatHeader', () => {
  it('escapes the attributes it names', () => {
    const chat = { key: ImChatKey('fake:bot', 'a"b'), bot: 'fake:bot', ref: { id: 'a"b', type: 'group' as const }, source: ImSourceId('<s>') }
    expect(chatHeader(chat)).toBe('<im-chat key="fake:bot|a&quot;b" source="&lt;s&gt;" type="group" />')
  })
})
