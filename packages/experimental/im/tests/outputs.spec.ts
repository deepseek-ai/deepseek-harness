/** Output renderer registry: begin/update/end lifecycle, eligibility, io attribution and button routing. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createTextMode, mountFakeAdapter } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import {
  ImChatKey, ImMessageKey,
  type ImActivity, type ImActivityChange, type ImOutputIO, type ImOutputRenderer, type ImTurnOutput,
} from '../src/api.ts'
import { Config } from '../src/config.ts'
import { ImError } from '../src/error.ts'
import { ImOutputRegistry, NO_OUTPUT, type ImOutputDeps } from '../src/outputs.ts'
import { ImSender } from '../src/send.ts'
import { ImStore } from '../src/store.ts'
import {
  activity, BOT, chatOf, click, flush, inbound, inboundDraft, noClick, OutputsHarness, pick, rawReaction, react, record,
  toggle,
} from './support/outputs-harness.ts'

const open: OutputsHarness[] = []

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

/** Boot one registry harness and remember it for teardown. */
function booted(): OutputsHarness {
  const harness = new OutputsHarness()
  open.push(harness)
  return harness
}

/** A renderer that records every call it receives. */
class Probe implements ImOutputRenderer {
  readonly id = 'probe'
  readonly calls: string[] = []
  readonly seen: ImActivity[] = []
  readonly ios: ImOutputIO[] = []
  /** Fail the `end` call. */
  fail = false
  /** Fail the `update` call. */
  failUpdate = false

  begin(activity: ImActivity, io: ImOutputIO): ImTurnOutput {
    this.calls.push(`begin:${activity.turn}`)
    this.seen.push(activity)
    this.ios.push(io)
    return {
      update: (updated: ImActivity, change: ImActivityChange): void => {
        this.calls.push(`update:${change}`)
        this.seen.push(updated)
        if (this.failUpdate) throw new Error('update failed')
      },
      end: async (final: ImActivity): Promise<void> => {
        this.calls.push(`end:${final.status}`)
        this.seen.push(final)
        if (this.fail) throw new Error('end failed')
      },
    }
  }
}

