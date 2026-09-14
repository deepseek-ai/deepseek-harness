/** React-free browser terminal state and reconnecting Remote-stream ownership. */
import { preferredShell, rememberShell } from './shell-preference.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteStreamCarrierError, type ClientRemote, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError, remoteErrorOf, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TerminalShell, TerminalAttachmentId, TerminalEnvironment, TerminalFrame,
  WebTerminalId, WebTerminalInfo,
} from '../types.ts'

/** The generated terminal namespace's browser-facing operations. */
export type TerminalRemote = ClientRemote['terminal']

/** Product error identifiers translated by the terminal UI. */
export type TerminalViewIssue = 'missingTerminal' | 'inputFull' | 'attachmentEnded' | 'invalidOutput' | 'terminalLimit'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Client terminal failure preserved through the Remote stream supervisor. */
    'terminal/view': { readonly issue: TerminalViewIssue }
  }
}

class TerminalViewError extends RemoteError<'terminal/view'> {
  constructor(issue: TerminalViewIssue, message: string = issue) { super('terminal/view', message, { issue }) }
}

/** One screen write awaiting the DOM emulator's callback. */
export interface TerminalRenderFrame {
  readonly revision: number
  readonly frame: Extract<TerminalFrame, { type: 'snapshot' | 'output' }>
}

/** Observable state of one sidebar occurrence. */
export interface TerminalViewState {
  readonly phase: 'idle' | 'loading' | 'selecting' | 'creating' | 'connecting' | 'connected' | 'disconnected' | 'closing' | 'closed' | 'failed'
  readonly shells?: readonly TerminalShell[] | undefined
  readonly selectedShell?: string | undefined
  readonly environment?: TerminalEnvironment | undefined
  readonly title?: string | undefined
  readonly info?: WebTerminalInfo | undefined
  readonly writable: boolean
  readonly render?: TerminalRenderFrame | undefined
  readonly error?: string | undefined
  readonly issue?: TerminalViewIssue | undefined
}

/** A view survives DOM unmount; its process only ends on explicit close. */
export class TerminalView {
  /** Observable controls, process metadata and the next screen update awaiting acknowledgement. */
  readonly state: SnapshotStore<TerminalViewState> = createSnapshotStore<TerminalViewState>({ phase: 'idle', writable: false })
  private readonly lifetime = new AbortController()
  private stream: RemoteStream<TerminalFrame> | undefined
  private mounted = false
  private attachmentId: TerminalAttachmentId | undefined
  private pendingRender: { revision: number; resolve: () => void } | undefined
  private revision = 0
  private creation: Promise<void> | undefined
  private loading: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private writes: Promise<void> = Promise.resolve()
  private queuedInput = 0
  private readonly detaching = new Set<Promise<void>>()

  /**
   * @param sessionId - Session owning the terminal.
   * @param remote - typed terminal Remote operations.
   * @param gateway - reconnecting stream factory.
   * @param id - Host terminal identity, reused when recovering an item from its Session list.
   * @param createWhenMissing - allow allocation only for a new tab, never a listed terminal.
   */
  constructor(
    private readonly sessionId: SessionId,
    private readonly remote: TerminalRemote,
    private readonly gateway: Pick<ClientRemote, '$stream'>,
    readonly id: WebTerminalId,
    private readonly createWhenMissing = true,
  ) {}

  /**
   * Attach the DOM lifetime, loading shell choices or reconnecting the saved process.
   * @returns a detach callback that leaves the terminal process alive.
   */
  mount(): () => void {
    this.mounted = true
    if (this.state.getSnapshot().info === undefined) void this.refresh()
    else this.connect()
    return () => {
      this.mounted = false
      this.detach()
    }
  }

  /**
   * Start or recover this tab, deduplicating mounts and retries during allocation.
   * Only a new tab may allocate a shell; listed terminals cannot be silently replaced.
   * @returns after environment lookup and creation or recovery settle.
   */
  refresh(): Promise<void> {
    if (this.creation !== undefined) return this.creation
    if (this.loading !== undefined) return this.loading
    if (this.closing !== undefined || this.lifetime.signal.aborted) return Promise.resolve()
    this.patch({ phase: 'loading', error: undefined, issue: undefined })
    this.loading = (async () => {
      const [environment, available] = await Promise.all([
        this.remote.environment(this.sessionId, this.lifetime.signal), this.remote.list(this.sessionId),
      ])
      if (this.stopped()) return
      this.patch({ environment: valueOf(environment) })
      const info = valueOf(available).find(item => item.id === this.id)
      if (info !== undefined) this.adopt(info)
      else if (this.createWhenMissing) {
        const shells = valueOf(await this.remote.shells(this.sessionId, this.lifetime.signal))
        if (this.stopped()) return
        const previous = this.state.getSnapshot().selectedShell ?? preferredShell()
        const selectedShell = shells.find(shell => shell.path === previous)?.path ?? shells[0]?.path
        this.patch({ phase: 'selecting', shells, selectedShell })
      }
      else throw new TerminalViewError('missingTerminal')
    })().catch((error: unknown) => { this.fail(error) }).finally(() => { this.loading = undefined })
    return this.loading
  }

