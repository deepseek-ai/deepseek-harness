import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { expect, it } from 'vitest'
import type { PtcOutput, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { OutputLedger } from '../src/output-ledger.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

function bytes(result: PtcRunResult): number {
  return Buffer.byteLength(JSON.stringify(result.output.map(block => block.type === 'text' ? block.text : block)))
    + (result.error ? Buffer.byteLength(JSON.stringify(result.error.message))
      : result.value === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.value)))
}

it('retains a prefix and gives the completion priority within the combined cap', () => {
  const ledger = new OutputLedger(20)
  const output: PtcOutput[] = []
  expect(ledger.admit({ type: 'text', text: 'first' }, output)).toBe(true)
  expect(ledger.admit({ type: 'text', text: 'second' }, output)).toBe(true)
  expect(ledger.admit({ type: 'text', text: 'third' }, output)).toBe(false)
  expect(ledger.success(output)).toEqual({ output, outputTruncated: true })
  expect(ledger.success(output, 1)).toEqual({ output, value: 1, outputTruncated: true })
  expect(ledger.success(output, 'too long')).toEqual({ output: [output[0]], value: 'too long', outputTruncated: true })
  expect(ledger.success(output, 'x'.repeat(20)).error?.kind).toBe('output-limit')
})

it.each([4, 8, 40, 80])('bounds multibyte output and diagnostics without losing failure kinds at %s bytes', (maxBytes) => {
  const ledger = new OutputLedger(maxBytes)
  const output: PtcOutput[] = []
  ledger.admit({ type: 'text', text: '你好🙂'.repeat(50) }, output)
  const success = ledger.success(output)
  expect(success.error).toBeUndefined()
  expect(success.outputTruncated).toBe(true)
  expect(bytes(success)).toBeLessThanOrEqual(maxBytes)
  for (const kind of ['exception', 'timeout', 'abort', 'protocol', 'worker-exit'] as const) {
    const failure = ledger.failure(output, { kind, message: '失败🙂'.repeat(50) })
    expect(failure.error?.kind).toBe(kind)
    expect(failure.outputTruncated).toBe(true)
    expect(bytes(failure)).toBeLessThanOrEqual(maxBytes)
  }
})

it('leaves fitting output and diagnostics unchanged', () => {
  const ledger = new OutputLedger(80)
  expect(ledger.success([])).toEqual({ output: [] })
  expect(ledger.failure([], { kind: 'exception', message: 'short' })).toEqual({ output: [], error: { kind: 'exception', message: 'short' } })
  const output: PtcOutput[] = []
  expect(ledger.admit({ type: 'text', text: 'x'.repeat(76) }, output)).toBe(true)
  expect(bytes(ledger.success(output))).toBe(80)
})

it('keeps whole images in emission order and drops everything after an oversized entry', () => {
  const entry: PtcOutput = { type: 'image', attachment: {
    attachmentId: brandString<AttachmentId>('sha256:image'), mediaType: 'image/png', bytes: 64, width: 8, height: 4,
  } }
  const size = Buffer.byteLength(JSON.stringify([entry]))
  const ledger = new OutputLedger(size)
  const output: PtcOutput[] = []
  expect(ledger.admit(entry, output)).toBe(true)
  expect(ledger.admit(entry, output)).toBe(false)
  expect(ledger.admit({ type: 'text', text: 'text' }, output)).toBe(false)
  expect(ledger.success(output)).toEqual({ output: [entry], outputTruncated: true })
  expect(ledger.success(output, 1)).toEqual({ output: [], value: 1, outputTruncated: true })
  const multiple = new OutputLedger(Buffer.byteLength(JSON.stringify([entry, entry])))
  expect(multiple.admit(entry, [])).toBe(true)
  expect(multiple.admit(entry, [])).toBe(true)
})
