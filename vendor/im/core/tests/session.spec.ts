/**
 * The slim `Session` envelope and its JSON view, the `onClick` `CallbackRegistry` with TTL, the `satori/receive`
 * intake gate of `bot.receive`, and the `satori:` internal routes (bot-scoped, service-wide, the `/_tmp/:id` +
 * `/_api/:name` passthroughs, and the `http/fetch` path adapters use for resource URLs).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Http } from '@deepseek-ai/cordis-plugin-http'
import { Bot, type ButtonEvent, CallbackRegistry, type CheckEvent, h, type InboundMessage, Satori, type SelectEvent } from '@deepseek-ai/cordis-plugin-im-core'
import type {} from '@deepseek-ai/cordis-plugin-http'

class TestBot extends Bot<Record<string, never>> {}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

async function setup() {
  const ctx = new Context()
  // `ctx.plugin()` applies the plugin in a microtask; awaiting the fiber makes the services available here.
  await ctx.plugin(Satori)
  await ctx.plugin(Http)
  const bot = new TestBot(ctx, {}, { id: 'test:bot', platform: 'test' })
  bot.selfId = 'bot1'
  return { ctx, bot }
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'm1',
    chat: { id: 'c1', type: 'group' },
    sender: { id: 'u1', name: 'Alice' },
    content: h('message', h('p', 'hello')),
    mentions: { self: false, all: false, users: [] },
    time: 1_700_000_000_000,
    referrer: undefined,
    ...overrides,
  }
}

function button(bot: Bot, id: string, referrer: unknown = { msg_id: 'p1' }): ButtonEvent {
  return {
    id,
    referrer,
    time: 1_700_000_000_000,
    bot,
    user: { id: 'u1' },
    chat: { id: 'c1', type: 'group' },
  }
}

function selection(bot: Bot, id: string, values: string[]): SelectEvent {
  return {
    id,
    values,
    referrer: { msg_id: 'p1' },
    time: 1_700_000_000_000,
    bot,
    user: { id: 'u1' },
    chat: { id: 'c1', type: 'group' },
  }
}

function toggle(bot: Bot, id: string, checked: boolean): CheckEvent {
  return {
    id,
    checked,
    referrer: { msg_id: 'p1' },
    time: 1_700_000_000_000,
    bot,
    user: { id: 'u1' },
    chat: { id: 'c1', type: 'group' },
  }
}

describe('Session', () => {
  it('exposes the event envelope through the remaining accessors', async () => {
    const { bot } = await setup()
    const message = inbound()
    const session = bot.session({ type: 'message', id: 'evt-1', message, referrer: 'ref' })
    expect(session.type).toBe('message')
    expect(session.timestamp).toBeGreaterThan(0)
    expect(session.message).toBe(message)
    expect(session.button).toBeUndefined()
    expect(session.referrer).toBe('ref')
    session.type = 'message-deleted'
    expect(session.event.type).toBe('message-deleted')
  })

  it('falls back to the message and button referrers', async () => {
    const { bot } = await setup()
    expect(bot.session({ type: 'message', message: inbound({ referrer: 'from-message' }) }).referrer).toBe('from-message')
    expect(bot.session({
      type: 'interaction/button',
      button: button(bot, 'b1', 'from-button'),
    }).referrer).toBe('from-button')
  })

  it('serializes as the event envelope plus sn and the current login', async () => {
    const { bot } = await setup()
    const message = inbound()
    const session = bot.session({ type: 'message', id: 'evt-1', message })
    const json = session.toJSON()

    expect(json).toMatchObject({ type: 'message', id: 'evt-1', sn: session.sn })
    expect(json.message).toEqual(message)
    expect(json.login).toEqual(bot.toJSON())
    expect(json.login.selfId).toBe('bot1')
    // the whole event round-trips through JSON: message content is a plain element tree
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
    // and it is a snapshot, not a live view
    json.type = 'changed'
    expect(session.event.type).toBe('message')
  })

  it('numbers sessions per bot service', async () => {
    const { bot } = await setup()
    const first = bot.session({ type: 'message' })
    const second = bot.session({ type: 'message' })
    expect(second.sn).toBe(first.sn + 1)
  })
})

describe('CallbackRegistry', () => {
  it('registers by id, dispatches, and resolves whether a callback ran', async () => {
    const { bot } = await setup()
    const calls: string[] = []
    const registry = new CallbackRegistry()
    registry.registerButton('a', () => { calls.push('a') })

    expect(registry.getButton('a')).toBeTypeOf('function')
    expect(await registry.dispatchButton(button(bot, 'a'))).toBe(true)
    expect(await registry.dispatchButton(button(bot, 'other'))).toBe(false)
    expect(calls).toEqual(['a'])
  })

  it('replaces a registration, and a stale disposer keeps the replacement', async () => {
    const { bot } = await setup()
    const calls: string[] = []
    const registry = new CallbackRegistry()
    const disposeFirst = registry.registerButton('a', () => { calls.push('first') })
    registry.registerButton('a', () => { calls.push('second') })

    disposeFirst()
    expect(await registry.dispatchButton(button(bot, 'a'))).toBe(true)
    expect(calls).toEqual(['second'])
  })

  it('expires after the TTL and prunes the entry on read', async () => {
    const { bot } = await setup()
    let now = 1_000
    const registry = new CallbackRegistry({ now: () => now, ttlMs: 500 })
    registry.registerButton('a', () => { /* only reachable while unexpired */ })

    now = 1_499
    expect(registry.getButton('a')).toBeTypeOf('function')
    expect(await registry.dispatchButton(button(bot, 'a'))).toBe(true)

    now = 1_500
    expect(registry.getButton('a')).toBeUndefined()
    expect(await registry.dispatchButton(button(bot, 'a'))).toBe(false)
  })

  it('honours a per-registration TTL and clear()', async () => {
    const { bot } = await setup()
    let now = 1_000
    const calls: string[] = []
    const registry = new CallbackRegistry({ now: () => now, ttlMs: 10_000 })
    registry.registerButton('short', () => { calls.push('short') }, 100)
    registry.registerButton('long', () => { calls.push('long') })

    now = 1_200
    expect(await registry.dispatchButton(button(bot, 'short'))).toBe(false)
    expect(await registry.dispatchButton(button(bot, 'long'))).toBe(true)

    registry.clear()
    expect(await registry.dispatchButton(button(bot, 'long'))).toBe(false)
    expect(calls).toEqual(['long'])
  })

  it('lets a callback failure reach the caller', async () => {
    const { bot } = await setup()
    const registry = new CallbackRegistry()
    registry.registerButton('a', () => { throw new Error('handler failed') })
    await expect(registry.dispatchButton(button(bot, 'a'))).rejects.toThrow('handler failed')
  })

  it('keeps button and select callbacks apart by kind', async () => {
    const { bot } = await setup()
    const calls: string[] = []
    const registry = new CallbackRegistry()
    registry.registerButton('shared', () => { calls.push('button') })
    registry.registerSelect('shared', () => { calls.push('select') })

    expect(await registry.dispatchButton(button(bot, 'shared'))).toBe(true)
    expect(await registry.dispatchSelect(selection(bot, 'shared', ['v']))).toBe(true)
    expect(calls).toEqual(['button', 'select'])
  })

  it('never routes a pick to a button callback of the same id', async () => {
    const { bot } = await setup()
    const registry = new CallbackRegistry()
    registry.registerButton('shared', () => { throw new Error('a pick must not reach a button callback') })
    expect(await registry.dispatchSelect(selection(bot, 'shared', ['v']))).toBe(false)
    expect(registry.getSelect('shared')).toBeUndefined()
    expect(registry.getButton('shared')).toBeTypeOf('function')
  })

  it('dispatches a checkbox toggle to its own callback, never to a click or a pick', async () => {
    const { bot } = await setup()
    const calls: string[] = []
    const registry = new CallbackRegistry()
    registry.registerButton('shared', () => { calls.push('button') })
    registry.registerSelect('shared', () => { calls.push('select') })
    registry.registerCheck('shared', event => { calls.push(event.checked ? 'checked' : 'cleared') })

    expect(await registry.dispatchCheck(toggle(bot, 'shared', true))).toBe(true)
    expect(await registry.dispatchCheck(toggle(bot, 'shared', false))).toBe(true)
    expect(calls).toEqual(['checked', 'cleared'])
    expect(await registry.dispatchCheck(toggle(bot, 'unknown', true))).toBe(false)
  })
})

