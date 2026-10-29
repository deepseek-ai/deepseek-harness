/** Owner of the single tunnel worker process used by one DSH web process. */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdtempSync, type WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseTunnelWorkerEvent,
  type TunnelRequestToken,
  type TunnelRegistrationToken,
  type TunnelShareSpec,
  type TunnelWorkerCommand,
  type TunnelWorkerEvent,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import {
  INITIAL_RETRY_BACKOFF,
  RETRY_STABLE_MS,
  retryBackoffNext,
  retryBackoffSettled,
  type RetryBackoff,
} from '../owner-gateway/retry-backoff.ts'

/** A Node executable plus argv used to start the worker in source or built mode. */
export interface TunnelProcessCommand {
  readonly executable: string
  readonly args: readonly string[]
}

/** Owner commands acquire their registration identity in the supervisor, not in Host consumers. */
export type TunnelWorkerInput = TunnelWorkerCommand extends infer Command
  ? Command extends TunnelWorkerCommand ? Omit<Command, 'registrationToken'> : never
  : never

/** Runtime options for one owner-side worker. */
export interface TunnelWorkerOptions {
  readonly command: TunnelProcessCommand
}

/**
 * Own one long-lived tunnel process and multiplex all shares over IPC.
 * The worker is started lazily; commands issued before `ready` are queued.
 *
 * The process is supervised, not just launched: a worker that exits is replaced on the shared
 * reconnect schedule and every share the owner registered is handed to the replacement, so a crash
 * cannot leave a share offline that the owner never stopped sharing.
 */
