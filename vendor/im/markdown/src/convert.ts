/**
 * GFM markdown → Satori elements: the one place in the IM stack that knows the markdown syntax.
 *
 * Adapters never see markdown source; each mode serializes its own dialect from the elements produced here (with its
 * own escaping).
 *
 * Pipeline, and why it has these stages:
 * - **mdast** (`mdast-util-from-markdown` + GFM) is where the markdown syntax lives;
 * - **hast** (`mdast-util-to-hast`) is the HTML-shaped tree raw HTML can be spliced into — markdown has no node for
 *   `<u>x</u>`, so a syntax extension per tag is not the answer;
 * - **hast with real elements** (`hast-util-raw`, i.e. parse5) parses the HTML that markdown carried as opaque text:
 *   it pairs tags, decodes entities and tolerates everything HTML authoring is allowed to be sloppy about;
 * - **Satori elements** are the last step here, and they are vocabulary-driven: `elementInfo` says which tags exist,
 *   what each may contain and which attributes it requires, `tagAliases` maps HTML spellings onto them. `**x**`,
 *   `<u>x</u>`, `<spoiler>x</spoiler>` and every other registered element therefore take one path.
 *
 * What markdown may express is the content half of the vocabulary: an element whose category is inline, block or
 * media. An interactive element (`button`, `input`, `select`, `form`), a renderer directive (`fallback`, `case`) or an
 * inbound wrapper (`raw`, `forward`) cannot be authored — its children are kept as text instead, because a message
 * must not hand a reader a control its sender never sent.
 *
 * Conventions kept deliberately small and lossless:
 * - a soft line break (a single newline inside a paragraph) also becomes `<br>`: chat markdown is line-oriented, and
 *   collapsing it to a space would silently drop the author's line structure;
 * - a paragraph that holds nothing but one image becomes a bare block-level `<img>`, so `img.inline`
 *   keeps meaning "image inside phrasing content";
 * - an element the vocabulary gives no content (`at`, `channel`, `emoji`) holds its label in `name`, and HTML parses
 *   `<at id=ou_x />` as an *open* tag: such a tag is closed explicitly before parsing, and its text keeps becoming the
 *   label;
 * - a block element on a line of its own becomes that block, while the same element written inside a sentence keeps
 *   its text: inline HTML is always phrasing, and the vocabulary's `normalize` refuses a whole message for one block
 *   element standing in phrasing content, so the text is what the reader keeps instead of losing the turn;
 * - footnote markers and definitions are flattened before the HTML stage, because GFM's footnote HTML (a `<sup>`
 *   reference and an end-of-document list) is not what a chat message should show;
 * - unsupported constructs degrade to their children (or to their literal text) instead of throwing: the input is user
 *   content, and the render engine normalizes the result anyway.
 */

