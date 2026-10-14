import type { ReactNode } from 'react'
import {
  CliAccountAction, CliAccountActivation, CliAccountBadge, CliAccountSection, CliAccountToast,
} from '@deepseek-ai/dsh-client-ui-cli-account'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { WECOM_PACKAGE, presentConnection, type ConnectionFace } from './connection.ts'
import type { NS, WecomKey } from './locales.ts'

type FaceProps = InjectFace<ConnectionFace> & PropsLocale<typeof NS>

export function WecomConnectionSection(props: FaceProps): ReactNode {
  const { useWecomConnection, check, connect, cancel, openAuthorization, retry, t } = props
  const snapshot = useWecomConnection(value => value)
  const shown = presentConnection(snapshot)
  const disabled = snapshot.busy || (!snapshot.linked && shown.phase !== 'stopped')
  const action = (label: WecomKey, onClick: () => void, variant?: 'primary' | 'ghost'): ReactNode =>
    <CliAccountAction key={label} label={t(label)} disabled={disabled} onClick={onClick} variant={variant} />
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
    <CliAccountSection packageName={WECOM_PACKAGE} phase={shown.phase} title={t('section.title')} status={status} actions={actions}
      detail={detail} failure={'failed' in shown && shown.failed ? t('failed') : undefined} hint={t('hint')} />
  )
}

export function WecomConnectionBadge({ subject, useWecomConnection, t }: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const phase = useWecomConnection(value => presentConnection(value).phase)
  return <CliAccountBadge subject={subject} packageName={WECOM_PACKAGE} phase={phase} label={shown => t(`badge.${shown}`)} />
}

export function WecomConnectionActivation(props: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const { useWecomConnection, connect, onDismiss, onOpenDetails, t } = props
  const phase = useWecomConnection(value => presentConnection(value).phase)
  return (
    <CliAccountActivation needed={phase === 'disconnected'} settled={phase !== 'checking'}
      title={t('activation.title')} body={t('activation.body')} later={t('activation.later')} connect={t('action.connect')} close={t('close')}
      onDismiss={onDismiss} onConnect={() => { onOpenDetails(); connect() }} />
  )
}

export function WecomConnectionToast({ useWecomConnection, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useWecomConnection(value => value.notice)
  return <CliAccountToast notice={notice} text={kind => t(`notice.${kind}`)} onDone={dismissNotice} />
}
