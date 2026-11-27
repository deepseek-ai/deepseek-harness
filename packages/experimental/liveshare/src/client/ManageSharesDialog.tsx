/** Global owner-side list of shares; each row opens that Session's share dialog. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { NS } from './locales.ts'
import type { OwnerShares } from './owner-shares.ts'
import type { OutgoingShare } from './share-types.ts'
import css from './ShareDialog.module.css'

/** Props for the global Liveshare share manager. */
export interface LiveshareManageSharesDialogProps extends PropsLocale<typeof NS> {
  /** Owner share management, addressed through the generated `liveshareShares` namespace. */
  readonly shares: OwnerShares
  /** Open the share dialog for one Session. */
  readonly onOpenShare?: (sessionId: string, sessionTitle: string) => void
  /** Close the manager. */
  readonly onClose: () => void
}

/** Reconnect controls for an offline share keep failures and pending work on that row. */
function ReconnectAction({ share, shares, refreshRow, t }: {
  readonly share: OutgoingShare
  readonly shares: OwnerShares
  readonly refreshRow: (shareId: string) => Promise<void>
  readonly t: LiveshareManageSharesDialogProps['t']
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState<'dialog.ownerStateHeld' | 'manage.reconnectFailed' | 'viewer.reason.share-not-found' | 'viewer.reason.share-expired'>()
  const deadline = share.expiresAt === undefined ? Infinity : Date.parse(share.expiresAt)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!Number.isFinite(deadline) || deadline <= now) return
    const timer = setTimeout(() => { setNow(Date.now()) }, Math.min(0x7fffffff, Math.max(0, deadline - Date.now())))
    return () => { clearTimeout(timer) }
  }, [deadline, now])
  if (!(now < deadline)) return null

  const reconnect = async (): Promise<void> => {
    if (pending.current) return
    if (Date.now() >= deadline) { setNow(Date.now()); return }
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      const result = await shares.reconnect({ shareId: share.shareId })
      if (!result.ok) {
        switch (result.error.code) {
          case 'liveshareShares/share-not-found': setError('viewer.reason.share-not-found'); break
          case 'liveshareShares/share-expired': setError('viewer.reason.share-expired'); break
          case 'liveshareShares/owner-state-held': setError('dialog.ownerStateHeld'); break
          default: setError('manage.reconnectFailed')
        }
      }
    } catch {
      setError('manage.reconnectFailed')
    } finally {
      // Even a failed manual attempt can restart the worker's automatic retry loop.
      await refreshRow(share.shareId)
      pending.current = false
      setBusy(false)
    }
  }
  return <>
    {error !== 'viewer.reason.share-not-found' && error !== 'viewer.reason.share-expired' && (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void reconnect() }}>
        {t(busy ? 'manage.reconnecting' : 'manage.reconnect')}
      </Button>
    )}
    {error !== undefined && <span className={css.error} role="alert">{t(error)}</span>}
  </>
}

/**
 * List every share and open the one whose Session the owner wants to manage.
 * @param props - Owner shares, navigation callback, close callback, and copy.
 * @returns The manager modal.
 */
export function LiveshareManageSharesDialog({ shares, onOpenShare, onClose, t }: LiveshareManageSharesDialogProps): ReactNode {
  const [shareList, setShareList] = useState<readonly OutgoingShare[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  /** The share whose stop the owner is confirming; undefined while no confirmation is open. */
  const [stopTarget, setStopTarget] = useState<OutgoingShare>()
  const [stopAcknowledged, setStopAcknowledged] = useState(false)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    let cancelled = false
    void shares.list()
      .then((listed) => {
        if (cancelled) return
        if (!listed.ok) throw new Error('shares unavailable')
        setShareList(listed.value.shares)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setError(t('manage.unavailable'))
      })
    return () => { cancelled = true }
  }, [shares, t])

  const refreshRow = async (shareId: string): Promise<void> => {
    try {
      const listed = await shares.list()
      if (!listed.ok) { setError(t('manage.unavailable')); return }
      const row = listed.value.shares.find(share => share.shareId === shareId)
      setShareList(current => current.flatMap(share => share.shareId === shareId ? row ?? [] : share))
      setError('')
    } catch {
      setError(t('manage.unavailable'))
    }
  }

  const stopShare = async (): Promise<void> => {
    const target = stopTarget
    /* v8 ignore next -- the confirmation is only rendered while a share is selected */
    if (target === undefined) return
    setStopping(true)
    setError('')
    try {
      const stopped = await shares.stop({ shareId: target.shareId })
      // A Host whose share state another running process holds refuses the write; the share stays
      // listed, and the owner acts on it in the process holding the state.
      if (!stopped.ok) {
        setError(stopped.error.code === 'liveshareShares/owner-state-held'
          ? t('dialog.ownerStateHeld')
          : t('dialog.stopFailed'))
        return
      }
      setShareList(current => current.filter(share => share.shareId !== target.shareId))
      setStopTarget(undefined)
      setStopAcknowledged(false)
    } catch {
      setError(t('dialog.stopFailed'))
    } finally {
      setStopping(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('manage.title')}
      closeLabel={t('manage.done')}
      className={css.modal as string}
      footer={<Button variant="primary" onClick={onClose}>{t('manage.done')}</Button>}
    >
      <div className={css.form}>
        <p className={css.description}>{t('manage.description')}</p>
        {!loaded && error === '' ? <p className={css.noRequests}>{t('manage.loading')}</p> : null}
        {loaded && shareList.length === 0 ? <p className={css.noRequests}>{t('manage.empty')}</p> : null}
        {shareList.length === 0 ? null : (
          <ul className={css.outgoingList}>
            {shareList.map((share) => {
              const primary = share.sessionIds?.[0] ?? share.sessionId ?? ''
              const open = primary === '' || onOpenShare === undefined
                ? undefined
                : () => { onOpenShare(primary, share.sessionTitle) }
              return (
                <li key={share.shareId} className={css.outgoingItem}>
                  <div className={css.managerRow}>
                    <strong title={share.sessionTitle}>{share.sessionTitle}</strong>
                    <span className={share.online ? css.online : css.offline}>
                      {t(share.online ? 'dialog.share.online' : share.reconnectStopped === true ? 'manage.reconnectStopped' : 'dialog.share.offline')}
                    </span>
                    <div className={css.managerActions}>
                      {!share.online && <ReconnectAction share={share} shares={shares} refreshRow={refreshRow} t={t} />}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={open === undefined}
                        onClick={open}
                      >
                        {t('manage.open')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setStopTarget(share); setStopAcknowledged(false) }}
                      >
                        {t('manage.cancelShare')}
                      </Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {error === '' ? null : <div className={css.error} role="alert">{error}</div>}
      </div>
      <RiskConfirmation
        open={stopTarget !== undefined}
        title={t('manage.stop.title')}
        description={t('manage.stop.description')}
        acknowledgeLabel={t('manage.stop.acknowledge')}
        cancelLabel={t('dialog.cancel')}
        closeLabel={t('manage.done')}
        confirmLabel={t('dialog.stop')}
        acknowledged={stopAcknowledged}
        disabled={stopping}
        onAcknowledgedChange={setStopAcknowledged}
        onCancel={() => { setStopAcknowledged(false); setStopTarget(undefined) }}
        onConfirm={() => { void stopShare() }}
      />
    </Modal>
  )
}
