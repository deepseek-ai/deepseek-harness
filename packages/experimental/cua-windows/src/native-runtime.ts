/** Host-owned connector and independently disposable Agent connections to a shared Windows helper. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { addAbortListener } from 'node:events'
import { realpath } from 'node:fs/promises'
import { PassThrough, Writable, type Readable, type Duplex } from 'node:stream'
import assert from 'node:assert/strict'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { NativeError, type NativeChannel, type NativeClientConfig } from '@deepseek-ai/dsh-cua/native-client'
import { z } from 'zod'
import { connectWindowsPipe, type WindowsConnection, type WindowsTransport } from './native-transport.ts'

const Ready = z.object({
  type: z.literal('ready'), protocol: z.literal(1), runtimeKey: z.string().min(1), instanceId: z.string().min(1),
})
const Started = Ready.extend({ endpoint: z.string().min(1), launcherId: z.string().min(1) })
// Private transport control frames have fixed encoding; operation replies pass through unchanged.
const closedFrame = Buffer.from('{"type":"closed"}\n')
type Owner = { subprocess: Pick<SubprocessRuntime, 'spawn'> }

function failure(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)) }

async function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const cancelled = Promise.withResolvers<T>()
  using _listener = addAbortListener(signal, () => { cancelled.reject(signal.reason) })
  return await Promise.race([operation, cancelled.promise])
}

function firstFrame(stream: Readable, signal: AbortSignal): Promise<{ value: unknown; rest: Buffer }> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0)
    const clean = () => {
      stream.off('data', data).off('error', rejectFrame).off('end', ended).off('close', ended)
      signal.removeEventListener('abort', aborted)
    }
    const rejectFrame = (error: Error) => { clean(); reject(error) }
    const ended = () => { rejectFrame(new NativeError('NATIVE_EOF', 'Helper ended before native readiness')) }
    const aborted = () => { rejectFrame(failure(signal.reason)) }
    const data = (chunk: Buffer) => {
      const newline = chunk.indexOf(10)
      const size = newline < 0 ? chunk.length : newline + 1
      if (bytes.length + size > 8192) { rejectFrame(new NativeError('NATIVE_PROTOCOL', 'Native readiness exceeded its byte limit')); return }
      bytes = Buffer.concat([bytes, chunk.subarray(0, size)])
      if (newline < 0) return
      stream.pause()
      clean()
      try {
        resolve({ value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1))), rest: chunk.subarray(size) })
      } catch (error) { reject(new NativeError('NATIVE_PROTOCOL', 'Invalid native readiness frame', { cause: error })) }
    }
    stream.on('data', data).on('error', rejectFrame).on('end', ended).on('close', ended)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

class WindowsHelper {
  readonly ready: Promise<z.infer<typeof Started>>
  readonly done: Promise<void>
  readonly sockets = new Set<Duplex>()
  private readonly readiness = Promise.withResolvers<z.infer<typeof Started>>()
  private readonly startup = new AbortController()
  private handle: SubprocessHandle | undefined
  private phase: 'starting' | 'ready' | 'closing' | 'closed' = 'starting'
  private stopTimer: ReturnType<typeof setTimeout> | undefined
  private error: Error | undefined

  constructor(private readonly owner: Owner, private readonly config: NativeClientConfig) {
    this.ready = this.readiness.promise
    void this.ready.catch(() => {})
    this.done = this.run()
    void this.done.catch(() => {})
  }

  get ended(): boolean { return this.phase === 'closing' || this.phase === 'closed' }

  async stop(): Promise<void> {
    if (!this.ended) {
      this.phase = 'closing'
      this.startup.abort(new NativeError('NATIVE_CLOSED', 'Computer Use is shutting down'))
      this.handle?.stdin?.end()
      this.stopTimer = setTimeout(() => { this.handle?.terminate() }, this.config.graceMs)
    }
    await this.done
  }

  private async run(): Promise<void> {
    const startupTimer = setTimeout(() => {
      this.startup.abort(new NativeError('NATIVE_CONNECT_TIMEOUT', 'Windows helper did not become ready before connectTimeoutMs; check helper diagnostics and Windows application-control policy'))
    }, this.config.connectTimeoutMs)
    try {
      const helperPath = await realpath(this.config.helperPath)
      const digest = createHash('sha256')
      for await (const chunk of createReadStream(helperPath, { signal: this.startup.signal })) digest.update(chunk as Buffer)
      const runtimeKey = digest.digest('hex')
      const instanceId = randomUUID().replaceAll('-', '')
      this.startup.signal.throwIfAborted()
      const handle = this.owner.subprocess.spawn({
        argv: [helperPath, '--serve', '--instance-id', instanceId, '--runtime-key', runtimeKey,
          '--connect-timeout-ms', String(this.config.connectTimeoutMs), '--grace-ms', String(this.config.graceMs)],
        cwd: this.config.cwd, graceMs: this.config.graceMs,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65_536 } },
      })
      this.handle = handle
      assert(handle.stdin && handle.stdout, 'The helper requested piped control and readiness streams')
      handle.stdout.on('error', (error: Error) => { this.error ??= error; this.startup.abort(error) })
      const exit = handle.done.then((outcome) => {
        const diagnostic = handle.collected.stderr?.readFrom(0).text.trim() || 'no diagnostic output'
        throw new NativeError('NATIVE_EXITED',
          `Windows helper exited before readiness (${String(outcome.exitCode)}): ${diagnostic}. Check Windows application-control policy and helper signing.`)
      })
      let frame: Awaited<ReturnType<typeof firstFrame>>
      try { frame = await Promise.race([firstFrame(handle.stdout, this.startup.signal), exit]) } catch (error) {
        // EOF can precede process settlement and its final collected stderr.
        if (error instanceof NativeError && error.code === 'NATIVE_EOF') await interruptible(exit, this.startup.signal)
        throw error
      }
      const ready = Started.parse(frame.value)
      if (ready.runtimeKey !== runtimeKey || ready.launcherId !== instanceId || frame.rest.length !== 0)
        throw new NativeError('NATIVE_PROTOCOL', 'Windows helper readiness has another identity or unexpected output')
      this.startup.signal.throwIfAborted()
      handle.stdout.on('data', () => {
        this.error ??= new NativeError('NATIVE_PROTOCOL', 'Windows helper wrote unsolicited readiness data')
        void this.stop().catch((error: unknown) => { this.error ??= failure(error) })
      })
      handle.stdout.resume()
      clearTimeout(startupTimer)
      this.phase = 'ready'
      this.readiness.resolve(ready)
      const outcome = await handle.done
      if (!this.ended) this.error ??= new NativeError('NATIVE_EXITED',
        `Windows helper stopped (${String(outcome.exitCode)}, ${String(outcome.signal)}); select applications again`)
    } catch (error) { this.error ??= failure(error) }
    finally {
      clearTimeout(startupTimer)
      this.phase = 'closing'
      const error = this.error ?? new NativeError('NATIVE_CLOSED', 'Windows helper closed; select applications again')
      for (const socket of this.sockets) socket.destroy(error)
      const handle = this.handle
      try {
        if (handle) {
          handle.stdin?.end()
          const timer = setTimeout(() => { handle.terminate() }, this.config.graceMs)
          try {
            await handle.done
            if (!await handle.waitForExit()) throw new NativeError('NATIVE_CLEANUP', 'Windows helper process range did not exit')
          } finally { clearTimeout(timer) }
        }
      } finally {
        clearTimeout(this.stopTimer)
        this.phase = 'closed'
        this.readiness.reject(error)
      }
    }
  }
}

class WindowsChannel implements NativeChannel {
  readonly stdout = new PassThrough()
  readonly stdin: Writable
  readonly done: Promise<void>
  private readonly startup = new AbortController()
  private readonly readiness = Promise.withResolvers<Duplex>()
  private readonly closed: PromiseWithResolvers<void> = Promise.withResolvers()
  private socket: Duplex | undefined
  private closing = false
  private closeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(helper: Promise<WindowsHelper>, config: NativeClientConfig, pollIntervalMs: number,
    owner: Owner, transport: WindowsTransport) {
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        void this.readiness.promise.then((socket) => {
          if (this.closing) { callback(new NativeError('NATIVE_CLOSED', 'Native connection is closing')); return }
          socket.write(chunk, callback)
        }, callback)
      },
      final: (callback) => { this.close(); callback() },
      destroy: (error, callback) => { this.close(); callback(error) },
    })
    for (const stream of [this.stdin, this.stdout]) stream.on('error', () => {})
    void this.readiness.promise.catch(() => {})
    void this.closed.promise.catch(() => {})
    this.done = this.run(helper, config, pollIntervalMs, owner, transport)
    void this.done.catch(() => {})
  }

  close(): void {
    if (this.closing) return
    this.closing = true
    this.startup.abort(new NativeError('NATIVE_CLOSED', 'Native connection closed before readiness'))
    if (this.socket && !this.socket.destroyed) this.socket.write('{"type":"close"}\n')
  }

  waitForClose(): Promise<void> { return this.closed.promise }

  private async run(helperPromise: Promise<WindowsHelper>, config: NativeClientConfig, pollIntervalMs: number,
    owner: Owner, transport: WindowsTransport): Promise<void> {
    let helper: WindowsHelper | undefined
    let connection: WindowsConnection | undefined
    let closed: Promise<void> | undefined
    let caught: Error | undefined
    let admitted = false
    const observation = { acknowledged: false }
    const timer = setTimeout(() => {
      this.startup.abort(new NativeError('NATIVE_CONNECT_TIMEOUT', 'Windows native connection exceeded connectTimeoutMs; check helper diagnostics and Windows application-control policy'))
    }, config.connectTimeoutMs)
    try {
      helper = await interruptible(helperPromise, this.startup.signal)
      const ready = await interruptible(helper.ready, this.startup.signal)
      this.startup.signal.throwIfAborted()
      connection = connectWindowsPipe(owner.subprocess, config, ready.endpoint, ready.runtimeKey, transport)
      const socket = connection.stream
      this.socket = socket
      helper.sockets.add(socket)
      let socketError: Error | undefined
      closed = new Promise<void>((resolve, reject) => {
        socket.on('error', (error: Error) => { socketError = error })
        socket.on('close', () => {
          if (socketError) reject(socketError)
          else if (!observation.acknowledged) reject(new NativeError('NATIVE_EOF', 'Windows pipe closed without cleanup acknowledgement'))
          else resolve()
        })
      })
      void closed.catch(() => {})
      const abort = () => { socket.destroy(failure(this.startup.signal.reason)) }
      this.startup.signal.addEventListener('abort', abort, { once: true })
      try {
        const frame = firstFrame(socket, this.startup.signal)
        void frame.catch(() => {})
        await connection.connected
        this.startup.signal.throwIfAborted()
        {
          const { maxRequestBytes, maxResponseBytes, axTimeoutMs, textEventIntervalMs,
            screenshotTimeoutMs, timeoutMs, graceMs, maxClickHoldMs } = config
          socket.write(JSON.stringify({ type: 'hello', protocol: 1, runtimeKey: ready.runtimeKey,
            config: { maxRequestBytes, maxResponseBytes, axTimeoutMs, textEventIntervalMs, screenshotTimeoutMs, timeoutMs, graceMs, pollIntervalMs, maxClickHoldMs } }) + '\n')
        }
        const response = await frame
        const accepted = Ready.parse(response.value)
        if (accepted.runtimeKey !== ready.runtimeKey || accepted.instanceId !== ready.instanceId)
          throw new NativeError('NATIVE_PROTOCOL', 'Windows pipe belongs to another helper instance')
        this.startup.signal.throwIfAborted()
        admitted = true
        this.startup.signal.removeEventListener('abort', abort)
        clearTimeout(timer)
        const close = () => {
          this.closeTimer ??= setTimeout(() => { socket.destroy(new NativeError('NATIVE_CLEANUP', 'Windows pipe did not acknowledge cleanup')) }, config.graceMs)
        }
        this.startup.signal.addEventListener('abort', close, { once: true })
        let prefix: Buffer | undefined = Buffer.alloc(0)
        const receive = (chunk: Buffer) => {
          let offset = 0
          while (offset < chunk.length) {
            const newline = chunk.indexOf(10, offset)
            const end = newline < 0 ? chunk.length : newline + 1
            const piece = chunk.subarray(offset, end)
            if (prefix !== undefined) prefix = prefix.length + piece.length <= closedFrame.length
              ? Buffer.concat([prefix, piece]) : undefined
            if (newline >= 0) {
              if (prefix?.equals(closedFrame)) {
                if (!this.closing) {
                  socket.destroy(new NativeError('NATIVE_PROTOCOL', 'Unexpected Windows cleanup acknowledgement'))
                  return
                }
                observation.acknowledged = true
              }
              prefix = Buffer.alloc(0)
            }
            offset = end
          }
          if (!this.closing) this.stdout.write(chunk)
        }
        socket.on('data', receive)
        if (response.rest.length !== 0) receive(response.rest)
        socket.resume()
        this.readiness.resolve(socket)
        try { await closed } finally { this.startup.signal.removeEventListener('abort', close) }
      } finally { this.startup.signal.removeEventListener('abort', abort) }
    } catch (error) {
      const cause = failure(error)
      if (!this.closing || admitted) caught = cause
      this.readiness.reject(cause)
    }
    finally {
      clearTimeout(timer)
      clearTimeout(this.closeTimer)
      this.closing = true
      this.socket?.destroy()
      if (closed) {
        try { await closed } catch (error) { if (admitted) caught ??= failure(error) }
      }
      if (this.socket) helper?.sockets.delete(this.socket)
      let cleanupError: Error | undefined
      try { await connection?.dispose() } catch (error) { cleanupError = failure(error); caught ??= cleanupError }
      if (admitted && !observation.acknowledged) {
        cleanupError = new NativeError('NATIVE_CLEANUP', 'Windows pipe ended without native cleanup acknowledgement')
      }
      this.stdin.destroy()
      if (caught) this.stdout.destroy(caught)
      else this.stdout.end()
      if (cleanupError) this.closed.reject(cleanupError)
      else this.closed.resolve()
    }
    if (caught) throw caught
  }
}

/** One provider owns a service lease; Agent connections own only their application and snapshot state. */
export class WindowsNativeRuntime {
  private helper: WindowsHelper | undefined
  private disposal: Promise<void> | undefined
  private readonly channels = new Set<WindowsChannel>()

