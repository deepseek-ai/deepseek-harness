/** One sidebar terminal behind the terminal registry: sends, screen reads, signals and release to the person. */

import { AgentTerminalError } from '@deepseek-ai/dsh-api-terminal-controller'
import type { AgentTerminal, TerminalScreenMark, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessTerminalForeground } from '@deepseek-ai/dsh-subprocess'
import { TerminalError } from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackendSession, TerminalReadRequest, TerminalReadResult, TerminalSendOperation, TerminalSendRead,
  TerminalSendRequest, TerminalSendResult, TerminalSessionStatus, TerminalSignal, TerminalSignalResult, TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'

/** Refusal the model receives once the person has typed into an Agent terminal. */
export const TAKEN_OVER = 'The user has taken over this terminal; read it with terminal_read or open a new terminal.'

/** Refusal the model receives once the Session's sandbox policy differs from the one the terminal launched under. */
export const POLICY_CHANGED = 'The session sandbox settings changed after this terminal opened, so it no longer accepts input; open a new terminal with terminal_open. You can still read, signal or close this one.'

/** Lines returned by `terminal_read` when the model names no count, as its schema states. */
const DEFAULT_READ_LINES = 500

/** The Agent terminal capabilities a session uses. */
export type PanelTerminal = Pick<AgentTerminal,
  'pid' | 'info' | 'revision' | 'changed' | 'drain' | 'write' | 'read' | 'mark' | 'inspectForeground' | 'signal' | 'close'>

/** Thresholds that decide when a send returns, and the byte bound of returned text. */
export interface PanelSendOptions {
  readonly promptSilenceMs: number
  readonly probeIntervalMs: number
  readonly idleSilenceMs: number
  readonly timeoutMs: number
  readonly maxReadBytes: number
}

/** The sandbox policy an Agent terminal launched under and the policy its Session resolves now. */
export interface PanelTerminalPolicy {
  readonly launched: SandboxExecutionPolicy
  readonly current: () => SandboxExecutionPolicy
}

/**
 * Whether two resolved policies confine commands the same way.
 * @param left - one resolved policy.
 * @param right - the other resolved policy.
 * @returns true when mode, workspace root and extra writable roots match.
 */
export function samePolicy(left: SandboxExecutionPolicy, right: SandboxExecutionPolicy): boolean {
  const roots = (policy: SandboxExecutionPolicy): string => [...policy.additionalWritableRoots ?? []].sort().join('\0')
  return left.mode === right.mode && left.workspaceRoot === right.workspaceRoot && roots(left) === roots(right)
}

interface RenderedLines {
  readonly lines: readonly string[]
  readonly truncated: boolean
}

const NO_LINES: RenderedLines = { lines: [], truncated: false }

/**
 * Read the monotonic clock used for every silence and deadline comparison.
 * @returns milliseconds since an arbitrary origin.
 */
export function now(): number {
  return performance.now()
}

/**
 * Translate the controller's takeover refusal into the model-facing explanation.
 * @param error - failure from an Agent terminal operation.
 * @returns the error to report.
 */
export function modelError(error: unknown): unknown {
  return error instanceof AgentTerminalError && error.code === 'user-control' ? new Error(TAKEN_OVER, { cause: error }) : error
}

/**
 * Project controller process state onto the registry's session status.
 * @param info - current terminal metadata.
 * @returns running, or exited with the shell's exit code when one exists.
 */
export function statusOf(info: WebTerminalInfo): TerminalSessionStatus {
  return info.state === 'running' ? { kind: 'running' } : { kind: 'exited', exitCode: info.exitCode, signal: null }
}

/**
 * Inspect the foreground process group, treating an inspection failure as unknown.
 * @param terminal - terminal to inspect.
 * @returns the foreground facts, or undefined when they cannot be observed.
 */
export async function inspect(terminal: PanelTerminal): Promise<SubprocessTerminalForeground | undefined> {
  try {
    return await terminal.inspectForeground()
  } catch (_inspectionFailed: unknown) {
    // An unobservable foreground leaves silence as the only readiness evidence.
    return undefined
  }
}

/**
 * Whether the shell is back at its prompt or the foreground program waits for terminal input.
 * @param terminal - terminal whose top-level process is the shell.
 * @param foreground - inspected foreground facts.
 * @returns true when typing would reach a reader now.
 */
export function waitsForInput(terminal: PanelTerminal, foreground: SubprocessTerminalForeground | undefined): boolean {
  return foreground !== undefined && (foreground.processGroupId === terminal.pid || foreground.inputWaiting)
}

