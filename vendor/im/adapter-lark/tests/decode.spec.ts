/**
 * Inbound decoding of the Lark / Feishu adapter.
 *
 * Every case is a real event envelope from `tests/fixtures` — the wire shape of `im.message.receive_v1` and of a
 * message read — so the suite pins the element vocabulary each platform kind becomes, the referrer/thread/quote context
 * a reply needs, and the never-empty rule, without touching the network.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/cordis-plugin-im-core'
import { toText, type Element, type Tag } from '@deepseek-ai/satori-element'
import {
  Lark,
  readLarkReferrer,
  type LarkRawEvent,
  type LarkReferrer,
} from '@deepseek-ai/cordis-plugin-im-adapter-lark'
import { decodeEvent, decodeMessage, epochTime } from '@deepseek-ai/cordis-plugin-im-adapter-lark/src/decode.ts'
import { disposeAll, fixture, mount, SELF_ID } from './fixtures/harness.ts'

/** Decode clock of the suite; `referrer.receivedAt` and the timestamp fallbacks use it. */
const NOW = 1_700_000_100_000

const CHAT = { id: 'oc_chat', type: 'group' as const }

afterEach(disposeAll)

/** The single message of a decode result. */
function messageOf(sessions: Session[]) {
  expect(sessions).toHaveLength(1)
  const session = sessions[0]!
  expect(session.type).toBe('message')
  expect(session.message).toBeDefined()
  return session.message!
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

/** The referrer of one message, narrowed through the public guard. */
function referrerOf(value: unknown): LarkReferrer {
  const referrer = readLarkReferrer(value)
  expect(referrer).toBeDefined()
  return referrer!
}

/** The `satori:` URL of one message resource. */
function resourceUrl(messageId: string, key: string, type: 'image' | 'file') {
  return `satori:feishu/${SELF_ID}/messages/${messageId}/resources/${key}?type=${type}`
}

/** Decode one fixture with a freshly mounted bot. */
async function decode(name: string) {
  const { bot } = await mount()
  const raw = fixture<LarkRawEvent>(name)
  const sessions = await decodeEvent(bot, raw, NOW)
  return { bot, raw, sessions, message: messageOf(sessions) }
}

describe('text and its mentions', () => {
  it('splits mention keys into at elements and keeps the rest literal', async () => {
    const { message, sessions } = await decode('text-mentions')
    expect(message.id).toBe('om_text_mentions')
    expect(message.chat).toEqual(CHAT)
    expect(message.sender).toEqual({ id: 'ou_user' })
    expect(message.time).toBe(1_700_000_000_000)
    // The bot itself and `@all` are the reader's business, not the renderer's.
    expect(message.mentions).toEqual({ self: true, all: true, users: [{ id: SELF_ID, name: '小助手' }] })
    // A hyperlink arrives as markdown text; inbound text stays literal instead of being interpreted as markup.
    expect(toText(message.content).trim()).toBe('@小助手 看一下 @all 这条 [看板](https://example.com/board)')
    const paragraph = message.content.children[0]!
    expect(paragraph.type).toBe('p')
    expect(paragraph.children.map(child => child.type)).toEqual(['at', 'text', 'at', 'text'])
    expect(attrs(paragraph.children[0])).toEqual({ type: 'user', id: SELF_ID, name: '小助手' })
    expect(attrs(paragraph.children[1])).toEqual({ content: ' 看一下 ' })
    expect(attrs(paragraph.children[2])).toEqual({ type: 'all', name: '所有人' })
    // Duplicate deliveries are documented, so the intake dedupes on the message id.
    expect(sessions[0]!.event.id).toBe('om_text_mentions')
  })

  it('carries the reply and thread context a reply needs', async () => {
    const { message } = await decode('text-thread')
    expect(message.chat).toEqual({ id: 'oc_topic', type: 'group' })
    expect(message.thread).toEqual({ id: 'omt_thread', root: 'om_root' })
    expect(message.quote).toEqual({ id: 'om_root' })
    expect(referrerOf(message.referrer)).toEqual({
      event_id: 'ev_text_thread',
      receivedAt: NOW,
      chatType: 'group',
      chatId: 'oc_topic',
      messageId: 'om_text_thread',
      threadId: 'omt_thread',
      rootId: 'om_root',
    })
  })
})

describe('post', () => {
  it('decodes the title, paragraphs, links, media and code of a rich post', async () => {
    const { message } = await decode('post')
    const content = message.content
    const [title] = content.children
    expect(title!.type).toBe('title')
    expect(toText(title!)).toBe('周报')
    const paragraphs = collection(content, 'p')
    expect(paragraphs.map(paragraph => paragraph.children.map(child => child.type))).toEqual([
      ['text', 'a'],
      ['at', 'text'],
      ['img'],
      ['video'],
      ['text'],
    ])
    expect(attrs(collection(content, 'a')[0])).toEqual({ href: 'https://example.com/board' })
    expect(attrs(collection(content, 'at')[0])).toEqual({ type: 'user', id: 'ou_alice', name: 'Alice' })
    expect(attrs(collection(content, 'img')[0])).toEqual({ src: resourceUrl('om_post', 'img_v2_post', 'image') })
    // `media` is the video kind: the file is the video, `image_key` its poster.
    expect(attrs(collection(content, 'video')[0])).toEqual({
      src: resourceUrl('om_post', 'file_v2_clip', 'file'),
      poster: resourceUrl('om_post', 'img_v2_poster', 'image'),
      duration: 4200,
    })
    const code = collection(content, 'pre')[0]!
    expect(attrs(code)).toEqual({ lang: 'ts' })
    expect(toText(code)).toBe('const a = 1')
    expect(collection(content, 'hr')).toHaveLength(1)
    // Post emotions are unicode characters, so they stay the text the platform sent.
    expect(toText(content)).toContain('😊')
  })

  it('reads the markdown of `content_v2` instead of flattening it again', async () => {
    const { message } = await decode('post-content-v2')
    const content = message.content
    expect(toText(collection(content, 'h2')[0])).toBe('进展')
    const list = collection(content, 'ul')[0]!
    expect(collection(list, 'li').map(item => toText(item).trim())).toEqual(['• 完成 A', '• 完成 B'])
    // An `md` node that only holds phrasing content stays inside its paragraph.
    const paragraph = content.children[content.children.length - 1]!
    expect(paragraph.type).toBe('p')
    expect(paragraph.children.map(child => child.type)).toEqual(['text', 'b'])
    expect(toText(paragraph)).toBe('行内 重点')
  })
})

describe('resource kinds point at the internal route', () => {
  it('decodes an image', async () => {
    const { message } = await decode('image')
    expect(message.content.children.map(child => child.type)).toEqual(['img'])
    expect(attrs(collection(message.content, 'img')[0])).toEqual({
      src: resourceUrl('om_image', 'img_v2_photo', 'image'),
    })
  })

  it('decodes a file with its name', async () => {
    const { message } = await decode('file')
    expect(attrs(collection(message.content, 'file')[0])).toEqual({
      src: resourceUrl('om_file', 'file_v2_report', 'file'),
      name: 'report.pdf',
    })
  })

  it('decodes a voice message with its duration', async () => {
    const { message } = await decode('audio')
    expect(attrs(collection(message.content, 'audio')[0])).toEqual({
      src: resourceUrl('om_audio', 'file_v2_voice', 'file'),
      duration: 3000,
    })
  })

  it('decodes a video message with its poster, duration and name', async () => {
    const { message } = await decode('media')
    expect(attrs(collection(message.content, 'video')[0])).toEqual({
      src: resourceUrl('om_media', 'file_v2_clip', 'file'),
      poster: resourceUrl('om_media', 'img_v2_poster', 'image'),
      duration: 4200,
      name: 'clip.mp4',
    })
  })
})

describe('kinds without a direct element become raw or forward', () => {
  it('keeps a sticker as a raw element with its label', async () => {
    const { message } = await decode('sticker')
    expect(message.content.children.map(child => child.type)).toEqual(['raw'])
    const raw = collection(message.content, 'raw')[0]!
    expect(attrs(raw)).toMatchObject({ platform: 'lark', type: 'sticker' })
    expect(toText(raw)).toBe('[表情]')
  })

  it('decodes a merged forward as an identity reference', async () => {
    const { message } = await decode('merge-forward')
    const forward = collection(message.content, 'forward')[0]!
    // The entries are separate messages of their own read (`upper_message_id`), so only the container is named here.
    expect(attrs(forward)).toEqual({ id: 'om_merge_forward' })
    expect(toText(message.content).trim()).toBe('[forward]')
  })

  it('keeps an unknown kind with its readable text', async () => {
    const { message } = await decode('unknown-location')
    const raw = collection(message.content, 'raw')[0]!
    expect(attrs(raw)).toMatchObject({ platform: 'lark', type: 'location', data: { latitude: '31.2' } })
    expect(toText(raw)).toBe('上海办公室')
  })

  it('never decodes to empty content', async () => {
    const { message } = await decode('empty-text')
    expect(message.content.type).toBe('message')
    expect(message.content.children).not.toHaveLength(0)
    const raw = collection(message.content, 'raw')[0]!
    expect(attrs(raw)).toMatchObject({ platform: 'lark', type: 'text' })
    expect(toText(raw)).toBe('[空消息]')
  })

  it('keeps a system message template', async () => {
    const { bot } = await mount()
    const raw = fixture<LarkRawEvent>('text-mentions')
    raw.event = {
      message: {
        message_id: 'om_system',
        chat_id: 'oc_chat',
        chat_type: 'group',
        message_type: 'system',
        create_time: '1700000000000',
        content: '{"template":"{from_user} 邀请 {to_chusers} 加入群聊"}',
      },
    }
    const [session] = await bot.decodeEvent(raw)
    const message = messageOf([session!])
    const element = collection(message.content, 'raw')[0]!
    expect(attrs(element)).toMatchObject({ platform: 'lark', type: 'system' })
    expect(toText(element)).toBe('{from_user} 邀请 {to_chusers} 加入群聊')
  })

  it('keeps a shared chat and a shared contact as raw elements', async () => {
    const { bot } = await mount()
    /** The same envelope with another message kind. */
    const event = (type: string, content: string, messageId: string, chatType = 'group') => {
      const raw = fixture<LarkRawEvent>('text-mentions')
      raw.event = {
        message: {
          message_id: messageId,
          chat_id: 'oc_chat',
          chat_type: chatType,
          message_type: type,
          create_time: '1700000000000',
          content,
        },
      }
      return raw
    }
    const shared = messageOf(await bot.decodeEvent(event('share_chat', '{"chat_id":"oc_shared"}', 'om_share_chat')))
    const sharedRaw = collection(shared.content, 'raw')[0]!
    expect(attrs(sharedRaw)).toMatchObject({ platform: 'lark', type: 'share_chat', data: { chat_id: 'oc_shared' } })
    expect(toText(sharedRaw)).toBe('[群名片]')

    const contact = messageOf(await bot.decodeEvent(event('share_user', '{"user_id":"ou_alice"}', 'om_share_user')))
    const contactRaw = collection(contact.content, 'raw')[0]!
    expect(attrs(contactRaw)).toMatchObject({ platform: 'lark', type: 'share_user' })
    expect(toText(contactRaw)).toBe('[个人名片]')
    // A direct chat is readable from the payload alone, so no chat probe is needed to decode its message.
    const direct = await bot.decodeEvent(event('text', '{"text":"hi"}', 'om_direct', 'p2p'))
    expect(direct[0]!.event.message?.chat).toEqual({ id: 'oc_chat', type: 'direct' })
  })
})

describe('interactive cards', () => {
  it('flattens the delivered render structure in document order', async () => {
    const { message } = await decode('interactive')
    const raw = collection(message.content, 'raw')[0]!
    expect(attrs(raw)).toMatchObject({ platform: 'lark', type: 'interactive' })
    const text = toText(raw)
    expect(text).toContain('构建结果')
    expect(text).toContain('分支 main 通过')
    // The card's own `at` element names the mention by its message-scoped key.
    expect(text).toContain('@小助手')
    expect(text).toContain('查看日志')
    expect(text).toContain('[image: 趋势图]')
    expect(text).toContain('重试')
    expect(text).toContain('机器人自动推送')
    // A target the card links to survives as a real link, not as a placeholder.
    expect(attrs(collection(raw, 'a')[0])).toEqual({ href: 'https://example.com/log' })
    expect(text).toContain('[link] https://example.com/log')
  })

  it('reads the card JSON a `user_card_content` read returns', async () => {
    const { message } = await decode('interactive-card-json')
    const raw = collection(message.content, 'raw')[0]!
    const text = toText(raw)
    expect(text).toContain('发布提醒')
    expect(text).toContain('**v1.2.0** 已上线')
    expect(text).toContain('打开链接')
    expect(text).toContain('[link] https://example.com/release')
  })
})

describe('other event families', () => {
  it('decodes a recall into `message-deleted`', async () => {
    const { bot } = await mount({}, {
      '/open-apis/im/v1/chats/oc_chat': () => Response.json({ code: 0, data: { chat_mode: 'group' } }),
    })
    const [session] = await decodeEvent(bot, fixture<LarkRawEvent>('recalled'), NOW)
    expect(session!.type).toBe('message-deleted')
    expect(session!.event.id).toBe('om_text_mentions')
    expect(session!.event.deleted).toEqual({ id: 'om_text_mentions', chat: { id: 'oc_chat', type: 'group' } })
    expect(session!.timestamp).toBe(1_700_000_035_000)
  })

  it('decodes a reaction change when the payload names its chat', async () => {
    const { bot } = await mount()
    const [session] = await decodeEvent(bot, fixture<LarkRawEvent>('reaction'), NOW)
    expect(session!.type).toBe('reaction-added')
    expect(session!.event.id).toBe('ev_reaction')
    expect(session!.event.reaction).toEqual({
      message: { id: 'om_text_mentions', chat: { id: 'oc_chat', type: 'group' } },
      emoji: 'SMILE',
      user: { id: 'ou_user' },
    })
  })

  it('decodes a reaction change even when the platform names no chat', async () => {
    const { bot } = await mount()
    const raw = fixture<LarkRawEvent>('reaction')
    const event = raw.event as Record<string, unknown>
    delete event.chat_id
    delete event.chat_type
    const [session] = await bot.decodeEvent(raw)
    expect(session!.type).toBe('reaction-added')
    expect(session!.event.id).toBe('ev_reaction')
    expect(session!.event.reaction).toEqual({
      message: { id: 'om_text_mentions' },
      emoji: 'SMILE',
      user: { id: 'ou_user' },
    })
  })

  it('normalizes an own-app reaction operator to bot.selfId and handles reaction-removed', async () => {
    const { bot } = await mount()
    bot.selfId = 'ou_bot'
    const raw = fixture<LarkRawEvent>('reaction')
    raw.header = { ...raw.header, event_type: 'im.message.reaction.deleted_v1', event_id: 'ev_del' }
    raw.event = {
      message_id: 'om_text_mentions',
      reaction_type: { emoji_type: 'Typing' },
      operator_type: 'app',
      app_id: bot.config.appId,
      action_time: '1700000031000',
    }
    const [session] = await bot.decodeEvent(raw)
    expect(session!.type).toBe('reaction-removed')
    expect(session!.event.id).toBe('ev_del')
    expect(session!.event.reaction).toEqual({
      message: { id: 'om_text_mentions' },
      emoji: 'Typing',
      user: { id: 'ou_bot', isBot: true },
    })
  })

  it('publishes nothing for a family it does not serve', async () => {
    const { bot } = await mount()
    const raw = fixture<LarkRawEvent>('text-mentions')
    raw.header = { ...raw.header, event_type: 'im.chat.updated_v1' } as unknown as LarkRawEvent['header']
    await expect(bot.decodeEvent(raw)).resolves.toEqual([])
  })
})

describe('a message read back', () => {
  /** One message as `GET /im/v1/messages/:id` shapes it. */
  function read(overrides: Record<string, unknown> = {}): Lark.Message {
    return {
      message_id: 'om_read',
      chat_id: 'oc_chat',
      msg_type: 'text',
      create_time: '1700000009000',
      sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' },
      body: { content: '{"text":"@_user_1 你好"}' },
      mentions: [{ key: '@_user_1', id: 'ou_alice', id_type: 'open_id', name: 'Alice' }],
      ...overrides,
    } as Lark.Message
  }

  it('decodes a read text with the chat the caller authorized', async () => {
    const { bot } = await mount()
    const message = await decodeMessage(bot, read(), CHAT, NOW)
    expect(message.id).toBe('om_read')
    expect(message.chat).toEqual(CHAT)
    expect(message.sender).toEqual({ id: 'ou_user' })
    expect(message.time).toBe(1_700_000_009_000)
    expect(toText(message.content).trim()).toBe('@Alice 你好')
    // A read carries the mention id as a plain string (`id_type`), which resolves the same way.
    expect(attrs(collection(message.content, 'at')[0])).toEqual({ type: 'user', id: 'ou_alice', name: 'Alice' })
    expect(referrerOf(message.referrer)).toEqual({
      receivedAt: NOW,
      chatType: 'group',
      chatId: 'oc_chat',
      messageId: 'om_read',
    })
  })

  it('probes the chat kind when the caller does not know it', async () => {
    const { bot, calls } = await mount({}, {
      '/open-apis/im/v1/chats/oc_chat': () => Response.json({ code: 0, data: { chat_mode: 'topic' } }),
    })
    const message = await decodeMessage(bot, read(), undefined, NOW)
    expect(message.chat).toEqual({ id: 'oc_chat', type: 'topic' })
    expect(calls.filter(call => call.path === '/open-apis/im/v1/chats/oc_chat')).toHaveLength(1)
  })

  it('keeps a recalled message as a raw element', async () => {
    const { bot } = await mount()
    const message = await bot.decodeMessage(read({ deleted: true, body: { content: '' } }), CHAT)
    const raw = collection(message.content, 'raw')[0]!
    expect(attrs(raw)).toMatchObject({ platform: 'lark', type: 'deleted' })
    expect(toText(raw)).toBe('[消息已撤回]')
  })

  it('keeps the thread and the quoted parent of a read message', async () => {
    const { bot } = await mount()
    const message = await bot.decodeMessage(
      read({ root_id: 'om_root', parent_id: 'om_root', thread_id: 'omt_1' }),
      CHAT,
    )
    expect(message.thread).toEqual({ id: 'omt_1', root: 'om_root' })
    expect(message.quote).toEqual({ id: 'om_root' })
  })

  it('fills a merged forward with the entries the same read carried', async () => {
    const { bot } = await mount()
    const container = read({
      message_id: 'om_forward',
      msg_type: 'merge_forward',
      body: { content: 'Merged and Forwarded Message' },
    })
    // The entries are messages of the chat the forward was assembled from, each naming the container it belongs to.
    const entry = (patch: Record<string, unknown>): Lark.Message => read({
      chat_id: 'oc_source',
      upper_message_id: 'om_forward',
      ...patch,
    })
    const message = await decodeMessage(bot, container, CHAT, NOW, [
      container,
      entry({ message_id: 'om_entry_1', body: { content: '{"text":"hello"}' } }),
      entry({ message_id: 'om_entry_2', msg_type: 'image', body: { content: '{"image_key":"img_v2_1"}' } }),
      entry({ message_id: 'om_entry_3', msg_type: 'merge_forward', body: { content: 'Merged and Forwarded Message' } }),
      // A forwarded conversation usually carries a rich-text entry: its paragraphs are what a forward can hold inline.
      entry({
        message_id: 'om_entry_4',
        msg_type: 'post',
        body: { content: '{"title":"","content":[[{"tag":"text","text":"http_trace_id 3a96fa"}]]}' },
      }),
    ])
    const forward = collection(message.content, 'forward')[0]!
    expect(attrs(forward)).toEqual({ id: 'om_forward' })
    // One line per entry: the sender, then the entry's own content; a nested forward stays a reference of its own.
    const lines = toText(forward).split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('ou_user: hello')
    expect(lines[1]).toContain('ou_user: ')
    // A forward nested in the answer keeps its own identity on a line of its own.
    expect(lines[2]).toBe('[合并转发 #om_entry_3]')
    expect(lines[3]).toBe('ou_user: http_trace_id 3a96fa')
    // The entry's picture is served by the container: the platform answers `File not in msg` for the entry's own id.
    expect(attrs(collection(forward, 'img')[0])).toMatchObject({ src: resourceUrl('om_forward', 'img_v2_1', 'image') })
  })

  it('lays a forward of a forward out in the order the platform returned it', async () => {
    const { bot } = await mount()
    const merge = { msg_type: 'merge_forward', body: { content: 'Merged and Forwarded Message' } }
    const entry = (id: string, parent?: string, patch: Record<string, unknown> = {}): Lark.Message => read({
      message_id: id,
      chat_id: 'oc_source',
      upper_message_id: parent,
      body: { content: `{"text":"${id}"}` },
      ...patch,
    })
    // The answer carries the whole tree: the inner container, then the entries that belong to it.
    const message = await decodeMessage(bot, entry('om_outer', undefined, merge), CHAT, NOW, [
      entry('om_outer', undefined, merge),
      entry('om_t1', 'om_outer'),
      entry('om_inner', 'om_outer', merge),
      entry('om_g1', 'om_inner'),
      entry('om_t2', 'om_outer'),
    ])
    const forward = collection(message.content, 'forward')[0]!
    expect(toText(forward).split('\n')).toEqual([
      'ou_user: om_t1',
      '[合并转发 #om_inner]',
      '  ou_user: om_g1',
      'ou_user: om_t2',
    ])
  })

  it('keeps a merged forward as a reference when the read carried no entry', async () => {
    const { bot } = await mount()
    const message = await bot.decodeMessage(read({ msg_type: 'merge_forward', body: { content: 'Merged and Forwarded Message' } }), CHAT)
    expect(toText(message.content).trim()).toBe('[forward]')
  })

  it('rejects a message without an identity', async () => {
    const { bot } = await mount()
    await expect(bot.decodeMessage({ chat_id: 'oc_chat' } as Lark.Message, CHAT)).rejects.toThrow(/message ID/)
    await expect(bot.decodeMessage({ message_id: 'om_x' } as Lark.Message, undefined)).rejects.toThrow(/message chat/)
  })
})

describe('timestamp helpers', () => {
  it('reads epoch milliseconds sent as a string, and the other shapes the platform uses', () => {
    expect(epochTime('1700000000000', 0)).toBe(1_700_000_000_000)
    expect(epochTime(1_700_000_000, 0)).toBe(1_700_000_000_000)
    expect(epochTime('2026-10-20T12:59:09+08:00', 0)).toBe(Date.parse('2026-10-20T12:59:09+08:00'))
    expect(epochTime(undefined, 7)).toBe(7)
    expect(epochTime('not a time', 7)).toBe(7)
  })
})

describe('decode is independent of the bot instance', () => {
  it('decodes without a mounted adapter', async () => {
    const { bot } = await mount()
    const raw = fixture<LarkRawEvent>('image')
    const direct = await decodeEvent(bot, raw, NOW)
    const throughBot = await bot.decodeEvent(raw)
    // The module function and the hook are the same decode; the hook only supplies the bot clock.
    const a = direct[0]!.event.message!
    const b = throughBot[0]!.event.message!
    expect(a.content).toEqual(b.content)
    expect(toText(a.content)).toBe(toText(b.content))
  })
})
