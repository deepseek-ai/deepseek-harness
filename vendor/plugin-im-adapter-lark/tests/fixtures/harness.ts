/**
 * The offline mounting harness the decoder and event suites share.
 *
 * One `{ ctx, bot }` pair: the adapter on a fresh context, `http/fetch` answering the long-connection handshake routes
 * and the test's own routes, and a stand-in socket through `http/websocket`, so no test touches the network. Fixtures
 * under `tests/fixtures/*.json` are real event envelopes, loaded by name.
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import { Satori } from '@deepseek-ai/cordis-plugin-im-core'
import LarkBot, { Config, type LarkConfig } from '@deepseek-ai/cordis-plugin-im-adapter-lark'
import * as Markdown from '@deepseek-ai/cordis-plugin-im-markdown'

/** The bot's own open id; the handshake route answers with it. */
export const SELF_ID = 'ou_bot'
/** Application id of the mounted bot (also the resource scope). */
export const APP_ID = 'cli_lark'

/** One request the adapter made. */
export interface Call {
  path: string
  method: string
  search: string
  body: unknown
}

/** What the platform answers for one path. */
export type Route = (call: Call) => Response | Promise<Response>

const contexts: Context[] = []

/** Dispose every context a test mounted (call it from `afterEach`). */
export async function disposeAll(): Promise<void> {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
}

/**
 * Load one fixture envelope.
 *
 * @param name - file name without `.json` under `tests/fixtures/`.
 * @returns the parsed JSON.
 */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8')) as T
}

/** Stand-in socket, so a mounted bot can complete its long-connection handshake. */
class Socket extends EventTarget {
  readyState = 1
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer'
  private opened = false
  close() {}
  send() {}

  /** The transport opens as soon as the adapter listens for it. */
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    super.addEventListener(type, listener, options)
    if (type === 'open' && !this.opened) {
      this.opened = true
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
  }
}

/**
 * The routes every mounted bot needs (gateway, token, identity) plus the test's own; an unexpected path throws, so a
 * test also proves that no request it did not route was made.
 *
 * @param overrides - routes of the test, keyed by pathname.
 * @returns the recorded calls and the handler.
 */
function platform(overrides: Record<string, Route> = {}) {
  const calls: Call[] = []
  const handler = (call: Call): Response | Promise<Response> => {
    const override = overrides[call.path]
    if (override) return override(call)
    if (call.path === '/callback/ws/endpoint') {
      return Response.json({
        code: 0,
        data: { URL: 'wss://open.feishu.cn/cb/ws?service_id=7', ClientConfig: { PingInterval: 120 } },
      })
    }
    if (call.path === '/open-apis/auth/v3/tenant_access_token/internal') {
      return Response.json({ code: 0, tenant_access_token: 't-token', expire: 7200 })
    }
    if (call.path === '/open-apis/bot/v3/info') {
      return Response.json({ code: 0, bot: { open_id: SELF_ID, app_name: 'Lark Bot' } })
    }
    throw new Error(`Unexpected request: ${call.method} ${call.path}`)
  }
  return { calls, handler }
}

/**
 * Mount the adapter on a fresh context.
 *
 * @param input - configuration overrides (`allowAtAll`, `render`, …).
 * @param overrides - extra platform routes, keyed by pathname.
 * @returns the context, the bot, its configuration and every recorded request.
 */
export async function mount(input: Record<string, unknown> = {}, overrides: Record<string, Route> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  await ctx.plugin(Markdown)
  const routes = platform(overrides)
  // The plugin's hook types speak undici's `WebSocket`; this fake only has to stay open.
  ctx.on('http/websocket', (() => new Socket()) as never)
  ctx.on('http/fetch', async (url: URL, init: any) => {
    const call: Call = {
      path: url.pathname,
      method: init.method ?? 'GET',
      search: url.search,
      body: init.body,
    }
    routes.calls.push(call)
    return await routes.handler(call)
  })
  const config: LarkConfig = Config({ appId: APP_ID, appSecret: 'secret', ...input } as LarkConfig)
  await ctx.plugin(LarkBot, config)
  const bot = ctx.bots[0] as LarkBot
  // The handshake answers with the same id, so this is only what a synchronous assertion sees first.
  bot.selfId = SELF_ID
  return { ctx, bot, config, calls: routes.calls }
}