  /**
   * Select and remember one verified shell before starting the terminal.
   * @param path - executable path offered by Host discovery.
   */
  selectShell(path: string): void {
    const state = this.state.getSnapshot()
    if (state.phase === 'selecting' && state.shells?.some(shell => shell.path === path)) {
      this.patch({ selectedShell: path })
      rememberShell(path)
    }
  }

  /**
   * Start the selected shell once; failed attempts retain their selection for retry.
   * @returns after allocation settles; failures are exposed in observable state.
   */
  start(): Promise<void> {
    if (this.creation !== undefined) return this.creation
    const state = this.state.getSnapshot()
    if (state.phase !== 'selecting' || state.environment === undefined || state.selectedShell === undefined
      || this.closing !== undefined || this.lifetime.signal.aborted) return Promise.resolve()
    rememberShell(state.selectedShell)
    return this.create(state.environment, state.selectedShell)
  }

  private stopped(): boolean { return this.lifetime.signal.aborted || this.closing !== undefined }

  private async create(environment: TerminalEnvironment, shellPath: string): Promise<void> {
    this.patch({ phase: 'creating', error: undefined, issue: undefined })
    this.creation = (async () => {
      const info = valueOf(await this.remote.create(this.sessionId, {
        id: this.id, shellPath, cols: Math.min(80, environment.maxCols), rows: Math.min(24, environment.maxRows),
      }, this.lifetime.signal))
      if (!this.lifetime.signal.aborted) {
        this.adopt(info)
      }
    })().catch((error: unknown) => { this.fail(error) }).finally(() => { this.creation = undefined })
    await this.creation
  }

  private adopt(info: WebTerminalInfo): void {
    this.patch({ info, title: info.title })
    if (this.mounted && this.closing === undefined) this.connect()
  }

  /** Reattach with a fresh screen and regain input control. */
  connect(): void {
    const info = this.state.getSnapshot().info
    if (info === undefined || !this.mounted || this.closing !== undefined || this.lifetime.signal.aborted) return
    this.detach()
    const stream = this.gateway.$stream<TerminalFrame>({
      name: 'Browser terminal output',
      open: (signal) => {
        const attachmentId = randomUUID() as TerminalAttachmentId
        this.attachmentId = attachmentId
        return this.remote.follow(this.sessionId, info.id, attachmentId, signal)
      },
      ended: () => new TerminalViewError('attachmentEnded'),
      carrierFailed: () => { if (this.stream === stream) this.patch({ phase: 'disconnected', writable: false }) },
    })
    this.stream = stream
    this.patch({ phase: 'connecting', writable: false, error: undefined, issue: undefined, render: undefined })
    void this.consume(stream)
  }

  /**
   * Release the next stream item after xterm has parsed this frame.
   * @param revision - locally delivered render revision.
   */
  acknowledge(revision: number): void {
    if (this.pendingRender?.revision !== revision) return
    this.pendingRender.resolve()
    this.pendingRender = undefined
  }

  /**
   * Serialize raw input so concurrent RPC requests cannot reorder keystrokes.
   * @param data - input from the terminal emulator.
   */
  write(data: string): void {
    const state = this.state.getSnapshot()
    const attachmentId = this.attachmentId
    if (!state.writable || state.info === undefined || attachmentId === undefined) return
    const bytes = new TextEncoder().encode(data).byteLength
    if (this.queuedInput + bytes > (state.environment?.maxInputBytes ?? 0)) { this.fail(new TerminalViewError('inputFull')); return }
    this.queuedInput += bytes
    const id = state.info.id
    this.writes = this.writes.then(async () => {
      if (this.attachmentId !== attachmentId || !this.state.getSnapshot().writable) return
      valueOf(await this.remote.write(this.sessionId, id, attachmentId, data))
    }).catch((error: unknown) => { if (this.attachmentId === attachmentId) this.fail(error) }).finally(() => { this.queuedInput -= bytes })
  }

  /**
   * Resize only from the currently writable view.
   * @param cols - measured column count.
   * @param rows - measured row count.
   */
  resize(cols: number, rows: number): void {
    const state = this.state.getSnapshot()
    const attachmentId = this.attachmentId
    if (!state.writable || state.info === undefined || attachmentId === undefined) return
    if (state.info.cols === cols && state.info.rows === rows) return
    const id = state.info.id
    cols = Math.min(cols, state.environment?.maxCols ?? cols)
    rows = Math.min(rows, state.environment?.maxRows ?? rows)
    this.writes = this.writes.then(async () => {
      if (this.attachmentId !== attachmentId || !this.state.getSnapshot().writable) return
      valueOf(await this.remote.resize(this.sessionId, id, attachmentId, cols, rows))
    }).catch((error: unknown) => { if (this.attachmentId === attachmentId) this.fail(error) })
  }

