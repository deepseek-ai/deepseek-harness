/**
 * The rename action: a `sidebar.workspaces.session.menu.item` row that raises
 * the rename request, and the `shell.overlay` dialog entry that answers it.
 * The dialog lives outside the row menu because the row unmounts with the
 * menu; the browser raises the same request from a title double-click.
 */
import { useRef, useState } from 'react'
import { Button, IconEditOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  RenameSessionInjected, SessionMenuItemProps, SessionRenameDialogInjected, SessionRenameDialogProps, SessionRenameTarget,
} from '../contract/slots.ts'
import css from '../rows/WorkspaceBrowser.module.css'

/**
 * Menu row (order 200): ask for the rename dialog, seeded with the row's current title.
 * @param props - owner share, menu open state, and the rename share.
 * @returns the row.
 */
export function RenameSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, useShortcuts, requestSessionRename, t,
}: SessionMenuItemProps<RenameSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'session.rename'))
  return (
    <MenuItemButton
      shortcut={shortcut}
      icon={<IconEditOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        requestSessionRename(sessionId, displayTitle)
      }}
    >
      {t('rename')}
    </MenuItemButton>
  )
}

/**
 * The `shell.overlay` entry: nothing while no rename is requested, otherwise
 * one dialog per request (keyed by the Session, so a new request starts a
 * fresh draft). Sessions have no client-side name-conflict rule (the host
 * normalizes), and unlike Workspace rename an unchanged title is NOT
 * blocked. An unnamed Session starts with an empty draft and requires a name.
 * @param props - the request hook, its settlement, the rename hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionRenameDialog({ useRenameRequest, settleSessionRename, renameSession, t }: SessionRenameDialogProps) {
  const request = useRenameRequest(pending => pending)
  if (request === null) return null
  return (
    <RenameForm
      key={request.sessionId}
      request={request}
      renameSession={renameSession}
      onSettle={settleSessionRename}
      t={t}
    />
  )
}

/** One request's dialog: the draft seeds from the request on mount; in-flight and error state die with it. */
function RenameForm({ request, renameSession, onSettle, t }: {
  request: SessionRenameTarget
  renameSession: SessionRenameDialogInjected['renameSession']
  onSettle: () => void
  t: SessionRenameDialogProps['t']
}) {
  const [draft, setDraft] = useState(request.currentTitle)
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // IME composition: Enter that commits a composition must not submit.
  const composingRef = useRef(false)
  const trimmed = draft.trim()
  const blocked = renaming || trimmed === ''
  const close = () => {
    if (renaming) return
    onSettle()
  }
  const confirm = () => {
    if (blocked) return
    setRenaming(true)
    setError(null)
    renameSession(request.sessionId, trimmed).then(() => {
      setRenaming(false)
      onSettle()
    }).catch((reason: unknown) => {
      setRenaming(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('rename.session.title')}
      footer={(
        <>
          <Button variant="outline" disabled={renaming} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={confirm}>{t('rename')}</Button>
        </>
      )}
    >
      <input
        className={css.renameInput}
        value={draft}
        aria-label={t('field.sessionName')}
        data-modal-autofocus
        disabled={renaming}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setDraft(e.target.value); setError(null) }}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composingRef.current) {
            e.preventDefault()
            confirm()
          }
        }}
      />
      {error !== null && <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
