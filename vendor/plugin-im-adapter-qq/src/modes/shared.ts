/**
 * Shared machinery of the two QQ modes: the node stream the element handlers produce (text runs, block boundaries,
 * media, buttons and verbatim code), the draft `assemble` builds from it (text runs merged, one `msg_type: 7` message per
 * media element, buttons hoisted into the keyboard, parts clamped to the passive budget), `serialize` into the wire body,
 * `diff` for append streaming and `check`.
 *
 * Payload contract with `send.ts`: `serialize` returns a {@link QqMessageRequest} **without** `msg_id`,
 * `msg_seq`, `event_id` and `message_reference` — the send stage fills the passive fields and the reply reference.
 * Media drafts carry a `ResourceRef` that the adapter's `upload` resolved; `serialize` writes its key as
 * `media.file_info`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/modes/shared
 */

import { type Element, isPhrasingContainer } from '@deepseek-ai/satori-element'
import type { LimitViolation, Mode, Prepared, RenderContext, ResolvedResource, ResourceKind, ResourceRef } from '@deepseek-ai/cordis-plugin-im-core'
import { COST_PLAIN } from '@deepseek-ai/cordis-plugin-im-core'
import type { QqKeyboard, QqKeyboardButton, QqMessageRequest } from '../api.ts'
import type { QQConfig } from '../config.ts'
import { layoutKeyboard } from '../keyboard.ts'

/** Paragraph boundary inside the node stream. */
export interface BlockNode { kind: 'block' }

/** One media element: becomes its own `msg_type: 7` message. */
export interface MediaNode {
  kind: 'media'
  tag: 'img' | 'audio' | 'video' | 'file'
  ref: ResourceRef
  /** Text used when the passive budget forces the media into the text message (`[图片: alt]`). */
  label: string
  path: string
}

/** One keyboard button, hoisted out of the content by `assemble` (markdown + keyboard only). */
export interface ButtonNode {
  kind: 'button'
  button: QqKeyboardButton
  /** Row key: the enclosing `<button-group>`'s stable id, `''` for loose buttons. */
  row: string
  /** Markdown text that replaces the button when the keyboard has no room for it. */
  fallback: string
  path: string
}

/**
 * Text the platform re-reads literally: a fenced code block. `assemble` copies it into the message content as it is,
 * so blank lines and indentation of the code survive, and the markdown escaper never touches it.
 */
export interface VerbatimNode {
  kind: 'verbatim'
  text: string
}

/**
 * One image kept inside the message body instead of its own media message.
 *
 * QQ renders an inline markdown image only when both pixel dimensions are given (`#0px` keeps the source size), and it
 * fetches the source itself: a public URL directly, or the `qqbot-media://` reference of an uploaded resource. The
 * reference is only known after `prepare`, so `assemble` writes a placeholder that `serialize` replaces.
 */
export interface InlineImageNode {
  kind: 'image'
  ref: ResourceRef
  alt: string
  width?: number
  height?: number
}

/** Platform node of both modes: a text fragment (already escaped for markdown) or one of the structured nodes. */
export type QqNode = string | BlockNode | MediaNode | ButtonNode | VerbatimNode | InlineImageNode

/** One platform message before resource resolution. */
export type QqDraft =
  | { msg_type: 0; content: string }
  | { msg_type: 2; content: string; keyboard?: QqKeyboard; images?: readonly InlineImageNode[] }
  | { msg_type: 7; tag: MediaNode['tag']; media: ResourceRef }

/** Append-stream patch: text appended to the previous draft's content. */
export interface QqPatch { append: string }

export interface QqTypes {
  node: QqNode
  draft: QqDraft
  payload: QqMessageRequest
  patch: QqPatch
}

export const BLOCK: BlockNode = Object.freeze({ kind: 'block' }) as BlockNode

export const isBlock = (node: QqNode): node is BlockNode => typeof node === 'object' && node.kind === 'block'

export const isVerbatim = (node: QqNode): node is VerbatimNode => typeof node === 'object' && node.kind === 'verbatim'

