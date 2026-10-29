/** The DingTalk account section: the buttons, signed-in user, and failure the Plugins page shows for each account state. */
import type { CliAccountAction, CliAccountDisplay, CliAccountPage } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { presentConnection, type ConnectionSnapshot } from './connection.ts'
import type { NS } from './locales.ts'

/** The page actions and the DingTalk Remote operations the section's buttons call. */
export interface DingtalkActions extends CliAccountPage {
  /** Check the account again, installing dws first while it is missing. */
  readonly check: () => void
  /** Sign in through the authorization page. */
  readonly signIn: () => void
  readonly signOut: () => void
}

/**
 * The account section for one page snapshot.
 * @param snapshot - the Host's view and the page state.
 * @param t - the DingTalk dictionary.
 * @param actions - what the section's buttons call.
 * @returns the phase, step, buttons, detail, and failure.
 */
export function presentAccount(snapshot: ConnectionSnapshot, t: TranslateNS<typeof NS>, actions: DingtalkActions): CliAccountDisplay {
  /* jscpd:ignore-start -- CLI app plugin pages map the shared phases to the same retry, open-link, and cancel actions. */
  const shown = presentConnection(snapshot)
  const buttons: CliAccountAction[] = []
  let status: string | undefined
  let detail: string | undefined
  switch (shown.phase) {
    case 'connected':
      buttons.push({
        label: t('action.signOut'), onClick: actions.signOut,
        confirm: { title: t('signOut.title'), body: t('signOut.body'), label: t('action.signOut') },
      })
      if (shown.userName === undefined) detail = t('detail.connected')
      else if (shown.corpName === undefined) detail = t('detail.connectedAs', { name: shown.userName })
      else detail = t('detail.connectedIn', { name: shown.userName, org: shown.corpName })
      break
    case 'disconnected': buttons.push({ label: t('action.connect'), onClick: actions.signIn, variant: 'primary' }); detail = t('detail.disconnected'); break
    case 'unavailable': buttons.push({ label: t('action.retry'), onClick: actions.check }); detail = t(shown.missing ? 'detail.missing' : 'detail.unavailable'); break
    case 'stopped': buttons.push({ label: t('action.retry'), onClick: actions.retry }); detail = t('detail.stopped'); break
    case 'connecting':
      status = t(`step.${shown.step}`)
      if (shown.step === 'authorizing' && shown.url !== undefined) {
        buttons.push({ label: t('action.open'), onClick: actions.openAuthorization, variant: 'primary' })
        detail = t('detail.authorizing')
      }
      if (shown.cancellable) buttons.push({ label: t('action.cancel'), onClick: actions.cancel, variant: 'ghost' })
      break
    case 'checking': if (shown.downloading) status = t('step.downloading'); break
  }
  /* jscpd:ignore-end */
  const failed = 'failed' in shown ? shown.failed : undefined
  return {
    phase: shown.phase, status, actions: buttons, detail,
    failure: failed === undefined ? undefined : { text: t(failed.kind === 'sign-in' ? 'failed.signIn' : 'failed'), command: failed.failure },
  }
}
