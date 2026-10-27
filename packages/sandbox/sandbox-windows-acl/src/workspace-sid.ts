/**
 * Deterministic write identities for canonical writable-directory sets and
 * separate identities for private temp directories. Standing directory ACEs
 * are reusable only by executions carrying the same complete set identity.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/workspace-sid
 */

import { createHash } from 'node:crypto'

/**
 * Derive the write SID for a workspace and its additional writable roots.
 * Order and duplicate entries do not affect the identity. A workspace-only
 * set retains its existing SID; larger sets use unambiguous JSON encoding.
 * @param workspaceRoot - the canonical workspace path.
 * @param additionalWritableRoots - canonical extra directories; defaults to none.
 * @returns the deterministic SDDL string for the complete directory set.
 */
export function workspaceWriteSid(workspaceRoot: string, additionalWritableRoots: readonly string[] = []): string {
  const roots = [...new Set([workspaceRoot, ...additionalWritableRoots])].sort()
  const identity = roots.length === 1 ? workspaceRoot : JSON.stringify(roots)
  const digest = createHash('sha256').update(identity, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}`
}

/**
 * Derive one private temp directory's write SID. The random directory path
 * is the capability identity; a fixed third subauthority domain-separates
 * the result from every two-subauthority workspace SID.
 * @param tempDir - the private temp directory's absolute path.
 * @returns the SDDL string form.
 */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash('sha256').update('temp\0', 'utf8').update(tempDir, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}-1`
}
