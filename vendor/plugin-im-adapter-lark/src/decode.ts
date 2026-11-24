/**
 * Inbound decoding of the Lark / Feishu adapter.
 *
 * Every message the platform delivers or answers a read with becomes the same element vocabulary that outgoing content
 * uses — never a flattened string — plus the two inbound-only wrappers `<forward>` and `<raw>`, and it is never empty.
 * What the platform sends per `message_type`:
 *
 * - `text`: `content` is `{"text":"…"}` with the message-scoped mention keys (`@_user_1`, `@_all`) inlined, so the
 *   text is split on those keys and each one becomes `<at type=user id=open_id name>`; everything else stays literal
 *   text. The platform strips style markup from `text`, and the `[label](url)` shape a hyperlink arrives in stays
 *   literal on purpose: inbound text is untrusted, and interpreting it as markup is forbidden.
 * - `post`: paragraphs of nodes → `<p>` with `<b>`/`<i>`/`<u>`/`<s>`/`<a>`/`<at>`/`<code>`/`<img>`/`<video>` inside,
 *   `<pre lang>` for code blocks, `<hr>`, and the post title as the `<title>` envelope element. The event only carries
 *   `content`, where headings, lists, quotes and tables have already been collapsed to text; the query APIs
 *   additionally return `content_v2`, whose `md` nodes keep the original markdown, which is why an `md` node is read
 *   through `fromMarkdown` instead of being flattened again.
 * - `image` / `file` / `audio` / `media`: resource elements whose `src` is the `satori:` URL
 *   (`satori:<platform>/<selfId>/messages/<mid>/resources/<key>?type=…`), so `bot.getResource` downloads them with the
 *   bot's credentials lazily and dsh-im decides whether to fetch. `media` is a video with its poster and duration.
 * - `interactive`: the platform delivers a card as the structure it renders (`title` plus paragraphs of `text`, `a`,
 *   `at`, `img`, `note`, `button` and picker elements) unless the caller read it back with
 *   `card_msg_content_type=user_card_content`, which returns the original card JSON. Both are walked in document order
 *   by {@link walkCard}: every element's text, picker options and hints, a picture's alternative text as an
 *   `[image: alt]` reference, and one `[link]` line per target the card links to. The result stands inside
 *   `<raw type="interactive">` because a card has no direct element equivalent — but it is still real elements, so a
 *   mention inside card text stays an `<at>` and a target becomes an `<a>`.
 * - `merge_forward`: `<forward id>` — an identity reference, because the entries are separate messages. An event
 *   carries none of them, so the element stands alone there; a platform read returns the whole tree with the container
 *   (`upper_message_id`), so a read fills the element with one line per entry, a nested forward included. A picture
 *   inside a forward is addressed through the container, which is the only message that serves its resources.
 * - `sticker`, `share_chat`, `share_user`, `system`, `deleted` and every type with no element: `<raw
 *   platform="lark" type="…">` carrying the payload in `data` and the readable text the platform gave — `[表情]` for a
 *   sticker (the platform never renders its image), `[已撤回]` for a recalled message, the system template as it came.
 *
 * Context that is *not* content: `parent_id` becomes `InboundMessage.quote` with only the id, because dsh-im
 * decides whether the quoted message is worth reading; `thread_id`/`root_id` become `thread`; the mentions become
 * `mentions.{self,all,users}`; and `referrer` is the {@link LarkReferrer} of {@link ./api/events.ts} — the chat, its
 * kind, the message this answer belongs to and the thread, everything `sendPayload` needs to reply instead of create.
 *
 * Dedupe key: `SessionEvent.id` is the platform **message id** for a message (duplicate deliveries reuse `message_id`),
 * the recall's message id for a recall and the event id for a reaction. The outer event id stays available as
 * `referrer.event_id`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/decode
 */

import { toText, type ChatRef, type InboundMessage, type Session, type UserRef } from '@deepseek-ai/cordis-plugin-im-core'
import { fromMarkdown } from '@deepseek-ai/cordis-plugin-im-markdown'
import { h, isBlock, isInline, normalize, type Element } from '@deepseek-ai/satori-element'
import {
  type LarkChatKind, type LarkMessageReceivedEvent, type LarkRawEvent, type LarkReferrer, arrayOf, isDict, nonEmpty,
} from './api/events.ts'
import type { LarkBot } from './bot.ts'
import type { Message } from './types/index.ts'

/**
 * Map the platform's chat-kind vocabulary onto {@link LarkChatKind}.
 *
 * Both `message.chat_type` (`p2p` | `group`) and `chat.chat_mode` (`p2p` | `group` | `topic`) use the same words, so
 * one mapping covers both. An absent or unknown value is a group: it is the permissive reading, and the fallback of
 * the ported client.
 *
 * @param value - `chat_type` of a message event, or `chat_mode` of a chat read.
 * @returns the chat kind.
 */
export function chatKindOf(value: unknown): LarkChatKind {
  return value === 'p2p' ? 'direct' : value === 'topic' ? 'topic' : 'group'
}

