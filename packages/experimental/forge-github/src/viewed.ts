/** The signed-in user's viewed marks on pull request files through GraphQL, pinned to one head commit. */

import type {
  ChangeRequestRef, ForgeActionFailure, ForgeFailure, ForgeViewedFiles, ForgeViewedRequest, ForgeViewedState,
} from '@deepseek-ai/dsh-experimental-forge'
import { pullRequestNode } from './pull-request-node.ts'
import { z } from 'zod'
import type { GraphqlReader } from './commits.ts'
import type { GraphqlWriter } from './mutation.ts'
import { checkedRepository, isCommit } from './urls.ts'

/** Files GitHub returns per GraphQL page, its connection maximum. */
const PAGE = 100

/** One page of a pull request's files with the viewer's marks and its head; `cursor` continues after the previous page. */
export const VIEWED_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      files(first: $first, after: $cursor) { totalCount pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } }
    }
  }
}`

/** Mark one file viewed; variables `id` (pull request node id) and `path`, sent on standard input. */
export const MARK_VIEWED_MUTATION = `mutation($id: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
}`

/** Clear one file's viewed mark; variables `id` (pull request node id) and `path`, sent on standard input. */
export const UNMARK_VIEWED_MUTATION = `mutation($id: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
}`

const STATES: ReadonlyMap<string, ForgeViewedState> = new Map([['VIEWED', 'viewed'], ['UNVIEWED', 'unviewed'], ['DISMISSED', 'dismissed']])

const pageSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: z.string(),
        files: z.object({
          totalCount: z.number().int().nonnegative(),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          nodes: z.array(z.object({ path: z.string(), viewerViewedState: z.string() })),
        }).nullable(),
      }).nullable(),
    }).nullable(),
  }),
})

/**
 * Read the viewer's marks on a pull request's files, at most `limit`, reading pages until the limit or the last file.
 * Every page must name `headSha` as the head, so the marks never mix two pushes, and a cursor no earlier page returned,
 * so the listing ends. A state GitHub adds later reads as `unviewed`.
 * @param read - runs one GraphQL request.
 * @param ref - pull request address.
 * @param headSha - head commit the marks must be read at.
 * @param limit - most files listed.
 * @param signal - cancellation of every page.
 * @returns the marks at `headSha`, `stale` once the head is another commit, or why GitHub did not list them.
 * @throws when `headSha` is not a full commit object name.
 */
export async function readViewed(
  read: GraphqlReader,
  ref: ChangeRequestRef,
  headSha: string,
  limit: number,
  signal: AbortSignal,
): Promise<ForgeViewedFiles | ForgeFailure> {
  const { host, owner, name } = checkedRepository(ref)
  if (!isCommit(headSha)) throw new Error(`forge-github: invalid head commit ${JSON.stringify(headSha)}`)
  // A map keeps a path such as `__proto__`, which assignment to a plain object drops.
  const files = new Map<string, ForgeViewedState>()
  let listed = 0
  const cursors = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const body = await read([
      'api', 'graphql', '--hostname', host, '-f', `query=${VIEWED_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
      '-F', `number=${ref.number}`, '-F', `first=${Math.min(PAGE, limit - listed)}`, ...cursor === null ? [] : ['-f', `cursor=${cursor}`],
    ], signal)
    if (!body.ok) return body.failure
    const parsed = pageSchema.safeParse(body.body)
    if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitHub response to the viewed file read' }
    const pull = parsed.data.data.repository?.pullRequest
    if (pull == null) return { code: 'not-found', message: `pull request ${ref.number} was not found` }
    if (pull.headRefOid.toLowerCase() !== headSha.toLowerCase()) {
      return { code: 'stale', message: `the pull request head moved from ${headSha} to ${pull.headRefOid}` }
    }
    // GitHub answers null for the files of a pull request whose diff it cannot list.
    if (pull.files === null) return { code: 'unavailable', message: 'GitHub did not list the pull request files' }
    const { totalCount, pageInfo: { hasNextPage, endCursor }, nodes } = pull.files
    for (const node of nodes) files.set(node.path, STATES.get(node.viewerViewedState) ?? 'unviewed')
    listed += nodes.length
    // `fromEntries` defines each path as an own property, `__proto__` included.
    if (!hasNextPage || listed >= limit) {
      return { headSha: pull.headRefOid, files: Object.fromEntries(files), truncated: totalCount > listed }
    }
    if (endCursor === null || cursors.has(endCursor)) return { code: 'unavailable', message: 'GitHub file pagination did not advance' }
    cursors.add(endCursor)
    cursor = endCursor
  }
}

/**
 * Set or clear the viewer's mark on one file. GitHub's mutations take no head commit, so the pull request head is read
 * first and the write is refused once it is another commit; a push between that read and the write leaves the mark on
 * the file as the new head has it.
 * @param read - runs one GraphQL query.
 * @param write - runs one GraphQL mutation.
 * @param ref - pull request address.
 * @param request - the file, its mark, and the head commit the user saw.
 * @param signal - cancellation of both requests.
 * @returns undefined once GitHub saved the mark, `stale` when the head moved, or why GitHub refused.
 * @throws when `request.headSha` is not a full commit object name.
 */
export async function writeViewed(
  read: GraphqlReader,
  write: GraphqlWriter,
  ref: ChangeRequestRef,
  request: ForgeViewedRequest,
  signal: AbortSignal,
): Promise<ForgeActionFailure | undefined> {
  if (!isCommit(request.headSha)) throw new Error(`forge-github: invalid head commit ${JSON.stringify(request.headSha)}`)
  const id = await pullRequestNode(read, ref, request.headSha, signal)
  if (typeof id !== 'string') return id
  const variables = { id, path: request.path }
  return await write(ref.repository.host, request.viewed
    ? { query: MARK_VIEWED_MUTATION, field: 'markFileAsViewed', variables }
    : { query: UNMARK_VIEWED_MUTATION, field: 'unmarkFileAsViewed', variables }, signal)
}
