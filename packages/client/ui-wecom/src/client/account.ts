/** The WeCom authorization section: the buttons, guide download rows, and failure the Plugins page shows for each state. */
import type { CliAccountAction, CliAccountDisplay, CliAccountNote, CliAccountPage } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpstreamSkillsState } from '@deepseek-ai/dsh-upstream-skills/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { presentConnection, type ConnectionSnapshot } from './connection.ts'
import type { NS } from './locales.ts'

type Translate = TranslateNS<typeof NS>

/** The page actions and the WeCom Remote operations the section's buttons call. */
export interface WecomActions extends CliAccountPage {
  /** Read the authorization again. */
  readonly check: () => void
  /** Bind a bot through the QR-code page. */
  readonly connect: () => void
}

/* jscpd:ignore-start -- CLI app plugins whose guides download report the same states, each from its own dictionary. */
/** The row that reports guides that are not in place yet; a failed download offers a check, which restarts it. */
function skillsNotes(skills: UpstreamSkillsState | undefined, t: Translate, check: () => void): CliAccountNote[] {
  switch (skills) {
    case undefined:
    case 'installed': return []
    case 'downloading': return [{ text: t('skills.downloading') }]
    case 'failed': return [{ text: t('skills.failed'), action: { label: t('action.retry'), onClick: check } }]
    /* v8 ignore next -- closed skills state union */
    default: return assertNever(skills)
  }
}
/* jscpd:ignore-end */

/**
 * The authorization section for one page snapshot.
 * @param snapshot - the Host's view and the page state.
 * @param t - the WeCom dictionary.
 * @param actions - what the section's buttons call.
 * @returns the phase, step, buttons, detail, guide download row, and failure.
 */
export function presentAccount(snapshot: ConnectionSnapshot, t: Translate, actions: WecomActions): CliAccountDisplay {
  const shown = presentConnection(snapshot)
  const buttons: CliAccountAction[] = []
  let status: string | undefined
  let detail: string | undefined
  switch (shown.phase) {
    case 'disconnected': buttons.push({ label: t('action.connect'), onClick: actions.connect, variant: 'primary' }); detail = t('detail.disconnected'); break
    case 'unavailable': buttons.push({ label: t('action.retry'), onClick: actions.check }); detail = t('detail.unavailable'); break
    case 'stopped': buttons.push({ label: t('action.retry'), onClick: actions.retry }); detail = t('detail.stopped'); break
    case 'connected': detail = t('detail.connected'); break
    case 'connecting':
      status = t(`step.${shown.step}`)
      if (shown.url !== undefined) {
        buttons.push({ label: t('action.open'), onClick: actions.openAuthorization, variant: 'primary' })
        detail = t('detail.authorizing')
      }
      if (shown.cancellable) buttons.push({ label: t('action.cancel'), onClick: actions.cancel, variant: 'ghost' })
      break
    case 'checking': break
  }
  return {
    phase: shown.phase, status, actions: buttons, detail,
    notes: skillsNotes(snapshot.view?.account.skills, t, actions.check),
    failure: 'failed' in shown && shown.failed !== undefined ? { text: t('failed'), command: shown.failed.failure } : undefined,
  }
}
