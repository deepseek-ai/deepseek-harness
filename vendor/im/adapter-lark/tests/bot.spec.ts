/**
 * The adapter shell: identity, the mode table and its preference order, the OpenAPI client routes, the
 * resource internal route, reactions, reads and the mode-shaped hooks that delegate to `modes/`, `prepare.ts`,
 * `send.ts`, `stream.ts` and `decode.ts`.
 *
 * Every request goes through the `http/fetch` hook and every socket through `http/websocket`, so no test touches the
 * network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import {
  PlatformError,
  Satori,
  Status,
  createResourceFetcher,
  normalize,
  ResourceTimeoutError,
  ResourceTooLargeError,
  type InboundMessage,
  type Target,
} from '@deepseek-ai/cordis-plugin-im-core'
import { h } from '@deepseek-ai/satori-element'
import LarkBot, {
  AccessToken,
  Config,
  DEFAULT_BASE_URLS,
  LarkApiError,
  readLarkReferrer,
  resolveBaseUrl,
  WsClient,
  type LarkConfig,
} from '@deepseek-ai/cordis-plugin-im-adapter-lark'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

/** One request the adapter made. */
interface Call {
  path: string
  method: string
  search: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
}

/** What the platform answers for one path. */
type Route = (call: Call) => Response | Promise<Response>

/** Stand-in socket, so a mounted bot can complete its long-connection handshake. */
class Socket extends EventTarget {
  readyState = 1
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer'
  private opened = false
  close() {}
  send() {}

  /** The transport opens as soon as the adapter listens for it, i.e. after it took ownership of the socket. */
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, listener, options)
    if (type === 'open' && !this.opened) {
      this.opened = true
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
  }
}

/** Routes every mounted bot needs (gateway, token, identity) plus the test's own. */
function platform(overrides: Record<string, Route> = {}) {
  const calls: Call[] = []
  const handler = (call: Call): Response | Promise<Response> => {
    const override = overrides[call.path]
    if (override) return override(call)
    if (call.path === '/callback/ws/endpoint') {
      return Response.json({ code: 0, data: { URL: 'wss://open.feishu.cn/cb/ws?service_id=7', ClientConfig: { PingInterval: 120 } } })
    }
    if (call.path === '/open-apis/auth/v3/tenant_access_token/internal') {
      return Response.json({ code: 0, tenant_access_token: 't-token', expire: 7200 })
    }
    if (call.path === '/open-apis/bot/v3/info') {
      return Response.json({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Lark Bot', avatar_url: 'https://a/1.png' } })
    }
    throw new Error(`Unexpected request: ${call.method} ${call.path}`)
  }
  return { calls, handler }
}

/** Mount the adapter on a fresh context; `appId` is the bot id suffix and the resource scope. */
async function mount(input: Record<string, unknown> = {}, overrides: Record<string, Route> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  const routes = platform(overrides)
  // The plugin's hook types speak undici's `WebSocket`; this fake only has to stay open.
  ctx.on('http/websocket', (() => new Socket()) as never)
  ctx.on('http/fetch', async (url: URL, init: any) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => { headers[key] = value })
    const call: Call = {
      path: url.pathname,
      method: init.method ?? 'GET',
      search: url.search,
      headers,
      body: init.body,
      signal: init.signal,
    }
    routes.calls.push(call)
    return await routes.handler(call)
  })
  const config: LarkConfig = Config({ appId: 'cli_lark', appSecret: 'secret', ...input } as LarkConfig)
  await ctx.plugin(LarkBot, config)
  const bot = ctx.bots[0] as LarkBot
  return { ctx, bot, config, calls: routes.calls }
}

const group: Target = { chat: { id: 'oc_chat', type: 'group' } }

/** The decoded shape a mocked `decodeMessage` returns. */
function inbound(id: string, chatId = 'oc_chat'): InboundMessage {
  return {
    id,
    chat: { id: chatId, type: 'group' },
    sender: { id: 'ou_user' },
    content: normalize(h('p', 'hi')),
    mentions: { self: false, all: false, users: [] },
    time: 1_700_000_000_000,
    referrer: {},
  }
}

