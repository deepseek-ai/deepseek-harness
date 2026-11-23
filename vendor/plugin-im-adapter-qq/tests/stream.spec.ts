/**
 * The C2C `append` stream driver.
 *
 * Two layers: the driver itself (suffix sends, `index` / `stream_msg_id` / `input_state` bookkeeping, the passive
 * ticket per chunk, the `shape` and `budget` violations) driven directly, and the same driver through `bot.stream`
 * (the stream scheduler) under fake timers, where a non-prefix change has to end in the recall + resend and a group
 * has to send exactly once. Every request is answered by a scripted transport; no test leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import {
  createRenderReport,
  PlatformError,
  Satori,
  StreamLimitError,
  type Prepared,
  type SendOptions,
  type StreamTickContext,
  type Target,
} from '@deepseek-ai/cordis-plugin-im-core'
import { h, normalize } from '@deepseek-ai/satori-element'
import QQBot, {
  Config,
  type QqMessageRequest,
  type QQConfig,
} from '@deepseek-ai/cordis-plugin-im-adapter-qq'
import type { QQReferrer } from '../src/decode.ts'
import type { QqDraft } from '../src/modes/shared.ts'
import { createStreamDriver, INPUT_STATE_CLOSE, INPUT_STATE_OPEN, type QqStreamState } from '../src/stream.ts'
import * as Markdown from '@deepseek-ai/cordis-plugin-im-markdown'

const GROUP = 'group:FBB1D91204242AAB8B61A0179A6245B0'
const DIRECT = 'user:DD8246C68EC19CAF8D2AA76941180EA4'

const group: Target = { chat: { id: GROUP, type: 'group' } }

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

/** An answer of the scripted platform. */
interface Answer {
  status?: number
  body?: unknown
}

/** The answer of a successful `stream_messages` call: the streamed message's identity arrives in `id`. */
const STREAM_ANSWER: Answer = { body: { id: 'stream-1', remain_msg_len: 1000 } }

/** A `40054005` answer, i.e. `(msg_id, msg_seq)` already used . */
const DEDUPE: Answer = { status: 400, body: { code: 40054005, message: '消息被去重' } }

/**
 * Mount the adapter on a context whose only transport is the scripted `http/fetch` hook.
 *
 * @param answer - answer of the n-th API request.
 * @param input - config overrides; streaming is on unless a test turns it off.
 */
async function mount(
  answer: (call: Call, index: number) => Answer = () => STREAM_ANSWER,
  input: Partial<QQConfig> = {},
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  await ctx.plugin(Markdown)
  const calls: Call[] = []
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
  const config: QQConfig = Config({ appId: '102106848', secret: 'secret', transport: 'none', stream: true, ...input } as QQConfig)
  await ctx.plugin(QQBot, config)
  const bot = ctx.bots[0] as QQBot
  return { bot, calls }
}

/** A referrer of an inbound C2C message, received now. */
function referrer(input: Partial<QQReferrer> = {}): QQReferrer {
  return { msg_id: 'ROBOT1.0_in', receivedAt: Date.now(), chatType: 'direct', chatId: DIRECT, ...input }
}

/** A C2C target that answers the inbound message above. */
function direct(input: Partial<QQReferrer> = {}): Target {
  return { chat: { id: DIRECT, type: 'direct' }, referrer: referrer(input) }
}

/** The prepared draft of one text state (`Prepared<QqDraft>`, what `open` / `tick` / `close` receive). */
function prepared(content: string): Prepared<QqDraft> {
  return { draft: { msg_type: 0, content }, resolved: new Map() }
}

/** The serialized payload of one text state (`QqMessageRequest`, the mode's `serialize`). */
function payload(content: string): QqMessageRequest {
  return { msg_type: 0, content }
}

/** A tick context of one driver call. */
function tickContext(target: Target, options: SendOptions = {}): StreamTickContext {
  return {
    target,
    mode: 'text',
    options,
    signal: new AbortController().signal,
    report: createRenderReport(),
    content: normalize('state'),
    attempt: 1,
  }
}

