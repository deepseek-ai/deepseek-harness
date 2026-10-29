/** The DingTalk account the Plugins page shows, derived from the Host's account view. */
import type { CliAccountSnapshot } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { DingtalkState } from '@deepseek-ai/dsh-dingtalk-cli/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The npm package whose bundle page carries the account section. */
export const DINGTALK_PACKAGE = '@deepseek-ai/dsh-dingtalk'

/** The page's whole view: the Host's account view plus this browser's stream, pending action, and notice. */
export type ConnectionSnapshot = CliAccountSnapshot<DingtalkState>

/** The step a sign-in or sign-out in progress shows. */
export type ConnectionStep = 'authorizing' | 'connecting' | 'signing-out'

type Failed = DingtalkState['result']

/**
 * What the user sees about the account, derived from the Host's view alone. `downloading` marks a check that installs dws
 * first; `missing` marks an account left without dws because that download did not finish.
 */
export type ConnectionPresentation =
  | { readonly phase: 'checking'; readonly downloading: boolean }
  | { readonly phase: 'stopped' | 'disconnected'; readonly failed: Failed }
  | { readonly phase: 'unavailable'; readonly missing: boolean; readonly failed: Failed }
  | { readonly phase: 'connected'; readonly userName: string | undefined; readonly corpName: string | undefined; readonly failed: Failed }
  | { readonly phase: 'connecting'; readonly step: ConnectionStep; readonly url: string | undefined; readonly cancellable: boolean }

/**
 * Derive the account the page shows from the Host's view.
 * @param snapshot - the view as the Host last reported it, and whether the Host stream stopped.
 * @returns the phase, with the operation in progress, the signed-in user, or the last failed result.
 */
export function presentConnection(snapshot: Pick<ConnectionSnapshot, 'view' | 'stopped'>): ConnectionPresentation {
  const view = snapshot.view
  if (snapshot.stopped) return { phase: 'stopped', failed: undefined }
  if (view === undefined) return { phase: 'checking', downloading: false }
  const { account, operation, result } = view
  if (operation?.kind === 'check') return { phase: 'checking', downloading: operation.phase === 'downloading' }
  if (operation !== undefined) {
    const step: ConnectionStep = operation.kind === 'sign-out' ? 'signing-out' : operation.phase === 'authorizing' ? 'authorizing' : 'connecting'
    return { phase: 'connecting', step, url: operation.authorizationUrl, cancellable: operation.cancellable }
  }
  const failed = result?.outcome === 'failed' ? result : undefined
  switch (account.state) {
    case 'unchecked': return failed === undefined ? { phase: 'checking', downloading: false } : { phase: 'unavailable', missing: false, failed }
    case 'not-installed': return { phase: 'unavailable', missing: true, failed }
    case 'signed-out': return { phase: 'disconnected', failed }
    case 'unverified': return { phase: 'unavailable', missing: false, failed }
    case 'connected': return { phase: 'connected', userName: account.userName, corpName: account.corpName, failed }
    /* v8 ignore next -- closed account state union */
    default: return assertNever(account)
  }
}
