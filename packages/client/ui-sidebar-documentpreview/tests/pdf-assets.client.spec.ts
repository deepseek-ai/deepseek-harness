/** PDF binary resources are exact-name, local data with independent transferable buffers. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPdfBinaryDataFactory, type PdfAssetMap } from '../src/client/pdf/assets.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('PDF binary assets', () => {
  const assets: PdfAssetMap = {
    cMapUrl: { 'sample.bcmap': 'AQID' },
    standardFontDataUrl: { 'font.pfb': 'BAU=' },
    wasmUrl: { 'decoder.wasm': 'BgcI' },
  }

  it('reads the ambient build payload only when the factory is created', async () => {
    vi.stubGlobal('__DSH_PDFJS_ASSETS__', assets)
    const Factory = createPdfBinaryDataFactory()
    const factory = new Factory()
    expect(Array.from(await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' }))).toEqual([1, 2, 3])
    expect(Array.from(await factory.fetch({ kind: 'standardFontDataUrl', filename: 'font.pfb' }))).toEqual([4, 5])
    expect(Array.from(await factory.fetch({ kind: 'wasmUrl', filename: 'decoder.wasm' }))).toEqual([6, 7, 8])
  })

  it('never shares a buffer that PDF.js may transfer away', async () => {
    const Factory = createPdfBinaryDataFactory(assets)
    const factory = new Factory()
    const first = await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' })
    structuredClone(first, { transfer: [first.buffer] })
    expect(first.byteLength).toBe(0)
    expect(Array.from(await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' }))).toEqual([1, 2, 3])
  })

  it.each(['../font.pfb', 'missing.bcmap', 'toString'])('rejects unbundled filename %s without fetching', async (filename) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const Factory = createPdfBinaryDataFactory(assets)
    await expect(new Factory().fetch({ kind: 'cMapUrl', filename })).rejects.toThrow('not bundled')
    expect(fetch).not.toHaveBeenCalled()
  })
})
