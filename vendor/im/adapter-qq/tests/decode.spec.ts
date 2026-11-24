/**
 * Inbound decoding of the QQ official bot : every fixture is a real dispatch frame built from
 * the QQ open-platform event reference (`GROUP_AT_MESSAGE_CREATE`, `C2C_MESSAGE_CREATE`, `INTERACTION_CREATE`,
 * `GROUP_ADD_ROBOT`), so the suite pins the vocabulary, the passive-reply referrer and the acknowledgement contract
 * without touching the network.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import { Satori, type Session } from '@deepseek-ai/cordis-plugin-im-core'
import { toText, type Element, type Tag } from '@deepseek-ai/satori-element'
import QQBot, { Config, type GatewayDispatch, type QQConfig } from '@deepseek-ai/cordis-plugin-im-adapter-qq'
import {
  decodeTimestamp,
  parseSceneExt,
  passiveKey,
  readQQReferrer,
  type QQReferrer,
} from '@deepseek-ai/cordis-plugin-im-adapter-qq/src/decode.ts'

/** The bot's own openid; the gateway's `READY` frame normally sets it. */
const SELF_ID = '3404886050704567073'
/** The bot's cross-application openid: the id a `GROUP_MESSAGE_CREATE` body uses for a mention of the bot. */
const SELF_UNION = '9210BCC6199FD6F694EF11F55C88DF78'
const GROUP_ID = 'group:B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5'
const GROUP_MEMBER = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4'
const C2C_USER = 'user:DD8246C68EC19CAF8D2AA76941180EA4'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One dispatch frame from `tests/fixtures`, exactly as the gateway delivers it. */
function load(name: string): GatewayDispatch {
  const file = new URL(`./fixtures/${name}.json`, import.meta.url)
  return JSON.parse(readFileSync(file, 'utf8')) as GatewayDispatch
}

/**
 * One `GROUP_MESSAGE_CREATE` frame: the full-mode event a bot with 接收所有消息 switched on receives for every group
 * message. Unlike `GROUP_AT_MESSAGE_CREATE` the body keeps the `<@…>` mention in place.
 * @param content - message body as the platform sent it.
 * @param id - message id; the passive reply is addressed by it.
 * @returns the dispatch frame.
 */
function fullModeFrame(content: string, id = 'ROBOT1.0_full'): GatewayDispatch {
  return {
    op: 0,
    s: 2,
    t: 'GROUP_MESSAGE_CREATE',
    id: 'GROUP_MESSAGE_CREATE_EVENT',
    d: {
      id,
      content,
      group_openid: 'B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5',
      author: { member_openid: GROUP_MEMBER, username: '小明', member_role: 'member' },
      timestamp: '2026-07-21T10:00:00+08:00',
    },
  }
}

/** Mount the adapter REST-only (no gateway, no request leaves the process) with the acknowledgement stubbed out. */
async function mount(input: Record<string, unknown> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  ctx.on('http/fetch', () => {
    throw new Error('unexpected network request')
  })
  const config = Config({ appId: '102106848', secret: 'secret', transport: 'none', ...input } as QQConfig)
  await ctx.plugin(QQBot, config)
  const bot = ctx.bots[0] as QQBot
  bot.selfId = SELF_ID
  bot.user = { id: SELF_ID, name: '群pro测试机器人', isBot: true }
  const acknowledge = vi.spyOn(bot, 'acknowledgeInteraction').mockImplementation(async () => {})
  return { ctx, bot, acknowledge }
}

/** Every element of one tag in a tree, in document order. */
function collection(content: Element, tag: Tag): Element[] {
  const found: Element[] = []
  const walk = (node: Element) => {
    if (node.type === tag) found.push(node)
    for (const child of node.children) walk(child)
  }
  walk(content)
  return found
}

/** Attributes of one element as a plain record. */
function attrs(element: Element | undefined): Record<string, unknown> {
  return (element?.attrs ?? {}) as Record<string, unknown>
}

/** The single message of a decode result. */
function messageOf(sessions: Session[]) {
  expect(sessions).toHaveLength(1)
  const session = sessions[0]!
  expect(session.type).toBe('message')
  expect(session.message).toBeDefined()
  return session.message!
}

/** The single button click of a decode result. */
function buttonOf(sessions: Session[]) {
  expect(sessions).toHaveLength(1)
  const session = sessions[0]!
  expect(session.type).toBe('interaction/button')
  expect(session.button).toBeDefined()
  return session.button!
}

