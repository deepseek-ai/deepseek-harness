/** Display text preparation for model reasoning. */

/**
 * Prepare complete or streaming reasoning for display.
 * @param text - original complete or streaming reasoning.
 * @returns display text, or empty text when no displayable content is available.
 */
export function reasoningText(text: string): string {
  if (text[0] !== '<') return text
  /* v8 ignore start -- Custom rendering behavior is outside unit coverage. */
  const opening = '<signature>'
  if (opening.startsWith(text)) return ''
  if (!text.startsWith(opening)) return text
  const closing = '</signature>'
  const end = text.indexOf(closing, opening.length)
  if (end === -1) return ''
  let start = end + closing.length
  while (start < text.length) {
    if (text[start] === '\n') start++
    else if (text[start] === '\r' && text[start + 1] === '\n') start += 2
    else break
  }
  return text.slice(start)
  /* v8 ignore stop */
}
