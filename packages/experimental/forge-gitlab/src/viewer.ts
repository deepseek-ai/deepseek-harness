/** Lists and counts of the signed-in user's open merge requests through GraphQL. */

import type {
  ChangeRequestSummary, ForgeFailure, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GitLabApi } from './api.ts'
import { AWAITED_REVIEW_STATES, GIVEN_REVIEW_STATES, PEOPLE_PAGE, reviewDecision, reviewOf, rollup } from './status.ts'
import { avatarUrlOf, isSegment, location, repositoryOf } from './urls.ts'

/** The lists the provider reads on every host it serves. */
export const VIEWER_FILTERS: ReadonlySet<ForgeViewerFilter> = new Set(['review-requested', 'authored', 'involved'])

/** Most merge requests one list read returns, GitLab's connection page maximum. */
export const VIEWER_PAGE = 100

/** The lists GitLab reads from one connection of the signed-in user; `involved` joins two. */
export type SingleListFilter = Exclude<ForgeViewerFilter, 'involved'>

/** Host, project, and limit of one list read. */
export type ViewerScope = Omit<ForgeViewerQuery, 'filter'>

/** The size of every list with the user GitLab counted them for. */
export interface ViewerCounts {
  /** Username of the signed-in user GitLab answered as. */
  readonly viewer: string
  /** Number of open merge requests in each list. */
  readonly counts: ReadonlyMap<ForgeViewerFilter, number>
}

/** The review states of a reviewer whose review is still awaited, as a GraphQL list. */
const AWAITED = `[${[...AWAITED_REVIEW_STATES].join(', ')}]`

/** The review states of a reviewer who gave a review, as a GraphQL list. */
const GIVEN = `[${[...GIVEN_REVIEW_STATES].join(', ')}]`

/** Arguments that select the open merge requests of a connection. */
const OPEN = 'state: opened'

/** Arguments of one list page: most recently updated first, `$first` merge requests, in `$project` or in every project. */
const PAGE = `${OPEN}, sort: UPDATED_DESC, first: $first, projectPath: $project`

/**
 * The four connections of `currentUser` that the lists are read from, each built from the arguments that select its
 * state and page: merge requests that await the user's review, ones the user wrote, ones the user reviewed and did not
 * write, and ones assigned to the user who neither wrote nor reviews them. The last two name the user as `$me` and
 * share no merge request with each other or with the first two.
 */
const CONNECTIONS = {
  awaited: (selected: string): string => `reviewRequestedMergeRequests(${selected}, reviewStates: ${AWAITED})`,
  authored: (selected: string): string => `authoredMergeRequests(${selected})`,
  // The states of a given review are listed, since `reviewStates` reads the user's own state. GitLab 19.5.1 applies
  // `not: { reviewStates }` to every reviewer, which leaves out a merge request another reviewer has yet to review.
  reviewed: (selected: string): string =>
    `reviewRequestedMergeRequests(${selected}, reviewStates: ${GIVEN}, not: { authorUsername: $me })`,
  assigned: (selected: string): string => `assignedMergeRequests(${selected}, not: { authorUsername: $me, reviewerUsername: $me })`,
}

/** Merge request fields one list row takes; the reviewers decide the review outcome and name the signed-in user's own review state. */
const ROW_FRAGMENT = `fragment ViewerRow on MergeRequest {
  iid title webUrl draft updatedAt diffHeadSha approved
  author { username avatarUrl bot }
  project { fullPath }
  headPipeline { status }
  reviewers(first: ${PEOPLE_PAGE}) { nodes { username mergeRequestInteraction { reviewState } } }
}`

const ROWS = '{ count nodes { ...ViewerRow } }'

/** One page of a list read from one connection; variables: the integer `first` and the nullable string `project`. */
export const VIEWER_LIST_QUERIES: Readonly<Record<SingleListFilter, string>> = {
  'review-requested': `query($first: Int!, $project: String) {
  currentUser { username list: ${CONNECTIONS.awaited(PAGE)} ${ROWS} }
}
${ROW_FRAGMENT}`,
  'authored': `query($first: Int!, $project: String) {
  currentUser { username list: ${CONNECTIONS.authored(PAGE)} ${ROWS} }
}
${ROW_FRAGMENT}`,
}

/** One page of each connection of the `involved` list; variables: `first`, `project`, and `me`, the signed-in user's username. */
export const VIEWER_INVOLVED_QUERY = `query($first: Int!, $project: String, $me: String!) {
  currentUser {
    username
    reviewed: ${CONNECTIONS.reviewed(PAGE)} ${ROWS}
    assigned: ${CONNECTIONS.assigned(PAGE)} ${ROWS}
  }
}
${ROW_FRAGMENT}`

