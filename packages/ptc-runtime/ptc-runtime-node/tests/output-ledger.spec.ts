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