/** The driver bookkeeping of a handle the driver created. */
function stateOf(handle: { state?: unknown }): QqStreamState {
  return handle.state as QqStreamState
}

describe('driver installation', () => {
  it('answers the C2C append driver only for a direct chat with streaming enabled', async () => {
    const off = await mount(undefined, { stream: false })
    expect(off.bot.streamDriver('text', direct())).toBeUndefined()
    expect(off.bot.streamDriver('markdown', direct())).toBeUndefined()

    const { bot } = await mount()
    expect(bot.streamDriver('text', direct())?.strategy).toBe('append')
    expect(bot.streamDriver('markdown', direct())?.strategy).toBe('append')
    // 群消息不支持流式参数, so a group keeps the core `final` strategy.
    expect(bot.streamDriver('text', group)).toBeUndefined()
  })
})

describe('driver — open', () => {
  it('starts the streamed message with the whole first state and the passive fields', async () => {
    const { bot, calls } = await mount()
    const driver = createStreamDriver(bot, { now: () => 1234 })
    const target = direct()
    const handle = await driver.open(prepared('Hel'), payload('Hel'), tickContext(target))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: `https://api.sgroup.qq.com/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/stream_messages`,
      method: 'POST',
      data: {
        content_type: 'text',
        content_raw: 'Hel',
        index: 0,
        input_mode: 'replace',
        input_state: INPUT_STATE_OPEN,
        msg_id: 'ROBOT1.0_in',
        msg_seq: 2,
      },
    })
    expect(handle.parts).toHaveLength(1)
    expect(handle.parts[0]).toMatchObject({ id: 'stream-1', kind: 'text', time: 1234 })
    expect(handle).toMatchObject({ bot: bot.id, target, mode: 'text', edits: 0 })
    // The stream id comes from the first answer's `id`: the endpoint has no `stream_msg_id` field of its own.
    expect(stateOf(handle)).toMatchObject({ contentType: 'text', published: 'Hel', index: 1, streamId: 'stream-1' })
  })

  it('streams markdown bodies as content_type markdown', async () => {
    const { bot, calls } = await mount()
    const driver = createStreamDriver(bot)
    const markdown: QqMessageRequest = { msg_type: 2, markdown: { content: '**hi**' } }
    await driver.open(prepared('**hi**'), markdown, tickContext(direct()))
    expect(calls[0]!.data).toMatchObject({ content_type: 'markdown', content_raw: '**hi**' })
  })

  it('refuses a state the endpoint cannot carry, so the scheduler sends an ordinary message instead', async () => {
    const { bot, calls } = await mount()
    const driver = createStreamDriver(bot)
    const target = direct()

    const media: QqMessageRequest = { msg_type: 7, content: ' ', media: { file_info: 'file_info' } }
    await expect(driver.open({ draft: { msg_type: 7, tag: 'img', media: {} as never }, resolved: new Map() } as never, media, tickContext(target)))
      .rejects.toMatchObject({ name: 'StreamLimitError', violation: { kind: 'shape' } })

    const keyboard: QqMessageRequest = { msg_type: 2, markdown: { content: 'x' }, keyboard: { content: { rows: [] } } }
    await expect(driver.open(prepared('x'), keyboard, tickContext(target)))
      .rejects.toMatchObject({ name: 'StreamLimitError', violation: { kind: 'shape' } })

    // A state that switches text/markdown cannot be appended to the message it already created.
    expect(calls).toHaveLength(0)
  })

  it('needs a passive reply context: without one the stream is a budget violation, not an active send', async () => {
    const { bot, calls } = await mount()
    const driver = createStreamDriver(bot)
    await expect(driver.open(prepared('a'), payload('a'), tickContext({ chat: { id: DIRECT, type: 'direct' } })))
      .rejects.toMatchObject({ name: 'StreamLimitError', violation: { kind: 'budget' } })
    expect(calls).toHaveLength(0)
  })
})