/** The size of every connection in every project; variable `me` is the signed-in user's username. */
export const VIEWER_COUNT_QUERY = `query($me: String!) {
  currentUser {
    username
    awaited: ${CONNECTIONS.awaited(OPEN)} { count }
    authored: ${CONNECTIONS.authored(OPEN)} { count }
    reviewed: ${CONNECTIONS.reviewed(OPEN)} { count }
    assigned: ${CONNECTIONS.assigned(OPEN)} { count }
  }
}`

/** The signed-in user's username. */
export const VIEWER_NAME_QUERY = 'query { currentUser { username } }'

const rowSchema = z.object({
  iid: z.string(),
  title: z.string(),
  webUrl: z.string(),
  draft: z.boolean(),
  updatedAt: z.string(),
  diffHeadSha: z.string().nullable(),
  approved: z.boolean(),
  author: z.object({ username: z.string(), avatarUrl: z.string().nullable(), bot: z.boolean() }).nullable(),
  project: z.object({ fullPath: z.string() }),
  headPipeline: z.object({ status: z.string() }).nullable(),
  reviewers: z.object({
    nodes: z.array(z.object({
      username: z.string(),
      mergeRequestInteraction: z.object({ reviewState: z.string().nullable() }).nullable(),
    })),
  }),
})

const sizeSchema = z.object({ count: z.number().int().nonnegative() })
const pageSchema = sizeSchema.extend({ nodes: z.array(rowSchema) })
const userSchema = z.object({ username: z.string() })

const nameSchema = z.object({ currentUser: userSchema.nullable() })
const listSchema = z.object({ currentUser: userSchema.extend({ list: pageSchema }).nullable() })
const involvedSchema = z.object({ currentUser: userSchema.extend({ reviewed: pageSchema, assigned: pageSchema }).nullable() })
const countSchema = z.object({
  currentUser: userSchema.extend({ awaited: sizeSchema, authored: sizeSchema, reviewed: sizeSchema, assigned: sizeSchema }).nullable(),
})

/** A merge request number as GitLab spells it, short enough to be a safe integer. */
const IID = /^[1-9]\d{0,14}$/

/**
 * Read the `review-requested` or the `authored` list through one request: the open merge requests on which the user's
 * review state is unreviewed or started, or the ones the user wrote, most recently updated first. Merge requests this
 * provider cannot address and ones without a head commit are left out of `items` and still counted in `total`.
 * @param api - GitLab reads.
 * @param filter - the list.
 * @param scope - host, project, and a limit the caller already bounded by {@link VIEWER_PAGE}.
 * @param signal - cancellation of the read.
 * @returns the list, or why GitLab did not provide it; `not-found`, without a request, for a project path GitLab cannot hold.
 */
export async function readViewerList(
  api: GitLabApi, filter: SingleListFilter, scope: ViewerScope, signal: AbortSignal,
): Promise<ForgeViewerList | ForgeFailure> {
  const project = projectPathOf(scope.repository)
  if (project === undefined) return UNSEARCHABLE
  const variables = { first: scope.limit, project }
  const user = await readAsUser(api, scope.host, VIEWER_LIST_QUERIES[filter], variables, listSchema, 'merge request list', signal)
  if ('code' in user) return user
  const awaited = filter === 'review-requested'
  return {
    viewer: user.username,
    items: user.list.nodes.flatMap(row => summaryOf(scope.host, row, user.username, awaited) ?? []),
    total: user.list.count,
  }
}

/**
 * Read the `involved` list through one request of two connections, since GitLab has no single one for it: the open merge
 * requests the user reviewed and did not write, and the ones assigned to the user who neither wrote nor reviews them.
 * Both are merged most recently updated first and cut to the limit; `total` is the sum of their sizes.
 * @param api - GitLab reads.
 * @param scope - host, project, and a limit the caller already bounded by {@link VIEWER_PAGE}.
 * @param me - username of the signed-in user, which the connections exclude as author and as reviewer. A list whose
 * `viewer` is another username was selected for the wrong user and must be read again with that username.
 * @param signal - cancellation of the read.
 * @returns the list, or why GitLab did not provide it; `not-found`, without a request, for a project path GitLab cannot hold.
 */
export async function readInvolvedList(
  api: GitLabApi, scope: ViewerScope, me: string, signal: AbortSignal,
): Promise<ForgeViewerList | ForgeFailure> {
  const project = projectPathOf(scope.repository)
  if (project === undefined) return UNSEARCHABLE
  const variables = { first: scope.limit, project, me }
  const user = await readAsUser(api, scope.host, VIEWER_INVOLVED_QUERY, variables, involvedSchema, 'merge request list', signal)
  if ('code' in user) return user
  const items = [...user.reviewed.nodes, ...user.assigned.nodes].flatMap(row => summaryOf(scope.host, row, user.username, false) ?? [])
  items.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  return { viewer: user.username, items: items.slice(0, scope.limit), total: user.reviewed.count + user.assigned.count }
}

