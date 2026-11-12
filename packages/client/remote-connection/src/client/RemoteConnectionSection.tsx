/** Separate QR and tokenized-link controls for signing another browser in. */
import { QRCodeSVG } from 'qrcode.react'
import { Button, IconWarningOutlineMedium, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteConnectionContentProps } from './slots.ts'
import css from './RemoteConnectionSection.module.css'

/** Renderer-derived section data, localized copy, and actions. */
export type RemoteConnectionSectionProps = RemoteConnectionContentProps & PropsLocale<'remoteConnection'>

/**
 * Present independent QR and tokenized-link cards with loading confined to the QR preview.
 * @param props - Section injection and standard slot props.
 * @returns Remote connection settings content.
 */
export function RemoteConnectionSection(props: RemoteConnectionSectionProps) {
  const { t, useRemoteConnection } = props
  const loading = useRemoteConnection(state => state.phase === 'loading' && state.deployment === null)
  if (loading) return <div className={css.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={20} /></div>
  return <section className={css.section} aria-label={t('title')}>
    <header className={css.header}>
      <h2 className={css.title}>{t('title')}</h2>
    </header>
    <QrLoginCard {...props} />
    <LinkLoginCard {...props} />
  </section>
}

function QrLoginCard({ t, useRemoteConnection, create, cancel, reload }: Pick<RemoteConnectionSectionProps,
  't' | 'useRemoteConnection' | 'create' | 'cancel' | 'reload'>) {
  const { deployment, phase, ticket, error, remainingSeconds, retainDetails } = useRemoteConnection(state => state)
  const busy = phase === 'loading' || phase === 'creating' || phase === 'cancelling'
  const available = deployment?.availability === 'available'
  const http = deployment?.url.startsWith('http:') === true
  const visibleTicket = phase === 'pending' && ticket !== null ? ticket : null
  const showQrPreview = visibleTicket !== null || busy
  const showDetails = visibleTicket !== null || retainDetails
  const showQrBody = (phase !== 'ready' && phase !== 'cancelled') || !available
  return <section className={css.card} aria-label={t('qrTitle')} aria-busy={busy || undefined}>
    <header className={css.cardHeader}>
      <h3 className={css.methodTitle}>{t('qrTitle')}</h3>
      {(available || ticket !== null) && <div className={css.qrActions}>
        {available && <Button variant="primary" size="sm" disabled={busy} onClick={create}>
          {t(phase === 'ready' ? 'generate' : 'regenerate')}
        </Button>}
        {(ticket !== null || phase === 'creating') && <Button variant="outline" size="sm" disabled={busy} onClick={cancel}>{t('cancel')}</Button>}
      </div>}
    </header>
    {showQrBody && <div className={css.cardBody}>
      {showQrPreview && <div className={css.symbol}>
        {visibleTicket !== null && <QRCodeSVG className={css.qr} value={visibleTicket.url} size={240} marginSize={4} level="M" role="img" aria-label={t('qr')} title={t('qr')} />}
        {busy && <div className={css.progress} role="status" aria-label={t(phase)}><StateDot state="ongoing" size={20} /></div>}
      </div>}
      <div className={css.field}>
        {showQrPreview && <div className={showDetails ? css.field : `${css.field} ${css.placeholder}`} aria-hidden={!showDetails || undefined}>
          <p className={css.qrDetails}>
            <span>{t('scan')}</span>
            <span className={css.countdown} role="timer" aria-live="off">{t('expires', { seconds: String(remainingSeconds) })}</span>
          </p>
          <CredentialWarning t={t} http={http} method="qr" />
        </div>}
        {deployment !== null && deployment.availability !== 'available' && <p className={css.notice} role="status">{t(deployment.availability)}</p>}
        {phase === 'expired' && <div className={css.caution} role="status">
          <span className={css.cautionIcon} aria-hidden="true"><IconWarningOutlineMedium /></span>
          <div className={css.cautionBody}><p className={css.warning}>{t('expired')}</p></div>
        </div>}
        {(phase === 'used' || phase === 'replaced')
        && <p className={css.notice} role="status">{t(phase)}</p>}
        {error !== null && <p className={css.error} role="alert">{t(error)}</p>}
        {(error === 'loadFailed' || error === 'statusFailed') && <div className={css.actions}>
          <Button variant="outline" size="sm" onClick={reload}>{t('retry')}</Button>
        </div>}
      </div>
    </div>}
  </section>
}

function LinkLoginCard({ t, useRemoteConnection, useLoginLink, copyLink, reloadLink }: Pick<RemoteConnectionSectionProps,
  't' | 'useRemoteConnection' | 'useLoginLink' | 'copyLink' | 'reloadLink'>) {
  const deployment = useRemoteConnection(state => state.deployment)
  const link = useLoginLink(state => state)
  const available = deployment?.availability === 'available'
  const http = deployment?.url.startsWith('http:') === true
  const retryLink = link.phase === 'error'
  return <section className={css.card} aria-label={t('linkTitle')}>
    <header className={css.header}>
      <h3 className={css.methodTitle}>{t('linkTitle')}</h3>
      <p className={css.description}>{t('linkDescription')}</p>
    </header>
    {deployment !== null && <div className={css.linkRow}>
      <div className={css.linkPreview}>
        <code className={css.linkUrl}>{link.url ?? deployment.url}</code>
      </div>
      {available && <Button variant="outline" size="sm" disabled={link.phase === 'loading' || link.phase === 'copying'}
        onClick={retryLink ? reloadLink : copyLink}>
        <span className={css.copyLabel}>
          <span className={css.copyLabelSizer} aria-hidden="true">{t('copyLink')}</span>
          <span className={css.copyLabelSizer} aria-hidden="true">{t('copying')}</span>
          <span>{t(retryLink ? 'retry' : link.phase === 'copying' ? 'copying' : link.copied ? 'copied' : 'copyLink')}</span>
        </span>
      </Button>}
    </div>}
    {available && retryLink && <p className={css.error} role="alert">{t('linkFailed')}</p>}
    {link.copied && <CredentialWarning t={t} http={http} method="link" />}
  </section>
}

function CredentialWarning({ t, http, method }: PropsLocale<'remoteConnection'> & { http: boolean; method: 'qr' | 'link' }) {
  return <div className={css.caution}>
    <span className={css.cautionIcon} aria-hidden="true"><IconWarningOutlineMedium /></span>
    <div className={css.cautionBody}>
      <p className={css.cautionTitle}>{t(method === 'qr' ? 'warningTitle' : 'linkWarningTitle')}</p>
      <p className={css.warning}>{t(method === 'qr' ? 'warning' : 'linkWarning')}</p>
      {http && <p className={css.warning}>{t('httpWarning')}</p>}
    </div>
  </div>
}
