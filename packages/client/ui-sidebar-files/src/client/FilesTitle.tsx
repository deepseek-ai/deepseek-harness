/**
 * The files type's chip title: the folder sheet before the type's label.
 * Registered under `sidebar.right.pane.tab.title`; without it the chip would
 * show the bare label. The tree in the body draws its own row glyphs and never
 * this one.
 */
import type { ReactNode } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './FilesBody.module.css'

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the folder sheet followed by the tab's title text.
 */
export function FilesTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <FileTypeIcon kind="folder" size={16} className={css.titleIcon} />
      {tab.title}
    </>
  )
}
