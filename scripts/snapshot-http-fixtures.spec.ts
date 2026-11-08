import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

const httpMock = vi.hoisted(() => ({ createServer: vi.fn() }))

vi.mock('node:http', () => ({ createServer: httpMock.createServer }))

// Snapshot plugins are plain runtime JavaScript loaded by cordis.yml.
// @ts-expect-error The fixture intentionally has no declaration artifact.
import * as searchFixtureModule from '../snapshots/session/web-search-endpoint-guidance/web-search-error-fixture.mjs'
// @ts-expect-error The fixture intentionally has no declaration artifact.
import * as loopbackFixtureModule from '../snapshots/session/loopback-fixture-server.mjs'

const RECORDED_ENDPOINT = 'http://127.0.0.1:43118/api/v1/tools/search'

interface FixturePlugin {
  readonly name: string
  readonly inject?: readonly string[]
  apply(ctx: Context): Promise<void>
}

interface LoopbackFixtureOptions {
  readonly label: string
  readonly onCleanup: () => void
  readonly onListening: (address: { port: number }) => void
  readonly requestListener: () => void
}

const searchFixture = searchFixtureModule as unknown as FixturePlugin
const typedLoopbackFixtureModule = loopbackFixtureModule as unknown as {
  readonly applyLoopbackServerEffect: (ctx: Context, options: LoopbackFixtureOptions) => Promise<void>
}
const { applyLoopbackServerEffect } = typedLoopbackFixtureModule
const nativeFetch = globalThis.fetch

class FixtureServer extends EventEmitter {
  readonly started = Promise.withResolvers<undefined>()
  listening = false
  closed = false
  connectionsClosed = false
  unreferenced = false
  private listenCallback: (() => void) | undefined
  private port = 0

  listen(_port: number, _host: string, callback: () => void): this {
    this.listenCallback = callback
    this.started.resolve(undefined)
    return this
  }

  finishListening(port = 54321): void {
    this.port = port
    this.listening = true
    this.listenCallback?.()
  }

  address(): { address: string; family: string; port: number } | null {
    return this.listening ? { address: '127.0.0.1', family: 'IPv4', port: this.port } : null
  }

  unref(): this {
    this.unreferenced = true
    return this
  }

  close(callback: (error?: Error) => void): this {
    this.listening = false
    this.closed = true
    callback()
    return this
  }

  closeAllConnections(): void {
    this.connectionsClosed = true
  }
}

function nextServer(): FixtureServer {
  const server = new FixtureServer()
  httpMock.createServer.mockReturnValueOnce(server)
  return server
}

function captureErrors(ctx: Context): unknown[] {
  const errors: unknown[] = []
  ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
  return errors
}

async function disposeWhileStarting(fiber: { dispose(): Promise<unknown> }, server: FixtureServer): Promise<void> {
  await server.started.promise
  const disposal = fiber.dispose()
  const settled = vi.fn()
  void disposal.then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  server.finishListening()
  await disposal
}

afterEach(() => {
  globalThis.fetch = nativeFetch
  httpMock.createServer.mockReset()
})

describe('snapshot HTTP fixture lifecycle', () => {
  it('joins search listener setup and cleanup when disposal wins the startup race', async () => {
    const server = nextServer()
    const ctx = new Context()
    const errors = captureErrors(ctx)
    const fiber = ctx.plugin(searchFixture)
    await disposeWhileStarting(fiber, server)

    expect(server).toMatchObject({ closed: true, connectionsClosed: true, unreferenced: true })
    expect(globalThis.fetch).toBe(nativeFetch)
    expect(errors).toEqual([])
  })

  it('runs owner cleanup and closes the listener when disposal wins the startup race', async () => {
    const server = nextServer()
    const ctx = new Context()
    const errors = captureErrors(ctx)
    const onCleanup = vi.fn()
    const onListening = vi.fn()
    const fiber = ctx.plugin({
      name: 'loopback-fixture-lifecycle-test',
      apply: testCtx => applyLoopbackServerEffect(testCtx, {
        label: 'loopback-fixture-lifecycle-test',
        onCleanup,
        onListening,
        requestListener: () => {},
      }),
    })
    await disposeWhileStarting(fiber, server)

    expect(server).toMatchObject({ closed: true, connectionsClosed: true, unreferenced: true })
    expect(onListening).toHaveBeenCalledWith(expect.objectContaining({ port: 54321 }))
    expect(onCleanup).toHaveBeenCalledOnce()
    expect(errors).toEqual([])
  })

  it('maps every fetch input form and rejects another path on the recorded authority', async () => {
    const server = nextServer()
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}'))
    globalThis.fetch = fetchMock
    const ctx = new Context()
    const fiber = ctx.plugin(searchFixture)
    await server.started.promise
    server.finishListening(54322)
    await fiber

    try {
      await globalThis.fetch(RECORDED_ENDPOINT)
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://127.0.0.1:54322/api/v1/tools/search')

      await globalThis.fetch(new URL(RECORDED_ENDPOINT))
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://127.0.0.1:54322/api/v1/tools/search')

      const request = new Request(RECORDED_ENDPOINT, { method: 'POST', headers: { 'x-fixture': 'request' } })
      await globalThis.fetch(request)
      const mappedRequest = fetchMock.mock.calls.at(-1)?.[0]
      expect(mappedRequest).toBeInstanceOf(Request)
      if (!(mappedRequest instanceof Request)) throw new TypeError('mapped fetch input must be a Request')
      expect(mappedRequest.url).toBe('http://127.0.0.1:54322/api/v1/tools/search')
      expect(mappedRequest.method).toBe('POST')
      expect(mappedRequest.headers.get('x-fixture')).toBe('request')

      const unrelated = new URL('https://example.test/')
      await globalThis.fetch(unrelated)
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(unrelated)

      await expect(globalThis.fetch('http://127.0.0.1:43118/unexpected'))
        .rejects.toThrow('web-search-error-fixture: unexpected URL for recorded authority')
    } finally {
      await fiber.dispose()
    }

    expect(globalThis.fetch).toBe(fetchMock)
    expect(server.closed).toBe(true)
  })

  it('preserves a later fetch wrapper while still closing the listener and reporting the ownership error', async () => {
    const server = nextServer()
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}'))
    globalThis.fetch = fetchMock
    const ctx = new Context()
    const errors = captureErrors(ctx)
    const fiber = ctx.plugin(searchFixture)
    await server.started.promise
    server.finishListening()
    await fiber

    const fixtureFetch = globalThis.fetch
    const laterFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => fixtureFetch(input, init))
    globalThis.fetch = laterFetch
    await fiber.dispose()

    expect(globalThis.fetch).toBe(laterFetch)
    expect(server).toMatchObject({ closed: true, connectionsClosed: true })
    expect(errors.map(String).join('\n')).toContain('web-search-error-fixture: global fetch owner changed before cleanup')
  })
})
