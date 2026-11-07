/** Host review threads and comments shared by the browser-side thread tests. */

import type { ForgeCommentId, ForgeReviewComment, ForgeReviewThread, ForgeThreadId } from '@deepseek-ai/dsh-experimental-forge/types'

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
