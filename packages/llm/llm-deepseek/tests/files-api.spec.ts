import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { LlmError, userAgent } from '@deepseek-ai/dsh-llm'
import { DeepSeekFileId } from '../src/file-id.ts'
import {
  DeepSeekFilesClient,
  DeepSeekFilesError,
  isFilesQuotaError,
  MAX_FILE_UPLOAD_BYTES,
} from '../src/files-api.ts'

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-api-one', type: 'file', size_bytes: 3,
    created_at: '2023-11-14T22:13:20.000Z', filename: 'image.png', mime_type: 'image/png',
    ...overrides,
  }
}

describe('DeepSeekFilesClient', () => {
  describe('successful response JSON', () => {
    it.each((['upload', 'list', 'retrieve', 'delete'] as const).flatMap(operation =>
      ['', '{"id":'].map(body => ({ operation, body })),
    ))('rejects malformed JSON with operation and HTTP status: %j', async ({ operation, body }) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }))
      const client = new DeepSeekFilesClient({ baseURL: 'https://files.example', headers: { 'x-api-key': 'test-key' }, fetch: fetchImpl })
      const operations = {
        upload: () => client.upload({ data: Uint8Array.of(1), mediaType: 'image/png', filename: 'image.png', expiresAfterSeconds: 3_600 }),
        list: () => client.list(),
        retrieve: () => client.retrieve(DeepSeekFileId('file-api-one')),
        delete: () => client.delete(DeepSeekFileId('file-api-one')),
      }
      const error = await operations[operation]().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(LlmError)
      if (!(error instanceof LlmError)) throw error
      expect(error.cause).toBeInstanceOf(SyntaxError)
      expect(error).toMatchObject({
        code: 'INVALID_RESPONSE',
        message: `DeepSeek Files API returned invalid JSON for ${operation} (HTTP 200).`,
        failure: { status: 200 },
      })
      expect(fetchImpl).toHaveBeenCalledOnce()
    })

    it.each([new TypeError('body transport failed'), new DOMException('body aborted', 'AbortError')])(
      'preserves a non-JSON body-read failure: %s', async (failure) => {
        const client = new DeepSeekFilesClient({ baseURL: 'https://files.example', headers: { 'x-api-key': 'test-key' },
          fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(failure) } })),
        })
        await expect(client.retrieve(DeepSeekFileId('file-api-one'))).rejects.toBe(failure)
      },
    )
  })

  it('uploads Messages files beneath the literal configured root and bounds reuse without expiry metadata', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(url)).toBe('https://gateway.example/custom/route/v1/files')
      const headers = new Headers(init?.headers)
      expect(headers.get('x-api-key')).toBe('key')
      expect(headers.get('anthropic-version')).toBe('2023-06-01')
      expect(headers.get('anthropic-beta')).toBe('files-api-2025-04-14')
      expect(headers.has('authorization')).toBe(false)
      const form = init?.body as FormData
      expect(form.get('purpose')).toBeNull()
      expect(form.get('expires_after[anchor]')).toBe('created_at')
      expect(form.get('expires_after[seconds]')).toBe('3600')
      return new Response(JSON.stringify(file()))
    }) as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://gateway.example/custom/route///', headers: { 'x-api-key': 'key' }, fetch: fetchImpl })
    const uploaded = await client.upload({ data: Uint8Array.of(1, 2, 3), mediaType: 'image/png', filename: 'image.png', expiresAfterSeconds: 3_600 })
    const createdAt = Math.floor(Date.parse('2023-11-14T22:13:20.000Z') / 1_000)
    expect(uploaded).toEqual({ id: 'file-api-one', bytes: 3, createdAt, filename: 'image.png', expiresAt: createdAt + 3_600 })
  })

  it.each([
    ['https://provider.example/anthropic/v1', 'https://provider.example/anthropic/v1/files'],
    ['https://provider.example/v1beta/', 'https://provider.example/v1beta/v1/files'],
  ])('resolves the Messages Files endpoint from %s', async (baseURL, expected) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(file())))
    const client = new DeepSeekFilesClient({ baseURL, headers: { 'x-api-key': 'key' }, fetch: fetchImpl })

    await client.upload({
      data: Uint8Array.of(1, 2, 3), mediaType: 'image/png', filename: 'image.png', expiresAfterSeconds: 3_600,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(requestUrl(fetchImpl.mock.calls[0]![0])).toBe(expected)
  })

  it('maps Messages list cursors, file metadata and deletion with native metadata', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      if (url.search) {
        expect(Object.fromEntries(url.searchParams)).toEqual({ after_id: 'file-before', limit: '1000' })
        return new Response(JSON.stringify({ data: [file()], first_id: 'file-api-one', last_id: 'file-api-one', has_more: false }))
      }
      expect(url.pathname).toBe('/anthropic/v1/files/file-api-one')
      return new Response(JSON.stringify(init?.method === 'DELETE' ? { id: 'file-api-one', type: 'file_deleted' } : file()))
    }) as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com/anthropic', headers: { 'x-api-key': 'key' }, fetch: fetchImpl })
    await expect(client.list({ after: DeepSeekFileId('file-before'), limit: 1_000 })).resolves.toMatchObject({ data: [{ bytes: 3 }], hasMore: false })
    await expect(client.retrieve(DeepSeekFileId('file-api-one'))).resolves.toMatchObject({ id: 'file-api-one', bytes: 3 })
    await expect(client.delete(DeepSeekFileId('file-api-one'))).resolves.toBeUndefined()
  })

  it('accepts an empty Messages list with null cursors', async () => {
    const client = new DeepSeekFilesClient({ baseURL: 'https://gateway.example', headers: { 'x-api-key': 'key' },
      fetch: async () => new Response(JSON.stringify({ data: [], first_id: null, last_id: null, has_more: false })),
    })
    await expect(client.list()).resolves.toEqual({ data: [], hasMore: false })
  })

  it.each(['first_id', 'last_id'])('rejects a Messages list with a numeric %s', async (cursor) => {
    const client = new DeepSeekFilesClient({ baseURL: 'https://gateway.example', headers: { 'x-api-key': 'key' },
      fetch: async () => new Response(JSON.stringify({ data: [], first_id: null, last_id: null, has_more: false, [cursor]: 1 })),
    })
    await expect(client.list()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('refuses a redirected Files request before contacting another origin', async ({ onTestFinished }) => {
    const forwarded: string[] = []
    const origins: string[] = []
    const destination = createServer((request, response) => {
      forwarded.push(String(request.headers['x-api-key'] ?? request.headers.authorization))
      response.end(JSON.stringify(file()))
    })
    const source = createServer((_request, response) => {
      response.writeHead(307, { location: `${origins[0]}/file-api-one` })
      response.end()
    })
    for (const server of [destination, source]) {
      server.listen(0, '127.0.0.1')
      onTestFinished(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error)
            else resolve()
          })
        })
      })
      await once(server, 'listening')
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('expected a TCP server address')
      origins.push(`http://127.0.0.1:${address.port}`)
    }
    const client = new DeepSeekFilesClient({ baseURL: origins[1]!, headers: { 'x-api-key': 'redirect-test-key' } })
    const error = await client.retrieve(DeepSeekFileId('file-api-one')).catch((cause: unknown) => cause)
    expect(forwarded).toEqual([])
    expect(error).toMatchObject({ code: 'TRANSPORT' })
  })

  it.each([null, [], { type: 'wrong' }, { mime_type: null }, { created_at: 'invalid' }, { created_at: 123 }, { size_bytes: -1 }])('rejects malformed Messages file metadata %#', async (value) => {
    const client = new DeepSeekFilesClient({ baseURL: 'https://gateway.example', headers: { 'x-api-key': 'key' },
      fetch: async () => new Response(JSON.stringify(value === null || Array.isArray(value) ? value : file(value))),
    })
    await expect(client.retrieve(DeepSeekFileId('file-api-one'))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects a Messages deletion that returns a different file identity', async () => {
    const client = new DeepSeekFilesClient({ baseURL: 'https://gateway.example', headers: { 'x-api-key': 'key' },
      fetch: async () => new Response(JSON.stringify({ id: 'wrong', type: 'file_deleted' })),
    })
    await expect(client.delete(DeepSeekFileId('file-api-one'))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('uploads multipart bytes with attribution and explicit expiry', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(url)).toBe('https://api.deepseek.com/v1/files')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      const headers = new Headers(init?.headers)
      expect(headers.get('x-api-key')).toBe('key')
      expect(headers.get('user-agent')).toBe(userAgent())
      const form = init?.body
      expect(form).toBeInstanceOf(FormData)
      if (!(form instanceof FormData)) throw new Error('expected multipart body')
      expect(form.get('purpose')).toBeNull()
      expect(form.get('expires_after[anchor]')).toBe('created_at')
      expect(form.get('expires_after[seconds]')).toBe('604800')
      const blob = form.get('file')
      expect(blob).toBeInstanceOf(Blob)
      expect((blob as Blob).size).toBe(3)
      return new Response(JSON.stringify(file()), { status: 200 })
    }) as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com/', headers: { 'x-api-key': 'key' }, fetch: fetchImpl })

    await expect(client.upload({
      data: Uint8Array.of(1, 2, 3),
      mediaType: 'image/png',
      filename: 'image.png',
      expiresAfterSeconds: 604_800,
    })).resolves.toEqual({
      id: DeepSeekFileId('file-api-one'),
      bytes: 3,
      createdAt: 1_700_000_000,
      filename: 'image.png',
      expiresAt: 1_700_604_800,
    })
  })

  it('validates list, retrieve, and delete responses', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = requestUrl(url)
      if (target.includes('?')) {
        return new Response(JSON.stringify({
          data: [file()], first_id: 'file-api-one', last_id: 'file-api-one', has_more: false,
        }), { status: 200 })
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ id: 'file-api-one', type: 'file_deleted' }), { status: 200 })
      }
      return new Response(JSON.stringify(file()), { status: 200 })
    }) as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com', headers: { 'x-api-key': 'key' }, fetch: fetchImpl })

    await expect(client.list({ after: DeepSeekFileId('file-api-before'), limit: 20 })).resolves.toMatchObject({
      data: [{ id: 'file-api-one' }], firstId: 'file-api-one', lastId: 'file-api-one', hasMore: false,
    })
    await expect(client.retrieve(DeepSeekFileId('file-api-one'))).resolves.toMatchObject({ id: 'file-api-one' })
    await expect(client.delete(DeepSeekFileId('file-api-one'))).resolves.toBeUndefined()
  })

  it('retains quota error detail for the one cleanup retry policy', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: { message: 'user storage quota exceeded', type: 'invalid_request_error', code: 'file_quota' },
    }), { status: 400 }))) as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com', headers: { 'x-api-key': 'key' }, fetch: fetchImpl })

    const error = await client.upload({
      data: Uint8Array.of(1), mediaType: 'image/png', filename: 'image.png', expiresAfterSeconds: 3_600,
    }).catch((caught: unknown) => caught)
    expect(isFilesQuotaError(error)).toBe(true)
    expect(isFilesQuotaError(new Error('storage quota'))).toBe(false)
  })

  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [400, 'FILES_API'],
  ] as const)('classifies HTTP %i Files failures as %s', async (status, code) => {
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com',
      headers: { 'x-api-key': 'key' },
      fetch: vi.fn(() => Promise.resolve(new Response('not-json', { status }))),
    })
    await expect(client.retrieve(DeepSeekFileId('missing'))).rejects.toMatchObject({
      name: 'DeepSeekFilesError',
      code,
      detail: '',
    })
  })

  it.each([
    null,
    [],
    {},
    { error: null },
    { error: [] },
    { error: { message: 1, type: 2, code: 3 } },
  ])('falls back to the HTTP status for an unstructured provider error %#', async (body) => {
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com',
      headers: { 'x-api-key': 'key' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 400 }))),
    })
    const error = await client.retrieve(DeepSeekFileId('missing')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DeepSeekFilesError)
    expect(error).toMatchObject({ message: 'DeepSeek Files API error (HTTP 400)', detail: '' })
  })

  it('wraps transport failures but preserves an aborted request reason', async () => {
    const transport = new Error('socket closed')
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com',
      headers: { 'x-api-key': 'key' },
      fetch: vi.fn(() => Promise.reject(transport)),
    })
    await expect(client.retrieve(DeepSeekFileId('one'))).rejects.toMatchObject({
      code: 'TRANSPORT',
      cause: transport,
    })

    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    await expect(client.retrieve(DeepSeekFileId('one'), controller.signal)).rejects.toBe(transport)
  })

  it.each([
    null,
    [],
    file({ id: 1 }),
    file({ id: '' }),
    file({ type: 'wrong' }),
    file({ size_bytes: 1.5 }),
    file({ size_bytes: -1 }),
    file({ created_at: 1.5 }),
    file({ created_at: -1 }),
    file({ filename: 1 }),
    file({ filename: '' }),
  ])('rejects an invalid file object %#', async (body) => {
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com',
      headers: { 'x-api-key': 'key' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))),
    })
    await expect(client.retrieve(DeepSeekFileId('one'))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each([
    3_599,
    2_592_001,
    3_600.5,
  ])('refuses invalid file expiry %s before transport', async (expiresAfterSeconds) => {
    const fetchImpl = vi.fn() as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com', headers: { 'x-api-key': 'key' }, fetch: fetchImpl })
    await expect(client.upload({
      data: Uint8Array.of(1), mediaType: 'image/png', filename: 'image.png', expiresAfterSeconds,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a file larger than the upload limit before transport', async () => {
    const fetchImpl = vi.fn() as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com', headers: { 'x-api-key': 'key' }, fetch: fetchImpl })
    const data = { byteLength: MAX_FILE_UPLOAD_BYTES + 1 } as Uint8Array
    await expect(client.upload({
      data, mediaType: 'image/png', filename: 'image.png', expiresAfterSeconds: 3_600,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    {},
    { data: null, has_more: false },
    { data: [], has_more: 0 },
    { data: [], has_more: false, first_id: 1 },
    { data: [], has_more: false, last_id: 1 },
  ])('rejects an invalid list response %#', async (body) => {
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com',
      headers: { 'x-api-key': 'key' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))),
    })
    await expect(client.list()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('accepts a list without cursors and uses the global fetch default', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      data: [], has_more: false,
    }), { status: 200 })))
    vi.stubGlobal('fetch', fetchImpl)
    try {
      const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com///', headers: { 'x-api-key': 'key' } })
      await expect(client.list()).resolves.toEqual({ data: [], hasMore: false })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    null,
    [],
    {},
    { id: 'wrong', type: 'file_deleted' },
    { id: 'file-api-one', type: 'wrong' },
  ])('rejects an invalid delete response %#', async (body) => {
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com',
      headers: { 'x-api-key': 'key' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))),
    })
    await expect(client.delete(DeepSeekFileId('file-api-one'))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})

it('authenticates Files with the raw DSH token', async () => {
  const client = new DeepSeekFilesClient({
    baseURL: 'https://api.deepseek.com', headers: { 'x-dsh-auth-token': 'account-token' },
    fetch: (_url, init) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('x-dsh-auth-token')).toBe('account-token')
      expect(headers.has('authorization')).toBe(false)
      expect(headers.has('x-api-key')).toBe(false)
      return Promise.resolve(new Response(JSON.stringify({ object: 'list', data: [], has_more: false }), { status: 200 }))
    },
  })
  await client.list()
})
