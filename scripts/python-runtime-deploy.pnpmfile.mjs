/** Preserve workspace build approvals when pnpm deploy converts local dependencies to file URLs. */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Translate local build identities without changing their approved or denied status.
 * @param {Record<string, unknown> & { allowBuilds?: Record<string, boolean | string> }} config - Source workspace configuration.
 * @returns {Record<string, unknown>} Deployment configuration with exact file URL approvals.
 */
function updateConfig(config) {
  if (config.allowBuilds === undefined) return config
  const allowBuilds = Object.fromEntries(Object.entries(config.allowBuilds).map(([key, value]) => {
    const marker = key.indexOf('@file:')
    if (marker < 0 || key.slice(marker + 6).startsWith('//')) return [key, value]
    const source = resolve(import.meta.dirname, '..', key.slice(marker + 6))
    return [`${key.slice(0, marker + 1)}${pathToFileURL(source).href}`, value]
  }))
  return { ...config, allowBuilds }
}

/** Pnpm configuration hooks scoped to Python runtime deployment. */
export const hooks = { updateConfig }
