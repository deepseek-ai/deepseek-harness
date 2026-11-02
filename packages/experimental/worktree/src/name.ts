/** Generated worktree names that lead back to the Session that created them. */

import { randomBytes } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * Generate a branch and checkout name: the prefix, the first eight hexadecimal digits of the
 * first UUID in the Session id, a hyphen, and four random hexadecimal digits. A Session id
 * without a UUID gets eight random hexadecimal digits after the prefix instead.
 * @param prefix - validated name prefix.
 * @param sessionId - id of the Session the worktree is created for.
 * @returns the generated name; it is unique only with high probability, so creation still rejects an existing branch.
 */
export function generatedWorktreeName(prefix: string, sessionId: Agent['session']['id']): string {
  const uuid = UUID.exec(sessionId)?.[0]
  return uuid === undefined
    ? `${prefix}${randomBytes(4).toString('hex')}`
    : `${prefix}${uuid.slice(0, 8).toLowerCase()}-${randomBytes(2).toString('hex')}`
}
