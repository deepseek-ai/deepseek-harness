/** Session-owned user terminals with the execution environment's system-user permissions. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { discoverShells, resolveShell } from './shells.ts'
import { BrowserTerminal } from './terminal.ts'
import { TerminalRetention } from './retention.ts'
import type {
  TerminalShell, TerminalAttachmentId, TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalRetentionFrame,
  WebTerminalId, WebTerminalInfo,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Interactive user terminals, separate from the Agent terminal tool registry. */
    terminalController: TerminalController
  }
}

/** Deployment limits and an optional shell profile. */
export interface Config {
  /** Explicit shell profile; omission uses the execution environment's default shell. */
  readonly shell?: {
    /** Executable path or PATH name, verified by the subprocess provider. */
    path: string
    /** User-visible profile name. */
    name: string
    /** Arguments passed to the interactive shell. */
    args: string[]
  } | undefined
  /** Executable names or paths checked for the new-terminal shell selector. */
  readonly shellCandidates: string[]
  /** Maximum retained terminals and pending allocations per Session. */
  readonly maxTerminals: number
  /** Maximum terminal width in columns. */
  readonly maxCols: number
  /** Maximum terminal height in rows. */
  readonly maxRows: number
  /** Screen history rows retained for reconnecting clients. */
  readonly scrollback: number
  /** Maximum queued UTF-8 frame bytes per output follower before disconnection. */
  readonly maxBufferedBytes: number
  /** Maximum UTF-8 bytes in one input request. */
  readonly maxInputBytes: number
  /** Provider process-termination grace period in milliseconds. */
  readonly disposeGraceMs: number
  /** Continuous confirmed idle time without window holds before reclamation; zero disables reclamation. */
  readonly unattendedTimeoutMs: number
  /** Interval between unattended shell and process observations. */
  readonly activityPollIntervalMs: number
  /** Delay before retrying failed owned terminal cleanup. */
  readonly cleanupRetryMs: number
}

interface TerminalAllocation {
  info: WebTerminalInfo
  readonly cleanup: TerminalRetention
}

interface OwnedSession {
  readonly lifetime: AbortController
  readonly closedIds: Set<WebTerminalId>
  cleanup?: Promise<void>
  readonly terminals: Map<WebTerminalId, BrowserTerminal>
  readonly pending: Map<WebTerminalId, Promise<BrowserTerminal>>
  readonly allocations: Map<WebTerminalId, TerminalAllocation>
}

/** Typed Remote control of transient Session-owned terminal processes. */
export class TerminalController extends TypertRemoteService {
  static inject = ['subprocess', 'sandboxPolicy', 'typert']
  static Config: z<Config> = z.object({
    shell: z.union([z.object({
      path: z.string().required(), name: z.string().required(), args: z.array(z.string()).default([]),
    }), z.const(undefined)]),
    shellCandidates: z.array(z.string().min(1)).default(['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd']),
    maxTerminals: z.number().step(1).min(1).default(8),
    maxCols: z.number().step(1).min(2).default(500),
    maxRows: z.number().step(1).min(1).default(200),
    scrollback: z.number().step(1).min(0).default(1000),
    maxBufferedBytes: z.number().step(1).min(1024).default(2 * 1024 * 1024),
    maxInputBytes: z.number().step(1).min(1).default(64 * 1024),
    disposeGraceMs: z.number().step(1).min(1).default(1000),
    unattendedTimeoutMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(7_200_000),
    activityPollIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
    cleanupRetryMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(60_000),
  })