describe('LarkBot shell', () => {
  it('is identified as lark:<appId>, reporting the configured platform', async () => {
    const feishu = await mount()
    expect(feishu.bot.id).toBe('lark:cli_lark')
    expect(feishu.bot.platform).toBe('feishu')
    expect(feishu.bot.adapterName).toBe('lark')
    const lark = await mount({ platform: 'lark' })
    expect(lark.bot.id).toBe('lark:cli_lark')
    expect(lark.bot.platform).toBe('lark')
    expect(lark.bot.adapterName).toBe('lark')
  })

  it('learns its own identity from the handshake', async () => {
    const { bot, calls } = await mount()
    await vi.waitFor(() => { expect(bot.status).toBe(Status.ONLINE) })
    expect(bot.selfId).toBe('ou_bot')
    expect(bot.user).toEqual({ id: 'ou_bot', name: 'Lark Bot', avatar: 'https://a/1.png', isBot: true })
    expect(bot.sid).toBe('feishu:ou_bot')
    expect(calls.map(call => call.path)).toContain('/open-apis/auth/v3/tenant_access_token/internal')
    expect(calls.map(call => call.path)).toContain('/open-apis/bot/v3/info')
    await bot.disconnect()
  })

  it('builds both mode tables and declares the card-first order', async () => {
    const { bot } = await mount()
    // Core resolves the mode per message; the adapter only says which modes exist and in what order it prefers them.
    expect(bot.modeOrder).toEqual(['card', 'post'])
    expect(bot.modes.post.id).toBe('post')
    expect(bot.modes.card.id).toBe('card')
    // A stream opens in the card mode, which edits the one card message in place.
    expect(bot.streamDriver('card')?.strategy).toBe('edit')
  })

  it('publishes each message in the mode that keeps the most of it, weighted per element', async () => {
    const { bot } = await mount()
    // `<u>` degrades in the card mode and renders natively in post, so the weighted score picks post.
    expect((await bot.render(group, h('p', 'a ', h('u', 'underlined')))).mode).toBe('post')
    // Bold and a link are native in both, so the tie keeps the adapter's order (card).
    expect((await bot.render(group, h('p', 'a ', h('b', 'bold'), ' ', h('a', { href: 'https://x.test/1' }, 'link')))).mode)
      .toBe('card')
    // `<span>` and `<small>` cost the post mode two plain elements; the card keeps both.
    expect((await bot.render(group, [h('p', h('span', { color: 'info' }, 'blue')), h('small', 'note')])).mode).toBe('card')
  })

  it('reads a chat\'s members by open id and skips a member it cannot address', async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/chats/oc_probe/members': () => Response.json({
        code: 0,
        data: {
          items: [{ member_id: 'ou_a', name: '张三', member_id_type: 'open_id' }, { name: 'no id' }],
          has_more: true,
          page_token: 'p2',
        },
      }),
    })
    const page = await bot.members({ id: 'oc_probe', type: 'group' })
    // The id a mention addresses is the `open_id`, and a member reported without one addresses nobody.
    expect(page.data).toEqual([{ id: 'ou_a', name: '张三' }])
    expect(page.next).toBe('p2')
    expect(calls.filter(call => call.path.endsWith('/members'))).toHaveLength(1)
  })

  it('scopes uploads to the application, not the chat', async () => {
    const { bot } = await mount()
    expect(bot.resourceScope(group, 'image')).toBe('cli_lark')
    expect(bot.resourceScope({ chat: { id: 'ou_user', type: 'direct' } }, 'file')).toBe('cli_lark')
  })

  it('classifies platform failures through errors.ts', async () => {
    const { bot } = await mount()
    const muted = bot.classify(new LarkApiError('muted', { code: 230035, status: 400 }))
    expect(muted.kind).toBe('permission')
    expect(muted.published).toBe('no')
  })

  it('points the client at the host of the configured platform', async () => {
    const feishu = await mount()
    expect(feishu.bot.api.baseUrl).toBe(DEFAULT_BASE_URLS.feishu)
    expect(resolveBaseUrl({ platform: 'lark' })).toBe(DEFAULT_BASE_URLS.lark)
    const lark = await mount({ platform: 'lark' })
    expect(lark.bot.api.baseUrl).toBe('https://open.larksuite.com/open-apis/')
    const custom = await mount({ baseUrl: 'https://proxy.example.com/open-apis' })
    expect(custom.bot.api.resolve('im/v1/messages')).toBe('https://proxy.example.com/open-apis/im/v1/messages')
  })

  it('applies the defaults of the configuration schema', async () => {
    const { bot } = await mount()
    expect(bot.config).toMatchObject({
      platform: 'feishu',
      cardStreaming: true,
      callbacks: true,
      callbackAnswerMs: 1_500,
    })
    expect(bot.config.allowAtAll).toBeUndefined()
    expect(bot.config.ws).toMatchObject({
      maxFrameBytes: 1024 * 1024,
      maxFrameParts: 128,
      maxPendingFrames: 64,
      maxPendingEvents: 64,
      frameTimeoutMs: 30_000,
      retryTimes: 6,
    })
    expect(bot.config.appSecret).toBe('secret')
  })

  it('exposes the internal URL of a message resource', async () => {
    const { bot } = await mount()
    await vi.waitFor(() => { expect(bot.selfId).toBe('ou_bot') })
    expect(bot.getResourceUrl('om_1', 'img_v2_abc')).toBe('satori:feishu/ou_bot/messages/om_1/resources/img_v2_abc?type=image')
    expect(bot.getResourceUrl('om_1', 'file_v2_abc', 'file')).toBe('satori:feishu/ou_bot/messages/om_1/resources/file_v2_abc?type=file')
  })

  it('narrows a referrer', async () => {
    const { bot } = await mount()
    const referrer = { event_id: 'ev_1', receivedAt: 5, chatType: 'group', chatId: 'oc_chat', messageId: 'om_1', threadId: 'omt_1' }
    expect(bot.referrerOf({ chat: { id: 'oc_chat', type: 'group' }, referrer })).toEqual(referrer)
    expect(readLarkReferrer({ chatType: 'group' })).toBeUndefined()
    expect(bot.referrerOf(group)).toBeUndefined()
  })

  // The hooks delegate to their module: modes (`modes/`), prepare/send (`prepare.ts`, `send.ts`), the stream drivers
  // (the core `edit` driver) and the decoder (`decode.ts`); each is covered by its own spec.
  it('wires the stream driver per mode', async () => {
    const { bot } = await mount()
    expect(bot.streamDriver('card')?.strategy).toBe('edit')
    expect(bot.streamDriver('post')?.strategy).toBe('edit')
    expect(bot.streamDriver('text')).toBeUndefined()
    const plain = await mount({ cardStreaming: false })
    expect(plain.bot.streamDriver('card')).toBeUndefined()
  })
})

