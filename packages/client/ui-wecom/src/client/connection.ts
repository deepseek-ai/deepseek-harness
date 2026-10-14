import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { CliAccountConnection, type CliAccountPhase, type CliAccountSnapshot } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { WecomState } from '@deepseek-ai/dsh-wecom-cli/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'

export const WECOM_PACKAGE = '@deepseek-ai/dsh-wecom'

export type WecomNotice = 'connected'

export type ConnectionSnapshot = CliAccountSnapshot<WecomState, WecomNotice>

export type ConnectionPresentation =
  | { readonly phase: Exclude<CliAccountPhase, 'connecting'>; readonly failed: WecomState['result'] }
  | { readonly phase: 'connecting'; readonly step: 'authorizing' | 'connecting'; readonly url: string | undefined; readonly cancellable: boolean }

export interface ConnectionFace {
  hooks: { wecomConnection: HostObservable<ConnectionSnapshot> }
  check(): void
  connect(): void
  cancel(): void
  openAuthorization(): void
  retry(): void
  dismissNotice(): void
}

export function presentConnection({ view, stopped }: Pick<ConnectionSnapshot, 'view' | 'stopped'>): ConnectionPresentation {
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
