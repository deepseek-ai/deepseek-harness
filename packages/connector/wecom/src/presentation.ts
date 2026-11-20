/** The WeCom authorization section the Plugins page shows for each Host view. */
import type { CliAccountText } from '@deepseek-ai/dsh-cli-account/types'
import type {
  ConnectorAccountButton, ConnectorAccountCopy, ConnectorAccountDisplay, ConnectorAccountFailure, ConnectorAccountNote,
  ConnectorAccountOperation,
} from '@deepseek-ai/dsh-client-ui-connector-account/types'
import type { UpstreamSkillsState } from '@deepseek-ai/dsh-upstream-skills/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { WecomTextKey } from './locales.ts'
import type { WecomOperationKind, WecomState } from './types.ts'

type Text = CliAccountText<WecomTextKey>

/** The npm package whose bundle page carries the authorization section. */
export const WECOM_PACKAGE = '@deepseek-ai/dsh-wecom'

/* jscpd:ignore-start -- CLI app plugins declare page operations, copy, and commands alike, each with its own text. */
/**
 * List the operations the section's buttons start; binding a bot reports a notice in the browser that started it.
 * @param text - writes a key of the WeCom text in every shipped language.
 * @returns the operations with their notices.
 */
export function operations(text: Text): readonly ConnectorAccountOperation<WecomOperationKind>[] {
  return [
    { kind: 'check' },
    { kind: 'connect', notice: text('notice.connected') },
  ]
}

/**
 * Write the section's title and hint, and the prompt after the bundle is switched on while unauthorized.
 * @param text - writes a key of the WeCom text in every shipped language.
 * @returns the section's fixed text.
 */
export function copy(text: Text): ConnectorAccountCopy {
  return {
    title: text('section.title'),
    hint: text('hint'),
    activation: { title: text('activation.title'), body: text('activation.body'), connect: text('action.connect') },
  }
}

const CHECK = { kind: 'start', operation: 'check' } as const
const CONNECT = { kind: 'start', operation: 'connect' } as const
/* jscpd:ignore-end */

/* jscpd:ignore-start -- CLI app plugins whose guides download report the same states, each in its own text. */
/** The row that reports guides that are not in place yet; a failed download offers a check, which restarts it. */
function skillsNotes(skills: UpstreamSkillsState, text: Text): ConnectorAccountNote[] {
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
function connectingButtons(operation: NonNullable<WecomState['operation']>, text: Text): ConnectorAccountButton[] {
  const buttons: ConnectorAccountButton[] = []
  if (operation.authorizationUrl !== undefined) buttons.push({ label: text('action.open'), command: { kind: 'open' }, variant: 'primary' })
  if (operation.cancellable) buttons.push({ label: text('action.cancel'), command: { kind: 'cancel' }, variant: 'ghost' })
  return buttons
}

/**
 * The authorization section for one Host view.
 * @param view - the authorization, the operation in progress, and the last result.
 * @param text - writes a key of the WeCom text in every shipped language.
 * @returns the phase, status, tag, buttons, detail, bound-bot and guide download rows, and failure guidance.
 */
export function presentAccount(view: WecomState, text: Text): ConnectorAccountDisplay {
  const notes = skillsNotes(view.account.skills, text)
  const { operation } = view
  if (operation?.kind === 'check') return { phase: 'checking', status: text('status.checking'), buttons: [], notes }
  if (operation !== undefined) {
    return {
      phase: 'connecting', status: text(operation.phase === 'authorizing' ? 'step.authorizing' : 'step.connecting'),
      badge: text('badge.connecting'), buttons: connectingButtons(operation, text), notes,
      ...operation.authorizationUrl === undefined ? {} : { detail: text('detail.authorizing') },
    }
  }
  const failed = view.result?.outcome === 'failed'
  // The Service adds the failed command and its exit code.
  const failure: { failure?: ConnectorAccountFailure } = failed ? { failure: { text: text('failed') } } : {}
  switch (view.account.state) {
    case 'unchecked':
      if (!failed) return { phase: 'checking', status: text('status.checking'), buttons: [], notes }
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
        phase: 'connected', status: text('status.connected'), badge: text('badge.connected'),
        // Binding again replaces the bot in the CLI's configuration, which the terminal shares, so it asks first.
        buttons: [{
          label: text('action.rebind'), command: CONNECT,
          confirm: { title: text('rebind.title'), body: text('rebind.body'), label: text('action.rebind') },
        }],
        detail: text('detail.connected'),
        notes: [...view.account.botId === undefined ? [] : [{ text: text('bot.bound', { id: view.account.botId }) }], ...notes],
        ...failure,
      }
    /* v8 ignore next -- closed account state union */
    default: return assertNever(view.account.state)
  }
}