describe('bot.callbacks routing', () => {
  it('dispatches interaction/button events of its own bot to the registered onClick', async () => {
    const { bot } = await setup()
    const calls: string[] = []
    bot.callbacks.registerButton('stop', (event) => { calls.push(event.id) })

    bot.dispatch(bot.session({ type: 'interaction/button', button: button(bot, 'stop') }))
    await tick()
    expect(calls).toEqual(['stop'])

    bot.dispatch(bot.session({ type: 'interaction/button', button: button(bot, 'unknown') }))
    await tick()
    expect(calls).toEqual(['stop'])
  })

  it('ignores events of another bot and events without a button', async () => {
    const { ctx, bot } = await setup()
    const other = new TestBot(ctx, {}, { id: 'test:other', platform: 'test' })
    const calls: string[] = []
    bot.callbacks.registerButton('stop', () => { calls.push('stop') })

    other.dispatch(other.session({ type: 'interaction/button', button: button(other, 'stop') }))
    other.dispatch(other.session({ type: 'message', message: inbound() }))
    await tick()
    expect(calls).toEqual([])
  })

  it('never throws into the transport when an onClick fails', async () => {
    const { bot } = await setup()
    bot.callbacks.registerButton('boom', () => { throw new Error('boom') })
    const session = bot.session({ type: 'interaction/button', button: button(bot, 'boom') })
    expect(() => bot.dispatch(session)).not.toThrow()
    await tick()
  })

  it('dispatches interaction/select events of its own bot to the registered onSelect', async () => {
    const { bot } = await setup()
    const picked: string[][] = []
    bot.callbacks.registerSelect('sel', (event) => { picked.push(event.values) })

    bot.dispatch(bot.session({ type: 'interaction/select', select: selection(bot, 'sel', ['a', 'b']) }))
    await tick()
    expect(picked).toEqual([['a', 'b']])

    bot.dispatch(bot.session({ type: 'interaction/select', select: selection(bot, 'unknown', ['a']) }))
    await tick()
    expect(picked).toEqual([['a', 'b']])
  })

  it('dispatches interaction/check events of its own bot to the registered onChange', async () => {
    const { bot } = await setup()
    const states: boolean[] = []
    bot.callbacks.registerCheck('chk', (event) => { states.push(event.checked) })

    bot.dispatch(bot.session({ type: 'interaction/check', check: toggle(bot, 'chk', true) }))
    await tick()
    bot.dispatch(bot.session({ type: 'interaction/check', check: toggle(bot, 'chk', false) }))
    await tick()
    expect(states).toEqual([true, false])

    bot.dispatch(bot.session({ type: 'interaction/check', check: toggle(bot, 'unknown', true) }))
    await tick()
    expect(states).toEqual([true, false])
  })
})