describe('LarkBot reads', () => {
  it('reads one message after checking it belongs to the authorized chat', async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/messages/om_1': () => Response.json({
        code: 0,
        data: { items: [{ message_id: 'om_1', chat_id: 'oc_chat', msg_type: 'text' }] },
      }),
    })
    vi.spyOn(bot, 'decodeMessage').mockImplementation(async raw => inbound(String(raw.message_id)))
    await expect(bot.getMessage(group.chat, 'om_1')).resolves.toMatchObject({ id: 'om_1' })
    const call = calls.find(entry => entry.path.endsWith('/im/v1/messages/om_1'))!
    // A card must read as the JSON it was sent with.
    expect(call.search).toContain('card_msg_content_type=user_card_content')
    expect(call.headers.authorization).toBe('Bearer t-token')
    expect(bot.decodeMessage).toHaveBeenCalledWith(expect.objectContaining({ message_id: 'om_1' }), group.chat,
      // The items the answer carried travel with the container: they are a merged forward's contents.
      [expect.objectContaining({ message_id: 'om_1' })])
  })

  it('refuses a message that is absent or belongs to another chat', async () => {
    const foreign = await mount({}, {
      '/open-apis/im/v1/messages/om_2': () => Response.json({ code: 0, data: { items: [{ message_id: 'om_2', chat_id: 'oc_other' }] } }),
      '/open-apis/im/v1/messages/om_3': () => Response.json({ code: 0, data: { items: [] } }),
    })
    const decode = vi.spyOn(foreign.bot, 'decodeMessage')
    await expect(foreign.bot.getMessage(group.chat, 'om_2')).rejects.toThrow(/belongs to another chat/)
    await expect(foreign.bot.getMessage(group.chat, 'om_3')).rejects.toThrow(/absent/)
    expect(decode).not.toHaveBeenCalled()
  })

  it('lists a page of messages oldest first and passes the cursor on', async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/messages': () => Response.json({
        code: 0,
        data: {
          items: [{ message_id: 'om_1', chat_id: 'oc_chat' }, { message_id: 'om_2', chat_id: 'oc_chat' }],
          has_more: true,
          page_token: 'next-1',
        },
      }),
    })
    vi.spyOn(bot, 'decodeMessage').mockImplementation(async raw => inbound(String(raw.message_id)))
    const page = await bot.getMessageList(group.chat, 'cursor-0', 2)
    expect(page.data.map(message => message.id)).toEqual(['om_1', 'om_2'])
    expect(page.next).toBe('next-1')
    const call = calls.find(entry => entry.path.endsWith('/im/v1/messages'))!
    expect(call.search).toContain('container_id_type=chat')
    expect(call.search).toContain('container_id=oc_chat')
    expect(call.search).toContain('page_size=2')
    expect(call.search).toContain('page_token=cursor-0')
    expect(call.search).toContain('sort_type=ByCreateTimeAsc')
  })

  it('omits the cursor when the page is the last one', async () => {
    const { bot } = await mount({}, {
      '/open-apis/im/v1/messages': () => Response.json({ code: 0, data: { items: [], has_more: false } }),
    })
    vi.spyOn(bot, 'decodeMessage').mockResolvedValue(inbound('om_1'))
    expect(await bot.getMessageList(group.chat)).toEqual({ data: [] })
  })

  it('returns the bytes of one message resource through the internal route', async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/messages/om_1/resources/img_v2_abc': () => new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
      }),
    })
    await vi.waitFor(() => { expect(bot.selfId).toBe('ou_bot') })
    const response = await bot.ctx.http(bot.getResourceUrl('om_1', 'img_v2_abc'))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(response.headers.get('content-type')).toBe('image/png')
    const call = calls.find(entry => entry.path.endsWith('/resources/img_v2_abc'))!
    expect(call.search).toBe('?type=image')
    expect(call.headers.authorization).toBe('Bearer t-token')
  })

  it('surfaces a platform failure of the resource route', async () => {
    const { bot } = await mount({}, {
      '/open-apis/im/v1/messages/om_1/resources/file_v2_abc': () => Response.json({ code: 234003, msg: 'resource gone' }, { status: 404 }),
    })
    await vi.waitFor(() => { expect(bot.selfId).toBe('ou_bot') })
    await expect(bot.ctx.http(bot.getResourceUrl('om_1', 'file_v2_abc', 'file'))).rejects.toThrow()
  })

  it('streams internal resource and image routes so maxBytes aborts before buffering the body', async () => {
    let headerPulled = 0
    let headerCancelled = false
    let chunkPulled = 0
    let cancelled = false
    const { bot } = await mount({}, {
      '/open-apis/im/v1/messages/om_1/resources/file_big': () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          headerPulled += 1
          controller.enqueue(new Uint8Array(8))
        },
        cancel() {
          headerCancelled = true
        },
      }, { highWaterMark: 0 }), {
        headers: { 'content-type': 'application/octet-stream', 'content-length': '100' },
      }),
      '/open-apis/im/v1/images/img_stream': () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          chunkPulled += 1
          controller.enqueue(new Uint8Array([1, 2, 3]))
        },
        cancel() {
          cancelled = true
        },
      }, { highWaterMark: 0 }), {
        headers: { 'content-type': 'image/png' },
      }),
    })
    await vi.waitFor(() => { expect(bot.selfId).toBe('ou_bot') })
    const fetchResource = createResourceFetcher(bot.ctx, { maxBytes: 4 })

    await expect(fetchResource(bot.getResourceUrl('om_1', 'file_big', 'file'), new AbortController().signal))
      .rejects.toBeInstanceOf(ResourceTooLargeError)
    expect(headerPulled).toBe(0)
    expect(headerCancelled).toBe(true)

    await expect(fetchResource('satori:feishu/ou_bot/images/img_stream', new AbortController().signal))
      .rejects.toBeInstanceOf(ResourceTooLargeError)
    expect(chunkPulled).toBe(2)
    expect(cancelled).toBe(true)
  })

  it('aborts an internal resource fetch whose upstream response stalls before headers arrive', async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/messages/om_1/resources/file_slow': call =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true })
        }),
    })
    await vi.waitFor(() => { expect(bot.selfId).toBe('ou_bot') })
    const fetchResource = createResourceFetcher(bot.ctx, { timeout: 25 })
    await expect(fetchResource(bot.getResourceUrl('om_1', 'file_slow', 'file'), new AbortController().signal))
      .rejects.toBeInstanceOf(ResourceTimeoutError)
    const upstream = calls.find(entry => entry.path.endsWith('/resources/file_slow'))
    expect(upstream?.signal?.aborted).toBe(true)
  })

  it('probes the chat kind once and caches it', async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/chats/oc_chat': () => Response.json({ code: 0, data: { chat_mode: 'topic' } }),
      '/open-apis/im/v1/chats/oc_p2p': () => Response.json({ code: 0, data: { chat_mode: 'p2p' } }),
    })
    expect(await bot.chatTypeOf('oc_chat')).toBe('topic')
    expect(await bot.chatTypeOf('oc_chat')).toBe('topic')
    expect(calls.filter(call => call.path.endsWith('/chats/oc_chat'))).toHaveLength(1)
    expect(await bot.chatTypeOf('oc_p2p')).toBe('direct')
    bot.forgetChat('oc_chat')
    expect(await bot.chatTypeOf('oc_chat')).toBe('topic')
    expect(calls.filter(call => call.path.endsWith('/chats/oc_chat'))).toHaveLength(2)
  })

  it('assumes a group when the chat cannot be read', async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/chats/oc_broken': () => Response.json({ code: 230001, msg: 'bad' }, { status: 400 }),
    })
    expect(await bot.chatTypeOf('oc_broken')).toBe('group')
    // A failed probe is not cached, so the next caller asks again.
    expect(await bot.chatTypeOf('oc_broken')).toBe('group')
    expect(calls.filter(call => call.path.endsWith('/chats/oc_broken'))).toHaveLength(2)
  })
})

