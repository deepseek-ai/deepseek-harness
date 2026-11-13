/** The commits of a merge request through the REST commit listing, oldest first. */

import type { ChangeRequestRef, ForgeCommit, ForgeCommitList, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GitLabApi } from './api.ts'
import { mergeRequestPath } from './urls.ts'

/** Commits per page; GitLab's REST maximum. */
const PAGE = 100

const commitSchema = z.object({
  id: z.string(),
  parent_ids: z.array(z.string()),
  title: z.string(),
  author_name: z.string().nullable(),
  authored_date: z.string(),
})

/**
 * List a merge request's commits at its current head, at most `limit` of them. GitLab lists them newest first with the
 * total in `X-Total`, so a longer list reads the pages that hold the oldest `limit` commits.
 * @param api - GitLab reads.
 * @param ref - merge request.
 * @param limit - the most commits to list.
 * @param signal - cancellation of the read.
 * @returns the commits oldest first, the oldest `limit` when there are more, or why GitLab did not list them.
 */
export async function readCommits(
  api: GitLabApi, ref: ChangeRequestRef, limit: number, signal: AbortSignal,
): Promise<ForgeCommitList | ForgeFailure> {
  const unexpected: ForgeFailure = { code: 'unavailable', message: 'unexpected GitLab response to the commit listing' }
  const host = ref.repository.host
  const path = `${mergeRequestPath(ref)}/commits?per_page=${PAGE}`
  const first = await api.restPage(host, `${path}&page=1`, signal)
  if (!first.ok) return first.failure
  const parsed = z.array(commitSchema).safeParse(first.body)
  if (!parsed.success) return unexpected
  const newest = parsed.data[0]
  if (newest === undefined) return { code: 'unavailable', message: `merge request ${ref.number} lists no commits` }
  const total = first.total ?? parsed.data.length
  // Entries are numbered newest first from 0; the oldest `limit` start at `total - limit`.
  const skip = Math.max(0, total - limit)
  const pages = new Map<number, z.infer<typeof commitSchema>[]>([[1, parsed.data]])
  for (let page = Math.floor(skip / PAGE) + 1; (page - 1) * PAGE < total; page++) {
    if (pages.has(page)) continue
    const next = await api.restPage(host, `${path}&page=${page}`, signal)
    if (!next.ok) return next.failure
    const listed = z.array(commitSchema).safeParse(next.body)
    if (!listed.success) return unexpected
    pages.set(page, listed.data)
  }
  const ordered = [...pages.entries()].sort(([left], [right]) => left - right).flatMap(([page, entries]) =>
    entries.map((entry, index) => ({ entry, position: (page - 1) * PAGE + index })))
  const commits = ordered.filter(({ position }) => position >= skip).map(({ entry }): ForgeCommit => ({
    sha: entry.id,
    parent: entry.parent_ids[0] ?? null,
    title: entry.title,
    author: entry.author_name,
    authoredAt: entry.authored_date,
  })).reverse()
  return { headSha: newest.id, commits, truncated: total > limit }
}
