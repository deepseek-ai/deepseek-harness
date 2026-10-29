/**
 * Markdown input: GFM markdown → elements, expanded by `normalize` for `<markdown>` / `h.markdown`.
 *
 * Adapters never see markdown source; each mode serializes its own dialect from the elements produced here (with its
 * own escaping), so this converter is the single place that knows the CommonMark/GFM syntax.
 *
 * Mapping: heading → `h1`…`h6`, emphasis/strong/delete → `i`/`b`/`s`, inlineCode → `code`, code → `pre[lang]`,
 * list/listItem → `ul`/`ol`/`li[checked]`, blockquote → `blockquote`, thematicBreak → `hr`,
 * table/tr/th/td with `align`, link → `a`, image → `img`, html → `text`, hard break → `br`.
 *
 * Conventions kept deliberately small and lossless:
 * - a soft line break (a single newline inside a paragraph) also becomes `<br>`: chat markdown is line-oriented, and
 *   collapsing it to a space would silently drop the author's line structure;
 * - a paragraph that holds nothing but one image becomes a bare block-level `<img>`, so `img.inline`
 *   keeps meaning "image inside phrasing content";
 * - reference links/images resolve against the document's link reference definitions;
 * - unsupported constructs degrade to their children (or to their literal text) instead of throwing: the input is user
 *   content, and `normalize` validates the result anyway.
 */

import { fromMarkdown as parseMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Code, List, ListItem, Nodes, PhrasingContent, RootContent, Table } from 'mdast'
import { make } from './factory.ts'
import type { Element } from './vocabulary.ts'

/** Link reference definitions of one document: normalized identifier → target URL. */
type References = ReadonlyMap<string, string>

