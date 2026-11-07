/** Host review threads, comments, and diff files shared by the browser-side thread tests. */

import type { ForgeCommentId, ForgeReviewComment, ForgeReviewThread, ForgeThreadId } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeDiffFile, ForgeDiffHunk } from '../src/types.ts'

let comments = 0

/**
 * Build a comment by `reviewer` that has a web page.
 * @param overrides - fields to replace.
 * @returns the comment.
 */
export function reviewComment(overrides: Partial<ForgeReviewComment> = {}): ForgeReviewComment {
  comments += 1
  return {
    id: `comment-${comments}` as ForgeCommentId,
    author: { login: 'reviewer', avatarUrl: 'https://avatars.example/u/1', bot: false },
    body: 'First comment',
    createdAt: '2026-11-05T08:00:00Z',
    pending: false,
    url: `https://github.com/octo/demo/pull/7#discussion_r${comments}`,
    ...overrides,
  }
}

/**
 * Build an unresolved new-side thread on line 3 of `src/a.ts`, written at the head `a…a` and placed there, with one comment.
 * @param overrides - fields to replace.
 * @returns the thread.
 */
export function reviewThread(overrides: Partial<ForgeReviewThread> = {}): ForgeReviewThread {
  return {
    id: `thread-${comments + 1}` as ForgeThreadId,
    path: 'src/a.ts',
    side: 'R',
    subject: 'line',
    current: { commit: 'a'.repeat(40), startLine: 3, endLine: 3 },
    original: { commit: 'a'.repeat(40), startLine: 3, endLine: 3 },
    diffHunk: '@@ -1,3 +1,3 @@\n a\n-b\n+B',
    resolved: false,
    comments: [reviewComment()],
    ...overrides,
  }
}

/**
 * Build a modified text file with hunks.
 * @param path - the file's path.
 * @param hunks - its hunks.
 * @returns the diff file.
 */
export function diffFile(path: string, hunks: readonly ForgeDiffHunk[]): ForgeDiffFile {
  return { path, previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, additions: 1, deletions: 1,
    digest: 'digest', layer: 'implementation', hunks }
}
