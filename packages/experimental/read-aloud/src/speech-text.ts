/** Reply Markdown reduced to the plain text that is read aloud. */
import type { Nodes, Parents, Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

/** Longest inline formula, in code units, that is read as written; a longer one is skipped. */
const INLINE_MATH_LIMIT = 20
/**
 * A block formula between `$$` pairs, or an inline formula between two `$` on one line; a backslash-escaped dollar
 * is no delimiter. An inline formula follows Pandoc's rule, so that amounts of money stay text: its opening dollar
 * precedes a non-space character, and its closing dollar follows a non-space character and precedes no digit. The
 * math syntax packages are not used here: they install KaTeX into the Host runtime.
 */
const FORMULA = /(?<!\\)\$\$[\s\S]+?\$\$|(?<!\\)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g
/** ASCII punctuation, each of which Markdown reads literally after a backslash. */
const PUNCTUATION = /[!-/:-@[-`{-~]/g

/**
 * Convert reply Markdown to the text a voice reads. Paragraphs, headings and list items become lines; emphasis, links
 * and inline code keep their text; code blocks, tables, block formulas, images, HTML and footnotes are left out.
 * @param markdown - reply text as the model wrote it.
 * @returns plain text with one line per block, or an empty string when nothing is readable prose.
 */
export function speechText(markdown: string): string {
  return spoken(parse(withoutFormulas(markdown))).replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
}

function parse(markdown: string): Root {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

/**
 * Take the formulas out of the source before it is parsed for speech. A short inline formula stays as literal text; a
 * dollar inside code or HTML delimits nothing.
 */
function withoutFormulas(markdown: string): string {
  let result = ''
  let at = 0
  for (const [start, end] of literalRanges(parse(markdown))) {
    result += markdown.slice(at, start).replace(FORMULA, spokenFormula) + markdown.slice(start, end)
    at = end
  }
  return result + markdown.slice(at).replace(FORMULA, spokenFormula)
}

/** Source ranges that the parser read as code or HTML, in document order. */
function literalRanges(node: Nodes): [number, number][] {
  if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    /* v8 ignore next -- fromMarkdown positions every node it creates. */
    if (start === undefined || end === undefined) return []
    return [[start, end]]
  }
  return 'children' in node ? node.children.flatMap(child => literalRanges(child)) : []
}

/** The punctuation of a kept formula is escaped, so the parser reads no markup in it. */
function spokenFormula(_formula: string, inline: string | undefined): string {
  return inline !== undefined && inline.length <= INLINE_MATH_LIMIT ? inline.replace(PUNCTUATION, '\\$&') : ''
}

function children(node: Parents): string {
  return node.children.map(spoken).join('')
}

function spoken(node: Nodes): string {
  switch (node.type) {
    // A source line break inside a paragraph is spacing, not a pause. Emphasis markers the parser left unpaired are not read.
    case 'text': return node.value.replace(/\s*\n\s*/g, ' ').replace(/\*\*|__|~~/g, '')
    case 'inlineCode': return node.value
    case 'break': return '\n'
    case 'paragraph':
    case 'heading': return `${children(node)}\n`
    case 'root':
    case 'blockquote':
    case 'list':
    case 'listItem':
    case 'emphasis':
    case 'strong':
    case 'delete':
    case 'link':
    case 'linkReference': return children(node)
    // Every other node is left out: code, table, html, image, thematicBreak, definitions, footnotes, and node
    // types that extensions add later (the union is merge-extensible).
    default: return ''
  }
}
