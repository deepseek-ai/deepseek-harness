/** Browser-use provider identities. @module @deepseek-ai/dsh-browser-use/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Provider-owned name identifying a browser-use registration. */
export type BrowserUseProviderName = Branded<'BrowserUseProviderName'>

/**
 * Brand a provider-owned name without changing or validating it.
 * @param name - name chosen by the provider implementation.
 * @returns the same name with its browser-use provider brand.
 */
export function BrowserUseProviderName(name: string): BrowserUseProviderName {
  return name as BrowserUseProviderName
}
