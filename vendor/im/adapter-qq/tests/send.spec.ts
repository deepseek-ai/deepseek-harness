/**
 * The send/delete stage : passive `msg_id`/`msg_seq`, the active fallback outside the
 * window, the `(msg_id, msg_seq)` dedupe retry, the reply reference and the two-minute recall window. Every request
 * is answered by a stubbed transport.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import { h, PlatformError, Satori, type MessageHandle, type SendContext, type SentPart, type Target } from '@deepseek-ai/cordis-plugin-im-core'
import { normalize } from '@deepseek-ai/satori-element'
import * as Markdown from '@deepseek-ai/cordis-plugin-im-markdown'
import QQBot, {
  Config,
  DELETE_WINDOW_MS,
  deleteSentPart,
  INVALID_EVENT_ID_CODE,
  messageKindOf,
  sendMessagePayload,
  type QQConfig,
  type QQReferrer,
} from '@deepseek-ai/cordis-plugin-im-adapter-qq'

const GROUP = 'group:FBB1D91204242AAB8B61A0179A6245B0'
const DIRECT = 'user:DD8246C68EC19CAF8D2AA76941180EA4'

const group: Target = { chat: { id: GROUP, type: 'group' } }
const direct: Target = { chat: { id: DIRECT, type: 'direct' } }

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One request the adapter made (the token call is not recorded). */
interface Call {
  url: string
  method: string | undefined
  data: any
  signal: AbortSignal | undefined
}

/** An answer body or status of the scripted platform. */
interface Answer {
  status?: number
  body?: unknown
}

/** A 40054005 answer, i.e. `(msg_id, msg_seq)` already used . */
const DEDUPE: Answer = { status: 400, body: { code: 40054005, message: '消息被去重' } }

/** Mount the adapter on a context whose only transport is the scripted `http/fetch` hook. */
async function mount(
  answer: (call: Call, index: number) => Answer = (_call, index) => ({ body: { id: `ROBOT1.0_out_${index}` } }),
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  await ctx.plugin(Markdown)
  const calls: Call[] = []
    // Contextual typing gives the hook the http package's own request init (undici), so the stub stays exact.
  ctx.on('http/fetch', async (url, init) => {
    const href = String(url)
    if (href.startsWith('https://bots.qq.com/')) {
      return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 7200 }), { status: 200 })
    }
    const call: Call = {
      url: href,
      method: init.method,
      data: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      signal: init.signal ?? undefined,
    }
    calls.push(call)
    const result = answer(call, calls.length - 1)
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status ?? 200 })
  })
  const config: QQConfig = Config({ appId: '102106848', secret: 'secret', transport: 'none' } as QQConfig)
  await ctx.plugin(QQBot, config)
  const bot = ctx.bots[0] as QQBot
  return { bot, calls }
}

/** A referrer of an inbound group message, received now. */
function clickReferrer(eventId: string): QQReferrer {
  return { event_id: eventId, receivedAt: Date.now(), chatType: 'group', chatId: GROUP }
}

/** A reply referrer of the group; `input` overrides the defaults. */
function referrer(input: Partial<QQReferrer> = {}): QQReferrer {
  return { msg_id: 'ROBOT1.0_in', receivedAt: Date.now(), chatType: 'group', chatId: GROUP, ...input }
}

/** A send context of one part. */
function context(input: Partial<SendContext> = {}): SendContext {
  return { index: 0, options: {}, previous: [], ...input }
}

/** A handle whose single part was published now. */
function handle(bot: QQBot, target: Target, part: SentPart): MessageHandle {
  return { bot: bot.id, target, mode: 'text', parts: [part], createdAt: part.time, edits: 0, content: normalize('') }
}

