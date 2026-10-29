/**
 * Card-markdown dialect of the Lark card mode: escaping of user text, the markdown builders the card handlers use,
 * markdown normalization, and the element-id scheme.
 *
 * Why a separate escaper from the post one. Card markdown (JSON 2.0 `markdown` component) is the broadest Lark
 * dialect: CommonMark + GFM plus an HTML-ish tag allow-list (`<at>`, `<font>`, `<br>`, `<hr>`, `<link>`, `<person>`,
 * `<text_tag>`, `<local_datetime>`, `<raw>`, `<a>`). The platform renders any allowed tag it finds — so a model that
 * writes `<at id=all>` inside plain text would ping the whole group — and shows CommonMark autolinks with their
 * angle brackets. The rules are:
 * - **every `<` of user text becomes `&#60;`** (user text is never allowed to open a tag); a code span or fence keeps
 *   its body verbatim, because the platform decodes no entity inside code and the reader would see `&#60;` there;
 * - **autolinks are unwrapped**: a bare `http(s)://` URL in text becomes an explicit `[url](url)` link (and
 *   {@link normalizeCardMarkdown} still rewrites a literal `<https://…>`), so neither backslash escapes nor angle
 *   brackets end up inside a rendered URL;
 * - **fences are closed and start at column zero**: generated fences are balanced and longer than any backtick run of
 *   their body, list continuation never indents a fence (the platform does not recognise an indented fence), and the
 *   final pass closes an unterminated fence and dedents any indented one;
 * - fenced code bodies are left verbatim.
 * On top of that, CommonMark metacharacters of user text (`\ * _ ~ \` [ ] # | >`) are backslash-escaped and a line
 * start that would open a block (`- `, `1. `, `+ `, `===`) is neutralised, because text is literal (markdown input
 * was already parsed by `normalize` → `fromMarkdown`).
 *
 * Images inside markdown (`![alt](img_key)`) cannot carry their key at transform time (upload is `prepare`'s job), so
 * the handlers write a **placeholder** `\uE000<src>\uE001` that {@link resolveImagePlaceholders} replaces with the
 * resolved key at serialize time. Placeholders keep drafts plain strings, which is what the streaming `diff()` needs
 * (prefix checks, byte counts).
 */

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------------------------------------------
// Text escaping

/** HTML-like tags a card markdown component accepts (dsh `ALLOWED_TAGS`); every other `<` is escaped. */
export const CARD_MD_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'br', 'hr', 'person', 'local_datetime', 'at', 'a', 'text_tag', 'raw', 'link', 'font',
])

/** CommonMark/GFM metacharacters that user text must not be able to use (besides `<`, `&` and line starts). */
export const CARD_MD_ESCAPABLE = '\\*_~`[]#|>'

/** The `<` of user text: an entity, which the platform renders as a literal `<` and never as a tag. */
export const LT_ENTITY = '&#60;'

/** A hard line break. A single newline is a soft break the platform may collapse (dsh `TITLE_BREAK`). */
export const CARD_BREAK = '<br>'

