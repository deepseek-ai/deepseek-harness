import { type Awaitable, Time } from '@deepseek-ai/cosmokit'
import { Context, FiberState } from '@deepseek-ai/cordis'
import type { Bot } from './bot.ts'
import { Status, type WebSocket } from './protocol.ts'
import z from '@deepseek-ai/schemastery'

export interface WsClientConfig {
  retryLazy: number
  retryTimes: number
  retryInterval: number
}

export const WsClientConfig: z<WsClientConfig> = z.object({
  retryTimes: z.natural().description('初次连接时的最大重试次数。').default(6),
  retryInterval: z.natural().role('ms').description('初次连接时的重试时间间隔。').default(5 * Time.second),
  retryLazy: z.natural().role('ms').description('连接关闭后的重试时间间隔。').default(Time.minute),
}).description('连接设置')

export abstract class WsClientBase<B extends Bot = Bot> {
  protected socket?: WebSocket
  private controller?: AbortController
  private retry?: ReturnType<typeof setTimeout>
  private readonly pending = new Set<Promise<void>>()

  protected abstract prepare(signal: AbortSignal): Awaitable<WebSocket>
  protected abstract accept(socket: WebSocket, signal: AbortSignal): Awaitable<void>
  protected abstract getActive(): boolean
  protected abstract setStatus(status: Status, error?: Error): void

  constructor(public ctx: Context, public bot: B, public config: WsClientConfig) {
    ctx.effect(() => () => this.stop())
  }

  protected track(task: Promise<void>) {
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task)).catch(error => this.ctx.logger.error(error))
  }

  async start() {
    const stopped = this.stop()
    const controller = this.controller = new AbortController()
    await stopped
    if (this.controller !== controller || !this.getActive()
      || [FiberState.UNLOADING, FiberState.DISPOSED].includes(this.ctx.fiber.state)) return
    let established = false
    const { signal } = controller
    let retryCount = 0
    const logger = this.ctx.logger('adapter')
    const { retryTimes, retryInterval, retryLazy } = this.config
    const active = () => !signal.aborted && this.getActive()

    const reconnect = (initial: boolean, error: Error) => {
      if (!active() || this.retry) return
      if (initial && retryCount >= retryTimes) {
        this.setStatus(Status.OFFLINE, error)
        return
      }
      const delay = retryCount++ >= retryTimes ? retryLazy : retryInterval
      this.setStatus(Status.RECONNECT, error)
      logger.warn('websocket disconnected; retry in %s: %s', Time.format(delay), error.message)
      this.retry = setTimeout(() => {
        this.retry = undefined
        if (active()) this.track(connect(initial))
      }, delay)
    }

    const connect = async (initial: boolean) => {
      let socket: WebSocket
      try {
        socket = await this.prepare(signal)
      } catch (error) {
        reconnect(initial, error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (!active()) {
        socket.close(1000, 'adapter stopped')
        return
      }
      this.socket = socket
      const connection = new AbortController()
      const abort = () => connection.abort(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      socket.addEventListener('error', () => {
        if (active()) logger.warn('websocket transport error')
      })
      socket.addEventListener('close', ({ code }) => {
        connection.abort(new Error('websocket closed'))
        signal.removeEventListener('abort', abort)
        if (this.socket === socket) this.socket = undefined
        reconnect(!established, new Error(`websocket closed with ${code}`))
      })
      socket.addEventListener('open', () => {
        if (!active() || this.socket !== socket) {
          socket.close(1000, 'adapter stopped')
          return
        }
        this.track((async () => {
          try {
            await this.accept(socket, connection.signal)
            if (active() && !connection.signal.aborted) {
              established = true
              retryCount = 0
            }
          } catch (error) {
            connection.abort(error)
            reconnect(initial, error instanceof Error ? error : new Error(String(error)))
            socket.close(3000, 'adapter initialization failed')
          }
        })())
      })
    }
    this.track(connect(true))
  }

  async stop() {
    this.controller?.abort(new Error('adapter stopped'))
    this.controller = undefined
    clearTimeout(this.retry)
    this.retry = undefined
    this.socket?.close(1000, 'adapter stopped')
    this.socket = undefined
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}

export abstract class WsClient<B extends Bot<WsClientConfig>> extends WsClientBase<B> {
  constructor(ctx: Context, bot: B) {
    super(ctx, bot, bot.config)
  }

  getActive() {
    return this.bot.isActive
  }

  setStatus(status: Status, error?: Error) {
    this.bot.status = status
    this.bot.error = error
  }

  async connect() {
    await this.start()
  }

  async disconnect() {
    await this.stop()
  }
}
