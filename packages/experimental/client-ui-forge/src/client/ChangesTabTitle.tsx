/** Chip title of a changes tab: the changes icon and the view's name in the current language. */

import type { ReactNode } from 'react'
import { IconListPenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { changesTitle, parseChangesAddress } from './changes-address.ts'
import type { NS } from './locales.ts'
import css from './ForgeTab.module.css'

/** Props of the changes tab title. */
export type ChangesTabTitleProps = Pick<PropsRuntime<'sidebar.right.pane.tab.title'>, 'useTabInfo'> & PropsLocale<typeof NS>

/**
 * Render the chip title of a changes tab; an address this package did not mint keeps the captured title.
 * @param props - tab information and forge panel copy.
 * @returns the icon followed by the title.
 */
export function ChangesTabTitle({ useTabInfo, t }: ChangesTabTitleProps): ReactNode {
  const { tab } = useTabInfo()
  const target = parseChangesAddress(tab.contentId)
  return (
    <>
      <span className={css.titleIcon}><IconListPenOutlineRegular size={16} /></span>
      <span className={css.titleText}>{target === undefined ? tab.title : changesTitle(target.source, t)}</span>
    </>
  )
}
