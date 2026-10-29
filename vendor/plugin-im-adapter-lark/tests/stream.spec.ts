/**
 * The CardKit `patch` stream driver.
 *
 * Three layers:
 * - **installation**: `LarkBot.streamDriver` answers the CardKit driver in card mode (`cardStreaming !== false`), the
 *   core `edit` driver in post mode and `undefined` (buffered `final`) nowhere else; both drivers are memoized, so
 *   every stream of one bot reuses the same stateless instance;
 * - **the driver itself**: entity creation + one reference message, one request per diff op with a strictly
 *   increasing `sequence`, a full update when the scheduler had no patches or the streaming window closed, `close`
 *   switching `streaming_mode` off, the streaming window as the budget;
 * - **through `bot.stream`** (the stream scheduler) under fake timers with a scripted growing activity from
 *   `streamingScripts()`: a growing text, a growing list and a non-prefix change, plus a failed request whose retry
 *   keeps the sequence strictly increasing, the post `edit` path and the non-streaming card path.
 *
 * Every request is answered by a stubbed transport; nothing touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import {
  createRenderReport, normalize, Satori, type MessageHandle, type Prepared, type SendOptions, type StreamTickContext,
  type Target,
} from '@deepseek-ai/cordis-plugin-im-core'
import { streamingScripts } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import { h } from '@deepseek-ai/satori-element'
import LarkBot, { Config, type LarkConfig } from '@deepseek-ai/cordis-plugin-im-adapter-lark'
import { cardJson, type CardDraft, type CardMessageDraft, type CardPayload, type CardPatch } from '../src/modes/card.ts'
import {
  CARD_STREAM_WINDOW_MARGIN_MS, CARD_STREAM_WINDOW_MS, createCardStreamDriver, type LarkCardStreamState,
} from '../src/stream.ts'

const CHAT = 'oc_chat'
const target: Target = { chat: { id: CHAT, type: 'group' } }

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------------------------------------------
// Mocked platform

/** One request the adapter made (the tenant token call is not recorded). */
interface Call {
  path: string
  method: string
  body: string | undefined
}

/** An answer of the scripted platform; `undefined` falls through to the routes below. */
interface Answer {
  status?: number
  body?: unknown
}

/**
 * Mount the adapter on a context whose only transport is the scripted `http/fetch` hook. The bot is constructed
 * directly, so its long connection never starts.
 *
 * @param answer - answer of the n-th request, or `undefined` to use the default route.
 * @param input - configuration overrides (`cardStreaming`, `callbacks`, …).
 */
async function mount(answer?: (call: Call, index: number) => Answer | undefined, input: Record<string, unknown> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  const calls: Call[] = []
  ctx.on('http/fetch', async (url: URL, init: any) => {
    if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
      return Response.json({ code: 0, tenant_access_token: 't-token', expire: 7200 })
    }
    const call: Call = { path: url.pathname, method: init.method ?? 'GET', body: init.body }
    calls.push(call)
    const scripted = answer?.(call, calls.length - 1)
    if (scripted) return new Response(JSON.stringify(scripted.body ?? {}), { status: scripted.status ?? 200 })
    return route(call)
  })
  const config: LarkConfig = Config({ appId: 'cli_lark', appSecret: 'secret', ...input } as LarkConfig)
  const bot = new LarkBot(ctx, config)
  return { ctx, bot, calls }
}

/** The CardKit and message routes. */
function route(call: Call): Response {
  const ok = () => Response.json({ code: 0, data: {} })
  if (call.method === 'POST' && call.path === '/open-apis/cardkit/v1/cards') {
    return Response.json({ code: 0, data: { card_id: 'card_1' } })
  }
  if (call.method === 'PUT' && call.path === '/open-apis/cardkit/v1/cards/card_1') return ok()
  if (call.method === 'POST' && call.path === '/open-apis/cardkit/v1/cards/card_1/elements') return ok()
  if (call.method === 'PATCH' && call.path === '/open-apis/cardkit/v1/cards/card_1/settings') return ok()
  if (/^\/open-apis\/cardkit\/v1\/cards\/card_1\/elements\/[^/]+\/content$/.test(call.path)) {
    return call.method === 'PUT' ? ok() : unexpected(call)
  }
  if (/^\/open-apis\/cardkit\/v1\/cards\/card_1\/elements\/[^/]+$/.test(call.path)) {
    return call.method === 'PATCH' || call.method === 'DELETE' ? ok() : unexpected(call)
  }
  if (call.method === 'POST' && call.path === '/open-apis/im/v1/messages') {
    return Response.json({ code: 0, data: { message_id: 'om_1', chat_id: CHAT } })
  }
  if (call.path === '/open-apis/im/v1/messages/om_1') {
    return call.method === 'PUT' || call.method === 'DELETE' ? ok() : unexpected(call)
  }
  throw unexpected(call)
}

