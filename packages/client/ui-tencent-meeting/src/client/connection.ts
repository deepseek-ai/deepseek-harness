/** The Tencent Meeting account the Plugins page shows, derived from the Host's account view. */
import type { CliAccountSnapshot } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { TencentMeetingState } from '@deepseek-ai/dsh-tencent-meeting-cli/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The npm package whose bundle page carries the account section. */
export const TENCENT_MEETING_PACKAGE = '@deepseek-ai/dsh-tencent-meeting'

/** The page's whole view: the Host's account view plus this browser's stream, pending action, and notice. */
export type ConnectionSnapshot = CliAccountSnapshot<TencentMeetingState>

/** The step a sign-in or sign-out in progress shows. */
export type ConnectionStep = 'authorizing' | 'connecting' | 'signing-out'

type Failed = TencentMeetingState['result']

/** What the user sees about the account, derived from the Host's view alone. */
export type ConnectionPresentation =
  | { readonly phase: 'checking' | 'stopped' | 'disconnected' | 'unavailable'; readonly failed: Failed }
  | { readonly phase: 'connected'; readonly userName: string; readonly failed: Failed }
  | { readonly phase: 'connecting'; readonly step: ConnectionStep; readonly url: string | undefined; readonly cancellable: boolean }

function step(operation: NonNullable<TencentMeetingState['operation']>): ConnectionStep {
  if (operation.kind === 'sign-out') return 'signing-out'
  return operation.phase === 'authorizing' ? 'authorizing' : 'connecting'
}

/**
 * Derive the account the page shows from the Host's view.
 * @param snapshot - the view as the Host last reported it, and whether the Host stream stopped.
 * @returns the phase, with the operation in progress, the signed-in user, or the last failed result.
 */
export function presentConnection(snapshot: Pick<ConnectionSnapshot, 'view' | 'stopped'>): ConnectionPresentation {
  const view = snapshot.view
  if (snapshot.stopped) return { phase: 'stopped', failed: undefined }
  if (view === undefined || view.operation?.kind === 'check') return { phase: 'checking', failed: undefined }
  const { account, operation, result } = view
  if (operation !== undefined) {
    return { phase: 'connecting', step: step(operation), url: operation.authorizationUrl, cancellable: operation.cancellable }
  }
  const failed = result?.outcome === 'failed' ? result : undefined
  switch (account.state) {
    case 'unchecked': return { phase: failed === undefined ? 'checking' : 'unavailable', failed }
    case 'signed-out': return { phase: 'disconnected', failed }
    case 'unverified': return { phase: 'unavailable', failed }
    case 'connected': return { phase: 'connected', userName: account.userName, failed }
    /* v8 ignore next -- closed account state union */
    default: return assertNever(account)
  }
}