describe('bot.receive intake gate', () => {
  it('awaits every satori/receive listener before publishing the event', async () => {
    const { ctx, bot } = await setup()
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })

    ctx.on('satori/receive', async () => {
      seen.push('intake:start')
      await gate
      seen.push('intake:done')
    })
    ctx.on('message', () => { seen.push('message') })

    const task = bot.receive(bot.session({ type: 'message', message: inbound() }))
    await tick()
    expect(seen).toEqual(['intake:start'])

    release()
    await task
    expect(seen).toEqual(['intake:start', 'intake:done', 'message'])
  })

  it('runs every intake listener before the observers', async () => {
    const { ctx, bot } = await setup()
    const seen: string[] = []
    ctx.on('satori/receive', async () => { seen.push('a') })
    ctx.on('satori/receive', async () => { seen.push('b') })
    ctx.on('message-deleted', () => { seen.push('observer') })

    await bot.receive(bot.session({
      type: 'message-deleted',
      deleted: { id: 'm1', chat: { id: 'c1', type: 'group' } },
    }))
    expect(seen).toEqual(['a', 'b', 'observer'])
  })

  it('does not publish the event when the intake gate rejects', async () => {
    const { ctx, bot } = await setup()
    const seen: string[] = []
    ctx.on('satori/receive', () => { throw new Error('duplicate event') })
    ctx.on('message', () => { seen.push('message') })

    const error = await bot.receive(bot.session({ type: 'message', message: inbound() })).catch(error => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toMatchObject({ message: 'duplicate event' })
    expect(seen).toEqual([])
  })

  it('re-emits internal envelopes by their declared name and keeps internal/session', async () => {
    const { ctx, bot } = await setup()
    const seen: string[] = []
    ctx.on('internal/session', () => { seen.push('internal/session') })
    // the internal event name is adapter-defined, so it is not part of the static Events map
    ;(ctx as any).on('custom/event', (data: unknown, target: Bot) => {
      seen.push(`${target.id}:${JSON.stringify(data)}`)
    })

    bot.dispatch(bot.session({ type: 'internal', internal: { type: 'custom/event', data: { ok: true } } }))
    expect(seen).toEqual(['internal/session', 'test:bot:{"ok":true}'])
  })
})

