/** Plain source display for files without a more specific document renderer. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { linesOf } from './lines.ts'
import css from '../TextPreview.module.css'

/** @param props - document contents and standard tab information. @returns source lines with navigation targets. */
export function TextBody({ content, useTabInfo }: DocumentPreviewProps): ReactNode {
  const { tab } = useTabInfo()
  const params = tab.navigation.params
  const target = params !== undefined && 'line' in params ? params.line : undefined
  if (content.kind !== 'text') return null
  return (
    <div className={css.textDocument} data-textpreview-plain>
      {content.pages.map(page => (
        <pre key={page.offset} className={css.page} data-textpreview-page={page.offset}>
          {linesOf(page).map((text, index) => {
            const number = page.offset + index
            return (
              <div
                key={number}
                className={clsx(css.line, number === target && css.lineTarget)}
                data-textpreview-line={number}
                {...number === target ? { 'data-textpreview-target': number } : {}}
              >
                {text}{'\n'}
              </div>
            )
          })}
        </pre>
      ))}
    </div>
  )
}
