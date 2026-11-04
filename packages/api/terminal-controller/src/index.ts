/** Session-owned user terminals with the execution environment's system-user permissions. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import { AgentTerminalHandle, type AgentTerminal, type AgentTerminalRequest } from './agent.ts'
import { discoverShells, findShell, resolveShell } from './shells.ts'
import { BrowserTerminal } from './terminal.ts'
import { TerminalRetention } from './retention.ts'
import type {
  TerminalShell, TerminalInput, TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalRetentionFrame,
  TerminalScreenPage, TerminalScreenRequest, WebTerminalId, WebTerminalInfo,
} from './types.ts'

export type * from './types.ts'
export { AgentTerminalError } from './agent.ts'
export type { AgentTerminal, AgentTerminalErrorCode, AgentTerminalRequest } from './agent.ts'

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
  /**
   * Maximum running Agent-controlled terminals and pending Agent allocations per Session; `maxTerminals` still bounds
   * every terminal, including exited ones and failed allocations awaiting cleanup.
   */
  readonly maxAgentTerminals: number
  /** Maximum terminal width in columns. */
  readonly maxCols: number
  /** Maximum terminal height in rows. */
  readonly maxRows: number
  /** Screen history rows retained for reconnecting clients. */
  readonly scrollback: number
  /** Maximum queued UTF-8 frame bytes per output follower and in the Client input buffer. */
  readonly maxBufferedBytes: number
  /** Maximum raw UTF-8 bytes per input command and across unacknowledged Client input. */
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
  /** Agent allocations not yet committed; with running Agent-controlled terminals, they count toward `maxAgentTerminals`. */
  readonly agentPending: Set<WebTerminalId>
}

/** Process launch and the metadata published once the process is committed. */
interface TerminalLaunch {
  readonly argv: readonly string[]
  readonly env: Record<string, string>
  readonly info: WebTerminalInfo
  /** Removes files the launch created once the process has ended; it must not throw. */
  readonly release?: () => Promise<void>
}

/**
 * Validate a terminal display title.
 * @param title - requested title.
 * @returns the title without surrounding whitespace.
 * @throws Error when the title is blank or longer than 120 characters.
 */
function terminalTitle(title: string): string {
  if (title.trim().length === 0 || title.length > 120) throw new Error('Terminal title must contain 1–120 characters')
  return title.trim()
}

