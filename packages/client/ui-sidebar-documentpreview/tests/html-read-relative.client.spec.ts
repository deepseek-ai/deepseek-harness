/** HTML URL decoding stays local; ordinary Remote reads leave path resolution and authorization to the Host. */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createReadHtmlRelative } from '../src/client/html/read-relative.ts'
import type { ReadHtmlRelated } from '../src/client/html/read-relative.ts'

const ADDRESS = 'dsh-resource://file/session/html/sub/index.html'

describe('HTML relative file reader', () => {
  it('decodes a relative URL once and converts the Remote result to native bytes', async () => {
    const value = { absolutePath: '/workspace/a b.js', data: btoa('x'), version: 'v1', offset: 0, bytes: 1, eof: true }
    const readRelated = vi.fn<ReadHtmlRelated>().mockResolvedValue({ ok: true, value })
    const tab = new AbortController()
    const loading = new AbortController()
    const read = createReadHtmlRelative(readRelated, ADDRESS, tab.signal)
    await expect(read('../a%20b.js?v=1#fragment', loading.signal)).resolves.toEqual({ ...value, data: new Uint8Array([120]) })
    const signal = readRelated.mock.calls[0]?.[2]
    expect(readRelated).toHaveBeenCalledExactlyOnceWith(ADDRESS, '../a b.js', signal)
    expect(signal?.aborted).toBe(false)
    tab.abort()
    expect(signal?.aborted).toBe(true)
  })

  it('refuses non-relative references and preserves Host permission failures', async () => {
    const readRelated = vi.fn<ReadHtmlRelated>().mockResolvedValue({
      ok: false, error: new RemoteError('workspace-file/outside-workspace', 'outside workspace', { path: '../x.js' }),
    })
    const signal = new AbortController().signal
    const read = createReadHtmlRelative(readRelated, ADDRESS, signal)
    for (const path of ['', '/x.js', 'file:///x.js', '%2Fx.js', 'C:/x.js', '..\\x.js', '%00.js', '%ZZ.js']) {
      await expect(read(path, signal)).rejects.toThrow()
    }
    expect(readRelated).not.toHaveBeenCalled()
    await expect(read('../x.js', signal)).rejects.toThrow('outside workspace')
  })

  it('does not start an already cancelled read', async () => {
    const controller = new AbortController()
    controller.abort()
    const readRelated = vi.fn<ReadHtmlRelated>()
    const read = createReadHtmlRelative(readRelated, ADDRESS, controller.signal)
    await expect(read('x.js', new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(readRelated).not.toHaveBeenCalled()
  })

  it('rejects bytes that arrive after this packing request is cancelled', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<ReadHtmlRelated>>>()
    const readRelated = vi.fn<ReadHtmlRelated>().mockReturnValue(pending.promise)
    const loading = new AbortController()
    const read = createReadHtmlRelative(readRelated, ADDRESS, new AbortController().signal)
    const result = read('./late.js', loading.signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    loading.abort()
    pending.resolve({ ok: true, value: { absolutePath: '/workspace/late.js', version: 'v1', bytes: 1, offset: 0, data: 'AQ==', eof: true } })
    await rejected
  })
})
