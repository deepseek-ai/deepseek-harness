/** Feishu connection surfaces on the Plugins page: the bundle section, title tag, activation guidance, and notices. */
import { useState, type ReactNode } from 'react'
import {
  CliAccountActivation, CliAccountBadge, CliAccountConfirm, CliAccountSection, CliAccountToast, type CliAccountAction,
} from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { FEISHU_PACKAGE, presentConnection, type ConnectionFace } from './connection.ts'
import type { NS } from './locales.ts'

type FaceProps = InjectFace<ConnectionFace> & PropsLocale<typeof NS>

/**
 * The connection section on the Feishu bundle's page.
 * @param props - the shared connection face and the Feishu dictionary.
 * @returns the status line, its actions, and the sign-out confirmation.
 */
export function FeishuConnectionSection(props: FaceProps): ReactNode {
  const { useFeishuConnection, check, linkApp, signIn, cancel, signOut, openAuthorization, retry, t } = props
  const snapshot = useFeishuConnection(value => value)
  const [confirming, setConfirming] = useState<'sign-out' | 'replace-app' | undefined>(undefined)
  const shown = presentConnection(snapshot)
  const actions: CliAccountAction[] = []
  let status: string | undefined
  let detail: string | undefined
  switch (shown.phase) {
    case 'disconnected':
      actions.push(shown.next === 'link-app'
        ? { label: t('action.linkApp'), onClick: linkApp, variant: 'primary' }
        : { label: t('action.signIn'), onClick: signIn, variant: 'primary' })
      detail = t(shown.next === 'link-app' ? 'detail.no-app' : 'detail.signed-out')
      break
    case 'unavailable': actions.push({ label: t('action.retry'), onClick: check }); detail = t('detail.unavailable'); break
    case 'stopped': actions.push({ label: t('action.retry'), onClick: retry }); detail = t('detail.stopped'); break
    case 'connected':
      actions.push({ label: t('action.signOut'), onClick: () => { setConfirming('sign-out') } })
      detail = shown.userName === undefined ? t('detail.connected') : t('detail.connectedAs', { name: shown.userName })
      break
    case 'connecting':
      status = t(`step.${shown.step}`)
      if (shown.url !== undefined) {
        actions.push({ label: t('action.open'), onClick: openAuthorization, variant: 'primary' })
        if (shown.step === 'configuring' || shown.step === 'authorizing') detail = t(`detail.${shown.step}`)
      }
      if (shown.cancellable) actions.push({ label: t('action.cancel'), onClick: cancel, variant: 'ghost' })
      break
    case 'checking': break
  }
  const close = (): void => { setConfirming(undefined) }
  return (
    <CliAccountSection t={t} packageName={FEISHU_PACKAGE} phase={shown.phase} status={status} busy={snapshot.busy} linked={snapshot.linked}
      actions={actions} detail={detail}
      notes={'appId' in shown
        ? [{ text: t('app.linked', { id: shown.appId }), action: { label: t('action.replaceApp'), onClick: () => { setConfirming('replace-app') }, variant: 'ghost' } }]
        : []}
      failure={'failed' in shown && shown.failed !== undefined ? {
        text: t(shown.failed.kind === 'link-app' ? 'failed.linkApp' : 'failed'),
        command: shown.failed.failure,
        details: [shown.failed.failure?.type, shown.failed.failure?.subtype],
      } : undefined}>
      <CliAccountConfirm t={t} open={confirming === 'sign-out'} title={t('signOut.title')} body={t('signOut.body')}
        confirm={t('action.signOut')} onClose={close} onConfirm={signOut} />
      <CliAccountConfirm t={t} open={confirming === 'replace-app'} title={t('replaceApp.title')} body={t('replaceApp.body')}
        confirm={t('action.replaceApp')} onClose={close} onConfirm={linkApp} />
    </CliAccountSection>
  )
}

/**
 * The connection tag beside the Feishu bundle's title.
 * @param props - the open detail page's subject, the connection face, and the dictionary.
 * @returns the tag for the Feishu bundle, or null on any other page.
 */
export function FeishuConnectionBadge({ subject, useFeishuConnection, t }: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const phase = useFeishuConnection(value => presentConnection(value).phase)
  return <CliAccountBadge t={t} subject={subject} packageName={FEISHU_PACKAGE} phase={phase} />
}

/**
 * Guidance after the user switches the Feishu bundle on while the account is not connected.
 * @param props - activation callbacks, the connection face, and the dictionary.
 * @returns a dismissible prompt that starts the connection from the bundle's page.
 */
export function FeishuConnectionActivation(props: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const { useFeishuConnection, linkApp, signIn, onDismiss, onOpenDetails, t } = props
  const phase = useFeishuConnection(value => presentConnection(value).phase)
  const next = useFeishuConnection((value) => {
    const shown = presentConnection(value)
    return shown.phase === 'disconnected' ? shown.next : undefined
  })
  return (
    <CliAccountActivation t={t} phase={phase} onDismiss={onDismiss} onConnect={() => {
      onOpenDetails()
      if (next === 'sign-in') signIn()
      else linkApp()
    }} />
  )
}

/**
 * Connection outcomes reported outside the Plugins panel's lifetime.
 * @param props - the shared notice, its dismissal, and the dictionary.
 * @returns the toast for the latest notice, or null.
 */
export function FeishuConnectionToast({ useFeishuConnection, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useFeishuConnection(value => value.notice)
  return <CliAccountToast t={t} notice={notice} onDone={dismissNotice} />
}
