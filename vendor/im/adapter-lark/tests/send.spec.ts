/**
 * The network stage of the Lark adapter: create vs reply vs reply-in-thread, the `receive_id_type` of a target, the
 * per-part `uuid`, the `PUT`/`PATCH`/CardKit edit routes and the recall.
 *
 * Every request is answered by a stubbed transport: nothing touches the network.
 */

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import {
  normalize, PlatformError, Satori, type MessageHandle, type SendContext, type SentPart, type Target,
} from '@deepseek-ai/cordis-plugin-im-core'
import LarkBot, { Config, LarkApiError, type LarkConfig, type LarkReferrer } from '@deepseek-ai/cordis-plugin-im-adapter-lark'
import * as Markdown from '@deepseek-ai/cordis-plugin-im-markdown'
import {
  deleteSentPart, editMessagePayload, partKindOf, receiveIdTypeOf, replyPlan, sendMessagePayload, type LarkPayload,
} from '../src/send.ts'

const group: Target = { chat: { id: 'oc_chat', type: 'group' } }

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One request the adapter made. */
interface Call {
  path: string
  method: string
  search: string
  body: any
}

/** What the platform answers for one path. */
type Route = (call: Call) => Response | Promise<Response>

/** The outbound routes. */
function routes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    '/open-apis/im/v1/messages': () => Response.json({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_chat' } }),
    '/open-apis/im/v1/messages/om_parent/reply': () => Response.json({ code: 0, data: { message_id: 'om_reply', thread_id: 'omt_1' } }),
    '/open-apis/im/v1/messages/om_1': (call) => Response.json({ code: 0, data: { message_id: 'om_1', method: call.method } }),
    '/open-apis/cardkit/v1/cards/card_1': () => Response.json({ code: 0, data: {} }),
    ...overrides,
  }
}

/** Mount the adapter; the bot is constructed directly, so its long connection never starts. */
async function mount(overrides: Record<string, Route> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  await ctx.plugin(Markdown)
  const calls: Call[] = []
  const table = routes(overrides)
  ctx.on('http/fetch', async (url: URL, init: any) => {
    const call: Call = { path: url.pathname, method: init.method ?? 'GET', search: url.search, body: init.body }
    if (call.path === '/open-apis/auth/v3/tenant_access_token/internal') {
      return Response.json({ code: 0, tenant_access_token: 't-token', expire: 7200 })
    }
    calls.push(call)
    const route = table[call.path]
    if (!route) throw new Error(`Unexpected request: ${call.method} ${call.path}`)
    return await route(call)
  })
  const config: LarkConfig = Config({ appId: 'cli_lark', appSecret: 'secret' } as LarkConfig)
  const bot = new LarkBot(ctx, config)
  return { ctx, bot, calls }
}

/** A post payload as the post mode serializes it: `content` is the platform **object**. */
const post: LarkPayload = { msg_type: 'post', content: { zh_cn: { content: [[{ tag: 'md', text: 'hi' }]] } } }

/** The card JSON 2.0 document as the card mode serializes it. */
const card = { schema: '2.0', config: { update_multi: true }, body: { elements: [{ tag: 'markdown', content: 'hi' }] } }

/** One send context of part `index`. */
function send(index = 0, options: SendContext['options'] = {}, quote?: string): SendContext {
  return { index, options, previous: [], ...quote === undefined ? {} : { quote } }
}

/** A handle whose parts were published with the given kinds. */
function handle(kind = 'post', state?: unknown): MessageHandle {
  const parts: SentPart[] = [{ id: 'om_1', kind, time: 1 }]
  return {
    bot: 'lark:cli_lark',
    target: group,
    mode: kind.startsWith('card') ? 'card' : 'post',
    parts,
    createdAt: 1,
    edits: 0,
    content: normalize([]),
    ...state === undefined ? {} : { state },
  }
}

