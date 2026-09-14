/** One PTY, a bounded terminal emulator and its detachable browser followers. */
import { createRequire } from 'node:module'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { SerializeAddon as Serializer } from '@xterm/addon-serialize'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { TerminalFollower } from './stream.ts'
import type { TerminalAttachmentId, TerminalFrame, WebTerminalInfo } from './types.ts'

const { Terminal, SerializeAddon } = loadXterm()

function loadXterm() {
  // The Preview's CommonJS wrapper owns its outer require binding; these literal calls also retain the CJS entries.
  const require = createRequire(import.meta.url)
  const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')
  const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')
  return { Terminal, SerializeAddon }
}

/** Process lifetime is independent of follower and component lifetimes. */
export class BrowserTerminal {
  private readonly screen: HeadlessTerminal
  private readonly serializer: Serializer
  private readonly followers = new Set<TerminalFollower>()
  private sequence = 0
  private operations: Promise<unknown> = Promise.resolve()
  private readonly drained: Promise<void>
  private closing: Promise<void> | undefined
  private controller: { id: TerminalAttachmentId; follower: TerminalFollower } | undefined

  /**
   * @param handle - allocated terminal process range.
   * @param info - initial metadata.
   * @param scrollback - maximum retained scrollback rows.
   * @param maxBufferedBytes - per-follower queue cap.
   */
  constructor(
    private readonly handle: SubprocessTerminalHandle,
    public info: WebTerminalInfo,
    scrollback: number,
    private readonly maxBufferedBytes: number,
  ) {
    this.screen = new Terminal({ cols: info.cols, rows: info.rows, scrollback, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.screen.loadAddon(this.serializer)
    this.drained = this.consume()
  }

  /**
   * Attach with exclusive input control; an older attachment becomes read-only.
   * @param id - browser attachment identity.
   * @param signal - attachment cancellation; never terminates the process.
   * @returns a consistent screen followed by ordered output and state changes.
   */
  async *follow(id: TerminalAttachmentId, signal: AbortSignal): AsyncIterable<TerminalFrame> {
    signal.throwIfAborted()
    const follower = new TerminalFollower(this.maxBufferedBytes)
    const baseline = await this.enqueue(() => {
      signal.throwIfAborted()
      this.controller = { id, follower }
      this.info = { ...this.info, controllerId: id }
      this.broadcast({ type: 'state', info: this.info })
      const snapshot: TerminalFrame = { type: 'snapshot', sequence: this.sequence, screen: this.serializer.serialize(), info: this.info }
      this.followers.add(follower)
      return snapshot
    })
    try {
      yield baseline
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
      if (this.controller?.follower === follower) {
        this.controller = undefined
        const { controllerId: _controllerId, ...info } = this.info
        this.info = info
        this.broadcast({ type: 'state', info })
      }
    }
  }

  /**
   * Send raw terminal input without command interpretation.
   * @param id - current writable attachment.
   * @param data - UTF-8 input, including shell completion/control keys.
   * @returns when the provider accepts the input.
   */
  write(id: TerminalAttachmentId, data: string): Promise<void> {
    return this.enqueue(async () => { this.requireController(id); await this.handle.write(data) })
  }

  /**
   * Resize the PTY and recovery screen in the same operation order as output.
   * @param id - current writable attachment.
   * @param cols - validated column count.
   * @param rows - validated row count.
   * @returns when the provider and emulator use the new dimensions.
   */
  resize(id: TerminalAttachmentId, cols: number, rows: number): Promise<void> {
    return this.enqueue(async () => {
      this.requireController(id)
      await this.handle.resize(cols, rows)
      this.screen.resize(cols, rows)
      this.info = { ...this.info, cols, rows }
      this.broadcast({ type: 'state', info: this.info })
    })
  }

  /**
   * Publish a display name to every attached view.
   * @param title - validated user title.
   */
  rename(title: string): void {
    this.info = { ...this.info, title }
    this.broadcast({ type: 'state', info: this.info })
  }

  /**
   * Terminate the complete provider-owned process range before releasing its screen.
   * @returns after process cleanup and final output drainage; failures remain retryable.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      await this.handle.terminate()
      await this.drained
      for (const follower of this.followers) follower.finish()
      this.followers.clear()
      this.screen.dispose()
    })().catch((error: unknown) => { this.closing = undefined; throw error })
    return this.closing
  }

  private requireController(id: TerminalAttachmentId): void {
    if (this.closing !== undefined || this.info.state !== 'running') throw new RemoteError('terminal/control-unavailable', 'Terminal is not running', { reason: 'not-running' })
    if (this.controller?.id !== id) throw new RemoteError('terminal/control-unavailable', 'Terminal input is controlled by another attachment', { reason: 'read-only' })
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
    const outcome = this.handle.done.then(value => ({ value }), (error: unknown) => ({ error }))
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
    this.broadcast({ type: 'state', info: this.info })
  }

  private async output(data: string): Promise<void> {
    if (data.length === 0) return
    await this.enqueue(async () => {
      await new Promise<void>((resolve) => { this.screen.write(data, resolve) })
      this.broadcast({ type: 'output', sequence: ++this.sequence, data })
    })
  }
}
