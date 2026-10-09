import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { readBoundedUtf8Body } from '../src/body.ts'

/** Minimal async-iterable request for byte-level branches Node fetch cannot construct. */
function request(options: {
  chunks?: Array<Buffer | string>
  contentLength?: string
  complete?: boolean
  error?: unknown
} = {}): IncomingMessage & { resume: ReturnType<typeof vi.fn> } {
  const resume = vi.fn()
  return {
    headers: {
      ...(options.contentLength === undefined ? {} : { 'content-length': options.contentLength }),
    },
    complete: options.complete ?? true,
    resume,
    async * [Symbol.asyncIterator]() {
      for (const chunk of options.chunks ?? []) yield chunk
      if (options.error !== undefined) throw options.error
    },
  } as unknown as IncomingMessage & { resume: ReturnType<typeof vi.fn> }
}

describe('bounded webhook body intake', () => {
  it('accepts an absent length and both Buffer and string chunks', async () => {
    await expect(readBoundedUtf8Body(request({ chunks: [Buffer.from('{'), '}'] }), 2)).resolves.toBe('{}')
  })

  it('rejects malformed, unsafe, and oversized declared lengths', async () => {
    await expect(readBoundedUtf8Body(request({ contentLength: '01' }), 10)).rejects.toMatchObject({ status: 400 })
    await expect(readBoundedUtf8Body(request({ contentLength: '999999999999999999999' }), Number.MAX_SAFE_INTEGER))
      .rejects.toMatchObject({ status: 413 })
    const oversized = request({ contentLength: '3' })
    await expect(readBoundedUtf8Body(oversized, 2)).rejects.toMatchObject({ status: 413 })
    expect(oversized.resume).toHaveBeenCalledOnce()
  })

  it('rejects a chunked body at the first byte beyond the cap', async () => {
    const streamed = request({ chunks: [Buffer.from('ab'), Buffer.from('c')] })
    await expect(readBoundedUtf8Body(streamed, 2)).rejects.toMatchObject({ status: 413 })
    expect(streamed.resume).toHaveBeenCalledOnce()
  })

  it('normalizes stream failure and incomplete EOF as an aborted body', async () => {
    await expect(readBoundedUtf8Body(request({ error: new Error('socket') }), 10))
      .rejects.toMatchObject({ status: 400, message: 'request body was aborted' })
    await expect(readBoundedUtf8Body(request({ complete: false }), 10))
      .rejects.toMatchObject({ status: 400, message: 'request body was aborted' })
  })

  it('rejects invalid UTF-8 after a complete bounded read', async () => {
    await expect(readBoundedUtf8Body(request({ chunks: [Buffer.from([0xff])] }), 1))
      .rejects.toMatchObject({ status: 400, message: 'request body is not valid UTF-8' })
  })
})