  /**
   * Update the Host terminal's display name.
   * @param title - user-entered terminal title.
   * @returns after the rename settles and its result is reflected in view state.
   */
  async rename(title: string): Promise<void> {
    if (title.trim() === this.state.getSnapshot().title || this.lifetime.signal.aborted) return
    try {
      valueOf(await this.remote.rename(this.sessionId, this.id, title))
      const current = this.state.getSnapshot().info
      this.patch({ ...(current === undefined ? {} : { info: { ...current, title: title.trim() } }), title: title.trim() })
    } catch (error) { this.fail(error) }
  }

  /**
   * Explicitly terminate this view's process independently of its DOM lifetime.
   * @returns after Host process cleanup succeeds; failures remain retryable by the owner.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.patch({ phase: 'closing', writable: false, error: undefined, issue: undefined })
    this.detach()
    this.closing = (async () => {
      // Even a refused or lost creation response may leave an allocation to close.
      await this.creation
      valueOf(await this.remote.close(this.sessionId, this.id))
      this.detach()
      this.patch({ phase: 'closed', writable: false })
    })().catch((error: unknown) => { this.closing = undefined; this.fail(error); throw error })
    return this.closing
  }

  /**
   * Stop Client work on plugin unload without closing Host terminals.
   * @returns after active and previously detached stream iterators have closed.
   */
  async dispose(): Promise<void> {
    this.mounted = false
    this.lifetime.abort()
    this.detach()
    await Promise.all(this.detaching)
  }

  private detach(): void {
    const previous = this.stream
    this.stream = undefined
    this.attachmentId = undefined
    this.pendingRender?.resolve()
    this.pendingRender = undefined
    if (previous !== undefined) {
      const cleanup = previous.dispose().finally(() => { this.detaching.delete(cleanup) })
      this.detaching.add(cleanup)
    }
  }

  private async consume(stream: RemoteStream<TerminalFrame>): Promise<void> {
    let generation = 0
    let sequence = 0
    try {
      for await (const item of stream) {
        if (this.stream !== stream) return
        const frame = item.value
        if (generation !== item.generation) {
          if (frame.type !== 'snapshot') throw new TerminalViewError('invalidOutput', 'Terminal output generation is missing its screen snapshot')
          generation = item.generation
          sequence = frame.sequence
          item.accept()
        } else if (frame.type === 'output') {
          if (frame.sequence !== sequence + 1) throw new TerminalViewError('invalidOutput', 'Terminal output sequence has a gap')
          sequence = frame.sequence
        } else if (frame.type === 'snapshot') throw new TerminalViewError('invalidOutput', 'Unexpected terminal screen snapshot')
        if (frame.type !== 'output') {
          this.patch({ info: frame.info, title: frame.info.title, phase: 'connected', writable: frame.info.state === 'running' && frame.info.controllerId === this.attachmentId })
        }
        if (frame.type !== 'state') {
          const revision = ++this.revision
          await new Promise<void>((resolve) => {
            this.pendingRender = { revision, resolve }
            const aborted = (): void => { this.acknowledge(revision) }
            item.signal.addEventListener('abort', aborted, { once: true })
            this.pendingRender.resolve = () => { item.signal.removeEventListener('abort', aborted); resolve() }
            this.patch({ render: { revision, frame } })
            if (item.signal.aborted) aborted()
          })
        }
      }
    } catch (error) {
      if (this.stream === stream) {
        if (this.state.getSnapshot().info?.state === 'exited') this.patch({ phase: 'closed', writable: false })
        else this.fail(error)
      }
    }
  }

  private patch(patch: Partial<TerminalViewState>): void {
    if (this.lifetime.signal.aborted) return
    this.state.set({ ...this.state.getSnapshot(), ...patch })
  }

  private fail(error: unknown): void {
    const failure = remoteErrorOf(error)
    if (failure?.code === 'terminal/control-unavailable') {
      this.patch({ writable: false, error: undefined, issue: undefined })
      return
    }
    const issue = failure?.code === 'terminal/view' ? failure.details.issue : failure?.code === 'terminal/limit-reached' ? 'terminalLimit' : undefined
    this.patch({ phase: error instanceof RemoteStreamCarrierError ? 'disconnected' : 'failed', writable: false, issue, error: error instanceof Error ? error.message : String(error) })
  }
}

function valueOf<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}
