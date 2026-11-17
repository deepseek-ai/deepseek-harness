/**
 * Inbound decoding of the QQ official bot: every gateway dispatch becomes the same element vocabulary as outgoing
 * content, never flat text, and every message keeps the context a passive reply needs.
 *
 * Event families:
 * - `GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE` → one `message` session each. `content` is tokenized into
 * `text` / `at` (`<@openid>`, `<@!openid>`, `<qqbot-at-user id>`, `<qqbot-at-everyone/>`), `attachments` become
 * `img` / `audio` / `video` / `file` elements with their platform URL as `src`, `ark_data` becomes
 * `<raw platform="qq" type="ark">` because a structured card is a platform-only kind, 聊天记录
 * (`msg_elements[].message_type = 102`) becomes
 * `<forward id>`, and a reply (`message_scene.ext.ref_msg_idx` plus the `message_type = 103` element) becomes
 * `InboundMessage.quote`. Content is never empty: an event the vocabulary cannot express is kept as
 * `<raw platform="qq" type="empty">[空消息]</raw>`.
 * - `GROUP_MESSAGE_CREATE` — every group message once 接收所有消息 is switched on — decodes identically, except that
 * the body keeps the `<@…>` mention and only a body that mentions the bot is `mentions.self`.
 * - `INTERACTION_CREATE` type `11` → one `interaction/button` session, acknowledged before it is published (the QQ
 * client spins until the platform sees `PUT /interactions/{id}`). Type `12` (快捷菜单) is acknowledged too but
 * publishes no session, and every other interaction type (feedback, clear-session, authorizations …) needs no
 * acknowledgement at all.
 * - `GROUP_ADD_ROBOT` / `GROUP_DEL_ROBOT` / `FRIEND_ADD` / `FRIEND_DEL` → one `internal` session
 * (`qq/group-added`, `qq/group-removed`, `qq/friend-added`, `qq/friend-removed`) so observers see the chat
 * lifecycle without a protocol event the core does not own.
 * - Anything else (including `READY` / `RESUMED`, which belong to the gateway itself) decodes to no session.
 *
 * ## Referrer contract
 *
 * `InboundMessage.referrer` and `ButtonEvent.referrer` are a {@link QQReferrer}: the passive-reply key plus
 * everything the passive manager needs to book the window without re-reading the event. {@link readQQReferrer} is
 * the narrowing guard for a `Target.referrer: unknown`; the key of a passive reply is `msg_id` for messages and
 * `event_id` for button clicks, `chatType` selects the group/C2C window and budget, and `receivedAt` is the moment
 * this process saw the event (the platform timestamp is `InboundMessage.time` / `ButtonEvent.time`).
 *
 * ## Dedupe key
 *
 * `SessionEvent.id` is the intake dedupe key. Message sessions use the platform **message id**
 * (`ROBOT1.0_…`), because both message events are documented to push the same `msg_id` more than once, so a
 * redelivery must not be processed twice; the outer dispatch id (the QQ `event_id`) is preserved as
 * `referrer.event_id`. Button sessions use the interaction id, which is unique per click and is also the id the
 * acknowledgement route takes.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/decode
 */

import { h, normalize, type ButtonEvent, type Element } from '@deepseek-ai/satori-element'
import type { ChatRef, InboundMessage, Session, UserRef } from '@deepseek-ai/cordis-plugin-im-core'
import { chatId, type ChatKind } from './api.ts'
import type { GatewayDispatch, QQBot } from './bot.ts'

/** A decoded JSON object of an event body. */
type Dict = Record<string, unknown>

// ---------------------------------------------------------------------------------------------------------------
// Public shapes

/**
 * Passive-reply context of one inbound event.
 *
 * `chatId` is the self-describing `ChatRef.id` (`group:<openid>` / `user:<openid>`,) and doubles as the key the
 * passive manager books the window under; `chatType` is the same value as `ChatRef.type`, so `'group'` selects the
 * 5-minute / 5-reply window and `'direct'` the 60-minute / 4-reply one.
 */