describe('LarkBot reactions', () => {
  const message = { id: 'om_1', chat: { id: 'oc_chat', type: 'group' as const } }

  it('adds one catalogue emoji', async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/messages/om_1/reactions': () => Response.json({ code: 0, data: { reaction_id: 'r_1' } }),
    })
    await bot.createReaction(message, 'SMILE')
    const call = calls.find(entry => entry.path.endsWith('/reactions') && entry.method === 'POST')!
    expect(call.method).toBe('POST')
    expect(JSON.parse(String(call.body))).toEqual({ reaction_type: { emoji_type: 'SMILE' } })
  })

  it("withdraws only this application's reaction", async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/messages/om_1/reactions': () => Response.json({
        code: 0,
        data: {
          items: [
            { reaction_id: 'r_user', operator: { operator_type: 'user', operator_id: 'ou_user' }, reaction_type: { emoji_type: 'SMILE' } },
            { reaction_id: 'r_app', operator: { operator_type: 'app', operator_id: 'cli_lark' }, reaction_type: { emoji_type: 'SMILE' } },
          ],
        },
      }),
      '/open-apis/im/v1/messages/om_1/reactions/r_app': () => Response.json({ code: 0, data: {} }),
    })
    await bot.deleteReaction(message, 'SMILE')
    const deletes = calls.filter(call => call.method === 'DELETE')
    expect(deletes.map(call => call.path)).toEqual(['/open-apis/im/v1/messages/om_1/reactions/r_app'])
    // The read filtered by emoji and page size.
    const list = calls.find(call => call.method === 'GET')!
    expect(list.search).toContain('reaction_type=SMILE')
  })

  it('does nothing when the bot carries no such reaction', async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/messages/om_1/reactions': () => Response.json({ code: 0, data: { items: [] } }),
    })
    await bot.deleteReaction(message, 'SMILE')
    expect(calls.some(call => call.method === 'DELETE')).toBe(false)
  })
})

