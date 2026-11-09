/**
 * Patterns of `.gitattributes` lines, matched as Git's wildmatch matches them: `*` and `?` stay within one path
 * segment, `**` between slashes or at either end crosses segments, `[...]` sets take `!` or `^` for negation, ranges,
 * and POSIX classes, `\` makes the next character literal, and every other character, including `(`, `{`, and `+`,
 * is literal. Matching is case-sensitive, as in Git unless `core.ignoreCase` is set, and compares characters where Git
 * compares UTF-8 bytes, so `?` and ranges differ from Git only for characters outside ASCII.
 */

/** ASCII members of each POSIX class wildmatch accepts, written as regular expression class ranges. */
const CLASSES: Readonly<Record<string, string>> = {
  alnum: 'a-zA-Z0-9',
  alpha: 'a-zA-Z',
  blank: ' \\t',
  cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9',
  graph: '\\x21-\\x7e',
  lower: 'a-z',
  print: '\\x20-\\x7e',
  punct: '\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e',
  space: '\\t-\\r ',
  upper: 'A-Z',
  xdigit: '0-9a-fA-F',
}

/** Write one character literally in a regular expression, inside or outside a class. */
function literal(char: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(char) ? `\\${char}` : char
}

/**
 * Translate a bracket expression that starts at `pattern[start]`, which is `[`.
 * @returns the regular expression class and the index of the closing `]`, or undefined for an unterminated set or an
 * unknown class, which wildmatch treats as matching nothing.
 */
function bracket(pattern: string, start: number): { readonly source: string; readonly end: number } | undefined {
  let index = start + 1
  const negated = pattern[index] === '!' || pattern[index] === '^'
  if (negated) index += 1
  const members: string[] = []
  // The first character, even `]`, is a member, so the set closes at a later `]`.
  for (let first = true; first || pattern[index] !== ']'; first = false, index += 1) {
    let char = pattern[index]
    if (char === undefined) return undefined
    if (char === '[' && pattern[index + 1] === ':') {
      // A class runs to the next `]`, which must follow `:`; otherwise the `[` is a member.
      const close = pattern.indexOf(']', index + 2)
      if (close === -1) return undefined
      if (close > index + 2 && pattern[close - 1] === ':') {
        const range = CLASSES[pattern.slice(index + 2, close - 1)]
        if (range === undefined) return undefined
        members.push(range)
        index = close
        continue
      }
    }
    if (char === '\\') {
      index += 1
      char = pattern[index]
      if (char === undefined) return undefined
    }
    const to = pattern[index + 2]
    if (pattern[index + 1] === '-' && to !== undefined && to !== ']') {
      index += 2
      let end = to
      if (end === '\\') {
        index += 1
        end = pattern[index] ?? ''
        if (end === '') return undefined
      }
      // A range whose end precedes its start matches only its start.
      members.push(char <= end ? `${literal(char)}-${literal(end)}` : literal(char))
      continue
    }
    members.push(literal(char))
  }
  const set = members.join('')
  // A set never matches `/`.
  return { source: negated ? `[^/${set}]` : `(?!/)[${set}]`, end: index }
}

/**
 * Compile one `.gitattributes` pattern, without the leading `/` that anchors it, into a test of a path.
 * @param pattern - the pattern as written, which the caller has checked is not quoted, negated, or a directory.
 * @returns a test of the text the pattern applies to, or undefined for a pattern that can match nothing.
 */
export function wildmatch(pattern: string): ((text: string) => boolean) | undefined {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index)
    if (char === '\\') {
      const next = pattern[index + 1]
      if (next === undefined) return undefined
      source += literal(next)
      index += 1
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '*') {
      let last = index
      while (pattern[last + 1] === '*') last += 1
      const after = pattern[last + 1]
      const crossing = last > index && (index === 0 || pattern[index - 1] === '/') && (after === undefined || after === '/')
      if (crossing && after === '/') {
        // `**/` also matches no directory at all.
        source += '(?:.*/)?'
        index = last + 1
      } else {
        source += crossing ? '.*' : '[^/]*'
        index = last
      }
    } else if (char === '[') {
      const set = bracket(pattern, index)
      if (set === undefined) return undefined
      source += set.source
      index = set.end
    } else {
      source += literal(char)
    }
  }
  const expression = new RegExp(`^${source}$`, 's')
  return text => expression.test(text)
}