export interface QQReferrer {
  /** QQ `msg_id` of the inbound message (`ROBOT1.0_…`): the passive key of a message reply. Absent on clicks. */
  msg_id?: string
  /** Outer dispatch id (the QQ `event_id`): the passive key of a button click. Absent when the frame had none. */
  event_id?: string
  /** When this process decoded the event (ms). The platform time is `InboundMessage.time` / `ButtonEvent.time`. */
  receivedAt: number
  /** Chat kind, mirroring `ChatRef.type`: `group` = 群聊, `direct` = 单聊. */
  chatType: 'group' | 'direct'
  /** `ChatRef.id` of the chat (`group:<group_openid>` / `user:<user_openid>`). */
  chatId: string
  /** The platform message that carried the clicked button (`INTERACTION_CREATE` only). */
  messageId?: string
}

/**
 * Narrow an adapter-private `Target.referrer` back to a {@link QQReferrer}.
 *
 * @param value - anything a caller received as `referrer` (normally `unknown`).
 * @returns the referrer, or `undefined` when it is not one of ours.
 */
export function readQQReferrer(value: unknown): QQReferrer | undefined {
  if (!isDict(value)) return
  const receivedAt = typeof value.receivedAt === 'number' ? value.receivedAt : undefined
  const chatType = value.chatType === 'group' || value.chatType === 'direct' ? value.chatType : undefined
  const chatId = nonEmpty(value.chatId)
  if (receivedAt === undefined || chatType === undefined || chatId === undefined) return
  const referrer: QQReferrer = { receivedAt, chatType, chatId }
  const msgId = nonEmpty(value.msg_id)
  if (msgId) referrer.msg_id = msgId
  const eventId = nonEmpty(value.event_id)
  if (eventId) referrer.event_id = eventId
  const messageId = nonEmpty(value.messageId)
  if (messageId) referrer.messageId = messageId
  return referrer
}

/**
 * The passive-reply key of a referrer: `msg_id` for a message trigger, `event_id` for a click.
 *
 * @param referrer - a decoded {@link QQReferrer}.
 * @returns the platform id the next message is sent against, or `undefined` when neither exists.
 */