describe('ImOutputRegistry lifecycle', () => {
  it('begins, updates and ends the turn of the session renderer', async () => {
    const harness = booted()
    const probe = new Probe()
    harness.registry.register(probe)
    const hosted = harness.host({ output: 'probe' })
    const trigger = inbound('thread-1')

    harness.messages.set(trigger.key, trigger)
    harness.ctx.emit('im/activity', activity(hosted, { trigger }), 'start')
    await flush()
    expect(probe.calls).toEqual(['begin:1'])
    expect(probe.seen[0]?.trigger).toBe(trigger)

    const delta = activity(hosted, { trigger, segments: [{ kind: 'text', text: 'hi' }], updatedAt: 11 })
    harness.ctx.emit('im/activity', delta, 'delta')
    harness.ctx.emit('im/activity', { ...delta, status: 'done', updatedAt: 12 }, 'end')
    await flush()
    expect(probe.calls).toEqual(['begin:1', 'update:delta', 'end:done'])

    // The per-turn io sends into the home chat, quoting the turn's trigger and attributing the session.
    const io = probe.ios[0]!
    expect(io.chat).toBe(hosted.bindings[0]!.chat)
    await io.send('hello')
    await io.stream({ intervalMs: 100 })
    expect(harness.sender.sends).toEqual([{
      chat: hosted.bindings[0]!.chat, content: 'hello', options: { session: hosted.sessionId, quote: trigger.key, thread: 'thread-1' },
    }])
    expect(harness.sender.streams).toEqual([{
      chat: hosted.bindings[0]!.chat,
      options: { session: hosted.sessionId, quote: trigger.key, thread: 'thread-1', intervalMs: 100 },
    }])
  })

  it('omits the thread of a thread-less trigger and every quote of a trigger-less turn', async () => {
    const harness = booted()
    const probe = new Probe()
    harness.registry.register(probe)
    const hosted = harness.host({ output: 'probe' })
    harness.ctx.emit('im/activity', activity(hosted), 'start')
    await flush()

    await probe.ios[0]!.send('hi')
    expect(harness.sender.sends[0]?.options).toEqual({ session: hosted.sessionId })

    // A trigger outside a thread is quoted without a thread of its own.
    const top = inbound()
    harness.messages.set(top.key, top)
    harness.ctx.emit('im/activity', activity(hosted, { turn: 2, trigger: top }), 'start')
    await flush()
    await probe.ios[1]!.send('hello')
    expect(harness.sender.sends[1]?.options).toEqual({ session: hosted.sessionId, quote: top.key })

    // If the trigger is evicted from history before or during the turn, `quote` is omitted rather than failing with access.
    harness.messages.delete(top.key)
    await probe.ios[1]!.send('after-eviction')
    expect(harness.sender.sends[2]?.options).toEqual({ session: hosted.sessionId })
  })

  it('renders nothing for `none`, an unknown renderer or no writable home binding', async () => {
    const harness = booted()
    const probe = new Probe()
    harness.registry.register(probe)

    const plain = harness.host({ sessionId: SessionId('im-no-output') })
    const off = harness.host({ sessionId: SessionId('im-off'), key: 'conv:off', output: NO_OUTPUT })
    const unknown = harness.host({ sessionId: SessionId('im-unknown'), key: 'conv:unknown', output: 'missing' })
    const noHome = harness.host({
      sessionId: SessionId('im-no-home'), key: 'conv:no-home', output: 'probe',
      bindings: [{ chat: chatOf().key, writable: true }],
    })

    for (const hosted of [plain, off, unknown, noHome]) {
      harness.ctx.emit('im/activity', activity(hosted), 'start')
      harness.ctx.emit('im/activity', activity(hosted, { status: 'done' }), 'end')
    }
    await flush()
    expect(probe.calls).toEqual([])
  })

  it('survives a renderer that cannot begin or end', async () => {
    const harness = booted()
    const broken: ImOutputRenderer = {
      id: 'broken',
      begin: () => { throw new Error('begin failed') },
    }
    harness.registry.register(broken)
    const failing = harness.host({ output: 'broken' })
    harness.ctx.emit('im/activity', activity(failing), 'start')
    harness.ctx.emit('im/activity', activity(failing, { status: 'done' }), 'end')
    await flush()
    expect(harness.sender.sends).toEqual([])

    const probe = new Probe()
    probe.fail = true
    harness.registry.register(probe)
    const hosted = harness.host({ sessionId: SessionId('im-2'), key: 'conv:2', output: 'probe' })
    harness.ctx.emit('im/activity', activity(hosted), 'start')
    harness.ctx.emit('im/activity', activity(hosted, { status: 'done' }), 'end')
    await flush()
    expect(probe.calls).toEqual(['begin:1', 'end:done'])

    const stringFail: ImOutputRenderer = {
      id: 'string-fail',
      begin: () => ({
        update: () => {},
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error rejection exercises String(error).
        end: () => Promise.reject('raw end failure'),
      }),
    }
    harness.registry.register(stringFail)
    const hostedRaw = harness.host({ sessionId: SessionId('im-3'), key: 'conv:3', output: 'string-fail' })
    harness.ctx.emit('im/activity', activity(hostedRaw), 'start')
    harness.ctx.emit('im/activity', activity(hostedRaw, { status: 'done' }), 'end')
    await flush()
  })

  it('reports a renderer that fails an update and keeps the turn open', async () => {
    const harness = booted()
    const probe = new Probe()
    probe.failUpdate = true
    harness.registry.register(probe)
    const hosted = harness.host({ output: 'probe' })

    harness.ctx.emit('im/activity', activity(hosted), 'start')
    await flush()
    harness.ctx.emit('im/activity', activity(hosted, { updatedAt: 11 }), 'delta')
    await flush()
    expect(probe.calls).toEqual(['begin:1', 'update:delta'])

    // The failure is reported per change: the turn still ends.
    harness.ctx.emit('im/activity', activity(hosted, { status: 'done' }), 'end')
    await flush()
    expect(probe.calls).toEqual(['begin:1', 'update:delta', 'end:done'])
  })

  it('ignores a change of a turn it never started and settles a superseded turn', async () => {
    const harness = booted()
    const probe = new Probe()
    harness.registry.register(probe)
    const hosted = harness.host({ output: 'probe' })

    harness.ctx.emit('im/activity', activity(hosted, { segments: [{ kind: 'text', text: 'orphan' }] }), 'delta')
    await flush()
    expect(probe.calls).toEqual([])

    harness.ctx.emit('im/activity', activity(hosted), 'start')
    harness.ctx.emit('im/activity', activity(hosted, { turn: 2 }), 'start')
    await flush()
    expect(probe.calls).toEqual(['begin:1', 'end:running', 'begin:2'])
  })

  it('ends every open turn on dispose', async () => {
    const harness = booted()
    const probe = new Probe()
    harness.registry.register(probe)
    const hosted = harness.host({ output: 'probe' })
    harness.ctx.emit('im/activity', activity(hosted), 'start')
    await flush()

    await harness.registry.dispose()
    expect(probe.calls).toEqual(['begin:1', 'end:running'])
  })

  it('renders into the chat of the trigger when the session may write there, and nowhere otherwise', async () => {
    const harness = booted()
    const probe = new Probe()
    harness.registry.register(probe)
    const home = chatOf()
    const other = chatOf('other')
    const quiet = chatOf('quiet')
    const hosted = harness.host({
      output: 'probe',
      bindings: [
        { chat: home.key, writable: true, home: true },
        { chat: other.key, writable: true, thread: 'topic-9' },
        { chat: quiet.key, writable: false },
      ],
    })

    // A writable binding of the trigger's chat wins: the trigger is quoted inside that binding's thread.
    const elsewhere = { ...inbound(), key: ImMessageKey(BOT.id, 'm-other'), chat: other }
    harness.messages.set(elsewhere.key, elsewhere)
    harness.ctx.emit('im/activity', activity(hosted, { trigger: elsewhere }), 'start')
    await flush()
    expect(probe.ios[0]?.chat).toBe(other.key)
    await probe.ios[0]!.send('there')
    expect(harness.sender.sends[0]).toEqual({
      chat: other.key, content: 'there', options: { session: hosted.sessionId, quote: elsewhere.key, thread: 'topic-9' },
    })

    // A trigger chat the session cannot write to renders nothing: another chat's turn is not published into the home
    // chat, whose readers never asked for it and cannot attribute it.
    const readOnly = { ...inbound(), key: ImMessageKey(BOT.id, 'm-quiet'), chat: quiet }
    harness.ctx.emit('im/activity', activity(hosted, { turn: 2, trigger: readOnly }), 'start')
    await flush()
    expect(probe.ios).toHaveLength(1)
    expect(harness.sender.sends).toHaveLength(1)

    // A turn without a trigger renders into the home binding.
    harness.ctx.emit('im/activity', activity(hosted, { turn: 3 }), 'start')
    await flush()
    expect(probe.ios[1]?.chat).toBe(home.key)
    await probe.ios[1]!.send('home')
    expect(harness.sender.sends[1]).toEqual({ chat: home.key, content: 'home', options: { session: hosted.sessionId } })
  })

  it('registers each renderer id once and unregisters it through the disposer', () => {
    const harness = booted()
    const probe = new Probe()
    const undo = harness.registry.register(probe)
    expect(harness.registry.get('probe')).toBe(probe)
    expect(() => harness.registry.register(probe)).toThrow(ImError)
    expect(() => harness.registry.register(probe)).toThrow(/already registered/)
    expect(() => harness.registry.register({ id: NO_OUTPUT, begin: () => { throw new Error('unused') } }))
      .toThrow(/reserved/)
    expect(() => harness.registry.register({ id: ' ', begin: () => { throw new Error('unused') } })).toThrow(/reserved/)

    undo()
    expect(harness.registry.get('probe')).toBeUndefined()
    undo()
    expect(harness.registry.get('probe')).toBeUndefined()
  })
})

