import { describe, expect, expectTypeOf, it } from 'vitest'
import { brandNumber, type BrandedNumber } from '../src/index.ts'

type EventOrdinal = BrandedNumber<'EventOrdinal'>

describe('numeric brands', () => {
  it('brands a number without changing its runtime value', () => {
    const value = brandNumber<EventOrdinal>(7)

    expect(value).toBe(7)
    expectTypeOf(value).toEqualTypeOf<EventOrdinal>()
  })
})
