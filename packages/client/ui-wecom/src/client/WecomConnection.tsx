/** WeCom authorization surfaces on the Plugins page: the bundle section, title tag, activation guidance, and notices. */
import type { ReactNode } from 'react'
import {
  CliAccountActivation, CliAccountBadge, CliAccountSection, CliAccountToast, type CliAccountAction,
} from '@deepseek-ai/dsh-client-ui-cli-account'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { WECOM_PACKAGE, presentConnection, type ConnectionFace } from './connection.ts'
import type { NS } from './locales.ts'

type FaceProps = InjectFace<ConnectionFace> & PropsLocale<typeof NS>

/**
 * The authorization section on the WeCom bundle's page.
 * @param props - the shared connection face and the WeCom dictionary.
 * @returns the status line and its actions.
 */
export function WecomConnectionSection(props: FaceProps): ReactNode {
  const { useWecomConnection, check, connect, cancel, openAuthorization, retry, t } = props
  const snapshot = useWecomConnection(value => value)
  const shown = presentConnection(snapshot)
  const actions: CliAccountAction[] = []
  let status: string | undefined
  let detail: string | undefined
  switch (shown.phase) {
    case 'disconnected': actions.push({ label: t('action.connect'), onClick: connect, variant: 'primary' }); detail = t('detail.disconnected'); break
    case 'unavailable': actions.push({ label: t('action.retry'), onClick: check }); detail = t('detail.unavailable'); break
    case 'stopped': actions.push({ label: t('action.retry'), onClick: retry }); detail = t('detail.stopped'); break
    case 'connected': detail = t('detail.connected'); break
    case 'connecting':
      status = t(`step.${shown.step}`)
      if (shown.url !== undefined) {
        actions.push({ label: t('action.open'), onClick: openAuthorization, variant: 'primary' })
        detail = t('detail.authorizing')
      }
      if (shown.cancellable) actions.push({ label: t('action.cancel'), onClick: cancel, variant: 'ghost' })
      break
    case 'checking': break
  }
  return (
    <CliAccountSection t={t} packageName={WECOM_PACKAGE} phase={shown.phase} status={status} busy={snapshot.busy} linked={snapshot.linked}
      actions={actions} detail={detail} failure={'failed' in shown && shown.failed !== undefined ? { text: t('failed'), command: shown.failed.failure } : undefined} />
  )
}

/**
 * The authorization tag beside the WeCom bundle's title.
 * @param props - the open detail page's subject, the connection face, and the dictionary.
 * @returns the tag for the WeCom bundle, or null on any other page.
 */
export function WecomConnectionBadge({ subject, useWecomConnection, t }: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const phase = useWecomConnection(value => presentConnection(value).phase)
  return <CliAccountBadge t={t} subject={subject} packageName={WECOM_PACKAGE} phase={phase} />
}

/**
 * Guidance after the user switches the WeCom bundle on while it is not authorized.
 * @param props - activation callbacks, the connection face, and the dictionary.
 * @returns a dismissible prompt that starts the authorization from the bundle's page.
 */
export function WecomConnectionActivation(props: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const { useWecomConnection, connect, onDismiss, onOpenDetails, t } = props
  const phase = useWecomConnection(value => presentConnection(value).phase)
  return <CliAccountActivation t={t} phase={phase} onDismiss={onDismiss} onConnect={() => { onOpenDetails(); connect() }} />
}

/**
 * Authorization outcomes reported outside the Plugins panel's lifetime.
 * @param props - the shared notice, its dismissal, and the dictionary.
 * @returns the toast for the latest notice, or null.
 */
export function WecomConnectionToast({ useWecomConnection, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useWecomConnection(value => value.notice)
  return <CliAccountToast t={t} notice={notice} onDone={dismissNotice} />
}
