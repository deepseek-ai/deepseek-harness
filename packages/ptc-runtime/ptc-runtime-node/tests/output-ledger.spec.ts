import { PtcImage } from '@deepseek-ai/dsh-ptc-runtime'
import { expect, it } from 'vitest'
import { OutputLedger } from '../src/output-ledger.ts'

it('accounts for exact JSON escaping, separators and optional completion values', () => {
  const ledger = new OutputLedger(20)
  const logs: string[] = []
  expect(ledger.admit('first', logs)).toBe(true)
  expect(ledger.admit('second', logs)).toBe(true)
  expect(ledger.admit('third', logs)).toBe(false)
  expect(ledger.success(logs)).toEqual({ logs: ['first', 'second'] })
  expect(ledger.success(logs, 1)).toEqual({ logs: ['first', 'second'], value: 1 })
  expect(ledger.success(logs, 'too long').error?.kind).toBe('output-limit')
})

it('retains a bounded prefix when logs or a failure diagnostic exceed the limit', () => {
  for (const maxBytes of [4, 8, 40, 80]) {
    const ledger = new OutputLedger(maxBytes)
    const result = ledger.limit(['a', 'b', '你好🙂'.repeat(50)])
    expect(result.error?.kind).toBe('output-limit')
    const bytes = Buffer.byteLength(JSON.stringify(result.logs)) + Buffer.byteLength(JSON.stringify(result.error?.message))
    expect(bytes).toBeLessThanOrEqual(maxBytes)
  }
  const ledger = new OutputLedger(80)
  expect(ledger.failure([], { kind: 'exception', message: 'short' })).toEqual({ logs: [], error: { kind: 'exception', message: 'short' } })
  expect(ledger.failure([], { kind: 'exception', message: 'x'.repeat(100) }).error?.kind).toBe('output-limit')
})


it('charges ordered image descriptors and text against one budget', () => {
  const image = new PtcImage('/image.png', 8, 4)
  const entry = { afterLog: 0, image }
  const bytes = Buffer.byteLength(JSON.stringify([entry]))
  const ledger = new OutputLedger(bytes + 2)
  expect(ledger.admitImage(entry)).toBe(true)
  expect(ledger.admitImage(entry)).toBe(false)
  expect(ledger.admit('text', [])).toBe(false)
  expect(ledger.success([])).toEqual({ logs: [] })
  const multiple = new OutputLedger(bytes * 2 + 2)
  expect(multiple.admitImage(entry)).toBe(true)
  expect(multiple.admitImage(entry)).toBe(true)
})
