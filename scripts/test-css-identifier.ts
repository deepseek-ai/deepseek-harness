/**
 * CSS identifier serialization for test expectations. A CSS Modules class name holds the name itself, while a
 * stylesheet writes it escaped where CSS requires: lightningcss's `[hash]` can begin with `-` and a digit, so the
 * class `-5ab_root` appears as `.-\35 ab_root` in the compiled stylesheet.
 */

/**
 * Serialize an identifier the way CSSOM `CSS.escape` does, which is also how lightningcss writes selectors.
 * @param name - a class name or another identifier.
 * @returns the identifier as a stylesheet writes it.
 */
export function cssIdentifier(name: string): string {
  // CSSOM serializes code points, not grapheme clusters.
  return Array.from(name, (char, index) => {
    const code = char.codePointAt(0) as number
    if (code === 0) return '\uFFFD'
    const digit = char >= '0' && char <= '9'
    if (code <= 0x1f || code === 0x7f || (digit && (index === 0 || (index === 1 && name.startsWith('-'))))) {
      return `\\${code.toString(16)} `
    }
    if (name === '-') return '\\-'
    return code >= 0x80 || /[-\w]/u.test(char) ? char : `\\${char}`
  }).join('')
}
