/** One PTY, a bounded terminal emulator and its detachable browser followers. */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteError, remoteErrorOf, type RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { SerializeAddon as Serializer } from '@xterm/addon-serialize'
import type { SubprocessTerminalActivity, SubprocessTerminalForeground, SubprocessTerminalHandle, SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import { AgentTerminalError } from './agent.ts'
import { cursorLineStart, lastContentRow, pageLines, renderLines } from './screen.ts'
import { TerminalFollower } from './stream.ts'
import { TerminalRetention, type TerminalRetentionPolicy } from './retention.ts'
import type {
  TerminalEnvironment, TerminalInput, TerminalFrame, TerminalRetentionFrame, TerminalScreenMark, TerminalScreenPage,
  TerminalScreenRequest, WebTerminalInfo,
} from './types.ts'

const requireHeadless = createLazyRequire<typeof import('@xterm/headless')>('@xterm/headless', import.meta.url)
const requireSerialize = createLazyRequire<typeof import('@xterm/addon-serialize')>('@xterm/addon-serialize', import.meta.url)

/** Process lifetime is independent of follower and component lifetimes. */
export class BrowserTerminal {
  private readonly screen: HeadlessTerminal
  private readonly serializer: Serializer
  private readonly followers = new Set<TerminalFollower>()
  private sequence = 0
  private operations: Promise<unknown> = Promise.resolve()
  private readonly drained: Promise<void>
  /** Provider completion precedes output drainage and the published exit state. */
  private exited = false
  private closing: Promise<void> | undefined
  private screenDisposed = false
  private retention: TerminalRetention | undefined
  private controller: TerminalFollower | undefined
  private changes = 0
  private readonly waiters = new Set<() => void>()
  private stateListener: (() => void) | undefined

  /**
   * @param handle - allocated terminal process range.
   * @param info - initial metadata.
   * @param scrollback - maximum retained scrollback rows.
   * @param maxBufferedBytes - per-follower queue cap.
   * @param release - removes files the launch created once the process has ended; it must not throw.
   */
  constructor(
    private readonly handle: SubprocessTerminalHandle,
    public info: WebTerminalInfo,
    scrollback: number,
    private readonly maxBufferedBytes: number,
    private readonly release: () => Promise<void> = () => Promise.resolve(),
  ) {
    const { Terminal } = requireHeadless()
    const { SerializeAddon } = requireSerialize()
    this.screen = new Terminal({ cols: info.cols, rows: info.rows, scrollback, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.screen.loadAddon(this.serializer)
    this.drained = this.consume()
  }

  /**
   * Start monitoring after this allocation is committed to its Session owner.
   * @param policy - validated Host timing policy.
   * @param closing - closes the id before any asynchronous termination.
   * @param closed - removes the exact successfully terminated owner record.
   * @param failed - diagnostic sink for background cleanup failure.
   */
  monitor(policy: TerminalRetentionPolicy, closing: () => void, closed: () => void, failed: (error: unknown) => void): void {
    this.retention = new TerminalRetention(policy, () => this.handle.inspectActivity(), async () => {
      closing()
      await this.closeProcess()
      closed()
    }, failed)
  }

  /**
   * Retain this committed process independently of output attachment.
   * @param signal - physical window stream lifetime.
   * @returns its hold acknowledgement and lifetime.
   */
  retain(signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    if (this.retention === undefined) throw new Error('Terminal has not been committed')
    return this.retention.retain(signal)
  }

  /**
   * Attach with exclusive input control; older attachments keep receiving output.
   * @param input - Gateway-decoded commands; returning its iterator must interrupt pending reads.
   * @param limits - input byte and PTY dimension limits validated at the Remote boundary.
   * @param signal - attachment cancellation; never terminates the process.
   * @param inputWindow - carrier frame capacity; absent for a carrier without an encoded-frame inbox limit.
   * @returns a screen baseline, output, per-attachment state and ordered command acknowledgements.
   */
  async *attach(input: AsyncIterable<TerminalInput>, limits: Pick<TerminalEnvironment, 'maxInputBytes' | 'maxCols' | 'maxRows'>, signal: AbortSignal, inputWindow?: RemoteUplinkWindow): AsyncIterable<TerminalFrame> {
    signal.throwIfAborted()
    const follower = new TerminalFollower(this.maxBufferedBytes)
    const baseline = await this.enqueue(() => {
      signal.throwIfAborted()
      this.controller = follower
      this.broadcastState()
      const snapshot: TerminalFrame = { type: 'snapshot', sequence: this.sequence, screen: this.serializer.serialize(), info: this.info, writable: this.writable(follower), ...inputWindow === undefined ? {} : { inputWindow } }
      this.followers.add(follower)
      return snapshot
    })
    const uplink = input[Symbol.asyncIterator]()
    const commands = this.consumeInput(uplink, follower, limits, signal).catch((error: unknown) => {
      follower.fail(error instanceof Error ? error : new Error(String(error)))
    })
    try {
      yield baseline
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
      if (this.controller === follower) {
        this.controller = undefined
        this.broadcastState()
      }
      // Gateway's uplink return wakes pending reads before attachment cleanup joins the input pump.
      await uplink.return?.()
      await commands
    }
  }

  private async consumeInput(input: AsyncIterator<TerminalInput>, follower: TerminalFollower, limits: Pick<TerminalEnvironment, 'maxInputBytes' | 'maxCols' | 'maxRows'>, signal: AbortSignal): Promise<void> {
    let sequence = 0
    while (true) {
      const next = await input.next()
      if (next.done === true || signal.aborted || !follower.active) return
      const command = next.value
      if (!Number.isSafeInteger(command.sequence) || command.sequence !== ++sequence) throw new Error('Terminal input sequence has a gap')
      try {
        await this.enqueue(async () => {
          signal.throwIfAborted()
          this.requireController(follower)
          switch (command.type) {
            case 'write':
              if (Buffer.byteLength(command.data, 'utf8') > limits.maxInputBytes) throw new Error('Terminal input exceeds the configured limit')
              // Control passes before the write so queued agent input cannot follow the person's keystrokes.
              if (command.typed === true && this.info.control === 'agent') {
                this.info = { ...this.info, control: 'user' }
                this.broadcastState()
              }
              this.retention?.invalidate()
              await this.handle.write(command.data)
              break
            case 'resize':
              if (!Number.isSafeInteger(command.cols) || command.cols < 2 || command.cols > limits.maxCols
                || !Number.isSafeInteger(command.rows) || command.rows < 1 || command.rows > limits.maxRows) throw new Error('Terminal dimensions exceed the configured limits')
              await this.handle.resize(command.cols, command.rows)
              this.screen.resize(command.cols, command.rows)
              this.info = { ...this.info, cols: command.cols, rows: command.rows }
              this.broadcastState()
              break
            /* v8 ignore next -- the Gateway codec validates this closed union. */
            default: assertNever(command)
          }
        })
        follower.push({ type: 'ack', sequence })
      } catch (error) {
        const failure = remoteErrorOf(error)
        if (failure?.code === 'terminal/control-unavailable') {
          follower.push({ type: 'ack', sequence, refusal: failure.details.reason })
        } else if (this.exited) {
          follower.push({ type: 'ack', sequence, refusal: 'not-running' })
        } else throw error
      }
    }
  }

  private writable(follower: TerminalFollower): boolean {
    return !this.exited && this.closing === undefined && this.info.state === 'running' && this.controller === follower
  }

  private broadcastState(): void {
    for (const follower of this.followers) follower.push({ type: 'state', info: this.info, writable: this.writable(follower) })
    this.advance()
    this.stateListener?.()
  }

  /**
   * Set the one listener that reports published state changes to the owner's roster; a later call replaces it.
   * @param listener - called after each state publication; it must not throw.
   */
  setStateListener(listener: () => void): void { this.stateListener = listener }

  /**
   * Observe shell lifecycle without interpreting output.
   * @returns idle, busy, or unknown for unsupported shells and incomplete observations.
   */
  async inspectActivity(): Promise<SubprocessTerminalActivity['state']> {
    return (await this.handle.inspectActivity()).state
  }

  /** Top-level terminal process id reported by the provider. */
  get pid(): number { return this.handle.pid }

  /** Advances after each applied output chunk and each published state change. */
  get revision(): number { return this.changes }

  /**
   * Wait until output or state changes after a known revision.
   * @param after - revision the caller has observed.
   * @param signal - wait cancellation.
   * @returns the current revision, which exceeds `after`.
   */
  async changed(after: number, signal: AbortSignal): Promise<number> {
    while (this.changes <= after) {
      signal.throwIfAborted()
      // Abort only wakes the wait; the loop rethrows the caller's exact reason.
      await new Promise<void>((resolve) => {
        const wake = (): void => { signal.removeEventListener('abort', wake); this.waiters.delete(wake); resolve() }
        this.waiters.add(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    }
    return this.changes
  }

  private advance(): void {
    this.changes++
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const wake of waiters) wake()
  }

  /**
   * Write agent input in order with browser input and output.
   * @param data - text delivered without implicit newline conversion.
   * @returns after the provider accepts the input.
   * @throws AgentTerminalError when the user controls the terminal or it is not running.
   */
  agentWrite(data: string): Promise<void> {
    return this.enqueue(async () => {
      this.requireAgentControl()
      this.retention?.invalidate()
      await this.handle.write(data)
    })
  }

  /**
   * Deliver a signal to the foreground process group on the agent's behalf.
   * @param signal - permitted terminal signal.
   * @returns the process group that received it.
   * @throws AgentTerminalError when the user controls the terminal or it is not running.
   */
  agentSignal(signal: SubprocessTerminalSignal): Promise<number> {
    return this.enqueue(async () => {
      this.requireAgentControl()
      this.retention?.invalidate()
      return this.handle.signalForeground(signal)
    })
  }

  /**
   * Inspect the foreground process group without changing input control.
   * @returns the group and its input-wait fact, or undefined when the provider cannot resolve one.
   */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return this.handle.inspectForeground()
  }

  /**
   * Wait until output received before the call, and input queued before it, are applied.
   * @returns after the queued work settles, whether or not it failed.
   */
  async drain(): Promise<void> {
    await this.enqueue(() => undefined)
  }

  /**
   * Render a newest-relative page of the screen as applied so far; {@link drain} first to include received output.
   * @param request - page position and byte bound.
   * @returns rendered text; alternate-screen applications return their current screen.
   * @throws AgentTerminalError after the screen is released.
   */
  readScreen(request: TerminalScreenRequest): TerminalScreenPage {
    this.requireScreen()
    const buffer = this.screen.buffer.active
    return pageLines(renderLines(buffer, 0, lastContentRow(buffer) + 1), request)
  }

  /**
   * Mark the start of the cursor's logical line on the screen as applied so far; {@link drain} first to place it after received output.
   * @returns a mark whose lines begin with that logical line; a change of active buffer renders the whole new buffer.
   * @throws AgentTerminalError after the screen is released.
   */
  markScreen(): TerminalScreenMark {
    this.requireScreen()
    const buffer = this.screen.buffer.active
    const marked = buffer.type
    const marker = this.screen.registerMarker(cursorLineStart(buffer) - buffer.baseY - buffer.cursorY)
    return {
      lines: () => {
        this.requireScreen()
        const active = this.screen.buffer.active
        const end = lastContentRow(active) + 1
        if (active.type !== marked || marker === undefined) return { lines: renderLines(active, 0, end), truncated: false }
        if (marker.isDisposed) return { lines: renderLines(active, 0, end), truncated: true }
        return { lines: renderLines(active, marker.line, end), truncated: false }
      },
      dispose: () => { marker?.dispose() },
    }
  }

  private requireAgentControl(): void {
    if (this.exited || this.closing !== undefined || this.info.state !== 'running') throw new AgentTerminalError('not-running', 'The terminal is not running')
    if (this.info.control !== 'agent') throw new AgentTerminalError('user-control', 'The user has taken over this terminal')
  }

  /** Whether closing released the screen; reads and marks then fail. */
  get screenReleased(): boolean { return this.screenDisposed }

  private requireScreen(): void {
    if (this.screenDisposed) throw new AgentTerminalError('unavailable', 'The terminal was closed')
  }

  /**
   * Publish a display name to every attached view.
   * @param title - validated user title.
   */
  rename(title: string): void {
    this.info = { ...this.info, title }
    this.broadcastState()
  }

  /**
   * Terminate the complete provider-owned process range before releasing its screen.
   * @returns after process cleanup and final output drainage; failures remain retryable.
   */
  close(): Promise<void> {
    return this.retention?.close() ?? this.closeProcess()
  }

  /**
   * Stop unattended cleanup scheduling and await final process cleanup.
   * @returns after terminal and monitor quiescence.
   */
  dispose(): Promise<void> { return this.retention?.dispose() ?? this.closeProcess() }

  private closeProcess(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      await this.handle.terminate()
      await this.drained
      await this.release()
      for (const follower of this.followers) follower.finish()
      this.followers.clear()
      this.screenDisposed = true
      this.screen.dispose()
    })().catch((error: unknown) => { this.closing = undefined; throw error })
    return this.closing
  }

  private requireController(follower: TerminalFollower): void {
    if (this.exited || this.closing !== undefined || this.info.state !== 'running') throw new RemoteError('terminal/control-unavailable', 'Terminal is not running', { reason: 'not-running' })
    if (this.controller !== follower || !follower.active) throw new RemoteError('terminal/control-unavailable', 'Terminal input is controlled by another attachment', { reason: 'read-only' })
  }

  private broadcast(frame: TerminalFrame): void {
    for (const follower of this.followers) follower.push(frame)
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.operations.then(operation)
    this.operations = pending.catch(() => { /* The caller owns this operation's failure; later cleanup must still run. */ })
    return pending
  }

  private async consume(): Promise<void> {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    const outcome = this.handle.done.then((value) => { this.exited = true; return { value } }, (error: unknown) => ({ error }))
    try {
      for await (const chunk of this.handle.output) {
        // Node Readable's iterator is untyped; this provider explicitly emits Buffer chunks.
        const data = decoder.decode(chunk as Buffer, { stream: true })
        await this.output(data)
      }
      await this.output(decoder.decode())
      const result = await outcome
      if ('error' in result) throw result.error
      this.info = { ...this.info, state: 'exited', exitCode: result.value.exitCode }
    } catch (error) {
      this.info = { ...this.info, state: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    this.broadcastState()
  }

  private async output(data: string): Promise<void> {
    if (data.length === 0) return
    await this.enqueue(async () => {
      await new Promise<void>((resolve) => { this.screen.write(data, resolve) })
      this.broadcast({ type: 'output', sequence: ++this.sequence, data })
      this.advance()
    })
  }
}
