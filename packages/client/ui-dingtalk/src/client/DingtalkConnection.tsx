/** DingTalk account surfaces on the Plugins page: the bundle section, title tag, activation guidance, and notices. */
import { useState, type ReactNode } from 'react'
import {
  CliAccountActivation, CliAccountBadge, CliAccountConfirm, CliAccountSection, CliAccountToast, type CliAccountAction,
} from '@deepseek-ai/dsh-client-ui-cli-account'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { DINGTALK_PACKAGE, presentConnection, type ConnectionFace } from './connection.ts'
import type { NS } from './locales.ts'

type FaceProps = InjectFace<ConnectionFace> & PropsLocale<typeof NS>

/**
 * The account section on the DingTalk bundle's page.
 * @param props - the shared connection face and the DingTalk dictionary.
 * @returns the status line, its actions, and the sign-out confirmation.
 */
export function DingtalkConnectionSection(props: FaceProps): ReactNode {
  /* jscpd:ignore-start -- CLI app plugin pages render the shared section from the same phase-to-action mapping. */
  const { useDingtalkConnection, check, signIn, signOut, cancel, openAuthorization, retry, t } = props
  const snapshot = useDingtalkConnection(value => value)
  const [confirming, setConfirming] = useState(false)
  const shown = presentConnection(snapshot)
  const actions: CliAccountAction[] = []
  let status: string | undefined
  let detail: string | undefined
  switch (shown.phase) {
    case 'connected':
      actions.push({ label: t('action.signOut'), onClick: () => { setConfirming(true) } })
      if (shown.userName === undefined) detail = t('detail.connected')
      else if (shown.corpName === undefined) detail = t('detail.connectedAs', { name: shown.userName })
      else detail = t('detail.connectedIn', { name: shown.userName, org: shown.corpName })
      break
    case 'disconnected': actions.push({ label: t('action.connect'), onClick: signIn, variant: 'primary' }); detail = t('detail.disconnected'); break
    case 'unavailable': actions.push({ label: t('action.retry'), onClick: check }); detail = t(shown.missing ? 'detail.missing' : 'detail.unavailable'); break
    case 'stopped': actions.push({ label: t('action.retry'), onClick: retry }); detail = t('detail.stopped'); break
    case 'connecting':
      status = t(`step.${shown.step}`)
      if (shown.step === 'authorizing' && shown.url !== undefined) {
        actions.push({ label: t('action.open'), onClick: openAuthorization, variant: 'primary' })
        detail = t('detail.authorizing')
      }
      if (shown.cancellable) actions.push({ label: t('action.cancel'), onClick: cancel, variant: 'ghost' })
      break
    case 'checking': if (shown.downloading) status = t('step.downloading'); break
  }
  const failed = 'failed' in shown ? shown.failed : undefined
  return (
    <CliAccountSection t={t} packageName={DINGTALK_PACKAGE} phase={shown.phase} status={status} busy={snapshot.busy}
      linked={snapshot.linked} actions={actions} detail={detail}
      failure={failed === undefined
        ? undefined
        : { text: t(failed.kind === 'sign-in' ? 'failed.signIn' : 'failed'), command: failed.failure }}>
      <CliAccountConfirm t={t} open={confirming} title={t('signOut.title')} body={t('signOut.body')} confirm={t('action.signOut')}
        onClose={() => { setConfirming(false) }} onConfirm={signOut} />
    </CliAccountSection>
  )
  /* jscpd:ignore-end */
}

/* jscpd:ignore-start -- CLI app plugin pages wire the shared tag and activation components to their own connection hooks. */
/**
 * The account tag beside the DingTalk bundle's title.
 * @param props - the open detail page's subject, the connection face, and the dictionary.
 * @returns the tag for the DingTalk bundle, or null on any other page.
 */
export function DingtalkConnectionBadge({ subject, useDingtalkConnection, t }: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const phase = useDingtalkConnection(value => presentConnection(value).phase)
  return <CliAccountBadge t={t} subject={subject} packageName={DINGTALK_PACKAGE} phase={phase} />
}

/**
 * Guidance after the user switches the DingTalk bundle on while the account is not connected.
 * @param props - activation callbacks, the connection face, and the dictionary.
 * @returns a dismissible prompt that starts the sign-in from the bundle's page.
 */
export function DingtalkConnectionActivation(props: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const { useDingtalkConnection, signIn, onDismiss, onOpenDetails, t } = props
  const phase = useDingtalkConnection(value => presentConnection(value).phase)
  return <CliAccountActivation t={t} phase={phase} onDismiss={onDismiss} onConnect={() => { onOpenDetails(); signIn() }} />
}
/* jscpd:ignore-end */

/**
 * Account outcomes reported outside the Plugins panel's lifetime.
 * @param props - the shared notice, its dismissal, and the dictionary.
 * @returns the toast for the latest notice, or null.
 */
export function DingtalkConnectionToast({ useDingtalkConnection, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useDingtalkConnection(value => value.notice)
  return <CliAccountToast t={t} notice={notice} onDone={dismissNotice} />
}
