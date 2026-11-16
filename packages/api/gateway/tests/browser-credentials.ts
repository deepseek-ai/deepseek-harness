import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as Token from '@deepseek-ai/dsh-host-authentication-token'
import { BrowserAuth } from '@deepseek-ai/dsh-host-authentication-token/src/browser-auth.ts'

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
export async function browserCookie(ctx: Context): Promise<string> {
  const existing = browserCookies.get(ctx)
  if (existing !== undefined) return existing
  await ctx.plugin(Token, { cookieMaxAgeDays: 30 }).await()
  const auth = await BrowserAuth.create(ctx[Context.root], ctx.credentials, 30)
  const target = new URL(auth.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`))
  let setCookie: string | undefined
  const request = {
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: { host: target.host },
    socket: { destroyed: false },
  } as IncomingMessage
  const response = {
    writeHead(_status: number, headers?: Readonly<Record<string, string>>) { setCookie = headers?.['set-cookie'] },
    end() {},
  } as ServerResponse
  await ctx.waterfall('webserver/request', request, response, async () => {})
  if (setCookie === undefined) throw new Error('gateway fixture did not receive a browser cookie')
  const cookie = setCookie.split(';', 1)[0]!
  browserCookies.set(ctx, cookie)
  ctx.effect(() => () => { browserCookies.delete(ctx) })
  return cookie
}
