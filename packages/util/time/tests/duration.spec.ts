import { describe, expect, it } from 'vitest'
import { Duration } from '@deepseek-ai/dsh-util-time'

/** Rebuild a span from its own parts, so a wrong split shows up as a wrong total. */
const partSum = (parts: {
  days: number
  hours: number
  minutes: number
  seconds: number
  milliseconds: number
}): number =>
  parts.days * 86_400_000 + parts.hours * 3_600_000
  + parts.minutes * 60_000 + parts.seconds * 1_000 + parts.milliseconds

/** Deterministic span source, so a failure is reproducible from the seed alone. */
const spans = (count: number, seed: number): number[] => {
  const out: number[] = []
  let state = seed
  for (let i = 0; i < count; i += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    out.push((state / 2_147_483_648) * Number.MAX_SAFE_INTEGER)
  }
  return out
}

describe('Duration construction', () => {
  it('accepts a fractional millisecond count and keeps the fraction', () => {
    expect(Duration.fromMilliseconds(1_500.25).decompose())
      .toEqual({ days: 0, hours: 0, minutes: 0, seconds: 1, milliseconds: 500.25 })
  })

  it('accepts the largest exactly representable count', () => {
    const parts = Duration.fromMilliseconds(Number.MAX_SAFE_INTEGER).decompose()
    expect(parts).toEqual({ days: 104_249_991, hours: 8, minutes: 59, seconds: 0, milliseconds: 991 })
    expect(partSum(parts)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('refuses a count that is not a finite number', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => Duration.fromMilliseconds(value)).toThrow(TypeError)
    }
  })

  it('refuses a count above the exactly representable millisecond range', () => {
    expect(() => Duration.fromMilliseconds(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError)
    expect(() => Duration.fromMilliseconds(-Number.MAX_SAFE_INTEGER - 2)).toThrow(TypeError)
    // The bound is what keeps the whole-part identity exact, so it is asserted, not assumed.
    expect(partSum(Duration.fromMilliseconds(Number.MAX_SAFE_INTEGER).decompose()))
      .toBe(Number.MAX_SAFE_INTEGER)
  })

  it('is frozen, and overrides no implicit conversion', () => {
    const span = Duration.fromMilliseconds(1)
    expect(Object.isFrozen(span)).toBe(true)
    expect(Reflect.set(span, 'span', 2)).toBe(false)
    expect(span.decompose().milliseconds).toBe(1)
    // No coercion hook is overridden, so no caller obtains the count by coercion.
    expect(Object.hasOwn(Duration.prototype, 'valueOf')).toBe(false)
    expect(Object.hasOwn(Duration.prototype, 'toString')).toBe(false)
    expect(Object.hasOwn(Duration.prototype, Symbol.toPrimitive)).toBe(false)
  })
})

describe('Duration decompose', () => {
  it('splits a span into floored whole parts and the fractional remainder', () => {
    expect(Duration.fromMilliseconds(0).decompose())
      .toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 })
    expect(Duration.fromMilliseconds(999).decompose())
      .toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 999 })
    expect(Duration.fromMilliseconds(1_000).decompose())
      .toEqual({ days: 0, hours: 0, minutes: 0, seconds: 1, milliseconds: 0 })
    expect(Duration.fromMilliseconds(3_661_999).decompose())
      .toEqual({ days: 0, hours: 1, minutes: 1, seconds: 1, milliseconds: 999 })
    expect(Duration.fromMilliseconds(90_061_500).decompose())
      .toEqual({ days: 1, hours: 1, minutes: 1, seconds: 1, milliseconds: 500 })
    expect(Duration.fromMilliseconds(90_061_500.75).decompose())
      .toEqual({ days: 1, hours: 1, minutes: 1, seconds: 1, milliseconds: 500.75 })
    expect(Duration.fromMilliseconds(86_400_000).decompose())
      .toEqual({ days: 1, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 })
  })

  it('answers frozen parts', () => {
    expect(Object.isFrozen(Duration.fromMilliseconds(3_661_999).decompose())).toBe(true)
  })

  it('keeps the whole-part identity across the accepted range', () => {
    for (let span = 0; span <= 120_000; span += 1) {
      expect(partSum(Duration.fromMilliseconds(span).decompose())).toBe(span)
    }
    for (const span of spans(2_000, 20_260_924)) {
      const parts = Duration.fromMilliseconds(span).decompose()
      expect(partSum(parts)).toBe(span)
      expect(parts.milliseconds).toBeGreaterThanOrEqual(0)
      expect(parts.milliseconds).toBeLessThan(1_000)
      expect(parts.hours).toBeLessThan(24)
      expect(parts.minutes).toBeLessThan(60)
      expect(parts.seconds).toBeLessThan(60)
    }
  })

  it('refuses a negative span instead of inventing a sign policy', () => {
    expect(() => Duration.fromMilliseconds(-1).decompose()).toThrow(RangeError)
    expect(() => Duration.fromMilliseconds(-0.5).decompose()).toThrow(RangeError)
  })
})