// ---------------------------------------------------------------------------------------------------------------
// Events → sessions

/**
 * Decode one event envelope into the sessions to publish.
 *
 * The `card.action.trigger` family never reaches this function: {@link ./ws.ts cardActionSession} answers and
 * publishes it before the intake, because the platform gives the click three seconds.
 *
 * @param bot - the bot the event was received for.
 * @param raw - validated envelope whose body is still the raw wire object.
 * @param now - clock used for `referrer.receivedAt` and as the timestamp fallback; injectable for tests.
 * @returns the sessions of this event, possibly empty. `ws.ts` awaits `bot.receive` for each of them before it
 * acknowledges the frame.
 */
export async function decodeEvent(bot: LarkBot, raw: LarkRawEvent, now = Date.now()): Promise<Session[]> {
  switch (raw.header.event_type) {
    case 'im.message.receive_v1':
      return messageSessions(bot, raw, now)
    case 'im.message.recalled_v1':
      return await recalledSessions(bot, raw, now)
    case 'im.message.reaction.created_v1':
      return reactionSessions(bot, raw, 'reaction-added', now)
    case 'im.message.reaction.deleted_v1':
      return reactionSessions(bot, raw, 'reaction-removed', now)
    default:
      // A family this adapter does not serve (or one `ws.ts` answers itself) publishes nothing.
      return []
  }
}

/**
 * One `im.message.receive_v1` event.
 *
 * @param bot - receiving bot.
 * @param raw - envelope.
 * @param now - decode time.
 * @returns one `message` session, or none when the body carries no message id or no chat.
 */
function messageSessions(bot: LarkBot, raw: LarkRawEvent, now: number): Session[] {
  const event = raw.event as LarkMessageReceivedEvent
  const wire: Record<string, unknown> = isDict(event.message) ? event.message : {}
  const id = nonEmpty(wire.message_id)
  const chatId = nonEmpty(wire.chat_id)
  if (!id || !chatId) return []
  const chatType = chatKindOf(wire.chat_type)
  const chat: ChatRef = { id: chatId, type: chatType }
  const mentions = readMentions(wire.mentions)
  const type = nonEmpty(wire.message_type) ?? 'unknown'
  const time = epochTime(wire.create_time, now)
  const rootId = nonEmpty(wire.root_id)
  const threadId = nonEmpty(wire.thread_id)
  const parentId = nonEmpty(wire.parent_id)
  const referrer: LarkReferrer = { event_id: raw.header.event_id, receivedAt: now, chatType, chatId, messageId: id }
  if (threadId) referrer.threadId = threadId
  if (rootId) referrer.rootId = rootId
  const message: InboundMessage = {
    id,
    chat,
    sender: decodeUser(event.sender),
    content: decodeContent(bot, { messageId: id, type, content: nonEmpty(wire.content) ?? '', mentions }),
    mentions: mentionFlags(mentions, bot),
    time,
    referrer,
    raw: event,
  }
  const thread = threadOf(rootId, threadId)
  if (thread) message.thread = thread
  if (parentId) message.quote = { id: parentId }
  return [bot.session({ type: 'message', id, timestamp: time, message })]
}

/**
 * One `im.message.recalled_v1` event.
 *
 * @param bot - receiving bot.
 * @param raw - envelope.
 * @param now - decode time.
 * @returns one `message-deleted` session, or none when the body carries no message id or no chat.
 */
async function recalledSessions(bot: LarkBot, raw: LarkRawEvent, now: number): Promise<Session[]> {
  const id = nonEmpty(raw.event.message_id)
  const chatId = nonEmpty(raw.event.chat_id)
  if (!id || !chatId) return []
  // A recall names the chat but not its kind, and `MessageRef` carries a `ChatRef`.
  const chat: ChatRef = { id: chatId, type: await bot.chatTypeOf(chatId) }
  const time = epochTime(raw.event.recall_time, now)
  return [bot.session({ type: 'message-deleted', id, timestamp: time, deleted: { id, chat } })]
}

/**
 * One `im.message.reaction.created_v1` / `deleted_v1` event.
 *
 * The platform's reaction payload names the message, the emoji and the operator, and normally carries no chat id:
 * `message.chat` is populated when the payload provides `chat_id` and omitted otherwise so downstream stores can
 * resolve the message by id without fabricating a chat. When `operator_type === 'app'` matches this application, the
 * operator is normalized to `bot.selfId` so consumers can recognize self-reactions cleanly.
 *
 * @param bot - receiving bot.
 * @param raw - envelope.
 * @param type - core event name.
 * @param now - decode time.
 * @returns one reaction session, or none.
 */
