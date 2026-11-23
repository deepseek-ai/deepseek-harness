/**
 * Card-markdown dialect of the Lark card mode: escaping of user text, the markdown builders the card handlers use,
 * markdown normalization, and the element-id scheme.
 *
 * Why a separate escaper from the post one. Card markdown (JSON 2.0 `markdown` component) is the broadest Lark
 * dialect: CommonMark + GFM plus an HTML-ish tag allow-list (`<at>`, `<font>`, `<br>`, `<hr>`, `<link>`, `<person>`,
 * `<text_tag>`, `<local_datetime>`, `<raw>`, `<a>`). The platform renders any allowed tag it finds — so a model that
 * writes `<at id=all>` inside plain text would ping the whole group. There is no underline: a markdown component
 * shows `<u>文本</u>` as those literal characters (2026-11-11, a real card), which is why the card mode registers no
 * `u` and underlined content resolves to the post mode. The rules are:
 * - **user text goes through `mdast-util-to-markdown`**, the CommonMark/GFM writer: it escapes the markdown syntax of
 *   literal text (`\ * _ ~ ` [ ] # | >`, line-start block markers) and keeps a code span or fence verbatim, with a
 *   delimiter longer than any backtick run of its body;
 * - **a `<` and an entity-looking `&` take the entity forms the platform documents** (`&#60;`, `&#38;`), so user text
 *   never opens a tag. The platform decodes entities in markdown text only, never inside a code span or fence, which
 *   is why nothing is escaped inside code: an entity there reaches the reader as `&#60;`;
 * - **autolinks are unwrapped**: a bare `http(s)://` URL in text becomes an explicit `[url](url)` link (and
 *   {@link normalizeCardMarkdown} still rewrites a literal `<https://…>`), so neither backslash escapes nor angle
 *   brackets end up inside a rendered URL;
 * - **fences are closed and start at column zero**: generated fences are balanced and longer than any backtick run of
 *   their body, list continuation never indents a fence (the platform does not recognise an indented fence), and the
 *   final pass closes an unterminated fence and dedents any indented one;
 * - fenced code bodies are left verbatim.
 *
 * Images inside markdown (`![alt](img_key)`) cannot carry their key at transform time (upload is `prepare`'s job), so
 * the handlers write a **placeholder** `\uE000<src>\uE001` that {@link resolveImagePlaceholders} replaces with the
 * resolved key at serialize time. Placeholders keep drafts plain strings, which is what the streaming `diff()` needs
 * (prefix checks, byte counts).
 */

import { createHash } from 'node:crypto'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown } from 'mdast-util-to-markdown'
import type { Root, RootContent } from 'mdast'
import { isEveryoneId } from './shared.ts'

// ---------------------------------------------------------------------------------------------------------------
// Text escaping

/**
 * The serializer of the card dialect. Every rule for literal text — markdown metacharacters, line-start block markers,
 * entity-looking `&`, code-span delimiters, fence length — comes from `mdast-util-to-markdown`; this file adds only
 * what the platform adds on top: GFM (it renders tables, strikethrough and task lists) and the entity forms below.
 */
const SERIALIZE = { extensions: [gfmToMarkdown()] }

/**
 * The `<` of user text, in the form the platform documents for showing it. The platform decodes entities in markdown
 * text and in no other context, so a `<` inside a code span or fence is left verbatim.
 */
export const LT_ENTITY = '&#60;'

/** An entity-looking `&` (`&amp;`, `&#60;`), which the platform would decode if the text carried it unescaped. */
const AMP_ENTITY = '&#38;'

/** A hard line break. A single newline is a soft break the platform may collapse (dsh `TITLE_BREAK`). */
export const CARD_BREAK = '<br>'

