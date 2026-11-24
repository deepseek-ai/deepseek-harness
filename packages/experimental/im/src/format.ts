/**
 * `ctx.im.format(messages)` → model-facing content blocks.
 *
 * Two styles, both carrying the stable media ids of {@link mediaLabel}:
 * - `xml` (default): one `<im-message seq="12" from="张三" time="14:07">…</im-message>` per message, with
 *   `self="true"` for the bot's own messages and `quote="#10"` when the message answers a stored one. The body is
 *   the plain text of the content (block structure flattened by `toText`), so a model can read a code block inline.
 * - Every body encodes `&` and `<`: the envelope is what tells a model which chat it answers in, and message text is
 *   written by a chat participant, who could otherwise spell a second `<im-chat … />` header inside a body.
 * - `line`: compact one-liners, `#12 14:07 张三(u_1) ↩#10 李四: 原文: 正文`, collapsing every message to one
 *   line so a batch of history stays concise.
 *
 * Media elements keep their `[图片 #12.1]` placeholder in the text; `media: true` additionally admits the images and
 * appends them as image blocks after that text, so the model sees the picture and can still name it later.
 */
import type { Context } from '@deepseek-ai/cordis'
import { h, toText, type Element, type UserRef } from '@deepseek-ai/cordis-plugin-im-core'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ImConfig, ImFormatOptions, ImHistory, ImMessage } from './api.ts'
import { mediaKindOf, mediaLabel, mediaRefAt, mediaRefs, type ImMediaStore } from './media.ts'

/** Model-facing rendering style of one message. */
export type ImFormatStyle = 'xml' | 'line'

/** A quote resolved as far as the caller could: a seq token plus whatever the store kept about it. */
interface ImQuoteRef {
  /** `#<seq>` when the quoted message is still stored in the same chat, the message key otherwise. */
  id: string
  sender: UserRef | undefined
  text: string | undefined
}

/** Upper bound of a one-line body/preview segment (code points), so a line stays one screen line. */
const LINE_LIMIT = 240
/** Upper bound of a quoted or forwarded preview inside a line (code points). */
const PREVIEW_LIMIT = 60
/** Upper bound of a quoted preview inside an XML `quote-text` attribute (code points). */
const QUOTE_XML_LIMIT = 500

/** Display name of a sender: its platform name, or its id when the platform names nobody. */
function senderName(user: UserRef): string {
  return user.name?.trim() || user.id
}

/** `HH:MM` of a message timestamp in the host's local zone (the zone the transcript is read in). */
function clock(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Collapse whitespace (including line breaks) into single spaces, bounded to `limit` code points. */
function oneLine(text: string, limit = LINE_LIMIT): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(collapsed)
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : collapsed
}

/**
 * Escape a value for use inside a double-quoted XML attribute of the transcript.
 * @param value - the raw attribute value.
 * @returns the value with `&`, `<`, `>` and `"` escaped.
 */
export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Escape a value for use as the character data of the transcript (`im-message` bodies, quote previews).
 *
 * A message body is content a chat participant controls, and the transcript's envelope is what tells a model which chat
 * it is answering in: a body that spells `</im-message><im-chat key="…" />` would otherwise read as a second chat
 * header, and the shared session holds a write grant for every chat it heard.
 * @param value - the raw body or preview text.
 * @returns the value with `&` and `<` escaped, so nothing in it can open or close an element.
 */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

/**
 * One-line preview of a merged forward: its id plus the first line of the preview it carries.
 * @param node - the forward element, which supplies the id.
 * @param children - the entries to preview; the caller passes them already relabelled when the forward was expanded.
 * @returns the preview line.
 */
function forwardPreview(node: Element<'forward'>, children: readonly Element[] = node.children): string {
  // The id is required by the vocabulary, but an unnormalized inbound forward may arrive without one.
  const attrs: { id?: unknown } = node.attrs
  const id = typeof attrs.id === 'string' ? attrs.id : ''
  const preview = children.length ? oneLine(toText(children), PREVIEW_LIMIT) : ''
  return preview ? `[合并转发 #${id}: ${preview}]` : `[合并转发 #${id}]`
}

/** Text of one message: media elements become their stable labels, forwards a one-line preview. */
function bodyOf(message: ImMessage): string {
  let index = 0
  const relabel = (node: Element): Element => {
    const kind = mediaKindOf(node)
    if (kind) return h.text(mediaLabel(mediaRefAt(message, node, kind, ++index)))
    // An expanded forward numbers the media of its entries as this walk reaches them, because `mediaRefs` reads the same
    // tree in the same order: a label skipped here would name a different element to `im_read_image`.
    if (node.type === 'forward') return h.text(forwardPreview(node, node.children.map(relabel)))
    return { ...node, children: node.children.map(relabel) }
  }
  return toText({ ...message.content, children: message.content.children.map(relabel) })
}