import { fromMarkdown as parseMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { toHast } from 'mdast-util-to-hast'
import { raw } from 'hast-util-raw'
import type { Element as HastElement, Root as HastRoot, RootContent as HastNode } from 'hast'
import type { RootContent } from 'mdast'
import {
  type Category, type Element, elementInfo, h, isTag, tagAliases, type Tag,
} from '@deepseek-ai/satori-element'

/** `h` over a tag computed at run time; every tag still comes from the vocabulary. */
const build = h as unknown as (type: string, attrs: Record<string, unknown>, ...children: Element[]) => Element

/** Element categories markdown may author: what a message says, not what a reader can operate. */
const CONTENT: ReadonlySet<Category> = new Set<Category>(['inline', 'block', 'media'])

/** Tags whose empty content model takes its label from the text it wraps (`<at id=ou_x>张三</at>`). */
const LABELLED: ReadonlySet<Tag> = new Set<Tag>(['at', 'channel', 'emoji'])

/** A Satori text element. */
function text(content: string): Element {
  return h.text(content)
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown source → mdast

/** Line endings as the parser's offsets count them. */
function normalizeNewlines(source: string): string {
  return source.replace(/\r\n?/g, '\n')
}

/** Parse GFM markdown into an mdast tree (GFM = autolink, strikethrough, table, task list, footnote). */
function parse(source: string) {
  return parseMarkdown(normalizeNewlines(source), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
}

/**
 * Convert markdown source into block-level elements (never a `<message>`).
 *
 * @param source - GFM markdown, raw HTML included.
 * @returns the blocks of the document.
 */
export function fromMarkdown(source: string): Element[] {
  const tree = parse(String(source ?? ''))
  // `raw` is typed over every hast node; a root goes in and a root comes out.
  const hast = raw(toHast({ ...tree, children: prepare(tree.children) }, { allowDangerousHtml: true })) as HastRoot
  return convert(hast.children, undefined)
}

/**
 * The part of a document still being written that later text cannot change: everything before its last top-level
 * block.
 *
 * CommonMark parses blocks line by line, so text appended to a document can only reshape its last block (a paragraph
 * turning into a setext heading or a table, a list continuing, an emphasis, a code span or a fence closing); every
 * block before it is final. A link reference definition is the exception: one that arrives after the cut resolves a
 * reference above it only in the complete document.
 *
 * @param source - a prefix of a markdown document.
 * @returns the source of its settled blocks without trailing whitespace; `''` while the first block is still open.
 */
export function settledMarkdown(source: string): string {
  const normalized = normalizeNewlines(source)
  const end = parse(normalized).children.at(-1)?.position?.start.offset
  return end === undefined ? '' : normalized.slice(0, end).trimEnd()
}

// ---------------------------------------------------------------------------------------------------------------
// mdast preparation: what must not reach the HTML stage

/** A self-closing tag (`<at id=ou_x />`); an attribute value may itself carry `>`. */
const SELF_CLOSING = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/>/g

/**
 * The vocabulary tag a spelled name stands for (`strong` → `b`, `ins` → `u`, `at` → `at`).
 *
 * @param name - the tag name as the author spelled it.
 * @returns the tag, or undefined when the vocabulary has none for it.
 */
function resolveTag(name: string): Tag | undefined {
  const lower = name.toLowerCase()
  // `tagAliases` is a plain object: `constructor` and the other inherited names are not spellings of a tag.
  if (Object.hasOwn(tagAliases, lower)) return tagAliases[lower]
  return isTag(lower) ? lower : undefined
}

/** Whether `tag` holds content a message may say rather than a control a reader operates. */
function isContent(tag: Tag): boolean {
  return CONTENT.has(elementInfo[tag].category)
}

/**
 * Close every self-closing tag whose vocabulary element cannot hold children.
 *
 * HTML ignores the `/` of `<at id=ou_x />` and nests everything after it inside that element; the element's content
 * model says it holds nothing, so the empty form is written as `<at id=ou_x></at>` before parsing.
 *
 * @param value - one raw HTML run as markdown carried it.
 * @returns the same run with empty-content elements closed explicitly.
 */
function closeEmpty(value: string): string {
  return value.replace(SELF_CLOSING, (whole, name: string, attrs: string) => {
    const tag = resolveTag(name)
    return tag !== undefined && elementInfo[tag].content === 'empty' ? `<${name}${attrs}></${name}>` : whole
  })
}

/**
 * Rewrite the mdast children a chat message must not render as GFM's own HTML: footnote markers and definitions
 * become the literal marker plus the definition's blocks, and raw HTML runs are prepared for the HTML stage.
 *
 * @param nodes - mdast children.
 * @returns the same content with those constructs flattened.
 */
function prepare(nodes: readonly RootContent[]): RootContent[] {
  const out: RootContent[] = []
  for (const node of nodes) {
    if (node.type === 'footnoteReference') {
      out.push({ type: 'text', value: `[^${node.label ?? node.identifier}]` })
      continue
    }
    if (node.type === 'footnoteDefinition') {
      out.push(...prepare(node.children))
      continue
    }
    if (node.type === 'html') {
      out.push({ ...node, value: closeEmpty(node.value) })
      continue
    }
    const children = (node as unknown as { children?: RootContent[] }).children
    if (Array.isArray(children) && children.length) out.push({ ...node, children: prepare(children) } as RootContent)
    else out.push(node)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// hast → Satori elements

/** Whether `node` is a hast element. */
function isElement(node: HastNode): node is HastElement {
  return node.type === 'element'
}

/**
 * Attribute values of one hast element: the plain ones (parse5 keeps an unknown attribute of a raw tag verbatim),
 * which is how `<span color="red">` reaches `span[color]`.
 */
function attrsOf(tag: Tag, properties: HastElement['properties'] | undefined): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
    if (typeof value === 'string' && !value) continue
    attrs[key] = value
  }
  if (tag === 'at') {
    // Feishu spells the id `user_id`; the vocabulary spells it `id`.
    if (attrs.id === undefined && typeof attrs.user_id === 'string') attrs.id = attrs.user_id
    delete attrs.user_id
    attrs.type ??= 'user'
    // Feishu spells "everyone" as the id `all`. Written that way it is the `all` mention, not a user whose id happens
    // to be `all`: a mode decides whether to render a mention from its `type`, and `allowAtAll: false` only withholds
    // the `all` variant, so a `user` carrying that id would reach the platform as @everyone.
    if (attrs.type === 'user' && (attrs.id === 'all' || attrs.id === 'here')) {
      attrs.type = attrs.id
      delete attrs.id
    }
  }
  return attrs
}

/** The language of a fence: the `language-…` class markdown put on its `<code>`. */
function languageOf(properties: HastElement['properties'] | undefined): string | undefined {
  const classes = (properties ?? {}).className
  if (!Array.isArray(classes)) return undefined
  for (const name of classes) {
    if (typeof name !== 'string') continue
    const match = /^language-(.+)$/.exec(name)
    if (match) return match[1]
  }
  return undefined
}

/** Every text run of one hast subtree, in order. */
function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value
  if (!isElement(node)) return ''
  return node.children.map(hastText).join('')
}

/** Whether a container's content is elements only, so the whitespace between them is layout rather than content. */
function isStructural(tag: Tag | undefined): boolean {
  return tag !== undefined && elementInfo[tag].content !== 'phrasing' && elementInfo[tag].content !== 'text'
}

/**
 * The one element of a container whose other children are whitespace, if that is all it holds.
 *
 * @param children - hast children.
 * @returns the sole element, or undefined when the container holds text or several elements.
 */
function soleElement(children: readonly HastNode[]): HastElement | undefined {
  const meaningful = children.filter(child => !(child.type === 'text' && !child.value.trim()))
  const [only] = meaningful
  return meaningful.length === 1 && only !== undefined && isElement(only) ? only : undefined
}

/**
 * The block-level element a paragraph is made of, when it is made of one: markdown writes inline HTML, so
 * `<small>…</small>` on a line of its own arrives as the only child of a paragraph.
 *
 * @param children - the paragraph's hast children.
 * @returns the block element, or undefined when the paragraph is anything else.
 */
function soleBlock(children: readonly HastNode[]): HastElement | undefined {
  const only = soleElement(children)
  if (only === undefined) return undefined
  const tag = resolveTag(only.tagName)
  return tag !== undefined && isContent(tag) && elementInfo[tag].position === 'block' ? only : undefined
}

/**
 * Convert hast children into Satori elements.
 *
 * @param nodes - hast children.
 * @param parent - tag of the container they stand in, when that is a vocabulary tag.
 * @returns the elements; a tag this vocabulary has no content element for contributes its children instead.
 */
function convert(nodes: readonly HastNode[], parent: Tag | undefined): Element[] {
  const out: Element[] = []
  for (const [index, node] of nodes.entries()) {
    if (node.type === 'text') {
      const verbatim = parent !== undefined && elementInfo[parent].content === 'text'
      pushText(out, verbatim ? node.value : trimLineEdges(node.value, nodes[index - 1], nodes[index + 1]), parent)
      continue
    }
    if (!isElement(node)) continue
    out.push(...element(node, parent))
  }
  return out
}

/** HTML elements that end a line by themselves, besides the vocabulary's block elements. */
const HTML_BLOCKS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figure', 'footer', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/**
 * Whether a sibling of a text run already ends the line on its side: a `<br>`, a block element, or the edge of the
 * container (`undefined`). The newline the source writes next to it is that same line end, not another one.
 */
function endsLine(node: HastNode | undefined): boolean {
  if (node === undefined) return true
  if (!isElement(node)) return false
  if (node.tagName === 'br' || HTML_BLOCKS.has(node.tagName)) return true
  const tag = resolveTag(node.tagName)
  return tag !== undefined && elementInfo[tag].position === 'block'
}

/**
 * Drop the newline at either end of a text run whose neighbour already ends the line there (`a<br>\nb`, `a\n<ul>`, the
 * first and last line of `<div>\nraw\n</div>`). A newline next to inline content stays, and becomes a break.
 */
function trimLineEdges(value: string, before: HastNode | undefined, after: HastNode | undefined): string {
  let start = 0
  let end = value.length
  if (endsLine(before) && value.startsWith('\n')) start = 1
  if (endsLine(after) && end > start && value.endsWith('\n')) end -= 1
  return value.slice(start, end)
}

/** One text run: a newline becomes `<br>`, except where the element holds text verbatim. */
function pushText(out: Element[], value: string, parent: Tag | undefined): void {
  const verbatim = parent !== undefined && elementInfo[parent].content === 'text'
  if (verbatim) {
    if (value) out.push(text(value))
    return
  }
  // Whitespace between blocks (at the top level, or in a container of elements) is layout, not content.
  if (!value.trim() && (parent === undefined || isStructural(parent))) return
  // Every newline is a break, including one at either end of the run: in `first\n**second**\nthird` the breaks are
  // the last character of `first\n` and the first of `\nthird`, so the empty pieces a split leaves there still count.
  value.split('\n').forEach((line, index) => {
    if (index) out.push(h('br'))
    if (line) out.push(text(line))
  })
}

/**
 * Take a task-list checkbox off an item: the state belongs to the `<li>`, and no reader operates a disabled `<input>`.
 *
 * @param children - the item's hast children.
 * @returns the state (absent when the item carries no checkbox) and the remaining children, label first.
 */
function takeCheckbox(children: HastElement['children']): { checked?: boolean; children: HastElement['children'] } {
  const [first, ...rest] = children
  if (!first || !isElement(first) || first.tagName !== 'input' || first.properties?.type !== 'checkbox') {
    return { children }
  }
  const [head, ...tail] = rest
  // The whitespace that separated the box from the label is markup, not text: drop it so the label starts the item.
  const trimmed = head?.type === 'text' ? [{ ...head, value: head.value.trimStart() }, ...tail] : rest
  return { checked: first.properties.checked === true, children: trimmed }
}

/**
 * The label of an element that has no children: the text an author wrapped it around, when that is all it wrapped.
 *
 * @param content - the element's converted children.
 * @returns the label, or undefined when the element carries anything but text.
 */
function labelOf(content: readonly Element[]): string | undefined {
  if (!content.length || !content.every(child => child.type === 'text')) return undefined
  const label = content.map(child => String(child.attrs.content ?? '')).join('').trim()
  return label ? label : undefined
}

/**
 * Convert one hast element.
 *
 * @param node - the element.
 * @param parent - tag of its container, when that is a vocabulary tag.
 * @returns the elements it stands for (more than one when children are hoisted out of it).
 */
function element(node: HastElement, parent: Tag | undefined): Element[] {
  const tag = resolveTag(node.tagName)
  if (tag === undefined || !isContent(tag)) return convert(node.children, parent)
  const info = elementInfo[tag]

  // A fence: markdown emits `<pre><code class="language-…">`, while the vocabulary holds `pre[lang]` of plain text.
  if (tag === 'pre') {
    const code = node.children.find(child => isElement(child) && child.tagName === 'code')
    const source = code ?? node
    const lang = languageOf(isElement(source) ? source.properties : undefined)
    const body = hastText(source).replace(/\n$/, '')
    const attrs = { ...attrsOf(tag, node.properties), ...lang === undefined ? {} : { lang } }
    return [build(tag, attrs, ...body ? [text(body)] : [])]
  }

  let children = node.children
  let checked: boolean | undefined
  if (tag === 'li') ({ checked, children } = takeCheckbox(children))
  const attrs = attrsOf(tag, node.properties)
  if (checked !== undefined) attrs.checked = checked
  // An element whose required attribute did not survive is not that element: its text is all that remains.
  if ((info.required ?? []).some(key => attrs[key] === undefined || attrs[key] === '')) return convert(node.children, parent)

  // A paragraph holding one block-level element is that block: markdown writes inline HTML, so `<small>…</small>` on a
  // line of its own arrives as the only content of a paragraph, and the vocabulary has `small` at flow level.
  if (tag === 'p') {
    const block = soleBlock(children)
    if (block !== undefined) return element(block, undefined)
  }

  // A block element inside a sentence, or a list item outside its list, is refused by `normalize` as a whole message:
  // the text is what the reader keeps instead of losing the turn.
  if (info.position === 'block' && parent !== undefined && !isStructural(parent)) return convert(node.children, parent)
  if (info.parents !== undefined && (parent === undefined || !info.parents.includes(parent))) {
    return convert(node.children, parent)
  }

  const content = convert(children, tag)
  // A paragraph that is nothing but an image is that (block-level) picture: `img.inline` means "inside a sentence".
  if (tag === 'p' && content.length === 1 && content[0]!.type === 'img') return content

  if (info.content !== 'empty') return [build(tag, attrs, ...content)]

  // The element holds no children: text wrapped around a labelled one is its label, and anything else follows it.
  const label = LABELLED.has(tag) && attrs.name === undefined ? labelOf(content) : undefined
  if (label === undefined) return [build(tag, attrs), ...content]
  return [build(tag, { ...attrs, name: label })]
}
