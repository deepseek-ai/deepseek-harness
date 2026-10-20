/** Agent access to Session terminals: control checks and their typed failures. */

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
