/** Account sign-out confirmation with the current task impact. */
import { useState } from 'react'
import { Button, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountKey } from './locales.ts'
import css from './SignInDialog.module.css'

/** @param props - task impact at opening, localized copy, and account actions. @returns sign-out confirmation. */
export function SignOutDialog({ running, signOut, close, t }: {
  running: boolean | 'unknown'
  signOut: () => Promise<void>
  close: () => void
  t: (key: AccountKey) => string
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const dismiss = () => { if (!busy) close() }
  const confirm = async () => {
    setBusy(true)
    setFailed(false)
    try { await signOut(); close() }
    catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return <Modal open headless title={t('signOut')} onClose={dismiss} className={css.dialog as string}>
    <div className={css.content}>
      <div className={css.header}>
        <h2 className={css.title}>{t('signOut')}</h2>
        <button type="button" className={css.close} aria-label={t('close')} disabled={busy} onClick={dismiss}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>
      <p className={css.description}>{t(running === 'unknown' ? 'signOutUnknownDescription' : running ? 'signOutRunningDescription' : 'signOutDescription')}</p>
      {failed && <p className={css.description} role="alert">{t('failed')}</p>}
    </div>
    <div className={css.actions}>
      <Button variant="outline" className={css.secondaryButton} disabled={busy} onClick={dismiss}>{t('cancel')}</Button>
      <Button variant="primary" className={css.primaryButton} disabled={busy}
        onClick={() => { void confirm() }}>{t('signOut')}</Button>
    </div>
  </Modal>
}
