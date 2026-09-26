import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Remote, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { browserCookie, provideBrowserCredentials } from './browser-credentials.ts'

/** The smallest Remote stream that reads its uplink: every carrier has to serve it alike. */
class EchoService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'echo', { namespace: 'echo' })
  }

  @Remote({ mode: 'stream' })
  async *echo(prefix: string, signal: AbortSignal): RemoteStream<string, string> {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('echo ran outside a Remote call')
    for await (const item of invocation.uplink<string>()) {
      signal.throwIfAborted()
      yield `${prefix}${item}`
    }
  }
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('the echo stream on each carrier', () => {
  it('echoes uplink items through the in-process carrier', async () => {
    const ctx = await setup(false)
    const replies = await ctx.typertGateway.stream({
      namespace: 'echo', method: 'echo', args: { prefix: '> ' }, uplink: items(['a', 'b']),
    })
    await expect(collect(replies)).resolves.toEqual(['> a', '> b'])
  })

  it('echoes uplink frames through the WebSocket carrier', async () => {
    const ctx = await setup(true)
    const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
      headers: { cookie: browserCookie(ctx) },
    })
    await once(socket, 'open')
    const frames: unknown[] = []
    socket.on('message', (data) => { frames.push(JSON.parse(rawText(data))) })
    socket.send(JSON.stringify({ type: 'open', streamId: 'echo', endpoint: 'echo/echo', payload: { args: { prefix: '> ' } } }))
    socket.send(JSON.stringify({ type: 'item', streamId: 'echo', value: 'a' }))
    socket.send(JSON.stringify({ type: 'item', streamId: 'echo', value: 'b' }))
    socket.send(JSON.stringify({ type: 'end', streamId: 'echo' }))
    await vi.waitFor(() => {
      expect(frames).toEqual([
        { type: 'item', streamId: 'echo', value: '> a' },
        { type: 'item', streamId: 'echo', value: '> b' },
        { type: 'end', streamId: 'echo' },
      ])
    })
    socket.close()
    await once(socket, 'close')
  })
})

async function setup(transport: boolean): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  if (transport) {
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    provideBrowserCredentials(ctx)
  }
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, {})
  if (transport) await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  await ctx.plugin(EchoService)
  return ctx
}

async function *items<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) yield value
}

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of source) values.push(value)
  return values
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}