describe('ImOutputRegistry buttons', () => {
  it('re-emits an admitted click with its message and session attribution', async () => {
    const harness = booted()
    const hosted = harness.host({ output: 'probe' })
    const message = inbound()
    harness.messages.set(message.key, message)
    harness.sender.owners.set(message.key, hosted.sessionId)

    // The registry subscribes `interaction/button` itself.
    harness.ctx.emit('interaction/button', click('dsh:more', { message: 'm1', data: 'payload', values: { field: 'v' } }))
    await flush()
    expect(harness.buttons).toHaveLength(1)
    expect(harness.buttons[0]).toMatchObject({
      id: 'dsh:more',
      data: 'payload',
      values: { field: 'v' },
      chat: chatOf(),
      user: { id: 'user-1' },
      bot: BOT,
      message,
      session: hosted.sessionId,
      time: 1000,
    })
  })

  it('catches and logs a thrown listener failure from interaction/button and interaction/select', async () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    const warn = vi.spyOn(harness.ctx.logger, 'warn').mockImplementation(() => {})
    harness.ctx.on('im/button', () => { throw new Error('button listener boom') })
    harness.ctx.on('im/select', () => { throw new Error('select listener boom') })

    harness.ctx.emit('interaction/button', click('dsh:plain'))
    harness.ctx.emit('interaction/select', pick('sel-size', ['l']))
    await flush()
    expect(warn.mock.calls.some(([fmt]) => String(fmt).includes('IM button click was not handled'))).toBe(true)
    expect(warn.mock.calls.some(([fmt]) => String(fmt).includes('IM %s was not handled'))).toBe(true)
    warn.mockRestore()
  })

  it('ignores a click from a sender the admitting source does not allow', async () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all', users: ['another-user'] })

    harness.registry.button(click('dsh:plain'))
    expect(harness.buttons).toEqual([])

    // The sender the rule admits reaches the host again.
    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all', users: ['user-1'] })
    harness.registry.button(click('dsh:plain'))
    expect(harness.buttons).toHaveLength(1)
  })

  it('refuses an interaction whose admitting source was removed', async () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    // The chat record outlives the rule in `im_messages`; the click must not fall through to "no allowlist".
    harness.sources.delete('team')

    harness.registry.button(click('dsh:plain'))
    expect(harness.buttons).toEqual([])
  })

  it('refuses an interaction of a chat the rule no longer lists', async () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    // The rule survives while its `chats` list names another chat, which is how an operator narrows one source. The
    // record stays in `im_messages`, but the old chat's members must not keep pressing the session's controls.
    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all', chats: ['elsewhere'] })

    harness.registry.button(click('dsh:plain'))
    expect(harness.buttons).toEqual([])

    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all', chats: [chatOf().ref.id] })
    harness.registry.button(click('dsh:plain'))
    expect(harness.buttons).toHaveLength(1)
  })

  it('keeps a click without a stored message unattributed and ignores foreign chats', async () => {
    const harness = booted()
    harness.host({ output: 'probe' })

    harness.registry.button(click('dsh:plain'))
    expect(harness.buttons).toHaveLength(1)
    expect(harness.buttons[0]?.message).toBeUndefined()
    expect(harness.buttons[0]?.session).toBeUndefined()
    expect(harness.buttons[0]?.data).toBeUndefined()

    // A click in a chat this host does not know is invisible.
    harness.registry.button(click('dsh:plain', { chat: 'elsewhere' }))
    expect(harness.buttons).toHaveLength(1)
    // An envelope without a button is not a click.
    harness.registry.button(noClick())
    expect(harness.buttons).toHaveLength(1)
  })

  it('ignores a stored message belonging to another chat when attributing an interaction', async () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    const foreign = harness.host({ key: 'foreign', output: 'probe', bindings: [{ chat: ImChatKey('fake:bot', 'elsewhere'), writable: true, home: true }] })
    const foreignMsg = { ...inbound(), key: ImMessageKey('fake:bot', 'm-foreign'), chat: chatOf('elsewhere') }
    // Simulate an alias collision where history.get(aliasKey) returns a message from another chat.
    harness.messages.set(ImMessageKey('fake:bot', 'REFIDX_shared'), foreignMsg)
    harness.sender.owners.set(foreignMsg.key, foreign.sessionId)

    harness.registry.button(click('dsh:plain', { message: 'REFIDX_shared' }))
    expect(harness.buttons).toHaveLength(1)
    expect(harness.buttons[0]?.message).toBeUndefined()
    expect(harness.buttons[0]?.session).toBeUndefined()
  })

})

