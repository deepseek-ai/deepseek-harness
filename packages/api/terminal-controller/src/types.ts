/** Browser terminal identities, metadata and screen-stream frames. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The terminal identity is missing or has begun process cleanup. */
    'terminal/unavailable': Record<string, never>
    /** Input or resize was refused without invalidating the output attachment. */
    'terminal/control-unavailable': { readonly reason: 'read-only' | 'not-running' }
    /** Retained screens and pending allocations consume the Session's terminal quota. */
    'terminal/limit-reached': { readonly limit: number }
  }
}

/** A terminal identity scoped to one Session and one Host lifetime. */
export type WebTerminalId = Branded<'WebTerminalId'>

/** Acknowledges one physical window hold without taking screen or input control. */
export interface TerminalRetentionFrame {
  readonly type: 'retained'
}

/** An executable shell verified in the subprocess provider's execution environment. */
export interface TerminalShell {
  readonly path: string
  readonly args: readonly string[]
  readonly name: string
}

/** Current Session directory and terminal limits; retained terminals keep their own process directories. */
export interface TerminalEnvironment {
  /** Logged current directory, read without filesystem validation. */
  readonly cwd: string
  readonly maxInputBytes: number
  /** Maximum complete encoded Client input bytes retained until acknowledgement. */
  readonly maxBufferedBytes: number
  readonly maxCols: number
  readonly maxRows: number
  readonly scrollback: number
}

/** The party that created a terminal or controls its input. */
export type TerminalParty = 'user' | 'agent'

/**
 * Sandbox mode of an agent terminal. Kept member-identical to `SandboxMode` in
 * `@deepseek-ai/dsh-sandbox` without a wire dependency on it; change both together.
 */
export type TerminalSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Host-owned terminal state; process exit never creates a replacement shell. */
export interface WebTerminalInfo {
  readonly id: WebTerminalId
  readonly title: string
  readonly shell: TerminalShell
  /** Initial working directory; shell directory changes do not update this field. */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly state: 'running' | 'exited' | 'failed'
  readonly exitCode: number | null
  readonly error?: string
  /** Party that created the terminal. */
  readonly origin: TerminalParty
  /** Input owner; an agent terminal passes to the user on the user's first typed input and never returns. */
  readonly control: TerminalParty
  /** Sandbox mode an agent terminal started under; user terminals run with system-user permissions and omit it. */
  readonly sandboxMode?: TerminalSandboxMode
}

/** A newest-relative page of rendered screen lines. */
export interface TerminalScreenRequest {
  /** Lines to skip back from the newest line. */
  readonly offset: number
  /** Maximum lines to return. */
  readonly count: number
  /** Maximum UTF-8 bytes of the returned text; the newest bytes are kept. */
  readonly maxBytes: number
}

/** Rendered screen text: wrapped rows are joined and control sequences are already applied. */
export interface TerminalScreenPage {
  readonly text: string
  /** Logical lines currently retained, including scrollback. */
  readonly totalLines: number
  /** Inclusive newest-relative offset of the page. */
  readonly lineBegin: number
  /** Exclusive newest-relative offset after the returned lines. */
  readonly lineEnd: number
  /** Whether the byte bound dropped lines or cut a line inside the requested range. */
  readonly truncated: boolean
}

/** A screen position that follows scrollback trimming, used to render output written after it. */
export interface TerminalScreenMark {
  /**
   * Render logical lines from the marked row through the last content row of the screen as applied so far.
   * @returns the lines; `truncated` means scrollback trimming discarded the marked row and rendering starts at the oldest row.
   * @throws AgentTerminalError `unavailable` after the screen is released.
   */
  lines(): { readonly lines: readonly string[]; readonly truncated: boolean }
  /** Release the emulator marker. */
  dispose(): void
}

/** Create is idempotent for an open identity; closed identities cannot be recreated. */
export interface TerminalCreateRequest {
  /** A path returned by shell discovery; absent selects the execution default. */
  readonly shellPath?: string
  readonly id: WebTerminalId
  readonly cols: number
  readonly rows: number
}

/**
 * Commands are numbered consecutively from one within each attachment; acknowledgements never authorize replay.
 * `typed` marks keyboard, paste, IME or pointer input from the person, as opposed to terminal-protocol replies.
 */
export type TerminalInput =
  | { readonly type: 'write'; readonly sequence: number; readonly data: string; readonly typed?: boolean }
  | { readonly type: 'resize'; readonly sequence: number; readonly cols: number; readonly rows: number }

/**
 * Every attachment begins with a complete bounded screen, then ordered output.
 * inputWindow is absent when the carrier has no encoded-frame inbox limit.
 */
export type TerminalFrame =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: WebTerminalInfo; readonly writable: boolean; readonly inputWindow?: RemoteUplinkWindow }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'state'; readonly info: WebTerminalInfo; readonly writable: boolean }
  | { readonly type: 'ack'; readonly sequence: number; readonly refusal?: 'read-only' | 'not-running' }