function unexpected(call: Call): never {
  throw new Error(`Unexpected request: ${call.method} ${call.path}`)
}

/** The parsed body of one request. */
function bodyOf(call: Call | undefined): any {
  expect(call).toBeDefined()
  return JSON.parse(String(call!.body))
}

/** The `sequence` of every CardKit write, in call order (the create and message calls carry none). */
function sequences(calls: Call[]): number[] {
  return calls
    .map(call => bodyOf(call).sequence)
    .filter((sequence): sequence is number => typeof sequence === 'number')
}

/** Every CardKit write must number its request: `1, 2, 3 …` with no gap and no reuse. */
function expectContiguous(seq: number[]): void {
  expect(seq).toEqual(seq.map((_value, index) => index + 1))
}

/** The card document of a CardKit write (create body or full update body). */
function cardOfBody(body: any): any {
  const card = body.card ?? body
  expect(card.type).toBe('card_json')
  return JSON.parse(card.data)
}

// ---------------------------------------------------------------------------------------------------------------
// Driver-level fixtures

/** One card draft: a single markdown component, as the card mode renders a paragraph. */
function prepared(content: string, id = 'e1'): Prepared<CardDraft> {
  const value: CardMessageDraft = { kind: 'card', elements: [{ tag: 'markdown', id, content, refs: [], tables: 0 }] }
  return { draft: value, resolved: new Map() }
}

/** The serialized payload of one card state (`CardPayload`, what the mode's `serialize` returns). */
function payload(content: string, id = 'e1'): CardPayload {
  const value = prepared(content, id)
  return { msg_type: 'interactive', content: cardJson(value.draft as CardMessageDraft, () => 'img_v2_key') }
}

/** A tick context of one driver call. */
function tickContext(options: SendOptions = {}): StreamTickContext {
  return {
    target,
    mode: 'card',
    options,
    signal: new AbortController().signal,
    report: createRenderReport(),
    content: normalize('state'),
    attempt: 1,
  }
}

/** The stream bookkeeping of a handle the driver created. */
function stateOf(handle: MessageHandle): LarkCardStreamState {
  return handle.state as LarkCardStreamState
}

/** A `content` patch (a markdown component whose text grew). */
function contentPatch(content: string, id = 'e1', append = true): CardPatch {
  return { op: 'content', id, component: { tag: 'markdown', id, content, refs: [], tables: 0 }, append }
}

// ---------------------------------------------------------------------------------------------------------------
// Installation