describe('sendMessagePayload — passive replies', () => {
  it('answers the inbound message with msg_id and the first msg_seq of the window', async () => {
    const { bot, calls } = await mount()
    const target: Target = { ...group, referrer: referrer() }
    const part = await sendMessagePayload(bot, { msg_type: 0, content: 'hi' }, target, context())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: `https://api.sgroup.qq.com/v2/groups/FBB1D91204242AAB8B61A0179A6245B0/messages`,
      method: 'POST',
      data: { msg_type: 0, content: 'hi', msg_id: 'ROBOT1.0_in', msg_seq: 2 },
    })
    expect(part).toMatchObject({ id: 'ROBOT1.0_out_0', kind: 'text' })
    expect(part.time).toBeGreaterThan(0)
  })

  it('increments msg_seq per reply and per msg_id', async () => {
    const { bot, calls } = await mount()
    const target: Target = { ...group, referrer: referrer() }
    for (let index = 0; index < 3; index++) await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, target, context())
    expect(calls.map(call => call.data.msg_seq)).toEqual([2, 3, 4])
    const other: Target = { ...group, referrer: referrer({ msg_id: 'ROBOT1.0_other' }) }
    await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, other, context())
    expect(calls[3]!.data).toMatchObject({ msg_id: 'ROBOT1.0_other', msg_seq: 2 })
  })

  it('answers a click with event_id and no msg_seq', async () => {
    const { bot, calls } = await mount()
    const click = clickReferrer('INTERACTION_CREATE:abc')
    await sendMessagePayload(bot, { msg_type: 0, content: 'pressed' }, { ...group, referrer: click }, context())
    expect(calls[0]!.data).toEqual({ msg_type: 0, content: 'pressed', event_id: 'INTERACTION_CREATE:abc' })
  })

  it('adds the interaction prefix to a click id the gateway reported bare', async () => {
    // `d.id` of the `INTERACTION_CREATE` frame is a bare uuid and `PUT /interactions/{id}` takes it verbatim, but the
    // message body refusing it with 40034025 is what a click looked like as a dead button.
    const { bot, calls } = await mount()
    const click = clickReferrer('1b13d569-4610-4ab9-bc51-feecc5def6d4')
    await sendMessagePayload(bot, { msg_type: 0, content: 'pressed' }, { ...group, referrer: click }, context())
    expect(calls[0]!.data).toEqual({
      msg_type: 0,
      content: 'pressed',
      event_id: 'INTERACTION_CREATE:1b13d569-4610-4ab9-bc51-feecc5def6d4',
    })
  })

  it('falls back to one active send when the platform refuses the event id', async () => {
    const { bot, calls } = await mount((_call, index) => index === 0
      ? { status: 400, body: { code: INVALID_EVENT_ID_CODE, message: '请求参数event_id无效' } }
      : { body: { id: 'ROBOT1.0_after_fallback' } })
    const part = await sendMessagePayload(bot, { msg_type: 0, content: 'pressed' }, {
      ...group,
      referrer: clickReferrer('bare-id'),
    }, context())
    // The refusal published nothing, so the reply without the passive field cannot duplicate it.
    expect(calls.map(call => call.data)).toEqual([
      { msg_type: 0, content: 'pressed', event_id: 'INTERACTION_CREATE:bare-id' },
      { msg_type: 0, content: 'pressed' },
    ])
    expect(part.id).toBe('ROBOT1.0_after_fallback')
  })

  it('strips passive fields a payload must not carry and re-fills them', async () => {
    const { bot, calls } = await mount()
    const payload = { msg_type: 0, content: 'x', msg_id: 'STALE', msg_seq: 99, event_id: 'STALE' }
    await sendMessagePayload(bot, payload, { ...group, referrer: referrer() }, context())
    expect(calls[0]!.data).toEqual({ msg_type: 0, content: 'x', msg_id: 'ROBOT1.0_in', msg_seq: 2 })
    // The payload itself is never mutated: the pipeline may reuse it.
    expect(payload).toMatchObject({ msg_id: 'STALE', msg_seq: 99, event_id: 'STALE' })
  })

  it('sends actively outside the passive window', async () => {
    const { bot, calls } = await mount()
    const stale = referrer({ receivedAt: Date.now() - 6 * 60 * 1000 })
    await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, { ...group, referrer: stale }, context())
    expect(calls[0]!.data).toEqual({ msg_type: 0, content: 'x' })
  })

  it('sends actively once the reply budget is spent', async () => {
    const { bot, calls } = await mount()
    const target: Target = { ...group, referrer: referrer() }
    for (let index = 0; index < 6; index++) await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, target, context())
    expect(calls.map(call => call.data.msg_seq)).toEqual([2, 3, 4, 5, 6, undefined])
    expect(calls[5]!.data).toEqual({ msg_type: 0, content: 'x' })
  })

  it('sends actively when there is no referrer at all', async () => {
    const { bot, calls } = await mount()
    await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, group, context())
    expect(calls[0]!.data).toEqual({ msg_type: 0, content: 'x' })
  })

  it('ignores a referrer of another chat', async () => {
    const { bot, calls } = await mount()
    await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, { ...direct, referrer: referrer() }, context())
    expect(calls[0]!.data).toEqual({ msg_type: 0, content: 'x' })
  })

  it('posts C2C and media bodies on their own routes', async () => {
    const { bot, calls } = await mount()
    await sendMessagePayload(bot, { msg_type: 7, content: ' ', media: { file_info: 'K' } }, direct, context())
    expect(calls[0]!.url).toBe(`https://api.sgroup.qq.com/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/messages`)
    expect(calls[0]!.data).toEqual({ msg_type: 7, content: ' ', media: { file_info: 'K' } })
    expect(messageKindOf(7)).toBe('media')
    expect(messageKindOf(0)).toBe('text')
    expect(messageKindOf(2)).toBe('markdown')
  })
})

