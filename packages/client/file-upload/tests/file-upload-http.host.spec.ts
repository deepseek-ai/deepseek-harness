import { runInNewContext } from 'node:vm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { handleFileUploadHttp } from '../src/http-route.ts'
import type { FileUploads } from '../src/index.ts'

function request(input: {
  method?: string
  sessionId?: string
  name?: string
  contentType?: string
  body?: Uint8Array
} = {}): Request {
  const query = new URLSearchParams()
  if (input.sessionId !== undefined) query.set('sessionId', input.sessionId)
  if (input.name !== undefined) query.set('name', input.name)
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return new Request(`http://host/api/session/uploadFileBinary${suffix}`, {
    method: input.method ?? 'POST',
    headers: input.contentType === undefined ? {} : { 'content-type': input.contentType },
    ...(input.body === undefined ? {} : { body: new Blob([Uint8Array.from(input.body).buffer]) }),
  })
}

function uploads(result: unknown): FileUploads & {
  uploadStream: Mock<FileUploads['uploadStream']>
  uploadedChunks: Uint8Array[]
} {
  const uploadedChunks: Uint8Array[] = []
  const uploadStream = vi.fn<FileUploads['uploadStream']>(async (input) => {
    for await (const chunk of input.data) uploadedChunks.push(chunk)
    return await result as Awaited<ReturnType<FileUploads['uploadStream']>>
  })
  return {
    uploadedChunks,
    uploadStream,
  } as unknown as FileUploads & {
    uploadStream: Mock<FileUploads['uploadStream']>
    uploadedChunks: Uint8Array[]
  }
}

describe('background file upload Fetch route', () => {
  it('accepts one authenticated streaming POST request', async () => {
    const service = uploads(Promise.resolve({}))
    expect((await handleFileUploadHttp(service, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).status).toBe(200)
  })

  it('rejects the wrong method, media type, and missing Session id without storing', async () => {
    const service = uploads(Promise.resolve({}))
    const wrongMethod = await handleFileUploadHttp(service, request({ method: 'GET' }))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const wrongType = await handleFileUploadHttp(service, request({ contentType: 'application/json' }))
    expect(wrongType.status).toBe(415)
    expect(await wrongType.text()).toBe('content type must be application/octet-stream')

    const missingSession = await handleFileUploadHttp(
      service,
      request({ contentType: 'application/octet-stream' }),
    )
    expect(missingSession.status).toBe(400)
    expect(await missingSession.text()).toBe('sessionId is required')
    expect(service.uploadStream).not.toHaveBeenCalled()
  })

  it('stores the request bytes and returns the staged receipt', async () => {
    const value = {
      receiptId: 'receipt-1',
      file: { attachmentId: 'file-1', name: 'large & final.bin', bytes: 4 },
    }
    const service = uploads(Promise.resolve(value))
    const response = await handleFileUploadHttp(service, request({
      sessionId: 's1',
      name: 'large & final.bin',
      contentType: 'application/octet-stream; charset=binary',
      body: Uint8Array.of(1, 2, 3, 4),
    }))
    expect(service.uploadStream).toHaveBeenCalledOnce()
    const upload = service.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1', name: 'large & final.bin' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(service.uploadedChunks).toEqual([Uint8Array.of(1, 2, 3, 4)])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, value })
  })

  it('returns business and internal storage failures and keeps an absent name absent', async () => {
    const business = uploads(Promise.reject(new RemoteError(
      'session/attachment-invalid', 'denied', { reason: 'NOPE' },
    )))
    const businessResponse = await handleFileUploadHttp(business, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))
    expect(business.uploadStream).toHaveBeenCalledOnce()
    const upload = business.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(business.uploadedChunks).toEqual([])
    expect(await businessResponse.json()).toEqual({
      ok: false,
      error: { code: 'session/attachment-invalid', message: 'denied', details: { reason: 'NOPE' } },
    })

    const internal = uploads(Promise.reject(new Error('disk offline')))
    expect(await (await handleFileUploadHttp(internal, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'disk offline', details: {} },
    })

    const foreignError = runInNewContext('new Error("disk exception")') as unknown as Error
    const exception = uploads(Promise.reject(foreignError))
    expect(await (await handleFileUploadHttp(exception, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'Error: disk exception', details: {} },
    })
  })
})
