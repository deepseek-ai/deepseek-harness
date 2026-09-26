/** Invocation ownership remains generic, idempotent, and shared across bundles. */
import { describe, expect, it, vi } from 'vitest'
import { isTypertOwnedValue, TYPERT_OWNED_VALUE, typertOwnedValue } from '../src/owned-value.ts'

describe('TypertOwnedValue', () => {
  it('preserves its value and releases once across explicit and scoped disposal', () => {
    const value = { context: 'owned' }
    const release = vi.fn()
    {
      using owned = typertOwnedValue(value, release)
      expect(owned.value).toBe(value)
      expect(isTypertOwnedValue(owned)).toBe(true)
      owned[Symbol.dispose]()
      owned[Symbol.dispose]()
    }
    expect(release).toHaveBeenCalledOnce()
  })

  it('recognizes a separately produced marker without accepting false markers or borrowed values', () => {
    expect(TYPERT_OWNED_VALUE).toBe(Symbol.for('dsh.typert.owned-value'))
    const siblingBundle = { [Symbol.for('dsh.typert.owned-value')]: true, value: {}, [Symbol.dispose]() {} }
    expect(isTypertOwnedValue(siblingBundle)).toBe(true)
    for (const value of [undefined, null, 1, {}, { [Symbol.for('dsh.typert.owned-value')]: false }]) {
      expect(isTypertOwnedValue(value)).toBe(false)
    }
  })
})
