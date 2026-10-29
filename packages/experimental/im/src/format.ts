/**
 * `ctx.im.format(messages)` → model-facing content blocks.
 *
 * Two styles, both carrying the stable media ids of {@link mediaLabel}:
 * - `xml` (default): one `<im-message seq="12" from="张三" time="14:07">…</im-message>` per message, with
 *   `self="true"` for the bot's own messages and `quote="#10"` when the message answers a stored one. The body is
 *   the plain text of the content (block structure flattened by `toText`), so a model can read a code block inline.
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

/** One-line preview of a merged forward: its id plus the first line of the preview it carries. */
function forwardPreview(node: Element<'forward'>): string {
  // The id is required by the vocabulary, but an unnormalized inbound forward may arrive without one.
  const attrs: { id?: unknown } = node.attrs
  const id = typeof attrs.id === 'string' ? attrs.id : ''
  const preview = node.children.length ? oneLine(toText(node.children), PREVIEW_LIMIT) : ''
  return preview ? `[合并转发 #${id}: ${preview}]` : `[合并转发 #${id}]`
}

/** Text of one message: media elements become their stable labels, forwards a one-line preview. */
function bodyOf(message: ImMessage): string {
  let index = 0
  const relabel = (node: Element): Element => {
    const kind = mediaKindOf(node)
    if (kind) return h.text(mediaLabel(mediaRefAt(message, node, kind, ++index)))
    if (node.type === 'forward') return h.text(forwardPreview(node))
    return { ...node, children: node.children.map(relabel) }
  }
  return toText({ ...message.content, children: message.content.children.map(relabel) })
}

/** `<im-message …>body</im-message>`. */
function xmlText(message: ImMessage, body: string, quote: ImQuoteRef | undefined): string {
  const attributes = [`seq="${message.seq}"`, `from="${escapeAttribute(senderName(message.sender))}"`, `time="${clock(message.time)}"`]
  if (message.sender.self) attributes.push('self="true"')
  if (quote) attributes.push(`quote="${escapeAttribute(quote.id)}"`)
  return `<im-message ${attributes.join(' ')}>${body}</im-message>`
}

/** `↩#10 李四: 原文` — the reply marker of one line. */
function quoteSegment(quote: ImQuoteRef): string {
  let segment = `↩${quote.id}`
  if (quote.sender) segment += ` ${senderName(quote.sender)}`
  if (quote.text) segment += `: ${oneLine(quote.text, PREVIEW_LIMIT)}`
  return segment
}

/** `#12 14:07 张三(u_1) …: body`. */
function lineText(message: ImMessage, body: string, quote: ImQuoteRef | undefined): string {
  const identity = `${senderName(message.sender)}${message.sender.self ? '(你)' : ''}(${message.sender.id})`
  const head = [`#${message.seq}`, clock(message.time), identity]
  if (quote) head.push(quoteSegment(quote))
  const text = oneLine(body)
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
   * `line`: compact one-liners. `media` attaches admitted images as image blocks after the text.
   * `forward` elements render as a one-line preview.
   * @param messages - stored messages in transcript order.
   * @param options - style, media admission, envelope header and cancellation.
   * @returns user-message content: one text block, then the admitted images.
   */
  async format(messages: readonly ImMessage[], options: ImFormatOptions = {}): Promise<UserMessage['content']> {
    const style = options.style ?? 'xml'
    const lines = messages.map(message => renderMessage(message, style, this.quoteRef(message)))
    const text = [options.header ?? '', ...lines].filter(line => line !== '').join('\n')
    const content: ContentBlock[] = [{ type: 'text', text }]
    if (options.media && messages.length) {
      const refs = messages.flatMap(message => mediaRefs(message))
      for (const item of await this.media.admit(refs, options.signal)) {
        if (item.image) content.push(item.image)
      }
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
