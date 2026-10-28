/** Per-Agent byte connections to the per-user native screenshot process. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { Socket } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import type { NativeClientConfig, NativeChannel } from '@deepseek-ai/dsh-cua/native-client'
export type { NativeChannel } from '@deepseek-ai/dsh-cua/native-client'

const Ready = z.object({
  type: z.literal('ready'), protocol: z.literal(1), runtimeKey: z.string(),
  pid: z.number().int().positive(), instanceId: z.string().min(1),
}).strict()
const Refusal = z.object({ type: z.literal('error'), code: z.string().min(1), message: z.string() }).strict()
const handshakeByteLimit = 8192
type LauncherExit = [PromiseSettledResult<SubprocessOutcome>, PromiseSettledResult<boolean>]
interface RuntimeLocation { helperPath: string; runtimeKey: string; directory: string }


function transportError(code: string, message: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, { cause }), { code })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : transportError('NATIVE_CONNECT', 'Native connection failed', error)
}

async function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const cancelled = Promise.withResolvers<T>()
  const abort = (): void => { cancelled.reject(signal.reason) }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([operation, cancelled.promise]) }
  finally { signal.removeEventListener('abort', abort) }
}

class SharedNativeChannel implements NativeChannel {
  readonly stdin: Writable
  readonly stdout = new PassThrough()
  readonly done: Promise<void>
  private readonly ready = Promise.withResolvers<Socket>()
  private readonly closed: PromiseWithResolvers<void> = Promise.withResolvers()
  private readonly startup = new AbortController()
  private readonly startupTimer: ReturnType<typeof setTimeout>
  private launcher: SubprocessHandle | undefined
  private launcherExit: Promise<LauncherExit> | undefined
  private launcherFinished = false
  private socket: Socket | undefined
  private socketClosed: Promise<void> | undefined
  private connected = false
  private closing = false
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined
  private cleanupFailure: Error | undefined

  constructor(private readonly owner: { subprocess: Pick<SubprocessRuntime, 'spawn'> }, private readonly config: NativeClientConfig) {
    this.stdin = new Writable({
      write: (chunk: Buffer, encoding, callback) => {
        void this.ready.promise.then((socket) => {
          if (this.closing) callback(transportError('NATIVE_CLOSED', 'Native connection is closing'))
          else {
            try { socket.write(chunk, encoding, callback) }
            catch (error) { callback(asError(error)) }
          }
        }, callback)
      },
      final: (callback) => { this.close(); callback() },
      destroy: (error, callback) => { this.close(); callback(error) },
    })
    // Consumers can attach after construction; connection failures still settle done.
    this.stdin.on('error', () => {})
    this.stdout.on('error', () => {})
    void this.ready.promise.catch(() => {})
    void this.closed.promise.catch(() => {})
    this.startupTimer = setTimeout(() => {
      this.startup.abort(transportError('NATIVE_CONNECT_TIMEOUT', `Native connection exceeded ${config.connectTimeoutMs}ms`))
    }, config.connectTimeoutMs)
    this.done = this.run()
    void this.done.catch(() => {})
  }

  close(): void {
    if (this.closing) return
    this.closing = true
    clearTimeout(this.startupTimer)
    if (!this.connected) {
      this.startup.abort(transportError('NATIVE_CLOSED', 'Native connection closed before it became ready'))
      this.socket?.destroy()
      if (!this.launcherFinished) this.launcher?.terminate()
    } else {
      this.socket?.end()
      this.cleanupTimer = setTimeout(() => {
        this.cleanupFailure = transportError('NATIVE_CLEANUP', `Native connection did not finish cleanup within ${this.config.graceMs}ms`)
        this.socket?.destroy(this.cleanupFailure)
      }, this.config.graceMs)
    }
  }

  waitForClose(): Promise<void> { return this.closed.promise }

  private async run(): Promise<void> {
    let failure: Error | undefined
    try {
      const socket = await this.connect(await this.prepare())
      this.startup.signal.throwIfAborted()
      clearTimeout(this.startupTimer)
      this.connected = true
      this.ready.resolve(socket)
      await this.socketClosed
    } catch (error) {
      failure = asError(this.startup.signal.aborted ? this.startup.signal.reason : error)
      this.ready.reject(failure)
      if (!this.closing) this.stdout.destroy(failure)
    } finally {
      clearTimeout(this.startupTimer)
      clearTimeout(this.cleanupTimer)
      this.closing = true
      this.socket?.destroy()
      try { await this.cleanup() }
      catch (error) { this.cleanupFailure ??= asError(error) }
      this.stdin.destroy()
      if (this.cleanupFailure) {
        this.stdout.destroy(this.cleanupFailure)
        this.closed.reject(this.cleanupFailure)
      } else {
        this.stdout.end()
        this.closed.resolve()
      }
    }
    if (this.cleanupFailure) throw this.cleanupFailure
    if (failure) throw failure
  }

  private async prepare(): Promise<RuntimeLocation> {
    const helperPath = await realpath(this.config.helperPath)
    const runtimeKey = createHash('sha256').update(await readFile(helperPath, { signal: this.startup.signal })).digest('hex')
    const uid = userInfo().uid
    const directory = `/tmp/dsh-cua-${uid}`
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
      throw transportError('NATIVE_RUNTIME_DIRECTORY', 'Native runtime directory must be a real, owner-only directory owned by the current user')
    }
    return { helperPath, runtimeKey, directory }
  }

  private async ensureShared({ helperPath, runtimeKey, directory }: RuntimeLocation): Promise<void> {
    this.startup.signal.throwIfAborted()
    this.launcherFinished = false
    this.launcher = this.owner.subprocess.spawn({
      argv: [helperPath, '--ensure-shared', '--runtime-key', runtimeKey, '--runtime-directory', directory,
        '--startup-timeout-ms', String(this.config.connectTimeoutMs)],
      cwd: this.config.cwd, graceMs: this.config.graceMs, signal: this.startup.signal,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
    })
    this.launcherExit = Promise.allSettled([this.launcher.done, this.launcher.waitForExit()])
    const [outcome, range] = await untilAbort(this.launcherExit, this.startup.signal)
    this.launcherFinished = true
    if (range.status === 'rejected') throw range.reason
    if (!range.value) throw transportError('NATIVE_CLEANUP', 'Native launcher process range did not close')
    if (outcome.status === 'rejected') throw outcome.reason
    if (outcome.value.exitCode !== 0 || outcome.value.signal !== null) {
      const stdout = this.launcher.collected.stdout?.readFrom(0).text ?? ''
      let response: unknown
      try { response = JSON.parse(stdout) }
      catch (_error) { /* Missing or incomplete output uses the retained process diagnostics below. */ }
      const refusal = Refusal.safeParse(response)
      if (refusal.success) throw transportError(refusal.data.code, refusal.data.message)
      const stderr = this.launcher.collected.stderr?.readFrom(0).text ?? ''
      throw transportError('NATIVE_STARTUP', `Native launcher failed (exit ${outcome.value.exitCode}, signal ${outcome.value.signal})${stderr ? `: ${stderr}` : ''}`)
    }
  }

  private async connect(location: RuntimeLocation): Promise<Socket> {
    for (;;) {
      await this.ensureShared(location)
      const socket = await this.connectOnce(join(location.directory, `${location.runtimeKey}.sock`), location.runtimeKey)
      if (socket) return socket
      // A server can exit with its last client before admitting this connection.
      await delay(25, undefined, { signal: this.startup.signal })
    }
  }

  private async connectOnce(path: string, runtimeKey: string): Promise<Socket | undefined> {
    this.startup.signal.throwIfAborted()
    const socket = new Socket()
    this.socket = socket
    const handshake: PromiseWithResolvers<void> = Promise.withResolvers()
    const ended: PromiseWithResolvers<void> = Promise.withResolvers()
    this.socketClosed = ended.promise
    void ended.promise.catch(() => {})
    let peerEnded = false
    let socketError: Error | undefined
    let bytes = Buffer.alloc(0)
    const admission: { status: 'pending' | 'accepted' | 'refused' } = { status: 'pending' }
    const abort = (): void => { socket.destroy(asError(this.startup.signal.reason)) }
    this.startup.signal.addEventListener('abort', abort, { once: true })
    socket.on('error', (error: Error) => { socketError = error; handshake.reject(error) })
    socket.on('end', () => { peerEnded = true })
    socket.on('close', () => {
      this.startup.signal.removeEventListener('abort', abort)
      const error = socketError ?? (peerEnded ? undefined : transportError('NATIVE_EOF', 'Native socket closed without cleanup acknowledgement'))
      handshake.reject(error ?? transportError('NATIVE_EOF', 'Native socket ended before its handshake'))
      if (error) ended.reject(error)
      else ended.resolve()
    })
    socket.once('connect', () => {
      const { maxRequestBytes, maxResponseBytes, axTimeoutMs, textEventIntervalMs, maxClickHoldMs,
        screenshotTimeoutMs, timeoutMs, graceMs } = this.config
      socket.write(JSON.stringify({ type: 'hello', protocol: 1, runtimeKey,
        config: { maxRequestBytes, maxResponseBytes, axTimeoutMs, textEventIntervalMs, maxClickHoldMs, screenshotTimeoutMs, timeoutMs, graceMs } }) + '\n')
    })
    const receive = (chunk: Buffer): void => {
      const newline = chunk.indexOf(10)
      const length = newline < 0 ? chunk.length : newline + 1
      if (bytes.length + length > handshakeByteLimit) {
        admission.status = 'refused'
        socket.destroy(transportError('NATIVE_PROTOCOL', 'Native handshake exceeded its byte limit'))
        return
      }
      bytes = Buffer.concat([bytes, chunk.subarray(0, length)])
      if (newline < 0) return
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)))
        const refusal = Refusal.safeParse(value)
        if (refusal.success) {
          admission.status = 'refused'
          socket.destroy(transportError(refusal.data.code, refusal.data.message))
          return
        }
        const ready = Ready.parse(value)
        if (ready.runtimeKey !== runtimeKey) throw transportError('NATIVE_PROTOCOL', 'Native handshake returned a different runtime identity')
        admission.status = 'accepted'
        socket.removeListener('data', receive)
        this.startup.signal.removeEventListener('abort', abort)
        if (chunk.length > length) this.stdout.write(chunk.subarray(length))
        socket.pipe(this.stdout, { end: false })
        handshake.resolve()
      } catch (error) {
        admission.status = 'refused'
        socket.destroy(transportError('NATIVE_PROTOCOL', 'Native helper refused or returned an invalid handshake', error))
      }
    }
    socket.on('data', receive)
    socket.connect(path)
    try {
      await untilAbort(handshake.promise, this.startup.signal)
      return socket
    } catch (error) {
      socket.destroy()
      await ended.promise.catch(() => {})
      if (admission.status === 'pending' && error instanceof Error && 'code' in error
        && ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'NATIVE_EOF'].includes(String(error.code))) return undefined
      throw error
    } finally {
      if (admission.status !== 'accepted') socket.removeListener('data', receive)
    }
  }

  private async cleanup(): Promise<void> {
    if (!this.launcherFinished) this.launcher?.terminate()
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(transportError('NATIVE_CLEANUP', `Native startup cleanup exceeded ${this.config.graceMs}ms`))
    }, this.config.graceMs)
    try {
      const [, launcher] = await untilAbort(Promise.allSettled([
        Promise.resolve(this.socketClosed), Promise.resolve(this.launcherExit),
      ] as const), controller.signal)
      if (launcher.status === 'fulfilled' && launcher.value) {
        const range = launcher.value[1]
        if (range.status === 'rejected') throw range.reason
        if (!range.value) throw transportError('NATIVE_CLEANUP', 'Native launcher process range did not close')
      }
    } finally { clearTimeout(timer) }
  }
}

/**
 * Prepare or join the native process; writes wait for identity-checked readiness.
 * @param owner - Provider owning the short-lived native startup command.
 * @param config - Native runtime identity, operation limits and connection deadlines.
 * @returns One independently disposable Agent connection, without operation replay.
 */
export function createSharedNativeChannel(owner: { subprocess: Pick<SubprocessRuntime, 'spawn'> }, config: NativeClientConfig): NativeChannel {
  return new SharedNativeChannel(owner, config)
}
