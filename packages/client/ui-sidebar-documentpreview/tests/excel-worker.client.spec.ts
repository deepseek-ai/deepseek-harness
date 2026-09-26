/** Worker entry translates parser failures into its private response protocol. */
import { afterEach, expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { excelFixture } from './excel-fixture.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('../src/client/excel/convert.ts') })

it('returns parsed sheets and bounded failure categories', async () => {
  const post = vi.fn()
  vi.stubGlobal('postMessage', post)
  vi.stubGlobal('onmessage', null)
  await import('../src/client/excel/worker.ts')
  const handle: (event: MessageEvent) => void = globalThis.onmessage!
  const message = (bytes: Uint8Array<ArrayBuffer>, maxCells = 250_000) => {
    handle({ data: { bytes, format: 'xlsx', limits: { ...Config({}).excel, maxCells } } } as MessageEvent)
  }
  message(await excelFixture())
  await vi.waitFor(() => { expect(post).toHaveBeenCalledWith(expect.objectContaining({ ok: true })) })
  message(new Uint8Array([1, 2]))
  await vi.waitFor(() => { expect(post).toHaveBeenCalledWith({ ok: false, code: 'invalid' }) })
  message(await excelFixture(), 1)
  await vi.waitFor(() => { expect(post).toHaveBeenCalledWith({ ok: false, code: 'tooLarge' }) })
})

it('reports an unexpected parser failure as an invalid workbook', async () => {
  const post = vi.fn()
  vi.stubGlobal('postMessage', post)
  vi.stubGlobal('onmessage', null)
  vi.doMock('../src/client/excel/convert.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/client/excel/convert.ts')>()
    return { ...original, convertExcel: vi.fn().mockRejectedValue(new Error('parser crashed')) }
  })
  await import('../src/client/excel/worker.ts')
  const handle: (event: MessageEvent) => void = globalThis.onmessage!
  handle({ data: { bytes: new Uint8Array(), format: 'xlsx', limits: Config({}).excel } } as MessageEvent)
  await vi.waitFor(() => { expect(post).toHaveBeenCalledWith({ ok: false, code: 'invalid' }) })
})
