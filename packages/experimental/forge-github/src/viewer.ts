/** Lists of the signed-in user's open pull requests through the GitHub GraphQL search. */

import type {
  ChangeRequestSummary, ForgeFailure, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GraphqlReader } from './commits.ts'
import { checksRollup, reviewDecision, VERDICTS } from './graphql.ts'
import { isSegment } from './urls.ts'

/** The lists GitHub search reads, each the same search the GitHub pull request page offers. */
export const VIEWER_FILTERS: ReadonlySet<ForgeViewerFilter> = new Set(['review-requested', 'authored', 'involved'])

/**
 * Search qualifiers of each list. `involved` leaves out the other two lists, so the three never share a pull request;
 * `review-requested:@me` also matches a request to one of the user's teams.
 */
const QUALIFIERS: Readonly<Record<ForgeViewerFilter, string>> = {
  'review-requested': 'review-requested:@me',
  'authored': 'author:@me',
  'involved': 'involves:@me -author:@me -review-requested:@me',
}

const ROW_FIELDS = `number title url isDraft updatedAt headRefOid reviewDecision
  repository { name owner { login } }
  author { __typename login avatarUrl }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  viewerLatestReview { state commit { oid } }
  viewerLatestReviewRequest { requestedReviewer { __typename ... on Team { combinedSlug } } }`

/** One page of one list with the signed-in user; variables `q` and the integer `first`. */
export const VIEWER_LIST_QUERY = `query($q: String!, $first: Int!) {
  viewer { login }
  search(type: ISSUE, query: $q, first: $first) { issueCount nodes { __typename ... on PullRequest { ${ROW_FIELDS} } } }
}`

/** The size of every list in one request; variables `review`, `authored`, and `involved`. */
export const VIEWER_COUNT_QUERY = `query($review: String!, $authored: String!, $involved: String!) {
  review: search(type: ISSUE, query: $review, first: 0) { issueCount }
  authored: search(type: ISSUE, query: $authored, first: 0) { issueCount }
  involved: search(type: ISSUE, query: $involved, first: 0) { issueCount }
}`

const ownerSchema = z.object({ name: z.string(), owner: z.object({ login: z.string() }) })

const rowSchema = z.object({
  __typename: z.literal('PullRequest'),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  headRefOid: z.string(),
  reviewDecision: z.string().nullable(),
  repository: ownerSchema,
  author: z.object({ __typename: z.string(), login: z.string(), avatarUrl: z.string().nullable() }).nullable(),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })) }),
  viewerLatestReview: z.object({ state: z.string(), commit: z.object({ oid: z.string() }).nullable() }).nullable(),
  viewerLatestReviewRequest: z.object({
    requestedReviewer: z.object({ __typename: z.string(), combinedSlug: z.string().optional() }).nullable(),
  }).nullable(),
})

const listSchema = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    search: z.object({ issueCount: z.number().int().nonnegative(), nodes: z.array(z.unknown()) }),
  }),
})

const countSchema = z.object({
  data: z.object({
    review: z.object({ issueCount: z.number().int().nonnegative() }),
    authored: z.object({ issueCount: z.number().int().nonnegative() }),
    involved: z.object({ issueCount: z.number().int().nonnegative() }),
  }),
})

/**
 * Build the search text of one list.
 * @param filter - the list.
 * @param repository - one repository to search in, or null for every repository the user can read.
 * @returns the search text, most recently updated first, or undefined for a repository whose owner or name cannot be
 * a search qualifier.
 */
export function searchText(filter: ForgeViewerFilter, repository: ForgeViewerQuery['repository']): string | undefined {
  if (repository !== null && (!isSegment(repository.owner) || !isSegment(repository.name))) return undefined
  const scope = repository === null ? '' : ` repo:${repository.owner}/${repository.name}`
  return `is:pr is:open archived:false ${QUALIFIERS[filter]}${scope} sort:updated-desc`
}

