/** Job identities and compatibility constructors, independent of the registry implementation. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Identifies one job across registry lifetimes. The registry generates `<kind>-<short-uuid>`;
 * access still requires owner authorization.
 */
export type JobId = Branded<'JobId'>

/**
 * Brand a string as a {@link JobId}.
 * @param id - the raw job-id string (the registry generates 16 UUID hex characters after the kind).
 * @returns the same string, branded; no validation is performed.
 */
export function JobId(id: string): JobId {
  return id as JobId
}
