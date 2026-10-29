/** The Feishu account section: the buttons, rows, and failure the Plugins page shows for each connection state. */
import type { CliAccountAction, CliAccountDisplay, CliAccountPage } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { presentConnection, type ConnectionSnapshot } from './connection.ts'
import type { NS } from './locales.ts'

/** The page actions and the Feishu Remote operations the section's buttons call. */
export interface FeishuActions extends CliAccountPage {
  /** Check the account again. */
  readonly check: () => void
  /** Link an app, replacing a configured one after the page confirms it. */
  readonly linkApp: () => void
  /** Sign the linked app's user in. */
  readonly signIn: () => void
  readonly signOut: () => void
}

/**
 * The connection section for one page snapshot.
 * @param snapshot - the Host's view and the page state.
 * @param t - the Feishu dictionary.
 * @param actions - what the section's buttons call.
 * @returns the phase, step, buttons, detail, linked app, and failure.
 */
export function presentAccount(snapshot: ConnectionSnapshot, t: TranslateNS<typeof NS>, actions: FeishuActions): CliAccountDisplay {
  const shown = presentConnection(snapshot)
  const buttons: CliAccountAction[] = []
  let status: string | undefined
  let detail: string | undefined
  switch (shown.phase) {
    case 'disconnected':
      buttons.push(shown.next === 'link-app'
        ? { label: t('action.linkApp'), onClick: actions.linkApp, variant: 'primary' }
        : { label: t('action.signIn'), onClick: actions.signIn, variant: 'primary' })
      detail = t(shown.next === 'link-app' ? 'detail.no-app' : 'detail.signed-out')
      break
    case 'unavailable': buttons.push({ label: t('action.retry'), onClick: actions.check }); detail = t('detail.unavailable'); break
    case 'stopped': buttons.push({ label: t('action.retry'), onClick: actions.retry }); detail = t('detail.stopped'); break
    case 'connected':
      buttons.push({
        label: t('action.signOut'), onClick: actions.signOut,
        confirm: { title: t('signOut.title'), body: t('signOut.body'), label: t('action.signOut') },
      })
      detail = shown.userName === undefined ? t('detail.connected') : t('detail.connectedAs', { name: shown.userName })
      break
    case 'connecting':
      status = t(`step.${shown.step}`)
      if (shown.url !== undefined) {
        buttons.push({ label: t('action.open'), onClick: actions.openAuthorization, variant: 'primary' })
        if (shown.step === 'configuring' || shown.step === 'authorizing') detail = t(`detail.${shown.step}`)
      }
      if (shown.cancellable) buttons.push({ label: t('action.cancel'), onClick: actions.cancel, variant: 'ghost' })
      break
    case 'checking': break
  }
  return {
    phase: shown.phase, status, actions: buttons, detail,
    notes: 'appId' in shown
      ? [{
        text: t('app.linked', { id: shown.appId }),
        action: {
          label: t('action.replaceApp'), onClick: actions.linkApp, variant: 'ghost',
          confirm: { title: t('replaceApp.title'), body: t('replaceApp.body'), label: t('action.replaceApp') },
        },
      }]
      : [],
    failure: 'failed' in shown && shown.failed !== undefined ? {
      text: t(shown.failed.kind === 'link-app' ? 'failed.linkApp' : 'failed'),
      command: shown.failed.failure,
      details: [shown.failed.failure?.type, shown.failed.failure?.subtype],
    } : undefined,
  }
}