export function passiveKey(referrer: QQReferrer): string | undefined {
  return referrer.msg_id ?? referrer.event_id
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point

/**
 * Decode one gateway dispatch.
 *
 * @param bot - the bot the event was received for.
 * @param frame - dispatch payload (`op: 0`).
 * @param now - clock used for `referrer.receivedAt` and as the timestamp fallback; injectable for tests.
 * @returns the sessions to publish, possibly empty. Never throws: a frame this decoder does not understand is no
 * event. The gateway client awaits `bot.receive(session)` for each session before it handles the next frame.
 */
export async function decodeDispatch(bot: QQBot, frame: GatewayDispatch, now = Date.now()): Promise<Session[]> {
  switch (frame.t) {
    case 'GROUP_AT_MESSAGE_CREATE':
      return messageSession(bot, frame, 'group', now, false)
    // A bot with "接收所有消息" switched on receives every group message as `GROUP_MESSAGE_CREATE` instead, and the
    // body keeps the `<@…>` mention instead of stripping it. Only the messages that actually mention the bot are
    // addressed, so the mention has to be recognized rather than assumed.
    case 'GROUP_MESSAGE_CREATE':
      return await fullGroupSession(bot, frame, now)
    case 'C2C_MESSAGE_CREATE':
      return messageSession(bot, frame, 'direct', now, false)
    case 'INTERACTION_CREATE':
      return await interactionSessions(bot, frame, now)
    default:
      return lifecycleSessions(bot, frame, now)
  }
}

/**
 * One `GROUP_MESSAGE_CREATE` (full-mode group message).
 *
 * The body names a mentioned user by openid, and the platform's `mentions` array excludes the bot itself, so the
 * bot's own `union_openid` is the only way to tell an addressed message from background chatter. A failed identity
 * read is reported and the message is decoded as unaddressed: an answer to a message that did not address the bot is
 * worse than a missed one.
 *
 * @param bot - receiving bot.
 * @param frame - dispatch.
 * @param now - decode time.
 * @returns one session, or none when the body has no message id or no chat.
 */
async function fullGroupSession(bot: QQBot, frame: GatewayDispatch, now: number): Promise<Session[]> {
  try {
    await bot.ensureIdentity()
  } catch (error) {
    bot.ctx.logger.warn('qq: reading the bot identity failed, so a group message cannot be matched to it: %s', error)
  }
  return messageSession(bot, frame, 'group', now, true)
}


// ---------------------------------------------------------------------------------------------------------------
// Messages

/**
 * One `GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE` event.
 *
 * @param bot - receiving bot.
 * @param frame - dispatch.
 * @param chatType - `group` for the 群聊 event, `direct` for the 单聊 one.
 * @param now - decode time.
 * @param fullMode - the body is a `GROUP_MESSAGE_CREATE`, which also carries messages that do not address the bot.
 * @returns one session, or none when the body has no message id or no chat.
 */
function messageSession(
  bot: QQBot, frame: GatewayDispatch, chatType: 'group' | 'direct', now: number, fullMode: boolean,
): Session[] {
  const payload = isDict(frame.d) ? frame.d : undefined
  if (!payload) return []
  const id = nonEmpty(payload.id)
  const chat = chatType === 'group' ? groupChatOf(payload) : directChatOf(payload)
  if (!id || !chat) return []
  const decoded = decodeContent(payload, [bot.selfId, bot.unionOpenid])
  const time = decodeTimestamp(payload.timestamp, now)
  const referrer: QQReferrer = { msg_id: id, receivedAt: now, chatType, chatId: chat.id }
  const eventId = nonEmpty(frame.id)
  if (eventId) referrer.event_id = eventId

  const scene = isDict(payload.message_scene) ? parseSceneExt(payload.message_scene.ext) : {}
  const msgIdx = nonEmpty(scene.msg_idx)
  const message: InboundMessage = {
    id,
    ...msgIdx && msgIdx !== id ? { aliases: [msgIdx] } : {},
    chat,
    sender: decodeUser(payload.author),
    content: decoded.content,
    mentions: {
 // A `GROUP_AT_MESSAGE_CREATE` only reaches the bot when it was @-ed, and 单聊 needs no mention at all. A
 // full-mode body carries every group message, so there the text decides, and `@all` alone is not the bot.
      self: fullMode ? decoded.self : chatType === 'group' || decoded.self,
      all: decoded.all,
      users: decodeMentionedUsers(payload.mentions),
    },
    time,
    referrer,
  }
  const quote = decodeQuote(payload)
  if (quote) message.quote = quote
  message.raw = frame.d
  return [bot.session({ type: 'message', id, timestamp: time, message })]
}

/** The chat of a 群聊 event . */
function groupChatOf(payload: Dict): ChatRef | undefined {
  const openid = nonEmpty(payload.group_openid)
  if (!openid) return
  return { id: chatId('group', openid), type: 'group' }
}

/** The chat of a 单聊 event: the sender is the conversation (`user:<user_openid>`, ). */
function directChatOf(payload: Dict): ChatRef | undefined {
  const author = isDict(payload.author) ? payload.author : {}
  const openid = nonEmpty(payload.user_openid)
    ?? nonEmpty(author.user_openid)
    ?? nonEmpty(author.member_openid)
    ?? nonEmpty(author.id)
  if (!openid) return
  return { id: chatId('user', openid), type: 'direct' }
}

/** The sender of an event (`member_openid` in groups, `user_openid` in C2C, `id` as the last resort, ). */
function decodeUser(value: unknown): UserRef {
  const user = isDict(value) ? value : {}
  const userRef: UserRef = {
    id: nonEmpty(user.member_openid) ?? nonEmpty(user.user_openid) ?? nonEmpty(user.id) ?? '',
    isBot: user.bot === true,
  }
  const name = nonEmpty(user.username)
  if (name) userRef.name = name
  const role = user.member_role
  if (role === 'owner' || role === 'admin' || role === 'member') userRef.role = role
  return userRef
}

/** The `mentions` array of an event body; the bot itself is never part of it (platform contract). */
function decodeMentionedUsers(value: unknown): UserRef[] {
  const users: UserRef[] = []
  for (const item of arrayOf(value)) {
    const user = decodeUser(item)
    if (user.id) users.push(user)
  }
  return users
}

// ---------------------------------------------------------------------------------------------------------------
// Content

/** Result of {@link decodeContent}: the normalized tree plus what the text said about mentions. */
interface DecodedContent {
  content: Element<'message'>
  /** `<qqbot-at-everyone>` appeared in the text. */
  all: boolean
  /** The bot's own openid was mentioned in the text. */
  self: boolean
}

/**
 * Build the v4 tree of one event body.
 *
 * @param payload - event body.
 * @param selfIds - every id that names the bot (account id and openid); empty entries are ignored.
 * @returns the normalized `<message>` plus the mention flags read from the text.
 */
function decodeContent(payload: Dict, selfIds: readonly string[]): DecodedContent {
  const decoded = decodeInline(nonEmpty(payload.content) ?? '', selfIds)
  const nodes: Element[] = [...decoded.nodes]
  for (const attachment of arrayOf(payload.attachments)) {
    const element = decodeAttachment(attachment)
    if (element) nodes.push(element)
  }
  // 聊天记录 (merged records) has no send-side equivalent, so it stays an identity reference.
  for (const item of arrayOf(payload.msg_elements)) {
    if (!isDict(item) || numberOr(item.message_type) !== 102) continue
    const forwardId = nonEmpty(item.msg_idx)
    if (forwardId) nodes.push(h('forward', { id: forwardId }))
  }
  const ark = payload.ark_data
  if (isDict(ark)) {
 // A structured card is a platform-only kind; keep the payload and, when the platform did not already flatten
 // it into `content`, its prompt as the readable text.
    const raw = h('raw', { platform: 'qq', type: 'ark', data: ark })
    if (!decoded.text) raw.children.push(h.text(nonEmpty(ark.prompt) ?? nonEmpty(ark.ark_name) ?? '[卡片消息]'))
    nodes.push(raw)
  }
  let content = normalize(nodes)
  if (!content.children.length) {
 // Never empty : keep the body so nothing is lost and say so in the fallback text.
    const type = numberOr(payload.message_type)
    content = normalize(h('raw', { platform: 'qq', type: type === undefined ? 'empty' : `message_type:${type}`, data: payload }, '[空消息]'))
  }
  return { content, all: decoded.all, self: decoded.self }
}

/** Tokenizer result of the message text. */
interface DecodedInline {
  nodes: Element[]
  all: boolean
  self: boolean
  /** Whether the text held something visible (non-whitespace text or a mention). */
  text: boolean
}

/** `<@openid>`, `<@!openid>`, `<qqbot-at-user id="…"/>` and `<qqbot-at-everyone/>` of a message body . */
const MENTION_PATTERN = /<@!?([^>\s]+)>|<qqbot-at-user\b([^>]*)>|<qqbot-at-everyone\b[^>]*>/g

/** `id="…"` of a `<qqbot-at-user>` tag. */
const AT_USER_ID = /\bid\s*=\s*"([^"]*)"/i