function reactionSessions(
  bot: LarkBot,
  raw: LarkRawEvent,
  type: 'reaction-added' | 'reaction-removed',
  now: number,
): Session[] {
  const wire = raw.event
  const messageId = nonEmpty(wire.message_id)
  const emoji = isDict(wire.reaction_type) ? nonEmpty(wire.reaction_type.emoji_type) : undefined
  if (!messageId || !emoji) return []
  const chatId = nonEmpty(wire.chat_id)
  const message: { id: string; chat?: ChatRef } = chatId
    ? { id: messageId, chat: { id: chatId, type: chatKindOf(wire.chat_type) } }
    : { id: messageId }
  const reaction: NonNullable<Session['event']['reaction']> = { message, emoji }
  if (wire.operator_type === 'app') {
    const appId = nonEmpty(wire.app_id)
    const id = appId === bot.config.appId ? (bot.selfId || appId) : appId
    if (id) reaction.user = { id, isBot: true }
  } else {
    const operatorIds = isDict(wire.operator) && isDict(wire.operator.operator_id)
      ? wire.operator.operator_id
      : undefined
    const user = decodeUser({ sender_id: wire.user_id ?? operatorIds })
    if (user.id) reaction.user = user
  }
  const time = epochTime(wire.action_time, now)
  return [bot.session({ type, id: raw.header.event_id, timestamp: time, reaction })]
}

// ---------------------------------------------------------------------------------------------------------------
// Messages read back (getMessage / getMessageList)

/**
 * Decode one message read back from the platform.
 *
 * @param bot - reading bot.
 * @param raw - message as the platform returns it.
 * @param chat - chat the caller authorized, when it already knows it; without it the chat kind is probed once.
 * @param now - clock used as the timestamp fallback and for `referrer.receivedAt`.
 * @param entries - the other items of the same answer, which are a merged forward's contents.
 * @returns the decoded inbound message.
 */
export async function decodeMessage(
  bot: LarkBot,
  raw: Message,
  chat?: ChatRef,
  now = Date.now(),
  entries?: readonly Message[],
): Promise<InboundMessage> {
  const id = nonEmpty(raw.message_id)
  if (!id) throw new TypeError('Invalid Lark message ID')
  const chatId = chat?.id ?? nonEmpty(raw.chat_id)
  if (!chatId) throw new TypeError('Invalid Lark message chat')
  const resolved: ChatRef = chat ?? { id: chatId, type: await bot.chatTypeOf(chatId) }
  const type = nonEmpty(raw.msg_type) ?? 'unknown'
  const mentions = readMentions(raw.mentions)
  const time = epochTime(raw.create_time, now)
  const rootId = nonEmpty(raw.root_id)
  const threadId = nonEmpty(raw.thread_id)
  const parentId = nonEmpty(raw.parent_id)
  const referrer: LarkReferrer = { receivedAt: now, chatType: resolved.type, chatId: resolved.id, messageId: id }
  if (threadId) referrer.threadId = threadId
  if (rootId) referrer.rootId = rootId
  const message: InboundMessage = {
    id,
    chat: resolved,
    // A message the platform reports as `anonymous` carries no id; it is kept with an empty one.
    sender: decodeUser(raw.sender),
    content: decodeContent(bot, {
      messageId: id,
      // The platform clears the content of a recalled message, so the read's own flag is the evidence.
      type: raw.deleted ? 'deleted' : type,
      content: nonEmpty(raw.body?.content) ?? '',
      mentions,
      ...entries === undefined ? {} : { entries },
    }),
    mentions: mentionFlags(mentions, bot),
    time,
    referrer,
    raw,
  }
  const thread = threadOf(rootId, threadId)
  if (thread) message.thread = thread
  if (parentId) message.quote = { id: parentId }
  return message
}

// ---------------------------------------------------------------------------------------------------------------
// Content

/** One mention as the wire carries it, narrowed. */
export interface WireMention {
  /** Message-scoped key the text uses for this mention (`@_user_1`). */
  key?: string
  /** `open_id` (or `user_id`/`union_id`) of the user or app mentioned. */
  id?: string
  /** Display name the platform gives the mentioned user. */
  name?: string
  /** `@all` instead of one user. */
  all: boolean
}

/** Everything one message body needs to be decoded. */
export interface ContentInput {
  /** Message the body belongs to; the `satori:` resource URL is authorized by it. */
  messageId: string
  /** `message_type` / `msg_type` of the message. */
  type: string
  /** Raw `content`: JSON for every type except `merge_forward`, which sends its rendered title. */
  content: string
  /** The message's mentions, which give a mention key its identity. */
  mentions: WireMention[]
  /**
   * The other messages the same platform answer carried. A merged forward's entries are separate messages returned
   * with the container, each naming it in `upper_message_id`; an event carries none of them.
   */
  entries?: readonly Message[]
}

/**
 * Build the normalized `<message>` of one body, never empty.
 *
 * @param bot - adapter instance (its resource URLs).
 * @param input - the message body.
 * @returns the normalized tree.
 */
function decodeContent(bot: LarkBot, input: ContentInput): Element<'message'> {
  const content = normalize(contentNodes(bot, input))
  if (content.children.length) return content
  // Never empty: a body the vocabulary cannot express keeps its payload in `data` and says what it was.
  return normalize(rawElement(input, parseBody(input.content)))
}

/**
 * The element nodes of one body, in document order.
 *
 * @param bot - adapter instance.
 * @param input - the message body.
 * @returns the nodes; possibly empty when the body carries nothing to show.
 */