/** The referrer of one event, narrowed through the public guard. */
function referrerOf(value: unknown): QQReferrer {
  const referrer = readQQReferrer(value)
  expect(referrer).toBeDefined()
  return referrer!
}

describe('QQ inbound messages', () => {
  it('decodes a 群聊 @-message into a message session', async () => {
    const { bot } = await mount()
    const [session] = await bot.decodeDispatch(load('group-at-message'))
    const message = messageOf([session!])

    expect(message.id).toBe('ROBOT1.0_k3N4mQ2sT7vB9xY1zA5cD8eF0gH2jK4lM6nP8qR0sT2uV4wX6yZ8aB0cD2eF4gH6jK8lM0nP')
    expect(message.chat).toEqual({ id: GROUP_ID, type: 'group' })
    expect(message.sender).toEqual({
      id: GROUP_MEMBER,
      name: '小明',
      isBot: false,
      role: 'member',
    })
    expect(toText(message.content).trim()).toBe('/今日天气 上海')
    expect(message.content.type).toBe('message')
    // A 群聊 event only reaches the bot when it was @-ed; the platform strips that mention from `content`.
    expect(message.mentions).toEqual({ self: true, all: false, users: [] })
    expect(message.time).toBe(Date.parse('2026-07-21T10:00:00+08:00'))
    expect(message.quote).toBeUndefined()
  })

  it('decodes a full-mode 群聊 message that mentions the bot as addressed', async () => {
    const { bot } = await mount()
    vi.spyOn(bot.api, 'getSelf').mockResolvedValue({ id: SELF_ID, union_openid: SELF_UNION })

    const message = messageOf(await bot.decodeDispatch(fullModeFrame(`<@${SELF_UNION}> 在吗`)))

    expect(message.chat).toEqual({ id: GROUP_ID, type: 'group' })
    expect(toText(message.content)).toContain('在吗')
    // The platform's `mentions` array never carries the bot, so only the openid in the text identifies it.
    expect(message.mentions.self).toBe(true)
    expect(referrerOf(message.referrer).chatType).toBe('group')
  })

  it('leaves a full-mode 群聊 message that does not mention the bot unaddressed', async () => {
    const { bot } = await mount()
    bot.unionOpenid = SELF_UNION

    const message = messageOf(await bot.decodeDispatch(fullModeFrame('今天天气不错')))

    expect(message.mentions).toEqual({ self: false, all: false, users: [] })
  })

  it('reads the bot identity once for full-mode messages', async () => {
    const { bot } = await mount()
    const getSelf = vi.spyOn(bot.api, 'getSelf').mockResolvedValue({ id: SELF_ID, union_openid: SELF_UNION })

    expect(messageOf(await bot.decodeDispatch(fullModeFrame(`<@${SELF_UNION}> 一`, 'M1'))).mentions.self).toBe(true)
    expect(messageOf(await bot.decodeDispatch(fullModeFrame(`<@${SELF_UNION}> 二`, 'M2'))).mentions.self).toBe(true)
    expect(getSelf).toHaveBeenCalledTimes(1)
  })

  it('keeps a full-mode message unaddressed when the identity read fails', async () => {
    const { bot } = await mount()
    vi.spyOn(bot.api, 'getSelf').mockRejectedValue(new Error('offline'))

    const message = messageOf(await bot.decodeDispatch(fullModeFrame(`<@${SELF_UNION}> 在吗`)))

    // Answering a message that did not address the bot is worse than missing one.
    expect(message.mentions.self).toBe(false)
  })

  it('carries the passive-reply context the passive manager books a window from', async () => {
    const { bot } = await mount()
    const frame = load('group-at-message')
    const [session] = await bot.decodeDispatch(frame)

    const message = messageOf([session!])
    const referrer = referrerOf(message.referrer)
    expect(referrer.msg_id).toBe((frame.d as { id: string }).id)
    expect(referrer.event_id).toBe(frame.id)
    expect(referrer.chatType).toBe('group')
    expect(referrer.chatId).toBe(GROUP_ID)
    expect(referrer.receivedAt).toBeGreaterThan(Date.now() - 60_000)
    expect(referrer.messageId).toBeUndefined()
    // The reply key of a message trigger is its `msg_id`, and the session getter exposes the same referrer.
    expect(passiveKey(referrer)).toBe(referrer.msg_id)
    expect(referrerOf(session!.referrer)).toEqual(referrer)
    expect(readQQReferrer({ chatType: 'group' })).toBeUndefined()
    expect(readQQReferrer('nope')).toBeUndefined()
  })

  it('uses the sender of a 单聊 event as the conversation', async () => {
    const { bot } = await mount()
    const [session] = await bot.decodeDispatch(load('c2c-message'))
    const message = messageOf([session!])

    expect(message.chat).toEqual({ id: C2C_USER, type: 'direct' })
    expect(message.sender).toEqual({ id: 'DD8246C68EC19CAF8D2AA76941180EA4', isBot: false })
    expect(toText(message.content)).toBe('你好，今天有什么推荐的活动吗？')
    // A 单聊 message is addressed by the chat type, not by a mention.
    expect(message.mentions).toEqual({ self: false, all: false, users: [] })
    expect(referrerOf(message.referrer).chatType).toBe('direct')
  })

  it('keeps the session dedupe key stable across a redelivery of the same message', async () => {
    const { bot } = await mount()
    const frame = load('group-at-message')
    const [first] = await bot.decodeDispatch(frame)
    const [second] = await bot.decodeDispatch(frame)

    expect(first!.event.id).toBe((frame.d as { id: string }).id)
    expect(second!.event.id).toBe(first!.event.id)
  })

  it('decodes attachments into media elements with their platform URL', async () => {
    const { bot } = await mount()
    const [session] = await bot.decodeDispatch(load('group-at-message-media'))
    const message = messageOf([session!])

    expect(toText(message.content)).toContain('看看这张风景照')

    const [image] = collection(message.content, 'img')
    expect(attrs(image)).toMatchObject({
      src: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=img-01&rkey=rk01&spec=0',
      alt: 'photo.jpg',
      width: 1920,
      height: 1080,
    })

    const [audio] = collection(message.content, 'audio')
    // The platform transcodes SILK next to the original; the playable WAV copy is the useful source.
    expect(attrs(audio)).toEqual({
      src: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=voice-01&rkey=rk02&spec=1',
      name: 'voice.silk',
    })

    const [file] = collection(message.content, 'file')
    expect(attrs(file)).toEqual({
      src: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=file-01&rkey=rk03&spec=0',
      name: '季度报告.pdf',
      size: 2097152,
    })
  })

  it('decodes a quoted message from message_scene.ext and msg_elements', async () => {
    const { bot } = await mount()
    const [session] = await bot.decodeDispatch(load('c2c-quote'))
    const message = messageOf([session!])

    expect(message.quote).toBeDefined()
    expect(message.quote!.id).toBe('REFIDX_aaaaaaaaaaaaaaa==')
    expect(toText(message.quote!.content!)).toBe('每天坚持阅读半小时，一个月后你会发现自己的变化')
    expect(toText(message.content)).toBe('这个建议很有帮助，谢谢你！')
  })

  it('records message_scene.ext.msg_idx as an alias alongside message.id', async () => {
    const { bot } = await mount()
    const [session] = await bot.decodeDispatch({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      id: 'evt-alias',
      d: {
        id: 'ROBOT1.0_msg_1',
        author: { user_openid: 'user-1' },
        content: 'original text',
        timestamp: '2026-07-21T10:00:00+08:00',
        message_scene: { ext: ['msg_idx=REFIDX_alias_1=='] },
      },
    })
    const message = messageOf([session!])
    expect(message.id).toBe('ROBOT1.0_msg_1')
    expect(message.aliases).toEqual(['REFIDX_alias_1=='])
  })

  it('decodes a quoted 聊天记录 that carries no message_type marker', async () => {
    const { bot } = await mount()
    const [session] = await bot.decodeDispatch(load('group-at-message-quote'))
    const message = messageOf([session!])

    expect(message.quote!.id).toBe('TMP_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    expect(toText(message.quote!.content!)).toContain('今天的学习计划已完成')
    // The message body itself held only whitespace, so the tree says so instead of coming back empty.
    expect(toText(message.content)).toContain('[空消息]')
    expect(attrs(collection(message.content, 'raw')[0]).type).toBe('message_type:103')
  })

  it('keeps an ARK card as a raw element', async () => {
    const { bot } = await mount()
    const frame = load('c2c-ark')
    const message = messageOf(await bot.decodeDispatch(frame))

    const [raw] = collection(message.content, 'raw')
    expect(attrs(raw).platform).toBe('qq')
    expect(attrs(raw).type).toBe('ark')
    expect(attrs(raw).data).toEqual((frame.d as { ark_data: unknown }).ark_data)
    // The platform already flattened the card into `content`, so the raw element carries no duplicate text.
    expect(raw!.children).toHaveLength(0)
    expect(toText(message.content)).toContain('[卡片消息] 小程序')
  })

  it('turns the text markup into at elements and flags @everyone', async () => {
    const { bot } = await mount()
    const frame: GatewayDispatch = {
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      id: 'GROUP_AT_MESSAGE_CREATE:mentions',
      d: {
        id: 'ROBOT1.0_mentions',
        author: { id: GROUP_MEMBER, member_openid: GROUP_MEMBER, username: '小明', bot: false },
        group_openid: 'B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5',
        content: '<@!C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6> <@A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4> 你好 <qqbot-at-everyone/> <qqbot-at-user>',
        message_type: 0,
        timestamp: '2026-07-21T10:30:00+08:00',
        mentions: [{ id: 'C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6', username: '小红', bot: false }],
      },
    }
    const message = messageOf(await bot.decodeDispatch(frame))

    expect(collection(message.content, 'at').map(element => attrs(element))).toEqual([
      { type: 'user', id: 'C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6' },
      { type: 'user', id: GROUP_MEMBER },
      { type: 'all' },
    ])
    expect(message.mentions.self).toBe(true)
    expect(message.mentions.all).toBe(true)
    expect(message.mentions.users).toEqual([{ id: 'C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6', name: '小红', isBot: false }])
    // A malformed tag is literal text, never a lost mention.
    expect(toText(message.content)).toContain('<qqbot-at-user>')
  })

  it('recognises a mention of the bot itself in a 单聊 message', async () => {
    const { bot } = await mount()
    const frame: GatewayDispatch = {
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      id: 'C2C_MESSAGE_CREATE:self',
      d: {
        id: 'ROBOT1.0_self',
        author: { id: 'DD8246C68EC19CAF8D2AA76941180EA4', user_openid: 'DD8246C68EC19CAF8D2AA76941180EA4' },
        content: `<qqbot-at-user id="${SELF_ID}" /> 在吗`,
        message_type: 0,
        timestamp: '2026-07-21T10:31:00+08:00',
      },
    }
    const message = messageOf(await bot.decodeDispatch(frame))

    expect(message.mentions.self).toBe(true)
    expect(message.mentions.all).toBe(false)
    expect(collection(message.content, 'at').map(element => attrs(element))).toEqual([{ type: 'user', id: SELF_ID }])
    expect(toText(message.content)).toContain('在吗')
  })

  it('never returns empty content', async () => {
    const { bot } = await mount()
    const message = messageOf(await bot.decodeDispatch(load('empty-message')))

    expect(toText(message.content).trim()).toBe('[空消息]')
    expect(attrs(collection(message.content, 'raw')[0]).type).toBe('message_type:0')
    expect(message.sender.role).toBe('admin')
  })
})

describe('QQ interactions', () => {
  it('acknowledges a 群聊 button click exactly once and publishes it as interaction/button', async () => {
    const { bot, acknowledge } = await mount()
    const frame = load('interaction-button-group')
    const [session] = await bot.decodeDispatch(frame)
    const button = buttonOf([session!])

    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(acknowledge).toHaveBeenCalledWith('06915133-7aef-46ed-94f7-c50939e285ae')
    expect(session!.event.id).toBe('06915133-7aef-46ed-94f7-c50939e285ae')
    // A cordis-tracked bot reaches the event as a context-bound proxy, so only its identity fields compare.
    expect(button.bot.id).toBe(bot.id)
    expect(button.bot.sid).toBe(bot.sid)
    expect(button.user).toEqual({ id: GROUP_MEMBER })
    expect(button.chat).toEqual({ id: GROUP_ID, type: 'group' })
    expect(button.data).toBe('eyJjb21tYW5kIjogInNhbXBsZSJ9')
    // This payload carries no `button_id` and no `id:data` encoding, so the id stays empty instead of being invented.
    expect(button.id).toBe('')
    expect(button.time).toBe(Date.parse('2026-07-20T21:53:54+08:00'))
    expect(button.message).toBeUndefined()
  })

  it('carries the interaction id as the passive key of the click reply', async () => {
    const { bot } = await mount()
    const frame = load('interaction-button-c2c')
    const button = buttonOf(await bot.decodeDispatch(frame))

    expect(button.id).toBe('allow-once')
    expect(button.data).toBe('confirm:once')
    expect(button.chat).toEqual({ id: C2C_USER, type: 'direct' })
    const referrer = referrerOf(button.referrer)
    expect(referrer).toEqual({
      event_id: '1b13d569-4610-4ab9-bc51-feecc5def6d4',
      receivedAt: expect.any(Number),
      chatType: 'direct',
      chatId: C2C_USER,
    })
    expect(referrer.msg_id).toBeUndefined()
    expect(passiveKey(referrer)).toBe('1b13d569-4610-4ab9-bc51-feecc5def6d4')
  })

  it('recovers the button id from the `id[:data]` encoding when the platform omits it', async () => {
    const { bot } = await mount()
    const frame: GatewayDispatch = {
      op: 0,
      t: 'INTERACTION_CREATE',
      id: 'INTERACTION_CREATE:encoded',
      d: {
        id: 'encoded-click',
        type: 11,
        scene: 'group',
        chat_type: 1,
        group_openid: 'B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5',
        group_member_openid: GROUP_MEMBER,
        data: { type: 11, resolved: { button_data: 'allow-once:confirm' } },
        timestamp: '2026-07-20T21:53:54+08:00',
        version: 1,
      },
    }
    const button = buttonOf(await bot.decodeDispatch(frame))

    expect(button.id).toBe('allow-once')
    expect(button.data).toBe('allow-once:confirm')
  })

  it('exposes the message that carried the button when the platform reports it', async () => {
    const { bot } = await mount()
    const frame: GatewayDispatch = {
      op: 0,
      t: 'INTERACTION_CREATE',
      id: 'INTERACTION_CREATE:with-message',
      d: {
        id: 'with-message',
        type: 11,
        scene: 'c2c',
        chat_type: 2,
        user_openid: 'DD8246C68EC19CAF8D2AA76941180EA4',
        data: { type: 11, resolved: { button_id: 'ok', button_data: 'ok:1', message_id: 'ROBOT1.0_card' } },
        timestamp: '2026-07-20T21:53:54+08:00',
        version: 1,
      },
    }
    const button = buttonOf(await bot.decodeDispatch(frame))

    expect(button.message).toEqual({ id: 'ROBOT1.0_card', chat: { id: C2C_USER, type: 'direct' } })
    expect(referrerOf(button.referrer).messageId).toBe('ROBOT1.0_card')
  })

  it('acknowledges a 快捷菜单 click but publishes no button session', async () => {
    const { bot, acknowledge } = await mount()
    const frame: GatewayDispatch = {
      op: 0,
      t: 'INTERACTION_CREATE',
      id: 'INTERACTION_CREATE:menu',
      d: {
        id: 'menu-click',
        type: 12,
        scene: 'c2c',
        chat_type: 2,
        user_openid: 'DD8246C68EC19CAF8D2AA76941180EA4',
        data: { type: 12, resolved: { feature_id: 'daily-report' } },
        timestamp: '2026-07-20T21:53:54+08:00',
        version: 1,
      },
    }

    expect(await bot.decodeDispatch(frame)).toEqual([])
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('ignores — and does not acknowledge — the interaction types that take no response', async () => {
    const { bot, acknowledge } = await mount()
    expect(await bot.decodeDispatch(load('interaction-feedback'))).toEqual([])
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('keeps the click when the acknowledgement fails', async () => {
    const { bot, acknowledge } = await mount()
    acknowledge.mockRejectedValue(new Error('check app privilege not pass'))

    const button = buttonOf(await bot.decodeDispatch(load('interaction-button-c2c')))
    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(button.id).toBe('allow-once')
  })
})

describe('QQ chat lifecycle', () => {
  it('reports a bot added to a group as an internal observer event', async () => {
    const { bot } = await mount()
    const [session] = await bot.decodeDispatch(load('group-add-robot'))

    expect(session!.type).toBe('internal')
    expect(session!.event.id).toBe('GROUP_ADD_ROBOT:6f708192a3b4c5d6e7f8091a2b3c4d5e')
    expect(session!.event.internal).toEqual({
      type: 'qq/group-added',
      data: {
        chat: { id: GROUP_ID, type: 'group' },
        timestamp: 1753063200000,
        operator: { id: GROUP_MEMBER },
      },
    })
  })

  it('reports a removed friend as a direct chat the bot can no longer address', async () => {
    const { bot } = await mount()
    const frame: GatewayDispatch = {
      op: 0,
      t: 'FRIEND_DEL',
      id: 'FRIEND_DEL:friend',
      d: { openid: 'DD8246C68EC19CAF8D2AA76941180EA4', timestamp: 1753063200 },
    }
    const [session] = await bot.decodeDispatch(frame)

    expect(session!.event.internal).toEqual({
      type: 'qq/friend-removed',
      data: { chat: { id: C2C_USER, type: 'direct' }, timestamp: 1753063200000 },
    })
  })
})

describe('QQ decode robustness', () => {
  it('decodes nothing for frames it does not serve', async () => {
    const { bot, acknowledge } = await mount()
    const frames: GatewayDispatch[] = [
      { op: 0, t: 'READY', d: { session_id: 'x' } },
      { op: 0, t: 'MESSAGE_CREATE', d: { id: 'guild-message', channel_id: '1', content: 'x' } },
      { op: 0, t: 'GROUP_AT_MESSAGE_CREATE' },
      { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'ROBOT1.0_no-chat' } },
      { op: 0, t: 'INTERACTION_CREATE', d: {} },
      { op: 0, t: 'INTERACTION_CREATE', d: { id: 'stale', type: 99 } },
    ]
    for (const frame of frames) expect(await bot.decodeDispatch(frame)).toEqual([])
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('acknowledges a 频道 click but publishes nothing, because v1 serves only 群聊 and 单聊', async () => {
    const { bot, acknowledge } = await mount()
    const frame: GatewayDispatch = {
      op: 0,
      t: 'INTERACTION_CREATE',
      id: 'INTERACTION_CREATE:guild',
      d: {
        id: 'guild-click',
        type: 11,
        scene: 'guild',
        chat_type: 0,
        guild_id: 'guild-openid',
        channel_id: 'channel-openid',
        data: { type: 11, resolved: { button_id: 'b', user_id: 'user' } },
        timestamp: '2026-07-20T21:53:54+08:00',
        version: 1,
      },
    }

    expect(await bot.decodeDispatch(frame)).toEqual([])
    // The client spins until the platform sees the acknowledgement, so it is sent even when nothing else happens.
    expect(acknowledge).toHaveBeenCalledWith('guild-click')
  })

  it('reads the documented `key=value` scene extras', () => {
    expect(parseSceneExt([
      'msg_idx=REFIDX_xxx==',
      'ref_msg_idx=TMP_yyy',
      'auth_token=zzz',
    ])).toEqual({ msg_idx: 'REFIDX_xxx==', ref_msg_idx: 'TMP_yyy', auth_token: 'zzz' })
    // The field is loosely typed, so a JSON object is accepted as well.
    expect(parseSceneExt(['{"ref_msg_idx":"REFIDX_zzz=="}'])).toEqual({ ref_msg_idx: 'REFIDX_zzz==' })
    expect(parseSceneExt(['nonsense', '', '{"broken":', 42, null])).toEqual({})
    expect(parseSceneExt(undefined)).toEqual({})
  })

  it('parses the RFC3339 timestamps, the odd suffixes and epoch seconds', () => {
    expect(decodeTimestamp('2026-07-21T10:00:00+08:00')).toBe(Date.parse('2026-07-21T10:00:00+08:00'))
    expect(decodeTimestamp('2026-07-21T02:00:00Z')).toBe(Date.parse('2026-07-21T02:00:00Z'))
    expect(decodeTimestamp('2026-07-21 10:00:00')).toBe(new Date('2026-07-21T10:00:00').valueOf())
    expect(decodeTimestamp('2026-07-21T10:00:00+0800 CST m=+12.345')).toBe(Date.parse('2026-07-21T10:00:00+08:00'))
    expect(decodeTimestamp(1753063200)).toBe(1753063200000)
    expect(decodeTimestamp(1753063200123)).toBe(1753063200123)
    expect(decodeTimestamp(undefined, 7)).toBe(7)
    expect(decodeTimestamp('not a date', 7)).toBe(7)
  })
})
