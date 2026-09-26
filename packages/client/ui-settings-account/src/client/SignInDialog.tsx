/** Account authorization dialog; errors allow retry after cancelling any active attempt. */
import { useEffect, useState } from 'react'
import { Button, IconCloseOutlineRegular, IconLoadingOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountKey } from './locales.ts'
import { authorizeUrlWithTheme } from './authorize-url.ts'
import css from './SignInDialog.module.css'

/** @param props - safe account state, localized copy, and user actions. @returns login dialog. */
export function SignInDialog({ account, colorScheme, start, cancel, close, useApiKey, t }: {
  account: AccountSnapshot
  /** Resolved scheme of the active Desktop theme; the copied link carries it. */
  colorScheme: 'light' | 'dark'
  start: () => Promise<void>
  cancel: (id: SignInAttemptId) => Promise<void>
  close: () => void
  useApiKey: () => void
  t: (key: AccountKey) => string
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copyResult, setCopyResult] = useState<{ messageKey: 'copiedLink' | 'copyFailed' } | null>(null)
  const attempt = account.view?.attempt
  useEffect(() => { setCopyResult(null) }, [attempt?.id, attempt?.authorizeUrl])
  useEffect(() => {
    if (copyResult === null) return
    const timer = setTimeout(() => { setCopyResult(null) }, 2000)
    return () => { clearTimeout(timer) }
  }, [copyResult])
  const authorizeUrl = attempt?.authorizeUrl
  const phase = attempt?.phase
  const active = busy || phase === 'initializing' || phase === 'waiting-browser' || phase === 'exchanging' || phase === 'committing'
  const expired = phase === 'expired'
  const error = failed || account.loginFailed || account.failed || phase === 'failed'
  const waiting = active && !error
  const committing = phase === 'committing'
  useEffect(() => { if (account.view?.status === 'credential-stored') close() }, [account.view?.status, close])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setFailed(false)
    try { await action() } catch { setFailed(true) } finally { setBusy(false) }
  }
  const dismiss = () => {
    if (committing || busy) return
    if (active && attempt) void run(async () => { await cancel(attempt.id); close() })
    else close()
  }
  const retry = async () => {
    if (active && attempt) await cancel(attempt.id)
    await start()
  }
  const copyLink = async (authorizeUrl: string) => {
    try {
      await navigator.clipboard.writeText(authorizeUrlWithTheme(authorizeUrl, colorScheme))
      setCopyResult({ messageKey: 'copiedLink' })
    } catch { setCopyResult({ messageKey: 'copyFailed' }) }
  }
  const title = error ? t('failureTitle') : active ? t('browserTitle') : expired ? t('timeoutTitle') : t('loginTitle')
  return <Modal open headless title={title} onClose={dismiss} className={css.dialog as string}>
    <div className={css.content}>
      <div className={css.header}>
        <h2 className={css.title}>{title}</h2>
        <button type="button" className={css.close} aria-label={t('close')} onClick={dismiss}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>
      {waiting ? <p className={css.description}>
        {t('browserPrompt')}<button type="button" className={css.link} disabled={!authorizeUrl}
          onClick={authorizeUrl ? () => { void copyLink(authorizeUrl) } : undefined}>
          {t(copyResult?.messageKey ?? 'copyLink')}
        </button>{t('browserDescription')}
      </p> : <p className={css.description}>
        {error ? t('failed') : expired ? t('timeoutDescription') : t('loginDescription')}
      </p>}
    </div>
    <div className={css.actions}>
      <Button variant="outline" className={css.secondaryButton} disabled={committing || busy}
        onClick={active ? dismiss : useApiKey}>{t(active ? 'cancel' : 'addApiKey')}</Button>
      <Button variant="primary" className={css.primaryButton} disabled={busy || committing || waiting || account.view === undefined}
        aria-label={waiting ? t('waiting') : undefined} onClick={() => { void run(retry) }}>
        {waiting ? <IconLoadingOutlineRegular className={css.spinner} /> : t(expired || error ? 'retry' : 'signIn')}
      </Button>
    </div>
  </Modal>
}
