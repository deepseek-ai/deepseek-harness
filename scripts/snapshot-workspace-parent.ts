/** Workspace placement for snapshots that must not inherit temporary-directory write grants. */

import { accessSync, constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, parse, relative, sep } from 'node:path'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix)
}

/**
 * Select a writable temp sibling parent, or home when that parent is unavailable for writes.
 * The caller atomically allocates and owns cleanup of the generated workspace.
 * @param tempRoot - platform temporary directory.
 * @param home - fallback when temp siblings require a system directory or a non-writable parent.
 * @returns existing parent outside the automatic temporary write grants.
 */
export function outsideTempWorkspaceParent(tempRoot = tmpdir(), home = homedir()): string {
  const temporary = canonicalPath(tempRoot)
  const systemTemporary = canonicalPath('/tmp')
  const parent = dirname(temporary)
  if (temporary === systemTemporary || parent === parse(parent).root || contains(systemTemporary, parent)) return home
  try {
    accessSync(parent, constants.W_OK)
  } catch (error) {
    // A non-writable parent cannot host siblings; allocation failures still propagate from mkdtemp.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return home
    throw error
  }
  return parent
}

/**
 * Reject a workspace whose write could succeed without the session's workspace grant.
 * @param cwd - allocated workspace to check, with symlinks resolved before comparison.
 * @returns nothing; throws when an automatic temporary write grant contains the workspace.
 */
export function assertWorkspaceOutsideTemp(cwd: string): void {
  const path = canonicalPath(cwd)
  for (const root of writableRoots({ mode: 'workspace-write', workspaceRoot: '/tmp' })) {
    if (contains(root, path)) throw new Error('snapshot workspace ' + cwd + ' must be outside temporary writable root ' + root)
  }
}
