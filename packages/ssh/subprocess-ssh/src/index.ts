/** Remote subprocess and PTY handles with independent SSH streams and helper-owned process lifetimes. */
import { Duplex, PassThrough, type Readable, type Writable } from 'node:stream'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessOutputMode, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalEnvironment, SubprocessTerminalSignal, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import type { SshConnection } from '@deepseek-ai/dsh-ssh'
import { doneSchema, foregroundSchema, terminalActivitySchema, outputSnapshotFrameLimit, outputSnapshotSchema, preparedSchema, remotePath, streamEndpointSchema } from '@deepseek-ai/dsh-ssh/schemas'
import type { SshProcessId } from '@deepseek-ai/dsh-ssh/schemas'
import { SshRpcPeer, RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { z } from 'zod'

function environment(env?: NodeJS.ProcessEnv): Record<string, string | null> | undefined {
  return env === undefined ? undefined : Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null]))
}

class RemoteCleanupError extends AggregateError {}

/** One remote ordinary process; stdin and control remain usable during asynchronous SSH allocation. */
class RemoteProcess implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly control: Duplex | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  readonly streamsClosed: Promise<void>
  private readonly inbound = new PassThrough()
  private readonly out = new PassThrough()
  private readonly err = new PassThrough()
  private readonly toControl = new PassThrough()
  private readonly fromControl = new PassThrough()
  private readonly controller = new AbortController()
  private readonly started: Promise<void>
  private id: SshProcessId | undefined
  private sockets: Socket[] = []
  private quiescent = false
  private committed = false
  private termination: Promise<void> | undefined
  private readonly detachAbort: () => void
  private spills: { stdout?: string | undefined; stderr?: string | undefined } = {}
  private readonly updateCollection: Partial<Record<'stdout' | 'stderr', (snapshot: { tail: string; totalBytes: number }, final: boolean) => void>> = {}

  constructor(private readonly ssh: SshConnection, private readonly spec: SubprocessSpawnSpec) {
    this.stdin = spec.stdio.stdin === 'pipe' ? this.inbound : undefined
    this.stdout = spec.stdio.stdout === 'pipe' ? this.out : undefined
    this.stderr = spec.stdio.stderr === 'pipe' ? this.err : undefined
    const requestedControl = (spec.stdio as typeof spec.stdio & { control?: 'pipe' }).control
    this.control = requestedControl === undefined ? undefined : Duplex.from({ writable: this.toControl, readable: this.fromControl })
    for (const stream of [this.inbound, this.out, this.err, this.toControl, this.fromControl, this.control]) stream?.on('error', () => {})
    const collect = (name: 'stdout' | 'stderr', stream: PassThrough, mode: SubprocessOutputMode) => {
      if (mode === 'pipe') return undefined
      if (mode === 'inherit') { stream.pipe(name === 'stdout' ? process.stdout : process.stderr, { end: false }); return undefined }
      let collector = new OutputCollector(mode.maxBytes, undefined, name, '')
      let base = 0
      let total = 0
      let finalized = false
      this.updateCollection[name] = (snapshot, final): void => {
        const bytes = Buffer.from(snapshot.tail, 'base64')
        if (bytes.length > mode.maxBytes || snapshot.totalBytes < bytes.length) throw new Error('SSH helper returned invalid collected output coordinates')
        if (finalized) return
        if (snapshot.totalBytes < total) throw new Error('SSH helper rewound collected output')
        finalized = final
        collector = new OutputCollector(mode.maxBytes, undefined, name, '')
        collector.push(bytes)
        base = snapshot.totalBytes - bytes.length
        total = snapshot.totalBytes
      }
      return {
        readFrom: (offset: number) => {
          const snapshot = collector.readFrom(offset - base)
          return {
            ...snapshot, nextOffset: snapshot.nextOffset + base,
            ...(this.spills[name] === undefined ? {} : { spillPath: this.spills[name] }),
          }
        },
      }
    }
    const stdout = collect('stdout', this.out, spec.stdio.stdout)
    const stderr = collect('stderr', this.err, spec.stdio.stderr)
    this.collected = { ...(stdout === undefined ? {} : { stdout }), ...(stderr === undefined ? {} : { stderr }) }
    const onAbort = (): void => { this.terminate() }
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    this.detachAbort = () => { spec.signal?.removeEventListener('abort', onAbort) }
    this.started = this.start()
    this.streamsClosed = this.started.then(async () => {
      await Promise.all(this.sockets.map(socket => socket.closed ? Promise.resolve() : new Promise<void>((resolve) => {
        socket.once('close', () => { resolve() })
      })))
    }, () => {})
    this.done = this.started.then(async () => {
      const result = await ssh.request('process.done', { id: this.id }, doneSchema, undefined, true)
      await this.drainOutput()
      this.spills = result.spills
      for (const name of ['stdout', 'stderr'] as const) {
        const snapshot = result.collected[name]
        const finish = this.updateCollection[name]
        if ((snapshot === undefined) !== (finish === undefined)) throw new Error('SSH helper returned mismatched output collection modes')
        if (snapshot !== undefined) finish?.(snapshot, true)
      }
      return { exitCode: result.outcome.exitCode, signal: result.outcome.signal as NodeJS.Signals | null }
    }).catch((error: unknown) => {
      this.terminate()
      for (const socket of this.sockets) socket.destroy()
      for (const stream of [this.inbound, this.out, this.err, this.toControl, this.fromControl]) {
        stream.destroy(error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    })
    void this.done.catch(() => {})
  }

  private async start(): Promise<void> {
    this.spec.signal?.throwIfAborted()
    const prepared = await this.ssh.request(
      'process.prepare', { ...this.spec, signal: undefined, env: environment(this.spec.env) }, preparedSchema, this.controller.signal,
    )
    this.id = prepared.id
    try {
      const sockets = await Promise.all(Object.entries(prepared.streams).map(async ([name, path]) =>
        [name, await this.ssh.connectStream(path, this.controller.signal)] as const))
      this.sockets = sockets.map(([, socket]) => socket)
      for (const [name, socket] of sockets) {
        if (name === 'stdout' || name === 'stderr') {
          const mode = this.spec.stdio[name]
          if (typeof mode === 'object') {
            new SshRpcPeer(socket, socket, outputSnapshotFrameLimit(mode.maxBytes), 1, (method, raw) => Promise.resolve().then(() => {
              if (method !== 'snapshot') throw new Error('Unexpected SSH output-stream operation')
              this.updateCollection[name]?.(outputSnapshotSchema.parse(raw), false)
              return null
            }))
          } else {
            socket.end()
            const output = name === 'stdout' ? this.out : this.err
            const closeSocket = (): void => { socket.destroy() }
            output.once('close', closeSocket)
            socket.once('close', () => { output.off('close', closeSocket) })
            if (output.destroyed) closeSocket()
            else socket.pipe(output)
          }
        }
        if (name === 'stdin') this.inbound.pipe(socket)
        if (name === 'control') { this.toControl.pipe(socket); socket.pipe(this.fromControl) }
      }
      this.controller.signal.throwIfAborted()
      await this.ssh.request('process.start', { id: this.id }, z.object({}).strict(), this.controller.signal)
      this.committed = true
    } catch (error) {
      this.terminate()
      await this.termination?.catch(() => {})
      for (const socket of this.sockets) socket.destroy()
      throw error
    }
  }

  terminate(): void {
    if (this.quiescent || this.termination !== undefined) return
    if (!this.committed) this.controller.abort(new Error('SSH process terminated before launch acknowledgement'))
    if (this.id !== undefined) {
      this.termination = this.ssh.request('process.terminate', { id: this.id }, z.null()).then(() => {
        this.quiescent = true
        this.detachAbort()
      }).catch((error: unknown) => {
        // A connection unable to confirm termination must release its helper lease.
        void this.ssh.dispose().catch(() => {})
        throw error
      })
      void this.termination.catch(() => {})
    }
  }

  closeStreams(): void {
    for (const socket of this.sockets) socket.destroy()
    for (const stream of [this.inbound, this.out, this.err, this.toControl, this.fromControl, this.control]) stream?.destroy()
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.quiescent) return true
    if (signal?.aborted) return false
    if (signal === undefined) return this.observeExit()
    const cancelled = Promise.withResolvers<boolean>()
    const abort = (): void => { cancelled.resolve(false) }
    signal.addEventListener('abort', abort, { once: true })
    try { return await Promise.race([this.observeExit(signal), cancelled.promise]) }
    finally { signal.removeEventListener('abort', abort) }
  }

  private async observeExit(signal?: AbortSignal): Promise<boolean> {
    try { await this.started } catch {
      // Startup errors remain on done; a prepared process must first finish termination.
      if (this.termination !== undefined) await this.termination
      this.quiescent = true
      this.detachAbort()
      return true
    }
    if (this.termination !== undefined) { await this.termination; return true }
    const result = await this.ssh.request('process.wait', { id: this.id }, z.boolean(), signal, true)
    if (result) { this.quiescent = true; this.detachAbort() }
    return result
  }

  private async drainOutput(): Promise<void> {
    const disposers: Array<() => void> = []
    const outputs = (['stdout', 'stderr'] as const).map((name) => {
      if (typeof this.spec.stdio[name] === 'object') return Promise.resolve()
      const stream = name === 'stdout' ? this.out : this.err
      if (stream.readableEnded || stream.destroyed) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const done = (): void => { resolve() }
        for (const event of ['end', 'close', 'error']) stream.once(event, done)
        disposers.push(() => { for (const event of ['end', 'close', 'error']) stream.off(event, done) })
      })
    })
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.all(outputs),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.spec.graceMs) }),
      ])
    } finally {
      clearTimeout(timer)
      for (const dispose of disposers) dispose()
    }
  }
}

