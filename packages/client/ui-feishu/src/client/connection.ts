/** The Feishu connection the Plugins page shows, derived from the Host's account view. */
import type { CliAccountSnapshot } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { FeishuAppId, FeishuState } from '@deepseek-ai/dsh-feishu-cli/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The npm package whose bundle page carries the connection section. */
export const FEISHU_PACKAGE = '@deepseek-ai/dsh-feishu'

/** The page's whole view: the Host's account view plus this browser's stream, pending action, and notice. */
export type ConnectionSnapshot = CliAccountSnapshot<FeishuState>

/** The step a connection or sign-out in progress shows. */
export type ConnectionStep = 'configuring' | 'authorizing' | 'connecting' | 'signing-out'

/** What the user sees about the connection, derived from the Host's view alone. */
export type ConnectionPresentation =
  | { readonly phase: 'checking' | 'stopped' }
  | { readonly phase: 'disconnected'; readonly next: 'link-app'; readonly failed: FeishuState['result'] }
  | { readonly phase: 'disconnected'; readonly next: 'sign-in'; readonly appId: FeishuAppId; readonly failed: FeishuState['result'] }
  | { readonly phase: 'unavailable'; readonly appId: FeishuAppId; readonly failed: FeishuState['result'] }
  | { readonly phase: 'connected'; readonly appId: FeishuAppId; readonly userName: string | undefined; readonly failed: FeishuState['result'] }
  | {
    readonly phase: 'connecting'
    readonly step: ConnectionStep
    readonly url: string | undefined
    readonly cancellable: boolean
  }

function step(phase: Exclude<NonNullable<FeishuState['operation']>['phase'], 'checking'>): ConnectionStep {
  switch (phase) {
    case 'configuring':
    case 'authorizing':
    case 'signing-out': return phase
    case 'verifying':
    case 'cancelling': return 'connecting'
    /* v8 ignore next -- closed operation phase union */
    default: return assertNever(phase)
  }
}

/**
 * Derive the connection the page shows from the Host's view.
 * @param snapshot - the view as the Host last reported it, and whether the Host stream stopped.
 * @returns the phase, with the operation in progress or the account the last check found.
 */
export function presentConnection(snapshot: Pick<ConnectionSnapshot, 'view' | 'stopped'>): ConnectionPresentation {
  if (snapshot.stopped) return { phase: 'stopped' }
  const state = snapshot.view
  const operation = state?.operation
  if (state === undefined || operation?.kind === 'check') return { phase: 'checking' }
  if (operation !== undefined) {
    return {
      phase: 'connecting',
      step: operation.kind === 'sign-out' ? 'signing-out' : operation.phase === 'checking' ? 'connecting' : step(operation.phase),
      url: operation.authorizationUrl,
      cancellable: operation.cancellable,
    }
  }
  const failed = state.result?.outcome === 'failed' ? state.result : undefined
  const account = state.account
  switch (account.state) {
    case 'unchecked': return { phase: 'checking' }
    case 'connected': return { phase: 'connected', appId: account.appId, userName: account.userName, failed }
    case 'unconfigured': return { phase: 'disconnected', next: 'link-app', failed }
    case 'signed-out': return { phase: 'disconnected', next: 'sign-in', appId: account.appId, failed }
    case 'unverified': return { phase: 'unavailable', appId: account.appId, failed }
    /* v8 ignore next -- closed account state union */
    default: return assertNever(account)
  }
}
