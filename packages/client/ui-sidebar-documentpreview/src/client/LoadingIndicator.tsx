/** Shared indeterminate loading feedback for document reads and rendering. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './LoadingIndicator.module.css'

/**
 * @param props - localized status label and compact inline placement for additional pages.
 * @returns a centered document loading status or an accessible inline spinner.
 */
export function LoadingIndicator({ label, inline = false }: {
  label: string
  inline?: boolean
}): ReactNode {
  return <span className={clsx(css.loading, inline && css.inline)} role="status" aria-label={label} data-document-loading>
    <StateDot state="ongoing" size={inline ? 14 : 28} />
    {!inline && <span>{label}</span>}
  </span>
}