describe('ImOutputRegistry selects', () => {
  it('re-emits a pick of an admitted chat with its message and session attribution', async () => {
    const harness = booted()
    const hosted = harness.host({ output: 'probe' })
    const message = inbound()
    harness.messages.set(message.key, message)
    harness.sender.owners.set(message.key, hosted.sessionId)

    // The registry subscribes `interaction/select` itself.
    harness.ctx.emit('interaction/select', pick('sel-size', ['l'], { message: 'm1', data: 'step-2' }))
    await flush()
    expect(harness.selects).toHaveLength(1)
    expect(harness.selects[0]).toMatchObject({
      id: 'sel-size',
      values: ['l'],
      data: 'step-2',
      chat: chatOf(),
      user: { id: 'user-1' },
      bot: BOT,
      message,
      session: hosted.sessionId,
      time: 1000,
    })
    expect(harness.buttons).toEqual([])
  })

  it('ignores a pick from a sender the admitting source does not allow, and one in a foreign chat', async () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all', users: ['another-user'] })
    harness.registry.select(pick('sel-size', ['l']))
    expect(harness.selects).toEqual([])

    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all', users: ['user-1'] })
    harness.registry.select(pick('sel-size', ['l'], { chat: 'elsewhere' }))
    expect(harness.selects).toEqual([])

    // An envelope without a select is not a pick.
    harness.ctx.emit('interaction/select', noClick())
    await flush()
    expect(harness.selects).toEqual([])

    harness.registry.select(pick('sel-size', ['l']))
    expect(harness.selects).toHaveLength(1)
  })
})

