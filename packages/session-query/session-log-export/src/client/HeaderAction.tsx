/** Session Header trigger for the shared menu, retaining its Session-scoped download dialog. */
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextMenuTarget, MenuPoint } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { Button, IconEllipsisOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogProps } from './Dialog.tsx'
import type { SessionLogDownloadDialogInjected } from './Dialog.tsx'
import type { SessionMarkdownCopyState } from './copy-controller.ts'
import css from './HeaderAction.module.css'

/** Session download controls and observable menu/copy state for the Header trigger. */
export interface SessionLogDownloadHeaderInjected extends SessionLogDownloadDialogInjected {
  hooks: SessionLogDownloadDialogInjected['hooks'] & {
    sessionMarkdownCopy: ObservableSnapshot<SessionMarkdownCopyState>
    headerMenu: ObservableSnapshot<ContextMenuTarget | null>
  }
  /**
   * Toggle the shared menu for the captured Header Session.
   * @param sessionId - Session displayed by this Header.
   * @param point - trigger's viewport anchor.
   */
  openMenu: (sessionId: SessionId, point: MenuPoint) => void
}

/** Session runtime, localized copy, and injected Header operations. */
export type SessionLogDownloadHeaderProps = SessionLogDownloadDialogProps & InjectFace<SessionLogDownloadHeaderInjected>

/**
 * Render the Session Header's shared-menu trigger and persistent download dialog.
 * @param props - Session runtime, download and copy state, and localized copy.
 * @returns the Header action and Session-scoped dialog.
 */
export function SessionLogDownloadHeaderAction(props: SessionLogDownloadHeaderProps): ReactNode {
  const { sessionId, useSessionLogDownload, useSessionMarkdownCopy, useHeaderMenu, openMenu, t } = props
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const copying = useSessionMarkdownCopy(state => state.copying)
  const open = useHeaderMenu(target => target?.kind === 'sessionHeader' && target.value.sessionId === sessionId)
  const busy = entry?.status === 'downloading'
  return (
    <>
      <Button
        size="sm"
        className={css.moreButton}
        data-context-menu-trigger
        aria-label={t('header.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy || copying}
        onClick={(event) => {
          const button = event.currentTarget
          button.focus()
          const rect = button.getBoundingClientRect()
          openMenu(sessionId, { x: rect.left, y: rect.bottom })
        }}
      >
        <IconEllipsisOutlineRegular />
      </Button>
      <SessionLogDownloadDialog {...props} />
    </>
  )
}
