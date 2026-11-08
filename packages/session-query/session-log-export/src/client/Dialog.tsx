/** Root overlay showing one Session export at a time in initiation order. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionLogDownloadState } from './controller.ts'
import { NS } from './locales.ts'

/** Download state and dismissal bound into the root overlay entry. */
export interface SessionLogDownloadDialogInjected {
  hooks: { sessionLogDownload: ObservableSnapshot<SessionLogDownloadState> }
  dismiss: (sessionId: SessionId) => void
}

/** Root runtime, localized copy, and injected download state and actions. */
export type SessionLogDownloadDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionLogDownloadDialogInjected>

/**
 * Show the earliest open export independently of the displayed conversation.
 * @param props - root runtime, bound controller state, dismissal, and localized copy.
 * @returns one modal, or null when all exports are dismissed.
 */
export function SessionLogDownloadDialog({
  useSessionLogDownload, dismiss, t,
}: SessionLogDownloadDialogProps) {
  const bySession = useSessionLogDownload(state => state.bySession)
  const pending = Object.entries(bySession)
    .filter((pair): pair is [string, NonNullable<typeof pair[1]>] => pair[1]?.open === true)
    .sort((a, b) => a[1].order - b[1].order)[0]
  if (pending === undefined) return null
  const [id, entry] = pending
  const sessionId = id as SessionId
  const { status } = entry
  const title = status === 'downloading'
    ? t('dialog.preparingTitle')
    : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle')
  const description = status === 'downloading'
    ? t('dialog.preparingDescription')
    : status === 'success' ? t('dialog.successDescription') : entry.error || t('dialog.commandFailed')

  return (
    <Modal
      open
      onClose={() => { dismiss(sessionId) }}
      title={title}
      description={`${t('dialog.session', { sessionId })} ${description}`}
      closeLabel={t('dialog.close')}
      footer={<Button variant="primary" onClick={() => { dismiss(sessionId) }}>{t('dialog.close')}</Button>}
    />
  )
}
