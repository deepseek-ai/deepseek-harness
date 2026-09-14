/** One retained Markdown renderer over the document owner's accumulated text. */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import type {} from './locales.ts'
import css from './MarkdownBody.module.css'

/** Standard document inputs and this implementation's locale. */
export type MarkdownBodyProps = DocumentPreviewProps & PropsLocale<'documentMarkdown'>

/**
 * Render one accumulated document; EOF completes the primitive's full parse.
 * @param props - owner-loaded contents and localized primitive labels.
 * @returns Markdown content, or nothing for a non-text delivery.
 */
export function MarkdownBody({ content, t }: MarkdownBodyProps): ReactNode {
  const copyLabel = t('code.copy')
  const copiedLabel = t('code.copied')
  const footnotes = t('footnotes')
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel, copiedLabel }, footnotes,
  }), [copyLabel, copiedLabel, footnotes])
  if (content.kind !== 'text') return null
  return (
    <div className={css.document} data-document-markdown>
      <MarkdownText text={content.text} streaming={!content.eof} labels={labels} />
    </div>
  )
}
