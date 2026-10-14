/** Browser mirror of the Host's WeCom authorization and the Plugins page's actions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { CliAccountConnection, type CliAccountPhase, type CliAccountSnapshot } from '@deepseek-ai/dsh-client-ui-cli-account'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { WecomState } from '@deepseek-ai/dsh-wecom-cli/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The npm package whose bundle page carries the authorization section. */
export const WECOM_PACKAGE = '@deepseek-ai/dsh-wecom'

/** Outcomes the page reports after an operation this browser started succeeds. */
export type WecomNotice = 'connected'

/** The page's whole view: the Host's authorization view plus this browser's stream, pending action, and notice. */
export type ConnectionSnapshot = CliAccountSnapshot<WecomState, WecomNotice>

/** What the user sees about the authorization, derived from the Host's view alone. */
export type ConnectionPresentation =
  | { readonly phase: Exclude<CliAccountPhase, 'connecting'>; readonly failed: WecomState['result'] }
  | { readonly phase: 'connecting'; readonly step: 'authorizing' | 'connecting'; readonly url: string | undefined; readonly cancellable: boolean }

/** Page-facing actions and the snapshot hook the slot entries inject. */
export interface ConnectionFace {
  hooks: { wecomConnection: HostObservable<ConnectionSnapshot> }
  /** Read the authorization again. */
  check(): void
  /** Bind a bot through the QR-code page. */
  connect(): void
  cancel(): void
  openAuthorization(): void
  /** Reopen the Host stream after it stopped. */
  retry(): void
  dismissNotice(): void
}

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

/**
 * Mirror the `wecom` Remote and bind the page's actions to it.
 * @param ctx - the browser plugin context whose Remote the connection follows.
 * @returns the connection to dispose with the plugin, and the face the slot entries inject.
 */
export function createConnection(ctx: Context): { connection: CliAccountConnection<WecomState, WecomNotice>; face: ConnectionFace } {
  const connection = new CliAccountConnection<WecomState, WecomNotice>(ctx, {
    name: 'WeCom connection',
    follow: signal => ctx.remote.wecom.follow(signal),
    cancel: id => ctx.remote.wecom.cancel(id),
    notices: { connect: 'connected' },
  })
  const face: ConnectionFace = {
    hooks: { wecomConnection: connection.state },
    check: () => { connection.start(() => ctx.remote.wecom.check()) },
    connect: () => { connection.start(() => ctx.remote.wecom.connect()) },
    ...connection.actions,
  }
  return { connection, face }
}
