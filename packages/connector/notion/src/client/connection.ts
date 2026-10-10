/** Browser mirror of the managed Notion server and the Plugins page's connection actions. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { McpManagedServerView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpAuthorizationReason, McpOAuthAttemptId, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The server name the Notion plugin registers with the MCP manager. */
export const NOTION_SERVER = 'notion'

/** The npm package whose bundle page carries the connection section. */
export const NOTION_PACKAGE = '@deepseek-ai/dsh-notion'

/** A transient outcome the page reports outside its own lifetime. */
export interface ConnectionNotice {
  readonly seq: number
  readonly kind: 'connected' | 'signed-out' | 'action-failed'
}

/** The page's whole view: the Host's Notion entry plus this browser's pending action and notice. */
export interface ConnectionSnapshot {
  /** The manager's Notion entry; undefined until the stream reports one. */
  readonly server: McpManagedServerView | undefined
  /** Whether the manager stream is delivering. */
  readonly linked: boolean
  /** Whether an action this page started has not settled. */
  readonly busy: boolean
  readonly notice: ConnectionNotice | undefined
}

/** What the user sees about the connection, derived from the Host entry alone. */
export type ConnectionPresentation =
  | { readonly phase: 'checking' | 'connected' | 'connecting' }
  | { readonly phase: 'waiting-browser'; readonly attempt: McpOAuthAttemptId; readonly url: string | undefined }
  | { readonly phase: 'authorizing'; readonly attempt: McpOAuthAttemptId }
  | { readonly phase: 'disconnected'; readonly failed: boolean }
  | { readonly phase: 'reconnect'; readonly reason: Exclude<McpAuthorizationReason, 'missing'>; readonly failed: boolean }
  | { readonly phase: 'unavailable'; readonly failed: boolean }

/** Page-facing actions and the snapshot hook the slot entries inject. */
export interface ConnectionFace {
  hooks: { notionConnection: HostObservable<ConnectionSnapshot> }
  connect(): void
  cancel(): void
  signOut(): void
  retry(): void
  openAuthorization(): void
  dismissNotice(): void
}

function attemptPresentation(attempt: McpOAuthAttemptView): ConnectionPresentation | undefined {
  switch (attempt.phase) {
    case 'waiting-browser': return { phase: 'waiting-browser', attempt: attempt.id, url: attempt.authorizationUrl }
    case 'starting':
    case 'exchanging':
    case 'committing': return { phase: 'authorizing', attempt: attempt.id }
    case 'authorized':
    case 'cancelled':
    case 'failed': return undefined
    /* v8 ignore next -- closed attempt phase union */
    default: return assertNever(attempt.phase)
  }
}

/**
 * Derive the connection the page shows from the manager's Notion entry.
 * @param server - the entry as the manager last reported it.
 * @returns the phase, with the active attempt or the reason a new authorization is needed.
 */
export function presentConnection(server: McpManagedServerView | undefined): ConnectionPresentation {
  if (server === undefined) return { phase: 'checking' }
  const attempt = server.authorization
  const active = attempt === undefined ? undefined : attemptPresentation(attempt)
  if (active !== undefined) return active
  const failed = attempt?.phase === 'failed'
  const status = server.status
  switch (status.state) {
    case 'connected': return { phase: 'connected' }
    case 'connecting':
    case 'reconnecting': return { phase: 'connecting' }
    case 'waiting-authorization':
      return status.reason === 'missing' ? { phase: 'disconnected', failed } : { phase: 'reconnect', reason: status.reason, failed }
    case 'closed':
    case 'waiting-credentials':
    case 'disabled':
    case 'failed': return { phase: 'unavailable', failed }
    /* v8 ignore next -- closed managed status union */
    default: return assertNever(status)
  }
}

function openable(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  return parsed.protocol === 'https:'
    || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
}

function openAuthorizationPage(url: string | undefined): void {
  if (url !== undefined && openable(url)) window.open(url, '_blank', 'noopener,noreferrer')
}

