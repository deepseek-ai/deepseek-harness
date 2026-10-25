/** Markdown blockquotes produce atomic quote nodes and inline separator replacements. */
import { messageQuoteRanges, quoteTextOf } from './quote-text.ts'
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    quote: { readonly text: string }
  }
}

/** Recognize blockquote lines and display adjacent paragraph separators as inline spaces. */
export const quoteRule: UserTextRule<'quote'> = {
  id: 'quote',
  order: -10,
  match(text, from) {
    for (const range of messageQuoteRanges(text)) {
      for (const start of [range.start - 2, range.start, range.end]) {
        if (start < from) continue
        if (start === range.start) {
          return { id: 'quote', start, end: range.end, data: { text: quoteTextOf(text.slice(start, range.end)) } }
        }
        if (text.slice(start, start + 2) === '\n\n') {
          return { id: 'text', start, end: start + 2, data: { text: '\n\n', display: ' ' } }
        }
      }
    }
    return undefined
  },
}
