import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, IconDownloadOutlineRegular, IconEllipsisOutlineRegular, IconPaperPlaneOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogProps } from './Dialog.tsx'
import type { SessionLogDownloadDialogInjected } from './Dialog.tsx'
import css from './HeaderAction.module.css'

/** Session download controls with observable feedback availability and a Session feedback action. */
export interface SessionLogDownloadHeaderInjected extends SessionLogDownloadDialogInjected {
  hooks: SessionLogDownloadDialogInjected['hooks'] & { feedbackAvailable: ObservableSnapshot<boolean> }
  /**
   * Open the existing Session feedback draft without recording feedback; no-op after the feedback plugin unloads.
   * @param sessionId - Session whose feedback form to open.
   */
  openFeedback: (sessionId: SessionId) => void
}

/** Session download props plus the optional feedback action. */
export type SessionLogDownloadHeaderProps = SessionLogDownloadDialogProps & InjectFace<SessionLogDownloadHeaderInjected>

/**
 * Render the Session Header menu with download and optional feedback actions.
 * @param props - Session runtime, download controller, and localized copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
export function SessionLogDownloadHeaderAction(props: SessionLogDownloadHeaderProps): ReactNode {
  const { sessionId, useSessionLogDownload, useFeedbackAvailable, request, openFeedback, t } = props
  const feedbackAvailable = useFeedbackAvailable(value => value)
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'downloading'
  const [open, setOpen] = useState(false)

  return (
    <>
      <Menu
        open={open}
        align="end"
        dense
        onClose={() => { setOpen(false) }}
        items={[
          { id: 'download', label: t('menu.download'), icon: <IconDownloadOutlineRegular />, disabled: busy },
          ...feedbackAvailable ? [{ id: 'feedback', label: t('menu.feedback'), icon: <IconPaperPlaneOutlineRegular /> }] : [],
        ]}
        onSelect={(id) => {
          setOpen(false)
          if (id === 'feedback') openFeedback(sessionId)
          else void request(sessionId)
        }}
        anchor={(
          <Button
            size="sm"
            className={css.moreButton}
            aria-label={t('header.more')}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-busy={busy}
            onClick={() => { setOpen(value => !value) }}
          >
            <IconEllipsisOutlineRegular />
          </Button>
        )}
      />
      <SessionLogDownloadDialog {...props} />
    </>
  )
}
