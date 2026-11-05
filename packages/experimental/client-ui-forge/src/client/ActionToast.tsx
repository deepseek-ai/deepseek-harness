/** App-wide notice for forge panel actions, rendered outside the panel so it outlives it. */

import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type { NoticeSource } from './source.ts'

/** Full-opacity hold of a notice that offers to undo its action, long enough to reach the action. */
const UNDO_HOLD_MS = 6000

/** Full props of the `shell.overlay` entry. */
export type ActionToastProps = PropsLocale<typeof NS> & InjectFace<Omit<NoticeSource, 'report'>>

/**
 * Render the current notice: a success notice with its undo action, or a failure warning.
 * @param props - notice hook, dismissal, and copy.
 * @returns the toast, or nothing while no notice shows.
 */
export function ActionToast({ useNotice, dismiss, t }: ActionToastProps): ReactNode {
  const notice = useNotice(current => current)
  if (notice === null) return null
  const { undo } = notice
  return (
    <Toast
      key={`forge-panel-${String(notice.seq)}`}
      text={t(notice.key, notice.params)}
      {...notice.tone === 'success' ? { tone: 'success' as const } : { icon: <IconWarningOutlineRegular /> }}
      {...undo === undefined
        ? {}
        : {
          holdMs: UNDO_HOLD_MS,
          actions: [{ label: t('toast.undo'), onClick: () => { dismiss(); undo() } }],
        }}
      onDone={dismiss}
    />
  )
}