describe('driver installation', () => {
  it('answers the patch driver in card mode and the edit driver in post mode', async () => {
    const { bot } = await mount()
    const card = bot.streamDriver('card')
    expect(card?.strategy).toBe('patch')
    // The driver is one stateless instance: the per-message bookkeeping lives in `handle.state`.
    expect(bot.streamDriver('card')).toBe(card)

    const post = bot.streamDriver('post')
    expect(post?.strategy).toBe('edit')
    expect(bot.streamDriver('post')).toBe(post)
    expect(bot.streamDriver('text')).toBeUndefined()
  })

  it('keeps the buffered final strategy when card streaming is off', async () => {
    const { bot } = await mount(undefined, { cardStreaming: false })
    expect(bot.streamDriver('card')).toBeUndefined()
    // The post driver is independent of the card flag.
    expect(bot.streamDriver('post')?.strategy).toBe('edit')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The driver itself

describe('driver — open', () => {
  it('creates a streaming card entity, then sends it once as an interactive message', async () => {
    const { bot, calls } = await mount()
    const driver = createCardStreamDriver(bot, { now: () => 1234 })
    const handle = await driver.open(prepared('Hel'), payload('Hel'), tickContext())

    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /open-apis/cardkit/v1/cards',
      'POST /open-apis/im/v1/messages',
    ])
    // `open`: the whole card document with streaming enabled.
    const created = cardOfBody(bodyOf(calls[0]))
    expect(created).toMatchObject({ schema: '2.0', config: { update_multi: true, streaming_mode: true } })
    expect(created.body.elements).toMatchObject([{ tag: 'markdown', element_id: 'e1', content: 'Hel' }])
    expect(created.config.streaming_config).toBeTruthy()

    // The message references the entity; it is the only content the platform receives.
    const sent = bodyOf(calls[1])
    expect(sent).toMatchObject({ msg_type: 'interactive', receive_id: CHAT })
    expect(JSON.parse(sent.content)).toEqual({ type: 'card', data: { card_id: 'card_1' } })

    expect(handle.parts).toHaveLength(1)
    // `send.ts` records the kind from `content.type === 'card'`, so a later edit addresses the entity.
    expect(handle.parts[0]).toMatchObject({ id: 'om_1', kind: 'card-entity' })
    expect(handle).toMatchObject({ bot: bot.id, target, mode: 'card', edits: 0 })
    expect(stateOf(handle)).toMatchObject({ cardId: 'card_1', sequence: 0, openedAt: 1234 })
  })

  it('refuses a card JSON above `limit.payload.bytes` (size)', async () => {
    const { bot, calls } = await mount()
    const driver = createCardStreamDriver(bot)
    const huge = 'x'.repeat(40_000)
    await expect(driver.open(prepared(huge), payload(huge), tickContext()))
      .rejects.toMatchObject({ name: 'StreamLimitError', violation: { kind: 'size', key: 'limit.payload.bytes', limit: 30_000 } })
    // Refused before the entity exists: no orphan card entity and no message either.
    expect(calls).toHaveLength(0)
  })

  it('refuses a state a card message cannot show, so the scheduler sends an ordinary message', async () => {
    const { bot, calls } = await mount()
    const driver = createCardStreamDriver(bot)
    const media = { msg_type: 'audio', content: { file_key: 'file_v2_key' } } as CardPayload
    await expect(driver.open(prepared('x'), media, tickContext()))
      .rejects.toMatchObject({ name: 'StreamLimitError', violation: { kind: 'shape' } })
    expect(calls).toHaveLength(0)
  })
})

describe('driver — tick and close', () => {
  it('applies one request per diff op with fresh sequences, then closes with streaming off', async () => {
    const { bot, calls } = await mount()
    const driver = createCardStreamDriver(bot)
    const handle = await driver.open(prepared('Hel'), payload('Hel'), tickContext())
    calls.length = 0

    await driver.tick(handle, {
      draft: prepared('Hello'),
      payload: payload('Hello'),
      patches: [contentPatch('Hello')],
    }, tickContext())
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'PUT /open-apis/cardkit/v1/cards/card_1/elements/e1/content',
    ])
    expect(bodyOf(calls[0])).toMatchObject({ content: 'Hello', sequence: 1 })

    await driver.close(handle, { draft: prepared('Hello world'), payload: payload('Hello world') }, tickContext())
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'PUT /open-apis/cardkit/v1/cards/card_1/elements/e1/content',
      'PUT /open-apis/cardkit/v1/cards/card_1',
    ])
    // One full update carries the final state *and* ends streaming (`close` must turn it off).
    const final = cardOfBody(bodyOf(calls[1]))
    expect(final.config.streaming_mode).toBe(false)
    expect(final.config.streaming_config).toBeUndefined()
    expect(final.body.elements).toMatchObject([{ content: 'Hello world' }])
    expect(bodyOf(calls[1]).sequence).toBe(2)

    expectContiguous(sequences(calls))
    expect(handle.edits).toBe(1)
  })

  it('publishes the whole document when the scheduler had no patches', async () => {
    const { bot, calls } = await mount()
    const driver = createCardStreamDriver(bot)
    const handle = await driver.open(prepared('abc'), payload('abc'), tickContext())
    calls.length = 0

    await driver.tick(handle, { draft: prepared('xyz'), payload: payload('xyz') }, tickContext())
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['PUT /open-apis/cardkit/v1/cards/card_1'])
    const card = cardOfBody(bodyOf(calls[0]))
    // Mid-stream, so streaming stays on for the ticks that follow.
    expect(card.config.streaming_mode).toBe(true)
    expect(card.body.elements).toMatchObject([{ content: 'xyz' }])
    expect(bodyOf(calls[0]).sequence).toBe(1)
  })

  it('resumes a partially applied tick instead of repeating finished requests', async () => {
    // The second op of the first attempt is lost in transport; its retry must not repeat the first op.
    let failed = 0
    const { bot, calls } = await mount((call) => {
      if (call.method === 'PUT' && call.path.endsWith('/elements/e2/content') && failed++ === 0) {
        return { status: 500, body: { code: 1 } }
      }
      return undefined
    })
    const driver = createCardStreamDriver(bot)
    const handle = await driver.open(prepared('a'), payload('a'), tickContext())
    calls.length = 0

    const patches = [contentPatch('a+'), contentPatch('b+', 'e2')]
    await expect(driver.tick(handle, { draft: prepared('a+b+'), payload: payload('a+b+'), patches }, tickContext()))
      .rejects.toBeInstanceOf(Error)
    expect(calls.map(call => call.path.split('/elements/')[1])).toEqual(['e1/content', 'e2/content'])

    // The retry of the same tick (the scheduler re-sends the same patches) resumes the queue.
    await driver.tick(handle, { draft: prepared('a+b+'), payload: payload('a+b+'), patches }, tickContext())
    expect(calls.map(call => call.path.split('/elements/')[1])).toEqual(['e1/content', 'e2/content', 'e2/content'])
    // Every request took a fresh number, the failed one included.
    expect(sequences(calls)).toEqual([1, 2, 3])
  })

  it('publishes the whole document when the diff changes the element set', async () => {
    const { bot, calls } = await mount()
    const driver = createCardStreamDriver(bot)
    const handle = await driver.open(prepared('abc'), payload('abc'), tickContext())
    calls.length = 0

    const patches: CardPatch[] = [
      { op: 'insert', components: [{ tag: 'hr', id: 'e7' }], after: 'e1' },
      {
        op: 'patch',
        id: 'e8',
        component: {
          tag: 'button',
          id: 'e8',
          text: 'Retry',
          type: 'default',
          disabled: false,
          behavior: { type: 'open_url', url: 'https://example.com/retry' },
        },
        fields: ['text'],
      },
      { op: 'delete', id: 'e9' },
    ]
    await driver.tick(handle, { draft: prepared('abc'), payload: payload('abc'), patches }, tickContext())

    // Element ids are positional, so the insert and the delete it replaces address different ids: as separate requests
    // the platform can accept the first and reject a later one, which leaves the card with the old control removed and
    // its replacement missing. One document update cannot land partially.
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'PUT /open-apis/cardkit/v1/cards/card_1',
    ])
    expect(cardOfBody(bodyOf(calls[0])).config.streaming_mode).toBe(true)
  })

  it('sends a content-only diff as one element request', async () => {
    const { bot, calls } = await mount()
    const driver = createCardStreamDriver(bot)
    const handle = await driver.open(prepared('abc'), payload('abc'), tickContext())
    calls.length = 0

    await driver.tick(handle, {
      draft: prepared('abcd'),
      payload: payload('abcd'),
      patches: [contentPatch('abcd')],
    }, tickContext())

    expect(calls.map(call => `${call.method} ${call.path}`))
      .toEqual(['PUT /open-apis/cardkit/v1/cards/card_1/elements/e1/content'])
    expect(bodyOf(calls[0])).toMatchObject({ sequence: 1 })
  })

  it('publishes a full update once the 10-minute streaming window has closed', async () => {
    let clock = 0
    const { bot, calls } = await mount()
    const driver = createCardStreamDriver(bot, { now: () => clock })
    const handle = await driver.open(prepared('abc'), payload('abc'), tickContext())
    calls.length = 0

    clock = CARD_STREAM_WINDOW_MS
    await driver.tick(handle, { draft: prepared('abcd'), payload: payload('abcd'), patches: [contentPatch('abcd')] }, tickContext())
    // The platform forced streaming off: the content still lands, only as a whole-document update.
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['PUT /open-apis/cardkit/v1/cards/card_1'])
    expect(cardOfBody(bodyOf(calls[0])).config.streaming_mode).toBe(false)
  })

  it('sends the settings route the JSON string the platform accepts', async () => {
    const { bot, calls } = await mount()
    calls.length = 0

    await bot.cards.settings('card_1', { streaming_mode: true }, 7)

    expect(calls.map(call => `${call.method} ${call.path}`))
      .toEqual(['PATCH /open-apis/cardkit/v1/cards/card_1/settings'])
    const body = bodyOf(calls[0])
    expect(body.sequence).toBe(7)
    // The platform answers `400` to an object in this field and accepts the serialized form.
    expect(typeof body.settings).toBe('string')
    expect(JSON.parse(body.settings)).toEqual({ streaming_mode: true })
  })
})

