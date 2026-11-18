/**
 * The content tab's chip title: a file icon chosen by media type before the
 * same title the body header shows. Registered under
 * `sidebar.right.pane.tab.title` with the body's key.
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconTitle } from '../TextTitle.tsx'
import { iconKindOf } from './title.ts'

/** The title's composed props: the tab, its resource, and the title sources. */
export type ContentTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'>

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab reader, the resource hook, and the title sources.
 * @returns the 16px file icon followed by the title text.
 */
export function ContentTitle({ useTabInfo }: ContentTitleProps): ReactNode {
  const { tab } = useTabInfo()
  const params = tab.navigation.params
  const input = params !== undefined && 'previewContent' in params ? params : undefined
  const content = input?.previewContent
  const title = input?.previewTitle ?? tab.title
  return <IconTitle kind={iconKindOf(content?.mediaType)} title={title} />
}
