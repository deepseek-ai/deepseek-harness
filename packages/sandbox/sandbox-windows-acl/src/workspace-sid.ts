/**
 * Stable write identities for individual canonical directories, with separate
 * identities for private temp directories.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/workspace-sid
 */

import { createHash } from 'node:crypto'

/**
 * Derive one directory's write SID. Grant this SID only on that directory;
 * executions carry the SIDs of all directories they are allowed to write.
 * @param directory - the canonical directory path.
 * @returns the deterministic SDDL string, preserving existing workspace identities.
 */
export function directoryWriteSid(directory: string): string {
  const digest = createHash('sha256').update(directory, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}`
}

/**
 * Derive one private temp directory's write SID. The random directory path
 * is the capability identity; a fixed third subauthority domain-separates
 * the result from every two-subauthority directory SID.
 * @param tempDir - the private temp directory's absolute path.
 * @returns the SDDL string form.
 */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash('sha256').update('temp\0', 'utf8').update(tempDir, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}-1`
}
