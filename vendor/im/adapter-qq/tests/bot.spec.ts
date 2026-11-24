/**
 * The adapter shell: identity, mode selection, resource scope, error classification and the REST-only transport.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import { Satori, Status, type Target } from '@deepseek-ai/cordis-plugin-im-core'
import QQBot, { Config, QqApiError, resolveBaseUrl, WsClient, type QQConfig } from '@deepseek-ai/cordis-plugin-im-adapter-qq'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount the adapter on a fresh context; no request leaves the process. */
async function mount(input: Record<string, unknown> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  // The HTTP plugin has no business in these tests: any real request fails the test.
  ctx.on('http/fetch', () => {
    throw new Error('unexpected network request')
  })
  const config: QQConfig = Config({ appId: '102106848', secret: 'secret', ...input } as QQConfig)
  await ctx.plugin(QQBot, config)
  const bot = ctx.bots[0] as QQBot
  return { ctx, bot, config }
}

const group: Target = { chat: { id: 'group:FBB1D91204242AAB8B61A0179A6245B0', type: 'group' } }
const direct: Target = { chat: { id: 'user:DD8246C68EC19CAF8D2AA76941180EA4', type: 'direct' } }

describe('QQBot shell', () => {
  it('is identified as qq:<appId> on platform qq', async () => {
    const { bot } = await mount()
    expect(bot.id).toBe('qq:102106848')
    expect(bot.platform).toBe('qq')
    expect(bot.adapterName).toBe('qq')
  })

  it('becomes usable without a gateway when transport is none', async () => {
    const { bot } = await mount({ transport: 'none' })
    expect(bot.status).toBe(Status.ONLINE)
    expect(bot.isRestOnly).toBe(true)
    await bot.disconnect()
  })

  it('installs the WebSocket gateway when the transport is ws', async () => {
    const { bot } = await mount()
    expect(bot.isRestOnly).toBe(false)
    expect(bot.adapter).toBeInstanceOf(WsClient)
    // The token request is the first thing the client needs, and this test refuses all network access: the retry
    // policy reports RECONNECT instead of silently running without a transport.
    await vi.waitFor(() => { expect(bot.status).toBe(Status.RECONNECT) })
    expect((bot.error as Error).message).toMatch(/access token/)
    await bot.disconnect()
  })

  it('declares the markdown mode only when the configuration enables it, and only then keyboards', async () => {
    const { bot } = await mount()
    // Core picks the mode per message; `text` comes first, so a reply that needs no markdown stays plain text.
    expect(bot.modeOrder).toEqual(['text'])
    expect(bot.keyboardEnabled).toBe(false)

    const markdown = await mount({ markdown: true, keyboard: true })
    expect(markdown.bot.modeOrder).toEqual(['text', 'markdown'])
    expect(markdown.bot.keyboardEnabled).toBe(true)

    const keyboardsWithoutMarkdown = await mount({ keyboard: true })
    expect(keyboardsWithoutMarkdown.bot.keyboardEnabled).toBe(false)
  })

  it('uses the self-describing chat id as the resource scope', async () => {
    const { bot } = await mount({ transport: 'none' })
    expect(bot.resourceScope(group, 'image')).toBe('group:FBB1D91204242AAB8B61A0179A6245B0')
    expect(bot.resourceScope(direct, 'file')).toBe('user:DD8246C68EC19CAF8D2AA76941180EA4')
    expect(bot.address(group)).toEqual({ kind: 'group', id: 'FBB1D91204242AAB8B61A0179A6245B0' })
    expect(() => bot.address({ chat: { id: 'oc_chat', type: 'group' } })).toThrow(/group:<group_openid>/)
  })

  it('classifies platform failures through the error table', async () => {
    const { bot } = await mount({ transport: 'none' })
    const error = bot.classify(new QqApiError('nope', { code: 40054010, status: 400 }))
    expect(error.kind).toBe('invalid')
    expect(error.code).toBe(40054010)
    expect(error.published).toBe('no')
  })

  it('points the REST client at the configured host', async () => {
    const sandbox = await mount({ transport: 'none', sandbox: true })
    expect(sandbox.bot.api.baseUrl).toBe(resolveBaseUrl(sandbox.config))
    expect(sandbox.bot.api.baseUrl).toBe('https://sandbox.api.sgroup.qq.com/')
    const plain = await mount({ transport: 'none' })
    expect(plain.bot.api.baseUrl).toBe('https://api.sgroup.qq.com/')
  })

  it('rewrites the gateway host only when it differs from the configured one', async () => {
    const sandbox = await mount({ transport: 'none', sandbox: true })
    // The sandbox endpoint answers with its own host; prefixing it again produced sandbox.sandbox.api.sgroup.qq.com.
    vi.spyOn(sandbox.bot.api, 'getGateway').mockResolvedValue({ url: 'wss://sandbox.api.sgroup.qq.com/websocket' })
    expect(await sandbox.bot.gatewayUrl()).toBe('wss://sandbox.api.sgroup.qq.com/websocket')
    vi.spyOn(sandbox.bot.api, 'getGateway').mockResolvedValue({ url: 'wss://api.sgroup.qq.com/websocket' })
    expect(await sandbox.bot.gatewayUrl()).toBe('wss://sandbox.api.sgroup.qq.com/websocket')

    const plain = await mount({ transport: 'none' })
    vi.spyOn(plain.bot.api, 'getGateway').mockResolvedValue({ url: 'wss://api.sgroup.qq.com/websocket' })
    expect(await plain.bot.gatewayUrl()).toBe('wss://api.sgroup.qq.com/websocket')
  })

  it('exposes both modes, the decoder and the stream driver', async () => {
    const { bot } = await mount({ transport: 'none' })
    // Both modes are built on first use.
    expect(Object.keys(bot.modes)).toEqual(['text', 'markdown'])
    // The decoder answers with no session for a frame it cannot use, and never throws.
    expect(await bot.decodeDispatch({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {} })).toEqual([])
    // Only a C2C chat with `stream` has a driver; a group buffers and sends once.
    expect(bot.streamDriver('text', group)).toBeUndefined()
    expect(bot.streamDriver('text', direct)).toBeUndefined()
    const streaming = await mount({ transport: 'none', stream: true })
    expect(streaming.bot.streamDriver('text', direct)?.strategy).toBe('append')
    expect(streaming.bot.streamDriver('text', group)).toBeUndefined()
  })
})
