/**
 * Proves the vendor test lane itself: `vendor/im/*\/tests/**\/*.spec.ts` is in the
 * default vitest inventory, resolves the package through its source alias, and
 * runs without the coverage gate. Deliberately asserts only that the module
 * loads with exports, so every later rewrite of the vocabulary keeps this green.
 */

import { describe, expect, it } from 'vitest'
import * as satoriElement from '@deepseek-ai/satori-element'

describe('satori-element smoke', () => {
  it('loads the package through the workspace source alias', () => {
    expect(Object.keys(satoriElement).length).toBeGreaterThan(0)
  })
})