async function settle<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** One manager subscription per browser plugin, shared by every Notion entry on the Plugins page. */
export class NotionConnection {
  /** The page's whole view, published after each stream item or page action settles. */
  readonly state: SnapshotStore<ConnectionSnapshot> = createSnapshotStore<ConnectionSnapshot>({
    server: undefined, linked: false, busy: false, notice: undefined,
  })

  /** The attempt this browser started; only its URL opens a window here. */
  private started: McpOAuthAttemptId | undefined
  private readonly opened = new Set<McpOAuthAttemptId>()
  private seq = 0
  private disposed = false
  private readonly stream: RemoteStream<McpManagedServerView[]>
  private readonly observing: Promise<void>

  constructor(private readonly ctx: Context) {
    this.stream = ctx.remote.$stream<McpManagedServerView[]>({
      name: 'Notion connection', open: signal => ctx.remote.mcpServers.watch(signal),
      ended: () => new Error('Notion connection stream ended'),
      carrierFailed: () => { this.patch({ linked: false }) },
    })
    this.observing = this.observe()
  }

  /**
   * Bind the page-facing actions; each runs without awaiting so slot handlers stay synchronous.
   * @returns the face the slot entries inject.
   */
  face(): ConnectionFace {
    return {
      hooks: { notionConnection: this.state },
      connect: () => { void this.connect() },
      cancel: () => { void this.cancel() },
      signOut: () => { void this.run(async () => { await settle(this.ctx.remote.mcpServers.signOut(NOTION_SERVER)); this.notify('signed-out') }) },
      retry: () => { void this.run(async () => { await settle(this.ctx.remote.mcpServers.restart(NOTION_SERVER)) }) },
      openAuthorization: () => {
        const shown = presentConnection(this.state.getSnapshot().server)
        if (shown.phase === 'waiting-browser') openAuthorizationPage(shown.url)
      },
      dismissNotice: () => { this.patch({ notice: undefined }) },
    }
  }

  /** Stop observing the manager; Host-owned attempts keep running. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stream.dispose()
    await this.observing
  }

  private async observe(): Promise<void> {
    try {
      for await (const item of this.stream) {
        const server = item.value.find(entry => entry.name === NOTION_SERVER)
        this.patch({ server, linked: true })
        this.follow(server)
        item.accept()
      }
    } catch {
      // The carrier already reported the failure; a disposed page has nothing left to show.
      if (!this.disposed) this.patch({ linked: false })
    }
  }

  /** Open this browser's authorization page once, and report its outcome. */
  private follow(server: McpManagedServerView | undefined): void {
    const attempt = server?.authorization
    if (attempt === undefined || attempt.id !== this.started) return
    if (attempt.phase === 'waiting-browser' && !this.opened.has(attempt.id)) {
      this.opened.add(attempt.id)
      openAuthorizationPage(attempt.authorizationUrl)
    }
    if (attempt.phase === 'authorized') this.notify('connected')
    if (attempt.phase === 'authorized' || attempt.phase === 'cancelled' || attempt.phase === 'failed') this.started = undefined
  }

  private async connect(): Promise<void> {
    await this.run(async () => {
      const attempt = await settle(this.ctx.remote.mcpServers.startAuthorization(NOTION_SERVER))
      this.started = attempt.id
      // The stream may have reported this attempt before the call answered.
      this.follow(this.state.getSnapshot().server)
    })
  }

  private async cancel(): Promise<void> {
    const shown = presentConnection(this.state.getSnapshot().server)
    if (shown.phase !== 'waiting-browser' && shown.phase !== 'authorizing') return
    await this.run(async () => { await settle(this.ctx.remote.mcpServers.cancelAuthorization(NOTION_SERVER, shown.attempt)) })
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.state.getSnapshot().busy) return
    this.patch({ busy: true })
    try {
      await operation()
    } catch {
      // The Host keeps the diagnostic; the page reports one retryable outcome.
      this.notify('action-failed')
    } finally {
      this.patch({ busy: false })
    }
  }

  private patch(change: Partial<ConnectionSnapshot>): void {
    this.state.set({ ...this.state.getSnapshot(), ...change })
  }

  private notify(kind: ConnectionNotice['kind']): void {
    if (this.disposed) return
    this.seq += 1
    this.patch({ notice: { seq: this.seq, kind } })
  }
}
