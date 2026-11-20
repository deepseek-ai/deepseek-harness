/** Approval controls and persistent outcome notices, independent of Cordis contexts. */
import { useId, useState } from 'react'
import { Button, IconWarningOutlineMedium, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type { RemoteConnectionContentProps } from './slots.ts'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PairingDecision, PairingRequestId } from '../types.ts'
import type { ApprovalState } from './pairing-approval.ts'
import type {} from './pairing-resource.ts'
import css from './PairingRequests.module.css'
import card from './RemoteConnectionSection.module.css'

/** Owner operations and mutation state bound by the client plugin. */
export interface PairingInjected {
  readonly hooks: { readonly approval: ObservableSnapshot<ApprovalState> }
  /** @param id - selected request. @param decision - allow or deny. @returns after the operation settles. */
  decide: (id: PairingRequestId, decision: PairingDecision) => Promise<void>
  /** Dismiss the latest approval outcome. */
  dismiss: () => void
}

type Face = InjectFace<PairingInjected> & PropsLocale<'remoteConnection'>

/**
 * Render pending request codes and connection source IP addresses within Remote connection settings.
 * @param props - standard resource hook, owner actions, mutation state and localized copy.
 * @returns the approval card with live requests or feedback about the list read.
 */
export function PairingRequests({ useResource, useApproval, decide, t }: Pick<RemoteConnectionContentProps, 'useResource'> & Face) {
  const title = useId()
  const [retry, setRetry] = useState(0)
  const requests = useResource<'device-pairing'>(`dsh-resource://device-pairing/requests?retry=${String(retry)}`)
  const busy = useApproval(value => value.busy)
  const pendingRequests = requests.status === 'live' ? requests.value?.requests : undefined
  const hasRequests = pendingRequests !== undefined && pendingRequests.length > 0
  return <section className={`${card.card} ${css.section}`} aria-labelledby={title}>
    <header className={card.cardHeader}>
      <h3 className={card.methodTitle} id={title}>{t('pairing.title')}</h3>
    </header>
    <p className={card.description}>{t('pairing.description')}</p>
    {hasRequests && <div className={card.caution} role="note">
      <span className={card.cautionIcon} aria-hidden="true"><IconWarningOutlineMedium /></span>
      <p className={card.warning}>{t('pairing.permission')}</p>
    </div>}
    {requests.status === 'loading' && <div className={css.empty} role="status" aria-label={t('pairing.loading')}><StateDot state="ongoing" /></div>}
    {(requests.status === 'failed' || requests.status === 'none') && <div className={css.notice}>
      <p className={css.error} role="alert">{t('pairing.readFailed')}</p>
      <Button variant="outline" size="sm" onClick={() => { setRetry(value => value + 1) }}>{t('pairing.retry')}</Button>
    </div>}
    {pendingRequests?.map(request => <div className={css.request} key={request.id}>
      <div className={css.details}>
        <div className={css.identity}>
          <span className={css.label}>{t('pairing.code')}</span>
          <code className={css.code}>{request.code.slice(0, 4)} {request.code.slice(4)}</code>
        </div>
        <p className={css.sourceIp}>
          <span>{t('pairing.sourceIp')}</span>
          <span>{request.sourceIp ?? t('pairing.sourceIpUnknown')}</span>
        </p>
      </div>
      <div className={`${card.cardActions} ${css.actions}`}>
        <Button variant="primary" size="sm" disabled={busy}
          onClick={() => { void decide(request.id, 'allow') }}>{t('pairing.approve')}</Button>
        <Button variant="outline" size="sm" disabled={busy}
          onClick={() => { void decide(request.id, 'deny') }}>{t('pairing.deny')}</Button>
      </div>
    </div>)}
  </section>
}

/**
 * Announce the decision even when the owner has closed Settings.
 * @param props - mutation state, notice dismissal and localized copy.
 * @returns the current toast, or nothing.
 */
export function PairingToast({ useApproval, dismiss, t }: PropsRuntime<'shell.overlay'> & Face) {
  const state = useApproval(value => value)
  if (state.notice === null) return null
  return <Toast key={state.sequence} text={t(`pairing.${state.notice}`)} onDone={dismiss}
    {...state.notice === 'approved' || state.notice === 'denied' ? { tone: 'success' as const } : {}} />
}
