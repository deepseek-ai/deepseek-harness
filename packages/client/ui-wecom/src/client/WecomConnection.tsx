import { useEffect, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { WECOM_PACKAGE, presentConnection, type ConnectionFace, type ConnectionPresentation } from './connection.ts'
import type { NS, WecomKey } from './locales.ts'
import css from './WecomConnection.module.css'

type Phase = ConnectionPresentation['phase']
type FaceProps = InjectFace<ConnectionFace> & PropsLocale<typeof NS>

const TONE: Record<Phase, StateDotState> = {
  checking: 'ongoing', connecting: 'ongoing', connected: 'done', disconnected: 'idle', unavailable: 'warning', stopped: 'warning',
}

const BADGE: Record<Phase, readonly [WecomKey, TagTone] | undefined> = {
  checking: undefined,
  connecting: ['badge.connecting', 'info'],
  connected: ['badge.connected', 'success'],
  disconnected: ['badge.disconnected', 'outline'],
  unavailable: ['badge.unavailable', 'warning'],
  stopped: ['badge.stopped', 'warning'],
}

export function WecomConnectionSection(props: FaceProps): ReactNode {
  const { useWecomConnection, check, connect, cancel, openAuthorization, retry, t } = props
  const snapshot = useWecomConnection(value => value)
  const shown = presentConnection(snapshot)
  const disabled = snapshot.busy || (!snapshot.linked && shown.phase !== 'stopped')
  const action = (label: WecomKey, onClick: () => void, variant: 'primary' | 'outline' | 'ghost' = 'outline'): ReactNode =>
    <Button key={label} variant={variant} size="sm" disabled={disabled} onClick={onClick}>{t(label)}</Button>
  const actions: ReactNode[] = []
  let status = t(`status.${shown.phase === 'connecting' ? 'checking' : shown.phase}`)
  let detail: string | undefined
  switch (shown.phase) {
    case 'disconnected': actions.push(action('action.connect', connect, 'primary')); detail = t('detail.disconnected'); break
    case 'unavailable': actions.push(action('action.retry', check)); detail = t('detail.unavailable'); break
    case 'stopped': actions.push(action('action.retry', retry)); detail = t('detail.stopped'); break
    case 'connected': detail = t('detail.connected'); break
    case 'connecting':
      status = t(`step.${shown.step}`)
      if (shown.url !== undefined) {
        actions.push(action('action.open', openAuthorization, 'primary'))
        detail = t('detail.authorizing')
      }
      if (shown.cancellable) actions.push(action('action.cancel', cancel, 'ghost'))
      break
    case 'checking': break
  }
  return (
    <div className={css.section} data-wecom-connection={shown.phase}>
      <h4 className={css.title}>{t('section.title')}</h4>
      <div className={css.status}>
        <StateDot state={TONE[shown.phase]} />
        <span className={css.label}>{status}</span>
        <div className={css.actions}>{actions}</div>
      </div>
      {detail === undefined ? null : <p className={css.detail}>{detail}</p>}
      {'failed' in shown && shown.failed ? <p className={css.failure} role="alert">{t('failed')}</p> : null}
      <p className={css.hint}>{t('hint')}</p>
    </div>
  )
}

export function WecomConnectionBadge({ subject, useWecomConnection, t }: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const phase = useWecomConnection(value => presentConnection(value).phase)
  if (subject.kind === 'item' || subject.pkg.name !== WECOM_PACKAGE || !subject.pkg.enabled) return null
  const badge = BADGE[phase]
  return badge === undefined ? null : <Tag tone={badge[1]}>{t(badge[0])}</Tag>
}

export function WecomConnectionActivation(props: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const { useWecomConnection, connect, onDismiss, onOpenDetails, t } = props
  const phase = useWecomConnection(value => presentConnection(value).phase)
  const needed = phase === 'disconnected'
  useEffect(() => {
    if (phase !== 'checking' && !needed) onDismiss()
  }, [phase, needed, onDismiss])
  return (
    <Modal open={needed} title={t('activation.title')} closeLabel={t('close')} onClose={onDismiss}
      footer={<>
        <Button variant="ghost" onClick={onDismiss}>{t('activation.later')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => { onOpenDetails(); connect() }}>{t('action.connect')}</Button>
      </>}>
      <p>{t('activation.body')}</p>
    </Modal>
  )
}

export function WecomConnectionToast({ useWecomConnection, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useWecomConnection(value => value.notice)
  if (notice === undefined) return null
  const failed = notice.kind === 'action-failed'
  return (
    <Toast key={notice.seq} text={t(`notice.${notice.kind}`)} onDone={dismissNotice}
      {...failed ? { icon: <IconWarningOutlineRegular /> } : { tone: 'success' as const }} />
  )
}
