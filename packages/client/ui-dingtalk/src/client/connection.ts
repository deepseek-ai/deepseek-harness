/** Browser mirror of the Host's DingTalk account and the Plugins page's account actions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { CliAccountConnection, type CliAccountSnapshot } from '@deepseek-ai/dsh-client-ui-cli-account'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { DingtalkState } from '@deepseek-ai/dsh-dingtalk-cli/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The npm package whose bundle page carries the account section. */
export const DINGTALK_PACKAGE = '@deepseek-ai/dsh-dingtalk'

/** Outcomes the page reports after an operation this browser started succeeds. */
export type DingtalkNotice = 'connected' | 'signed-out'

/** The page's whole view: the Host's account view plus this browser's stream, pending action, and notice. */
export type ConnectionSnapshot = CliAccountSnapshot<DingtalkState, DingtalkNotice>

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

/** Page-facing actions and the snapshot hook the slot entries inject. */
export interface ConnectionFace {
  hooks: { dingtalkConnection: HostObservable<ConnectionSnapshot> }
  /** Check the account again, installing dws first while it is missing. */
  check(): void
  /** Sign in through the authorization page. */
  signIn(): void
  /** Sign out after the page confirms it. */
  signOut(): void
  cancel(): void
  openAuthorization(): void
  /** Reopen the Host stream after it stopped. */
  retry(): void
  dismissNotice(): void
}

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

/**
 * Mirror the `dingtalk` Remote and bind the page's actions to it.
 * @param ctx - the browser plugin context whose Remote the connection follows.
 * @returns the connection to dispose with the plugin, and the face the slot entries inject.
 */
export function createConnection(ctx: Context): { connection: CliAccountConnection<DingtalkState, DingtalkNotice>; face: ConnectionFace } {
  const connection = new CliAccountConnection<DingtalkState, DingtalkNotice>(ctx, {
    name: 'DingTalk connection',
    follow: signal => ctx.remote.dingtalk.follow(signal),
    cancel: id => ctx.remote.dingtalk.cancel(id),
    notices: { 'sign-in': 'connected', 'sign-out': 'signed-out' },
  })
  const face: ConnectionFace = {
    hooks: { dingtalkConnection: connection.state },
    check: () => { connection.start(() => ctx.remote.dingtalk.check()) },
    signIn: () => { connection.start(() => ctx.remote.dingtalk.signIn()) },
    signOut: () => { connection.start(() => ctx.remote.dingtalk.signOut()) },
    ...connection.actions,
  }
  return { connection, face }
}
