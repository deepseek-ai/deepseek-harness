/** Global owner-side list of shares; each row opens that Session's share dialog. */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
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

  const stopShare = async (): Promise<void> => {
    const target = stopTarget
    /* v8 ignore next -- the confirmation is only rendered while a share is selected */
    if (target === undefined) return
    setStopping(true)
    setError('')
    try {
      const stopped = await shares.stop({ shareId: target.shareId })
      if (!stopped.ok) throw new Error('stop refused')
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
            {shareList.map(share => (
              <li key={share.shareId} className={css.outgoingItem}>
                <div className={css.managerRow}>
                  <strong title={share.sessionTitle}>{share.sessionTitle}</strong>
                  <span className={share.online ? css.online : css.offline}>
                    {t(share.online ? 'dialog.share.online' : 'dialog.share.offline')}
                  </span>
                  <div className={css.managerActions}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={onOpenShare === undefined}
                      onClick={() => { onOpenShare?.(share.sessionId, share.sessionTitle) }}
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
            ))}
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