/** A line start that would open a list or a thematic break. */
const BLOCK_START = /^(\s*)([-+]|\d{1,9}[.)])/
/** A line that is nothing but `=` — a setext heading underline for the paragraph above it (plain `=` text is not). */
const SETEXT_UNDERLINE = /^(\s*)(=+)\s*$/
/** `&name;` / `&#123;` / `&#x1F;` — text that the platform would decode as an entity. */
const ENTITY = /^&(?:#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]*;)/i
/** A bare URL inside text (GFM extended autolink, approximately); trailing punctuation is trimmed by {@link splitUrls}. */
const BARE_URL = /https?:\/\/[^\s<>"'`\u3000-\u303f\uff00-\uffef]+/gi
/** Characters a URL does not end with (they are sentence punctuation in running text). */
const URL_TRAILER = /[.,;:!?*_~'")\]]+$/

/** Private-use delimiters of an image placeholder (`\uE000<src>\uE001`). */
export const IMAGE_OPEN = '\uE000'
export const IMAGE_CLOSE = '\uE001'
const PLACEHOLDER = /\uE000([^\uE001]*)\uE001/g

/**
 * Escape one run of user text: metacharacters, `<`, entity-looking `&`, the placeholder delimiters and — at the start
 * of every line — block markers. Newlines are kept; the caller decides what they mean.
 */
export function escapeCardText(text: string): string {
  let escaped = ''
  let index = 0
  for (const char of text) {
    if (char === '<') escaped += LT_ENTITY
    else if (char === '&') escaped += ENTITY.test(text.slice(index)) ? '&#38;' : '&'
    else if (char === IMAGE_OPEN || char === IMAGE_CLOSE) escaped += `&#${char.codePointAt(0)};`
    else escaped += CARD_MD_ESCAPABLE.includes(char) ? `\\${char}` : char
    index += char.length
  }
  return escaped.split('\n').map(escapeCardBlockStart).join('\n')
}

/**
 * Escape the block marker of one line of already character-escaped text: `- a` → `\- a`, `12. b` → `12\. b`,
 * `---` → `\---`, and a line of nothing but `=` → `\===` (a setext underline). A marker that can only be literal
 * (`a - b`, `3.5`, `= 104 B`) is left alone: a backslash the platform does not consume would show up in the chat.
 */
export function escapeCardBlockStart(line: string): string {
  const setext = SETEXT_UNDERLINE.exec(line)
  if (setext) {
    const at = (setext[1] ?? '').length
    return `${line.slice(0, at)}\\${line.slice(at)}`
  }
  const match = BLOCK_START.exec(line)
  if (!match) return line
  const indent = match[1] ?? ''
  const marker = match[2] ?? ''
  const rest = line.slice(indent.length + marker.length)
  const opensBlock = rest === '' || /^\s/.test(rest) || (marker[0] === rest[0] && rest.length >= 2)
  if (!opensBlock) return line
  const at = indent.length + marker.length - 1
  return `${line.slice(0, at)}\\${line.slice(at)}`
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

/**
 * Markdown of one `text` element: escaped, newlines as {@link CARD_BREAK}, and — unless `linkify` is false (text
 * inside a link label) — every bare URL unwrapped into an explicit `[url](url)` link (dsh autolink semantics).
 */
export function textMarkdown(text: string, linkify = true): string {
  const runs = linkify ? splitUrls(text) : [{ text, url: false }]
  return runs.map(run => run.url
    ? `[${escapeCardText(run.text)}](${escapeLinkHref(run.text)})`
    : escapeCardText(run.text)).join('').replace(/\r?\n/g, CARD_BREAK)
}

// ---------------------------------------------------------------------------------------------------------------
// Builders

/** Longest run of `char` in `text`. */
export function longestRun(text: string, char: string): number {
  let longest = 0
  let current = 0
  for (const item of text) {
    current = item === char ? current + 1 : 0
    if (current > longest) longest = current
  }
  return longest
}

/**
 * An inline code span. Newlines become spaces (a span is one line) and the body stays verbatim, like a fence: the
 * platform decodes no entity inside code, so escaping `<` would show `&#60;` to the reader, and a span cannot open a
 * tag anyway. The delimiter is longer than any backtick run of the text.
 */
export function cardCodeSpan(text: string): string {
  const body = stripPlaceholders(text).replace(/\r?\n/g, ' ')
  if (!body) return ''
  const fence = '`'.repeat(longestRun(body, '`') + 1)
  const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${body}${pad}${fence}`
}

/** A fenced code block at column zero, longer than any backtick run of its body; the body is verbatim. */
export function cardFence(text: string, lang?: string): string {
  const raw = stripPlaceholders(text)
  const body = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1))
  const info = (lang ?? '').replace(/[`\s]/g, '')
  return `${fence}${info}\n${body}\n${fence}`
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
  return `[${label || escapeCardText(href)}](${escapeLinkHref(href)})`
}

/** Card-markdown mention: `<at id=ou_x></at>` or `<at id=all></at>`; ids are restricted to `[\w-]`. */
export function cardMention(type: 'user' | 'all', id?: string): string {
  const target = type === 'all' ? 'all' : (id ?? '').replace(/[^\w-]/g, '')
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
const TAG = /^<\/?([a-zA-Z_][\w-]*)/

function escapeTags(line: string): string {
  let result = ''
  let index = 0
  while (index < line.length) {
    const next = line.indexOf('<', index)
    if (next === -1) return result + line.slice(index)
    result += line.slice(index, next)
    const tag = TAG.exec(line.slice(next))?.[1]
    result += tag !== undefined && CARD_MD_ALLOWED_TAGS.has(tag.toLowerCase()) ? '<' : LT_ENTITY
    index = next + 1
  }
  return result
}

/**
 * The port of dsh `normalizeMarkdown` for card markdown, applied by `assemble` to every component text as a final
 * guard: indented fences move to column zero, an unterminated fence is closed, CommonMark autolinks become ordinary
 * links (the card shows their angle brackets verbatim) and any `<` that does not open an allowed tag is escaped.
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
    result.push(escapeTags(dedented.replace(AUTOLINK, (_match, target: string) => `[${target}](${target})`)))
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