describe('driver — tick and close', () => {
  it('appends only the suffix the scheduler diffed, and closes with input_state 10', async () => {
    const { bot, calls } = await mount()
    const driver = createStreamDriver(bot)
    const target = direct()
    const handle = await driver.open(prepared('Hel'), payload('Hel'), tickContext(target))

    await driver.tick(handle, { draft: prepared('Hello'), payload: payload('Hello'), patches: [{ append: 'lo' }] }, tickContext(target))
    await driver.close(handle, { draft: prepared('Hello world'), payload: payload('Hello world') }, tickContext(target))

    expect(calls.map(call => call.data)).toMatchObject([
      { content_raw: 'Hel', index: 0, input_state: INPUT_STATE_OPEN },
      { content_raw: 'Hello', index: 1, input_state: INPUT_STATE_OPEN, stream_msg_id: 'stream-1', msg_seq: 3 },
      { content_raw: 'Hello world', index: 2, input_state: INPUT_STATE_CLOSE, stream_msg_id: 'stream-1', msg_seq: 4 },
    ])
    expect(stateOf(handle)).toMatchObject({ published: 'Hello world', index: 3, streamId: 'stream-1' })
    expect(handle.edits).toBe(1)
  })

  it('computes the suffix itself when the scheduler had no diff for the state', async () => {
    const { bot, calls } = await mount()
    const driver = createStreamDriver(bot)
    const target = direct()
    const handle = await driver.open(prepared('abc'), payload('abc'), tickContext(target))
    await driver.tick(handle, { draft: prepared('abcdef'), payload: payload('abcdef') }, tickContext(target))
    expect(calls[1]!.data).toMatchObject({ content_raw: 'abcdef', index: 1, input_mode: 'replace' })
  })

  it('skips a state the platform already shows', async () => {
    const { bot, calls } = await mount()
    const driver = createStreamDriver(bot)
    const target = direct()
    const handle = await driver.open(prepared('abc'), payload('abc'), tickContext(target))
    await driver.tick(handle, { draft: prepared('abc'), payload: payload('abc'), patches: [] }, tickContext(target))
    expect(calls).toHaveLength(1)
    expect(handle.edits).toBe(0)
  })

  it('reports a non-prefix state as a shape violation', async () => {
    const { bot, calls } = await mount()
    const driver = createStreamDriver(bot)
    const target = direct()
    const handle = await driver.open(prepared('abc'), payload('abc'), tickContext(target))
    const error = await driver
      .tick(handle, { draft: prepared('xyz'), payload: payload('xyz') }, tickContext(target))
      .then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(StreamLimitError)
    expect((error as StreamLimitError).violation.kind).toBe('shape')
    expect(calls).toHaveLength(1)
  })

  it('refuses a chunk the message has no room for as a shape violation, so the scheduler can resend it', async () => {
    // A live run showed the answer granting far less room than the next state needed. That is the streamed
    // message, not the content, being too small — a fresh message carries it — so the violation is `shape`.
    const { bot } = await mount(() => ({ body: { id: 'ROBOT1.0_stream', stream_msg_id: 'stream-1', remain_msg_len: 2 } }))
    const driver = createStreamDriver(bot)
    const target = direct()
    const handle = await driver.open(prepared('abc'), payload('abc'), tickContext(target))
    await expect(driver.close(handle, { draft: prepared('abcdef'), payload: payload('abcdef') }, tickContext(target)))
      .rejects.toMatchObject({ name: 'StreamLimitError', violation: { kind: 'shape', key: 'limit.text.chars', limit: 5, actual: 6 } })
  })
})

