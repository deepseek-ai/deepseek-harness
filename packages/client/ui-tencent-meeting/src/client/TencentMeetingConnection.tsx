/** Tencent Meeting account surfaces on the Plugins page: the bundle section, title tag, activation guidance, and notices. */
import { useState, type ReactNode } from 'react'
import {
  CliAccountActivation, CliAccountBadge, CliAccountConfirm, CliAccountSection, CliAccountToast, type CliAccountAction,
} from '@deepseek-ai/dsh-client-ui-cli-account'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { TENCENT_MEETING_PACKAGE, presentConnection, type ConnectionFace } from './connection.ts'
import type { NS } from './locales.ts'

type FaceProps = InjectFace<ConnectionFace> & PropsLocale<typeof NS>

/**
 * The account section on the Tencent Meeting bundle's page.
 * @param props - the shared connection face and the Tencent Meeting dictionary.
 * @returns the status line, its actions, and the sign-out confirmation.
 */
export function TencentMeetingConnectionSection(props: FaceProps): ReactNode {
  const { useTencentMeetingConnection, check, signIn, signOut, cancel, openAuthorization, retry, t } = props
  const snapshot = useTencentMeetingConnection(value => value)
  const [confirming, setConfirming] = useState(false)
  const shown = presentConnection(snapshot)
  const actions: CliAccountAction[] = []
  let status: string | undefined
  let detail: string | undefined
  /* jscpd:ignore-start -- CLI app plugin pages map the shared phases to the same retry, open-link, and cancel actions. */
  switch (shown.phase) {
    case 'connected':
      actions.push({ label: t('action.signOut'), onClick: () => { setConfirming(true) } })
      detail = t('detail.connected', { name: shown.userName })
      break
    case 'disconnected': actions.push({ label: t('action.connect'), onClick: signIn, variant: 'primary' }); detail = t('detail.disconnected'); break
    case 'unavailable': actions.push({ label: t('action.retry'), onClick: check }); detail = t('detail.unavailable'); break
    case 'stopped': actions.push({ label: t('action.retry'), onClick: retry }); detail = t('detail.stopped'); break
    case 'connecting':
      status = t(`step.${shown.step}`)
      if (shown.step === 'authorizing' && shown.url !== undefined) {
        actions.push({ label: t('action.open'), onClick: openAuthorization, variant: 'primary' })
        detail = t('detail.authorizing')
      }
      if (shown.cancellable) actions.push({ label: t('action.cancel'), onClick: cancel, variant: 'ghost' })
      break
    case 'checking': break
  }
  /* jscpd:ignore-end */
  const failed = 'failed' in shown ? shown.failed : undefined
  return (
    <CliAccountSection t={t} packageName={TENCENT_MEETING_PACKAGE} phase={shown.phase} status={status} busy={snapshot.busy}
      linked={snapshot.linked} actions={actions} detail={detail} failure={failed === undefined ? undefined : { text: t('failed'), command: failed.failure }}>
      <CliAccountConfirm t={t} open={confirming} title={t('signOut.title')} body={t('signOut.body')} confirm={t('action.signOut')}
        onClose={() => { setConfirming(false) }} onConfirm={signOut} />
    </CliAccountSection>
  )
}

/**
 * The account tag beside the Tencent Meeting bundle's title.
 * @param props - the open detail page's subject, the connection face, and the dictionary.
 * @returns the tag for the Tencent Meeting bundle, or null on any other page.
 */
export function TencentMeetingConnectionBadge({ subject, useTencentMeetingConnection, t }: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const phase = useTencentMeetingConnection(value => presentConnection(value).phase)
  return <CliAccountBadge t={t} subject={subject} packageName={TENCENT_MEETING_PACKAGE} phase={phase} />
}

/**
 * Guidance after the user switches the Tencent Meeting bundle on while the account is not connected.
 * @param props - activation callbacks, the connection face, and the dictionary.
 * @returns a dismissible prompt that starts the sign-in from the bundle's page.
 */
export function TencentMeetingConnectionActivation(props: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const { useTencentMeetingConnection, signIn, onDismiss, onOpenDetails, t } = props
  const phase = useTencentMeetingConnection(value => presentConnection(value).phase)
  return <CliAccountActivation t={t} phase={phase} onDismiss={onDismiss} onConnect={() => { onOpenDetails(); signIn() }} />
}

/**
 * Account outcomes reported outside the Plugins panel's lifetime.
 * @param props - the shared notice, its dismissal, and the dictionary.
 * @returns the toast for the latest notice, or null.
 */
export function TencentMeetingConnectionToast({ useTencentMeetingConnection, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useTencentMeetingConnection(value => value.notice)
  return <CliAccountToast t={t} notice={notice} onDone={dismissNotice} />
}
