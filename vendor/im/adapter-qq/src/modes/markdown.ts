/**
 * `markdown` mode : `b i s code h1 h2 ul ol li blockquote hr pre` natively (escaped with the QQ
 * markdown escaper, paragraphs separated by blank lines, `\u200B` for empty lines), `<a>` natively only with
 * `linkPolicy: 'keep'`, media as separate `msg_type: 7` messages, and — with
 * `keyboard` — `button button-group` hoisted into `keyboard.content.rows` (see `keyboard.ts`).
 *
 * `code` becomes a backtick span and `pre` a fenced block whose body is copied verbatim: nothing inside a code span or
 * fence is escaped, collapsed or padded with `\u200B`. A table the core fallback can lay out as a monospace grid
 * therefore reaches the chat as a fenced grid, which is the only form QQ keeps aligned — its markdown has no tables.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/modes/markdown
 */

import { type Element, isPhrasingContainer } from '@deepseek-ai/satori-element'
import { defineMode, ElementRegistry, type Mode, type RenderContext } from '@deepseek-ai/cordis-plugin-im-core'
import { buttonGroupNodes, buttonNode } from '../keyboard.ts'
import {
  assemble, BLOCK, block, codeSpan, escapeMarkdown, fenceBlock, flattenRuns, mapRuns, markdownUrl, mediaNode, modeBase,
  type InlineImageNode, type QqModeSettings, type QqNode, type QqTypes, trimNewlines, verbatim, wrapInline,
} from './shared.ts'
import { linkFallback } from './text.ts'

