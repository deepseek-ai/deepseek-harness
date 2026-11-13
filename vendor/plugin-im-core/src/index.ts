import { Context, Service } from '@deepseek-ai/cordis'
import { type Awaitable, defineProperty, type Dict } from '@deepseek-ai/cosmokit'
import type { Bot, SendResult } from './bot.ts'
import { ElementContributions } from './contributions.ts'
import { type InternalRouteCallback, InternalRouter, JsonForm } from './internal.ts'
import type { Meta } from './protocol.ts'
import type { Session } from './session.ts'
import type {} from '@deepseek-ai/cordis-plugin-http'
import { type ExtractParams } from 'path-to-regexp-typed'

export * from '@deepseek-ai/cordis'
export * from '@deepseek-ai/cosmokit'

export * from '@deepseek-ai/satori-element'

export * from './protocol.ts'
export * from './mode.ts'
export * from './registry.ts'
export * from './fallback.ts'
export * from './degradation.ts'
export * from './transform.ts'
export * from './directives.ts'
export * from './resource.ts'
export * from './bot.ts'
export * from './stream.ts'
export * from './contributions.ts'
export * from './errors.ts'
export * from './ws.ts'
export * from './internal.ts'
export * from './session.ts'

// ---------------------------------------------------------------------------------------------------------------
// Event contract. `bot.receive` awaits every `satori/receive` listener (the intake gate) before it
// publishes the ordinary observer events below; `internal/session` fires for every envelope, including `internal`
// ones, which `bot.dispatch` then re-emits as `ctx.emit(internal.type, internal.data, bot)`.

declare module '@deepseek-ai/cordis' {
  export interface Context {
    [Context.session]: Session
    satori: Satori
    bots: Bot[] & Dict<Bot>
  }

  export namespace Context {
    const session: unique symbol
  }

  interface Events {
    'satori/meta'(): void
    /** @mode parallel @param session - External event; awaited before transport acknowledgement. */
    'satori/receive'(session: Session): Awaitable<void>
    'internal/session'(session: Session): void
    /** `session.message` */
    'message'(session: Session): void
    /** `session.event.deleted` */
    'message-deleted'(session: Session): void
    /** `session.button`; the bot routes `onClick` callbacks, dsh-im re-emits as `im/button`. */
    'interaction/button'(session: Session): void
    /** `session.select`; the bot routes `onSelect` callbacks, dsh-im re-emits as `im/select`. */
    'interaction/select'(session: Session): void
    /** `session.check`; the bot routes `onChange` callbacks of a checkbox, dsh-im re-emits as `im/check`. */
    'interaction/check'(session: Session): void
    /** `session.event.reaction` */
    'reaction-added'(session: Session): void
    'reaction-removed'(session: Session): void
    /** `session.event.login` */
    'login-added'(session: Session): void
    'login-removed'(session: Session): void
    'login-updated'(session: Session): void
    /** @mode emit — observer: a logical message was published by `bot.send` / `edit` / a stream close. */
    'send'(bot: Bot, result: SendResult): void
    'bot-connect'(client: Bot): Awaitable<void>
    'bot-disconnect'(client: Bot): Awaitable<void>
  }
}

class DisposableSet<T> {
  private sn = 0
  private map1 = new Map<number, T[]>()
  private map2 = new Map<T, Set<number>>()

  constructor(private ctx: Context) {
    defineProperty(this, Service.tracker, {
      property: 'ctx',
    })
  }

  add(...values: T[]) {
    const sn = ++this.sn
    return this.ctx.effect(() => {
      let hasUpdate = false
      for (const value of values) {
        if (!this.map2.has(value)) {
          this.map2.set(value, new Set())
          hasUpdate = true
        }
        this.map2.get(value)!.add(sn)
      }
      this.map1.set(sn, values)
      if (hasUpdate) this.ctx.emit('satori/meta')
      return () => {
        let hasUpdate = false
        this.map1.delete(sn)
        for (const value of values) {
          this.map2.get(value)!.delete(sn)
          if (this.map2.get(value)!.size === 0) {
            this.map2.delete(value)
            hasUpdate = true
          }
        }
        if (hasUpdate) this.ctx.emit('satori/meta')
      }
    })
  }

  [Symbol.iterator]() {
    return new Set(([] as T[]).concat(...this.map1.values()))[Symbol.iterator]()
  }
}

export class Satori extends Service {
  public uid = Math.random().toString(36).slice(2)
  public proxyUrls: DisposableSet<string> = new DisposableSet(this.ctx)

