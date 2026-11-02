/** Shared Markdown blockquote formatting for browser text. */

/**
 * Project selected visible text as an ordinary Markdown blockquote.
 * @param text - selected visible text without quote markers.
 * @returns one `> `-prefixed line per normalized input line.
 */
export function formatQuoteText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').split('\n').map(line => `> ${line}`).join('\n')
}