/** Info string of a fence: what QQ may use to highlight, minus anything that would end the fence line. */
const infoString = (lang: string) => lang.replace(/[^\w+#.-]/g, '')

/**
 * `<img>` as a markdown image inside the message body.
 *
 * QQ fetches the picture itself and renders it only with both pixel dimensions, so the node keeps the element's size
 * (absent means `0px`, the source size) and the assembled body carries a placeholder that `serialize` fills with the
 * uploaded `qqbot-media://` reference. Keeping it here rather than in its own `msg_type: 7` message leaves the answer
 * one message — and one passive reply — instead of splitting the text around the picture.
 *
 * @param el - the `<img>` element.
 * @param ctx - render context, for the resource and the report.
 * @returns the block holding the image node.
 */
function image(el: Element<'img'>, ctx: RenderContext<QqTypes>): QqNode[] {
  const attrs = el.attrs as { src: string; alt?: string; width?: number; height?: number }
  const meta: { name?: string; width?: number; height?: number } = {}
  if (attrs.alt !== undefined) meta.name = attrs.alt
  if (attrs.width !== undefined) meta.width = attrs.width
  if (attrs.height !== undefined) meta.height = attrs.height
  const node: InlineImageNode = {
    kind: 'image',
    ref: ctx.resource('image', attrs.src, meta),
    alt: attrs.alt ?? '',
    ...attrs.width === undefined ? {} : { width: attrs.width },
    ...attrs.height === undefined ? {} : { height: attrs.height },
  }
  // Inside a sentence the picture stays in that sentence; standing on its own it takes its own paragraph.
  const parent = ctx.ancestors[ctx.ancestors.length - 1]
  return parent !== undefined && isPhrasingContainer(parent.type) ? [node] : [BLOCK, node, BLOCK]
}

/** `ul`/`ol`: each `<li>` rendered on its own line with its marker; continuation lines indented, code included. */
function list(el: Element<'ul' | 'ol'>, ctx: RenderContext<QqTypes>): QqNode[] {
  const out: QqNode[] = [BLOCK]
  let n = el.type === 'ol' ? (el.attrs as { start?: number }).start ?? 1 : 1
  let first = true
  for (const child of el.children) {
    if (child.type !== 'li') continue
    const marker = el.type === 'ol' ? `${n++}. ` : '- '
    const indent = ' '.repeat(marker.length)
    const lines = flattenRuns(ctx.render([child]), text => trimNewlines(text.replace(/\n+/g, '\n')))
    if (!first) out.push('\n')
    first = false
 // Every line takes the marker or the indent, a fenced block's included: a fence that starts mid-line is not a fence.
    out.push(lines.map((line, index) => `${index === 0 ? marker : indent}${line.text}`).join('\n'))
  }
  out.push(BLOCK)
  return out
}

/**
 * The `<qqbot-at-everyone />` text-chain tag of QQ.
 *
 * QQ reads these tags only inside a markdown body (`msg_type: 2`) — a plain text body shows them verbatim — which is
 * why only this mode declares `<at>`. A message carrying a mention therefore prices the text mode's readable `@name`
 * fallback and resolves to markdown.
 */
const MENTION_ALL = '<qqbot-at-everyone />'

/**
 * The `<qqbot-at-user>` tag of one person.
 * @param id - platform user id (the member's `member_openid` in a group).
 * @returns the tag, or an empty string for an id that names nobody.
 */
function mentionTagOf(id: string) {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '')
  return safe ? `<qqbot-at-user id="${safe}" />` : ''
}

/** Build the `markdown` mode. */
export function createMarkdownMode(settings: QqModeSettings): Mode<QqTypes> {
  const linkText = (label: string, href: string) => settings.linkPolicy === 'keep'
    ? `[${escapeMarkdown(label)}](${markdownUrl(href)})`
    : escapeMarkdown(label)

  const elements = new ElementRegistry<QqTypes>()
    .register('text', el => escapeMarkdown(el.attrs.content))
    .register('p', (el, ctx) => block(ctx.render(el.children)))
    .register('br', () => '\n')
    .register('at', el => el.attrs.type === 'all' ? MENTION_ALL : mentionTagOf(el.attrs.id ?? ''), {
      variants: ['user', 'all'],
    })
    .register('b', (el, ctx) => wrapInline(ctx.render(el.children), '**', '**'))
    .register('i', (el, ctx) => wrapInline(ctx.render(el.children), '*', '*'))
    .register('s', (el, ctx) => wrapInline(ctx.render(el.children), '~~', '~~'))
    .register('code', (el, ctx) => codeSpan(ctx.text(el.children)))
    .register('h1', (el, ctx) => block(ctx.render(el.children), text => `# ${text.replace(/\n+/g, ' ')}`))
    .register('h2', (el, ctx) => block(ctx.render(el.children), text => `## ${text.replace(/\n+/g, ' ')}`))
    .register('ul', list)
    .register('ol', list)
    .register('li', (el, ctx) => ctx.render(el.children), { variants: ['nested'] })
    .register('blockquote', (el, ctx) => {
      const lines = flattenRuns(ctx.render(el.children), text => trimNewlines(text.replace(/\n{3,}/g, '\n\n')), '\n\n')
 // Every line is quoted, a fenced block's included, or the fence ends the quote and its closing marker joins the
 // next block.
      const quoted = lines.map(line => line.literal || line.text.trim() ? `> ${line.text}` : '>').join('\n')
      return [BLOCK, quoted, BLOCK]
    })
    .register('pre', (el, ctx) => {
      const body = ctx.text(el.children)
      if (!body.trim()) return []
      const lang = el.attrs.lang
      return [BLOCK, verbatim(fenceBlock(body, lang ? infoString(lang) : undefined)), BLOCK]
    }, { variants: ['lang'] })
    .register('hr', () => [BLOCK, '***', BLOCK])
    .register('img', image, { variants: ['inline'] })
    .register('audio', mediaNode)
    .register('video', mediaNode)
    .register('file', mediaNode)
    .fallback('a', linkFallback(settings))
 // Config-dependent tags: register() mutates the registry, the cast only widens the compile-time tag set.
  const open = elements as unknown as ElementRegistry<QqTypes, never>

  if (settings.linkPolicy === 'keep') {
    open.register('a', (el, ctx) => {
      const nodes = ctx.render(el.children)
      const url = markdownUrl(el.attrs.href)
      if (!ctx.text(el.children).trim()) return `[${escapeMarkdown(el.attrs.href)}](${url})`
      return mapRuns(nodes, text => `[${text}](${url})`)
    })
  }
  if (settings.keyboard) {
    open
      .register('button', (el, ctx) => buttonNode(el, ctx, linkText, escapeMarkdown), {
        variants: ['action', 'link', 'input', 'theme', 'inline'],
      })
      .register('button-group', buttonGroupNodes)
  }

  return defineMode<QqTypes>()({
    ...modeBase('markdown', settings),
    elements,
    assemble: (nodes, _envelope, ctx) => assemble(nodes, ctx, settings),
  })
}
