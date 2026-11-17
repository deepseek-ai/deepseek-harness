/**
 * One connector's MCP server account as the Plugins page shows it: the manager's view of the server, with its running
 * authorization as the operation, and the page's operations run through the manager.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ConnectorAccountButton, ConnectorAccountCopy, ConnectorAccountDisplay, ConnectorAccountSource, ConnectorAccountView,
  ConnectorOperationId, ConnectorOperationResult,
} from '@deepseek-ai/dsh-client-ui-connector-account/types'
import type { McpAuthorizationReason, McpOAuthAttemptId, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import type { McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { text, type McpAccountKey } from './locales.ts'
import type { McpAccountCopy } from './types.ts'

/** The page's operations: authorize the server, sign out of it, and restart it. */
export type McpAccountKind = 'connect' | 'sign-out' | 'retry'

/** The phases of an authorization that has not finished. */
type Running = Exclude<McpOAuthAttemptView['phase'], 'authorized' | 'cancelled' | 'failed'>

/** The server as the manager lists it, absent until the manager lists it; a running authorization is the operation. */
export type McpAccountView = ConnectorAccountView<McpManagedServerView | undefined, McpAccountKind, Running>

function isRunning(phase: McpOAuthAttemptView['phase']): phase is Running {
  return phase !== 'authorized' && phase !== 'cancelled' && phase !== 'failed'
}

/** The page follows an authorization by the manager's attempt identity. */
function operationId(id: string): ConnectorOperationId {
  return brandString<ConnectorOperationId>(id)
}

/** Reads one server's account from the MCP manager and runs the page's operations through it. */
export class ServerAccount implements ConnectorAccountSource<McpAccountView> {
  /** The latest sign-out or restart the page ran, until the next authorization starts. */
  private finished: ConnectorOperationResult<McpAccountKind> | undefined
  private readonly listeners = new Set<() => void>()

  /**
   * @param ctx - the context carrying the MCP manager.
   * @param server - the server's name with the manager.
   */
  constructor(private readonly ctx: Context, private readonly server: string) {}

  /** @returns the server's view, with a running authorization as the operation and the latest finished operation. */
  snapshot(): McpAccountView {
    const account = this.ctx.mcpManager.list().find(view => view.name === this.server)
    const attempt = account?.authorization
    if (attempt === undefined) return { account, ...this.finished === undefined ? {} : { result: this.finished } }
    const id = operationId(attempt.id)
    const { phase } = attempt
    if (isRunning(phase)) {
      const link = attempt.authorizationUrl === undefined ? {} : { authorizationUrl: attempt.authorizationUrl }
      return { account, operation: { id, kind: 'connect', phase, cancellable: true, ...link } }
    }
    return { account, result: this.finished ?? { id, kind: 'connect', outcome: phase === 'authorized' ? 'succeeded' : phase } }
  }

  /**
   * @param listener - called after each change of the server's status or authorization, and after the page's sign-out
   *   or restart.
   * @returns a disposer that stops the calls.
   */
  observe(listener: () => void): () => void {
    this.listeners.add(listener)
    const stop = this.ctx.on('mcp-manager/status', (name) => { if (name === this.server) listener() })
    return () => {
      this.listeners.delete(listener)
      stop()
    }
  }

  /** The manager publishes every change of the server, so there is nothing to check. */
  refresh(): void {
    // The view is always current.
  }

  /**
   * @param kind - the page operation.
   * @returns the authorization attempt's identity, or a new identity once a sign-out or restart has finished.
   * @throws what the manager throws, such as for a server without OAuth or whose configuration is changing.
   */
  async start(kind: McpAccountKind): Promise<ConnectorOperationId> {
    switch (kind) {
      case 'connect':
        this.finished = undefined
        return operationId((await this.ctx.mcpManager.startAuthorization(this.server)).id)
      case 'sign-out':
        await this.ctx.mcpManager.signOut(this.server)
        return this.finish(kind)
      case 'retry':
        await this.ctx.mcpManager.restart(this.server)
        return this.finish(kind)
      /* v8 ignore next -- closed operation kind union */
      default: return assertNever(kind)
    }
  }

  /**
   * @param id - the authorization to cancel; the manager ignores any other identity.
   * @returns after the authorization's work drains.
   */
  async cancel(id: ConnectorOperationId): Promise<void> {
    await this.ctx.mcpManager.cancelAuthorization(this.server, brandString<McpOAuthAttemptId>(id))
  }

  private finish(kind: Exclude<McpAccountKind, 'connect'>): ConnectorOperationId {
    const id = operationId(randomUUID())
    this.finished = { id, kind, outcome: 'succeeded' }
    for (const listener of this.listeners) listener()
    return id
  }
}