/** Parse GFM markdown into an mdast tree (GFM = autolink, strikethrough, table, task list, footnote). */
function parse(source: string) {
  return parseMarkdown(source.replace(/\r\n?/g, '\n'), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
}

/** Convert markdown source into v4 block-level elements (never a `<message>`; `normalize` adds the envelope). */
export function fromMarkdown(source: string): Element[] {
  const root = parse(String(source ?? ''))
  return blocks(root.children, references(root.children))
}

function text(content: string): Element {
  return make('text', { content }, [])
}

/** Literal text, with each newline becoming `<br>` (text conservation: no character is dropped). */
function pushText(out: Element[], value: unknown) {
  const lines = String(value ?? '').split('\n')
  lines.forEach((line, index) => {
    if (index) out.push(make('br', {}, []))
    if (line) out.push(text(line))
  })
}

/** Collect `[id]: url` definitions, wherever they stand in the document. */
function references(nodes: readonly RootContent[], out: Map<string, string> = new Map()): References {
  for (const node of nodes) {
    if (node.type === 'definition') {
      if (!out.has(node.identifier)) out.set(node.identifier, node.url)
      continue
    }
    const children = (node as unknown as { children?: readonly RootContent[] }).children
    if (Array.isArray(children)) references(children, out)
  }
  return out
}

function blocks(nodes: readonly RootContent[], refs: References): Element[] {
  const out: Element[] = []
  for (const node of nodes) pushBlock(out, node, refs)
  return out
}

function pushBlock(out: Element[], node: RootContent, refs: References) {
  switch (node.type) {
    case 'paragraph': {
      const children = phrasing(node.children, refs)
      const media = standaloneMedia(children)
      if (media) out.push(media)
      else if (children.length) out.push(make('p', {}, children))
      return
    }
    case 'heading': {
      const depth = Math.min(6, Math.max(1, node.depth))
      out.push(make(`h${depth}`, {}, phrasing(node.children, refs)))
      return
    }
    case 'thematicBreak':
      out.push(make('hr', {}, []))
      return
    case 'code':
      out.push(code(node))
      return
    case 'blockquote':
      out.push(make('blockquote', {}, blocks(node.children, refs)))
      return
    case 'list':
      out.push(list(node, refs))
      return
    case 'table':
      out.push(table(node, refs))
      return
    case 'html':
      // Raw HTML degrades to its literal text; `normalize` wraps it into a <p>.
      pushText(out, node.value)
      return
    case 'definition':
      // Link reference definitions only feed references; they carry no content of their own.
      return
    case 'footnoteDefinition':
      // Footnotes are not a v4 construct: keep their blocks as ordinary content (the `[^label]` marker survives as
      // the literal text of a `footnoteReference`).
      out.push(...blocks(node.children, refs))
      return
    default:
      // Unknown block: keep the content (never throw on user input).
      pushUnknown<RootContent>(out, node as Nodes, children => blocks(children, refs))
  }
}

/** Degrade an unsupported node to its children, or to its literal text when it has neither. */
function pushUnknown<T>(out: Element[], node: Nodes, convert: (children: readonly T[]) => Element[]) {
  const unknown = node as unknown as { children?: readonly T[]; value?: unknown }
  if (Array.isArray(unknown.children) && unknown.children.length) out.push(...convert(unknown.children))
  else if (typeof unknown.value === 'string') pushText(out, unknown.value)
}

/** A paragraph that consists of nothing but one image yields the (block-level) media element itself. */
function standaloneMedia(children: Element[]): Element | undefined {
  const meaningful = children.filter(child => !(child.type === 'text' && !String(child.attrs.content ?? '').trim()))
  return meaningful.length === 1 && meaningful[0]!.type === 'img' ? meaningful[0] : undefined
}

function code(node: Code): Element {
  const lang = node.lang ? { lang: node.lang } : {}
  return make('pre', lang, node.value ? [text(node.value)] : [])
}

function list(node: List, refs: References): Element {
  const items = node.children.map(item => listItem(item, refs))
  if (!node.ordered) return make('ul', {}, items)
  const start = typeof node.start === 'number' && node.start !== 1 ? { start: node.start } : {}
  return make('ol', start, items)
}

function listItem(node: ListItem, refs: References): Element {
  // GFM task list: `checked` is `null` for ordinary items, `true`/`false` for `- [x]` / `- [ ]`.
  const attrs = typeof node.checked === 'boolean' ? { checked: node.checked } : {}
  return make('li', attrs, blocks(node.children, refs))
}

function table(node: Table, refs: References): Element {
  const align = node.align ?? []
  const rows = node.children.map((row, rowIndex) => {
    const cells = row.children.map((cell, column) => {
      const tag = rowIndex === 0 ? 'th' : 'td'
      const value = align[column]
      return make(tag, value ? { align: value } : {}, phrasing(cell.children, refs))
    })
    return make('tr', {}, cells)
  })
  return make('table', {}, rows)
}

function phrasing(nodes: readonly PhrasingContent[], refs: References): Element[] {
  const out: Element[] = []
  for (const node of nodes) pushInline(out, node, refs)
  return out
}

function pushInline(out: Element[], node: PhrasingContent, refs: References) {
  switch (node.type) {
    case 'text':
      pushText(out, node.value)
      return
    case 'emphasis':
      out.push(make('i', {}, phrasing(node.children, refs)))
      return
    case 'strong':
      out.push(make('b', {}, phrasing(node.children, refs)))
      return
    case 'delete':
      out.push(make('s', {}, phrasing(node.children, refs)))
      return
    case 'inlineCode':
      out.push(make('code', {}, [text(node.value)]))
      return
    case 'break':
      out.push(make('br', {}, []))
      return
    case 'link': {
      const children = phrasing(node.children, refs)
      // `<a>` requires a non-empty href; an unresolvable link degrades to its label.
      if (!node.url) out.push(...children)
      else out.push(make('a', { href: node.url }, children))
      return
    }
    case 'linkReference': {
      const children = phrasing(node.children, refs)
      const href = refs.get(node.identifier)
      if (href) out.push(make('a', { href }, children))
      else out.push(...children)
      return
    }
    case 'image': {
      if (!node.url) {
        pushText(out, node.alt ?? '')
        return
      }
      out.push(image(node.url, node.alt))
      return
    }
    case 'imageReference': {
      const src = refs.get(node.identifier)
      if (src) out.push(image(src, node.alt))
      else pushText(out, node.alt ?? '')
      return
    }
    case 'html':
      pushText(out, node.value)
      return
    case 'footnoteReference':
      pushText(out, `[^${node.label ?? node.identifier}]`)
      return
    default:
      pushUnknown<PhrasingContent>(out, node as Nodes, children => phrasing(children, refs))
  }
}

function image(src: string, alt: string | null | undefined): Element {
  // `title` is not part of the vocabulary (ElementMap.img); adapters use `alt` as the accessible label.
  return make('img', alt ? { src, alt } : { src }, [])
}