describe('ImOutputRegistry checks', () => {
  it('re-emits a toggle of an admitted chat with its state, message and session attribution', async () => {
    const harness = booted()
    const hosted = harness.host({ output: 'probe' })
    const message = inbound()
    harness.messages.set(message.key, message)
    harness.sender.owners.set(message.key, hosted.sessionId)

    // The registry subscribes `interaction/check` itself.
    harness.ctx.emit('interaction/check', toggle('chk-agree', true, { message: 'm1', data: 'row-3' }))
    await flush()
    expect(harness.checks).toHaveLength(1)
    expect(harness.checks[0]).toMatchObject({
      id: 'chk-agree',
      checked: true,
      data: 'row-3',
      chat: chatOf(),
      user: { id: 'user-1' },
      bot: BOT,
      message,
      session: hosted.sessionId,
      time: 1000,
    })
    expect(harness.buttons).toEqual([])
    expect(harness.selects).toEqual([])

    harness.registry.check(toggle('chk-agree', false))
    expect(harness.checks[1]?.checked).toBe(false)
    expect(harness.checks[1]?.message).toBeUndefined()
  })

  it('ignores a toggle from a user the source does not allow, and one in a foreign chat', async () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all', users: ['another-user'] })
    harness.registry.check(toggle('chk-agree', true))
    expect(harness.checks).toEqual([])

    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all', users: ['user-1'] })
    harness.registry.check(toggle('chk-agree', true, { chat: 'elsewhere' }))
    expect(harness.checks).toEqual([])
    // An envelope without a checkbox is not a toggle.
    harness.registry.check(noClick())
    expect(harness.checks).toEqual([])
  })
})