function contentNodes(bot: LarkBot, input: ContentInput): Element[] {
  switch (input.type) {
    case 'text':
      return textNodes(input)
    case 'post':
      return postNodes(bot, input)
    case 'image':
    case 'file':
    case 'audio':
    case 'media':
      return mediaNodes(bot, input)
    case 'interactive':
      return interactiveNodes(bot, input)
    case 'merge_forward':
      return [forwardNode(bot, input)]
    default:
      return [rawElement(input, parseBody(input.content))]
  }
}

/**
 * A merged forward: the container's identity, then one line per entry the read carried, nested forwards included.
 *
 * An event carries no entry, so the element stands as the reference alone and dsh-im shows a placeholder. A platform
 * read answers with the whole tree: the container, its entries, and — for a forward of a forward — the entries of the
 * inner container as well, every message naming its parent in `upper_message_id` and appearing once per place it sits.
 * The tree is therefore read in the platform's own order, and a nested container becomes a `[合并转发 #id]` line of its
 * own with the entries that follow it indented under it.
 *
 * The media of an entry is addressed by the container, never by the entry own id: the platform serves
 * `/messages/{id}/resources/{key}` for the message the read authorized and answers `No such file in message` for an
 * entry id, so a picture inside a forward is readable only through the container.
 *
 * @param bot - adapter instance.
 * @param input - the container's body, with the entries the read returned.
 * @returns the `<forward>` element.
 */
function forwardNode(bot: LarkBot, input: ContentInput): Element<'forward'> {
  const children: Element[] = []
  /** Depth of the last entry carrying each message id, so an entry lands under the instance of its parent before it. */
  const depthOf = new Map<string, number>()
  let first = true
  for (const entry of input.entries ?? []) {
    const parent = entry.upper_message_id
    // The container of the read names no parent; a message naming a parent this answer never carried belongs nowhere.
    if (parent === undefined) continue
    const id = nonEmpty(entry.message_id)
    const depth = (depthOf.get(parent) ?? 0) + 1
    if (id) depthOf.set(id, depth)
    if (!first) children.push(h('br'))
    first = false
    const indent = '  '.repeat(Math.min(depth - 1, FORWARD_INDENT_LIMIT))
    const type = nonEmpty(entry.msg_type) ?? 'unknown'
    if (type === 'merge_forward') {
      children.push(h.text(`${indent}[合并转发 #${id ?? ''}]`))
      continue
    }
    const sender = decodeUser(entry.sender)
    children.push(h.text(`${indent}${sender.name?.trim() || sender.id}: `))
    children.push(...phrasingOf(decodeContent(bot, {
      messageId: input.messageId,
      type,
      content: nonEmpty(entry.body?.content) ?? '',
      mentions: readMentions(entry.mentions),
    })))
  }
  return h('forward', { id: input.messageId }, ...children)
}

/**
 * The inline nodes of one decoded body: a forward holds phrasing only, so a paragraph contributes its own children and
 * a block it cannot hold inline (a quote, a table, preformatted text) contributes its text.
 *
 * @param content - the decoded body of one entry.
 * @returns the nodes to place inside `<forward>`.
 */
function phrasingOf(content: Element<'message'>): Element[] {
  const nodes: Element[] = []
  for (const child of content.children) {
    if (child.type === 'p') nodes.push(...child.children)
    else if (isBlock(child.type)) nodes.push(h.text(toText(child)))
    else nodes.push(child)
  }
  return nodes
}

/**
 * `text`: the platform inlines mention keys into the text and strips every style, so this is text plus `<at>`.
 *
 * @param input - the message body.
 * @returns the inline nodes.
 */
function textNodes(input: ContentInput): Element[] {
  const body = parseBody(input.content)
  // Content the platform delivers as text instead of JSON still is the message text.
  if (!body) return tokenizeMentions(input.content, input.mentions)
  const text = typeof body.text === 'string' ? body.text : ''
  return tokenizeMentions(text, input.mentions)
}

/** One unwrapped post body: its title and its paragraphs of nodes. */
interface PostBody {
  title?: string
  paragraphs: unknown[]
}

/**
 * Read a post body, whichever wrapper it uses.
 *
 * A message the platform sends carries `{"title","content"}`; the read APIs may wrap it per locale (`zh_cn`, `en_us`,
 * …) and add `content_v2`, whose `md` nodes still hold the original markdown.
 *
 * @param source - raw `content`.
 * @returns the unwrapped body, or `undefined` when it is not a post body.
 */
function parsePost(source: string): PostBody | undefined {
  const body = parseBody(source)
  if (!body) return
  const own = Array.isArray(body.content) || Array.isArray(body.content_v2) ? body : undefined
  const locale = own ?? [body.zh_cn, body.en_us, body.ja_jp, ...Object.values(body)]
    .find((value): value is Record<string, unknown> => isDict(value))
  if (!locale) return
  const paragraphs = Array.isArray(locale.content_v2) ? locale.content_v2
    : Array.isArray(locale.content) ? locale.content
      : []
  const title = nonEmpty(locale.title)
  return title ? { title, paragraphs } : { paragraphs }
}