/**
 * Wait for a revision after `revision`, a delay, or `stop`, whichever comes first.
 * @param terminal - terminal whose changes are awaited.
 * @param revision - revision already observed.
 * @param delayMs - longest wait.
 * @param stop - ends the wait early.
 * @returns whether the terminal changed.
 */
export async function changedWithin(terminal: PanelTerminal, revision: number, delayMs: number, stop: AbortSignal): Promise<boolean> {
  if (terminal.revision > revision) return true
  const wait = new AbortController()
  const end = (): void => { wait.abort() }
  const timer = setTimeout(end, Math.max(0, delayMs))
  stop.addEventListener('abort', end, { once: true })
  try {
    await terminal.changed(revision, wait.signal)
    return true
  } catch (error: unknown) {
    if (wait.signal.aborted) return false
    throw error
  } finally {
    clearTimeout(timer)
    stop.removeEventListener('abort', end)
  }
}

/**
 * Keep the newest UTF-8 bytes of text without splitting a code point.
 * @param text - complete text.
 * @param maxBytes - byte bound.
 * @returns the kept suffix and whether anything was dropped.
 */
export function newestBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const retainer = new TextRetainer({ kind: 'tail', maxBytes })
  retainer.push(text)
  const retained = retainer.finish()
  return { text: retained.text, truncated: retained.truncated }
}

/** A send's output, rendered from a screen mark that moves past the lines already read. */
class OutputReader {
  constructor(
    private readonly terminal: PanelTerminal,
    private mark: TerminalScreenMark,
    private readonly maxBytes: number,
  ) {}

  /**
   * Take the complete lines written since the previous read; the last line may still change and is read next time.
   * @returns the lines, each ending in a newline, and whether output was lost.
   */
  consume(): TerminalSendRead {
    const rendered = this.render()
    const complete = rendered.lines.slice(0, -1)
    if (complete.length === 0 && !rendered.truncated) return { delta: '', truncated: false }
    this.mark.dispose()
    this.mark = this.terminal.mark()
    const bounded = newestBytes(complete.map(line => `${line}\n`).join(''), this.maxBytes)
    return { delta: bounded.text, truncated: bounded.truncated || rendered.truncated }
  }

  /**
   * Render everything not yet read.
   * @returns the newest bytes of the remaining lines and whether output was lost.
   */
  remainder(): { text: string; truncated: boolean } {
    const rendered = this.render()
    const bounded = newestBytes(rendered.lines.join('\n'), this.maxBytes)
    return { text: bounded.text, truncated: bounded.truncated || rendered.truncated }
  }

  /** Release the screen mark. */
  dispose(): void {
    this.mark.dispose()
  }

  private render(): RenderedLines {
    try {
      return this.mark.lines()
    } catch (error: unknown) {
      if (error instanceof AgentTerminalError && error.code === 'unavailable') return NO_LINES
      throw error
    }
  }
}

/** One send: writes the input, then waits for readiness, silence, the deadline or the end of the session. */
class PanelSend implements TerminalSendOperation {
  readonly done: Promise<TerminalSendResult>
  private reader: OutputReader | undefined
  private finished = false
  private cancelRequested = false
  private writeIssued = false
  private readonly stop = new AbortController()

  constructor(
    private readonly terminal: PanelTerminal,
    request: TerminalSendRequest,
    private readonly options: PanelSendOptions,
    settled: () => void,
  ) {
    const signal = request.signal
    const abort = (): void => { this.cancel() }
    signal?.addEventListener('abort', abort, { once: true })
    this.done = this.run(request).finally(() => {
      this.finished = true
      this.reader?.dispose()
      signal?.removeEventListener('abort', abort)
      settled()
    })
  }

  readOutput(): TerminalSendRead {
    if (this.finished || this.reader === undefined) return { delta: '', truncated: false }
    return this.reader.consume()
  }

  cancel(): boolean {
    if (this.finished) return false
    if (!this.cancelRequested) {
      this.cancelRequested = true
      if (this.writeIssued) this.interrupt()
    }
    return true
  }

  /** End the wait because the Agent's session was closed or released. */
  release(): void {
    this.stop.abort()
  }

  private interrupt(): void {
    // The interrupt is queued behind the written input, so it reaches the command that input started.
    this.terminal.signal('SIGINT').catch((_interruptRefused: unknown) => {
      // After takeover or exit nothing can be interrupted; the wait still settles by readiness or deadline.
    })
  }

