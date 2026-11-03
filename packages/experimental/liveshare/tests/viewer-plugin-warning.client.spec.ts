// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { installViewerPluginWarnings, installViewerRpcWarnings } from '../src/client/viewer-plugin-warning.ts'

const t = ((key: string, values?: { plugin?: string }) => key === 'viewer.pluginUnsupported'
  ? `plugin ${values?.plugin ?? ''} unsupported`
  : 'dismiss') as never

afterEach(() => {
  vi.restoreAllMocks()
  document.querySelectorAll('[data-liveshare-plugin-warning]').forEach((node) => { node.remove() })
})

describe('viewer plugin warning', () => {
  it('names each owner-only plugin once per page', async () => {
    const original = globalThis.fetch
    const response = () => new Response(JSON.stringify({ error: 'owner-route-not-shared' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
    globalThis.fetch = vi.fn(async () => response())
    const dispose = installViewerPluginWarnings(document, t)
    try {
      await fetch('/api/timeline/watch', { method: 'POST' })
      await fetch('/api/timeline/watch', { method: 'POST' })
      await fetch('/api/other/edit', { method: 'POST' })
      const notices = document.querySelectorAll('[data-liveshare-plugin-warning]')
      expect(notices).toHaveLength(2)
      expect(notices[0]?.textContent).toContain('timeline')
      expect(notices[1]?.textContent).toContain('other')
    } finally {
      dispose()
      globalThis.fetch = original
    }
  })

  it('reports an owner-route failure returned by the RPC channel', async () => {
    const call = vi.fn(async (): Promise<ConnectionRpcResult<unknown>> => ({
      ok: false,
      error: { code: 'forbidden', message: 'owner-route-not-shared', details: {} },
    }))
    const connection: Pick<ConnectionHandle, 'rpc'> = { rpc: { call } }
    const dispose = installViewerRpcWarnings(connection, document, t)
    try {
      await connection.rpc.call('/api', 'timeline/watch', {})
      await connection.rpc.call('/api', 'timeline/watch', {})
      const notices = document.querySelectorAll('[data-liveshare-plugin-warning]')
      expect(notices).toHaveLength(1)
      expect(notices[0]?.textContent).toContain('timeline')
    } finally {
      dispose()
    }
  })

  it('ignores non-JSON refusals, foreign origins, and removed notices', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('not json', { status: 403 }))
    const dispose = installViewerPluginWarnings(document, t)
    try {
      await fetch('http://other.test/api/timeline/watch', { method: 'POST' })
      await fetch('/api/timeline/watch', { method: 'POST' })
      expect(document.querySelectorAll('[data-liveshare-plugin-warning]')).toHaveLength(0)
    } finally {
      dispose()
      globalThis.fetch = original
    }
  })

  it('ignores a request whose URL cannot be parsed', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('{}'))
    const dispose = installViewerPluginWarnings(document, t)
    try {
      await fetch('::not-a-url')
      expect(document.querySelectorAll('[data-liveshare-plugin-warning]')).toHaveLength(0)
    } finally {
      dispose()
      globalThis.fetch = original
    }
  })

  it('removes a notice from its dismiss control', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'owner-route-not-shared' }), { status: 403 }))
    const dispose = installViewerPluginWarnings(document, t)
    try {
      await fetch('/api/timeline/watch', { method: 'POST' })
      const notice = document.querySelector('[data-liveshare-plugin-warning]')
      const close = notice?.querySelector('button')
      close?.click()
      expect(notice?.isConnected).toBe(false)
    } finally {
      dispose()
      globalThis.fetch = original
    }
  })

  it('reports a thrown owner-route failure and tolerates a frozen connection', async () => {
    const call = vi.fn(async (): Promise<ConnectionRpcResult<unknown>> => {
      throw new Error('owner-route-not-shared')
    })
    const connection: Pick<ConnectionHandle, 'rpc'> = { rpc: { call } }
    const dispose = installViewerRpcWarnings(connection, document, t)
    try {
      await expect(connection.rpc.call('/api', 'timeline/watch', {})).rejects.toThrow('owner-route-not-shared')
      expect(document.querySelectorAll('[data-liveshare-plugin-warning]')).toHaveLength(1)
    } finally {
      dispose()
    }
    const frozen = Object.freeze({ call: vi.fn() }) as never
    const disposeFrozen = installViewerRpcWarnings({ rpc: frozen }, document, t)
    expect(() => { disposeFrozen() }).not.toThrow()
  })

  it('names a plugin for a request sent as a Request object', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'owner-route-not-shared' }), { status: 403 }))
    const dispose = installViewerPluginWarnings(document, t)
    try {
      await fetch(new Request(new URL('/api/files/read', location.href), { method: 'POST' }))
      const notices = document.querySelectorAll('[data-liveshare-plugin-warning]')
      expect(notices).toHaveLength(1)
      expect(notices[0]?.textContent).toContain('files')
    } finally {
      dispose()
      globalThis.fetch = original
    }
  })

  it('leaves a request with no plugin segment unnamed', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'owner-route-not-shared' }), { status: 403 }))
    const dispose = installViewerPluginWarnings(document, t)
    try {
      await fetch(new URL('/api/', location.href), { method: 'POST' })
      expect(document.querySelectorAll('[data-liveshare-plugin-warning]')).toHaveLength(0)
    } finally {
      dispose()
      globalThis.fetch = original
    }
  })

  it('leaves a successful call and a refusal of another kind unnamed', async () => {
    const results: ConnectionRpcResult<unknown>[] = [
      { ok: true, value: {} },
      { ok: false, error: { code: 'forbidden', message: 'not shared here', details: {} } },
    ]
    const call = vi.fn(async (): Promise<ConnectionRpcResult<unknown>> => results.shift() ?? { ok: true, value: {} })
    const connection: Pick<ConnectionHandle, 'rpc'> = { rpc: { call } }
    const dispose = installViewerRpcWarnings(connection, document, t)
    try {
      await connection.rpc.call('/api', 'timeline/watch', {})
      await connection.rpc.call('/api', 'timeline/watch', {})
      expect(document.querySelectorAll('[data-liveshare-plugin-warning]')).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('leaves an endpoint outside a plugin namespace unnamed', async () => {
    const call = vi.fn(async (): Promise<ConnectionRpcResult<unknown>> => ({
      ok: false,
      error: { code: 'forbidden', message: 'owner-route-not-shared', details: {} },
    }))
    const connection: Pick<ConnectionHandle, 'rpc'> = { rpc: { call } }
    const dispose = installViewerRpcWarnings(connection, document, t)
    try {
      await connection.rpc.call('/api', '/timeline/watch', {})
      expect(document.querySelectorAll('[data-liveshare-plugin-warning]')).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('rethrows an RPC failure that is not the owner-route refusal', async () => {
    const call = vi.fn(async (): Promise<ConnectionRpcResult<unknown>> => {
      throw new Error('transport closed')
    })
    const connection: Pick<ConnectionHandle, 'rpc'> = { rpc: { call } }
    const dispose = installViewerRpcWarnings(connection, document, t)
    try {
      await expect(connection.rpc.call('/api', 'timeline/watch', {})).rejects.toThrow('transport closed')
      expect(document.querySelectorAll('[data-liveshare-plugin-warning]')).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('leaves a thrown owner-route failure outside a plugin namespace unnamed', async () => {
    const call = vi.fn(async (): Promise<ConnectionRpcResult<unknown>> => {
      throw new Error('owner-route-not-shared')
    })
    const connection: Pick<ConnectionHandle, 'rpc'> = { rpc: { call } }
    const dispose = installViewerRpcWarnings(connection, document, t)
    try {
      await expect(connection.rpc.call('/api', '/timeline/watch', {})).rejects.toThrow('owner-route-not-shared')
      expect(document.querySelectorAll('[data-liveshare-plugin-warning]')).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('returns a no-op disposer for a connection without a channel', () => {
    const dispose = installViewerRpcWarnings({}, document, t)
    expect(() => { dispose() }).not.toThrow()
  })

  it('leaves a fetch that was replaced after installation in place', () => {
    const original = globalThis.fetch
    const replacement = vi.fn()
    const dispose = installViewerPluginWarnings(document, t)
    globalThis.fetch = replacement as never
    try {
      dispose()
      expect(globalThis.fetch).toBe(replacement)
    } finally {
      globalThis.fetch = original
    }
  })

  it('restores a delegating call and leaves a later replacement alone', async () => {
    const original = vi.fn(async (): Promise<ConnectionRpcResult<unknown>> => ({ ok: true, value: {} }))
    const connection: Pick<ConnectionHandle, 'rpc'> = { rpc: { call: original } }
    const dispose = installViewerRpcWarnings(connection, document, t)
    dispose()
    await connection.rpc.call('/api', 'timeline/watch', {})
    expect(original).toHaveBeenCalledWith('/api', 'timeline/watch', {})

    const disposeAgain = installViewerRpcWarnings(connection, document, t)
    const replacement = vi.fn(async (): Promise<ConnectionRpcResult<unknown>> => ({ ok: true, value: {} }))
    connection.rpc.call = replacement
    disposeAgain()
    await connection.rpc.call('/api', 'timeline/watch', {})
    expect(replacement).toHaveBeenCalledOnce()
  })

  it('ignores other responses and removes notices on dispose', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const dispose = installViewerPluginWarnings(document, t)
    try {
      await fetch('/api/timeline/watch', { method: 'POST' })
      expect(document.querySelectorAll('[data-liveshare-plugin-warning]')).toHaveLength(0)
    } finally {
      dispose()
      globalThis.fetch = original
    }
  })
})
