/** Chip title of the forge tab: the change request glyph and the localized tab name. */

import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ChangeRequestGlyph } from './glyphs.tsx'
import type { NS } from './locales.ts'
import css from './ForgeTab.module.css'

/**
 * Render the tab chip title in the current UI language.
 * @param props - forge panel copy.
 * @returns the glyph followed by the tab name.
 */
export function ForgeTabTitle({ t }: PropsLocale<typeof NS>): ReactNode {
  return (
    <>
      <span className={css.titleIcon}><ChangeRequestGlyph tone="open" tinted={false} size={16} /></span>
      <span className={css.titleText}>{t('tab.title')}</span>
    </>
  )
}
