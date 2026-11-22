import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { formatAgo, formatDuration, formatShortAgo } from '../src/client/format.ts'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(en)

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [499, '0s'],
    [500, '1s'],
    [59_400, '59s'],
    [59_500, '1m 0s'],
    [65_000, '1m 5s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '1h 0m'],
    [3_659_000, '1h 0m'],
    [3_660_000, '1h 1m'],
    [90_061_000, '25h 1m'],
  ])('formats %i ms as %s', (ms, text) => {
    expect(formatDuration(ms, t)).toBe(text)
  })

  it('uses the dictionary of the current language', () => {
    expect(formatDuration(65_000, makeTranslate(zh))).toBe('1 分 5 秒')
  })
})

describe('formatAgo', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')

  it.each([
    ['2026-10-09T11:59:30Z', 'just now'],
    ['2026-10-09T11:55:00Z', '5 min ago'],
    ['2026-10-09T09:00:00Z', '3 h ago'],
    ['2026-10-07T12:00:00Z', '2 d ago'],
    ['2026-06-01T12:00:00Z', '4 mo ago'],
    ['2024-10-09T12:00:00Z', '2 y ago'],
    ['2026-10-09T12:30:00Z', 'just now'],
  ])('dates %s relative to noon', (iso, text) => {
    expect(formatAgo(iso, now, t)).toBe(text)
  })

  it('dates nothing when the time does not parse', () => {
    expect(formatAgo('not a time', now, t)).toBeUndefined()
  })
})

describe('formatShortAgo', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')

  it.each([
    ['2026-10-09T11:59:30Z', 'now'],
    ['2026-10-09T11:55:00Z', '5min'],
    ['2026-10-09T09:00:00Z', '3h'],
    ['2026-10-07T12:00:00Z', '2d'],
    ['2026-06-01T12:00:00Z', '4mo'],
    ['2024-10-09T12:00:00Z', '2y'],
  ])('dates %s relative to noon in the one-line form', (iso, text) => {
    expect(formatShortAgo(iso, now, t)).toBe(text)
  })

  it('uses the dictionary of the current language', () => {
    expect(formatShortAgo('2026-10-09T11:55:00Z', now, makeTranslate(zh))).toBe('5分钟')
  })

  it('dates nothing when the time does not parse', () => {
    expect(formatShortAgo('not a time', now, t)).toBeUndefined()
  })
})