  private async run(request: TerminalSendRequest): Promise<TerminalSendResult> {
    const { terminal, options } = this
    await terminal.drain()
    const reader = new OutputReader(terminal, terminal.mark(), options.maxReadBytes)
    this.reader = reader
    const input = `${request.text}${request.submit ? '\r' : ''}`
    if (input.length > 0 && !this.cancelRequested) {
      this.writeIssued = true
      try {
        await terminal.write(input)
      } catch (error: unknown) {
        throw modelError(error)
      }
    }
    const startedAt = now()
    let revision = terminal.revision
    let lastChange = startedAt
    let lastProbe = -Infinity
    for (;;) {
      if (this.stop.signal.aborted || terminal.info.state !== 'running') return this.settle(reader, 'session_exit')
      const time = now()
      if (time - startedAt >= options.timeoutMs) return this.settle(reader, 'timeout')
      if (time - lastChange >= options.idleSilenceMs) return this.settle(reader, 'inferred_idle')
      if (time - lastChange >= options.promptSilenceMs && time - lastProbe >= options.probeIntervalMs) {
        lastProbe = time
        const foreground = await inspect(terminal)
        if (terminal.revision !== revision) {
          revision = terminal.revision
          lastChange = now()
        } else if (waitsForInput(terminal, foreground)) {
          return this.settle(reader, 'stdin_read')
        }
        continue
      }
      const wake = Math.min(
        startedAt + options.timeoutMs,
        lastChange + options.idleSilenceMs,
        Math.max(lastChange + options.promptSilenceMs, lastProbe + options.probeIntervalMs),
      )
      if (await changedWithin(terminal, revision, wake - now(), this.stop.signal)) {
        revision = terminal.revision
        lastChange = now()
      }
    }
  }

  private async settle(reader: OutputReader, waitReason: TerminalWaitReason): Promise<TerminalSendResult> {
    this.finished = true
    await this.terminal.drain()
    const remainder = reader.remainder()
    return { viewport: remainder.text, waitReason, sessionStatus: statusOf(this.terminal.info), truncated: remainder.truncated }
  }
}

/**
 * Registry session over one Agent terminal; closing before takeover ends the terminal, afterwards it only releases it.
 * The shell keeps its launch policy, so a send is refused once the Session resolves a different one.
 */
export class PanelTerminalSession implements TerminalBackendSession {
  private active: PanelSend | undefined
  private closing = false

  /**
   * @param terminal - committed Agent terminal.
   * @param motd - rendered screen after shell startup.
   * @param options - send thresholds and byte bound.
   * @param policy - the launch policy and the Session's current policy.
   */
  constructor(
    private readonly terminal: PanelTerminal,
    readonly motd: string,
    private readonly options: PanelSendOptions,
    private readonly policy: PanelTerminalPolicy,
  ) {}

  /** Top-level process id of the terminal's shell. */
  get pid(): number {
    return this.terminal.pid
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closing) throw new Error('PTY session is closing')
    if (this.active !== undefined) throw new TerminalError('PTY session already has an active send', 'SEND_ACTIVE')
    if (this.terminal.info.state !== 'running') throw new Error('PTY session has exited')
    if (this.terminal.info.control !== 'agent') throw new Error(TAKEN_OVER)
    if (!samePolicy(this.policy.launched, this.policy.current())) throw new Error(POLICY_CHANGED)
    if (request.signal?.aborted === true) throw new Error('PTY send aborted before write')
    // Only one send runs at a time, so the settling send is always the active one.
    const send = new PanelSend(this.terminal, request, this.options, () => { this.active = undefined })
    this.active = send
    return send
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const offset = request.offset ?? 0
    const count = request.count ?? DEFAULT_READ_LINES
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('PTY read offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('PTY read count must be a positive safe integer')
    return this.terminal.read({ offset, count, maxBytes: this.options.maxReadBytes })
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    if (this.closing) throw new Error('PTY session is closing')
    try {
      return { delivered: true, targetPgid: await this.terminal.signal(signal) }
    } catch (error: unknown) {
      throw modelError(error)
    }
  }

  status(): TerminalSessionStatus {
    return statusOf(this.terminal.info)
  }

  async close(_reason: string): Promise<void> {
    this.closing = true
    try {
      if (this.terminal.info.control === 'agent') await this.terminal.close()
    } catch (error: unknown) {
      // The person may type between the control check and the close; the terminal then stays theirs.
      if (!(error instanceof AgentTerminalError && error.code === 'user-control')) throw error
    } finally {
      // A failed close still ends the wait of the send in flight; the registry reports the failure.
      this.active?.release()
    }
  }
}
