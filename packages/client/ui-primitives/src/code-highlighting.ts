/** Shared filename-to-grammar selection and lazy line highlighter for source views. */
import { useCallback, useSyncExternalStore } from 'react'
import {
  grammarLoadCount, highlightLines, subscribeGrammarLoaded, type HighlightSpan,
} from './markdown/highlight.ts'

// The single extension table is owned by `@deepseek-ai/dsh-util-code-language`,
// shared with the Host read card; re-export it so Client callers keep importing
// the language selector and the preview registry's suffix list from this package.
export { CODE_HIGHLIGHT_EXTENSIONS, languageForPath } from '@deepseek-ai/dsh-util-code-language'

/** Highlight one source fragment into one token list per line. */
export type CodeHighlighter = (code: string) => HighlightSpan[][] | undefined

/**
 * Bind the shared lazy highlighter to one language and refresh after its grammar loads.
 * @param language - grammar hint selected from the source filename.
 * @returns a stable fragment highlighter; unknown and loading grammars return `undefined` for plain-text fallback.
 */
export function useCodeHighlighter(language: string | undefined): CodeHighlighter {
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  return useCallback(code => highlightLines(code, language), [language, loaded])
}

export type { HighlightSpan }