/**
 * `post`: the title as `<title>`, then one `<p>` per paragraph.
 *
 * @param bot - adapter instance.
 * @param input - the message body.
 * @returns the nodes.
 */
function postNodes(bot: LarkBot, input: ContentInput): Element[] {
  const post = parsePost(input.content)
  // A body without the post structure is still the message text the platform sent.
  if (!post) return tokenizeMentions(input.content, input.mentions)
  const nodes: Element[] = []
  if (post.title) nodes.push(h('title', post.title))
  for (const paragraph of post.paragraphs) {
    if (!Array.isArray(paragraph)) continue
    // A paragraph is one phrasing run; an `md` node that holds block markdown interrupts it (a heading is a block).
    let run: Element[] = []
    const flush = () => {
      if (!run.length) return
      nodes.push(h('p', ...run))
      run = []
    }
    for (const value of paragraph) {
      if (!isDict(value)) continue
      const tag = nonEmpty(value.tag) ?? 'text'
      if (tag === 'md') {
        const parsed = fromMarkdown(typeof value.text === 'string' ? value.text : '')
        const inline = parsed.length === 1 && parsed[0]!.type === 'p' ? parsed[0]!.children : undefined
        if (inline && inline.every(node => isInline(node.type))) run.push(...inline)
        else {
          flush()
          nodes.push(...parsed)
        }
        continue
      }
      const element = postNode(bot, input, tag, value)
      // A block node (pre, hr) interrupts the paragraph; the rest is phrasing content of it.
      if (element.some(node => isBlock(node.type))) {
        flush()
        nodes.push(...element)
      } else {
        run.push(...element)
      }
    }
    flush()
  }
  return nodes
}

/**
 * One node of a post paragraph (`p`/`b`/`i`/`u`/`s`/`a`/`at`/`img`/`pre`/`hr`, media as `video`).
 *
 * @param bot - adapter instance.
 * @param input - the message body (resource URL context).
 * @param tag - node tag.
 * @param node - node payload.
 * @returns the inline nodes of this node; empty for a node without a target.
 */
function postNode(bot: LarkBot, input: ContentInput, tag: string, node: Record<string, unknown>): Element[] {
  switch (tag) {
    case 'text':
      return tokenizeMentions(typeof node.text === 'string' ? node.text : '', input.mentions)
    case 'a': {
      const children = tokenizeMentions(typeof node.text === 'string' ? node.text : '', input.mentions)
      const href = nonEmpty(node.href)
      // A link without a target is its text: the vocabulary requires `href`.
      return href ? [h('a', { href }, ...children)] : children
    }
    case 'at': {
      const element = postAtElement(node, input.mentions)
      return element ? [element] : []
    }
    case 'code_block':
      return [h('pre', nonEmpty(node.language) ? { lang: nonEmpty(node.language) } : {}, typeof node.text === 'string' ? node.text : '')]
    case 'hr':
      return [h('hr')]
    case 'img': {
      const key = nonEmpty(node.image_key)
      return key ? [h('img', { src: bot.getResourceUrl(input.messageId, key, 'image') })] : []
    }
    case 'media': {
      const key = nonEmpty(node.file_key)
      if (!key) return []
      const poster = nonEmpty(node.image_key)
      const duration = durationOf(node.duration)
      return [h('video', {
        src: bot.getResourceUrl(input.messageId, key, 'file'),
        ...poster ? { poster: bot.getResourceUrl(input.messageId, poster, 'image') } : {},
        ...duration !== undefined ? { duration } : {},
      })]
    }
    case 'emotion': {
      // Post emotions are unicode characters, and the vocabulary's `emoji` is a keyed (T2) element; the character
      // itself is the lossless reading.
      const character = nonEmpty(node.emoji_type)
      return character ? [h.text(character)] : []
    }
    default:
      // An unknown node keeps the text the platform put in it, so nothing readable is lost.
      return tokenizeMentions(typeof node.text === 'string' ? node.text : '', input.mentions)
  }
}

/**
 * `image` / `file` / `audio` / `media`: one resource element whose `src` is the internal `satori:` URL.
 *
 * @param bot - adapter instance.
 * @param input - the message body.
 * @returns the node.
 */
function mediaNodes(bot: LarkBot, input: ContentInput): Element[] {
  const body = parseBody(input.content)
  if (!body) return [rawElement(input, undefined)]
  const name = nonEmpty(body.file_name)
  switch (input.type) {
    case 'image': {
      const key = nonEmpty(body.image_key)
      return key ? [h('img', { src: bot.getResourceUrl(input.messageId, key, 'image') })] : []
    }
    case 'file': {
      const key = nonEmpty(body.file_key)
      return key ? [h('file', {
        src: bot.getResourceUrl(input.messageId, key, 'file'),
        ...name ? { name } : {},
      })] : []
    }
    case 'audio': {
      const key = nonEmpty(body.file_key)
      if (!key) return []
      const duration = durationOf(body.duration)
      return [h('audio', {
        src: bot.getResourceUrl(input.messageId, key, 'file'),
        ...name ? { name } : {},
        ...duration !== undefined ? { duration } : {},
      })]
    }
    default: {
      // `media` is the video kind: the file is the video, `image_key` its poster.
      const key = nonEmpty(body.file_key)
      if (!key) return []
      const poster = nonEmpty(body.image_key)
      const duration = durationOf(body.duration)
      return [h('video', {
        src: bot.getResourceUrl(input.messageId, key, 'file'),
        ...name ? { name } : {},
        ...poster ? { poster: bot.getResourceUrl(input.messageId, poster, 'image') } : {},
        ...duration !== undefined ? { duration } : {},
      })]
    }
  }
}

