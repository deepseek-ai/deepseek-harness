/** Shared Markdown parsing and depth-first traversal for documentation gates. */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'

/** One authored Markdown line outside fenced code and rendered-away HTML comments. */
export interface MarkdownProseLine {
  /** 1-based source line number. */
  index: number
  /** Source text without normalization. */
  raw: string
}

/** One parsed Markdown heading, retaining its authored first line and rendered text. */
export interface MarkdownHeadingLine extends MarkdownProseLine {
  /** Parsed ATX or Setext heading depth. */
  depth: 1 | 2 | 3 | 4 | 5 | 6
  /** Rendered heading text, excluding raw HTML such as comments. */
  text: string
}

/** One code block from a parsed Markdown source. */
export interface MarkdownFence {
  /** 1-based source line of the opening fence. */
  line: number
  /** Info-string language (its first word), null on a bare or indented block. */
  lang: string | null
  /** Full info string (e.g. `ts ignore-check`), '' on a bare or indented block. */
  info: string
  /** Block body without the fence delimiters. */
  code: string
  /**
   * Whether a closing fence delimiter terminates the block — mdast silently
   * closes an unterminated fence at end of file. False on indented
   * (non-fenced) blocks, whose end line is code.
   */
  closed: boolean
}

/** Parse GitHub-flavored Markdown with the repository's standard extensions. */
export function parseMarkdown(source: string): Nodes {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

/**
 * Visit a Markdown tree depth-first; returning false prunes a node's children.
 * @param node - current tree node.
 * @param visitor - callback invoked before each node's children.
 */
export function visitMarkdown(node: Nodes, visitor: (node: Nodes) => boolean | void): void {
  if (visitor(node) === false) return
  if ('children' in node) {
    for (const child of node.children) visitMarkdown(child, visitor)
  }
}

/** Markdown nodes whose authored destination occupies a replaceable source range. */
export type MarkdownDestinationNode = Extract<Nodes, { type: 'link' | 'image' | 'definition' }>

/** One authored Markdown destination and its absolute source offsets. */
export interface MarkdownDestination {
  start: number
  end: number
  url: string
}

/** Whether a Markdown URL is external, repository-root absolute, or purely in-page. */
export function isExternalOrAbsoluteMarkdownUrl(url: string): boolean {
  return url.startsWith('#')
    || url.startsWith('//')
    || url.startsWith('/')
    || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

/** Split one Markdown URL without normalizing its query or fragment suffix. */
export function splitMarkdownUrlTarget(url: string): { path: string; suffix: string } {
  const boundary = url.search(/[?#]/)
  if (boundary === -1) return { path: url, suffix: '' }
  return { path: url.slice(0, boundary), suffix: url.slice(boundary) }
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (/\s/.test(source[index] ?? '')) index += 1
  return index
}

function labelEnd(source: string): number {
  const first = source.indexOf('[')
  if (first === -1) return -1
  let depth = 0
  for (let index = first; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') index += 1
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function destinationRange(rawNode: string, type: MarkdownDestinationNode['type']): { start: number; end: number } {
  const endOfLabel = labelEnd(rawNode)
  if (endOfLabel === -1) throw new Error(`markdown: cannot locate label end in ${JSON.stringify(rawNode)}`)
  let start: number
  if (type === 'definition') {
    const colon = rawNode.indexOf(':', endOfLabel + 1)
    if (colon === -1) throw new Error(`markdown: cannot locate definition separator in ${JSON.stringify(rawNode)}`)
    start = skipWhitespace(rawNode, colon + 1)
  } else {
    if (rawNode[endOfLabel + 1] !== '(') {
      throw new Error(`markdown: cannot locate inline destination in ${JSON.stringify(rawNode)}`)
    }
    start = skipWhitespace(rawNode, endOfLabel + 2)
  }
  if (rawNode[start] === '<') {
    for (let index = start + 1; index < rawNode.length; index += 1) {
      if (rawNode[index] === '\\') index += 1
      else if (rawNode[index] === '>') return { start: start + 1, end: index }
    }
    throw new Error(`markdown: cannot locate angle-bracket destination end in ${JSON.stringify(rawNode)}`)
  }
  let depth = 0
  for (let index = start; index < rawNode.length; index += 1) {
    const char = rawNode[index]
    if (char === '\\') index += 1
    else if (char === '(') depth += 1
    else if (char === ')') {
      if (depth === 0) return { start, end: index }
      depth -= 1
    } else if (/\s/.test(char ?? '') && depth === 0) {
      return { start, end: index }
    }
  }
  return { start, end: rawNode.length }
}

/** Locate one parsed destination in the original Markdown without reserializing it. */
export function markdownDestination(source: string, node: MarkdownDestinationNode): MarkdownDestination {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) {
    throw new Error(`markdown: destination ${JSON.stringify(node.url)} has no source offsets`)
  }
  const range = destinationRange(source.slice(start, end), node.type)
  const absolute = { start: start + range.start, end: start + range.end }
  return { ...absolute, url: source.slice(absolute.start, absolute.end) }
}

/**
 * Extract every parsed code block with its info string, in document order.
 * @param source - Markdown source to scan.
 * @returns each block's opening line, language, info string, and body.
 */
export function markdownFences(source: string): MarkdownFence[] {
  const lines = source.split('\n')
  const fences: MarkdownFence[] = []
  visitMarkdown(parseMarkdown(source), (node) => {
    if (node.type !== 'code' || node.position === undefined) return
    const lang = node.lang ?? null
    const meta = node.meta ?? ''
    const info = lang === null ? '' : meta === '' ? lang : `${lang} ${meta}`
    const endLine = lines[node.position.end.line - 1] ?? ''
    const closed = /^ {0,3}(`{3,}|~{3,})\s*$/.test(endLine)
    fences.push({ line: node.position.start.line, lang, info, code: node.value, closed })
  })
  return fences
}

/** Text a reader sees from one Markdown node; raw HTML itself contributes none. */
function renderedText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  if (node.type === 'break') return ' '
  if ('children' in node) return node.children.map(child => renderedText(child)).join('')
  return ''
}

/**
 * Return every parsed Markdown heading with its rendered text and source line.
 * @param source - Markdown source whose headings are returned.
 * @param tree - the {@link parseMarkdown} result for exactly `source`, when the caller already has it.
 * @returns headings in document order.
 */
export function markdownHeadingLines(source: string, tree: Nodes = parseMarkdown(source)): MarkdownHeadingLine[] {
  const rawLines = source.split('\n')
  const headings: MarkdownHeadingLine[] = []
  visitMarkdown(tree, (node) => {
    if (node.type !== 'heading' || node.position === undefined) return
    headings.push({
      depth: node.depth,
      index: node.position.start.line,
      raw: rawLines[node.position.start.line - 1] ?? '',
      text: renderedText(node),
    })
  })
  return headings
}

type ColumnRange = readonly [start: number, end: number]
type OffsetRange = readonly [start: number, end: number]

/** Source-column ranges occupied by parsed HTML comments, keyed by source line. */
function htmlCommentRanges(tree: Nodes, rawLines: readonly string[]): Map<number, ColumnRange[]> {
  const comments: OffsetRange[] = []
  visitMarkdown(tree, (node) => {
    if (node.type !== 'html' || node.position?.start.offset === undefined) return
    let cursor = 0
    while (true) {
      const start = node.value.indexOf('<!--', cursor)
      if (start < 0) break
      const close = node.value.indexOf('-->', start + '<!--'.length)
      const end = close < 0 ? node.value.length : close + '-->'.length
      comments.push([node.position.start.offset + start, node.position.start.offset + end])
      cursor = end
    }
  })

  const ranges = new Map<number, ColumnRange[]>()
  let lineOffset = 0
  rawLines.forEach((raw, index) => {
    const lineEnd = lineOffset + raw.length
    for (const [start, end] of comments) {
      const from = Math.max(start, lineOffset)
      const to = Math.min(end, lineEnd)
      const coversEmptyLine = raw.length === 0 && start <= lineOffset && end > lineOffset
      if (from < to || coversEmptyLine) {
        const lineRanges = ranges.get(index + 1) ?? []
        lineRanges.push([from - lineOffset, to - lineOffset])
        ranges.set(index + 1, lineRanges)
      }
    }
    lineOffset = lineEnd + 1
  })
  return ranges
}

/** Whether a source line retains non-whitespace text after HTML comments disappear. */
function hasRenderedTextOutsideComments(raw: string, ranges: readonly ColumnRange[] | undefined): boolean {
  if (ranges === undefined) return true
  let cursor = 0
  let visible = ''
  for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0])) {
    visible += raw.slice(cursor, start)
    cursor = Math.max(cursor, end)
  }
  visible += raw.slice(cursor)
  return visible.trim().length > 0
}

/**
 * Return source lines outside code blocks and HTML comments.
 * @param source - Markdown source whose prose should be retained verbatim.
 * @param tree - the {@link parseMarkdown} result for exactly `source`, when the caller already has it.
 * @returns unfenced lines with their original 1-based locations.
 */
export function markdownProseLines(source: string, tree: Nodes = parseMarkdown(source)): MarkdownProseLine[] {
  const rawLines = source.split('\n')
  const comments = htmlCommentRanges(tree, rawLines)
  const fenced = new Set<number>()
  visitMarkdown(tree, (node) => {
    if (node.type !== 'code' || node.position === undefined) return
    for (let line = node.position.start.line; line <= node.position.end.line; line += 1) fenced.add(line)
  })
  const kept: MarkdownProseLine[] = []
  rawLines.forEach((raw, i) => {
    if (fenced.has(i + 1)) return
    if (hasRenderedTextOutsideComments(raw, comments.get(i + 1))) {
      kept.push({ index: i + 1, raw })
    }
  })
  return kept
}
