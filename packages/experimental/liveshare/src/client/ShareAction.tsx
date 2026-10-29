/** Session-header action that opens the Liveshare owner-side share dialog. */

import { useEffect, useState, type ReactNode } from 'react'
import { IconShareOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { LiveshareManageSharesDialog } from './ManageSharesDialog.tsx'
import { openManagedSession, rememberManagedShare, takeManagedShare } from './share-navigation.ts'
import { LiveshareShareDialog } from './ShareDialog.tsx'
import type { NS } from './locales.ts'
import type { OwnerShares } from './owner-shares.ts'
import css from './ShareAction.module.css'

/** Business face the header action receives: the owner's share-management Remote. */
export interface LiveshareShareActionInjected {
  /** Owner share management, addressed through the generated `liveshareShares` namespace. */
  readonly shares: OwnerShares
}

/** Full props for the Liveshare Session-header utility. */
export type LiveshareShareActionProps =
  PropsRuntime<'conversation.session.header.utilities'> & InjectFace<LiveshareShareActionInjected> & PropsLocale<typeof NS>

/**
 * Render the Session Header Share action and its dialog for a local owner.
 * @param props - Session runtime plus localized copy.
 * @returns the header action and optional dialog.
 */
export function LiveshareShareAction({ sessionId, useSessions, shares, t }: LiveshareShareActionProps): ReactNode {
  const [view, setView] = useState<'closed' | 'share' | 'manage'>('closed')
  const [managedShare, setManagedShare] = useState<{ readonly sessionId: SessionId; readonly sessionTitle: string }>()
  const [defaultRelay, setDefaultRelay] = useState('')
  const sessionTitle = useSessions(state => state.byId[sessionId]?.displayTitle) ?? sessionId

  useEffect(() => {
    if (takeManagedShare(sessionId)) setView('share')
  }, [sessionId])

  useEffect(() => {
    if (view === 'closed' || defaultRelay !== '') return
    let cancelled = false
    void shares.relay()
      .then((result) => {
        if (cancelled || !result.ok) return
        // No saved address is a valid answer: the dialog opens with an empty field that says so.
        setDefaultRelay(result.value.effective ?? '')
      })
      .catch(() => { /* Dialog accepts a typed relay when the host read fails. */ })
    return () => { cancelled = true }
  }, [defaultRelay, view, shares])

  return (
    <>
      <button
        type="button"
        className={css.trigger}
        aria-label={t('header.action')}
        onClick={() => { setManagedShare(undefined); setView('share') }}
      >
        <span>{t('header.action')}</span>
        <IconShareOutlineRegular size={12} />
      </button>
      {view === 'share' && (
        <LiveshareShareDialog
          sessionId={managedShare?.sessionId ?? sessionId}
          sessionTitle={managedShare?.sessionTitle ?? sessionTitle}
          defaultRelay={defaultRelay}
          shares={shares}
          onManage={() => { setView('manage') }}
          onClose={() => { setManagedShare(undefined); setView('closed') }}
          t={t}
        />
      )}
      {view === 'manage' && (
        <LiveshareManageSharesDialog
          shares={shares}
          onOpenShare={(target, title) => {
            const selected = { sessionId: target as SessionId, sessionTitle: title }
            if (target !== sessionId) {
              rememberManagedShare(target)
              openManagedSession(target)
            }
            setManagedShare(selected)
            setView('share')
          }}
          onClose={() => { setView('closed') }}
          t={t}
        />
      )}
    </>
  )
}
