/** Parser Worker allocation, cancellation, timeout, and message failures. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseExcel } from '../src/client/excel/parse.ts'
import { Config } from '../src/config.ts'

const limits = Config({}).excel
const preview = { sheets: [{ name: 'Sheet', celldata: [] }], missingResults: 0, unsupportedFeatures: ['charts'] }
let instance: ParserWorker
const revokeUrl = vi.fn()

class ParserWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn<(message: { bytes: Uint8Array<ArrayBuffer> }, transfer: Transferable[]) => void>()
  terminate = vi.fn()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', vi.fn(function () { instance = new ParserWorker(); return instance }))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:excel-test')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeUrl)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); revokeUrl.mockClear() })

it('transfers a private copy and releases the Worker and URL after parsing', async () => {
  const input = new Uint8Array([1, 2, 3])
  const result = parseExcel(input, 'xlsx', limits, new AbortController().signal)
  const [message, transfer] = instance.postMessage.mock.calls[0]!
  expect(message.bytes).toEqual(input)
  expect(message.bytes).not.toBe(input)
  expect(transfer).toEqual([message.bytes.buffer])
  instance.onmessage!({ data: { ok: true, value: preview } })
  await expect(result).resolves.toEqual(preview)
  expect(instance.terminate).toHaveBeenCalledOnce()
  expect(revokeUrl).toHaveBeenCalledWith('blob:excel-test')
  expect(vi.getTimerCount()).toBe(0)
})

it('does not allocate a Worker for aborted or oversized input', async () => {
  const worker = vi.fn()
  vi.stubGlobal('Worker', worker)
  expect(() => parseExcel(new Uint8Array(), 'xlsx', limits, AbortSignal.abort())).toThrow()
  await expect(parseExcel(new Uint8Array(2), 'xlsx', { ...limits, maxBytes: 1 }, new AbortController().signal)).rejects.toThrow('tooLarge')
  expect(worker).not.toHaveBeenCalled()
})

it('cancels an active parser without retaining callbacks or timers', async () => {
  const controller = new AbortController()
  const result = parseExcel(new Uint8Array(), 'xlsx', limits, controller.signal)
  const rejection = expect(result).rejects.toThrow('closed')
  controller.abort(new Error('closed'))
  await rejection
  expect(instance.terminate).toHaveBeenCalledOnce()
  expect(instance.onmessage).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('terminates a parser that exceeds its time budget', async () => {
  const result = parseExcel(new Uint8Array(), 'xlsx', limits, new AbortController().signal)
  const rejection = expect(result).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(limits.timeoutMs)
  await rejection
  expect(instance.terminate).toHaveBeenCalledOnce()
})

it.each([null, 7, {}, { ok: true, value: null }, { ok: true, value: { sheets: [], missingResults: 0 } },
  { ok: true, value: { sheets: [{}], missingResults: 0 } }, { ok: true, value: { ...preview, missingResults: -1 } },
  { ok: true, value: { ...preview, unsupportedFeatures: undefined } },
  { ok: true, value: { ...preview, unsupportedFeatures: ['unknown'] } },
  { ok: true, value: { ...preview, unsupportedFeatures: [7] } },
  { ok: false, code: 'surprise' }, { ok: false, code: 'invalid' }])('rejects invalid Worker message %j', async (data) => {
  const result = parseExcel(new Uint8Array(), 'xlsx', limits, new AbortController().signal)
  instance.onmessage!({ data })
  await expect(result).rejects.toThrow('invalid')
  expect(instance.terminate).toHaveBeenCalledOnce()
})

it.each(['onerror', 'onmessageerror'] as const)('releases a failed parser on %s', async (event) => {
  const result = parseExcel(new Uint8Array(), 'xlsx', limits, new AbortController().signal)
  instance[event]!()
  await expect(result).rejects.toThrow('invalid')
  expect(instance.terminate).toHaveBeenCalledOnce()
})

it('revokes the URL when Worker construction fails', async () => {
  vi.stubGlobal('Worker', vi.fn(function () { throw new Error('unavailable') }))
  await expect(parseExcel(new Uint8Array(), 'xlsx', limits, new AbortController().signal)).rejects.toThrow('invalid')
  expect(revokeUrl).toHaveBeenCalledOnce()
})

it('terminates the Worker when posting the copied buffer fails', async () => {
  vi.stubGlobal('Worker', vi.fn(function () {
    instance = new ParserWorker()
    instance.postMessage.mockImplementation(() => { throw new Error('transfer failed') })
    return instance
  }))
  await expect(parseExcel(new Uint8Array(), 'xlsx', limits, new AbortController().signal)).rejects.toThrow('invalid')
  expect(instance.terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