export class TunnelWorker {
  private readonly listeners = new Set<(event: TunnelWorkerEvent) => void>()
  private readonly queue: TunnelWorkerCommand[] = []
  private readonly requests = new Map<TunnelRequestToken, Extract<TunnelWorkerEvent, { type: 'share-rpc-request' }>>()
  /**
   * Shares the current process is expected to carry: registered by the owner, then confirmed or
   * dropped by the worker's own events. A share that leaves this set is not necessarily forgotten —
   * `registrations` below is what the owner still holds.
   */
  private readonly shares = new Set<string>()
  /** Current add identity and latest committed Relay intent, retained across process replacements. */
  private readonly registrations = new Map<string, {
    spec: TunnelShareSpec
    registrationToken: TunnelRegistrationToken
    version: number | undefined
    connected: boolean
  }>()
  private child: ChildProcess | undefined
  private out: WriteStream | undefined
  private ready = false
  private stopping = false
  private aliveSince: number | undefined
  private backoff: RetryBackoff = INITIAL_RETRY_BACKOFF
  private restartTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: TunnelWorkerOptions) {}

  /** Start the worker and its private log file. */
  start(): void {
    if (this.stopping || this.child !== undefined) return
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const logDir = mkdtempSync(join(tmpdir(), 'liveshare-worker-'))
    this.out = createWriteStream(join(logDir, 'tunnel.log'), { flags: 'a', mode: 0o600 })
    const child = spawn(this.options.command.executable, [...this.options.command.args], {
      env: {
        NODE_ENV: process.env.NODE_ENV,
        LIVESHARE_TUNNEL_MODE: 'gateway',
        ...workerTransportEnv(process.env),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stdout?.pipe(this.out)
    child.stderr?.pipe(this.out)
    child.on('message', (value) => {
      if (this.child === child) this.onMessage(child, value)
    })
    child.on('spawn', () => {
      if (this.child === child) this.aliveSince = Date.now()
    })
    child.on('error', (error) => {
      if (this.child === child) this.onExit(error.message)
    })
    child.on('exit', (code, signal) => {
      if (this.child === child) this.onExit(`tunnel worker exited code=${String(code)} signal=${String(signal)}`)
    })
  }

  /**
   * Subscribe to worker lifecycle events.
   * @param listener Receives worker readiness, share, and failure events.
   * @returns Disposer that removes the listener.
   */
  onEvent(listener: (event: TunnelWorkerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Queue one command for the worker, starting it when necessary.
   *
   * The command is held until a worker can take it. While no process is running — before the first
   * start, or between a crash and its scheduled replacement — the restart replays the registration
   * set instead, which already carries this command's effect.
   * @param command Owner command to deliver after the worker is ready.
   * @returns Nothing.
   */
  send(command: TunnelWorkerInput): void {
    if (this.stopping) return
    if (command.type === 'share-rpc-response') {
      const request = this.requests.get(command.token)
      if (request === undefined || request.id !== command.id || request.shareId !== command.shareId
        || this.registrations.get(request.shareId)?.registrationToken !== request.registrationToken) return
      this.requests.delete(command.token)
      if (this.ready && this.child?.connected === true) {
        this.child.send({ ...command, registrationToken: request.registrationToken } satisfies TunnelWorkerCommand)
      }
      return
    }
    let ipc: TunnelWorkerCommand
    if (command.type === 'add-share') {
      this.cancelRequests(command.share.shareId)
      const registrationToken = randomUUID() as TunnelRegistrationToken
      ipc = { ...command, registrationToken }
      this.shares.add(command.share.shareId)
      this.registrations.set(command.share.shareId, { spec: command.share, registrationToken, version: undefined, connected: false })
    } else {
      ipc = command
    }
    if (command.type === 'remove-share') {
      this.cancelRequests(command.shareId)
      this.shares.delete(command.shareId)
      this.registrations.delete(command.shareId)
    }
    if (this.child === undefined || this.child.exitCode !== null || this.child.signalCode !== null) {
      this.queue.push(ipc)
      // A scheduled replacement flushes the queue when it arrives. With none pending — before the
      // first start, or after a crash left nothing to register — a worker starts now.
      if (this.restartTimer === undefined) this.start()
      return
    }
    if (this.ready && this.child.connected) {
      this.child.send(ipc)
    } else {
      this.queue.push(ipc)
    }
  }

  /** Stop accepting shares, cancel a pending restart, send shutdown, then kill a hung worker. */
  async stop(): Promise<void> {
    this.stopping = true
    this.cancelRequests()
    this.registrations.clear()
    this.queue.length = 0
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.child
    if (child === undefined) {
      this.out?.close()
      this.out = undefined
      return
    }
    const closed = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    if (child.connected) child.send({ type: 'shutdown' } satisfies TunnelWorkerCommand)
    const terminate = setTimeout(() => { child.kill('SIGTERM') }, 1_000)
    const kill = setTimeout(() => { child.kill('SIGKILL') }, 2_000)
    try {
      await closed
    } finally {
      clearTimeout(terminate)
      clearTimeout(kill)
    }
    this.child = undefined
    this.ready = false
    this.aliveSince = undefined
    this.shares.clear()
    this.queue.length = 0
    this.out?.close()
    this.out = undefined
  }

  private onMessage(child: ChildProcess, value: unknown): void {
    if (this.stopping || this.child !== child) return
    const event = parseTunnelWorkerEvent(value)
    if (event === undefined) {
      // An event this host does not read is otherwise indistinguishable from no event at all, which
      // is what makes a worker built from another release hard to diagnose from the owner side.
      const named = typeof value === 'object' && value !== null
        ? (value as { readonly type?: unknown }).type
        : undefined
      console.warn(`[liveshare] host dropped one worker event type=${typeof named === 'string' ? named : 'unnamed'}`)
      return
    }
    if (event.type !== 'ready'
      && this.registrations.get(event.shareId)?.registrationToken !== event.registrationToken) return
    if (event.type === 'share-access-state') {
      const registration = this.registrations.get(event.shareId)
      if (registration === undefined || !registration.connected
        || (registration.version !== undefined && registration.version >= event.version)) return
      const { expiresAt: _expiresAt, ...retained } = registration.spec
      registration.spec = {
        ...retained,
        accessMode: event.accessMode,
        allowedSubjectIds: event.allowedSubjectIds,
        sessionMode: event.sessionMode,
        // A Relay that states no switch states it off; the tier does not imply a fork grant.
        allowsFork: event.allowsFork === true,
        ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
      }
      registration.version = event.version
    } else if (event.type === 'share-rpc-request') {
      this.requests.set(event.token, event)
    } else if (event.type === 'share-rpc-cancel') {
      const request = this.requests.get(event.token)
      if (request === undefined || request.shareId !== event.shareId || request.id !== event.id
        || request.registrationToken !== event.registrationToken) return
      this.requests.delete(event.token)
    }
    if (event.type === 'share-connected') {
      this.shares.add(event.shareId)
      const registration = this.registrationOf(event.shareId)
      registration.connected = true
      registration.version = undefined
    } else if (event.type === 'share-error' || event.type === 'share-closed') {
      const registration = this.registrationOf(event.shareId)
      registration.connected = false
      registration.version = undefined
      // Socket loss invalidates authority but not the retained intent used by a replacement.
      if (event.type === 'share-error') this.shares.delete(event.shareId)
    }
    this.emit(event)
  }

  private onExit(message: string): void {
    /* v8 ignore next -- an exit report is delivered only for the current child, and the first report clears it. */
    if (this.child === undefined) return
    this.child = undefined
    this.ready = false
    if (this.aliveSince !== undefined && Date.now() - this.aliveSince >= RETRY_STABLE_MS) {
      this.backoff = retryBackoffSettled()
    }
    this.aliveSince = undefined
    for (const registration of this.registrations.values()) {
      registration.connected = false
      registration.version = undefined
    }
    this.cancelRequests()
    if (this.stopping) return
    this.queue.length = 0
    for (const [shareId, registration] of this.registrations) {
      this.emit({ type: 'share-error', registrationToken: registration.registrationToken, shareId, message })
    }
    // A worker carrying no share has nothing to repair, so it stays down until a command arrives.
    if (this.registrations.size > 0) this.scheduleRestart()
  }

  /** Replace the exited process after the scheduled delay, re-registering the owner's shares. */
  private scheduleRestart(): void {
    /* v8 ignore next -- only the current child's exit calls this, and stop() cancels a pending replacement. */
    if (this.stopping || this.child !== undefined || this.restartTimer !== undefined) return
    const delayMs = this.backoff.delayMs
    this.backoff = retryBackoffNext(this.backoff)
    console.warn(
      `[liveshare] restarting tunnel worker delayMs=${String(delayMs)}`
      + ` attempt=${String(this.backoff.attempt)} shares=${String(this.registrations.size)}`,
    )
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      /* v8 ignore next -- stop() clears this timer and start() clears it before spawning a replacement. */
      if (this.stopping || this.child !== undefined) return
      this.replayRegistrations()
      this.start()
    }, delayMs)
  }

  /**
   * Hand every registered share to the process about to start.
   *
   * The registration set is the owner's current intent, so it replaces any `add-share` still queued
   * from before the crash: that command's spec may already be superseded, and a share the owner
   * removed in the meantime is no longer in the set at all.
   */
  /** The registration the token guard above already matched for one non-ready event. */
  private registrationOf(shareId: string): {
    spec: TunnelShareSpec
    registrationToken: TunnelRegistrationToken
    version: number | undefined
    connected: boolean
  } {
    const registration = this.registrations.get(shareId)
    /* v8 ignore next -- the IPC token guard returned unless this share is registered. */
    if (registration === undefined) throw new Error('liveshare: worker event for an unregistered share')
    return registration
  }

  private replayRegistrations(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index]?.type === 'add-share') this.queue.splice(index, 1)
    }
    for (const registration of this.registrations.values()) {
      this.queue.push({ type: 'add-share', registrationToken: registration.registrationToken, share: registration.spec })
    }
  }

  private cancelRequests(shareId?: string): void {
    const requests = [...this.requests.values()].filter(request => shareId === undefined || request.shareId === shareId)
    for (const request of requests) this.requests.delete(request.token)
    for (const request of requests) {
      this.emit({ type: 'share-rpc-cancel', registrationToken: request.registrationToken, token: request.token, id: request.id, shareId: request.shareId })
    }
  }

  private emit(event: TunnelWorkerEvent): void {
    if (event.type === 'ready') {
      this.ready = true
      for (const command of this.queue.splice(0)) {
        if (this.child?.connected === true) this.child.send(command)
      }
    }
    for (const listener of this.listeners) listener(event)
  }
}

/**
 * Transport settings the worker's own TLS and proxy handling reads from the environment.
 *
 * The worker is a separate process, so a deployment that reaches its Relay through a private CA or
 * an explicit proxy has to pass those settings on: without them the worker rejects a Relay the Host
 * itself already reaches, and the failure looks like an unreachable address.
 */
const WORKER_TRANSPORT_ENV = [
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const

/**
 * Select the worker's inherited transport settings.
 * @param source - Environment of the Host process that starts the worker.
 * @returns Entries the worker needs to resolve and trust the Relay address.
 */
function workerTransportEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const forwarded: NodeJS.ProcessEnv = {}
  for (const name of WORKER_TRANSPORT_ENV) {
    const value = source[name]
    if (value !== undefined && value !== '') forwarded[name] = value
  }
  return forwarded
}
