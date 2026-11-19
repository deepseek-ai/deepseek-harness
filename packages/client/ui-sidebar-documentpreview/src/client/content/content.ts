/**
 * Convert previewable content into the document renderer input its selected
 * renderer loads: text pages for `text-pages`, one byte array for
 * `bytes-complete`.
 */
import type { DocumentContent, DocumentLoadMode } from '../index.ts'
import type { PreviewContent } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/**
 * One text as a single complete page, counted the way the workspace file
 * reader counts: each `\n` ends a line, a trailing partial line counts, and the
 * page text omits the final terminator. An empty text holds zero lines.
 * @param text - the complete text.
 * @returns the page text and its line count.
 */
export function textPage(text: string): { readonly text: string; readonly lines: number } {
  if (text === '') return { text, lines: 0 }
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return { text: body, lines: body.split('\n').length }
}

/**
 * The renderer input for one content value.
 * @param content - the loaded content.
 * @param loading - the selected renderer's loading mode; media-type renderers never load content themselves.
 * @returns text content with one complete page, or complete bytes.
 */
export function documentContentOf(content: PreviewContent, loading: Exclude<DocumentLoadMode, 'renderer'>): DocumentContent {
  if (loading === 'bytes-complete') {
    return { kind: 'bytes', data: 'bytes' in content ? content.bytes : new TextEncoder().encode(content.text) }
  }
  const text = 'text' in content ? content.text : new TextDecoder().decode(content.bytes)
  return { kind: 'text', text, pages: [{ offset: 1, ...textPage(text) }], eof: true }
}