describe('LarkBot client surface', () => {
  it('token is fetched once and cached', async () => {
    const { bot, calls } = await mount()
    await vi.waitFor(() => { expect(bot.tokens.token).toBe('t-token') })
    expect(bot.tokens.expiresAt).toBeGreaterThan(Date.now())
    await bot.api.getBotInfo()
    await bot.api.getBotInfo()
    // A refresh window of 30 minutes keeps one token for 7200 s; nothing is re-fetched inside it.
    expect(calls.filter(call => call.path.endsWith('/tenant_access_token/internal'))).toHaveLength(1)
    bot.invalidateToken()
    await bot.api.getBotInfo()
    expect(calls.filter(call => call.path.endsWith('/tenant_access_token/internal'))).toHaveLength(2)
  })

  it('exposes the generated route tree for `/_api/:name`', async () => {
    const { bot } = await mount({}, {
      '/open-apis/im/v1/messages/om_1': () => Response.json({
        code: 0,
        data: { items: [{ message_id: 'om_1', chat_id: 'oc_chat' }] },
      }),
    })
    // Generated routes are registered by importing the package (`types/index.ts` side effects).
    const answer = await bot.internal.im.message.get('om_1')
    expect(answer).toEqual({ items: [{ message_id: 'om_1', chat_id: 'oc_chat' }] })
  })

  it('reports an envelope failure of the generated routes as LarkApiError', async () => {
    const { bot } = await mount({}, {
      '/open-apis/im/v1/messages/om_2': () => Response.json({ code: 230001, msg: 'bad' }, { status: 400 }),
    })
    await expect(bot.internal.im.message.get('om_2')).rejects.toBeInstanceOf(LarkApiError)
    expect(bot.classify(new LarkApiError('x', { code: 230001, status: 400 })).kind).toBe('invalid')
  })

  it('installs the long connection as `bot.adapter`', async () => {
    const { bot } = await mount()
    expect(bot.adapter).toBeInstanceOf(WsClient)
    await bot.disconnect()
  })

  it('rejects a token caller aborted mid-refresh with published: no without breaking concurrent callers', async () => {
    let releaseToken!: (result: { code: number; tenant_access_token: string; expire: number }) => void
    const tokenGate = new Promise<{ code: number; tenant_access_token: string; expire: number }>((resolve) => {
      releaseToken = resolve
    })
    const post = vi.fn(() => tokenGate)
    const tokens = new AccessToken({
      appId: 'cli_lark',
      appSecret: 'secret',
      baseUrl: 'https://open.feishu.cn/open-apis/',
      post,
    })

    const callerA = new AbortController()
    const callerB = new AbortController()
    const pendingA = tokens.get(callerA.signal)
    const pendingB = tokens.get(callerB.signal)
    expect(post).toHaveBeenCalledOnce()

    callerA.abort()
    const errorA = await pendingA.catch(err => err)
    expect(errorA).toBeInstanceOf(PlatformError)
    expect(errorA).toMatchObject({ kind: 'fatal', published: 'no' })

    releaseToken({ code: 0, tenant_access_token: 'shared-token', expire: 7200 })
    await expect(pendingB).resolves.toBe('shared-token')
    expect(post).toHaveBeenCalledOnce()
  })

  it('marks token refresh transport and missing-token failures as published: no', async () => {
    const net = new AccessToken({
      appId: 'cli_lark',
      appSecret: 'secret',
      baseUrl: 'https://open.feishu.cn/open-apis/',
      post: () => Promise.reject(new Error('ECONNRESET')),
    })
    await expect(net.get()).rejects.toMatchObject({ kind: 'retryable', published: 'no' })

    const empty = new AccessToken({
      appId: 'cli_lark',
      appSecret: 'secret',
      baseUrl: 'https://open.feishu.cn/open-apis/',
      post: () => Promise.resolve({ code: 0, tenant_access_token: '', expire: 0 }),
    })
    await expect(empty.get()).rejects.toMatchObject({ kind: 'retryable', published: 'no' })

    const rateLimitedHttp = new AccessToken({
      appId: 'cli_lark',
      appSecret: 'secret',
      baseUrl: 'https://open.feishu.cn/open-apis/',
      post: () => Promise.reject(Object.assign(new Error('Too Many Requests'), {
        response: new Response(null, { status: 429, headers: { 'retry-after': '3' } }),
      })),
    })
    await expect(rateLimitedHttp.get()).rejects.toMatchObject({
      kind: 'rate-limit',
      published: 'no',
      retryAfterMs: 3000,
    })

    const apiError = new LarkApiError('rate limited', {
      code: 99991400,
      status: 429,
      retryAfterMs: 5000,
      body: { code: 99991400 },
    })
    const rateLimitedApi = new AccessToken({
      appId: 'cli_lark',
      appSecret: 'secret',
      baseUrl: 'https://open.feishu.cn/open-apis/',
      post: () => Promise.reject(apiError),
    })
    await expect(rateLimitedApi.get()).rejects.toMatchObject({
      code: 99991400,
      status: 429,
      retryAfterMs: 5000,
      body: { code: 99991400 },
      published: 'no',
    })
  })
})