/** A bare URL inside text (GFM extended autolink, approximately); trailing punctuation is trimmed by {@link splitUrls}. */
const BARE_URL = /https?:\/\/[^\s<>"'`\u3000-\u303f\uff00-\uffef]+/gi
/** Characters a URL does not end with (they are sentence punctuation in running text). */
const URL_TRAILER = /[.,;:!?*_~'")\]]+$/

/** Private-use delimiters of an image placeholder (`\uE000<src>\uE001`). */
export const IMAGE_OPEN = '\uE000'
export const IMAGE_CLOSE = '\uE001'
const PLACEHOLDER = /\uE000([^\uE001]*)\uE001/g

/** Serialize these block nodes as a document, without the newline the serializer ends the last block with. */
function serialize(children: RootContent[]): string {
  const root: Root = { type: 'root', children }
  return toMarkdown(root, SERIALIZE).replace(/\n$/, '')
}

/**
 * Escape one run of user text as card markdown. The serializer escapes the markdown syntax of literal text; the two
 * replacements then give `<` and an entity-looking `&` the form the platform documents, so text can neither open an
 * allowed tag nor be decoded as an entity of its own. Newlines are kept — {@link textMarkdown} turns them into breaks.
 */
export function escapeCardText(text: string): string {
  return serialize([{ type: 'paragraph', children: [{ type: 'text', value: text }] }])
    .replace(/\\</g, LT_ENTITY)
    .replace(/\\&/g, AMP_ENTITY)
    // A space the serializer preserved as `&#x20;` to keep it from becoming a hard break. Text never ends a block
    // here, so the plain space renders the same and keeps the component readable.
    .replace(/&#x20;/g, ' ')
    .replace(/[\uE000\uE001]/g, char => `&#${char.charCodeAt(0)};`)
}

/** Split text into plain runs and bare URLs (the URL without its trailing sentence punctuation). */
export function splitUrls(text: string): { text: string; url: boolean }[] {
  const out: { text: string; url: boolean }[] = []
  let index = 0
  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index ?? 0
    const url = match[0].replace(URL_TRAILER, '')
    if (url.length <= 'https://'.length) continue
    if (start > index) out.push({ text: text.slice(index, start), url: false })
    out.push({ text: url, url: true })
    index = start + url.length
  }
  if (index < text.length) out.push({ text: text.slice(index), url: false })
  return out
}

/** Characters that would end a link label or open a tag, in the entity forms the platform decodes in markdown text. */
const LABEL_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&#38;', '<': '&#60;', '>': '&#62;', '[': '&#91;', ']': '&#93;', '\\': '&#92;',
  '`': '&#96;', '*': '&#42;', '_': '&#95;', '~': '&#126;',
}

/**
 * A link label: the URL a link shows, or the text inside one.
 *
 * The GFM text serializer escapes the `:` of URL-shaped text so plain text cannot become an autolink, but a card
 * renders that backslash to the reader (`https\://example.com/b`), and a label is never autolinked. Labels therefore
 * use the entity forms instead — the platform decodes them in markdown text — and write no backslash at all.
 *
 * @param text - the label text.
 * @returns the label markdown.
 */
export function linkLabel(text: string): string {
  return text.replace(/[&<>[\]\\`*_~]/g, char => LABEL_ENTITIES[char] ?? char)
}

/**
 * Markdown of one `text` element: escaped, newlines as {@link CARD_BREAK}, and — unless `linkify` is false (text
 * inside a link label) — every bare URL unwrapped into an explicit `[url](url)` link (dsh autolink semantics).
 */
export function textMarkdown(text: string, linkify = true): string {
  const runs = linkify ? splitUrls(text) : [{ text, url: false }]
  return runs.map(run => run.url
    ? `[${linkLabel(run.text)}](${escapeLinkHref(run.text)})`
    : linkify ? escapeCardText(run.text) : linkLabel(run.text)).join('').replace(/\r?\n/g, CARD_BREAK)
}

// ---------------------------------------------------------------------------------------------------------------
// Builders

/**
 * An inline code span. Newlines become spaces (a span is one line) and the delimiter is longer than any backtick run
 * of the body, both from the serializer. The body stays verbatim: the platform decodes no entity inside code, so an
 * escaped `<` there would reach the reader as `&#60;`, and a span cannot open a tag anyway.
 */
export function cardCodeSpan(text: string): string {
  const body = stripPlaceholders(text).replace(/\r?\n/g, ' ')
  if (!body) return ''
  return serialize([{ type: 'paragraph', children: [{ type: 'inlineCode', value: body }] }])
}

/** A fenced code block at column zero, longer than any backtick run of its body; the body is verbatim. */
export function cardFence(text: string, lang?: string): string {
  const raw = stripPlaceholders(text)
  const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  const info = (lang ?? '').replace(/[`\s]/g, '')
  return serialize([{ type: 'code', lang: info || undefined, value }])
}

/**
 * Wrap `inner` in a marker pair (`**`, `*`, `~~`), moving boundary whitespace outside: CommonMark refuses to open
 * emphasis before a space. Whitespace-only content is returned unchanged.
 */
export function wrapInline(open: string, inner: string, close = open): string {
  const leading = /^(?:\s|<br>)*/.exec(inner)?.[0] ?? ''
  const trailing = /(?:\s|<br>)*$/.exec(inner.slice(leading.length))?.[0] ?? ''
  const core = inner.slice(leading.length, inner.length - trailing.length)
  if (!core) return inner
  return `${leading}${open}${core}${close}${trailing}`
}

const HREF_ESCAPES: Readonly<Record<string, string>> = { ' ': '%20', '(': '%28', ')': '%29', '<': '%3C', '>': '%3E' }

/** Percent-encode the characters that would end a `[](…)` destination early. */
export function escapeLinkHref(href: string): string {
  return href.replace(/[\s()<>]/g, char => HREF_ESCAPES[char] ?? `%${char.codePointAt(0)!.toString(16).toUpperCase()}`)
}

/** A link; a label equal to the URL (or empty) shows the URL itself, never an autolink in angle brackets. */
export function cardLink(label: string, href: string): string {
  return `[${label || linkLabel(href)}](${escapeLinkHref(href)})`
}

/** Card-markdown mention: `<at id=ou_x></at>` or `<at id=all></at>`; ids are restricted to `[\w-]`. */
export function cardMention(type: 'user' | 'all', id?: string): string {
  const target = type === 'all' ? 'all' : (id ?? '').replace(/[^\w-]/g, '')
  // A `user` whose id spells everyone would mention everyone past the withheld `all` variant: no mention at all.
  if (type === 'user' && isEveryoneId(target)) return ''
  return target ? `<at id=${target}></at>` : ''
}

/** `Color` of the vocabulary → `<font color>` of card markdown (`default` ⇒ no tag). */
export const CARD_FONT_COLORS: Readonly<Record<string, string>> = {
  muted: 'grey',
  info: 'blue',
  success: 'green',
  warning: 'orange',
  danger: 'red',
}

/** Colored text: `<font color='red'>…</font>`; an unknown or default color returns the text unchanged. */
export function cardFont(color: string | undefined, inner: string): string {
  const value = color ? CARD_FONT_COLORS[color] : undefined
  return value && inner ? `<font color='${value}'>${inner}</font>` : inner
}

// ---------------------------------------------------------------------------------------------------------------
// Fences and line prefixes

interface FenceState { char: string; length: number }

/** The fence a line opens (or `undefined`): ``` or ~~~, at most three spaces of indentation. */
function fenceOpen(line: string): FenceState | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return undefined
  const marker = match[1]!
  if (marker[0] === '`' && match[2]!.includes('`')) return undefined
  return { char: marker[0]!, length: marker.length }
}

function fenceCloses(line: string, open: FenceState): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
  return !!match && match[1]![0] === open.char && match[1]!.length >= open.length
}

/** Which lines of `text` belong to a fenced code block (fence lines included). */
export function fencedLines(text: string): boolean[] {
  const out: boolean[] = []
  let open: FenceState | undefined
  for (const line of text.split('\n')) {
    if (open) {
      out.push(true)
      if (fenceCloses(line, open)) open = undefined
      continue
    }
    open = fenceOpen(line)
    out.push(!!open)
  }
  return out
}

/**
 * Prefix every line of a block: `first` on line 0, `rest` on the others. Fenced lines are never indented by
 * whitespace (`indentFences: false`), because the platform does not recognise an indented fence; a `> ` prefix is kept
 * on them. Empty lines get the trimmed prefix.
 */
export function prefixLines(text: string, first: string, rest: string, options: { indentFences?: boolean } = {}): string {
  const fenced = fencedLines(text)
  const whitespace = !rest.trim()
  return text.split('\n').map((line, index) => {
    const prefix = index === 0 ? first : rest
    if (fenced[index] && whitespace && index > 0 && options.indentFences !== true) return line
    if (!line) return prefix.trimEnd()
    return `${prefix}${line}`
  }).join('\n')
}

// ---------------------------------------------------------------------------------------------------------------
// normalizeMarkdown port

const AUTOLINK = /<((?:https?|mailto):[^\s<>]+)>/g

/**
 * The port of dsh `normalizeMarkdown` for card markdown, applied by `assemble` to every component text as a final
 * guard: indented fences move to column zero, an unterminated fence is closed and CommonMark autolinks become
 * ordinary links (the card shows their angle brackets verbatim). A `<` that does not open an allowed tag is left
 * alone: `escapeCardText` already escaped the ones that could take effect, and escaping the rest would show the
 * reader an entity instead of the text.
 * Fenced bodies stay verbatim. Image rewriting is not ported: v4 images are elements whose keys `prepare` resolves.
 *
 * Unlike dsh, fences are tracked by character and length (CommonMark closing rules), so a ```` ```` ```` fence
 * holding a ```` ``` ```` line no longer toggles the state twice.
 */
export function normalizeCardMarkdown(text: string): string {
  if (text === '') return text
  let open: FenceState | undefined
  const result: string[] = []
  for (const line of text.split('\n')) {
    if (open) {
      if (fenceCloses(line.trimStart(), open)) {
        result.push(line.trimStart())
        open = undefined
      } else {
        result.push(line)
      }
      continue
    }
    const dedented = /^[ \t]+(?:`{3,}|~{3,})/.test(line) ? line.trimStart() : line
    const fence = fenceOpen(dedented)
    if (fence) {
      open = fence
      result.push(dedented)
      continue
    }
    result.push(dedented.replace(AUTOLINK, (_match, target: string) => `[${target}](${target})`))
  }
  if (open) result.push(open.char.repeat(open.length))
  return result.join('\n')
}

// ---------------------------------------------------------------------------------------------------------------
// Image placeholders

/** Verbatim text (code) cannot carry the placeholder delimiters: they become U+FFFD. */
export function stripPlaceholders(text: string): string {
  return text.replace(/[\uE000\uE001]/g, '\uFFFD')
}

/** The placeholder of an image source inside draft markdown (resolved by {@link resolveImagePlaceholders}). */
export function imagePlaceholder(src: string): string {
  return `${IMAGE_OPEN}${src.replace(/[\uE000\uE001]/g, '')}${IMAGE_CLOSE}`
}

/** Replace every image placeholder with the key `key(src)` returns. */
export function resolveImagePlaceholders(content: string, key: (src: string) => string): string {
  return content.replace(PLACEHOLDER, (_match, src: string) => key(src))
}

// ---------------------------------------------------------------------------------------------------------------
// Element ids

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/**
 * Card element id of a stable path: `e` + base32(sha1(path))[0..15] — 16 characters, starting with a letter,
 * `[a-z2-7]` only, which fits the platform rule (unique per card, ≤ 20 characters, letters/digits/`_`). `path` is
 * `RenderContext.stableId(el)` (a structural path, or `#<key>` for keyed elements), optionally with a suffix for
 * derived components (`<path>#row`).
 */
export function cardElementId(path: string): string {
  return `e${base32(createHash('sha1').update(path).digest()).slice(0, 15)}`
}
