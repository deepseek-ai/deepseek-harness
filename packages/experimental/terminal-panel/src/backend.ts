/** Terminal registry backend whose sessions are Agent terminals in the Session's sidebar. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentTerminalError } from '@deepseek-ai/dsh-api-terminal-controller'
import type { AgentTerminalRequest } from '@deepseek-ai/dsh-api-terminal-controller'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import { TerminalBackendCleanupError } from '@deepseek-ai/dsh-terminal'
import type { TerminalBackend, TerminalBackendSpawnSpec } from '@deepseek-ai/dsh-terminal'
import type { Config } from './config.ts'
import { changedWithin, inspect, now, PanelTerminalSession, waitsForInput } from './session.ts'
import type { PanelTerminal } from './session.ts'

/** Refusal for subagents, whose terminals would not appear where the user is looking. */
export const SUBAGENT_REFUSAL = 'Subagents cannot open terminals because the user cannot see them; use bash for shell commands instead.'

/** Services the backend reaches for each new terminal. */
export interface PanelBackendServices {
  /** Open an Agent terminal through the Session's terminal controller. */
  readonly open: (agent: Agent, request: AgentTerminalRequest, signal: AbortSignal) => Promise<PanelTerminal>
  /** Resolve the Session's sandbox policy, as the bash tool does. */
  readonly policy: (session: Session) => SandboxExecutionPolicy
}

/** Startup thresholds and the bound of the returned startup screen. */
export type StartupOptions = Pick<Config, 'startupSilenceMs' | 'startupTimeoutMs' | 'probeIntervalMs' | 'maxReadBytes'>

/**
 * Wait until the shell has printed, gone silent and owns the foreground, then render the screen.
 * @param terminal - newly opened Agent terminal.
 * @param options - startup thresholds and screen byte bound.
 * @param signal - cancellation of unpublished setup.
 * @returns the rendered startup screen.
 */
export async function startup(terminal: PanelTerminal, options: StartupOptions, signal: AbortSignal): Promise<string> {
  const startedAt = now()
  const deadline = startedAt + options.startupTimeoutMs
  let revision = terminal.revision
  // A screen printed before startup began counts as output; the revision alone also advances on attachment state.
  const printed = terminal.read({ offset: 0, count: Number.MAX_SAFE_INTEGER, maxBytes: options.maxReadBytes }).text !== ''
  let lastChange = printed ? startedAt : undefined
  let lastProbe = -Infinity
  for (;;) {
    signal.throwIfAborted()
    if (terminal.info.state !== 'running') throw new Error('The terminal shell exited during startup')
    const time = now()
    if (time >= deadline) throw new Error(`The terminal shell did not reach its prompt within ${options.startupTimeoutMs} ms`)
    if (lastChange !== undefined && time - lastChange >= options.startupSilenceMs && time - lastProbe >= options.probeIntervalMs) {
      lastProbe = time
      const foreground = await inspect(terminal)
      if (terminal.revision !== revision) {
        revision = terminal.revision
        lastChange = now()
        continue
      }
      // An unobservable foreground leaves silence as the only evidence that startup files finished.
      if (foreground === undefined || waitsForInput(terminal, foreground)) break
      continue
    }
    const wake = lastChange === undefined
      ? deadline
      : Math.min(deadline, Math.max(lastChange + options.startupSilenceMs, lastProbe + options.probeIntervalMs))
    if (await changedWithin(terminal, revision, wake - now(), signal)) {
      revision = terminal.revision
      lastChange = now()
    }
  }
  await terminal.drain()
  return terminal.read({ offset: 0, count: Number.MAX_SAFE_INTEGER, maxBytes: options.maxReadBytes }).text
}

/**
 * Close a terminal whose startup failed, unless the person already took it over.
 * @param terminal - unpublished Agent terminal.
 * @returns after the terminal is closed or left to the person.
 */
async function closeUnpublished(terminal: PanelTerminal): Promise<void> {
  try {
    await terminal.close()
  } catch (error: unknown) {
    if (!(error instanceof AgentTerminalError && error.code === 'user-control')) throw error
  }
}

/** Opens each registry session as a sidebar terminal under the Session's sandbox policy. */
export class PanelTerminalBackend implements TerminalBackend {
  readonly type: string

  /**
   * @param services - terminal allocation and sandbox policy resolution.
   * @param config - validated plugin configuration.
   */
  constructor(private readonly services: PanelBackendServices, private readonly config: Config) {
    this.type = config.backendType
  }

  async spawn(spec: TerminalBackendSpawnSpec): Promise<PanelTerminalSession> {
    const signal = spec.signal ?? new AbortController().signal
    signal.throwIfAborted()
    if (spec.owner.session.header.origin === 'subagent') throw new Error(SUBAGENT_REFUSAL)
    const { config, services } = this
    const policy = services.policy(spec.owner.session)
    const terminal = await services.open(spec.owner, {
      title: spec.name ?? spec.sessionId,
      ...spec.cwd === undefined ? {} : { cwd: spec.cwd },
      cols: config.cols,
      rows: config.rows,
      policy,
      preferredShells: config.preferredShells,
      env: config.environment,
    }, signal)
    try {
      const current = (): SandboxExecutionPolicy => services.policy(spec.owner.session)
      return new PanelTerminalSession(terminal, await startup(terminal, config, signal), config, { launched: policy, current })
    } catch (error: unknown) {
      try {
        await closeUnpublished(terminal)
      } catch (cleanupError: unknown) {
        throw new TerminalBackendCleanupError(error, cleanupError)
      }
      throw error
    }
  }
}
