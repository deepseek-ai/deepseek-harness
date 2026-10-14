/** Whitespace candidates use the same cursor, priority and Facts cache as reference candidates. */
import type { UserTextNode, UserTextRule } from '../contract/user-text.ts'

function replacement(text: string, start: number, end: number, display: string): UserTextNode<'text'> {
  return { id: 'text', start, end, data: { text: text.slice(start, end), display } }
}

/** Offer the next whitespace run whose display collapses to one space. */
export const collapseWhitespaceRule: UserTextRule<'text.collapse-whitespace'> = {
  id: 'text.collapse-whitespace',
  order: 1010,
  match(text, from, context) {
    if (!context.read('collapseWhitespace')) return undefined
    const spaces = /\s+/gu
    spaces.lastIndex = from
    for (let match = spaces.exec(text); match !== null; match = spaces.exec(text)) {
      // A search cursor inside an already matched run does not create a new original run.
      if ((match.index > 0 && /\s/u.test(text.slice(match.index - 1, match.index))) || match[0] === ' ') continue
      return replacement(text, match.index, match.index + match[0].length, ' ')
    }
    return undefined
  },
}

/** Offer original document-edge whitespace, winning same-start collisions with collapse. */
export const trimWhitespaceRule: UserTextRule<'text.trim-whitespace'> = {
  id: 'text.trim-whitespace',
  order: 1000,
  match(text, from, context) {
    if (!context.read('trimWhitespace')) return undefined
    if (from === 0) {
      const leading = /^\s+/u.exec(text)
      if (leading !== null) return replacement(text, 0, leading[0].length, '')
    }
    let start = text.length
    const whitespace = /\s/u
    while (start > 0 && whitespace.test(text.charAt(start - 1))) start--
    return start === text.length || start < from ? undefined : replacement(text, start, text.length, '')
  },
}