describe('sendMessagePayload — quote and dedupe', () => {
  it('answers a quoted message with the reply reference of', async () => {
    const { bot, calls } = await mount()
    await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, group, context({ quote: 'REFIDX_abcdef' }))
    expect(calls[0]!.data.message_reference).toEqual({ message_id: 'REFIDX_abcdef', ignore_get_message_error: true })
  })

  it('records ext_info.ref_idx in SentPart.aliases when present', async () => {
    const { bot } = await mount(() => ({ body: { id: 'ROBOT1.0_sent', ext_info: { ref_idx: 'REFIDX_sent' } } }))
    const withAlias = await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, group, context())
    expect(withAlias.id).toBe('ROBOT1.0_sent')
    expect(withAlias.aliases).toEqual(['REFIDX_sent'])

    const { bot: plainBot } = await mount(() => ({ body: { id: 'ROBOT1.0_plain' } }))
    const withoutAlias = await sendMessagePayload(plainBot, { msg_type: 0, content: 'x' }, group, context())
    expect(withoutAlias.aliases).toBeUndefined()
  })

  it('keeps the reference a mode already serialized', async () => {
    const { bot, calls } = await mount()
    const payload = { msg_type: 0, content: 'x', message_reference: { message_id: 'REFIDX_own' } }
    await sendMessagePayload(bot, payload, group, context({ quote: 'REFIDX_abc' }))
    expect(calls[0]!.data.message_reference).toEqual({ message_id: 'REFIDX_own' })
  })

  it('bumps msg_seq and retries once on a 40054005 answer', async () => {
    const { bot, calls } = await mount((_call, index) => index === 0 ? DEDUPE : { body: { id: 'ROBOT1.0_ok' } })
    const part = await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, { ...group, referrer: referrer() }, context())
    expect(calls.map(call => call.data.msg_seq)).toEqual([2, 3])
    expect(part.id).toBe('ROBOT1.0_ok')
  })

  it('gives up when the bumped sequence is deduplicated as well', async () => {
    const { bot, calls } = await mount(() => DEDUPE)
    const error = await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, { ...group, referrer: referrer() }, context())
      .catch(error => error)
    expect(calls.map(call => call.data.msg_seq)).toEqual([2, 3])
    expect(bot.classify(error)).toMatchObject({ kind: 'invalid', code: 40054005, published: 'no' })
  })

  it('reuses the sequence of a retried part instead of publishing it twice', async () => {
    const { bot, calls } = await mount()
    const target: Target = { ...group, referrer: referrer() }
    const options = { idempotencyKey: 'op-1' }
    await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, target, context({ options }))
    await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, target, context({ options }))
    expect(calls.map(call => call.data.msg_seq)).toEqual([2, 2])
    // A second part of the same logical message takes the next sequence.
    await sendMessagePayload(bot, { msg_type: 0, content: 'y' }, target, context({ options, index: 1 }))
    expect(calls[2]!.data.msg_seq).toBe(3)
  })

  it('reports a deduplicated retried part as published with an unknown id', async () => {
    // The core retries a `retryable` failure with the same idempotency key; the platform then proves the first
    // attempt was published by deduplicating the sequence it carried.
    const { bot, calls } = await mount((_call, index) => index === 0 ? { status: 500 } : DEDUPE)
    const target: Target = { ...group, referrer: referrer() }
    const options = { idempotencyKey: 'op-2' }
    const failure = await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, target, context({ options }))
      .catch(error => error)
    expect(bot.classify(failure)).toMatchObject({ kind: 'retryable' })
    const error = await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, target, context({ options }))
      .catch(error => error)
    // No third request: the sequence already published this part, so retrying would duplicate it.
    expect(calls).toHaveLength(2)
    expect(calls[1]!.data.msg_seq).toBe(2)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error).toMatchObject({ kind: 'invalid', code: 40054005, published: 'unknown' })
  })

  it('rejects a target that is not a QQ chat and a payload that is not a request body', async () => {
    const { bot, calls } = await mount()
    const target = await sendMessagePayload(bot, { msg_type: 0, content: 'x' }, { chat: { id: 'oc_chat', type: 'group' } }, context())
      .catch(error => error)
    expect(target).toBeInstanceOf(PlatformError)
    expect(target.kind).toBe('invalid')
    const payload = await sendMessagePayload(bot, 'hello', group, context()).catch(error => error)
    expect(payload).toBeInstanceOf(PlatformError)
    expect(payload.kind).toBe('invalid')
    expect(calls).toHaveLength(0)
  })

  it('does not retry an active send on an unknown-outcome 500 even with idempotencyKey, but retries a passive send', async () => {
    const { bot, calls } = await mount((_call, index) => index === 0 || index === 1 ? { status: 500 } : { body: { id: 'ROBOT1.0_ok' } })
    const active = await bot.send(group, h('message', h('p', 'x')), { idempotencyKey: 'op-active' }).catch(error => error)
    expect(active).toBeInstanceOf(PlatformError)
    expect(active).toMatchObject({ kind: 'retryable', published: 'unknown' })
    expect(calls).toHaveLength(1)

    const result = await bot.send({ ...group, referrer: referrer() }, h('message', h('p', 'x')), { idempotencyKey: 'op-passive' })
    expect(result.handle.parts[0]!.id).toBe('ROBOT1.0_ok')
    expect(calls).toHaveLength(3)
    expect(calls[1]!.data.msg_seq).toBe(2)
    expect(calls[2]!.data.msg_seq).toBe(2)
  })
})

