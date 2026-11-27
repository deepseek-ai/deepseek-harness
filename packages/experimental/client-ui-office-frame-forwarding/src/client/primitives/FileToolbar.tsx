/** Icon action matching the document toolbar's file controls. */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/client'
import css from './FileToolbar.module.css'

/**
 * Render one icon action in the shared file toolbar.
 * @param props - Icon, localized label, shortcut keys, and native button attributes.
 * @returns a consistently sized file-toolbar action.
 */
export function FileToolbarButton({ icon, label, shortcutKeys, ...attributes }: {
  icon: ReactNode
  label: string
  shortcutKeys?: readonly string[] | undefined
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>): ReactNode {
  return <Tooltip label={label} shortcutKeys={shortcutKeys} side="bottom" delayMs={500}>
    <button {...attributes} type="button" className={css.button} aria-label={label}>{icon}</button>
  </Tooltip>
}