describe('ImOutputRegistry reactions', () => {
  it('re-emits reactions on stored messages without chat_id, carrying session attribution and deduplicating event ids', async () => {
    const harness = booted()
    const hosted = harness.host({ output: 'probe' })
    const message = { ...inbound(), sender: { id: 'bot-user', self: true } }
    harness.messages.set(message.key, message)
    harness.sender.owners.set(message.key, hosted.sessionId)

    harness.ctx.emit('reaction-added', react('m1', 'THUMBSUP', { id: 'ev-1' }))
    // Duplicate platform redelivery with the same event id is ignored.
    harness.ctx.emit('reaction-added', react('m1', 'THUMBSUP', { id: 'ev-1' }))
    harness.ctx.emit('reaction-removed', react('m1', 'THUMBSUP', { id: 'ev-2', time: 1500 }))
    await flush()

    expect(harness.reactions).toHaveLength(2)
    expect(harness.reactions[0]).toMatchObject({
      action: 'added',
      emoji: 'THUMBSUP',
      chat: chatOf(),
      user: { id: 'user-1' },
      bot: BOT,
      message,
      session: hosted.sessionId,
      time: 1000,
      id: 'ev-1',
    })
    expect(harness.reactions[1]).toMatchObject({
      action: 'removed',
      emoji: 'THUMBSUP',
      time: 1500,
      id: 'ev-2',
    })
  })

  it('ignores self-reactions, unknown messages, chat mismatches, and disallowed users', () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    const message = { ...inbound(), sender: { id: 'bot-user', self: true } }
    harness.messages.set(message.key, message)

    // Bot's own working reaction is ignored.
    harness.registry.reaction(react('m1', 'Typing', { user: { id: 'bot-user', isBot: true } }), 'added')
    // Unknown message id is ignored.
    harness.registry.reaction(react('m-missing', 'THUMBSUP'), 'added')
    // Chat mismatch is ignored.
    harness.registry.reaction(react('m1', 'THUMBSUP', { chat: 'other' }), 'added')
    // User outside source allowlist is ignored.
    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all', users: ['another-user'] })
    harness.registry.reaction(react('m1', 'THUMBSUP'), 'added')

    expect(harness.reactions).toEqual([])
  })

  it('ignores a reaction without a payload, an emoji, or an identified user', () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    harness.messages.set(inbound().key, inbound())

    harness.registry.reaction(rawReaction(undefined), 'added')
    harness.registry.reaction(rawReaction({ message: { id: 'm1' }, emoji: '', user: { id: 'user-1' } }), 'added')
    harness.registry.reaction(rawReaction({ message: { id: 'm1' }, emoji: 'THUMBSUP' }), 'added')
    harness.registry.reaction(rawReaction({ message: { id: 'm1' }, emoji: 'THUMBSUP', user: { id: '' } }), 'added')

    expect(harness.reactions).toEqual([])
    // The same message and user with an emoji is surfaced, so the refusals above are the payload's.
    harness.registry.reaction(rawReaction({ message: { id: 'm1' }, emoji: 'THUMBSUP', user: { id: 'user-1' } }), 'added')
    expect(harness.reactions).toHaveLength(1)
  })

  it('ignores a reaction whose chat is unknown, whose rule was removed, or whose rule no longer lists the chat', () => {
    const harness = booted()
    harness.messages.set(inbound().key, inbound())
    // The stored message's chat is not admitted by this host.
    harness.registry.reaction(react('m1', 'THUMBSUP'), 'added')

    harness.host({ output: 'probe' })
    harness.sources.delete('team')
    harness.registry.reaction(react('m1', 'THUMBSUP'), 'added')

    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all', chats: ['elsewhere'] })
    harness.registry.reaction(react('m1', 'THUMBSUP'), 'added')
    expect(harness.reactions).toEqual([])

    harness.sources.set('team', { id: 'team', bot: BOT.id, writable: true, store: 'all' })
    harness.registry.reaction(react('m1', 'THUMBSUP'), 'added')
    expect(harness.reactions).toHaveLength(1)
  })

  it('leaves a reaction without an event id or a producing session unattributed and undeduplicated', () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    harness.messages.set(inbound().key, inbound())

    harness.registry.reaction(react('m1', 'THUMBSUP'), 'added')
    harness.registry.reaction(react('m1', 'THUMBSUP'), 'added')

    expect(harness.reactions).toHaveLength(2)
    expect(harness.reactions[0]).not.toHaveProperty('session')
    expect(harness.reactions[0]).not.toHaveProperty('id')
  })

  it('forgets the oldest event id once 1000 are remembered', () => {
    const harness = booted()
    harness.host({ output: 'probe' })
    harness.messages.set(inbound().key, inbound())

    for (let index = 0; index <= 1000; index++) harness.registry.reaction(react('m1', 'THUMBSUP', { id: `ev-${index}` }), 'added')
    expect(harness.reactions).toHaveLength(1001)
    // `ev-0` was evicted by `ev-1000`, so its redelivery surfaces again; `ev-1000` is still remembered.
    harness.registry.reaction(react('m1', 'THUMBSUP', { id: 'ev-0' }), 'added')
    harness.registry.reaction(react('m1', 'THUMBSUP', { id: 'ev-1000' }), 'added')
    expect(harness.reactions).toHaveLength(1002)
  })
})

