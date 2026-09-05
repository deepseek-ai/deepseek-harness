import { describe, expect, it } from 'vitest'
import { fileSizeText } from '../src/file-size.ts'

describe('fileSizeText', () => {
  it('formats bytes and both sides of the KB, MB, and GB rounding thresholds', () => {
    expect(fileSizeText(312)).toBe('312B')
    expect(fileSizeText(4.25 * 1024)).toBe('4.3KB')
    expect(fileSizeText(12.5 * 1024)).toBe('13KB')
    expect(fileSizeText(1.5 * 1024 * 1024)).toBe('1.5MB')
    expect(fileSizeText(12.5 * 1024 * 1024)).toBe('13MB')
    expect(fileSizeText(2447 * 1024 * 1024)).toBe('2.4GB')
    expect(fileSizeText(12.5 * 1024 * 1024 * 1024)).toBe('13GB')
  })
})
