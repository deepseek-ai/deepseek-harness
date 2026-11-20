/** English display fields shared by model-facing bundle catalogs. */
import type { BundleInfo } from './types.ts'

/**
 * Project the English catalog entry used by on-demand recommendation skills.
 * @param bundle - A bundle reported by the plugin manager.
 * @returns Its name, English display text or manifest fallbacks, and current selection.
 */
export function bundleCatalogEntry(bundle: BundleInfo): { name: string; title: string; description: string; enabled: boolean } {
  const title = bundle.meta?.title ?? bundle.name
  const description = bundle.meta?.description ?? bundle.description ?? ''
  return {
    name: bundle.name,
    title: typeof title === 'string' ? title : title.en,
    description: typeof description === 'string' ? description : description.en,
    enabled: bundle.enabled,
  }
}
