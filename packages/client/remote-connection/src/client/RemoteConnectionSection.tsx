/** Access address, QR login, and pairing approvals for browser sign-in. */
import { QRCodeSVG } from 'qrcode.react'
import { Button, IconWarningOutlineMedium, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteConnectionContentProps } from './slots.ts'
import { PairingRequests } from './PairingRequests.tsx'
import css from './RemoteConnectionSection.module.css'

/** Renderer-derived section data, localized copy, and actions. */
export type RemoteConnectionSectionProps = RemoteConnectionContentProps & PropsLocale<'remoteConnection'>

/**
 * Present address prerequisites, an access address, available QR login, and pairing cards.
 * @param props - Section injection and standard slot props.
 * @returns Remote connection settings content.
 */
export function RemoteConnectionSection(props: RemoteConnectionSectionProps) {
  const { t, useRemoteConnection, useApproval } = props
  const pairingAvailable = useApproval(state => state.available)
  const available = useRemoteConnection(state => state.deployment?.availability === 'available')
  const loading = useRemoteConnection(state => state.phase === 'loading' && state.deployment === null)
  if (loading) return <section className={css.section} aria-label={t('title')}>
    {pairingAvailable && <PairingRequests {...props} />}
    <div className={css.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={20} /></div>
  </section>
  return <section className={css.section} aria-label={t('title')}>
    <h2 className={css.title}>{t('title')}</h2>
    <ConnectionNotice {...props} />
    <AccessAddressCard {...props} />
    {available && <QrLoginCard {...props} />}
    {pairingAvailable && <PairingRequests {...props} />}
  </section>
}

function ConnectionNotice({ t, useRemoteConnection }: Pick<RemoteConnectionSectionProps, 't' | 'useRemoteConnection'>) {
  const deployment = useRemoteConnection(state => state.deployment)
  if (deployment === null) return null
  if (deployment.availability === 'available') return <p className={css.intro}>{t('addressDescription')}</p>
  const [message, ...steps] = t(deployment.availability).split('\n')
  return <div className={css.caution} role="status">
    <span className={css.cautionIcon} aria-hidden="true"><IconWarningOutlineMedium /></span>
    <div className={css.cautionBody}>
      <p className={css.warning}>{message}</p>
      {steps.length > 0 && <ol className={`${css.warning} ${css.warningList}`}>
        {steps.map(step => <li key={step}>{step}</li>)}
      </ol>}
    </div>
  </div>
}

function QrLoginCard({ t, useRemoteConnection, create, cancel, reload }: Pick<RemoteConnectionSectionProps,
  't' | 'useRemoteConnection' | 'create' | 'cancel' | 'reload'>) {
  const { deployment, phase, ticket, error, remainingSeconds, retainDetails } = useRemoteConnection(state => state)
  const busy = phase === 'loading' || phase === 'creating' || phase === 'cancelling'
  const http = deployment?.url.startsWith('http:') === true
  const visibleTicket = phase === 'pending' && ticket !== null ? ticket : null
  const showQrPreview = visibleTicket !== null || busy
  const showDetails = visibleTicket !== null || retainDetails
  const regenerate = ticket !== null || retainDetails || phase === 'used' || phase === 'expired' || phase === 'replaced'
  const showQrBody = phase !== 'ready' && phase !== 'cancelled'
  return <section className={css.card} aria-label={t('qrTitle')} aria-busy={busy || undefined}>
    <header className={css.cardHeader}>
      <h3 className={css.methodTitle}>{t('qrTitle')}</h3>
      <div className={css.cardActions}>
        <Button variant="primary" size="sm" disabled={busy} onClick={create}>
          {t(regenerate ? 'regenerate' : 'generate')}
        </Button>
        {(ticket !== null || phase === 'creating') && <Button variant="outline" size="sm" disabled={busy} onClick={cancel}>{t('cancel')}</Button>}
      </div>
    </header>
    {showQrBody && <div className={css.cardBody}>
      {showQrPreview && <div className={css.symbol}>
        {visibleTicket !== null && <QRCodeSVG className={css.qr} value={visibleTicket.url} size={240} marginSize={4} level="M" role="img" aria-label={t('qr')} title={t('qr')} />}
        {busy && <div className={css.progress} role="status" aria-label={t(phase)}><StateDot state="ongoing" size={20} /></div>}
      </div>}
      <div className={css.field}>
        {showQrPreview && <div className={showDetails ? css.field : `${css.field} ${css.placeholder}`} aria-hidden={!showDetails || undefined}>
          <p className={css.qrDetails}>
            <span className={css.countdown} role="timer" aria-live="off">{t('expires', { seconds: String(remainingSeconds) })}</span>
          </p>
          <CredentialWarning t={t} http={http} method="qr" />
        </div>}
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

function AccessAddressCard({ t, useRemoteConnection, useLoginLink, copyLink, reload }: Pick<RemoteConnectionSectionProps,
  't' | 'useRemoteConnection' | 'useLoginLink' | 'copyLink' | 'reload'>) {
  const deployment = useRemoteConnection(state => state.deployment)
  const error = useRemoteConnection(state => state.error)
  const link = useLoginLink(state => state)
  const credentialUrl = deployment?.loginUrlAllowed ? link.url : null
  const http = deployment?.url.startsWith('http:') === true
  return <section className={css.card} aria-label={t('addressTitle')}>
    <header className={css.header}>
      <h3 className={css.methodTitle}>{t('addressTitle')}</h3>
    </header>
    {deployment?.availability !== 'available' && error !== null && <>
      <p className={css.error} role="alert">{t(error)}</p>
      <div className={css.actions}><Button variant="outline" size="sm" onClick={reload}>{t('retry')}</Button></div>
    </>}
    {deployment !== null && <div className={css.linkRow}>
      <div className={css.linkPreview}>
        <code className={css.linkUrl}>{credentialUrl ?? deployment.url}</code>
      </div>
      <Button variant="outline" size="sm" disabled={link.phase === 'copying'} onClick={copyLink}>
        {t('copyLink')}
      </Button>
    </div>}
    {credentialUrl !== null && link.copied && <CredentialWarning t={t} http={http} method="link" />}
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