describe('driver — budget and passive sequencing', () => {
  it('reports the passive replies left and keeps the streaming window out of the budget', async () => {
    const { bot } = await mount()
    const driver = createStreamDriver(bot)
    const target = direct()
    const handle = await driver.open(prepared('a'), payload('a'), tickContext(target))
    // `passive.c2cReplies` is 4 and the opening chunk spent one.
    expect(driver.budget(handle)).toEqual({ updatesLeft: 3 })
  })

  it('reports no budget at all without a passive context', async () => {
    const { bot } = await mount()
    const driver = createStreamDriver(bot)
    const handle = { bot: bot.id, target: group, mode: 'text', parts: [], createdAt: 0, edits: 0, content: normalize(''), state: undefined }
    expect(driver.budget(handle as never)).toEqual({ updatesLeft: 0 })
  })

  it('moves to the next msg_seq when another client took the one it was given', async () => {
    const { bot, calls } = await mount((_call, index) => (index === 0 ? DEDUPE : STREAM_ANSWER))
    const driver = createStreamDriver(bot)
    const target = direct()
    const handle = await driver.open(prepared('abc'), payload('abc'), tickContext(target, { idempotencyKey: 'op-1' }))
    expect(calls.map(call => call.data.msg_seq)).toEqual([2, 3])
    expect(calls.map(call => call.data.index)).toEqual([0, 0])
    expect(handle.parts[0]!.id).toBe('stream-1')
  })

  it('reports a retried chunk that the platform deduped as published with an unknown state', async () => {
    // The opening chunk succeeds, the first attempt of the next one is lost in transport, and its retry is deduped.
    const { bot } = await mount((_call, index) => (index === 0 ? STREAM_ANSWER : index === 1 ? { status: 500, body: {} } : DEDUPE))
    const driver = createStreamDriver(bot)
    const target = direct()
    const handle = await driver.open(prepared('abc'), payload('abc'), tickContext(target, { idempotencyKey: 'op-1' }))
    const options = { idempotencyKey: 'op-1' }
    await expect(driver.tick(handle, { draft: prepared('abcdef'), payload: payload('abcdef') }, tickContext(target, options)))
      .rejects.toBeInstanceOf(Error)
    const error = await driver
      .tick(handle, { draft: prepared('abcdef'), payload: payload('abcdef') }, tickContext(target, options))
      .then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(PlatformError)
    expect((error as PlatformError).published).toBe('unknown')
  })
})

