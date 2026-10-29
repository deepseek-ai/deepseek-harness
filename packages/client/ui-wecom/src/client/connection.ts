/** The WeCom authorization the Plugins page shows, derived from the Host's authorization view. */
import type { CliAccountPhase, CliAccountSnapshot } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { WecomState } from '@deepseek-ai/dsh-wecom-cli/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The npm package whose bundle page carries the authorization section. */
export const WECOM_PACKAGE = '@deepseek-ai/dsh-wecom'

/** The page's whole view: the Host's authorization view plus this browser's stream, pending action, and notice. */
export type ConnectionSnapshot = CliAccountSnapshot<WecomState>

/** What the user sees about the authorization, derived from the Host's view alone. */
export type ConnectionPresentation =
  | { readonly phase: Exclude<CliAccountPhase, 'connecting'>; readonly failed: WecomState['result'] }
  | { readonly phase: 'connecting'; readonly step: 'authorizing' | 'connecting'; readonly url: string | undefined; readonly cancellable: boolean }

/**
 * Derive the authorization the page shows from the Host's view.
 * @param snapshot - the view as the Host last reported it, and whether the Host stream stopped.
 * @returns the phase, with the operation in progress or the last failed result.
 */
export function presentConnection(snapshot: Pick<ConnectionSnapshot, 'view' | 'stopped'>): ConnectionPresentation {
  const { view, stopped } = snapshot
  if (stopped) return { phase: 'stopped', failed: undefined }
  const operation = view?.operation
  if (view === undefined || operation?.kind === 'check') return { phase: 'checking', failed: undefined }
  if (operation !== undefined) {
    return {
      phase: 'connecting',
      step: operation.phase === 'authorizing' ? 'authorizing' : 'connecting',
      url: operation.authorizationUrl,
      cancellable: operation.cancellable,
    }
  }
  const failed = view.result?.outcome === 'failed' ? view.result : undefined
  switch (view.account.state) {
    case 'unchecked': return { phase: failed === undefined ? 'checking' : 'unavailable', failed }
    case 'unauthorized': return { phase: 'disconnected', failed }
    case 'authorized': return { phase: 'connected', failed }
    /* v8 ignore next -- closed account state union */
    default: return assertNever(view.account.state)
  }
}