/**
 * Split the platform text into `text` and `at` elements; plain text stays literal (it is never parsed as markup).
 *
 * @param source - `content` of the event body.
 * @param selfIds - every id that names the bot; a mention carrying one of them is a mention of the bot.
 * @returns the inline elements and the mention flags.
 */
function decodeInline(source: string, selfIds: readonly string[]): DecodedInline {
  const nodes: Element[] = []
  let all = false
  let self = false
  let text = false
  const pushText = (value: string) => {
    if (!value) return
    if (value.trim()) text = true
    nodes.push(h.text(value))
  }
  let last = 0
  for (const match of source.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0
    pushText(source.slice(last, index))
    const raw = match[0]
    const userId = match[1]
    if (userId) {
      nodes.push(h('at', { type: 'user', id: userId }))
      text = true
      if (selfIds.includes(userId)) self = true
    } else if (raw.startsWith('<qqbot-at-everyone')) {
      nodes.push(h('at', { type: 'all' }))
      all = true
      text = true
    } else {
      const id = nonEmpty(AT_USER_ID.exec(match[2] ?? '')?.[1])
      if (id) {
        nodes.push(h('at', { type: 'user', id }))
        text = true
        if (selfIds.includes(id)) self = true
      } else {
 // A malformed tag is literal text, not a lost mention.
        pushText(raw)
      }
    }
    last = index + raw.length
  }
  pushText(source.slice(last))
  return { nodes, all, self, text }
}