/** SSH provider paired with the SSH filesystem; the remote helper selects POSIX process ownership. */
export class SshSubprocessRuntime extends SubprocessRuntime {
  static inject = ['ssh']
  private readonly live = new Set<RemoteProcess>()
  private readonly terminals = new Set<SubprocessTerminalHandle>()
  private readonly terminalAllocations = new Set<Promise<SubprocessTerminalHandle>>()
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('SSH subprocess provider disposed'))
      for (const handle of this.live) handle.terminate()
      const results = await Promise.allSettled([
        ...[...this.live].map(async (handle) => {
          try { await handle.waitForExit() } finally { handle.closeStreams() }
        }),
        ...[...this.terminalAllocations].map(allocation => allocation.catch((error: unknown) => {
          if (error instanceof RemoteCleanupError) throw error
        })),
        ...[...this.terminals].map(handle => handle.terminate()),
      ])
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (errors.length > 0) throw new AggregateError(errors, 'SSH process cleanup could not be confirmed')
    })
  }

  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    try {
      return await this.ctx.ssh.request('executable', { command, env }, remotePath, signal)
    } catch (error) {
      if (error instanceof RemoteOperationError && error.code === 'SUBPROCESS_EXECUTABLE_NOT_FOUND') {
        throw new SubprocessExecutableNotFoundError(error.message, { cause: error })
      }
      throw error
    }
  }

  override terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    return this.ctx.ssh.request('terminal.environment', {}, z.object({
      platform: z.enum(['posix', 'windows']), defaultShell: z.string().optional(),
    }).strict().transform(value => ({ platform: value.platform,
      ...(value.defaultShell === undefined ? {} : { defaultShell: value.defaultShell }),
    })), signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.lifetime.signal.throwIfAborted()
    spec.signal?.throwIfAborted()
    const handle = new RemoteProcess(this.ctx.ssh, spec)
    this.live.add(handle)
    void handle.done.then(() => handle.waitForExit()).then(() => handle.streamsClosed)
      .then(() => { this.live.delete(handle) }).catch(() => {})
    return handle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    this.lifetime.signal.throwIfAborted()
    const signal = spec.signal === undefined ? this.lifetime.signal : AbortSignal.any([spec.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const allocation = this.createTerminal(spec, signal)
    this.terminalAllocations.add(allocation)
    try { return await allocation } finally { this.terminalAllocations.delete(allocation) }
  }

  private async createTerminal(spec: SubprocessTerminalSpawnSpec, signal: AbortSignal): Promise<SubprocessTerminalHandle> {
    const ssh = this.ctx.ssh
    const prepared = await ssh.request('process.prepare', {
      argv: spec.argv, cwd: spec.cwd, env: environment(spec.env), graceMs: spec.graceMs,
      terminal: { rows: spec.rows, cols: spec.cols, terminalType: spec.terminalType, shellActivity: spec.shellActivity },
    }, preparedSchema, signal)
    const id = prepared.id
    let socket: Socket | undefined
    try {
      signal.throwIfAborted()
      socket = await ssh.connectStream(streamEndpointSchema.parse(prepared.streams.terminal), signal)
      signal.throwIfAborted()
      socket.end()
      const output = new PassThrough()
      socket.pipe(output)
      const started = await ssh.request('process.start', { id }, z.object({ pid: z.number().int().positive() }).strict(), signal)
      signal.throwIfAborted()
      const done = ssh.request('process.done', { id }, doneSchema, undefined, true).then(result => ({ exitCode: result.outcome.exitCode, signal: result.outcome.signal as NodeJS.Signals | null }))
      void done.catch(() => {})
      let closing: Promise<void> | undefined
      const abort = (): void => { void handle.terminate().catch(() => { void ssh.dispose().catch(() => {}) }) }
      const handle: SubprocessTerminalHandle = {
        pid: started.pid, output, done,
        resize: async (cols, rows) => { await ssh.request('terminal.resize', { id, cols, rows }, z.null()) },
        write: async (data) => { await ssh.request('terminal.write', { id, value: data }, z.null()) },
        inspectForeground: async () => await ssh.request('terminal.inspect', { id }, foregroundSchema) ?? undefined,
        inspectActivity: () => ssh.request('terminal.activity', { id }, terminalActivitySchema),
        signalForeground: (signal: SubprocessTerminalSignal) => ssh.request('terminal.signal', { id, value: signal }, z.number().int().positive()),
        terminate: () => {
          closing ??= ssh.request('process.terminate', { id }, z.null(), undefined, true).then(() => {
            socket?.destroy()
            output.destroy()
            signal.removeEventListener('abort', abort)
            this.terminals.delete(handle)
          }).catch((error: unknown) => { closing = undefined; throw error })
          return closing
        },
      }
      signal.addEventListener('abort', abort, { once: true })
      this.terminals.add(handle)
      return handle
    } catch (error) {
      socket?.destroy()
      try { await ssh.request('process.terminate', { id }, z.null()) } catch (cleanupError) {
        void ssh.dispose().catch(() => {})
        throw new RemoteCleanupError([error, cleanupError], 'SSH terminal allocation failed and remote cleanup is unknown')
      }
      throw error
    }
  }
}

export default SshSubprocessRuntime