  /**
   * @param owner Managed subprocess provider.
   * @param pollIntervalMs Clipboard and application-readiness polling interval.
   * @param transport Resolved native Windows or WSL connection method.
   */
  constructor(private readonly owner: Owner, private readonly pollIntervalMs: number, private readonly transport: WindowsTransport = 'pipe') {}

  /**
   * Connect one Agent without transferring process ownership to that Agent.
   * @param config Executable identity and per-connection limits.
   * @returns The byte stream used by the shared native request client.
   */
  connect(config: NativeClientConfig): NativeChannel {
    if (this.disposal) throw new NativeError('NATIVE_CLOSED', 'Windows Computer Use is disposed')
    const acquire = async () => {
      if (this.helper?.ended) await this.helper.done
      if (this.disposal) throw new NativeError('NATIVE_CLOSED', 'Windows Computer Use is disposed')
      if (!this.helper || this.helper.ended) this.helper = new WindowsHelper(this.owner, config)
      return this.helper
    }
    const channel = new WindowsChannel(acquire(), config, this.pollIntervalMs, this.owner, this.transport)
    this.channels.add(channel)
    void channel.done.then(() => this.channels.delete(channel), () => this.channels.delete(channel))
    return channel
  }

  /** Close Agent pipes and join this Host's connector; other Hosts retain their service leases. */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      for (const channel of this.channels) channel.close()
      const channels = await Promise.allSettled([...this.channels].map(channel => channel.waitForClose()))
      let processError: unknown
      try { await this.helper?.stop() } catch (error) { processError = error }
      const errors: unknown[] = []
      for (const result of channels) { if (result.status === 'rejected') errors.push(result.reason) }
      if (processError !== undefined) errors.push(processError)
      if (errors.length) throw new AggregateError(errors, 'Windows Computer Use cleanup failed')
    })()
  }
}