describe('ImOutputRegistry referrers', () => {
  const REFERRER = { msg_id: 'ROBOT.1.abc', event_id: 'evt-1', receivedAt: 1000, chatType: 'group', chatId: 'chat' }
  const worlds: { ctx: Context; store: ImStore; sender: ImSender }[] = []

  afterEach(async () => {
    for (const world of worlds.splice(0)) {
      await world.sender.dispose()
      await world.store.dispose()
      await world.ctx.fiber.dispose()
    }
  })

  it('answers the turn trigger with the referrer the adapter put on it', async () => {
    // A real funnel under the registry: the trigger quote must reach the adapter as `Target.referrer` (QQ passive).
    const { ctx, bot } = await mountFakeAdapter({ modes: { text: createTextMode() }, selfId: 'bot-user' })
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    const config = Config({ sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all' }] })
    const store = new ImStore(ctx, config)
    await store.start()
    const chat = chatOf()
    await store.touchChat(chat)
    const hosted = record({ output: 'probe' })
    const sessions = {
      of: (id: SessionId) => (id === hosted.sessionId ? hosted : undefined),
      get: (keyOrId: string) => (keyOrId === hosted.sessionId || keyOrId === hosted.key ? hosted : undefined),
      stop: async () => true,
      trigger: () => undefined,
    }
    const sender = new ImSender(ctx, config, { store, sessions })
    await sender.start()
    worlds.push({ ctx, store, sender })
    const registry = new ImOutputRegistry(ctx, {
      im: {
        chat: (key: ImChatKey) => (key === chat.key ? chat : undefined),
        source: () => undefined,
        history: store,
      } satisfies ImOutputDeps['im'],
      sender,
    })
    registry.start()
    const probe = new Probe()
    registry.register(probe)

    const trigger = await store.put(inboundDraft(REFERRER), 'none')
    ctx.emit('im/activity', activity(hosted, { trigger }), 'start')
    await flush()
    await probe.ios[0]!.send('answer')
    expect(bot.operations.at(-1)?.target?.referrer).toEqual(REFERRER)
    await registry.dispose()
  })

  it('logs no missing-renderer warning when output is none', async () => {
    const harness = booted()
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const hosted = harness.host({ output: 'none' })
    harness.ctx.emit('im/activity', activity(hosted), 'start')
    harness.ctx.emit('im/activity', activity(hosted), 'end')
    await flush()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
