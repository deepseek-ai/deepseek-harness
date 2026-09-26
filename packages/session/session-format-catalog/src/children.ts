/** Bind parent-specific child evidence into the static first-party migration inventory. */

import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCatalog, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatV3ToV4, sessionFormatV3ToV4 } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { sessionFormatCatalogOptions } from './generated.ts'

/**
 * Assemble a catalog whose V3→V4 edge knows one parent's historical children.
 * @param children - complete child evidence retained unchanged for the catalog's lifetime; an empty array declares no children.
 * @returns a catalog with independent restore state per artifact and unchanged current-format readers.
 */
export function createSessionFormatCatalogWithChildren(children: readonly SessionFormatJsonValue[]): SessionFormatCatalog {
  const migration = createSessionFormatV3ToV4(children)
  return createSessionFormatCatalog({
    ...sessionFormatCatalogOptions,
    migrations: sessionFormatCatalogOptions.migrations.map(edge => edge === sessionFormatV3ToV4 ? migration : edge),
  })
}
