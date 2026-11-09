import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { expect, it } from 'vitest'
import type { PtcOutput } from '@deepseek-ai/dsh-ptc-runtime'
import { OutputLedger } from '../src/output-ledger.ts'

it('accounts for exact JSON escaping, separators and optional completion values', () => {
  const ledger = new OutputLedger(20)
  const output: PtcOutput[] = []
  expect(ledger.admit({ type: 'text', text: 'first' }, output)).toBe(true)
  expect(ledger.admit({ type: 'text', text: 'second' }, output)).toBe(true)
  expect(ledger.admit({ type: 'text', text: 'third' }, output)).toBe(false)
  expect(ledger.success(output)).toEqual({ output: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] })
  expect(ledger.success(output, 1)).toEqual({ output: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }], value: 1 })
  expect(ledger.success(output, 'too long').error?.kind).toBe('output-limit')
})

it('retains a bounded prefix when logs or a failure diagnostic exceed the limit', () => {
  for (const maxBytes of [4, 8, 40, 80]) {
    const ledger = new OutputLedger(maxBytes)
    const result = ledger.limit(['a', 'b', '你好🙂'.repeat(50)].map(text => ({ type: 'text', text })))
    expect(result.error?.kind).toBe('output-limit')
    const bytes = Buffer.byteLength(JSON.stringify(result.output.filter(block => block.type === 'text').map(block => block.text))) + Buffer.byteLength(JSON.stringify(result.error?.message))
    expect(bytes).toBeLessThanOrEqual(maxBytes)
  }
  const ledger = new OutputLedger(80)
  expect(ledger.failure([], { kind: 'exception', message: 'short' })).toEqual({ output: [], error: { kind: 'exception', message: 'short' } })
  expect(ledger.failure([], { kind: 'exception', message: 'x'.repeat(100) }).error?.kind).toBe('output-limit')
})


it('charges ordered image descriptors and text against one budget', () => {
  const attachment = { attachmentId: AttachmentId('sha256:image'), mediaType: 'image/png' as const, bytes: 64, width: 8, height: 4 }
  const entry: PtcOutput = { type: 'image', attachment }
  const bytes = Buffer.byteLength(JSON.stringify([entry]))
  const ledger = new OutputLedger(bytes)
  const output: PtcOutput[] = []
  expect(ledger.admit(entry, output)).toBe(true)
  expect(ledger.admit(entry, output)).toBe(false)
  expect(ledger.admit({ type: 'text', text: 'text' }, output)).toBe(false)
  expect(ledger.success(output)).toEqual({ output: [entry] })
  const multiple = new OutputLedger(Buffer.byteLength(JSON.stringify([entry, entry])))
  expect(multiple.admit(entry, [])).toBe(true)
  expect(multiple.admit(entry, [])).toBe(true)
})
