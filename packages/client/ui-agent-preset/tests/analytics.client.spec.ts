/**
 * Analytics categories for picker selections come from the preset id alone:
 * shipped ids map to fixed categories, every other id is `other`, and an
 * unloaded selection has no category.
 */

import { describe, expect, it } from 'vitest'
import { analyticsMode } from '../src/client/analytics.ts'

describe('analyticsMode', () => {
  it.each([
    ['cordis', 'creator'],
    ['ptc', 'ptc'],
    ['minimal', 'minimal'],
    ['standard', 'standard'],
  ] as const)('maps the built-in %s preset id to %s', (id, category) => {
    expect(analyticsMode(id)).toBe(category)
  })

  it('treats any other preset id as other', () => {
    expect(analyticsMode('mine')).toBe('other')
    expect(analyticsMode('private-id')).toBe('other')
  })

  it('has no category before the selection is known', () => {
    expect(analyticsMode('')).toBeUndefined()
  })
})