const CONNECT = { kind: 'start', operation: 'connect' } as const
const CANCEL: ConnectorAccountButton = { label: text('action.cancel'), command: { kind: 'cancel' }, variant: 'ghost' }

function connecting(status: McpAccountKey, detail: LocalizedText, buttons: readonly ConnectorAccountButton[]): ConnectorAccountDisplay {
  return { phase: 'connecting', status: text(status), badge: text('badge.connecting'), detail, buttons, notes: [] }
}

function unavailable(retryable: boolean, failure: Pick<ConnectorAccountDisplay, 'failure'>): ConnectorAccountDisplay {
  const buttons = retryable ? [{ label: text('action.retry'), command: { kind: 'start', operation: 'retry' } } as const] : []
  return {
    phase: 'unavailable', status: text('status.unavailable'), badge: text('badge.unavailable'), detail: text('detail.unavailable'),
    buttons, notes: [], ...failure,
  }
}

function reconnectDetail(reason: Exclude<McpAuthorizationReason, 'missing'>, copy: McpAccountCopy): LocalizedText {
  switch (reason) {
    case 'rejected': return copy.detail.rejected
    case 'scope': return copy.detail.scope
    case 'expired': return text('detail.reconnect.expired')
    case 'binding': return text('detail.reconnect.binding')
    /* v8 ignore next -- closed reason union */
    default: return assertNever(reason)
  }
}

/**
 * What the section shows for one server: the manager's status and the latest authorization, in the shared copy and the
 * connector's text. A server that needs authorization again shows as disconnected, with the reason in its detail; a
 * connected server can authorize again without signing out first.
 * @param view - the server as the manager lists it.
 * @param copy - the connector's text.
 * @returns the section's display.
 */
export function present(view: McpAccountView, copy: McpAccountCopy): ConnectorAccountDisplay {
  const server = view.account
  if (server === undefined) return { phase: 'checking', status: text('status.checking'), buttons: [], notes: [] }
  const attempt = server.authorization
  switch (attempt?.phase) {
    case 'waiting-browser':
      return connecting('status.waiting-browser', copy.detail.waitingBrowser, [
        { label: text('action.open'), command: { kind: 'open' }, variant: 'primary' }, CANCEL,
      ])
    case 'starting':
    case 'exchanging':
    case 'committing':
      return connecting('status.authorizing', copy.detail.authorizing, [CANCEL])
    default:
      break
  }
  const failure = attempt?.phase === 'failed' ? { failure: { text: text('failed') } } : {}
  const status = server.status
  switch (status.state) {
    case 'connected': {
      const signOut = text('action.signOut')
      return {
        phase: 'connected', status: text('status.connected'), badge: text('badge.connected'), detail: copy.detail.connected, notes: [],
        buttons: [
          // Authorizing again changes the account or workspace; the manager keeps the saved grant until the new one is saved.
          { label: text('action.reauthorize'), command: CONNECT },
          {
            label: signOut, command: { kind: 'start', operation: 'sign-out' },
            confirm: { title: copy.signOut.title, body: copy.signOut.body, label: signOut },
          },
        ],
      }
    }
    case 'connecting':
    case 'reconnecting':
      return connecting('status.connecting', copy.detail.connecting, [])
    case 'waiting-authorization':
      return status.reason === 'missing'
        ? {
          phase: 'disconnected', status: text('status.disconnected'), badge: text('badge.disconnected'), detail: copy.detail.disconnected,
          buttons: [{ label: copy.connect, command: CONNECT, variant: 'primary' }], connect: CONNECT, notes: [], ...failure,
        }
        : {
          phase: 'disconnected', status: text('status.reconnect'), badge: text('badge.reconnect'), detail: reconnectDetail(status.reason, copy),
          buttons: [{ label: text('action.reconnect'), command: CONNECT, variant: 'primary' }], connect: CONNECT, notes: [], ...failure,
        }
    // A restart recovers a closed server; a credential update or re-enabling the entry recovers the next two.
    case 'closed':
      return unavailable(true, failure)
    case 'waiting-credentials':
    case 'disabled':
      return unavailable(false, failure)
    // Only a Host restart recovers incomplete cleanup.
    case 'failed':
      return unavailable(status.reason !== 'cleanup' && status.reason !== 'unclosed-generation', failure)
    /* v8 ignore next -- closed managed status union */
    default:
      return assertNever(status)
  }
}

/**
 * The section's fixed text: the connector's title and activation prompt, under the shared line on where authorization
 * completes.
 * @param copy - the connector's text.
 * @returns the registry's copy.
 */
export function sectionCopy(copy: McpAccountCopy): ConnectorAccountCopy {
  return {
    title: copy.title, hint: text('hostBrowser'),
    activation: { title: copy.activation.title, body: copy.activation.body, connect: copy.connect },
  }
}
