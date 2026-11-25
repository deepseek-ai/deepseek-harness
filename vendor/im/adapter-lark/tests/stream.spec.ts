/**
 * Streaming through the Lark adapter.
 *
 * Two layers:
 * - **installation**: `LarkBot.streamDriver` answers the core `edit` driver in card mode (`cardStreaming !== false`) and
 *   in post mode, and `undefined` (buffered `final`) nowhere else; the drivers are memoized, so every stream of one bot
 *   reuses the same stateless instance;
 * - **through `bot.stream`** (the stream scheduler) under fake timers with a scripted growing activity from
 *   `streamingScripts()`: a card edited in place (one `PATCH` per state, no CardKit entity) and the post `edit` path,
 *   including its 20-edit budget and the `230075` refusal.
 *
 * Every request is answered by a stubbed transport; nothing touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import { Satori, type Target } from '@deepseek-ai/cordis-plugin-im-core'
import { streamingScripts } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import LarkBot, { Config, type LarkConfig } from '@deepseek-ai/cordis-plugin-im-adapter-lark'
import * as Markdown from '@deepseek-ai/cordis-plugin-im-markdown'

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
  await ctx.plugin(Markdown)
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

/** The message routes one stream uses. */
function route(call: Call): Response {
  const ok = () => Response.json({ code: 0, data: {} })
  if (call.method === 'POST' && call.path === '/open-apis/im/v1/messages') {
    return Response.json({ code: 0, data: { message_id: 'om_1', chat_id: CHAT } })
  }
  if (call.path === '/open-apis/im/v1/messages/om_1') {
    return call.method === 'PUT' || call.method === 'PATCH' || call.method === 'DELETE' ? ok() : unexpected(call)
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

// ---------------------------------------------------------------------------------------------------------------
// Installation

describe('driver installation', () => {
  it('answers the edit driver in card mode and in post mode', async () => {
    const { bot } = await mount()
    const card = bot.streamDriver('card')
    expect(card?.strategy).toBe('edit')
    // The driver is one stateless instance: the per-message bookkeeping lives in `handle.state`.
    expect(bot.streamDriver('card')).toBe(card)

    const post = bot.streamDriver('post')
    expect(post?.strategy).toBe('edit')
    expect(bot.streamDriver('post')).toBe(post)
    expect(bot.streamDriver('text')).toBeUndefined()
  })

  it('keeps the buffered final strategy when card editing is off', async () => {
    const { bot } = await mount(undefined, { cardStreaming: false })
    expect(bot.streamDriver('card')).toBeUndefined()
    // The post driver is independent of the card flag.
    expect(bot.streamDriver('post')?.strategy).toBe('edit')
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

  it('streams a card by editing the one message in place', async () => {
    const { bot, calls } = await mount()
    const stream = bot.stream(target)
    expect(stream.strategy).toBe('edit')

    const result = await run(stream, script('growing-text').states)

    // One message: the first state sends it, every later state replaces that same message's card JSON.
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/open-apis/im/v1/messages' })
    expect(bodyOf(calls[0]).msg_type).toBe('interactive')
    const edits = calls.slice(1)
    expect(edits.length).toBeGreaterThan(0)
    for (const call of edits) {
      expect(call).toMatchObject({ method: 'PATCH', path: '/open-apis/im/v1/messages/om_1' })
      // The whole card travels again: an inline card is replaced, not patched element by element.
      expect(JSON.parse(bodyOf(call).content)).toMatchObject({ schema: '2.0', config: { update_multi: true } })
    }
    expect(JSON.stringify(JSON.parse(bodyOf(edits.at(-1)!).content))).toContain('Patching them now.')
    // A card message is edited directly: no CardKit entity and no streaming mode that could expire.
    expect(calls.some(call => call.path.includes('/cardkit/'))).toBe(false)
    expect(stream.state).toBe('closed')
    expect(result.handle.parts[0]).toMatchObject({ id: 'om_1', kind: 'card-inline' })
  })

  it('streams a post through the same driver when the card cannot stream', async () => {
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