/**
 * One entry of `attachments` : `image/*` → `img`, `voice` → `audio`, `video*` → `video`, `file` and anything
 * else → `file`, each with the platform URL as `src`. An attachment without a URL carries no content and is dropped.
 *
 * @param value - attachment record.
 * @returns the element, or `undefined` when the record is unusable.
 */
function decodeAttachment(value: unknown): Element | undefined {
  if (!isDict(value)) return
  const src = nonEmpty(value.url)
  if (!src) return
  const type = (nonEmpty(value.content_type) ?? '').toLowerCase()
  const name = nonEmpty(value.filename)
  if (type.startsWith('image/')) {
    const image = h('img', { src })
    if (name) image.attrs.alt = name
    const width = numberOr(value.width)
    const height = numberOr(value.height)
    if (width !== undefined) image.attrs.width = width
    if (height !== undefined) image.attrs.height = height
    return image
  }
  if (type === 'voice') {
 // The platform transcodes SILK to WAV next to the original; the playable copy is the useful source.
    const audio = h('audio', { src: nonEmpty(value.voice_wav_url) ?? src })
    if (name) audio.attrs.name = name
    return audio
  }
  if (type === 'video' || type.startsWith('video/')) {
    const video = h('video', { src })
    if (name) video.attrs.name = name
    return video
  }
  const file = h('file', { src })
  if (name) file.attrs.name = name
  const size = numberOr(value.size)
  if (size !== undefined) file.attrs.size = size
  return file
}

/**
 * The quoted message of a reply.
 *
 * QQ delivers a reply as a reference index (`message_scene.ext` `ref_msg_idx`) plus the quoted message as a
 * `msg_elements` entry of `message_type: 103`; there is no fetch-by-id route for 群聊/单聊 messages, so the tree is
 * built from what the event carries (text only — the quoted attachments are not re-downloadable from here).
 *
 * @param payload - event body.
 * @returns `InboundMessage.quote`, or `undefined` when the message is not a reply.
 */
function decodeQuote(payload: Dict): InboundMessage['quote'] | undefined {
  const elements = arrayOf(payload.msg_elements).filter(isDict)
  const scene = isDict(payload.message_scene) ? parseSceneExt(payload.message_scene.ext) : {}
  const sceneId = nonEmpty(scene.ref_msg_idx)
  const marked = elements.find(item => numberOr(item.message_type) === 103)
 // A `message_type: 103` element is the quoted message. A quoted 聊天记录 arrives as its rendered text without that
 // marker, so the referenced element is the first one whenever `ref_msg_idx` points at the event body itself.
  const quoted = marked ?? (sceneId ? elements[0] : undefined)
  const id = sceneId ?? nonEmpty(marked?.msg_idx)
  if (!id) return
  const quote: NonNullable<InboundMessage['quote']> = { id }
  const sender = quoted ? decodeUser(quoted.author) : undefined
  if (sender?.id) quote.sender = sender
  const text = quoted ? nonEmpty(quoted.content) : undefined
  if (text) quote.content = normalize(h.text(text))
  return quote
}

// ---------------------------------------------------------------------------------------------------------------
// Interactions

/** `type` of a message-button click. */
const INTERACTION_BUTTON = 11
/** `type` of a quick-menu click: acknowledged like a button, but it produces no `interaction/button` session. */
const INTERACTION_MENU = 12

/**
 * One `INTERACTION_CREATE` event.
 *
 * @param bot - receiving bot.
 * @param frame - dispatch.
 * @param now - decode time.
 * @returns the click as a `interaction/button` session (button clicks only).
 */
