/** HTML URL decoding stays local; workspace reads leave path resolution and authorization to the Host. */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { createReadHtmlRelative } from '../src/client/html/read-relative.ts'
import type { ReadHtmlRelated } from '../src/client/html/read-relative.ts'

const ADDRESS = 'dsh-resource://file/session/html/sub/index.html'

describe('HTML relative file reader', () => {
  it('decodes a relative URL once and preserves the returned bytes', async () => {
    const value = { absolutePath: '/workspace/a b.js', data: new Uint8Array([120]), version: 'v1', offset: 0, bytes: 1, eof: true }
    const readRelated = vi.fn<ReadHtmlRelated>().mockResolvedValue({ ok: true, value })
    const tab = new AbortController()
    const loading = new AbortController()
    const addResource = vi.fn()
    const read = createReadHtmlRelative(readRelated, ADDRESS, tab.signal, addResource)
    await expect(read('../a%20b.js?v=1#fragment', loading.signal)).resolves.toBe(value)
    const signal = readRelated.mock.calls[0]?.[2]
    expect(readRelated).toHaveBeenCalledExactlyOnceWith(ADDRESS, '../a b.js', signal)
    expect(addResource).toHaveBeenCalledExactlyOnceWith(sessionFileAddress('html', value.absolutePath))
    expect(signal?.aborted).toBe(false)
    tab.abort()
    expect(signal?.aborted).toBe(true)
  })

  it('observes the Host-resolved dependency instead of a symlink and parent-segment spelling', async () => {
    const value = { absolutePath: '/workspace/style.css', data: new TextEncoder().encode('x'), version: 'v1', offset: 0, bytes: 1, eof: true }
    const readRelated = vi.fn<ReadHtmlRelated>().mockResolvedValue({ ok: true, value })
    const addResource = vi.fn()
    const signal = new AbortController().signal
    await createReadHtmlRelative(readRelated, ADDRESS, signal, addResource)('linked/../style.css', signal)
    expect(addResource).toHaveBeenCalledExactlyOnceWith(sessionFileAddress('html', value.absolutePath))
  })

  it('observes the Host-reported missing path so creation can invalidate the preview', async () => {
    const path = '/workspace/missing.css'
    const readRelated = vi.fn<ReadHtmlRelated>().mockResolvedValue({
      ok: false, error: new RemoteError('workspace-file/not-found', 'Missing dependency', { path }),
    })
    const addResource = vi.fn()
    const signal = new AbortController().signal
    await expect(createReadHtmlRelative(readRelated, ADDRESS, signal, addResource)('linked/../missing.css', signal))
      .rejects.toThrow('Missing dependency')
    expect(addResource).toHaveBeenCalledExactlyOnceWith(sessionFileAddress('html', path))
  })

  it('does not guess a dependency path when the Host failure contains none', async () => {
    const readRelated = vi.fn<ReadHtmlRelated>().mockResolvedValue({
      ok: false, error: new RemoteError('gateway/internal', 'Read failed', {}),
    })
    const addResource = vi.fn()
    const signal = new AbortController().signal
    await expect(createReadHtmlRelative(readRelated, ADDRESS, signal, addResource)('asset.css', signal)).rejects.toThrow('Read failed')
    expect(addResource).not.toHaveBeenCalled()
  })

  it('refuses non-relative references and preserves Host permission failures', async () => {
    const readRelated = vi.fn<ReadHtmlRelated>().mockResolvedValue({
      ok: false, error: new RemoteError('workspace-file/outside-workspace', 'outside workspace', { path: '../x.js' }),
    })
    const signal = new AbortController().signal
    const read = createReadHtmlRelative(readRelated, ADDRESS, signal, vi.fn())
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
    const read = createReadHtmlRelative(readRelated, ADDRESS, controller.signal, vi.fn())
    await expect(read('x.js', new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(readRelated).not.toHaveBeenCalled()
  })

  it('rejects bytes that arrive after this packing request is cancelled', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<ReadHtmlRelated>>>()
    const readRelated = vi.fn<ReadHtmlRelated>().mockReturnValue(pending.promise)
    const loading = new AbortController()
    const read = createReadHtmlRelative(readRelated, ADDRESS, new AbortController().signal, vi.fn())
    const result = read('./late.js', loading.signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    loading.abort()
    pending.resolve({ ok: true, value: { absolutePath: '/workspace/late.js', version: 'v1', bytes: 1, offset: 0, data: new Uint8Array([1]), eof: true } })
    await rejected
  })
})
