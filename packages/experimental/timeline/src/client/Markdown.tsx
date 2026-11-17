import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** Render saved detail text with Harness's shared, compact Markdown component. */
export function Markdown({ text, t }: { text: string } & PropsLocale<'timeline'>): ReactNode {
  const labels = useMemo(
    () => ({
      code: {
        copyLabel: t('markdownCopy'),
        copiedLabel: t('markdownCopied'),
        toolbarLabels: {
          codeLabel: t('markdownCode'),
          wrapLabel: t('markdownWrap'),
          unwrapLabel: t('markdownUnwrap'),
        },
      },
      footnotes: t('markdownFootnotes'),
    }),
    [t],
  )
  return (
    <div className="timeline-markdown">
      <MarkdownText text={text} labels={labels} variant="compact" />
    </div>
  )
}
