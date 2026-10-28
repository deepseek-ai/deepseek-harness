/** Web transport delegates module and entry changes to the page-owned controller. */
import { Context } from '@deepseek-ai/cordis'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Provide the module system face this transport drives: its entry controller's sync and reload. */
function provideModules(ctx: Context, sync: (...args: never[]) => unknown, reload: (...args: never[]) => unknown): void {
  ctx.provide('modules', { entries: { sync, reload } } as unknown as ClientModuleLoader)
}

it('forwards full graphs and rebuilt frames, contains wire errors and closes its EventSource', async () => {
  const ctx = new Context()
  const sync = vi.fn(async () => {})
  const reload = vi.fn(async () => {})
  provideModules(ctx, sync, reload)
  const warnings = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  let receive!: (event: { data: string }) => void
  const close = vi.fn()
  vi.stubGlobal('EventSource', class {
    close = close
    addEventListener(_name: string, listener: typeof receive) { receive = listener }
  })
  const fiber = ctx.plugin({ apply, inject })
  try {
    await fiber.await()
    const graph = { rev: 'r', entries: [], batches: [] }
    receive({ data: JSON.stringify({ type: 'graph', graph }) })
    receive({ data: JSON.stringify({ type: 'rebuilt', id: 'a', rev: 'r1' }) })
    await vi.waitFor(() => { expect(sync).toHaveBeenCalledWith(graph) })
    expect(reload).toHaveBeenCalledWith('a', 'r1')
    receive({ data: '{' })
    receive({ data: JSON.stringify({ type: 'graph', graph: null }) })
    receive({ data: JSON.stringify({ type: 'future' }) })
    expect(warnings).toHaveBeenCalledTimes(2)
    sync.mockRejectedValueOnce(new Error('invalid graph'))
    receive({ data: JSON.stringify({ type: 'graph', graph: {} }) })
    await vi.waitFor(() => { expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'invalid graph' })) })
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
  expect(close).toHaveBeenCalledOnce()
})

it('reads the event stream through the page transport when the shell provides one', async () => {
  const ctx = new Context()
  const sync = vi.fn(async () => {})
  const reload = vi.fn(async () => {})
  provideModules(ctx, sync, reload)
  const graph = { rev: 'r', entries: [], batches: [] }
  const encoder = new TextEncoder()
  let signal: AbortSignal | undefined
  const fetch = vi.fn((_input: string, init: RequestInit) => {
    signal = init.signal ?? undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': connected\n\n'))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'graph', graph })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'rebuilt', id: 'a', rev: 'r1' })}\n\n`))
        // The tunnel ends the body when the caller aborts.
        init.signal?.addEventListener('abort', () => { controller.close() })
      },
    })
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  })
  vi.stubGlobal('__DSH_TRANSPORT__', { fetch })
  const eventSource = vi.fn()
  vi.stubGlobal('EventSource', eventSource)
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const fiber = ctx.plugin({ apply, inject })
  try {
    await fiber.await()
    await vi.waitFor(() => { expect(sync).toHaveBeenCalledWith(graph) })
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledWith('a', 'r1') })
    expect(fetch).toHaveBeenCalledWith('plugins/events', expect.objectContaining({ method: 'GET' }))
    expect(eventSource).not.toHaveBeenCalled()
    expect(signal?.aborted).toBe(false)
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
  expect(signal?.aborted).toBe(true)
  await Promise.resolve()
  expect(errors).not.toHaveBeenCalled()
})

it.each([
  ['a refused stream', () => new Response('missing', { status: 404 }), 'plugins/events answered 404'],
  ['a stream without a body', () => new Response(null, { status: 200 }), 'plugins/events answered 200'],
  ['a stream that ends while the plugin runs', () => new Response(': connected\n\n', { status: 200 }), 'plugins/events closed'],
])('reports %s on the page transport', async (_label, respond, message) => {
  const ctx = new Context()
  provideModules(ctx, vi.fn(), vi.fn())
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  vi.stubGlobal('__DSH_TRANSPORT__', { fetch: () => Promise.resolve(respond()) })
  const fiber = ctx.plugin({ apply, inject })
  try {
    await fiber.await()
    await vi.waitFor(() => {
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(message) as string }))
    })
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

it('stays silent when disposal aborts a page-transport request in flight', async () => {
  const ctx = new Context()
  provideModules(ctx, vi.fn(), vi.fn())
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const fetch = vi.fn((_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
  }))
  vi.stubGlobal('__DSH_TRANSPORT__', { fetch })
  const fiber = ctx.plugin({ apply, inject })
  await fiber.await()
  await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
  await fiber.dispose()
  await ctx.fiber.dispose()
  await Promise.resolve()
  expect(errors).not.toHaveBeenCalled()
})
