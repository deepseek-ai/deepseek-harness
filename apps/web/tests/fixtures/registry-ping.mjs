/** Controlled public-registry responses inside one isolated Web-test Host. */
import { appendFileSync } from 'node:fs'
export const name = 'registry-ping-fixture'

/** Replace only npm registry ping requests and restore the Host transport on unload. */
export function apply(ctx, config) {
  ctx.effect(() => {
    const original = globalThis.fetch
    const lifetime = new AbortController()
    const pending = new Set()
    const endpoints = ['https://registry.npmjs.org/-/ping', 'https://registry.npmmirror.com/-/ping']
    globalThis.fetch = (input, init) => {
      if (typeof input !== 'string' || !endpoints.includes(input)) return original(input, init)
      appendFileSync(config.requestLog, JSON.stringify(input) + '\n')
      if (input === `${config.winner}-/ping`) return Promise.resolve(new Response('{}'))
      const signal = AbortSignal.any([init.signal, lifetime.signal])
      const request = new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
      pending.add(request)
      return request.finally(() => { pending.delete(request) })
    }
    return async () => {
      globalThis.fetch = original
      lifetime.abort()
      await Promise.allSettled(pending)
    }
  })
}