/** The body of one request, decoded. */
function bodyOf(call: Call | undefined): any {
  expect(call).toBeDefined()
  return JSON.parse(String(call!.body))
}

describe('receiveIdTypeOf', () => {
  it('addresses a chat by its chat id, whatever the chat type', () => {
    expect(receiveIdTypeOf(group)).toBe('chat_id')
    expect(receiveIdTypeOf({ chat: { id: 'oc_p2p', type: 'direct' } })).toBe('chat_id')
  })

  it('addresses a user by the id it names', () => {
    expect(receiveIdTypeOf({ chat: { id: 'ou_user', type: 'direct' } })).toBe('open_id')
    expect(receiveIdTypeOf({ chat: { id: 'on_union', type: 'direct' } })).toBe('union_id')
  })
})

describe('replyPlan', () => {
  const bot = { referrerOf: () => undefined } as unknown as LarkBot

  it('creates when nothing is answered', () => {
    expect(replyPlan(bot, group, send())).toEqual({ inThread: false })
  })

  it('replies to the quote', () => {
    expect(replyPlan(bot, group, send(0, {}, 'om_parent'))).toEqual({ messageId: 'om_parent', inThread: false })
  })

  it('replies inside the thread the quote lives in', () => {
    const threaded = {
      referrerOf: () => ({ receivedAt: 1, chatType: 'topic', chatId: 'oc_chat', messageId: 'om_parent', threadId: 'omt_1' }),
    } as unknown as LarkBot
    expect(replyPlan(threaded, group, send(0, {}, 'om_parent'))).toEqual({ messageId: 'om_parent', inThread: true })
  })

  it('answers the referrer when a boolean thread was requested and defers an unmatched thread id to anchor lookup', () => {
    const botWithReferrer = {
      id: 'lark:cli_lark',
      referrerOf: () => ({ receivedAt: 1, chatType: 'group', chatId: 'oc_chat', messageId: 'om_trigger' }),
    } as unknown as LarkBot
    expect(replyPlan(botWithReferrer, { ...group, thread: true }, send())).toEqual({ messageId: 'om_trigger', inThread: true })
    expect(replyPlan(botWithReferrer, { ...group, thread: 'omt_9' }, send())).toEqual({ threadId: 'omt_9', inThread: true })
    const matchingReferrer = {
      id: 'lark:cli_lark',
      referrerOf: () => ({
        receivedAt: 1, chatType: 'topic', chatId: 'oc_chat', messageId: 'om_reply_2', threadId: 'omt_9', rootId: 'om_root_9',
      }),
    } as unknown as LarkBot
    expect(replyPlan(matchingReferrer, { ...group, thread: 'omt_9' }, send())).toEqual({ messageId: 'om_root_9', inThread: true })
  })

  it('never invents a reply target', () => {
    expect(replyPlan(bot, { ...group, thread: true }, send())).toEqual({ inThread: false })
  })
})