describe('deleteSentPart', () => {
  /** Fixed instant the two window-boundary cases inject, so neither depends on real elapsed time. */
  const EDGE_CLOCK = 1_790_000_000_000

  it('recalls a part on its chat route', async () => {
    const { bot, calls } = await mount(() => ({ body: undefined }))
    const part: SentPart = { id: 'ROBOT1.0_out_0', kind: 'text', time: Date.now() }
    await deleteSentPart(bot, part, handle(bot, group, part))
    expect(calls[0]).toMatchObject({
      url: `https://api.sgroup.qq.com/v2/groups/FBB1D91204242AAB8B61A0179A6245B0/messages/ROBOT1.0_out_0`,
      method: 'DELETE',
      data: undefined,
    })
  })

  it('refuses to recall a message older than two minutes without a request', async () => {
    const { bot, calls } = await mount()
    // Injected clock: the window boundary must not depend on how long the test itself takes.
    const now = EDGE_CLOCK
    const part: SentPart = { id: 'ROBOT1.0_out_0', kind: 'text', time: now - DELETE_WINDOW_MS - 1 }
    const error = await deleteSentPart(bot, part, handle(bot, group, part), now).catch(error => error)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('invalid')
    expect(error.published).toBe('no')
    expect(calls).toHaveLength(0)
  })

  it('recalls at the very edge of the window', async () => {
    const { bot, calls } = await mount(() => ({ body: undefined }))
    const now = EDGE_CLOCK
    const part: SentPart = { id: 'ROBOT1.0_out_0', kind: 'text', time: now - DELETE_WINDOW_MS }
    await deleteSentPart(bot, part, handle(bot, group, part), now)
    expect(calls).toHaveLength(1)
  })

  it('surfaces the platform refusal of a recall', async () => {
    const { bot } = await mount(() => ({ status: 403, body: { code: 11253, message: 'no permission' } }))
    const part: SentPart = { id: 'ROBOT1.0_out_0', kind: 'text', time: Date.now() }
    const error = await deleteSentPart(bot, part, handle(bot, direct, part)).catch(error => error)
    expect(bot.classify(error)).toMatchObject({ kind: 'permission', published: 'no' })
  })
})