  private readonly owners = new Map<SessionId, OwnedSession>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Host context carrying typed Remote and execution providers.
   * @param config - validated terminal limits and optional shell profile.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'terminalController', { namespace: 'terminal' })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Terminal controller disposed'))
      const results = await Promise.allSettled([...this.owners].map(([id, owner]) => this.disposeOwner(id, owner)))
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'Browser terminal cleanup failed')
    }, 'terminal-controller.processes')
  }

  /**
   * Read the Session working directory and terminal limits without resolving a shell.
   * @param agent - Session owner supplied by the Gateway.
   * @param signal - request cancellation.
   * @returns the Session workspace directory and terminal limits.
   */
  @Remote
  environment(agent: Agent, signal: AbortSignal): TerminalEnvironment {
    signal.throwIfAborted()
    const { sandboxPolicy } = this.execution(agent)
    return { cwd: agent.session.header.cwd ?? sandboxPolicy.workspaceRoot,
      maxInputBytes: this.config.maxInputBytes, maxCols: this.config.maxCols,
      maxRows: this.config.maxRows, scrollback: this.config.scrollback }
  }

  /**
   * Discover installed shells in the Session's execution environment.
   * @param agent - Session owner supplied by the Gateway.
   * @param signal - request cancellation.
   * @returns verified profiles, with the configured or system default first.
   */
  @Remote
  shells(agent: Agent, signal: AbortSignal): Promise<TerminalShell[]> {
    signal.throwIfAborted()
    return discoverShells(this.execution(agent).subprocess, this.config.shell, this.config.shellCandidates, signal)
  }

  /**
   * List retained terminals without resolving or activating an Agent.
   * @param sessionId - displayed Session identity, including offline history.
   * @returns terminals retained for this Host lifetime.
   */
  @Remote
  list(sessionId: SessionId): WebTerminalInfo[] {
    const owner = this.owners.get(sessionId)
    if (owner === undefined) return []
    return [...owner.terminals.values(), ...owner.allocations.values()].map(terminal => terminal.info)
  }

  /**
   * Allocate a user shell once for a caller-generated identity, without Agent sandbox or approval restrictions.
   * @param agent - Session owner supplied by the Gateway.
   * @param request - initial dimensions and idempotency identity.
   * @param signal - allocation cancellation; committed terminals survive disconnection.
   * @returns the existing or newly committed terminal.
   */
  @Remote
  async create(agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> {
    this.lifetime.signal.throwIfAborted()
    if (!/^[\w-]{1,128}$/u.test(request.id)) throw new Error('Invalid terminal identity')
    this.dimensions(request.cols, request.rows)
    const owner = this.owner(agent)
    owner.lifetime.signal.throwIfAborted()
    this.requireOpen(owner, request.id)
    const existing = owner.terminals.get(request.id)
    if (existing !== undefined) return existing.info
    const pending = owner.pending.get(request.id)
    if (pending !== undefined) {
      const terminal = await pending
      this.requireOpen(owner, request.id)
      return terminal.info
    }
    if (new Set([...owner.terminals.keys(), ...owner.pending.keys(), ...owner.allocations.keys()]).size >= this.config.maxTerminals) throw new RemoteError('terminal/limit-reached', 'Session terminal limit reached', { limit: this.config.maxTerminals })
    const allocation = this.spawn(agent, owner, request, AbortSignal.any([signal, this.lifetime.signal, owner.lifetime.signal]))
    owner.pending.set(request.id, allocation)
    try {
      const terminal = await allocation
      owner.terminals.set(request.id, terminal)
      owner.allocations.delete(request.id)
      terminal.monitor(this.config, () => { owner.closedIds.add(request.id) }, () => {
        owner.terminals.delete(request.id)
      }, (error) => { this.ctx.logger.error('Browser terminal cleanup failed', error) })
      this.requireOpen(owner, request.id)
      return terminal.info
    } finally {
      owner.pending.delete(request.id)
    }
  }

  /**
   * Retain an existing terminal for a window without activating its Agent or taking input control.
   * @param sessionId - owning Session identity, including an inactive saved layout.
   * @param id - retained Host terminal identity.
   * @param signal - physical Remote stream cancellation.
   * @returns a hold acknowledgement followed by an open lifetime stream.
   */
  @Remote({ mode: 'stream' })
  retain(sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    const owner = this.owners.get(sessionId)
    const terminal = owner?.terminals.get(id)
    if (terminal === undefined || owner?.closedIds.has(id) === true || owner?.lifetime.signal.aborted === true) {
      throw new RemoteError('terminal/unavailable', 'Terminal is closing or unavailable', {})
    }
    return terminal.retain(signal)
  }

  /**
   * Attach to a terminal without binding its process lifetime to the transport.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param attachmentId - new exclusive input attachment.
   * @param signal - physical stream cancellation.
   * @returns screen recovery followed by output and metadata changes.
   */
  @Remote({ mode: 'stream' })
  follow(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, signal: AbortSignal): AsyncIterable<TerminalFrame> {
    if (!/^[\w-]{1,128}$/u.test(attachmentId)) throw new Error('Invalid terminal attachment identity')
    return this.terminal(agent, id).follow(attachmentId, signal)
  }

  /**
   * Deliver raw input, including Tab completion and control characters.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param attachmentId - current writable attachment.
   * @param data - input bytes represented as UTF-8 text.
   * @returns after provider input acceptance.
   */
  @Remote
  async write(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, data: string): Promise<void> {
    if (Buffer.byteLength(data, 'utf8') > this.config.maxInputBytes) throw new Error('Terminal input exceeds the configured limit')
    await this.terminal(agent, id).write(attachmentId, data)
  }

  /**
   * Update the dimensions of the PTY and recovery screen.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param attachmentId - current writable attachment.
   * @param cols - column count.
   * @param rows - row count.
   * @returns after the resize completes.
   */
  @Remote
  async resize(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, cols: number, rows: number): Promise<void> {
    this.dimensions(cols, rows)
    await this.terminal(agent, id).resize(attachmentId, cols, rows)
  }

  /**
   * Rename a terminal without changing its shell.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param title - nonempty display title, at most 120 characters.
   */
  @Remote
  rename(agent: Agent, id: WebTerminalId, title: string): void {
    if (title.trim().length === 0 || title.length > 120) throw new Error('Terminal title must contain 1–120 characters')
    this.terminal(agent, id).rename(title.trim())
  }

  /**
   * Close an identity to future creation and kill its process range; repeated closes succeed.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @returns after provider cleanup succeeds. A failure retains the terminal for retry.
   */
  @Remote
  async close(agent: Agent, id: WebTerminalId): Promise<void> {
    const owner = this.owner(agent)
    owner.closedIds.add(id)
    // create publishes the allocation before this wait settles; close owns it even if create then rejects.
    await owner.pending.get(id)?.catch(() => { /* Creation reports its failure; close still owns any allocated process. */ })
    const terminal = owner.terminals.get(id)
    if (terminal !== undefined) {
      await terminal.close()
      owner.terminals.delete(id)
    } else {
      const allocation = owner.allocations.get(id)
      if (allocation === undefined) return
      await allocation.cleanup.close()
      owner.allocations.delete(id)
    }
  }

  private owner(agent: Agent): OwnedSession {
    let owner = this.owners.get(agent.id)
    if (owner === undefined) {
      owner = { terminals: new Map(), pending: new Map(), allocations: new Map(), closedIds: new Set(), lifetime: new AbortController() }
      this.owners.set(agent.id, owner)
      const owned = owner
      agent.ctx.effect(() => async () => { await this.disposeOwner(agent.id, owned) }, 'terminal-controller.owner')
    }
    return owner
  }

  private disposeOwner(id: SessionId, owner: OwnedSession): Promise<void> {
    if (owner.cleanup !== undefined) return owner.cleanup
    owner.lifetime.abort(new Error('Terminal Session owner disposed'))
    owner.cleanup = (async () => {
      await Promise.allSettled(owner.pending.values())
      const results = await Promise.allSettled([
        ...[...owner.terminals.values()].map(terminal => terminal.dispose()),
        ...[...owner.allocations.values()].map(allocation => allocation.cleanup.dispose()),
      ])
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'Session terminal cleanup failed')
      owner.terminals.clear()
      owner.allocations.clear()
      this.owners.delete(id)
    })().catch((error: unknown) => { delete owner.cleanup; throw error })
    return owner.cleanup
  }

  private terminal(agent: Agent, id: WebTerminalId): BrowserTerminal {
    const terminal = this.owners.get(agent.id)?.terminals.get(id)
    if (terminal === undefined) throw new RemoteError('terminal/unavailable', 'Terminal no longer exists in this Session', {})
    this.requireOpen(this.owners.get(agent.id) as OwnedSession, id)
    return terminal
  }

  private requireOpen(owner: OwnedSession, id: WebTerminalId): void {
    if (owner.closedIds.has(id)) throw new RemoteError('terminal/unavailable', 'Terminal was closed in this Session', {})
  }

  private dimensions(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || cols < 2 || cols > this.config.maxCols
      || !Number.isSafeInteger(rows) || rows < 1 || rows > this.config.maxRows) throw new Error('Terminal dimensions exceed the configured limits')
  }

  private execution(agent: Agent): { subprocess: Context['subprocess']; sandboxPolicy: Context['sandboxPolicy'] } {
    // The Agent context selects execution providers but does not inject consumer services.
    const subprocess = agent.ctx.get('subprocess')
    const sandboxPolicy = agent.ctx.get('sandboxPolicy')
    if (subprocess === undefined || sandboxPolicy === undefined) throw new Error('The Session execution environment requires subprocess and sandbox policy providers')
    return { subprocess, sandboxPolicy }
  }

  private async spawn(agent: Agent, owner: OwnedSession, request: TerminalCreateRequest, signal: AbortSignal): Promise<BrowserTerminal> {
    const environment = this.environment(agent, signal)
    const { subprocess } = this.execution(agent)
    const shell = request.shellPath === undefined
      ? await resolveShell(subprocess, this.config.shell, signal)
      : (await this.shells(agent, signal)).find(candidate => candidate.path === request.shellPath)
    if (shell === undefined) throw new Error('Selected shell is not available in this execution environment')
    const handle = await subprocess.spawnTerminal({
      argv: [shell.path, ...shell.args], cwd: environment.cwd, cols: request.cols, rows: request.rows,
      terminalType: 'xterm-256color', env: { DSH_SESSION_ID: agent.id },
      shellActivity: true,
      graceMs: this.config.disposeGraceMs, signal,
    })
    const info: WebTerminalInfo = {
      id: request.id, shell, title: shell.name, cwd: environment.cwd,
      cols: request.cols, rows: request.rows, state: 'running', exitCode: null,
    }
    try {
      signal.throwIfAborted()
      return new BrowserTerminal(handle, info, this.config.scrollback, this.config.maxBufferedBytes)
    } catch (error) {
      const cleanup = new TerminalRetention(this.config, handle.inspectActivity.bind(handle), async () => {
        owner.closedIds.add(request.id)
        await handle.terminate()
        owner.allocations.delete(request.id)
      }, (cleanupError) => { this.ctx.logger.error('Browser terminal allocation cleanup failed', cleanupError) })
      owner.allocations.set(request.id, {
        info: { ...info, state: 'failed', error: error instanceof Error ? error.message : String(error) }, cleanup,
      })
      try {
        await cleanup.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Terminal allocation cleanup failed')
      }
      throw error
    }
  }
}

/** Browser terminal service plugin. */
export default TerminalController