describe('driver — budget', () => {
  it('reports the end of the streaming window and no update count', async () => {
    const { bot } = await mount()
    const driver = createCardStreamDriver(bot, { now: () => 1_000 })
    const handle = await driver.open(prepared('a'), payload('a'), tickContext())
    // CardKit has no per-message edit count; the only limit is the 10-minute window, kept away from its very end.
    expect(driver.budget(handle)).toEqual({ until: 1_000 + CARD_STREAM_WINDOW_MS - CARD_STREAM_WINDOW_MARGIN_MS })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Through the scheduler

describe('through the scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  const flush = () => vi.advanceTimersByTimeAsync(0)
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

  /** The scripted activity of one corpus script. */
  function script(name: string) {
    const found = streamingScripts().find(item => item.name === name)
    expect(found).toBeDefined()
    return found!
  }

  /** Drive a whole script through `bot.stream` until `close` resolves. */
  async function run(stream: ReturnType<LarkBot['stream']>, states: readonly unknown[]) {
    stream.update(states[0] as never)
    await flush()
    for (const state of states.slice(1)) {
      stream.update(state as never)
      // Longer than the `edit` strategy's 800 ms first-publication delay, so every state reaches the platform.
      await advance(900)
    }
    const done = stream.close(states[states.length - 1] as never)
    done.catch(() => {})
    await advance(5_000)
    return await done
  }

  it('streams a growing text into one card: entity, typewriter ticks, streaming off at close', async () => {
    const { bot, calls } = await mount()
    const stream = bot.stream(target)
    expect(stream.strategy).toBe('patch')

    const result = await run(stream, script('growing-text').states)

    expect(calls[0]).toMatchObject({ method: 'POST', path: '/open-apis/cardkit/v1/cards' })
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/open-apis/im/v1/messages' })
    expect(JSON.parse(bodyOf(calls[1]).content)).toEqual({ type: 'card', data: { card_id: 'card_1' } })
    // Intermediate states are element updates (the typewriter route), never a second message.
    const middle = calls.slice(2, -1)
    expect(middle.length).toBeGreaterThan(0)
    for (const call of middle) {
      expect(call.path).toMatch(/^\/open-apis\/cardkit\/v1\/cards\/card_1\/elements\/[^/]+\/content$/)
      expect(call.method).toBe('PUT')
    }
    // The last publication is the final document with streaming off.
    const last = calls[calls.length - 1]!
    expect(last).toMatchObject({ method: 'PUT', path: '/open-apis/cardkit/v1/cards/card_1' })
    const final = cardOfBody(bodyOf(last))
    expect(final.config.streaming_mode).toBe(false)
    expect(JSON.stringify(final.body.elements)).toContain('Patching them now.')

    expectContiguous(sequences(calls))
    expect(stream.state).toBe('closed')
    expect(result.handle.parts[0]).toMatchObject({ id: 'om_1', kind: 'card-entity' })
  })

  it('typewrites a growing list into the one markdown component the card mode assembled', async () => {
    const { bot, calls } = await mount()
    const stream = bot.stream(target)
    await run(stream, script('growing-list').states)

    // The card mode merges consecutive flow blocks into one markdown component, so a list that gains items keeps its
    // element id and only its text grows — the cheapest possible update.
    const updates = calls.filter(call => call.method === 'PUT' && /\/elements\/[^/]+\/content$/.test(call.path))
    expect(updates.length).toBeGreaterThan(0)
    expect(new Set(updates.map(call => call.path.split('/').at(-2))).size).toBe(1)
    expectContiguous(sequences(calls))
    // No message beyond the one that carries the entity.
    expect(calls.filter(call => call.path === '/open-apis/im/v1/messages')).toHaveLength(1)
    expect(JSON.stringify(cardOfBody(bodyOf(calls[calls.length - 1])).body.elements)).toContain('report')
  })

  it('keeps the sequence strictly increasing across a failed request and its retry', async () => {
    let attempts = 0
    const { bot, calls } = await mount((call) => {
      if (call.method !== 'PUT' || !call.path.endsWith('/content')) return undefined
      // The first element update is lost in transport; its retry must succeed on a **new** number.
      return ++attempts === 1 ? { status: 500, body: { code: 1 } } : undefined
    })
    const stream = bot.stream(target)
    const result = await run(stream, script('growing-text').states)

    expect(attempts).toBeGreaterThan(1)
    // The failed request consumed its number and the retry took the next one: never reused, never skipped.
    expectContiguous(sequences(calls))
    expect(sequences(calls).length).toBeGreaterThan(2)
    expect(stream.state).toBe('closed')
    expect(result.handle.parts[0]!.id).toBe('om_1')
  })

  it('publishes a `replace` diff as a full card update', async () => {
    const { bot, calls } = await mount()
    const stream = bot.stream(target)
    // The header appears between the states, which the by-id diff cannot express as an element op.
    await run(stream, [
      h('p', 'Checking the build'),
      [h('title', {}, 'Build status'), h('p', 'Checking the build')],
      [h('title', {}, 'Build status'), h('p', 'Build is green')],
    ])

    const full = calls.filter(call => call.method === 'PUT' && call.path === '/open-apis/cardkit/v1/cards/card_1')
    expect(full.length).toBeGreaterThanOrEqual(2)
    // The mid-stream replacement keeps streaming on (more ticks may follow), the closing one ends it.
    expect(cardOfBody(bodyOf(full[0]))).toMatchObject({
      config: { streaming_mode: true },
      header: { title: { tag: 'plain_text', content: 'Build status' } },
    })
    expect(cardOfBody(bodyOf(full[full.length - 1]))).toMatchObject({ config: { streaming_mode: false } })
    expectContiguous(sequences(calls))
  })

  it('streams a post through the edit driver when the card mode cannot stream', async () => {
    // `cardStreaming: false` leaves the card mode without a driver, so a stream opens in `post` (a stream uses
    // the mode that can stream).
    const { bot, calls } = await mount(undefined, { cardStreaming: false })
    expect(bot.streamDriver('card')).toBeUndefined()
    const stream = bot.stream(target)
    expect(stream.strategy).toBe('edit')
    await run(stream, script('final-shorter').states)

    // `edit`: the first state is sent, every later one replaces that one message.
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/open-apis/im/v1/messages' })
    expect(bodyOf(calls[0]).msg_type).toBe('post')
    const edits = calls.slice(1)
    expect(edits.length).toBeGreaterThan(0)
    for (const call of edits) {
      expect(call).toMatchObject({ method: 'PUT', path: '/open-apis/im/v1/messages/om_1' })
      expect(bodyOf(call).msg_type).toBe('post')
    }
    // `limit.update.count` is 20 including the final one.
    expect(calls.length).toBeLessThanOrEqual(20)
    expect(stream.state).toBe('closed')
    // The post path never touches CardKit.
    expect(calls.some(call => call.path.includes('/cardkit/'))).toBe(false)
  })

  it('degrades a post stream to one fresh send when the platform refuses the edit (230075)', async () => {
    // When the tenant answers 230075 to `PUT /im/v1/messages/{id}`, the edit driver's first tick is refused; a `limit`
    // is a budget violation for the scheduler, so the stream recalls the streamed message and publishes the final state
    // as a plain message instead of failing.
    const { bot, calls } = await mount((call) => {
      if (call.method === 'PUT' && call.path === '/open-apis/im/v1/messages/om_1') {
        return { status: 400, body: { code: 230075, msg: 'The message has exceeded the time that can be edited' } }
      }
      return undefined
    }, { cardStreaming: false })
    const stream = bot.stream(target)
    expect(stream.strategy).toBe('edit')
    const result = await run(stream, script('growing-text').states)

    // Refused once (a `limit` is never retried), then recalled, then sent again.
    expect(calls.filter(call => call.method === 'PUT').map(call => call.path))
      .toEqual(['/open-apis/im/v1/messages/om_1'])
    expect(calls.filter(call => call.method === 'DELETE').map(call => call.path))
      .toEqual(['/open-apis/im/v1/messages/om_1'])
    const sends = calls.filter(call => call.method === 'POST' && call.path === '/open-apis/im/v1/messages')
    // The opened state (recalled) and the final state — and the final content is published exactly once.
    expect(sends).toHaveLength(2)
    expect(JSON.stringify(bodyOf(sends[0]))).not.toContain('Patching them now.')
    expect(JSON.stringify(bodyOf(sends[1]))).toContain('Patching them now.')
    expect(stream.state).toBe('closed')
    expect(result.handle.parts[0]!.id).toBe('om_1')
    // The recall landed before the resend: no window shows both messages.
    expect(calls.findIndex(call => call.method === 'DELETE'))
      .toBeLessThan(calls.findIndex(call => call === sends[1]))
  })
})