/** Typed Remote control of transient Session-owned terminal processes. */
export class TerminalController extends TypertRemoteService {
  static inject = ['subprocess', 'sandboxPolicy', 'workingDirectory', 'typert']
  static Config: z<Config> = z.object({
    shell: z.union([z.object({
      path: z.string().required(), name: z.string().required(), args: z.array(z.string()).default([]),
    }), z.const(undefined)]),
    shellCandidates: z.array(z.string().min(1)).default(['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd']),
    maxTerminals: z.number().step(1).min(1).default(8),
    maxAgentTerminals: z.number().step(1).min(1).default(4),
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
  private readonly rosters = new Map<SessionId, Set<() => void>>()
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
   * Read the Session's current directory and terminal limits without filesystem validation or shell lookup.
   * @param agent - Session owner supplied by the Gateway.
   * @param signal - request cancellation.
   * @returns the logged current directory and terminal limits; retained terminals keep their own process directories.
   */
  @Remote
  environment(agent: Agent, signal: AbortSignal): TerminalEnvironment {
    signal.throwIfAborted()
    const { workingDirectory } = this.execution(agent)
    return { cwd: workingDirectory.get(agent.session),
      maxInputBytes: this.config.maxInputBytes, maxBufferedBytes: this.config.maxBufferedBytes, maxCols: this.config.maxCols,
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
    this.requireCapacity(owner)
    return (await this.allocate(agent, owner, request.id, launchSignal => this.userLaunch(agent, request, launchSignal), signal)).info
  }

  /**
   * Open a terminal for the Session's Agent under a caller-resolved sandbox policy; it appears in every
   * window that watches the Session and passes to the person on the person's first typed input.
   * @param agent - Session owner whose Agent requests the terminal.
   * @param request - title, directory, dimensions, sandbox policy and shell preference.
   * @param signal - allocation cancellation; a committed terminal outlives it.
   * @returns the Agent's handle for the committed terminal.
   * @throws RemoteError `terminal/limit-reached` when the Session or Agent terminal limit is reached.
   * @throws Error when the title is blank or longer than 120 characters.
   */
  async openForAgent(agent: Agent, request: AgentTerminalRequest, signal: AbortSignal): Promise<AgentTerminal> {
    this.lifetime.signal.throwIfAborted()
    const title = terminalTitle(request.title)
    this.dimensions(request.cols, request.rows)
    const owner = this.owner(agent)
    owner.lifetime.signal.throwIfAborted()
    this.requireCapacity(owner)
    const controlled = new Set(owner.agentPending)
    for (const { info } of [...owner.terminals.values(), ...owner.allocations.values()]) {
      if (info.origin === 'agent' && info.control === 'agent' && info.state === 'running') controlled.add(info.id)
    }
    if (controlled.size >= this.config.maxAgentTerminals) throw new RemoteError('terminal/limit-reached', 'Session Agent terminal limit reached', { limit: this.config.maxAgentTerminals })
    const id = randomUUID() as WebTerminalId
    owner.agentPending.add(id)
    try {
      const launch = { ...request, title }
      const terminal = await this.allocate(agent, owner, id, launchSignal => this.agentLaunch(agent, id, launch, launchSignal), signal)
      return new AgentTerminalHandle(terminal, () => this.close(agent, id))
    } finally {
      owner.agentPending.delete(id)
    }
  }

  /**
   * Render a page of any terminal in the Agent's Session, including terminals the person opened.
   * @param agent - Session owner.
   * @param id - terminal identity.
   * @param request - page position and byte bound.
   * @returns rendered screen text, including output received before the call.
   * @throws RemoteError `terminal/unavailable` when the terminal is missing or closes before the screen is read.
   */
  readScreen(agent: Agent, id: WebTerminalId, request: TerminalScreenRequest): Promise<TerminalScreenPage> {
    const terminal = this.terminal(agent, id)
    return terminal.drain().then(() => {
      if (terminal.screenReleased) throw new RemoteError('terminal/unavailable', 'Terminal was closed in this Session', {})
      return terminal.readScreen(request)
    })
  }

  /**
   * Observe whether a Session terminal's shell is running a command.
   * @param agent - Session owner.
   * @param id - terminal identity.
   * @returns idle, busy, or unknown for unsupported shells and sandboxed launches.
   */
  inspectActivity(agent: Agent, id: WebTerminalId): Promise<'idle' | 'busy' | 'unknown'> {
    return this.terminal(agent, id).inspectActivity()
  }

  /**
   * Stream the Session's retained terminals as whole sets, without resolving or activating an Agent.
   * @param sessionId - watched Session identity.
   * @param signal - stream cancellation.
   * @returns the current set, then a new set after creation, removal or any published state change.
   */
  @Remote({ mode: 'stream' })
  async *watch(sessionId: SessionId, signal: AbortSignal): AsyncIterable<WebTerminalInfo[]> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    let dirty = true
    let wake: (() => void) | undefined
    const listener = (): void => { dirty = true; wake?.() }
    const listeners = this.rosters.get(sessionId) ?? new Set<() => void>()
    this.rosters.set(sessionId, listeners)
    listeners.add(listener)
    lifetime.addEventListener('abort', listener, { once: true })
    try {
      while (!lifetime.aborted) {
        if (dirty) {
          dirty = false
          yield this.list(sessionId)
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      lifetime.removeEventListener('abort', listener)
      listeners.delete(listener)
      if (listeners.size === 0) this.rosters.delete(sessionId)
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
   * Attach terminal input and output to one physical Remote stream.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param signal - attachment cancellation; the process remains alive and input is never replayed.
   * @returns screen recovery, output, writable state and provider-acceptance acknowledgements.
   */
  @Remote({ mode: 'stream' })
  attach(agent: Agent, id: WebTerminalId, signal: AbortSignal): RemoteStream<TerminalFrame, TerminalInput> {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('Terminal attachment requires a Remote invocation')
    return this.terminal(agent, id).attach(invocation.uplink<TerminalInput>(), this.config, signal, invocation.uplinkWindow)
  }

  /**
   * Rename a terminal without changing its shell.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param title - nonempty display title, at most 120 characters.
   */
  @Remote
  rename(agent: Agent, id: WebTerminalId, title: string): void {
    const trimmed = terminalTitle(title)
    this.terminal(agent, id).rename(trimmed)
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
    this.changed(agent.id)
  }

  private owner(agent: Agent): OwnedSession {
    let owner = this.owners.get(agent.id)
    if (owner === undefined) {
      owner = {
        terminals: new Map(), pending: new Map(), allocations: new Map(), closedIds: new Set(),
        lifetime: new AbortController(), agentPending: new Set(),
      }
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
      this.changed(id)
    })().catch((error: unknown) => { delete owner.cleanup; throw error })
    return owner.cleanup
  }

  private changed(sessionId: SessionId): void {
    for (const listener of this.rosters.get(sessionId) ?? []) listener()
  }

  private requireCapacity(owner: OwnedSession): void {
    if (new Set([...owner.terminals.keys(), ...owner.pending.keys(), ...owner.allocations.keys()]).size >= this.config.maxTerminals) throw new RemoteError('terminal/limit-reached', 'Session terminal limit reached', { limit: this.config.maxTerminals })
  }

  private async allocate(
    agent: Agent, owner: OwnedSession, id: WebTerminalId, prepare: (signal: AbortSignal) => Promise<TerminalLaunch>, signal: AbortSignal,
  ): Promise<BrowserTerminal> {
    const allocation = this.spawn(agent, owner, id, prepare, AbortSignal.any([signal, this.lifetime.signal, owner.lifetime.signal]))
    owner.pending.set(id, allocation)
    try {
      const terminal = await allocation
      owner.terminals.set(id, terminal)
      owner.allocations.delete(id)
      terminal.monitor(this.config, () => { owner.closedIds.add(id) }, () => {
        owner.terminals.delete(id)
        this.changed(agent.id)
      }, (error) => { this.ctx.logger.error('Browser terminal cleanup failed', error) })
      terminal.setStateListener(() => { this.changed(agent.id) })
      this.changed(agent.id)
      this.requireOpen(owner, id)
      return terminal
    } finally {
      owner.pending.delete(id)
    }
  }

  private async userLaunch(agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<TerminalLaunch> {
    const { subprocess, workingDirectory } = this.execution(agent)
    const cwd = await workingDirectory.ensure(agent, signal)
    const shell = request.shellPath === undefined
      ? await resolveShell(subprocess, this.config.shell, signal)
      : (await this.shells(agent, signal)).find(candidate => candidate.path === request.shellPath)
    if (shell === undefined) throw new Error('Selected shell is not available in this execution environment')
    return {
      argv: [shell.path, ...shell.args], env: { DSH_SESSION_ID: agent.id },
      info: { id: request.id, shell, title: shell.name, cwd, cols: request.cols, rows: request.rows, state: 'running', exitCode: null, origin: 'user', control: 'user' },
    }
  }

  private async agentLaunch(agent: Agent, id: WebTerminalId, request: AgentTerminalRequest, signal: AbortSignal): Promise<TerminalLaunch> {
    const { subprocess, workingDirectory } = this.execution(agent)
    const cwd = request.cwd ?? await workingDirectory.ensure(agent, signal)
    const shell = await this.agentShell(agent, request.preferredShells, signal)
    const argv = await this.confine(agent, [shell.path, ...shell.args], request.policy, signal)
    const { platform } = await subprocess.terminalEnvironment(signal)
    // Confined shells cannot write the person's history file and must not load it. Only workspace-write grants /tmp,
    // so a read-only shell gets an empty HISTFILE and keeps no history file.
    const historyFile = `/tmp/dsh-agent-history-${id}`
    const keepsHistory = platform === 'posix' && request.policy.mode === 'workspace-write'
    const confined = platform === 'posix' && request.policy.mode !== 'danger-full-access'
    const history = confined ? { HISTFILE: keepsHistory ? historyFile : '' } : {}
    return {
      argv, env: { ...request.env, DSH_SESSION_ID: agent.id, ...history },
      info: {
        id, shell, title: request.title, cwd, cols: request.cols, rows: request.rows, state: 'running', exitCode: null,
        origin: 'agent', control: 'agent', sandboxMode: request.policy.mode,
      },
      ...keepsHistory ? { release: () => this.removeHistory(subprocess, historyFile) } : {},
    }
  }

  /**
   * Delete a confined Agent shell's history file in its execution environment after the shell ends.
   * @param subprocess - the execution environment that ran the shell.
   * @param path - history file the shell was given.
   * @returns after deletion; a failure is logged because the file only holds the ended shell's own history.
   */
  private async removeHistory(subprocess: Context['subprocess'], path: string): Promise<void> {
    try {
      const { exitCode, signal } = await subprocess.spawn({
        argv: ['rm', '-f', '--', path], cwd: '/',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: this.config.disposeGraceMs,
      }).done
      if (exitCode !== 0) throw new Error(`rm ended with ${exitCode ?? signal}`)
    } catch (error) {
      this.ctx.logger.warn('Agent terminal history cleanup failed', { path, error })
    }
  }

  private async agentShell(agent: Agent, preferred: readonly string[], signal: AbortSignal): Promise<TerminalShell> {
    if (preferred.length > 0) {
      const shells = await this.shells(agent, signal)
      for (const name of preferred) {
        const shell = findShell(shells, name)
        if (shell !== undefined) return shell
      }
    }
    return resolveShell(this.execution(agent).subprocess, this.config.shell, signal)
  }

  private async confine(
    agent: Agent, argv: readonly string[], policy: SandboxExecutionPolicy, signal: AbortSignal,
  ): Promise<readonly string[]> {
    if (policy.mode === 'danger-full-access') return argv
    const sandbox = agent.ctx.get('sandbox')
    if (sandbox === undefined) throw new Error(`Agent terminals in sandbox mode "${policy.mode}" require a sandbox provider in the execution environment`)
    // Re-state the discriminant because object spread does not preserve its narrowed type.
    return (await sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)).argv
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

  private execution(agent: Agent): { subprocess: Context['subprocess']; sandboxPolicy: Context['sandboxPolicy']; workingDirectory: Context['workingDirectory'] } {
    // The Agent context selects execution providers but does not inject consumer services.
    const subprocess = agent.ctx.get('subprocess')
    const sandboxPolicy = agent.ctx.get('sandboxPolicy')
    if (subprocess === undefined || sandboxPolicy === undefined) throw new Error('The Session execution environment requires subprocess and sandbox policy providers')
    const workingDirectory = agent.ctx.get('workingDirectory')
    if (workingDirectory === undefined) throw new Error('The Session execution environment requires a working-directory provider')
    return { subprocess, sandboxPolicy, workingDirectory }
  }

  private async spawn(
    agent: Agent, owner: OwnedSession, id: WebTerminalId, prepare: (signal: AbortSignal) => Promise<TerminalLaunch>, signal: AbortSignal,
  ): Promise<BrowserTerminal> {
    const { info, argv, env, release } = await prepare(signal)
    const handle = await this.execution(agent).subprocess.spawnTerminal({
      argv, cwd: info.cwd, cols: info.cols, rows: info.rows,
      terminalType: 'xterm-256color', env,
      shellActivity: true,
      graceMs: this.config.disposeGraceMs, signal,
    })
    try {
      signal.throwIfAborted()
      return new BrowserTerminal(handle, info, this.config.scrollback, this.config.maxBufferedBytes, release)
    } catch (error) {
      const cleanup = new TerminalRetention(this.config, handle.inspectActivity.bind(handle), async () => {
        owner.closedIds.add(id)
        await handle.terminate()
        await release?.()
        owner.allocations.delete(id)
        this.changed(agent.id)
      }, (cleanupError) => { this.ctx.logger.error('Browser terminal allocation cleanup failed', cleanupError) })
      owner.allocations.set(id, {
        info: { ...info, state: 'failed', error: error instanceof Error ? error.message : String(error) }, cleanup,
      })
      this.changed(agent.id)
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
