/** The Feishu account section the Plugins page shows for each Host view. */
import type { CliAccountText } from '@deepseek-ai/dsh-cli-account/types'
import type {
  ConnectorAccountButton, ConnectorAccountCopy, ConnectorAccountDisplay, ConnectorAccountFailure, ConnectorAccountNote,
  ConnectorAccountOperation,
} from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { FeishuTextKey } from './locales.ts'
import type { FeishuAppId, FeishuOperationKind, FeishuState } from './types.ts'

type Text = CliAccountText<FeishuTextKey>

/** The npm package whose bundle page carries the account section. */
export const FEISHU_PACKAGE = '@deepseek-ai/dsh-feishu'

/* jscpd:ignore-start -- CLI app plugins declare page operations, copy, and commands alike, each with its own text. */
/**
 * List the operations the section's buttons start; each but a check reports a notice in the browser that started it.
 * @param text - writes a key of the Feishu text in every shipped language.
 * @returns the operations with their notices.
 */
export function operations(text: Text): readonly ConnectorAccountOperation<FeishuOperationKind>[] {
  return [
    { kind: 'check' },
    { kind: 'link-app', notice: text('notice.app-linked') },
    { kind: 'sign-in', notice: text('notice.connected') },
    { kind: 'sign-out', notice: text('notice.signed-out') },
  ]
}

/**
 * Write the section's title and hint, and the prompt after the bundle is switched on while disconnected.
 * @param text - writes a key of the Feishu text in every shipped language.
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
const LINK_APP = { kind: 'start', operation: 'link-app' } as const
const SIGN_IN = { kind: 'start', operation: 'sign-in' } as const
const SIGN_OUT = { kind: 'start', operation: 'sign-out' } as const
/* jscpd:ignore-end */

type Operation = NonNullable<FeishuState['operation']>
type Step = 'step.downloading' | 'step.configuring' | 'step.authorizing' | 'step.connecting' | 'step.signing-out'

function step(operation: Operation): Step {
  if (operation.kind === 'sign-out') return 'step.signing-out'
  switch (operation.phase) {
    case 'downloading': return 'step.downloading'
    case 'configuring': return 'step.configuring'
    case 'authorizing': return 'step.authorizing'
    case 'signing-out': return 'step.signing-out'
    case 'checking':
    case 'verifying':
    case 'cancelling': return 'step.connecting'
    /* v8 ignore next -- closed operation phase union */
    default: return assertNever(operation.phase)
  }
}

function cancelButton(text: Text): ConnectorAccountButton {
  return { label: text('action.cancel'), command: { kind: 'cancel' }, variant: 'ghost' }
}

/** The section while an operation runs: its step, the Feishu page and its guidance while waiting there, and cancel. */
function presentOperation(operation: Operation, text: Text): ConnectorAccountDisplay {
  const current = step(operation)
  const buttons: ConnectorAccountButton[] = []
  if (operation.authorizationUrl !== undefined) buttons.push({ label: text('action.open'), command: { kind: 'open' }, variant: 'primary' })
  if (operation.cancellable) buttons.push(cancelButton(text))
  const guidance = operation.authorizationUrl === undefined ? undefined
    : current === 'step.configuring' ? text('detail.configuring')
      : current === 'step.authorizing' ? text('detail.authorizing') : undefined
  return {
    phase: 'connecting', status: text(current), badge: text('badge.connecting'), buttons, notes: [],
    ...guidance === undefined ? {} : { detail: guidance },
  }
}

/** The row that names the linked app and replaces it after a confirmation. */
function appNotes(appId: FeishuAppId, text: Text): ConnectorAccountNote[] {
  return [{
    text: text('app.linked', { id: appId }),
    button: {
      label: text('action.replaceApp'), command: LINK_APP, variant: 'ghost',
      confirm: { title: text('replaceApp.title'), body: text('replaceApp.body'), label: text('action.replaceApp') },
    },
  }]
}

/** The last failed operation's guidance; the Service adds the command and exit code. */
function failureOf(result: FeishuState['result'], text: Text): { failure?: ConnectorAccountFailure } {
  if (result?.outcome !== 'failed') return {}
  return { failure: { text: text(result.kind === 'link-app' ? 'failed.linkApp' : 'failed') } }
}

/**
 * The account section for one Host view.
 * @param view - the CLI's default account, the operation in progress, and the last result.
 * @param text - writes a key of the Feishu text in every shipped language.
 * @returns the phase, status, tag, buttons, detail, linked-app row, and failure guidance.
 */
export function presentAccount(view: FeishuState, text: Text): ConnectorAccountDisplay {
  const { account, operation } = view
  /* jscpd:ignore-start -- CLI app plugins that download their CLI show a running check alike, each with its own text. */
  if (operation?.kind === 'check') {
    return {
      phase: 'checking', status: text(operation.phase === 'downloading' ? 'step.downloading' : 'status.checking'),
      buttons: operation.cancellable ? [cancelButton(text)] : [], notes: [],
    }
  }
  /* jscpd:ignore-end */
  if (operation !== undefined) return presentOperation(operation, text)
  const failure = failureOf(view.result, text)
  const unavailable = (detail: 'detail.missing' | 'detail.unavailable', notes: ConnectorAccountNote[]): ConnectorAccountDisplay => ({
    phase: 'unavailable', status: text('status.unavailable'), badge: text('badge.unavailable'),
    buttons: [{ label: text('action.retry'), command: CHECK }], detail: text(detail), notes, ...failure,
  })
  switch (account.state) {
    case 'unchecked':
      return view.result?.outcome === 'failed'
        ? unavailable('detail.unavailable', [])
        : { phase: 'checking', status: text('status.checking'), buttons: [], notes: [] }
    case 'not-installed': return unavailable('detail.missing', [])
    case 'unconfigured':
      return {
        phase: 'disconnected', status: text('status.disconnected'), badge: text('badge.disconnected'),
        buttons: [{ label: text('action.linkApp'), command: LINK_APP, variant: 'primary' }], connect: LINK_APP,
        detail: text('detail.no-app'), notes: [], ...failure,
      }
    case 'signed-out':
      return {
        phase: 'disconnected', status: text('status.disconnected'), badge: text('badge.disconnected'),
        buttons: [{ label: text('action.signIn'), command: SIGN_IN, variant: 'primary' }], connect: SIGN_IN,
        detail: text('detail.signed-out'), notes: appNotes(account.appId, text), ...failure,
      }
    case 'unverified': return unavailable('detail.unavailable', appNotes(account.appId, text))
    /* jscpd:ignore-start -- CLI app plugins that sign out offer the same confirmed sign-out button. */
    case 'connected':
      return {
        phase: 'connected', status: text('status.connected'), badge: text('badge.connected'),
        buttons: [{
          label: text('action.signOut'), command: SIGN_OUT,
          confirm: { title: text('signOut.title'), body: text('signOut.body'), label: text('action.signOut') },
        }],
        detail: account.userName === undefined ? text('detail.connected') : text('detail.connectedAs', { name: account.userName }),
        notes: appNotes(account.appId, text), ...failure,
      }
    /* jscpd:ignore-end */
    /* v8 ignore next -- closed account state union */
    default: return assertNever(account)
  }
}
