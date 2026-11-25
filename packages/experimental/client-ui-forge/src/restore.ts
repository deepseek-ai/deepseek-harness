/** Which unstaged changes a restore of the changes view can act on. */

import type { ForgeDiffFile } from './types.ts'

/**
 * Whether restoring a file of the `unstaged` scope has content to return to or an untracked file to delete. A file the
 * index tracks without content, as `git add --intent-to-add` leaves it, shows as added or renamed and has neither:
 * Git would replace it with an empty file. A submodule is left out as well: `git restore` succeeds on it and leaves
 * the commit it has checked out.
 * @param file - a file as the `unstaged` scope lists it.
 * @returns whether a restore of the file is offered and accepted.
 */
export function restorable(file: Pick<ForgeDiffFile, 'untracked' | 'status' | 'submodule'>): boolean {
  return !file.submodule && (file.untracked || file.status === 'modified' || file.status === 'deleted')
}
