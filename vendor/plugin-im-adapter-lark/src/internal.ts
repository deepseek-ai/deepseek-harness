/**
 * Generated-route client of the OpenAPI subset (`types/`), and the `/_api/:name` escape hatch.
 *
 * `types/*.ts` retains the `auth`, `im` and `contact` OpenAPI route families from upstream; its
 * `Internal.define({ '/im/v1/messages': { POST: 'im.message.create', … } })` calls register every route of the
 * subset here at import time, and its `declare module` blocks type the resulting tree. The tree is a plain object of
 * callables addressed by name (`bot.internal.im.message.get(messageId)`), so a caller can reach a route this adapter
 * does not wrap — the typed client in `api/` covers what the pipeline uses.
 *
 * Every call goes through {@link ./api/client.ts}, so authorization, the envelope check and {@link LarkApiError} are
 * the same as the hand-written routes.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/internal
 */

import { type Dict, makeArray } from '@deepseek-ai/cordis-plugin-im-core'
import type { LarkBot } from './bot.ts'
import type { LarkQuery, LarkRequestOptions } from './api/client.ts'

export interface Internal {}

export interface BaseResponse {
  /** error code. would be 0 if success, and non-0 if failed. */
  code: number
  /** error message. would be 'success' if success. */
  msg: string
}

export type Paginated<T = any, ItemsKey extends string = 'items'> =
  & Promise<
    & { [K in ItemsKey]: T[] }
    & { page_token?: string; has_more: boolean }
  >
  & AsyncIterableIterator<T>

export interface Pagination {
  page_size?: number
  page_token?: string
}

export interface InternalRoute {
  name: string
  pagination?: {
    argIndex: number
    itemsKey?: string
    tokenKey?: string
  }
  multipart?: boolean
  type?: 'raw-json' | 'binary'
}

export class Internal {
  constructor(bot: LarkBot, tree = Internal._tree, signal?: AbortSignal) {
    return new Proxy(this, {
      get: (target, prop) => {
        if (typeof prop === 'symbol') return Reflect.get(target, prop)
        const value = tree[prop]
        if (typeof value === 'function') return value.bind(bot, signal)
        if (value) return new Internal(bot, value, signal)
      },
    })
  }

  /** Bind cancellation to every native request made through this client. */
  static withSignal(bot: LarkBot, signal: AbortSignal): Internal {
    return new Internal(bot, Internal._tree, signal)
  }

  private static _buildData(arg: object, options: InternalRoute) {
    if (options.multipart) {
      const form = new FormData()
      for (const [key, value] of Object.entries(arg)) {
        if (value instanceof File) {
          form.append(key, value, value.name)
        } else {
          form.append(key, value as string)
        }
      }
      return form
    }
    return arg
  }

  private static _tree: Dict = Object.create(null)

  static define(routes: Dict<Partial<Record<string, string | InternalRoute>>>) {
    for (const path in routes) {
      for (const key in routes[path]) {
        const method = key as string
        for (let route of makeArray(routes[path][method])) {
          if (typeof route === 'string') {
            route = { name: route }
          }

          const impl = async function (bot: LarkBot, signal: AbortSignal | undefined, ...args: any[]) {
            const raw = args.join(', ')
            const url = path.replace(/^\//, '').replace(/\{([^}]+)\}/g, () => {
              if (!args.length) throw new Error(`too few arguments for ${path}, received ${raw}`)
              return encodeURIComponent(String(args.shift()))
            })
            const config: LarkRequestOptions = {}
            if (signal) config.signal = signal
            if (args.length === 1) {
              if (method === 'GET' || method === 'DELETE') {
                config.params = args[0] as LarkQuery
              } else {
                config.data = Internal._buildData(args[0], route!)
              }
            } else if (args.length === 2 && method !== 'GET' && method !== 'DELETE') {
              config.data = Internal._buildData(args[0], route!)
              config.params = args[1] as LarkQuery
            } else if (args.length > 1) {
              throw new Error(`too many arguments for ${path}, received ${raw}`)
            }
            if (route!.type === 'binary') {
              return (await bot.api.download(method, url, config)).data
            }
            const envelope = await bot.api.request(method, url, config)
            if (route!.type === 'raw-json') return envelope
            return envelope.data
          }

          let root = Internal._tree
          const parts = route.name.split('.')
          const lastPart = parts.pop()!
          for (const part of parts) {
            root = root[part] ??= Object.create(null)
          }
          root[lastPart] = function (this: LarkBot, signal: AbortSignal | undefined, ...args: any[]) {
            let promise: Promise<any> | undefined
            const result = {} as Paginated
            // The pagination protocol hangs private keys (a `symbol`) off the same thenable, so the tree is built
            // through an untyped view of it.
            const internals = result as unknown as Record<string | symbol, any>
            for (const key of ['then', 'catch', 'finally'] as const) {
              result[key] = (...args2: any[]) => {
                const pending = promise ??= impl(this, signal, ...args)
                return (pending[key] as (...values: any[]) => Promise<any>)(...args2)
              }
            }

            if (route!.pagination) {
              const { argIndex, itemsKey = 'items', tokenKey = 'page_token' } = route!.pagination
              const iterArgs = [...args]
              iterArgs[argIndex] = { ...args[argIndex] }
              type Pagination = { data: any[]; next?: any }
              let pagination: Pagination | undefined
              result.next = async function () {
                const self = this as unknown as Record<string | symbol, any>
                pagination ??= await self[Symbol.for('satori.pagination')]() as Pagination
                if (pagination.data.length) return { done: false, value: pagination.data.shift() }
                if (!pagination.next) return { done: true, value: undefined }
                pagination = await self[Symbol.for('satori.pagination')]() as Pagination
                return this.next()
              }
              internals[Symbol.asyncIterator] = function () {
                return this
              }
              internals[Symbol.for('satori.pagination')] = async () => {
                const data = await impl(this, signal, ...iterArgs) as Record<string, any>
                iterArgs[argIndex].page_token = data[tokenKey]
                return {
                  data: data[itemsKey],
                  next: data[tokenKey] ? iterArgs : undefined,
                }
              }
            }

            return result
          }
        }
      }
    }
  }
}
