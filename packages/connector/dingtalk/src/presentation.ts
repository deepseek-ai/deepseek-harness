/** The DingTalk account section the Plugins page shows for each Host view. */
import { failureDetails } from '@deepseek-ai/dsh-cli-account'
import type {
  ConnectorAccountButton, ConnectorAccountCopy, ConnectorAccountDisplay, ConnectorAccountFailure,
  ConnectorAccountOperation,
} from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { text } from './locales.ts'
import type { DingtalkOperationKind, DingtalkState } from './types.ts'

/** The npm package whose bundle page carries the account section. */
export const DINGTALK_PACKAGE = '@deepseek-ai/dsh-dingtalk'

/* jscpd:ignore-start -- CLI app plugins declare page operations, copy, and commands alike, each with its own text. */
/** The operations the section's buttons start; signing in and out report a notice in the browser that started them. */
export const OPERATIONS: readonly ConnectorAccountOperation<DingtalkOperationKind>[] = [
  { kind: 'check' },
  { kind: 'sign-in', notice: text('notice.connected') },
  { kind: 'sign-out', notice: text('notice.signed-out') },
]

/** The section's title and hint, and the prompt after the bundle is switched on while signed out. */
export const COPY: ConnectorAccountCopy = {
  title: text('section.title'),
  hint: text('hint'),
  activation: { title: text('activation.title'), body: text('activation.body'), connect: text('action.connect') },
}

const CHECK = { kind: 'start', operation: 'check' } as const
const SIGN_IN = { kind: 'start', operation: 'sign-in' } as const
const SIGN_OUT = { kind: 'start', operation: 'sign-out' } as const
const CANCEL: ConnectorAccountButton = { label: text('action.cancel'), command: { kind: 'cancel' }, variant: 'ghost' }
/* jscpd:ignore-end */

type Operation = NonNullable<DingtalkState['operation']>
type Account = DingtalkState['account']

function step(operation: Operation): 'step.authorizing' | 'step.connecting' | 'step.signing-out' {
  if (operation.kind === 'sign-out') return 'step.signing-out'
  return operation.phase === 'authorizing' ? 'step.authorizing' : 'step.connecting'
}

/* jscpd:ignore-start -- CLI app plugin pages map a sign-in or sign-out in progress to the same open-link and cancel buttons. */
/** The section while a sign-in or sign-out runs: its step, the authorization page while waiting there, and cancel. */
function presentOperation(operation: Operation): ConnectorAccountDisplay {
  const authorizing = step(operation) === 'step.authorizing' && operation.authorizationUrl !== undefined
  const buttons: ConnectorAccountButton[] = []
  if (authorizing) buttons.push({ label: text('action.open'), command: { kind: 'open' }, variant: 'primary' })
  if (operation.cancellable) buttons.push(CANCEL)
  return {
    phase: 'connecting', status: text(step(operation)), badge: text('badge.connecting'), buttons, notes: [],
    ...authorizing ? { detail: text('detail.authorizing') } : {},
  }
}
/* jscpd:ignore-end */

/** The signed-in user and organization as far as `auth status` reported them. */
function connectedDetail(account: Extract<Account, { readonly state: 'connected' }>): NonNullable<ConnectorAccountDisplay['detail']> {
  if (account.userName === undefined) return text('detail.connected')
  if (account.corpName === undefined) return text('detail.connectedAs', { name: account.userName })
  return text('detail.connectedIn', { name: account.userName, org: account.corpName })
}

/**
 * The account section for one Host view.
 * @param view - the current dws account, the operation in progress, and the last result.
 * @returns the phase, status, tag, buttons, detail, and failure.
 */
export function presentAccount(view: DingtalkState): ConnectorAccountDisplay {
  const { account, operation } = view
  if (operation?.kind === 'check') {
    return {
      phase: 'checking', status: text(operation.phase === 'downloading' ? 'step.downloading' : 'status.checking'),
      buttons: operation.cancellable ? [CANCEL] : [], notes: [],
    }
  }
  if (operation !== undefined) return presentOperation(operation)
  const failed = view.result?.outcome === 'failed' ? view.result : undefined
  const failure: { failure?: ConnectorAccountFailure } = failed === undefined ? {} : {
    failure: {
      text: text(failed.kind === 'sign-in' ? 'failed.signIn' : 'failed'),
      ...failed.failure === undefined ? {} : { details: failureDetails(failed.failure) },
    },
  }
  const unavailable = (missing: boolean): ConnectorAccountDisplay => ({
    phase: 'unavailable', status: text('status.unavailable'), badge: text('badge.unavailable'),
    buttons: [{ label: text('action.retry'), command: CHECK }], detail: text(missing ? 'detail.missing' : 'detail.unavailable'), notes: [], ...failure,
  })
  switch (account.state) {
    case 'unchecked': return failed === undefined ? { phase: 'checking', status: text('status.checking'), buttons: [], notes: [] } : unavailable(false)
    case 'not-installed': return unavailable(true)
    case 'unverified': return unavailable(false)
    case 'signed-out':
      return {
        phase: 'disconnected', status: text('status.disconnected'), badge: text('badge.disconnected'),
        buttons: [{ label: text('action.connect'), command: SIGN_IN, variant: 'primary' }], connect: SIGN_IN,
        detail: text('detail.disconnected'), notes: [], ...failure,
      }
    /* jscpd:ignore-start -- CLI app plugins that sign out offer the same confirmed sign-out button. */
    case 'connected':
      return {
        phase: 'connected', status: text('status.connected'), badge: text('badge.connected'),
        buttons: [{
          label: text('action.signOut'), command: SIGN_OUT,
          confirm: { title: text('signOut.title'), body: text('signOut.body'), label: text('action.signOut') },
        }],
        detail: connectedDetail(account), notes: [], ...failure,
      }
    /* jscpd:ignore-end */
    /* v8 ignore next -- closed account state union */
    default: return assertNever(account)
  }
}
