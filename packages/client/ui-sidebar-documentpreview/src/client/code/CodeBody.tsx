/** Incrementally highlighted source; the document owner supplies the accumulated text and wrap preference. */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { languageForPath } from './languages.ts'
import type {} from './locales.ts'
import css from './CodeBody.module.css'

/** Document owner props and this renderer's localized controls. */
export type CodeBodyProps = DocumentPreviewProps & PropsLocale<'sidebarCodePreview'>

/** @param props - accumulated document contents and framework props. @returns one stable CodeBlock, or no body for byte contents. */
export function CodeBody({ resourceAddress, content, wrap, scrollportRef, t }: CodeBodyProps): ReactNode {
  if (content.kind !== 'text') return null
  const file = parseFileAddress(resourceAddress)
  if (file === undefined) throw new Error(`ui-sidebar-documentpreview: not a file address "${resourceAddress}"`)
  const language = languageForPath(file.path)
  return (
    <div className={css.renderer} data-code-preview data-wrap={wrap}>
      <CodeBlock
        className={css.code}
        contentRef={scrollportRef}
        code={content.text}
        lang={language}
        streaming={!content.eof}
        lineNumbers
        copyLabel={t('copy')}
        copiedLabel={t('copied')}
      />
    </div>
  )
}