export const isImage = (node: QqNode): node is InlineImageNode => typeof node === 'object' && node.kind === 'image'

/** Placeholder of the `index`-th image of one draft; `serialize` replaces it once `prepare` resolved the resource. */
export function imageToken(index: number): string {
  return `\u0000img${index}\u0000`
}

/**
 * Fold the images of one more draft into a merged message: every placeholder is renumbered onto `into`.
 *
 * @param content - already assembled content of the merged draft.
 * @param images - images that draft carried, indexed by its own placeholders.
 * @param into - images of the message being built.
 * @returns the content with its placeholders renumbered.
 */
function renumberImages(content: string, images: readonly InlineImageNode[] | undefined, into: InlineImageNode[]): string {
  if (!images?.length) return content
  let out = content
  images.forEach((image, index) => {
    const token = imageToken(index)
    if (!out.includes(token)) return
    out = out.split(token).join(imageToken(into.push(image) - 1))
  })
  return out
}

/** A verbatim node (a fenced code block) around `text`. */
export function verbatim(text: string): VerbatimNode {
  return { kind: 'verbatim', text }
}

/** How long after publication QQ still accepts a recall (`limit.delete.window`). */
export const QQ_DELETE_WINDOW_MS = 120_000

/** Settings of one mode instance, derived from {@link QQConfig}. */
export interface QqModeSettings {
  markdown: boolean
  keyboard: boolean
  linkPolicy: QQConfig['linkPolicy']
  /** Largest passive budget of any chat type; the mode's `limit.message.parts`. */
  parts: number
}

/**
 * Apply `fn` to each maximal run of text in `nodes`; structured nodes pass through and end the run.
 *
 * @param nodes - rendered children.
 * @param fn - run transform (receives the joined run; block markers inside it are joined with `sep`).
 * @param sep - what a block marker inside a run becomes; `undefined` keeps block markers as nodes.
 */
export function mapRuns(nodes: readonly QqNode[], fn: (text: string, index: number) => string, sep?: string): QqNode[] {
  const out: QqNode[] = []
  let run: string[] | undefined
  let index = 0
  const flush = () => {
    if (!run) return
    const text = run.join('')
    run = undefined
    out.push(fn(text, index++))
  }
  for (const node of nodes) {
    if (typeof node === 'string') (run ??= []).push(node)
    else if (isBlock(node) && sep !== undefined) (run ??= []).push(sep)
    else {
      flush()
      out.push(node)
    }
  }
  flush()
  return out
}

/** One rendered line: escaped markdown, or a line of a fenced block that must stay byte-exact. */
export interface RenderedLine {
  /** The line as it will be prefixed and joined. */
  text: string
  /** The line came from a verbatim node, so nothing may collapse its spacing. */
  literal: boolean
}

/**
 * Flatten rendered nodes into lines.
 *
 * {@link mapRuns} keeps a verbatim node out of the text run so nothing collapses the blank lines and indentation of a
 * fenced block — which also keeps it out of the prefix a list item or a block quote puts on every line it owns. The
 * fence then never opens on a line of its own, and the container's marker ends up glued to the closing fence, so
 * everything after it is swallowed into that block. Flattening first keeps both properties: text runs are formatted,
 * code lines are not, and the caller prefixes every line.
 *
 * @param nodes - rendered children of the container.
 * @param format - rewrite of one text run; never applied to a verbatim line.
 * @param sep - what a block marker inside the container becomes.
 * @returns the lines, without leading or trailing empty ones.
 */
export function flattenRuns(
  nodes: readonly QqNode[],
  format: (text: string) => string = text => text,
  sep = '\n',
): RenderedLine[] {
  const lines: RenderedLine[] = []
  let run: string[] | undefined
  const flush = () => {
    if (!run) return
    const text = format(run.join(''))
    run = undefined
    for (const line of text.split('\n')) lines.push({ text: line, literal: false })
  }
  for (const node of nodes) {
    if (typeof node === 'string') (run ??= []).push(node)
    else if (isBlock(node)) (run ??= []).push(sep)
    else if (isVerbatim(node)) {
      flush()
      for (const line of node.text.split('\n')) lines.push({ text: line, literal: true })
    } else flush()
  }
  flush()
  while (lines.length && !lines[0]!.text.trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1]!.text.trim()) lines.pop()
  return lines
}