/** `<im-message …>body</im-message>`. */
function xmlText(message: ImMessage, body: string, quote: ImQuoteRef | undefined): string {
  const attributes = [`seq="${message.seq}"`, `from="${escapeAttribute(senderName(message.sender))}"`, `time="${clock(message.time)}"`]
  if (message.sender.self) attributes.push('self="true"')
  if (quote) {
    attributes.push(`quote="${escapeAttribute(quote.id)}"`)
    if (quote.sender) attributes.push(`quote-from="${escapeAttribute(oneLine(senderName(quote.sender)))}"`)
    if (quote.text) {
      const preview = oneLine(quote.text, QUOTE_XML_LIMIT)
      if (preview) attributes.push(`quote-text="${escapeAttribute(preview)}"`)
    }
  }
  return `<im-message ${attributes.join(' ')}>${escapeText(body)}</im-message>`
}

/** `↩#10 李四: 原文` — the reply marker of one line. */
function quoteSegment(quote: ImQuoteRef): string {
  let segment = `↩${escapeText(oneLine(quote.id))}`
  if (quote.sender) segment += ` ${escapeText(oneLine(senderName(quote.sender)))}`
  if (quote.text) segment += `: ${escapeText(oneLine(quote.text, PREVIEW_LIMIT))}`
  return segment
}

/** `#12 14:07 张三(u_1) …: body`. */
function lineText(message: ImMessage, body: string, quote: ImQuoteRef | undefined): string {
  const name = escapeText(oneLine(senderName(message.sender)))
  const id = escapeText(oneLine(message.sender.id))
  const identity = `${name}${message.sender.self ? '(你)' : ''}(${id})`
  const head = [`#${message.seq}`, clock(message.time), identity]
  if (quote) head.push(quoteSegment(quote))
  const text = escapeText(oneLine(body))
  return `${head.join(' ')}:${text ? ` ${text}` : ''}`
}

/** One message in the requested style. */
function renderMessage(message: ImMessage, style: ImFormatStyle, quote: ImQuoteRef | undefined): string {
  const body = bodyOf(message)
  return style === 'line' ? lineText(message, body, quote) : xmlText(message, body, quote)
}

/**
 * Text of one message in the given style, without media blocks (tools, previews).
 * @param message - the stored message to render.
 * @param style - `xml` (envelope element per message) or `line` (one collapsed line).
 * @returns the rendered text, with media elements as their stable `[图片 #12.1]` labels.
 */
export function formatText(message: ImMessage, style: ImFormatStyle): string {
  const quote = message.quote
  return renderMessage(message, style, quote && { id: quote.key, sender: quote.sender, text: quote.text })
}

/**
 * `ctx.im.format`: renders stored messages as one model-facing text block (plus admitted images), resolving quotes to
 * the `#seq` token the transcript shows.
 */
export class ImFormatter {
  constructor(
    readonly ctx: Context,
    readonly config: ImConfig,
    readonly history: ImHistory,
    /** The media slice this formatter needs: admission of the media references one message carries. */
    readonly media: Pick<ImMediaStore, 'admit'>,
  ) {}

  /**
   * `xml` (default): one `<im-message seq from time quote>text [图片 #seq.n]</im-message>` per message;
   * `line`: compact one-liners. `media` attaches every admitted image as an image block and every admitted non-image
   * as a verbatim file block after the text. `forward` elements render as a one-line preview.
   * @param messages - stored messages in transcript order.
   * @param options - style, media admission, envelope header and cancellation.
   * @returns user-message content: one text block, then the admitted images and files.
   */
  async format(messages: readonly ImMessage[], options: ImFormatOptions = {}): Promise<UserMessage['content']> {
    const style = options.style ?? 'xml'
    const lines = messages.map(message => renderMessage(message, style, this.quoteRef(message)))
    const text = [options.header ?? '', ...lines].filter(line => line !== '').join('\n')
    const content: ContentBlock[] = [{ type: 'text', text }]
    if (options.media && messages.length) {
      const refs = messages.flatMap(message => mediaRefs(message))
      const skipped: string[] = []
      for (const item of await this.media.admit(refs, options.signal)) {
        if (item.image !== undefined) content.push(item.image)
        else if (item.file !== undefined) content.push(item.file)
        else if (item.skipped !== undefined) skipped.push(`${escapeText(mediaLabel(item.ref))}: skipped (${escapeText(item.skipped)})`)
      }
      if (skipped.length > 0) content[0] = { type: 'text', text: `${text}\n${skipped.join('\n')}` }
    }
    return content
  }

  /** The quote of a message, resolved to the seq the transcript shows when the store still has it. */
  private quoteRef(message: ImMessage): ImQuoteRef | undefined {
    const quote = message.quote
    if (!quote) return undefined
    const stored = this.history.get(quote.key)
    const id = stored && stored.chat.key === message.chat.key ? `#${stored.seq}` : quote.key
    return { id, sender: quote.sender, text: quote.text }
  }
}