describe('satori: internal routes', () => {
  it('resolves bot-scoped routes, then the service-wide router, then 404', async () => {
    const { ctx, bot } = await setup()
    bot.defineInternalRoute('/resource/:key', async ({ params, query }) => {
      return new Response(JSON.stringify({ key: params.key, type: query.get('type') }), {
        headers: { 'content-type': 'application/json' },
      })
    })
    ctx.satori.defineInternalRoute('/shared/:name', async ({ params }) => new Response(params.name))

    const url = bot.getInternalUrl('/resource/img-1', { type: 'image' })
    expect(url).toBe('satori:test/bot1/resource/img-1?type=image')

    const response = await ctx.satori.handleInternalRoute(new Request(url))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ key: 'img-1', type: 'image' })

    expect(await (await ctx.satori.handleInternalRoute(new Request(bot.getInternalUrl('/shared/x')))).text()).toBe('x')
    expect((await ctx.satori.handleInternalRoute(new Request(bot.getInternalUrl('/missing')))).status).toBe(404)
    expect((await ctx.satori.handleInternalRoute(new Request('satori:test/unknown/x'))).status).toBe(404)
  })

  it('serves the /_tmp/:id and /_api/:name passthroughs', async () => {
    const { ctx, bot } = await setup()
    ctx.satori._tempStore['t1'] = new Response('temp')
    expect(await (await ctx.satori.handleInternalRoute(new Request(bot.getInternalUrl('/_tmp/t1')))).text()).toBe('temp')
    expect((await ctx.satori.handleInternalRoute(new Request(bot.getInternalUrl('/_tmp/none')))).status).toBe(404)

    bot.internal = { ping: (...args: unknown[]) => ({ args, self: bot.selfId }) }
    const response = await ctx.satori.handleInternalRoute(new Request(bot.getInternalUrl('/_api/ping'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(['a', 1]),
    }))
    expect(await response.json()).toEqual({ args: ['a', 1], self: 'bot1' })
    // only POST is accepted
    expect((await ctx.satori.handleInternalRoute(new Request(bot.getInternalUrl('/_api/ping')))).status).toBe(405)
  })

  it('is what http/fetch resolves for satori: URLs', async () => {
    const { ctx, bot } = await setup()
    bot.defineInternalRoute('/resource/:key', async ({ params }) => new Response(`resource:${params.key}`))

    expect(await (await ctx.http(bot.getInternalUrl('/resource/a'))).text()).toBe('resource:a')
    // an unserved path surfaces the router's status through the http error's cause
    const error: any = await ctx.http(bot.getInternalUrl('/nope')).catch(error => error)
    expect(String(error.cause?.message)).toContain('status code: 404')
  })
})
