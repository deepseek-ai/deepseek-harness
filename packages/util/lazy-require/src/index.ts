/** Caller-relative lazy loading for CommonJS-compatible Host dependencies. */

import { createRequire } from 'node:module'

/**
 * Create a successful-result cache around Node's caller-relative `require`.
 * A failed load is not cached, so a corrected installation can be retried.
 * @param specifier - Literal dependency specifier declared by the caller package.
 * @param parentURL - Caller's `import.meta.url`, which owns package resolution.
 * @returns a zero-argument loader that resolves the dependency on first use.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- preserves caller-supplied module types
export function createLazyRequire<T>(specifier: string, parentURL: string | URL): () => T {
  const require = createRequire(parentURL)
  let loaded = false
  let value: T
  return () => {
    if (!loaded) {
      value = require(specifier) as T
      loaded = true
    }
    return value
  }
}