/** Card element tags whose `content` holds text the platform renders. */
const CARD_CONTENT_TAGS = new Set(['plain_text', 'lark_md', 'markdown'])
/** Card element tags whose `text` holds text the platform renders. */
const CARD_LABEL_TAGS = new Set(['text', 'plain_text', 'lark_md', 'markdown', 'fallback_text', 'button', 'a', 'link'])
/** Card element fields carrying a title the platform renders as a plain string. */
const CARD_TITLE_FIELDS = ['title', 'subtitle'] as const
/** Card element fields carrying a target the card links to. */
const CARD_LINK_FIELDS = ['href', 'url', 'default_url'] as const
/** Deepest indentation a forward of a forward adds, after which nesting stops moving the text right. */
const FORWARD_INDENT_LIMIT = 3

/**
 * Text, targets and mention names collected from one card in document order.
 *
 * A received card is delivered as the structure it renders, but a read with `user_card_content` returns the original
 * card JSON; both carry the same tags and fields, which is why one walk reads both (the port of `projection.ts`).
 */
interface CardWalk {
  /** One entry per piece of text the card shows, in document order. */
  lines: string[]
  /** Every target the card links to. */
  links: string[]
  /** Every picture the card shows, by the `image_key` the platform downloads it with. */
  images: { key: string; alt?: string }[]
  /** Display name the platform gives each mention key the message resolves. */
  names: Map<string, string>
}

/**
 * The label a card element shows: either a plain string or a `{ content }` / `{ text }` object.
 *
 * @param value - the field value.
 * @returns the text, or `undefined`.
 */
function cardLabel(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined
  const node = isDict(value) ? value : undefined
  if (!node) return
  return nonEmpty(node.content) ?? nonEmpty(node.text)
}

/**
 * Walk one card in document order and collect what it shows.
 *
 * @param value - card element, or an array of them.
 * @param walk - collector.
 */
function walkCard(value: unknown, walk: CardWalk): void {
  if (Array.isArray(value)) {
    for (const item of value) walkCard(item, walk)
    return
  }
  const element = isDict(value) ? value : undefined
  if (!element) return
  const tag = nonEmpty(element.tag)
  if (tag === 'img' || tag === 'image') {
    const alt = cardLabel(element.alt)
    walk.lines.push(alt ? `[image: ${alt}]` : '[image]')
    const key = nonEmpty(element.image_key)
    if (key) walk.images.push(alt === undefined ? { key } : { key, alt })
  } else if (tag === 'at') {
    // A delivered `at` element names its user by the message-scoped key it was authored with.
    const key = typeof element.user_id === 'string' ? element.user_id : ''
    const name = nonEmpty(element.user_name) ?? walk.names.get(key)
    if (name) walk.lines.push(`@${name}`)
  } else if (tag !== undefined && CARD_CONTENT_TAGS.has(tag) && typeof element.content === 'string') {
    walk.lines.push(element.content)
  } else if (tag !== undefined && CARD_LABEL_TAGS.has(tag) && typeof element.text === 'string') {
    walk.lines.push(element.text)
  }
  for (const field of CARD_TITLE_FIELDS) {
    const title = nonEmpty(element[field])
    if (title) walk.lines.push(title)
  }
  // A dropdown or overflow element delivers the labels it offers as plain strings.
  if (Array.isArray(element.options)) {
    for (const option of element.options) if (typeof option === 'string' && option) walk.lines.push(option)
  }
  // A field the card does not fill in names what it asks for in its hint.
  const placeholder = nonEmpty(element.placeholder)
  if (placeholder) walk.lines.push(placeholder)
  for (const field of CARD_LINK_FIELDS) {
    const link = nonEmpty(element[field])
    if (link) walk.links.push(link)
  }
  for (const [key, child] of Object.entries(element)) {
    // A picture's alternative text is part of its own reference.
    if (key === 'alt' && (tag === 'img' || tag === 'image')) continue
    walkCard(child, walk)
  }
}

/**
 * `interactive`: the card's text, pictures and links as `<raw type="interactive">` children.
 *
 * @param bot - adapter instance, which authorizes a picture's `satori:` URL.
 * @param input - the message body.
 * @returns the node.
 */