/** Wrap each text run in inline delimiters, keeping surrounding whitespace outside (`** x**` is not bold). */
export function wrapInline(nodes: readonly QqNode[], open: string, close: string): QqNode[] {
  return mapRuns(nodes, text => {
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!
    return match[2] ? `${match[1]}${open}${match[2]}${close}${match[3]}` : text
  })
}

/** A block: boundary markers around the children, optionally reformatting each text run. */
export function block(nodes: readonly QqNode[], fn?: (text: string, index: number) => string, sep = '\n'): QqNode[] {
  const inner = fn ? mapRuns(nodes, (text, index) => fn(trimNewlines(collapse(text)), index), sep) : nodes
  return [BLOCK, ...inner, BLOCK]
}

export const trimNewlines = (text: string) => text.replace(/^\n+|\n+$/g, '')
const collapse = (text: string) => text.replace(/\n{3,}/g, '\n\n')

const MEDIA_KIND: Record<MediaNode['tag'], ResourceKind> = { img: 'image', audio: 'audio', video: 'video', file: 'file' }
const MEDIA_LABEL: Record<MediaNode['tag'], string> = { img: '图片', audio: '语音', video: '视频', file: '文件' }

/** The media node of one `img audio video file` element, with no report of its own. */
function mediaOf(el: Element<'img' | 'audio' | 'video' | 'file'>, ctx: RenderContext<QqTypes>): MediaNode {
  const attrs = el.attrs as { src: string; alt?: string; name?: string; duration?: number; width?: number; height?: number }
  const meta: { name?: string; duration?: number; width?: number; height?: number } = {}
  if (attrs.name !== undefined) meta.name = attrs.name
  if (attrs.duration !== undefined) meta.duration = attrs.duration
  if (attrs.width !== undefined) meta.width = attrs.width
  if (attrs.height !== undefined) meta.height = attrs.height
  const caption = attrs.alt ?? attrs.name
  return {
    kind: 'media',
    tag: el.type,
    ref: ctx.resource(MEDIA_KIND[el.type], attrs.src, meta),
    label: `[${MEDIA_LABEL[el.type]}${caption ? `: ${caption}` : ''}]`,
    path: ctx.stableId(el),
  }
}

/** Handler of `img audio video file` in both modes: its own `msg_type: 7` message. */
export function mediaNode(el: Element<'img' | 'audio' | 'video' | 'file'>, ctx: RenderContext<QqTypes>): QqNode {
  const node = mediaOf(el, ctx)
  const parent = ctx.ancestors[ctx.ancestors.length - 1]
  if (parent && isPhrasingContainer(parent.type)) ctx.report.moved.push({ tag: el.type, reason: 'qq-media-split', path: node.path })
  return node
}

/** Join the paragraphs of one text run into message content; `undefined` when nothing visible is left. */
function finishText(parts: readonly QqNode[], settings: QqModeSettings): string | undefined {
  const paragraphs: string[] = []
  let current = ''
  /** The paragraph being built holds verbatim text: collapsing or rewriting its lines would corrupt the code. */
  let literal = false
  const push = () => {
    const raw = current
    const keep = literal
    current = ''
    literal = false
    if (!raw.trim()) return
    paragraphs.push(keep ? trimNewlines(raw) : formatParagraph(raw, settings))
  }
  for (const part of parts) {
    if (typeof part === 'string') current += part
    else if (isVerbatim(part)) {
      current += part.text
      literal = true
    } else push()
  }
  push()
  if (!paragraphs.length) return undefined
  return paragraphs.join(settings.markdown ? '\n\n' : '\n')
}