  /**
   * Element handlers plugins contribute to every mode that does not register the tag itself.
   *
   * A plugin registers its handler inside `ctx.effect()` so unloading it withdraws the handler again; every render
   * reads this table, so the contribution applies to bots that exist and to bots created later.
   */
  public elements = new ElementContributions()

  public _internalRouter: InternalRouter
  public _tempStore: Dict<Response> = Object.create(null)

  public _loginSeq = 0
  public _sessionSeq = 0

  constructor(ctx: Context) {
    super(ctx, 'satori')
    ctx.mixin('satori', ['bots'])

    defineProperty(this.bots, Service.tracker, {})

    const self = this
    ;(ctx as Context).on('http/fetch', async function (url, init, config, next) {
      if (url.protocol !== 'satori:') return next()
      const signal = init.signal as AbortSignal | undefined
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      }
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.method === 'GET' || init.method === 'HEAD'
          ? undefined
          : init.body as BodyInit,
        ...signal ? { signal } : {},
      } as RequestInit)
      const res = signal
        ? await new Promise<Response>((resolve, reject) => {
          let settled = false
          const onAbort = () => {
            settled = true
            reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          self.handleInternalRoute(request).then(
            (response) => {
              signal.removeEventListener('abort', onAbort)
              if (settled) {
                void response.body?.cancel(signal.reason).catch(() => {})
                return
              }
              settled = true
              resolve(response)
            },
            (error) => {
              signal.removeEventListener('abort', onAbort)
              if (!settled) {
                settled = true
                reject(error)
              }
            },
          )
        })
        : await self.handleInternalRoute(request)
      if (res.status >= 400) throw new Error(`Failed to fetch ${url}, status code: ${res.status}`)
      if (res.status >= 300) {
        const location = res.headers.get('location')!
        return this(new URL(location, url), {
          ...config,
          ...signal ? { signal } : {},
          responseType: response => response,
        })
      }
      return res
    })

    this._internalRouter = new InternalRouter(ctx)

    this.defineInternalRoute('/_tmp/:id', async ({ params, method }) => {
      if (method !== 'GET') return new Response(null, { status: 405 })
      return this._tempStore[params.id] ?? new Response(null, { status: 404 })
    })

    this.defineInternalRoute('/_api/:name', async (req, bot) => {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      const args = await JsonForm.decode(req)
      if (!args) return new Response(null, { status: 400 })
      try {
        let root = bot.internal
        for (const part of req.params.name.split('.')) {
          root = root[part]
        }
        let result = root(...args)
        if (req.headers.get('satori-pagination')) {
          if (!result?.[Symbol.for('satori.pagination')]) {
            return new Response('This API does not support pagination', { status: 400 })
          }
          result = await result[Symbol.for('satori.pagination')]()
        } else {
          result = await result
        }
        return await JsonForm.encode(result)
      } catch (error) {
        if (!ctx.get('http')?.isError(error) || !error.response) throw error
        return error.response
      }
    })
  }

  /** Lookup by stable bot id (`lark:<appId>`) or by `platform:selfId`. */
  public bots = new Proxy([] as Bot[], {
    get(target, prop) {
      if (prop in target || typeof prop === 'symbol') {
        return Reflect.get(target, prop)
      }
      return target.find(bot => bot.id === prop || bot.sid === prop)
    },
    deleteProperty(target, prop) {
      if (prop in target || typeof prop === 'symbol') {
        return Reflect.deleteProperty(target, prop)
      }
      const bot = target.findIndex(bot => bot.id === prop || bot.sid === prop)
      if (bot < 0) return true
      target.splice(bot, 1)
      return true
    },
  }) as Bot[] & Dict<Bot>

  defineInternalRoute<P extends string>(path: P, callback: InternalRouteCallback<ExtractParams<P>>) {
    return this._internalRouter.define(path, callback)
  }

  async handleInternalRoute(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const capture = /^([^/]+)\/([^/]+)(\/.+)$/.exec(url.pathname)
    if (!capture) return new Response(null, { status: 404 })
    const [, platform, selfId, path] = capture
    const bot = this.bots[`${platform}:${selfId}`]
    if (!bot) return new Response(null, { status: 404 })
    let response = await bot._internalRouter.handle(bot, req, path, url.searchParams)
    response ??= await this._internalRouter.handle(bot, req, path, url.searchParams)
    if (!response) return new Response(null, { status: 404 })
    return response
  }

  toJSON(): Meta {
    return {
      logins: this.bots.map(bot => bot.toJSON()),
      proxyUrls: [...this.proxyUrls],
    }
  }
}

export default Satori