/**
 * Read one list through one search request: GitHub answers a search of several lists in one document with a gateway
 * error, so every list is its own request. A search result that is not a pull request, or names a repository this
 * provider cannot address, is left out.
 * @param read - runs one GraphQL request.
 * @param query - host, list, repository, and a limit the caller already bounded.
 * @param signal - cancellation of the read.
 * @returns the list, or why GitHub did not provide it.
 */
export async function readViewerList(
  read: GraphqlReader, query: ForgeViewerQuery, signal: AbortSignal,
): Promise<ForgeViewerList | ForgeFailure> {
  const text = searchText(query.filter, query.repository)
  if (text === undefined) return { code: 'not-found', message: 'the repository name cannot be searched' }
  const output = await read(['api', 'graphql', '--hostname', query.host, '-f', `query=${VIEWER_LIST_QUERY}`, '-f', `q=${text}`,
    '-F', `first=${query.limit}`], signal)
  if (!output.ok) return output.failure
  const parsed = listSchema.safeParse(output.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitHub response to the pull request search' }
  const items: ChangeRequestSummary[] = []
  for (const node of parsed.data.data.search.nodes) {
    const row = rowSchema.safeParse(node)
    if (!row.success) continue
    const item = summaryOf(query.host, row.data)
    if (item !== undefined) items.push(item)
  }
  return { viewer: parsed.data.data.viewer.login, items, total: parsed.data.data.search.issueCount }
}

/**
 * Count every list on one host in one request.
 * @param read - runs one GraphQL request.
 * @param host - host to count on.
 * @param signal - cancellation of the read.
 * @returns the size of each list, or why GitHub did not provide them.
 */
export async function countViewerLists(
  read: GraphqlReader, host: string, signal: AbortSignal,
): Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure> {
  const text = (filter: ForgeViewerFilter): string => `is:pr is:open archived:false ${QUALIFIERS[filter]}`
  const output = await read(['api', 'graphql', '--hostname', host, '-f', `query=${VIEWER_COUNT_QUERY}`,
    '-f', `review=${text('review-requested')}`, '-f', `authored=${text('authored')}`, '-f', `involved=${text('involved')}`], signal)
  if (!output.ok) return output.failure
  const parsed = countSchema.safeParse(output.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitHub response to the pull request count' }
  const { review, authored, involved } = parsed.data.data
  return new Map<ForgeViewerFilter, number>([
    ['review-requested', review.issueCount], ['authored', authored.issueCount], ['involved', involved.issueCount],
  ])
}

/**
 * Map one search result.
 * @param host - host the search ran on.
 * @param row - the pull request fields.
 * @returns the summary, or undefined for a repository this provider cannot address.
 */
function summaryOf(host: string, row: z.infer<typeof rowSchema>): ChangeRequestSummary | undefined {
  const { owner: { login: owner }, name } = row.repository
  if (!isSegment(owner) || !isSegment(name)) return undefined
  const review = row.viewerLatestReview
  const verdict = review === null ? undefined : VERDICTS[review.state]
  const reviewer = row.viewerLatestReviewRequest?.requestedReviewer
  return {
    ref: { repository: { forge: 'github', host, owner, name }, number: row.number },
    url: row.url,
    title: row.title,
    draft: row.isDraft,
    author: row.author === null ? null : { login: row.author.login, avatarUrl: row.author.avatarUrl, bot: row.author.__typename === 'Bot' },
    headSha: row.headRefOid,
    checksRollup: checksRollup(row.commits.nodes[0]?.commit.statusCheckRollup?.state),
    reviewDecision: reviewDecision(row.reviewDecision),
    viewerReview: review === null || verdict === undefined ? null : { verdict, reviewedSha: review.commit?.oid ?? null },
    viewerRequest: reviewer == null ? null : { team: reviewer.__typename === 'Team' ? reviewer.combinedSlug ?? null : null },
    updatedAt: row.updatedAt,
  }
}