/** One paragraph of escaped text: runs of blank lines collapse, and in markdown a `\u200B` keeps a blank line alive. */
function formatParagraph(raw: string, settings: QqModeSettings): string {
  const text = trimNewlines(collapse(raw))
  if (!settings.markdown) return text
  return text.split('\n').map(line => line.trim() ? line : '\u200B').join('\n')
}

function textDraft(content: string, settings: QqModeSettings, images?: readonly InlineImageNode[]): QqDraft {
  if (!settings.markdown) return { msg_type: 0, content }
  return images?.length ? { msg_type: 2, content, images } : { msg_type: 2, content }
}

/** QQ renders an inline image only with both pixel dimensions; `0px` keeps the source size. */
function imageSize(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) && value > 0 ? `${Math.round(value)}px` : '0px'
}

/**
 * Replace every image placeholder with the markdown image QQ renders.
 *
 * The alt text loses the characters that would end the tag, and the source is the uploaded resource's
 * `qqbot-media://` reference: `prepare` uploaded it for this chat, so a public URL and a local file take one path.
 *
 * @param content - assembled content carrying the placeholders.
 * @param images - images of this draft, indexed by those placeholders.
 * @param resolved - uploaded keys of the prepared message.
 * @returns the content QQ receives.
 */
function resolveImages(
  content: string,
  images: readonly InlineImageNode[],
  resolved: ReadonlyMap<ResourceRef, ResolvedResource>,
): string {
  let out = content
  images.forEach((image, index) => {
    const token = imageToken(index)
    if (!out.includes(token)) return
    const key = resolved.get(image.ref)?.key
    const alt = image.alt.replace(/[[\]#]/g, '')
    // Without a key the upload did not happen, so the alt text is all that is left to show.
    const rendered = key === undefined
      ? alt
      : `![${alt} #${imageSize(image.width)} #${imageSize(image.height)}](qqbot-media://${key})`
    out = out.split(token).join(rendered)
  })
  return out
}

/**
 * `assemble` of both modes: text runs between media become one message each, every media element its own
 * `msg_type: 7` message, buttons go to the keyboard of the last markdown message. When the passive budget
 * (`limit.message.parts`) cannot take every part, all text is merged into the first text message and trailing media
 * degrade into their text label.
 */
export function assemble(nodes: QqNode[], ctx: RenderContext<QqTypes>, settings: QqModeSettings): QqDraft[] {
  type Item = { text: QqNode[]; images: InlineImageNode[] } | { media: MediaNode }
  const items: Item[] = []
  const buttons: ButtonNode[] = []
  let text: QqNode[] = []
  let images: InlineImageNode[] = []
  const flush = () => {
    if (text.length) items.push({ text, images })
    text = []
    images = []
  }
  for (const node of nodes) {
    if (typeof node === 'string' || isBlock(node) || isVerbatim(node)) text.push(node)
    else if (isImage(node)) {
 // The markdown mode embeds the image in its own body; a mode without that syntax keeps its own media message.
      if (settings.markdown) text.push(imageToken(images.push(node) - 1))
      else {
        flush()
        items.push({ media: { kind: 'media', tag: 'img', ref: node.ref, label: `[图片${node.alt ? `: ${node.alt}` : ''}]`, path: node.alt } })
      }
    } else if (node.kind === 'media') {
      flush()
      items.push({ media: node })
    } else buttons.push(node)
  }
  flush()

 // Text runs that render to nothing (whitespace between media) do not cost a message.
  const drafts: ({ content: string; images?: readonly InlineImageNode[] } | { media: MediaNode })[] = []
  for (const item of items) {
    if ('media' in item) drafts.push(item)
    else {
      const content = finishText(item.text, settings)
      if (content !== undefined) drafts.push(item.images.length ? { content, images: item.images } : { content })
    }
  }

  const limit = Math.max(1, ctx.limit('limit.message.parts') ?? Infinity)
  const join = settings.markdown ? '\n\n' : '\n'
  if (drafts.length > limit && drafts.some(draft => 'content' in draft)) {
 // Merge every text run into the first one: order is lost, text is not.
    const first = drafts.findIndex(draft => 'content' in draft)
    const merged = drafts.filter((draft): draft is { content: string; images?: readonly InlineImageNode[] } => 'content' in draft)
    for (let i = drafts.length - 1; i > first; i--) {
      if ('content' in drafts[i]!) drafts.splice(i, 1)
    }
    const into: InlineImageNode[] = []
    const content = merged.map(draft => renumberImages(draft.content, draft.images, into)).join(join)
    drafts[first] = into.length ? { content, images: into } : { content }
    if (merged.length > 1) ctx.report.moved.push({ tag: 'p', reason: 'qq-parts-limit-merged', path: 'message' })
  }
  while (drafts.length > limit) {
 // The budget cannot take another media message: the last one becomes its label in the text message.
    let index = -1
    for (let i = drafts.length - 1; i >= 0; i--) {
      if ('media' in drafts[i]!) {
        index = i
        break
      }
    }
    const media = (drafts.splice(index, 1)[0] as { media: MediaNode }).media
    ctx.report.degraded.push({ tag: media.tag, via: 'qq-parts-limit', path: media.path })
    const label = settings.markdown ? escapeMarkdown(media.label) : media.label
    const textIndex = drafts.findIndex(draft => 'content' in draft)
    if (textIndex < 0) drafts.unshift({ content: label })
    else {
      const draft = drafts[textIndex] as { content: string }
      draft.content = `${draft.content}${join}${label}`
    }
  }

  const out: QqDraft[] = drafts.map(draft => 'media' in draft
    ? { msg_type: 7, tag: draft.media.tag, media: draft.media.ref }
    : textDraft(draft.content, settings, draft.images))

  if (buttons.length) {
    const { keyboard, overflow } = layoutKeyboard(buttons, ctx.report)
    let last = -1
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.msg_type === 2) {
        last = i
        break
      }
    }
    if (last < 0) {
 // A keyboard needs a markdown message to ride on.
      out.push({ msg_type: 2, content: '\u200B' })
      last = out.length - 1
    }
    const draft = out[last] as Extract<QqDraft, { msg_type: 2 }>
    if (overflow.length) draft.content = draft.content === '\u200B' ? overflow.join(' ') : `${draft.content}\n\n${overflow.join(' ')}`
    if (keyboard) draft.keyboard = keyboard
  }

  if (out.length > 1) ctx.report.split += out.length - 1
  return out
}

