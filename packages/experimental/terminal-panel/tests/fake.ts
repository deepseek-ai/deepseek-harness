/** Scripted Agent terminal: a line screen, revisions, foreground facts and recorded agent operations. */
import { vi } from 'vitest'
import { AgentTerminalError } from '@deepseek-ai/dsh-api-terminal-controller'
import type { TerminalScreenMark, TerminalScreenPage, TerminalScreenRequest, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller'
import type { SubprocessTerminalForeground, SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import type { PanelTerminal } from '../src/session.ts'

/** The shell's process id; a foreground group equal to it means the shell is at its prompt. */
export const SHELL_PID = 100

interface Mark {
  index: number
  trimmed: boolean
  disposed: boolean
}

export class FakeTerminal implements PanelTerminal {
  readonly pid = SHELL_PID
  info: WebTerminalInfo = {
    id: 'web-terminal' as WebTerminalId, shell: { name: 'sh', path: '/bin/sh', args: ['-i'] }, title: 'pty-1', cwd: '/workspace',
    rows: 24, cols: 80, state: 'running', exitCode: null, origin: 'agent', control: 'agent', sandboxMode: 'workspace-write',
  }

  revision = 0
  /** Logical screen lines; the last one holds the cursor. */
  screen: string[] = ['$']
  foreground: SubprocessTerminalForeground | undefined = { processGroupId: SHELL_PID, inputWaiting: false }
  released = false
  /** Thrown by mark rendering to stand for an emulator failure. */
  renderFailure: Error | undefined
  readonly marks: Mark[] = []
  private readonly waiters = new Set<() => void>()

  readonly drain = vi.fn(async (): Promise<void> => {})
  readonly write = vi.fn(async (_data: string): Promise<void> => {})
  readonly inspectForeground = vi.fn(async (): Promise<SubprocessTerminalForeground | undefined> => this.foreground)
  readonly signal = vi.fn(async (_signal: SubprocessTerminalSignal): Promise<number> => 77)
  readonly close = vi.fn(async (): Promise<void> => {
    this.released = true
    this.update({ state: 'exited', exitCode: 0 })
  })

  readonly read = vi.fn((request: TerminalScreenRequest): TerminalScreenPage => {
    this.requireScreen()
    const end = Math.max(0, this.screen.length - request.offset)
    const lines = this.screen.slice(Math.max(0, end - request.count), end)
    return { text: lines.join('\n'), totalLines: this.screen.length, lineBegin: request.offset, lineEnd: request.offset + lines.length, truncated: false }
  })

  async changed(after: number, signal: AbortSignal): Promise<number> {
    while (this.revision <= after) {
      signal.throwIfAborted()
      await new Promise<void>((resolve) => {
        const wake = (): void => { signal.removeEventListener('abort', wake); this.waiters.delete(wake); resolve() }
        this.waiters.add(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    }
    return this.revision
  }

  mark(): TerminalScreenMark {
    this.requireScreen()
    const mark: Mark = { index: this.screen.length - 1, trimmed: false, disposed: false }
    this.marks.push(mark)
    return {
      lines: () => {
        this.requireScreen()
        if (this.renderFailure !== undefined) throw this.renderFailure
        return mark.trimmed ? { lines: [...this.screen], truncated: true } : { lines: this.screen.slice(mark.index), truncated: false }
      },
      dispose: () => { mark.disposed = true },
    }
  }

  /**
   * Apply output: the first part continues the cursor line, each later part starts a new line.
   * @param parts - text of the cursor line followed by new lines.
   */
  output(...parts: string[]): void {
    const [first = '', ...rest] = parts
    this.screen.push(`${this.screen.pop() ?? ''}${first}`, ...rest)
    this.advance()
  }

  /**
   * Drop the oldest lines as scrollback trimming does, trimming marks inside them.
   * @param count - number of lines dropped.
   */
  trim(count: number): void {
    this.screen.splice(0, count)
    for (const mark of this.marks) {
      if (mark.index < count) mark.trimmed = true
      else mark.index -= count
    }
  }

  /**
   * Publish a metadata change.
   * @param change - changed fields.
   */
  update(change: Partial<WebTerminalInfo>): void {
    this.info = { ...this.info, ...change }
    this.advance()
  }

  private advance(): void {
    this.revision++
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const wake of waiters) wake()
  }

  private requireScreen(): void {
    if (this.released) throw new AgentTerminalError('unavailable', 'The terminal was closed')
  }
}
