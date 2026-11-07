/** GitHub pull request commit listing through GraphQL, pinned to one head commit across pages. */

import type { ChangeRequestRef, ForgeCommit, ForgeCommitList, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import { checkedRepository } from './urls.ts'

/** Commits GitHub returns per GraphQL page, its connection maximum. */
const PAGE = 100

/** One page of a pull request's commits with its head; `cursor` continues after the previous page. */
export const COMMITS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(first: $first, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { commit { oid messageHeadline authoredDate author { name user { login } } parents(first: 1) { nodes { oid } } } }
      }
    }
  }
}`

const pageSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: z.string(),
        commits: z.object({
          totalCount: z.number().int().nonnegative(),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          nodes: z.array(z.object({
            commit: z.object({
              oid: z.string(),
              messageHeadline: z.string(),
              authoredDate: z.string(),
              author: z.object({ name: z.string().nullable(), user: z.object({ login: z.string() }).nullable() }).nullable(),
              parents: z.object({ nodes: z.array(z.object({ oid: z.string() })) }),
            }),
          })),
        }),
      }).nullable(),
    }).nullable(),
  }),
})

/** Runs one `gh` GraphQL request; resolves to its parsed JSON body, or why GitHub did not answer it. */
export type GraphqlReader = (args: readonly string[], signal: AbortSignal) => Promise<
  { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly failure: ForgeFailure }>

/**
 * List a pull request's commits oldest first, at most `limit`, reading pages until the limit or the last commit.
 * Every page must report the head and commit count of the first page, so the list never mixes two pushes, and a cursor
 * no earlier page returned, so the listing ends.
 * @param read - runs one GraphQL request.
 * @param ref - validated pull request address.
 * @param limit - most commits listed.
 * @param signal - cancellation of every page.
 * @returns the commits at one head, or why GitHub did not list them.
 */
export async function listCommits(
  read: GraphqlReader,
  ref: ChangeRequestRef,
  limit: number,
  signal: AbortSignal,
): Promise<ForgeCommitList | ForgeFailure> {
  const { host, owner, name } = checkedRepository(ref)
  const commits: ForgeCommit[] = []
  const cursors = new Set<string>()
  let first: { readonly head: string; readonly total: number } | undefined
  let cursor: string | null = null
  for (;;) {
    const body = await read([
      'api', 'graphql', '--hostname', host, '-f', `query=${COMMITS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
      '-F', `number=${ref.number}`, '-F', `first=${Math.min(PAGE, limit - commits.length)}`,
      ...cursor === null ? [] : ['-f', `cursor=${cursor}`],
    ], signal)
    if (!body.ok) return body.failure
    const parsed = pageSchema.safeParse(body.body)
    if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitHub response to the commit listing' }
    const pull = parsed.data.data.repository?.pullRequest
    if (pull == null) return { code: 'not-found', message: `pull request ${ref.number} was not found` }
    const { headRefOid: head, commits: { totalCount: total, pageInfo: { hasNextPage, endCursor } } } = pull
    first ??= { head, total }
    if (head !== first.head || total !== first.total) {
      return { code: 'unavailable', message: 'The pull request head changed while its commits were read' }
    }
    for (const { commit } of pull.commits.nodes) {
      commits.push({
        sha: commit.oid,
        parent: commit.parents.nodes[0]?.oid ?? null,
        title: commit.messageHeadline,
        author: commit.author?.user?.login ?? commit.author?.name ?? null,
        authoredAt: commit.authoredDate,
      })
    }
    if (!hasNextPage || commits.length >= limit) return { headSha: head, commits, truncated: total > commits.length }
    if (endCursor === null || cursors.has(endCursor)) return { code: 'unavailable', message: 'GitHub commit pagination did not advance' }
    cursors.add(endCursor)
    cursor = endCursor
  }
}
