/** Fixed analytics categories for the picker; custom preset ids never leave this package. */
import type { AnalyticsPreset } from '@deepseek-ai/dsh-client-product-analytics/client'

/** Resolve a known selection by preset id without treating an unloaded state as a default.
 * @param id - selected preset id; an empty id means unknown.
 * @returns the built-in category for a shipped id, other for any other id, or undefined until known.
 */
export function analyticsMode(id: string): AnalyticsPreset | 'other' | undefined {
  if (id === '') return undefined
  switch (id) {
    case 'cordis': return 'creator'
    case 'ptc': return 'ptc'
    case 'minimal': return 'minimal'
    case 'standard': return 'standard'
    default: return 'other'
  }
}