function interactiveNodes(bot: LarkBot, input: ContentInput): Element[] {
  const card = parseBody(input.content)
  // Content the platform did not send as JSON carries no structure to walk; it is still the card's own text.
  if (!card) return [rawElement(input, undefined, input.content ? [h.text(input.content)] : [])]
  const names = new Map<string, string>()
  for (const mention of input.mentions) {
    if (mention.key && !mention.all) names.set(mention.key, mention.name ?? mention.id ?? mention.key)
  }
  const walk: CardWalk = { lines: [], links: [], images: [], names }
  walkCard(card, walk)
  const children: Element[] = []
  const pushLine = (nodes: Element[]) => {
    if (!nodes.length) return
    if (children.length) children.push(h('br'))
    children.push(...nodes)
  }
  for (const line of walk.lines) {
    const text = line.trim()
    if (text) pushLine(tokenizeMentions(text, input.mentions))
  }
  for (const link of new Set(walk.links)) {
    pushLine([h.text('[link] '), h('a', { href: link }, link)])
  }
  // A picture the card shows stays a media element, so a reader can fetch it with the bot's credentials.
  for (const image of walk.images) {
    const src = bot.getCardImageUrl(image.key)
    pushLine([image.alt === undefined ? h('img', { src }) : h('img', { src, alt: image.alt })])
  }
  if (!children.length) children.push(h.text('[卡片消息]'))
  return [h('raw', { platform: 'lark', type: 'interactive', data: card }, ...children)]
}

/** Readable label of a message kind with no element (`[位置]`, `[投票]` …). */
const MESSAGE_LABELS: Readonly<Record<string, string>> = {
  sticker: '[表情]',
  share_chat: '[群名片]',
  share_user: '[个人名片]',
  system: '[系统消息]',
  deleted: '[消息已撤回]',
  location: '[位置]',
  todo: '[任务]',
  vote: '[投票]',
  hongbao: '[红包]',
  video_chat: '[视频通话]',
  share_calendar_event: '[日程]',
  calendar: '[日程]',
  general_calendar: '[日程]',
  folder: '[文件夹]',
  text: '[空消息]',
}

/**
 * The readable text of a kind with no element: the field the platform fills in, else its label.
 *
 * @param type - `message_type` / `msg_type`.
 * @param body - parsed content, when it was JSON.
 * @returns the text.
 */
function readableText(type: string, body: Record<string, unknown> | undefined): string {
  if (body) {
    for (const field of ['text', 'template', 'title', 'name', 'file_name', 'content'] as const) {
      const value = body[field]
      const text = nonEmpty(value) ?? (typeof value === 'number' ? String(value) : undefined)
      if (text) return text
    }
  }
  return MESSAGE_LABELS[type] ?? `[${type}]`
}

/**
 * The `<raw>` wrapper of a kind with no element: the payload stays in `data` and the readable text the platform gave
 * becomes the children.
 *
 * @param input - the message body.
 * @param body - parsed content, when it was JSON.
 * @param children - explicit children (the degenerate-card fallback passes its text).
 * @returns the node.
 */
