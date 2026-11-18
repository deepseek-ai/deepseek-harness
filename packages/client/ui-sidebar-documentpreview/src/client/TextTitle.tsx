/**
 * The text type's chip title: the file type's coloured sheet before the name
 * the registry captured at open time. Registered under
 * `sidebar.right.pane.tab.title`; without it the chip would show the bare name.
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { FileTypeIcon, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileTypeKind } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TextPreview.module.css'

/**
 * A chip title as every preview tab type of this package draws it.
 * @param props - the file icon category and the title text.
 * @returns the 16px sheet followed by the text.
 */
export function IconTitle({ kind, title }: { readonly kind: FileTypeKind; readonly title: string }): ReactNode {
  return (
    <>
      <FileTypeIcon kind={kind} size={16} className={css.titleIcon} />
      {title}
    </>
  )
}

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the type's 16px sheet followed by the tab's title text.
 */
export function TextTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <IconTitle kind={classifyFileType(tab.title)} title={tab.title} />
}