/** `serialize` of both modes: the request body without the passive fields (`send.ts` fills them). */
export function serialize(msg: Prepared<QqDraft>): QqMessageRequest {
  const draft = msg.draft
  switch (draft.msg_type) {
    case 0:
      return { msg_type: 0, content: draft.content }
    case 2: {
      const content = draft.images?.length ? resolveImages(draft.content, draft.images, msg.resolved) : draft.content
      return { msg_type: 2, markdown: { content }, ...draft.keyboard ? { keyboard: draft.keyboard } : {} }
    }
    case 7: {
      const resolved = msg.resolved.get(draft.media)
      if (!resolved) throw new Error(`qq: media ${draft.media.kind} ${draft.media.src} was not uploaded`)
      return { msg_type: 7, content: ' ', media: { file_info: resolved.key } }
    }
  }
}

/** `diff` for the C2C append driver: a prefix extension of the same text body is an append, anything else replaces. */
export function diff(prev: QqDraft, next: QqDraft): QqPatch[] | 'replace' {
  if (prev.msg_type === 7 || next.msg_type === 7) {
    return prev.msg_type === 7 && next.msg_type === 7 && prev.media.src === next.media.src && prev.media.kind === next.media.kind
      ? []
      : 'replace'
  }
  if (prev.msg_type !== next.msg_type) return 'replace'
  if (prev.msg_type === 2 && next.msg_type === 2 && JSON.stringify(prev.keyboard) !== JSON.stringify(next.keyboard)) return 'replace'
  if (!next.content.startsWith(prev.content)) return 'replace'
  return next.content.length === prev.content.length ? [] : [{ append: next.content.slice(prev.content.length) }]
}

