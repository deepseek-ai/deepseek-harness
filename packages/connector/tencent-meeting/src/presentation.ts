/** The Tencent Meeting account section the Plugins page shows for each Host view. */
import type { CliAccountText } from '@deepseek-ai/dsh-cli-account/types'
import type {
  ConnectorAccountButton, ConnectorAccountCopy, ConnectorAccountDisplay, ConnectorAccountFailure, ConnectorAccountOperation,
} from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { TencentMeetingTextKey } from './locales.ts'
import type { TencentMeetingOperationKind, TencentMeetingState } from './types.ts'

type Text = CliAccountText<TencentMeetingTextKey>

/** The npm package whose bundle page carries the account section. */
export const TENCENT_MEETING_PACKAGE = '@deepseek-ai/dsh-tencent-meeting'

/* jscpd:ignore-start -- CLI app plugins declare page operations, copy, and commands alike, each with its own text. */
/**
 * List the operations the section's buttons start; signing in and out report a notice in the browser that started them.
 * @param text - writes a key of the Tencent Meeting text in every shipped language.
 * @returns the operations with their notices.
 */
export function operations(text: Text): readonly ConnectorAccountOperation<TencentMeetingOperationKind>[] {
  return [
    { kind: 'check' },
    { kind: 'sign-in', notice: text('notice.connected') },
    { kind: 'sign-out', notice: text('notice.signed-out') },
  ]
}

/**
 * Write the section's title and hint, and the prompt after the bundle is switched on while signed out.
 * @param text - writes a key of the Tencent Meeting text in every shipped language.
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
const SIGN_IN = { kind: 'start', operation: 'sign-in' } as const
const SIGN_OUT = { kind: 'start', operation: 'sign-out' } as const
/* jscpd:ignore-end */

type Operation = NonNullable<TencentMeetingState['operation']>

/* jscpd:ignore-start -- CLI app plugin pages map a sign-in or sign-out in progress to the same open-link and cancel buttons. */
function cancelButton(text: Text): ConnectorAccountButton {
  return { label: text('action.cancel'), command: { kind: 'cancel' }, variant: 'ghost' }
}

function step(operation: Operation): 'step.authorizing' | 'step.connecting' | 'step.signing-out' {
  if (operation.kind === 'sign-out') return 'step.signing-out'
  return operation.phase === 'authorizing' ? 'step.authorizing' : 'step.connecting'
}

/** The section while a sign-in or sign-out runs: its step, the authorization page while waiting there, and cancel. */
function presentOperation(operation: Operation, text: Text): ConnectorAccountDisplay {
  const authorizing = step(operation) === 'step.authorizing' && operation.authorizationUrl !== undefined
  const buttons: ConnectorAccountButton[] = []
  if (authorizing) buttons.push({ label: text('action.open'), command: { kind: 'open' }, variant: 'primary' })
  if (operation.cancellable) buttons.push(cancelButton(text))
  return {
    phase: 'connecting', status: text(step(operation)), badge: text('badge.connecting'), buttons, notes: [],
    ...authorizing ? { detail: text('detail.authorizing') } : {},
  }
}
/* jscpd:ignore-end */

/**
 * The account section for one Host view.
 * @param view - the default tmeet account, the operation in progress, and the last result.
 * @param text - writes a key of the Tencent Meeting text in every shipped language.
 * @returns the phase, status, tag, buttons, detail, and failure guidance.
 */
export function presentAccount(view: TencentMeetingState, text: Text): ConnectorAccountDisplay {
  const { account, operation } = view
  /* jscpd:ignore-start -- CLI app plugins that sign in and out show the same running check and account states, each with its own text. */
  if (operation?.kind === 'check') {
    return {
      phase: 'checking', status: text(operation.phase === 'downloading' ? 'step.downloading' : 'status.checking'),
      buttons: operation.cancellable ? [cancelButton(text)] : [], notes: [],
    }
  }
  if (operation !== undefined) return presentOperation(operation, text)
  const failed = view.result?.outcome === 'failed'
  // The Service adds the failed command and its exit code.
  const failure: { failure?: ConnectorAccountFailure } = failed ? { failure: { text: text('failed') } } : {}
  const unavailable = (missing: boolean): ConnectorAccountDisplay => ({
    phase: 'unavailable', status: text('status.unavailable'), badge: text('badge.unavailable'),
    buttons: [{ label: text('action.retry'), command: CHECK }], detail: text(missing ? 'detail.missing' : 'detail.unavailable'), notes: [], ...failure,
  })
  switch (account.state) {
    case 'unchecked': return failed ? unavailable(false) : { phase: 'checking', status: text('status.checking'), buttons: [], notes: [] }
    case 'not-installed': return unavailable(true)
    case 'unverified': return unavailable(false)
    case 'signed-out':
      return {
        phase: 'disconnected', status: text('status.disconnected'), badge: text('badge.disconnected'),
        buttons: [{ label: text('action.connect'), command: SIGN_IN, variant: 'primary' }], connect: SIGN_IN,
        detail: text('detail.disconnected'), notes: [], ...failure,
      }
    case 'connected':
      return {
        phase: 'connected', status: text('status.connected'), badge: text('badge.connected'),
        buttons: [{
          label: text('action.signOut'), command: SIGN_OUT,
          confirm: { title: text('signOut.title'), body: text('signOut.body'), label: text('action.signOut') },
        }],
        detail: text('detail.connected', { name: account.userName }), notes: [], ...failure,
      }
    /* jscpd:ignore-end */
    /* v8 ignore next -- closed account state union */
    default: return assertNever(account)
  }
}
