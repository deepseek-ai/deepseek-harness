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
  /** Tab title. */
  readonly title: string
  /** Absolute initial directory; absent uses the Session working directory. */
  readonly cwd?: string
  readonly cols: number
  readonly rows: number
  /** Policy resolved from the Session sandbox policy; confined modes wrap the shell. */
  readonly policy: SandboxExecutionPolicy
  /** Executable names tried in order among discovered shells before the environment default. */
  readonly preferredShells: readonly string[]
}

/**
 * The agent's capability over one terminal it opened. Input, signals and closing require Agent control;
 * reads continue after the person takes over.
 */
export class AgentTerminal {
  /**
   * @param terminal - committed Session terminal.
   * @param closeTerminal - closes the identity through its Session owner.
   */
  constructor(private readonly terminal: BrowserTerminal, private readonly closeTerminal: () => Promise<void>) {}

  /** Host identity of the sidebar terminal. */
  get id(): WebTerminalId { return this.terminal.info.id }

  /** Current metadata, including control and process state. */
  get info(): WebTerminalInfo { return this.terminal.info }

  /** Advances after applied output and published state changes. */
  get revision(): number { return this.terminal.revision }

  /**
   * Wait until output or state changes after a known revision.
   * @param after - revision the caller has observed.
   * @param signal - wait cancellation.
   * @returns the current revision.
   */
  changed(after: number, signal: AbortSignal): Promise<number> { return this.terminal.changed(after, signal) }

  /**
   * Write input in order with the person's input and output.
   * @param data - text delivered without implicit newline conversion.
   * @returns after the provider accepts the input.
   */
  write(data: string): Promise<void> { return this.terminal.agentWrite(data) }

  /**
   * Render a newest-relative page of the screen.
   * @param request - page position and byte bound.
   * @returns rendered text.
   */
  read(request: TerminalScreenRequest): Promise<TerminalScreenPage> { return this.terminal.readScreen(request) }

  /**
   * Mark the cursor row so later output can be rendered from it.
   * @returns the screen mark.
   */
  mark(): Promise<TerminalScreenMark> { return this.terminal.markScreen() }

  /**
   * Inspect the foreground process group.
   * @returns the group and its input-wait fact, or undefined when unknown.
   */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> { return this.terminal.inspectForeground() }

  /**
   * Signal the foreground process group.
   * @param signal - permitted terminal signal.
   * @returns the process group that received it.
   */
  signal(signal: SubprocessTerminalSignal): Promise<number> { return this.terminal.agentSignal(signal) }

  /**
   * Terminate the terminal and remove its tab while the agent controls it.
   * @returns after process cleanup.
   * @throws AgentTerminalError after the person takes over; the terminal then stays open for the person.
   */
  async close(): Promise<void> {
    if (this.terminal.info.control !== 'agent') throw new AgentTerminalError('user-control', 'The user has taken over this terminal')
    await this.closeTerminal()
  }
}