describe('sendPayload: create', () => {
  it('creates the message in the chat with the JSON content of the payload', async () => {
    const { bot, calls } = await mount()
    const part = await bot.sendPayload(post, group, send())
    expect(part).toMatchObject({ id: 'om_sent', kind: 'post' })
    expect(part.time).toBeGreaterThan(0)
    expect(part.raw).toMatchObject({ message_id: 'om_sent' })
    const call = calls.find(entry => entry.method === 'POST')!
    expect(call.path).toBe('/open-apis/im/v1/messages')
    expect(call.search).toBe(`?receive_id_type=chat_id`)
    expect(bodyOf(call)).toEqual({
      receive_id: 'oc_chat',
      msg_type: 'post',
      content: JSON.stringify(post.content),
    })
  })

  it('sends a card payload and records the inline-card kind', async () => {
    const { bot, calls } = await mount()
    const part = await bot.sendPayload({ msg_type: 'interactive', content: card }, group, send())
    expect(part.kind).toBe('card-inline')
    expect(bodyOf(calls[0])).toEqual({
      receive_id: 'oc_chat',
      msg_type: 'interactive',
      content: JSON.stringify(card),
    })
  })

  it('addresses a direct chat by its open id', async () => {
    const { bot, calls } = await mount()
    await bot.sendPayload(post, { chat: { id: 'ou_user', type: 'direct' } }, send())
    expect(calls[0]!.search).toBe('?receive_id_type=open_id')
    expect(bodyOf(calls[0]).receive_id).toBe('ou_user')
  })

  it('derives the uuid from the idempotency key and the part index', async () => {
    const { bot, calls } = await mount()
    await bot.sendPayload(post, group, send(1, { idempotencyKey: 'op-1' }))
    expect(bodyOf(calls[0]).uuid).toBe(createHash('sha256').update('op-1#1').digest('hex').slice(0, 32))
    // A different part of the same logical message gets its own key.
    await bot.sendPayload(post, group, send(0, { idempotencyKey: 'op-1' }))
    expect(bodyOf(calls[1]).uuid).not.toBe(bodyOf(calls[0]).uuid)
  })

  it('sends no uuid when the caller gave no idempotency key', async () => {
    const { bot, calls } = await mount()
    await bot.sendPayload(post, group, send())
    expect(bodyOf(calls[0])).not.toHaveProperty('uuid')
  })

  it('aborts before the request when the caller signal is already aborted', async () => {
    const { bot, calls } = await mount()
    const controller = new AbortController()
    controller.abort()
    await expect(bot.sendPayload(post, group, send(0, { signal: controller.signal }))).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('sendPayload: reply and thread', () => {
  it('replies to the quoted message', async () => {
    const { bot, calls } = await mount()
    const part = await bot.sendPayload(post, group, send(0, {}, 'om_parent'))
    expect(part.id).toBe('om_reply')
    const call = calls.find(entry => entry.path === '/open-apis/im/v1/messages/om_parent/reply')!
    expect(call.method).toBe('POST')
    expect(bodyOf(call)).toEqual({ msg_type: 'post', content: JSON.stringify(post.content) })
  })

  it('replies inside the thread of a threaded referrer', async () => {
    const { bot, calls } = await mount()
    const target: Target = {
      ...group,
      referrer: { receivedAt: 5, chatType: 'topic', chatId: 'oc_chat', messageId: 'om_parent', threadId: 'omt_1' },
    }
    await bot.sendPayload(post, target, send())
    const call = calls.find(entry => entry.path.endsWith('/reply'))!
    expect(call.path).toBe('/open-apis/im/v1/messages/om_parent/reply')
    expect(bodyOf(call)).toMatchObject({ reply_in_thread: true })
  })

  it('answers the referrer inside a thread an explicit target asked for', async () => {
    const { bot, calls } = await mount()
    const target: Target = {
      ...group,
      thread: true,
      referrer: { receivedAt: 5, chatType: 'group', chatId: 'oc_chat', messageId: 'om_parent' },
    }
    await bot.sendPayload(post, target, send())
    expect(calls[0]!.path).toBe('/open-apis/im/v1/messages/om_parent/reply')
    expect(bodyOf(calls[0])).toMatchObject({ reply_in_thread: true })
  })

  it('creates when the referrer is not threaded and no thread was requested', async () => {
    const { bot, calls } = await mount()
    const target: Target = {
      ...group,
      referrer: { receivedAt: 5, chatType: 'group', chatId: 'oc_chat', messageId: 'om_parent' },
    }
    await bot.sendPayload(post, target, send())
    expect(calls[0]!.path).toBe('/open-apis/im/v1/messages')
    expect(bodyOf(calls[0])).toMatchObject({ receive_id: 'oc_chat' })
  })

  it('keeps the uuid of a retried reply', async () => {
    const { bot, calls } = await mount()
    const ctx = send(0, { idempotencyKey: 'op-2' }, 'om_parent')
    await bot.sendPayload(post, group, ctx)
    await bot.sendPayload(post, group, ctx)
    expect(bodyOf(calls[0]).uuid).toBe(bodyOf(calls[1]).uuid)
  })

  it('resolves an explicit thread id via listMessages and replies in thread instead of creating in the main chat', async () => {
    const { bot, calls } = await mount({
      '/open-apis/im/v1/messages': (call) => {
        if (call.method === 'GET') {
          return Response.json({
            code: 0,
            data: { items: [{ message_id: 'om_thread_root', chat_id: 'oc_chat', thread_id: 'omt_existing' }] },
          })
        }
        throw new Error('must not call POST /im/v1/messages for an explicit thread')
      },
      '/open-apis/im/v1/messages/om_thread_root/reply': () =>
        Response.json({ code: 0, data: { message_id: 'om_in_thread', root_id: 'om_thread_root', thread_id: 'omt_existing' } }),
    })

    // Even when an unrelated referrer from another thread or unthreaded message is present on the target,
    // `target.thread` resolves the requested thread rather than answering `om_other`.
    const target: Target = {
      ...group,
      thread: 'omt_existing',
      referrer: { receivedAt: 5, chatType: 'topic', chatId: 'oc_chat', messageId: 'om_other', threadId: 'omt_other' },
    }
    const firstPart = await bot.sendPayload(post, target, send(0))
    expect(firstPart.id).toBe('om_in_thread')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/open-apis/im/v1/messages' })
    expect(calls[0]!.search).toContain('container_id_type=thread')
    expect(calls[0]!.search).toContain('container_id=omt_existing')
    expect(calls[0]!.search).toContain('sort_type=ByCreateTimeAsc')
    expect(calls[0]!.search).toContain('page_size=1')
    expect(calls[1]!.path).toBe('/open-apis/im/v1/messages/om_thread_root/reply')
    expect(bodyOf(calls[1])).toMatchObject({ reply_in_thread: true })

    // Subsequent parts of the same multi-part send reuse part 0's thread root without repeating `listMessages`.
    await bot.sendPayload(post, target, { index: 1, options: {}, previous: [firstPart] })
    expect(calls).toHaveLength(3)
    expect(calls[2]!.path).toBe('/open-apis/im/v1/messages/om_thread_root/reply')
    expect(bodyOf(calls[2])).toMatchObject({ reply_in_thread: true })
  })

  it('verifies a root message id passed as target.thread and replies inside that thread', async () => {
    const { bot, calls } = await mount({
      '/open-apis/im/v1/messages/om_root': () =>
        Response.json({ code: 0, data: { items: [{ message_id: 'om_root', chat_id: 'oc_chat' }] } }),
      '/open-apis/im/v1/messages/om_root/reply': () =>
        Response.json({ code: 0, data: { message_id: 'om_child', root_id: 'om_root', thread_id: 'omt_root' } }),
    })

    const part = await bot.sendPayload(post, { ...group, thread: 'om_root' }, send())
    expect(part.id).toBe('om_child')
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /open-apis/im/v1/messages/om_root',
      'POST /open-apis/im/v1/messages/om_root/reply',
    ])
    expect(bodyOf(calls[1])).toMatchObject({ reply_in_thread: true })
  })

  it('refuses invalid, empty, non-chat, foreign-chat, or mismatched-quote thread targets with published: no', async () => {
    const { bot, calls } = await mount({
      '/open-apis/im/v1/messages': (call) => {
        if (call.method === 'GET' && call.search.includes('container_id=omt_empty')) {
          return Response.json({ code: 0, data: { items: [] } })
        }
        if (call.method === 'GET' && call.search.includes('container_id=omt_foreign')) {
          return Response.json({ code: 0, data: { items: [{ message_id: 'om_foreign', chat_id: 'oc_other' }] } })
        }
        throw new Error(`unexpected ${call.method} ${call.path}${call.search}`)
      },
      '/open-apis/im/v1/messages/om_wrong_thread': () =>
        Response.json({ code: 0, data: { items: [{ message_id: 'om_wrong_thread', chat_id: 'oc_chat', thread_id: 'omt_2' }] } }),
    })

    await expect(bot.sendPayload(post, { ...group, thread: '   ' }, send())).rejects.toMatchObject({
      kind: 'invalid',
      published: 'no',
    })
    await expect(bot.sendPayload(post, { chat: { id: 'ou_user', type: 'direct' }, thread: 'omt_1' }, send())).rejects.toMatchObject({
      kind: 'invalid',
      published: 'no',
    })
    await expect(bot.sendPayload(post, { ...group, thread: 'omt_empty' }, send())).rejects.toMatchObject({
      kind: 'invalid',
      published: 'no',
    })
    await expect(bot.sendPayload(post, { ...group, thread: 'omt_foreign' }, send())).rejects.toMatchObject({
      kind: 'invalid',
      published: 'no',
    })
    await expect(bot.sendPayload(post, { ...group, thread: 'omt_1' }, send(0, {}, 'om_wrong_thread'))).rejects.toMatchObject({
      kind: 'invalid',
      published: 'no',
    })
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('marks an HTTP 200 send answer missing data as published: unknown', async () => {
    const { bot } = await mount({
      '/open-apis/im/v1/messages': () => Response.json({ code: 0 }),
    })
    await expect(bot.sendPayload(post, group, send())).rejects.toMatchObject({
      published: 'unknown',
    })
  })

  it('verifies a quoted root message on the platform when its stored referrer has no thread info yet', async () => {
    const { bot, calls } = await mount({
      '/open-apis/im/v1/messages/om_root': () =>
        Response.json({ code: 0, data: { items: [{ message_id: 'om_root', chat_id: 'oc_chat', thread_id: 'omt_1' }] } }),
      '/open-apis/im/v1/messages/om_root/reply': () =>
        Response.json({ code: 0, data: { message_id: 'om_reply' } }),
    })
    const staleReferrer: LarkReferrer = {
      chatId: 'oc_chat',
      chatType: 'group',
      messageId: 'om_root',
      receivedAt: 1,
    }
    await bot.sendPayload(post, { ...group, thread: 'omt_1', referrer: staleReferrer }, send(0, {}, 'om_root'))
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /open-apis/im/v1/messages/om_root',
      'POST /open-apis/im/v1/messages/om_root/reply',
    ])
    expect(bodyOf(calls[1])).toMatchObject({ reply_in_thread: true })
  })
})

describe('sendPayload: failures', () => {
  it('refuses a payload that is not one request body', async () => {
    const { bot, calls } = await mount()
    await expect(bot.sendPayload('text', group, send())).rejects.toThrow(/request body/)
    await expect(bot.sendPayload({ content: {} }, group, send())).rejects.toThrow(/msg_type/)
    await expect(bot.sendPayload({ msg_type: 'post', content: 'x' }, group, send())).rejects.toThrow(/content object/)
    expect(calls).toHaveLength(0)
  })

  it('refuses an answer without a message id', async () => {
    const { bot } = await mount({
      '/open-apis/im/v1/messages': () => Response.json({ code: 0, data: {} }),
    })
    // The REST client already refuses an envelope without the key the caller cannot work without, so a part can
    // never be built from half an answer.
    const error = await sendMessagePayload(bot, post, group, send()).catch(error => error)
    expect(error).toBeInstanceOf(LarkApiError)
    expect(String(error.message)).toMatch(/without message id/)
  })
})

describe('editPayload', () => {
  it('edits a post with PUT', async () => {
    const { bot, calls } = await mount()
    await bot.editPayload(handle().parts[0]!, post, handle())
    const call = calls.find(entry => entry.path === '/open-apis/im/v1/messages/om_1')!
    expect(call.method).toBe('PUT')
    expect(bodyOf(call)).toEqual({ msg_type: 'post', content: JSON.stringify(post.content) })
  })

  it('edits a text message with PUT', async () => {
    const { bot, calls } = await mount()
    const text: LarkPayload = { msg_type: 'text', content: { text: 'hi' } }
    await editMessagePayload(bot, handle('text').parts[0]!, text, handle('text'))
    expect(calls[0]!.method).toBe('PUT')
    expect(bodyOf(calls[0])).toEqual({ msg_type: 'text', content: JSON.stringify({ text: 'hi' }) })
  })

  it('edits an inline card with PATCH', async () => {
    const { bot, calls } = await mount()
    const value = handle('card-inline')
    await editMessagePayload(bot, value.parts[0]!, { msg_type: 'interactive', content: card }, value)
    const call = calls.find(entry => entry.path === '/open-apis/im/v1/messages/om_1')!
    expect(call.method).toBe('PATCH')
    // The patch route carries the card JSON only, never a `msg_type`.
    expect(bodyOf(call)).toEqual({ content: JSON.stringify(card) })
  })

  it('refuses to edit a media message (text, post and card only)', async () => {
    const { bot, calls } = await mount()
    const error = await editMessagePayload(bot, handle('file').parts[0]!, { msg_type: 'file', content: { file_key: 'k' } }, handle('file'))
      .catch(error => error)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('invalid')
    expect(calls).toHaveLength(0)
  })
})

describe('deletePart', () => {
  it('recalls the platform message', async () => {
    const { bot, calls } = await mount()
    await bot.deletePart(handle().parts[0]!, handle())
    const call = calls.find(entry => entry.path === '/open-apis/im/v1/messages/om_1')!
    expect(call.method).toBe('DELETE')
    expect(call.body).toBeUndefined()
  })

  it('surfaces a platform failure so the core can report it', async () => {
    const { bot } = await mount({
      '/open-apis/im/v1/messages/om_1': () => Response.json({ code: 230002, msg: 'no recall' }, { status: 400 }),
    })
    await expect(deleteSentPart(bot, handle().parts[0]!, handle())).rejects.toThrow(/answered 400/)
  })
})

describe('partKindOf', () => {
  it('names the kind of every payload a mode produces', () => {
    expect(partKindOf(post)).toBe('post')
    expect(partKindOf({ msg_type: 'text', content: { text: 'x' } })).toBe('text')
    expect(partKindOf({ msg_type: 'interactive', content: card })).toBe('card-inline')
    expect(partKindOf({ msg_type: 'file', content: { file_key: 'k' } })).toBe('file')
    expect(partKindOf({ msg_type: 'audio', content: { file_key: 'k' } })).toBe('audio')
    expect(partKindOf({ msg_type: 'media', content: { file_key: 'k' } })).toBe('media')
    expect(partKindOf({ msg_type: 'image', content: { image_key: 'k' } })).toBe('image')
  })
})

describe('SentPart thread and referrer', () => {
  it('records thread_id, root_id, and an updated LarkReferrer from replyMessage when a new thread is created', async () => {
    const { bot } = await mount({
      '/open-apis/im/v1/messages/om_root/reply': () => Response.json({
        code: 0,
        data: { message_id: 'om_reply_1', thread_id: 'omt_new_1', root_id: 'om_root' },
      }),
    })
    const part = await sendMessagePayload(
      bot,
      { msg_type: 'text', content: { text: 'hello' } },
      { chat: { id: 'oc_1', type: 'group' }, thread: true },
      { index: 0, quote: 'om_root', options: {}, previous: [] },
    )
    expect(part.thread).toEqual({ id: 'omt_new_1', root: 'om_root' })
    expect(part.referrer).toMatchObject({
      chatType: 'group',
      chatId: 'oc_1',
      messageId: 'om_reply_1',
      threadId: 'omt_new_1',
      rootId: 'om_root',
    })
  })
})
