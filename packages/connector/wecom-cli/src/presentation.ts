/** The WeCom authorization section the Plugins page shows for each Host view. */
import { failureDetails } from '@deepseek-ai/dsh-cli-account'
import type {
  CliAccountButton, CliAccountCopy, CliAccountDisplay, CliAccountFailure, CliAccountNote, CliAccountOperation,
} from '@deepseek-ai/dsh-cli-account/types'
import type { UpstreamSkillsState } from '@deepseek-ai/dsh-upstream-skills/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { text } from './locales.ts'
import type { WecomOperationKind, WecomState } from './types.ts'

/** The npm package whose bundle page carries the authorization section. */
export const WECOM_PACKAGE = '@deepseek-ai/dsh-wecom'

/* jscpd:ignore-start -- CLI app plugins declare page operations, copy, and commands alike, each with its own text. */
/** The operations the section's buttons start; binding a bot reports a notice in the browser that started it. */
export const OPERATIONS: readonly CliAccountOperation<WecomOperationKind>[] = [
  { kind: 'check' },
  { kind: 'connect', notice: text('notice.connected') },
]

/** The section's title and hint, and the prompt after the bundle is switched on while unauthorized. */
export const COPY: CliAccountCopy = {
  title: text('section.title'),
  hint: text('hint'),
  activation: { title: text('activation.title'), body: text('activation.body'), connect: text('action.connect') },
}

const CHECK = { kind: 'start', operation: 'check' } as const
const CONNECT = { kind: 'start', operation: 'connect' } as const
/* jscpd:ignore-end */

/* jscpd:ignore-start -- CLI app plugins whose guides download report the same states, each in its own text. */
/** The row that reports guides that are not in place yet; a failed download offers a check, which restarts it. */
function skillsNotes(skills: UpstreamSkillsState): CliAccountNote[] {
  switch (skills) {
    case 'installed': return []
    case 'downloading': return [{ text: text('skills.downloading') }]
    case 'failed': return [{ text: text('skills.failed'), button: { label: text('action.retry'), command: CHECK } }]
    /* v8 ignore next -- closed skills state union */
    default: return assertNever(skills)
  }
}
/* jscpd:ignore-end */

/** The bound bot's QR-code page and the operation's cancel, while an authorization runs. */
function connectingButtons(operation: NonNullable<WecomState['operation']>): CliAccountButton[] {
  const buttons: CliAccountButton[] = []
  if (operation.authorizationUrl !== undefined) buttons.push({ label: text('action.open'), command: { kind: 'open' }, variant: 'primary' })
  if (operation.cancellable) buttons.push({ label: text('action.cancel'), command: { kind: 'cancel' }, variant: 'ghost' })
  return buttons
}

/**
 * The authorization section for one Host view.
 * @param view - the authorization, the operation in progress, and the last result.
 * @returns the phase, status, tag, buttons, detail, guide download row, and failure.
 */
export function presentAccount(view: WecomState): CliAccountDisplay {
  const notes = skillsNotes(view.account.skills)
  const { operation } = view
  if (operation?.kind === 'check') return { phase: 'checking', status: text('status.checking'), buttons: [], notes }
  if (operation !== undefined) {
    return {
      phase: 'connecting', status: text(operation.phase === 'authorizing' ? 'step.authorizing' : 'step.connecting'),
      badge: text('badge.connecting'), buttons: connectingButtons(operation), notes,
      ...operation.authorizationUrl === undefined ? {} : { detail: text('detail.authorizing') },
    }
  }
  const failed = view.result?.outcome === 'failed' ? view.result : undefined
  const failure: { failure?: CliAccountFailure } = failed === undefined ? {} : {
    failure: { text: text('failed'), ...failed.failure === undefined ? {} : { details: failureDetails(failed.failure) } },
  }
  switch (view.account.state) {
    case 'unchecked':
      if (failed === undefined) return { phase: 'checking', status: text('status.checking'), buttons: [], notes }
      return {
        phase: 'unavailable', status: text('status.unavailable'), badge: text('badge.unavailable'),
        buttons: [{ label: text('action.retry'), command: CHECK }], detail: text('detail.unavailable'), notes, ...failure,
      }
    case 'unauthorized':
      return {
        phase: 'disconnected', status: text('status.disconnected'), badge: text('badge.disconnected'),
        buttons: [{ label: text('action.connect'), command: CONNECT, variant: 'primary' }], connect: CONNECT,
        detail: text('detail.disconnected'), notes, ...failure,
      }
    case 'authorized':
      return {
        phase: 'connected', status: text('status.connected'), badge: text('badge.connected'), buttons: [],
        detail: text('detail.connected'), notes, ...failure,
      }
    /* v8 ignore next -- closed account state union */
    default: return assertNever(view.account.state)
  }
}
