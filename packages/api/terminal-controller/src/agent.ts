/** Agent access to Session terminals: control checks, typed failures and the agent's terminal handle. */
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessTerminalForeground, SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import type { BrowserTerminal } from './terminal.ts'
import type { TerminalScreenMark, TerminalScreenPage, TerminalScreenRequest, WebTerminalId, WebTerminalInfo } from './types.ts'

/** Why an agent operation on a terminal was refused. */
export type AgentTerminalErrorCode = 'user-control' | 'not-running' | 'unavailable'

/** A refused agent terminal operation; the terminal and its other attachments are unchanged. */
export class AgentTerminalError extends Error {
  /**
   * @param code - machine-routable refusal reason.
   * @param message - English description for logs and model-facing errors.
   */
  constructor(readonly code: AgentTerminalErrorCode, message: string) {
    super(message)
    this.name = 'AgentTerminalError'
  }
}

/** Launch parameters for an agent terminal; the caller resolves policy and directory. */
export interface AgentTerminalRequest {
  /** Tab title of 1–120 characters; surrounding whitespace is removed. */
  readonly title: string
  /** Absolute initial directory; absent uses the Session working directory. */
  readonly cwd?: string
  readonly cols: number
  readonly rows: number
  /** Policy resolved from the Session sandbox policy; confined modes wrap the shell. */
  readonly policy: SandboxExecutionPolicy
  /** Executable names tried in order among discovered shells before the environment default. */
  readonly preferredShells: readonly string[]
  /**
   * Variables added to the shell environment; the controller's `DSH_SESSION_ID`, and `HISTFILE` in confined
   * POSIX shells, take precedence.
   */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * The agent's capability over one terminal it opened. Input, signals and closing require Agent control;
 * reads continue after the person takes over.
 */
export interface AgentTerminal {
  /** Host identity of the sidebar terminal. */
  readonly id: WebTerminalId
  /** Top-level process id; an unconfined or exec-confined shell leads its own process group with it. */
  readonly pid: number
  /** Current metadata, including control and process state. */
  readonly info: WebTerminalInfo
  /** Advances after applied output and published state changes. */
  readonly revision: number
  /**
   * Wait until output or state changes after a known revision.
   * @param after - revision the caller has observed.
   * @param signal - wait cancellation.
   * @returns the current revision.
   */
  changed(after: number, signal: AbortSignal): Promise<number>
  /**
   * Write input in order with the person's input and output.
   * @param data - text delivered without implicit newline conversion.
   * @returns after the provider accepts the input.
   */
  write(data: string): Promise<void>
  /**
   * Wait until output received before the call is applied to the screen.
   * @returns after queued output and input settle.
   */
  drain(): Promise<void>
  /**
   * Render a newest-relative page of the screen as applied so far.
   * @param request - page position and byte bound.
   * @returns rendered text.
   * @throws AgentTerminalError `unavailable` after the terminal is closed.
   */
  read(request: TerminalScreenRequest): TerminalScreenPage
  /**
   * Mark the start of the cursor's logical line on the screen as applied so far, so later output can be rendered from it.
   * @returns the screen mark.
   * @throws AgentTerminalError `unavailable` after the terminal is closed.
   */
  mark(): TerminalScreenMark
  /**
   * Inspect the foreground process group.
   * @returns the group and its input-wait fact, or undefined when unknown.
   */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined>
  /**
   * Signal the foreground process group.
   * @param signal - permitted terminal signal.
   * @returns the process group that received it.
   */
  signal(signal: SubprocessTerminalSignal): Promise<number>
  /**
   * Terminate the terminal and remove its tab while the agent controls it.
   * Control is checked once when the call starts; a takeover during cleanup does not stop the close.
   * @returns after process cleanup.
   * @throws AgentTerminalError after the person takes over; the terminal then stays open for the person.
   */
  close(): Promise<void>
}

/** The controller's {@link AgentTerminal} over one committed Session terminal; the package does not export it. */
export class AgentTerminalHandle implements AgentTerminal {
  /**
   * @param terminal - committed Session terminal.
   * @param closeTerminal - closes the identity through its Session owner.
   */
  constructor(private readonly terminal: BrowserTerminal, private readonly closeTerminal: () => Promise<void>) {}

  get id(): WebTerminalId { return this.terminal.info.id }

  get pid(): number { return this.terminal.pid }

  get info(): WebTerminalInfo { return this.terminal.info }

  get revision(): number { return this.terminal.revision }

  changed(after: number, signal: AbortSignal): Promise<number> { return this.terminal.changed(after, signal) }

  write(data: string): Promise<void> { return this.terminal.agentWrite(data) }

  drain(): Promise<void> { return this.terminal.drain() }

  read(request: TerminalScreenRequest): TerminalScreenPage { return this.terminal.readScreen(request) }

  mark(): TerminalScreenMark { return this.terminal.markScreen() }

  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> { return this.terminal.inspectForeground() }

  signal(signal: SubprocessTerminalSignal): Promise<number> { return this.terminal.agentSignal(signal) }

  async close(): Promise<void> {
    if (this.terminal.info.control !== 'agent') throw new AgentTerminalError('user-control', 'The user has taken over this terminal')
    await this.closeTerminal()
  }
}