describe('through the scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const flush = () => vi.advanceTimersByTimeAsync(0)
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

  it('streams the states into one message: open, one appended suffix, then the closing chunk', async () => {
    const { bot, calls } = await mount()
    const target = direct()
    const stream = bot.stream(target)
    expect(stream.strategy).toBe('append')

    stream.update('Hel')
    await flush()
    stream.update('Hello')
    await advance(300)
    const done = stream.close('Hello world')
    done.catch(() => {})
    await advance(3000)
    const result = await done

    expect(calls).toHaveLength(3)
    expect(calls.map(call => ({ method: call.method, url: call.url, data: call.data }))).toMatchObject([
      {
        method: 'POST',
        data: { content_type: 'text', content_raw: 'Hel', index: 0, input_state: INPUT_STATE_OPEN },
      },
      { method: 'POST', data: { content_raw: 'Hello', index: 1, input_state: INPUT_STATE_OPEN } },
      { method: 'POST', data: { content_raw: 'Hello world', index: 2, input_state: INPUT_STATE_CLOSE } },
    ])
    expect(calls.every(call => call.url.endsWith(`/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/stream_messages`))).toBe(true)
    expect(result.handle.parts[0]!.id).toBe('stream-1')
    expect(stream.state).toBe('closed')
  })

  it('streams only the settled markdown blocks, so an unclosed emphasis never breaks the appended prefix', async () => {
    const { bot, calls } = await mount(undefined, { markdown: true })
    const stream = bot.stream(direct())

    // Nothing is settled while the only block is still being written: no request at all.
    stream.update(h.markdown('**未闭'))
    await flush()
    expect(calls).toHaveLength(0)
    stream.update(h.markdown('**加粗** 一段\n\n第二段 **未闭'))
    await advance(300)
    // The second paragraph's emphasis closes later, which re-parses it; it stays back until the stream closes.
    stream.update(h.markdown('**加粗** 一段\n\n第二段 **未闭合** 继续'))
    await advance(300)
    const done = stream.close(h.markdown('**加粗** 一段\n\n第二段 **未闭合** 继续'))
    done.catch(() => {})
    await advance(3000)
    await done

    expect(calls.map(call => ({ method: call.method, data: call.data }))).toMatchObject([
      { method: 'POST', data: { content_type: 'markdown', content_raw: '**加粗** 一段', input_state: INPUT_STATE_OPEN } },
      { method: 'POST', data: { content_raw: '**加粗** 一段\n\n第二段 **未闭合** 继续', input_state: INPUT_STATE_CLOSE } },
    ])
  })

  it('falls back to one plain message when the stream cannot open (no passive reply context)', async () => {
    const { bot, calls } = await mount()
    const stream = bot.stream({ chat: { id: DIRECT, type: 'direct' } })
    stream.update('abc')
    await flush()
    const done = stream.close('abc')
    done.catch(() => {})
    await advance(3000)
    const result = await done
    // The opening chunk is a `budget` violation, which the scheduler answers with an ordinary send; only that one
    // request left.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: `https://api.sgroup.qq.com/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/messages`,
      data: { msg_type: 0, content: 'abc' },
    })
    expect(calls[0]!.data.msg_id).toBeUndefined()
    expect(result.handle.parts[0]!.id).toBe('stream-1')
  })

  it('resolves a non-prefix final state by recalling the streamed message and sending the state fresh', async () => {
    const { bot, calls } = await mount()
    const target = direct()
    const stream = bot.stream(target)
    stream.update('abc')
    await flush()
    const done = stream.close('xyz')
    done.catch(() => {})
    await advance(3000)
    const result = await done

    expect(calls.map(call => call.method)).toEqual(['POST', 'DELETE', 'POST'])
    expect(calls[1]!.url).toBe(`https://api.sgroup.qq.com/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/messages/stream-1`)
    expect(calls[2]!.url).toBe(`https://api.sgroup.qq.com/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/messages`)
    expect(calls[2]!.data).toMatchObject({ msg_type: 0, content: 'xyz' })
    expect(result.handle.parts[0]!.id).toBe('stream-1')
  })

  it('recalls and resends instead of failing when the streamed message runs out of room', async () => {
    // 81 characters of room left after the first chunk.
    const { bot, calls } = await mount(() => ({ body: { id: 'ROBOT1.0_stream', stream_msg_id: 'stream-1', remain_msg_len: 81 } }))
    const stream = bot.stream(direct())

    const first = 'a'.repeat(76)
    stream.update(first)
    await flush()
    expect(calls.map(call => call.data.content_raw)).toEqual([first])

    // 130 characters: the suffix is 54, so the message still takes the state — it must not be refused.
    const second = first + 'b'.repeat(54)
    stream.update(second)
    await advance(300)
    expect(calls[1]!.data).toMatchObject({ content_raw: second, index: 1, input_state: INPUT_STATE_OPEN })

    // The next state appends 94 characters and no longer fits: the tick is dropped without a request and the stream
    // survives; close resolves it by recall and resend — recall the streamed message, then send the state as a
    // normal message.
    const third = second + 'c'.repeat(94)
    stream.update(third)
    await advance(1000)
    expect(calls).toHaveLength(2)

    const done = stream.close(third)
    done.catch(() => {})
    await advance(3000)
    const result = await done
    expect(calls.map(call => call.method)).toEqual(['POST', 'POST', 'DELETE', 'POST'])
    expect(calls[2]!.url).toBe(`https://api.sgroup.qq.com/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/messages/ROBOT1.0_stream`)
    expect(calls[3]!.url).toBe(`https://api.sgroup.qq.com/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/messages`)
    expect(calls[3]!.data).toMatchObject({ msg_type: 0, content: third })
    expect(result.handle.parts[0]!.id).toBe('ROBOT1.0_stream')
    expect(stream.state).toBe('closed')
  })

  it('recalls and resends when the driver refuses a non-prefix state at close (the platform state is uncertain)', async () => {
    // A failed tick leaves the platform state unknown, so the scheduler cannot pre-check the prefix and the driver's
    // own StreamLimitError('shape') from `close` has to reach the scheduler instead of failing the stream.
    const { bot, calls } = await mount((_call, index) => (index === 1 ? { status: 500, body: {} } : STREAM_ANSWER))
    const stream = bot.stream(direct(), { attempts: 1 })
    stream.update('abc')
    await flush()
    stream.update('abcdef')
    await advance(300)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.data).toMatchObject({ content_raw: 'abcdef', index: 1 })

    const done = stream.close('xyz')
    done.catch(() => {})
    await advance(3000)
    const result = await done
    expect(calls.map(call => call.method)).toEqual(['POST', 'POST', 'DELETE', 'POST'])
    expect(calls[2]!.url).toBe(`https://api.sgroup.qq.com/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/messages/stream-1`)
    expect(calls[3]!.data).toMatchObject({ msg_type: 0, content: 'xyz' })
    expect(result.handle.parts[0]!.id).toBe('stream-1')
    expect(stream.state).toBe('closed')
  })

  it('recalls and resends a shrinking final state instead of failing the stream', async () => {
    const { bot, calls } = await mount()
    const stream = bot.stream(direct())

    const first = 'a'.repeat(76)
    stream.update(first)
    await flush()
    stream.update(first + 'b'.repeat(54))
    await advance(300)
    expect(calls).toHaveLength(2)

    // The final state is shorter than what the platform already shows: append never replaces it. The tick carrying
    // it is dropped and close recalls the streamed message and sends the final state fresh.
    const shorter = 'a'.repeat(20)
    stream.update(shorter)
    await advance(1000)
    expect(calls).toHaveLength(2)

    const done = stream.close(shorter)
    done.catch(() => {})
    await advance(3000)
    const result = await done
    expect(calls.map(call => call.method)).toEqual(['POST', 'POST', 'DELETE', 'POST'])
    expect(calls[2]!.url).toBe(`https://api.sgroup.qq.com/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/messages/stream-1`)
    expect(calls[3]!.data).toMatchObject({ msg_type: 0, content: shorter })
    expect(result.handle.parts[0]!.id).toBe('stream-1')
    expect(stream.state).toBe('closed')
  })

  it('settles the stream and resends when the final state does not extend it and recall is refused', async () => {
    // QQ refuses to delete a streamed message, so the partial is closed where it stands instead of staying on
    // 生成中 forever, and the final state goes out as a fresh message.
    const { bot, calls } = await mount(call => (call.method === 'DELETE' ? { status: 400, body: { code: 40054007, message: 'no permission' } } : STREAM_ANSWER))
    const stream = bot.stream(direct())
    stream.update('abc')
    await flush()
    const done = stream.close('xyz')
    done.catch(() => {})
    await advance(3000)
    await done
    const streamed = calls.filter(call => call.url.endsWith('/stream_messages'))
    expect(streamed.map(call => call.data)).toMatchObject([
      { content_raw: 'abc', input_state: INPUT_STATE_OPEN, index: 0 },
      { content_raw: 'abc', input_state: INPUT_STATE_CLOSE, index: 1 },
    ])
    const plain = calls.filter(call => call.url.endsWith('/messages'))
    expect(plain.map(call => call.data.content)).toEqual(['xyz'])
  })

  it('sends a group state exactly once, at close (the core final strategy)', async () => {
    const { bot, calls } = await mount()
    const stream = bot.stream(group)
    expect(stream.strategy).toBe('final')
    stream.update('a')
    await flush()
    stream.update('ab')
    await advance(1000)
    expect(calls).toHaveLength(0)
    const done = stream.close('abc')
    done.catch(() => {})
    await advance(3000)
    await done
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: `https://api.sgroup.qq.com/v2/groups/FBB1D91204242AAB8B61A0179A6245B0/messages`,
      method: 'POST',
      data: { msg_type: 0, content: 'abc' },
    })
  })
})