/**
 * Count every list on one host, in every project, through one request: `involved` is the sum of its two connections.
 * @param api - GitLab reads.
 * @param host - host to count on.
 * @param me - username of the signed-in user, as {@link readInvolvedList} takes it; counts whose `viewer` is another
 * username must be read again with that username.
 * @param signal - cancellation of the read.
 * @returns the size of each list with the user GitLab answered as, or why GitLab did not provide them.
 */
export async function countViewerLists(
  api: GitLabApi, host: string, me: string, signal: AbortSignal,
): Promise<ViewerCounts | ForgeFailure> {
  const user = await readAsUser(api, host, VIEWER_COUNT_QUERY, { me }, countSchema, 'merge request count', signal)
  if ('code' in user) return user
  return {
    viewer: user.username,
    counts: new Map<ForgeViewerFilter, number>([
      ['review-requested', user.awaited.count], ['authored', user.authored.count], ['involved', user.reviewed.count + user.assigned.count],
    ]),
  }
}

/**
 * Read the username of the signed-in user.
 * @param api - GitLab reads.
 * @param host - host to read on.
 * @param signal - cancellation of the read.
 * @returns the username, or why GitLab did not name one.
 */
export async function readViewerName(api: GitLabApi, host: string, signal: AbortSignal): Promise<string | ForgeFailure> {
  const user = await readAsUser(api, host, VIEWER_NAME_QUERY, {}, nameSchema, 'user read', signal)
  return 'code' in user ? user : user.username
}

const UNSEARCHABLE: ForgeFailure = { code: 'not-found', message: 'the project path cannot be searched' }

/**
 * The `projectPath` argument of a list read.
 * @param repository - one project to read in, or null for every project.
 * @returns the project's full path, null for every project, or undefined for a path with a segment GitLab does not permit.
 */
function projectPathOf(repository: ForgeViewerQuery['repository']): string | null | undefined {
  if (repository === null) return null
  const { owner, name } = repository
  return owner.split('/').every(isSegment) && isSegment(name) ? `${owner}/${name}` : undefined
}

/**
 * Run one query and read `currentUser` from its answer.
 * @param api - GitLab reads.
 * @param host - host to read on.
 * @param query - GraphQL document that selects `currentUser`.
 * @param variables - query variables.
 * @param schema - the answer's `data`.
 * @param subject - what the query reads, for the failure of an answer `schema` does not accept.
 * @param signal - cancellation of the read.
 * @returns the user's fields; `unauthenticated` when GitLab answers without a user, as it does for a request whose
 * credentials it did not take; or the failure of the read.
 */
async function readAsUser<User>(
  api: GitLabApi, host: string, query: string, variables: Readonly<Record<string, unknown>>,
  schema: z.ZodType<{ readonly currentUser: User | null }>, subject: string, signal: AbortSignal,
): Promise<User | ForgeFailure> {
  const read = await api.graphql(host, query, variables, signal)
  if (!read.ok) return read.failure
  const parsed = schema.safeParse(read.body)
  if (!parsed.success) return { code: 'unavailable', message: `unexpected GitLab response to the ${subject}` }
  return parsed.data.currentUser ?? { code: 'unauthenticated', message: `GitLab named no signed-in user on ${host}` }
}

/**
 * Map one merge request of a list. GitLab has no team review requests and records no commit with a review, so a request
 * never names a team and a review never names a commit; the row reads no merge status, so an approval GitLab demands
 * reads as no review decision.
 * @param host - host the list was read on.
 * @param row - the merge request fields.
 * @param viewer - username of the signed-in user.
 * @param awaited - whether the list holds only merge requests that await the user's review, which then all name a
 * request, also past the reviewers the row reads.
 * @returns the summary, or undefined for a project path or number this provider cannot address and for a merge request
 * without commits, which has no head.
 */
function summaryOf(host: string, row: z.infer<typeof rowSchema>, viewer: string, awaited: boolean): ChangeRequestSummary | undefined {
  const place = location(host, row.project.fullPath.split('/'))
  if (place === undefined || !IID.test(row.iid) || row.diffHeadSha === null) return undefined
  const { author } = row
  const reviewer = row.reviewers.nodes.find(entry => entry.username.toLowerCase() === viewer.toLowerCase())
  const review = reviewer === undefined ? undefined : reviewOf(reviewer)
  return {
    ref: { repository: repositoryOf(place), number: Number(row.iid) },
    url: row.webUrl,
    title: row.title,
    draft: row.draft,
    author: author === null ? null : { login: author.username, avatarUrl: avatarUrlOf(host, author.avatarUrl), bot: author.bot },
    headSha: row.diffHeadSha,
    checksRollup: rollup(row.headPipeline?.status ?? null),
    reviewDecision: reviewDecision(row, null),
    viewerReview: review?.verdict == null ? null : { verdict: review.verdict, reviewedSha: null },
    viewerRequest: awaited || review?.requested === true ? { team: null } : null,
    updatedAt: row.updatedAt,
  }
}