async function interactionSessions(bot: QQBot, frame: GatewayDispatch, now: number): Promise<Session[]> {
  const payload = isDict(frame.d) ? frame.d : undefined
  if (!payload) return []
  const id = nonEmpty(payload.id)
  const type = numberOr(payload.type)
  if (!id || type === undefined) return []
 // The other interaction types (feedback, clear-session, story, model switch, authorizations) take no response.
  if (type !== INTERACTION_BUTTON && type !== INTERACTION_MENU) return []
  await acknowledge(bot, id)
  if (type !== INTERACTION_BUTTON) return []
  const chat = interactionChat(payload)
  if (!chat) return []
  const resolved = isDict(payload.data) && isDict(payload.data.resolved) ? payload.data.resolved : {}
  const messageId = nonEmpty(resolved.message_id)
  const time = decodeTimestamp(payload.timestamp, now)
  const referrer: QQReferrer = {
    event_id: id,
    receivedAt: now,
    chatType: chat.type === 'group' ? 'group' : 'direct',
    chatId: chat.id,
  }
  if (messageId) referrer.messageId = messageId
  const button: ButtonEvent = {
    bot,
    id: buttonIdOf(resolved),
    user: interactionUser(payload, resolved),
    chat,
    referrer,
    time,
  }
  const buttonData = nonEmpty(resolved.button_data)
  if (buttonData) button.data = buttonData
  if (messageId) button.message = { id: messageId, chat }
  return [bot.session({ type: 'interaction/button', id, timestamp: time, button })]
}

/**
 * The chat a click happened in. `chat_type` and `scene` describe the same thing; the platform documents
 * `0`/`guild` (频道) as a third product that v1 does not serve.
 */
function interactionChat(payload: Dict): ChatRef | undefined {
  const chatType = numberOr(payload.chat_type)
  const scene = nonEmpty(payload.scene)
  if (chatType === 1 || scene === 'group') {
    const openid = nonEmpty(payload.group_openid)
    if (!openid) return
    return { id: chatId('group', openid), type: 'group' }
  }
  if (chatType === 2 || scene === 'c2c') {
    const openid = nonEmpty(payload.user_openid)
    if (!openid) return
    return { id: chatId('user', openid), type: 'direct' }
  }
  return
}

/** The clicking user: `group_member_openid` in groups, `user_openid` in C2C, `resolved.user_id` in 频道. */
function interactionUser(payload: Dict, resolved: Dict): UserRef {
  const id = nonEmpty(payload.group_member_openid)
    ?? nonEmpty(payload.user_openid)
    ?? nonEmpty(resolved.user_id)
    ?? ''
  return { id }
}

/**
 * The id of the clicked button.
 *
 * `resolved.button_id` is what a custom keyboard sets, but the platform omits it for some clients, so the `id` is
 * recovered from `button_data`, where a callback button carries `data = id[:data]`.
 *
 * @param resolved - `data.resolved` of the interaction.
 * @returns the button id, possibly empty when the event carries neither field.
 */
function buttonIdOf(resolved: Dict): string {
  const id = nonEmpty(resolved.button_id)
  if (id) return id
  const data = nonEmpty(resolved.button_data)
  if (!data) return ''
  const index = data.indexOf(':')
  return index > 0 ? data.slice(0, index) : ''
}

/**
 * Acknowledge a click before it is published. A failure is logged instead of thrown: the platform client
 * just times out, and the handler can still react (and answer), which is strictly better than dropping the click.
 *
 * @param bot - receiving bot.
 * @param interactionId - `d.id` of the event.
 */
