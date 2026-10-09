/**
 * Font settings registered into the General section item slot: the text
 * font-size row, whose disclosure button expands a region holding the font
 * row for each role and the code and terminal size rows. The region starts
 * collapsed on every mount.
 */
import { useId, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { FontRole } from '../theme-settings.ts'
import type { createFontRowStore } from './settings-store.ts'
import { FontFamilyRow } from './FontFamilyRow.tsx'
import { FontSizeRow, type FontSizeRowExpander } from './FontSizeRow.tsx'
import css from './FontSettingsGroup.module.css'

/** Injected business face: font writes by role. */
export interface FontSettingsInjected {
  /** Change one role's font list (normalized by the theme service). */
  setFontFamily: (role: FontRole, value: string) => void
  /** Change one role's font size (integer px within its FONT_SIZE_SPECS range). */
  setFontSize: (role: FontRole, px: number) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type FontSettingsGroupProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createFontRowStore>>
  & PropsLocale<'settings.theme'> & FontSettingsInjected

/**
 * Render the text font-size row and its expandable font settings.
 * @param props - composed slot props.
 * @returns the text size row and, when expanded, the font rows.
 */
export function FontSettingsGroup({ setFontFamily, setFontSize, ...shared }: FontSettingsGroupProps) {
  const [open, setOpen] = useState(false)
  const regionId = useId()
  const family = (role: FontRole) => (
    <FontFamilyRow {...shared} role={role} setFontFamily={(value) => { setFontFamily(role, value) }} />
  )
  const size = (role: FontRole, expander?: FontSizeRowExpander) => (
    <FontSizeRow {...shared} role={role} expander={expander} setFontSize={(px) => { setFontSize(role, px) }} />
  )
  return (
    <div className={css.group}>
      {size('text', { open, controls: regionId, onToggle: () => { setOpen(value => !value) } })}
      {open && (
        <div id={regionId}>
          {family('text')}
          {family('code')}
          {size('code')}
          {family('terminal')}
          {size('terminal')}
        </div>
      )}
    </div>
  )
}
