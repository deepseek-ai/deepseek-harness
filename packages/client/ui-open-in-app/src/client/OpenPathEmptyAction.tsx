/** File opening action in an unpreviewable document's empty state. */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { NS } from './locales.ts'
import { FileOpenTarget, type OpenPathInjected } from './OpenPathAction.tsx'

/** Full props of the unpreviewable empty-state contribution. */
export type OpenPathEmptyActionProps =
  PropsRuntime<'sidebar.right.tab.document.unpreviewable'>
  & PropsLocale<typeof NS>
  & InjectFace<OpenPathInjected>

/**
 * Render the shared file opening menu with a larger labeled main button.
 * @param props - unpreviewable file and injected opening capabilities.
 * @returns the shared file opening action.
 */
export function OpenPathEmptyAction(props: OpenPathEmptyActionProps): ReactNode {
  return <FileOpenTarget {...props} empty />
}