async function acknowledge(bot: QQBot, interactionId: string): Promise<void> {
  try {
    await bot.acknowledgeInteraction(interactionId)
  } catch (error) {
    bot.ctx.logger.warn(`qq: failed to acknowledge interaction ${interactionId}`, error)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Chat lifecycle (observer only)

/** Chat lifecycle events of , mapped onto `internal` re-emissions of the core. */
const LIFECYCLE: Readonly<Record<string, { event: string; chatKind: ChatKind; type: 'group' | 'direct'; chatKey: string; operatorKey?: string }>> = {
  GROUP_ADD_ROBOT: { event: 'qq/group-added', chatKind: 'group', type: 'group', chatKey: 'group_openid', operatorKey: 'op_member_openid' },
  GROUP_DEL_ROBOT: { event: 'qq/group-removed', chatKind: 'group', type: 'group', chatKey: 'group_openid', operatorKey: 'op_member_openid' },
  FRIEND_ADD: { event: 'qq/friend-added', chatKind: 'user', type: 'direct', chatKey: 'openid' },
  FRIEND_DEL: { event: 'qq/friend-removed', chatKind: 'user', type: 'direct', chatKey: 'openid' },
}

/**
 * A bot added to / removed from a group, or a friend added / removed.
 *
 * @param bot - receiving bot.
 * @param frame - dispatch.
 * @param now - decode time.
 * @returns one `internal` session, or none for an event this decoder does not handle.
 */
function lifecycleSessions(bot: QQBot, frame: GatewayDispatch, now: number): Session[] {
  const entry = LIFECYCLE[frame.t]
  if (!entry) return []
  const payload = isDict(frame.d) ? frame.d : {}
  const openid = nonEmpty(payload[entry.chatKey])
  if (!openid) return []
  const chat: ChatRef = { id: chatId(entry.chatKind, openid), type: entry.type }
  const timestamp = decodeTimestamp(payload.timestamp, now)
  const data: Dict = { chat, timestamp }
  const operatorId = entry.operatorKey ? nonEmpty(payload[entry.operatorKey]) : undefined
  if (operatorId) data.operator = { id: operatorId }
  return [bot.session({
    type: 'internal',
    id: nonEmpty(frame.id) ?? `${frame.t}:${openid}`,
    timestamp,
    internal: { type: entry.event, data },
  })]
}

// ---------------------------------------------------------------------------------------------------------------
// Wire helpers

/**
 * Parse `message_scene.ext` : the current payloads define it as `key=value` strings (`msg_idx`,
 * `ref_msg_idx`, `auth_token`); a JSON object string is accepted as well, because that field has been typed
 * loosely across payload revisions.
 *
 * @param value - `message_scene.ext`.
 * @returns the decoded pairs, last one winning.
 */
export function parseSceneExt(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const item of arrayOf(value)) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (!text) continue
    if (text.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (isDict(parsed)) {
          for (const [key, entry] of Object.entries(parsed)) {
            if (typeof entry === 'string') result[key] = entry
          }
        }
        continue
      } catch {
        continue
      }
    }
    const index = text.indexOf('=')
    if (index <= 0) continue
    result[text.slice(0, index).trim()] = text.slice(index + 1).trim()
  }
  return result
}

/**
 * Parse an event timestamp into epoch milliseconds.
 *
 * The documented shape is RFC3339; the reference implementation also sees a monotonic-clock suffix (`m=+1.234`) and
 * a Windows zone name (`… +0800 CST`), so both are tolerated. The lifecycle events carry epoch **seconds** while the
 * message events carry a string, hence the heuristic for numeric input.
 *
 * @param value - `timestamp` of the event body.
 * @param fallback - used when the value is missing or unparseable (default: now).
 * @returns epoch milliseconds.
 */
export function decodeTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
 // Below 1e11 no millisecond epoch exists in this product's lifetime, so the value is in seconds.
    return value > 0 && value < 1e11 ? value * 1000 : value
  }
  if (typeof value !== 'string') return fallback
  let text = value.trim()
  if (!text) return fallback
  const monotonic = text.indexOf('m=')
  if (monotonic > 0) text = text.slice(0, monotonic).trim()
 // `… +0800 CST` → `… +08:00`: the zone name is redundant with the numeric offset in front of it.
  text = text.replace(/\s+CST$/i, '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  if (text.length > 10 && text[10] === ' ') text = `${text.slice(0, 10)}T${text.slice(11)}`
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : fallback
}

/** Whether a value is a plain JSON object. */
function isDict(value: unknown): value is Dict {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty string, or `undefined`. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A finite number, or `undefined`. */
function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** An array, or an empty one. */
function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