function rawElement(input: ContentInput, body: Record<string, unknown> | undefined, children?: Element[]): Element {
  return h(
    'raw',
    { platform: 'lark', type: input.type, ...body ? { data: body } : {} },
    ...children ?? [h.text(readableText(input.type, body))],
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Mentions

/**
 * Read the mentions of a message body, from either wire shape.
 *
 * An event carries `{ key, id: { open_id, user_id, union_id }, name }`; a message read carries
 * `{ key, id, id_type, name }` with the id as a plain string.
 *
 * @param value - the `mentions` array.
 * @returns one narrowed record per mention.
 */
function readMentions(value: unknown): WireMention[] {
  const mentions: WireMention[] = []
  for (const item of arrayOf(value)) {
    if (!isDict(item)) continue
    const key = nonEmpty(item.key)
    const wireId = item.id
    const id = nonEmpty(wireId)
      ?? (isDict(wireId) ? nonEmpty(wireId.open_id) ?? nonEmpty(wireId.user_id) ?? nonEmpty(wireId.union_id) : undefined)
    const name = nonEmpty(item.name)
    // `@all` names nobody: the platform either says so or sends the key without an identity.
    const all = key === '@_all' || item.mentioned_type === 'all'
    const mention: WireMention = { all }
    if (key) mention.key = key
    if (id) mention.id = id
    if (name) mention.name = name
    mentions.push(mention)
  }
  return mentions
}

/**
 * The `<at>` element of a post's `at` node.
 *
 * @param node - the node.
 * @param mentions - the message's mentions, which resolve a message-scoped key.
 * @returns the element, or `undefined` when nothing identifies the user.
 */
function postAtElement(node: Record<string, unknown>, mentions: WireMention[]): Element | undefined {
  const key = nonEmpty(node.user_id)
  const name = nonEmpty(node.user_name)
  const mention = key ? mentions.find(item => item.key === key) : undefined
  if (mention) return atOf(mention)
  if (key === '@_all' || node.user_id === '@_all') return h('at', { type: 'all', ...name ? { name } : {} })
  // `user_id` may already be an identity rather than a message-scoped key.
  if (key && !key.startsWith('@')) return h('at', { type: 'user', id: key, ...name ? { name } : {} })
  return undefined
}

/**
 * The `<at>` element of one narrowed mention.
 *
 * @param mention - narrowed mention.
 * @returns the element, or `undefined` when no identity is known.
 */
function atOf(mention: WireMention): Element | undefined {
  const name = mention.name
  if (mention.all) return h('at', { type: 'all', ...name ? { name } : {} })
  if (!mention.id) return undefined
  return h('at', { type: 'user', id: mention.id, ...name ? { name } : {} })
}

/**
 * Split platform text on the mention keys the message resolves (`text` → `text`/`at`).
 *
 * @param source - text of the body.
 * @param mentions - the message's mentions.
 * @returns the inline nodes; a mention without an identity keeps its placeholder as text.
 */
function tokenizeMentions(source: string, mentions: WireMention[]): Element[] {
  const keys = mentions
    .filter((mention): mention is WireMention & { key: string } => !!mention.key)
    .sort((a, b) => b.key.length - a.key.length)
  if (!keys.length) return source ? [h.text(source)] : []
  const pattern = new RegExp(keys.map(mention => escapeRegExp(mention.key)).join('|'), 'g')
  const nodes: Element[] = []
  let last = 0
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0
    const mention = keys.find(item => item.key === match[0])!
    if (index > last) nodes.push(h.text(source.slice(last, index)))
    nodes.push(atOf(mention) ?? h.text(match[0]))
    last = index + match[0].length
  }
  if (last < source.length) nodes.push(h.text(source.slice(last)))
  return nodes
}

/** Escape one literal string for a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The mention flags (`self`, `all`, `users`).
 *
 * @param mentions - the message's mentions.
 * @param bot - receiving bot (`selfId` is the open id the handshake learned).
 * @returns the flags.
 */
function mentionFlags(mentions: WireMention[], bot: LarkBot): InboundMessage['mentions'] {
  const users: UserRef[] = []
  let self = false
  let all = false
  for (const mention of mentions) {
    if (mention.all) {
      all = true
      continue
    }
    if (!mention.id) continue
    if (bot.selfId && mention.id === bot.selfId) self = true
    const user: UserRef = { id: mention.id }
    if (mention.name) user.name = mention.name
    users.push(user)
  }
  return { self, all, users }
}

// ---------------------------------------------------------------------------------------------------------------
// Wire helpers

/**
 * The sender of a message as a {@link UserRef}.
 *
 * A message the platform reports as `anonymous` or `unknown` carries no id; it keeps an empty one instead of losing
 * the message.
 *
 * @param sender - `sender` of an event, or `sender` of a read message.
 * @returns the sender.
 */
function decodeUser(sender: unknown): UserRef {
  const wire = isDict(sender) ? sender : {}
  const ids = isDict(wire.sender_id) ? wire.sender_id : wire
  const user: UserRef = { id: nonEmpty(ids.open_id) ?? nonEmpty(ids.id) ?? nonEmpty(ids.user_id) ?? '' }
  const type = nonEmpty(wire.sender_type)
  if (type === 'app' || type === 'bot') user.isBot = true
  return user
}

/**
 * `thread` of a message: the thread container, and its root when the event names one.
 *
 * @param rootId - `root_id` of the message.
 * @param threadId - `thread_id` of the message.
 * @returns the thread, or `undefined` when the message is not threaded.
 */
function threadOf(rootId: string | undefined, threadId: string | undefined): InboundMessage['thread'] | undefined {
  const id = threadId ?? rootId
  if (!id) return
  return rootId ? { id, root: rootId } : { id }
}

/**
 * A platform timestamp in epoch milliseconds.
 *
 * Message times are epoch **milliseconds as a string** (`create_time: "1699999999000"`), and the recall and reaction
 * payloads use the same unit; an RFC3339 value and epoch seconds are accepted as well. Anything unparseable falls back
 * to the decode time, so a message never loses its place in the stream.
 *
 * @param value - wire value.
 * @param fallback - used when the value is missing or unparseable.
 * @returns epoch milliseconds.
 */
export function epochTime(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value
  if (typeof value !== 'string' || !value.trim()) return fallback
  const text = value.trim()
  if (/^\d+$/.test(text)) {
    const numeric = Number(text)
    return numeric < 1e11 ? numeric * 1000 : numeric
  }
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : fallback
}

/**
 * A media duration in milliseconds, when the platform sent one.
 *
 * @param value - `duration` of a body (a number, or a numeric string).
 * @returns the duration, or `undefined`.
 */
function durationOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    const numeric = Number(value)
    if (numeric > 0) return numeric
  }
}

/**
 * Parse a message body's JSON.
 *
 * @param content - raw `content`.
 * @returns the object, or `undefined` when the body is absent or is not a JSON object.
 */
function parseBody(content: string): Record<string, unknown> | undefined {
  if (!content) return
  try {
    const value: unknown = JSON.parse(content)
    return isDict(value) ? value : undefined
  } catch {
    // `merge_forward` and a few degraded cards send plain text; the caller reads it as text.
    return
  }
}
