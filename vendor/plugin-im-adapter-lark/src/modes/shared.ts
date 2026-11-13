/**
 * Helpers shared by the Lark modes: the post-markdown escaper, the mode-specific mention syntax, the idempotency uuid
 * and the small Markdown builders both dialects need.
 *
 * The two dialects differ in escaping (`*_~\`[]<>#|` are also special in card markdown) and in the mention syntax
 * (`<at user_id="ou_x">Name</at>` in post, `<at id=ou_x>` in a card), which is why {@link mentionMarkdown} takes the
 * mode.
 */

import { createHash } from 'node:crypto'

/**
 * Characters that change the meaning of a Lark `md` node (CommonMark + GFM) when they come from user text: emphasis,
 * code spans, links, HTML-ish tags (`<at>`, `<u>`), ATX headings and GFM table cells.
 */
export const POST_MD_ESCAPABLE = '*_~`[]<>#|'

/** A line start that would open a list, a thematic break or a setext heading if it stayed unescaped. */
const BLOCK_START = /^(\s*)([-+=]|\d{1,9}[.)])/

/**
 * Escape user text for a Lark post `md` node.
 *
 * Every character of {@link POST_MD_ESCAPABLE} (and the backslash itself) is escaped, so a model that writes `*`,
 * `_`, `<` or a fence cannot change the structure of the message. On top of that, a marker that would *start a block*
 * is escaped (`- item`, `1. item`, `---`, `===`): those come from plain text, not from the element tree, so the
 * escaper is the only place that can neutralise them. Newlines are preserved — the caller decides whether they mean
 * a hard break.
 */
export function escapePostMd(text: string): string {
  let escaped = ''
  for (const char of text) {
    escaped += char === '\\' || POST_MD_ESCAPABLE.includes(char) ? `\\${char}` : char
  }
  return escaped.split('\n').map(escapeBlockStart).join('\n')
}

/**
 * Escape the block marker of one line of already character-escaped text: `- a` → `\- a`, `12. b` → `12\. b`,
 * `---` → `\---`, `===` → `\===`. A marker that can only be literal inline text (`a - b`, `3.5`) is left alone.
 */
export function escapeBlockStart(line: string): string {
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

/** The Lark markdown dialect a mention is written for (post nodes vs card markdown). */
export type MentionMode = 'post' | 'card'

/** A platform-neutral mention, i.e. the attributes of an `<at>` element. */
export interface MentionSpec {
  type: 'user' | 'all' | 'here' | 'role'
  id?: string
  name?: string
}

/**
 * Mention syntax of one dialect: `post` → `<at user_id="ou_x">Alice</at>` (`user_id="all"` for everyone);
 * `card` → `<at id=ou_x>Alice</at>`. A mention without an id (or a role, which neither dialect can address) becomes
 * its literal `@name` label, so the reader still sees whom it is about.
 */
export function mentionMarkdown(mode: MentionMode, mention: MentionSpec): string {
  const label = (mention.name ?? '').replace(/[<>&"\r\n]/g, '')
  if (mention.type === 'role') return label ? `@${label}` : ''
  const cleanId = (mention.id ?? '').replace(/[^\w-]/g, '')
  // A user whose id is the platform's word for everyone is not a user: rendering it would mention everyone without
  // the `all` variant a mode withholds under `allowAtAll: false`.
  if (mention.type === 'user' && isEveryoneId(cleanId)) return label ? `@${label}` : ''
  const id = mention.type === 'user' ? cleanId : 'all'
  if (!id) return label ? `@${label}` : ''
  return mode === 'card' ? `<at id=${id}>${label}</at>` : `<at user_id="${id}">${label}</at>`
}

/**
 * Whether a user id is the word Lark reads as "everyone" (`all`; `here` is reserved alongside it).
 * @param id - the id of a `user` mention.
 * @returns true when the platform would mention everyone for it.
 */
export function isEveryoneId(id: string | undefined): boolean {
  return id === 'all' || id === 'here'
}

/**
 * `uuid` of a Lark request: `sha256(<idempotencyKey>#<part index>)[0..32]` — at most 50 characters,
 * deduplicated by the platform for one hour. Per part, because a logical message may be several platform messages
 * and each one needs its own key.
 */
export function idempotencyUuid(seed: string, index = 0): string {
  return createHash('sha256').update(`${seed}#${index}`).digest('hex').slice(0, 32)
}

/** Longest run of `char` in `text` (fence and code-span delimiters must be longer than any run inside). */
export function longestRun(text: string, char: string): number {
  let longest = 0
  let current = 0
  for (const item of text) {
    if (item !== char) {
      current = 0
      continue
    }
    current++
    if (current > longest) longest = current
  }
  return longest
}

/** An inline code span around `text`, with a delimiter that cannot be closed by the text itself. */
export function codeSpan(text: string): string {
  if (!text) return ''
  const fence = '`'.repeat(longestRun(text, '`') + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** A fenced code block around `text` (a post `md` node, or a card markdown component), keeping `lang` as the info string. */
export function fenceBlock(text: string, lang?: string): string {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1))
  return `${fence}${lang ?? ''}\n${body}\n${fence}`
}

/**
 * Wrap `inner` in an inline marker pair (`**`, `*`, `~~`, `<u>`), moving leading and trailing whitespace outside the
 * markers: CommonMark refuses to open emphasis before a space, so `** bold **` would otherwise stay literal.
 * Whitespace-only content is returned unchanged.
 */
export function wrapInline(open: string, inner: string, close = open): string {
  const leading = /^\s*/.exec(inner)?.[0] ?? ''
  const trailing = /\s*$/.exec(inner.slice(leading.length))?.[0] ?? ''
  const core = inner.slice(leading.length, inner.length - trailing.length)
  if (!core) return inner
  return `${leading}${open}${core}${close}${trailing}`
}

/** Percent-escapes of the characters that would end a `[](…)` destination early (`encodeURIComponent` keeps `()`). */
const HREF_ESCAPES: Readonly<Record<string, string>> = {
  ' ': '%20',
  '(': '%28',
  ')': '%29',
  '<': '%3C',
  '>': '%3E',
}

/** Percent-encode the characters that would end a `[](…)` destination early (space, parentheses, angle brackets). */
export function escapeLinkHref(href: string): string {
  return href.replace(/[\s()<>]/g, char => HREF_ESCAPES[char]
    ?? `%${char.codePointAt(0)!.toString(16).toUpperCase()}`)
}