/** `check`: keyboard grid limits (`40034029`) and an empty text body. */
export function check(draft: QqDraft): LimitViolation[] {
  const out: LimitViolation[] = []
  if (draft.msg_type !== 7 && !draft.content) out.push({ kind: 'shape', message: 'qq: empty message content' })
  if (draft.msg_type === 2 && draft.keyboard?.content) {
    const rows = draft.keyboard.content.rows
    if (rows.length > 5) out.push({ kind: 'shape', key: 'limit.buttons.rows', limit: 5, actual: rows.length, message: 'qq: more than 5 keyboard rows' })
    for (const row of rows) {
      if (row.buttons.length > 5) out.push({ kind: 'shape', key: 'limit.buttons.row', limit: 5, actual: row.buttons.length, message: 'qq: more than 5 buttons in a keyboard row' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// QQ markdown escaper

/**
 * Escape text for QQ markdown: the inline metacharacters QQ reads as markup, and a leading U+200B for a run that would
 * otherwise open a block of its own (a list item, a heading, a quote, a rule).
 *
 * QQ follows CommonMark for `*`, `_`, `~`, backticks and brackets, but it renders `\#` and `1\.` with the backslash
 * still in the text, so a block marker cannot be defused with an escape: a zero-width space ahead of it is invisible
 * and keeps the marker from being seen at all. That matters for a heading whose own text is numbered (`## 1. Setext`)
 * and for prose that happens to start with a dash or a number.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_~[\]<>]/g, '\\$&')
    .replace(/^(\s*)(?=[-+]\s|#|\d+[.)]\s|>)/gm, '$1\u200B')
}

/** Make an URL safe inside `[label](url)`. */
export function markdownUrl(href: string): string {
  return href.replace(/[\s()<>]/g, ch => encodeURIComponent(ch))
}

/** Longest run of `char` in `text`: a code delimiter must be longer than any run of it inside the code. */
function longestRun(text: string, char: string): number {
  let longest = 0
  let run = 0
  for (const item of text) {
    run = item === char ? run + 1 : 0
    if (run > longest) longest = run
  }
  return longest
}

/**
 * An inline code span around `text`: newlines become spaces (a span is one line) and the delimiter is longer than any
 * backtick run inside, so the code cannot close its own span. Nothing inside is escaped.
 */
export function codeSpan(text: string): string {
  const body = text.replace(/\s*\n\s*/g, ' ')
  if (!body) return ''
  const delimiter = '`'.repeat(longestRun(body, '`') + 1)
  // A body starting or ending with a backtick would merge with the delimiter; the platform strips one surrounding
  // space again when the span has it on both sides.
  const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : ''
  return `${delimiter}${pad}${body}${pad}${delimiter}`
}

/** A fenced code block: the body verbatim, behind a fence longer than any backtick run inside it. */
export function fenceBlock(text: string, lang?: string): string {
  const body = text.replace(/\n+$/, '')
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1))
  return `${fence}${lang ?? ''}\n${body}\n${fence}`
}

/** Common pieces of the two mode specs. */
export function modeBase(id: string, settings: QqModeSettings): Pick<Mode<QqTypes>, 'id' | 'limits' | 'degradation' | 'serialize' | 'diff' | 'check'> {
  const limits: Mode<QqTypes>['limits'] = {
    'limit.message.parts': settings.parts,
    'limit.delete.window': QQ_DELETE_WINDOW_MS,
  }
  if (settings.keyboard) {
    limits['limit.buttons.row'] = 5
    limits['limit.buttons.rows'] = 5
  }
 // A lost `<hr>` is one ordinary element here: QQ has no divider, so the text mode turns it into a blank line anyway.
 // Declared explicitly so the price is a decision, not a default nobody looked at.
  return { id, limits, degradation: { cost: { hr: COST_PLAIN } }, serialize, diff, check }
}
