import type { Context } from '@deepseek-ai/cordis'

const browserCookies = new WeakMap<Context, string>()

/** Provide an in-memory credential-record owner for a mounted Connection plugin. */
export function provideBrowserCredentials(ctx: Context): void {
  const records = new Map<unknown, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(
      key: unknown,
      mutate: (current: unknown) => Promise<unknown>,
    ): Promise<unknown> {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
  } as never)
}

/**
 * Exchange a test Host's process token for its WebSocket/HTTP Cookie header.
 * @param ctx - Host root with the Web server and Connection mounted.
 * @returns the `cookie` header value, cached per root.
 */
export function browserCookie(ctx: Context): string {
  const existing = browserCookies.get(ctx)
  if (existing !== undefined) return existing
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const target = new URL(ctx.connection.authenticatedUrl(origin))
  let setCookie: string | undefined
  ctx.connection.authorizeIndex({
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: { host: target.host },
  }, {
    writeHead(_status, headers) { setCookie = headers?.['set-cookie'] },
    end() {},
  })
  if (setCookie === undefined) throw new Error('gateway fixture did not receive a browser cookie')
  const cookie = setCookie.split(';', 1)[0]!
  browserCookies.set(ctx, cookie)
  return cookie
}
