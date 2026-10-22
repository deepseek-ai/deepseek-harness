import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  Button, IconCopyOutlineRegular, IconDownloadOutlineRegular, IconEllipsisOutlineRegular,
  IconPaperPlaneOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogProps } from './Dialog.tsx'
import type { SessionLogDownloadDialogInjected } from './Dialog.tsx'
import type { SessionMarkdownCopyState } from './copy-controller.ts'
import css from './HeaderAction.module.css'

/** Markdown copy state and action bound into the Session Header contribution. */
export interface SessionMarkdownCopyHeaderInjected {
  hooks: { sessionMarkdownCopy: ObservableSnapshot<SessionMarkdownCopyState> }
  /**
   * Copy one complete Session transcript to the clipboard.
   * @param sessionId - Session captured by the menu click.
   */
  copyMarkdown: (sessionId: SessionId) => Promise<void>
}

/** Session download controls plus Markdown copy and observable feedback availability. */
export interface SessionLogDownloadHeaderInjected
  extends SessionLogDownloadDialogInjected, SessionMarkdownCopyHeaderInjected {
  hooks: SessionLogDownloadDialogInjected['hooks']
    & SessionMarkdownCopyHeaderInjected['hooks']
    & { feedbackAvailable: ObservableSnapshot<boolean> }
  /**
   * Open the existing Session feedback draft without recording feedback; no-op after the feedback plugin unloads.
   * @param sessionId - Session whose feedback form to open.
   */
  openFeedback: (sessionId: SessionId) => void
}

/** Session download props plus the optional feedback action. */
export type SessionLogDownloadHeaderProps = SessionLogDownloadDialogProps & InjectFace<SessionLogDownloadHeaderInjected>

/**
 * Render the Session Header menu with Markdown copy, download, and optional
 * feedback actions.
 * @param props - Session runtime, download and copy state, and localized copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
export function SessionLogDownloadHeaderAction(props: SessionLogDownloadHeaderProps): ReactNode {
  const {
    sessionId, useSessionLogDownload, useSessionMarkdownCopy, useFeedbackAvailable,
    request, copyMarkdown, openFeedback, t,
  } = props
  const feedbackAvailable = useFeedbackAvailable(value => value)
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const copying = useSessionMarkdownCopy(state => state.copying)
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
          { id: 'copy', label: t('menu.copyMarkdown'), icon: <IconCopyOutlineRegular />, disabled: copying },
          { id: 'download', label: t('menu.download'), icon: <IconDownloadOutlineRegular />, disabled: busy },
          ...feedbackAvailable ? [{ id: 'feedback', label: t('menu.feedback'), icon: <IconPaperPlaneOutlineRegular /> }] : [],
        ]}
        onSelect={(id) => {
          setOpen(false)
          if (id === 'feedback') openFeedback(sessionId)
          else if (id === 'copy') void copyMarkdown(sessionId)
          else void request(sessionId)
        }}
        anchor={(
          <Button
            size="sm"
            className={css.moreButton}
            aria-label={t('header.more')}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-busy={busy || copying}
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
