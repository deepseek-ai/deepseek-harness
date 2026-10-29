/** Canonical identities for change requests. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { ChangeRequestKey, ChangeRequestRef } from './types.ts'

/**
 * Build the canonical identity of a change request. Host, owner, and name
 * compare case-insensitively, as they do on the hosts this vocabulary serves.
 * @param ref - change request to identify.
 * @returns `<forge>:<host>/<owner>/<name>#<number>` in lowercase.
 */
export function changeRequestKey(ref: ChangeRequestRef): ChangeRequestKey {
  const { forge, host, owner, name } = ref.repository
  return brandString<ChangeRequestKey>(`${forge}:${host}/${owner}/${name}#${ref.number}`.toLowerCase())
}
