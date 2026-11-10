/** GitHub writes and reads of the change request overview: review requests, reviewer candidates, and branch updates. */

import type {
  BranchUpdateRequest, ChangeRequestRef, ForgeActionFailure, ForgeFailure, ForgeReviewerCandidate, ForgeReviewersRequest,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GraphqlReader } from './commits.ts'
import type { GraphqlWriter } from './mutation.ts'
import { pullRequestNode } from './pull-request-node.ts'
import { checkedRepository, isCommit } from './urls.ts'

/**
 * Add review requests from users and teams by node id; variable `input` is a `RequestReviewsInput`. Every supported
 * host has it, while GitHub Enterprise Server 3.19 and 3.20 lack `requestReviewsByLogin`.
 */
export const REQUEST_REVIEWS_MUTATION = `mutation($input: RequestReviewsInput!) {
  requestReviews(input: $input) { clientMutationId }
}`

/** Add review requests from bots by login, which only this mutation accepts; variable `input` is a `RequestReviewsByLoginInput`. */
export const REQUEST_BOT_REVIEWS_MUTATION = `mutation($input: RequestReviewsByLoginInput!) {
  requestReviewsByLogin(input: $input) { clientMutationId }
}`

/**
 * Split a team reviewer named `organization/slug`.
 * @param login - the team's name.
 * @returns the organization and the slug, or undefined for another name.
 */
function teamOf(login: string): readonly [string, string] | undefined {
  const [organization, slug, ...rest] = login.split('/')
  return organization === undefined || organization === '' || slug === undefined || slug === '' || rest.length > 0 ? undefined
    : [organization, slug]
}

/** Merge or rebase the base branch into the head branch; variable `input` is an `UpdatePullRequestBranchInput`. */
export const UPDATE_BRANCH_MUTATION = `mutation($input: UpdatePullRequestBranchInput!) {
  updatePullRequestBranch(input: $input) { clientMutationId }
}`

/** Most accounts one candidate listing returns. */
const CANDIDATES = 20

/** Accounts that can review and GitHub's suggestions; variables `owner`, `name`, and `search` are strings, `number` is an integer. */
export const CANDIDATES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $search: String!) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: ${CANDIDATES}, query: $search) { nodes { login name avatarUrl } }
    pullRequest(number: $number) { author { login } suggestedReviewers { reviewer { login name avatarUrl } } }
  }
}`

const account = z.object({ login: z.string(), name: z.string().nullable(), avatarUrl: z.string().nullable() })

const candidatesSchema = z.object({
  data: z.object({
    repository: z.object({
      assignableUsers: z.object({ nodes: z.array(account) }),
      pullRequest: z.object({
        author: z.object({ login: z.string() }).nullable(),
        suggestedReviewers: z.array(z.object({ reviewer: account })),
      }).nullable(),
    }).nullable(),
  }),
})

/**
 * Request reviews, adding to the requests GitHub holds. Users and teams are resolved to node ids in one query and asked
 * with `requestReviews`; bots, named with or without GitHub's `[bot]` suffix, are asked with `requestReviewsByLogin`
 * afterwards, which hosts without it refuse. A team is named `organization/slug`.
 * @param read - runs one GraphQL query.
 * @param write - runs one GraphQL mutation.
 * @param ref - pull request address.
 * @param request - the reviewers to ask.
 * @param signal - cancellation of every request.
 * @returns undefined once GitHub accepted every request, or why it refused; a refused bot request follows an accepted
 * request of the users and teams.
 */
export async function requestGitHubReviews(
  read: GraphqlReader, write: GraphqlWriter, ref: ChangeRequestRef, request: ForgeReviewersRequest, signal: AbortSignal,
): Promise<ForgeActionFailure | undefined> {
  if (request.reviewers.length === 0) return { code: 'failed', message: 'No reviewer was named' }
  const logins = (kind: string): string[] => request.reviewers.filter(reviewer => reviewer.kind === kind).map(reviewer => reviewer.login)
  const users = logins('user')
  const teams: (readonly [string, string])[] = []
  for (const login of logins('team')) {
    const team = teamOf(login)
    if (team === undefined) return { code: 'failed', message: `Team ${JSON.stringify(login)} is not named organization/slug` }
    teams.push(team)
  }
  const bots = logins('bot').map(login => login.endsWith('[bot]') ? login : `${login}[bot]`)
  const id = await pullRequestNode(read, ref, null, signal)
  if (typeof id !== 'string') return id
  const { host } = ref.repository
  if (users.length > 0 || teams.length > 0) {
    const ids = await reviewerIds(read, host, users, teams, signal)
    if ('code' in ids) return ids
    const failure = await write(host, { query: REQUEST_REVIEWS_MUTATION, field: 'requestReviews', variables: {
      input: { pullRequestId: id, union: true, ...ids.users.length > 0 ? { userIds: ids.users } : {},
        ...ids.teams.length > 0 ? { teamIds: ids.teams } : {} },
    } }, signal)
    if (failure !== undefined) return failure
  }
  if (bots.length === 0) return undefined
  return await write(host, { query: REQUEST_BOT_REVIEWS_MUTATION, field: 'requestReviewsByLogin',
    variables: { input: { pullRequestId: id, union: true, botLogins: bots } } }, signal)
}

const idNode = z.object({ id: z.string() })

/**
 * Resolve user logins and team slugs to node ids with one aliased query whose names are variables.
 * @returns the ids in request order, or why GitHub did not resolve them, as for an unknown login.
 */
async function reviewerIds(
  read: GraphqlReader, host: string, users: readonly string[], teams: readonly (readonly [string, string])[], signal: AbortSignal,
): Promise<{ readonly users: readonly string[]; readonly teams: readonly string[] } | ForgeActionFailure> {
  const declarations = [...users.map((_, index) => `$u${index}: String!`), ...teams.flatMap((_, index) => [`$o${index}: String!`, `$t${index}: String!`])]
  const fields = [...users.map((_, index) => `u${index}: user(login: $u${index}) { id }`),
    ...teams.map((_, index) => `t${index}: organization(login: $o${index}) { team(slug: $t${index}) { id } }`)]
  const query = `query(${declarations.join(', ')}) { ${fields.join(' ')} }`
  const body = await read(['api', 'graphql', '--hostname', host, '-f', `query=${query}`,
    ...users.flatMap((login, index) => ['-f', `u${index}=${login}`]),
    ...teams.flatMap(([organization, slug], index) => ['-f', `o${index}=${organization}`, '-f', `t${index}=${slug}`])], signal)
  if (!body.ok) return { code: body.failure.code === 'unauthenticated' ? 'unauthenticated' : 'failed', message: body.failure.message }
  const parsed = z.object({ data: z.record(z.string(), z.unknown()) }).safeParse(body.body)
  if (!parsed.success) return { code: 'failed', message: 'unexpected GitHub response to the reviewer lookup' }
  const { data } = parsed.data
  const userIds: string[] = []
  for (const [index, login] of users.entries()) {
    const user = idNode.safeParse(data[`u${index}`])
    if (!user.success) return { code: 'failed', message: `GitHub has no user ${login}` }
    userIds.push(user.data.id)
  }
  const teamIds: string[] = []
  for (const [index, [organization, slug]] of teams.entries()) {
    const team = z.object({ team: idNode }).safeParse(data[`t${index}`])
    if (!team.success) return { code: 'failed', message: `GitHub shows the signed-in user no team ${organization}/${slug}` }
    teamIds.push(team.data.team.id)
  }
  return { users: userIds, teams: teamIds }
}

/**
 * Update the head branch with `updatePullRequestBranch`. The head is read first and the update is refused once it is
 * another commit; GitHub also checks `expectedHeadOid` itself.
 * @param read - runs one GraphQL query.
 * @param write - runs one GraphQL mutation.
 * @param ref - pull request address.
 * @param request - update method and the head commit the user confirmed.
 * @param signal - cancellation of both requests.
 * @returns undefined once GitHub accepted the update, `stale` when the head moved, or why GitHub refused.
 * @throws when `request.headSha` is not a full commit object name.
 */
export async function updateGitHubBranch(
  read: GraphqlReader, write: GraphqlWriter, ref: ChangeRequestRef, request: BranchUpdateRequest, signal: AbortSignal,
): Promise<ForgeActionFailure | undefined> {
  if (!isCommit(request.headSha)) throw new Error(`forge-github: invalid head commit ${JSON.stringify(request.headSha)}`)
  const id = await pullRequestNode(read, ref, request.headSha, signal)
  if (typeof id !== 'string') return id
  return await write(ref.repository.host, { query: UPDATE_BRANCH_MUTATION, field: 'updatePullRequestBranch', variables: {
    input: { pullRequestId: id, expectedHeadOid: request.headSha, updateMethod: request.method === 'rebase' ? 'REBASE' : 'MERGE' },
  } }, signal)
}

/**
 * List accounts a review can be requested from: GitHub's suggestions for the pull request when `query` is empty, then
 * the accounts that can be assigned in the repository whose login or name matches `query`, without the author.
 * @param read - runs one GraphQL query.
 * @param ref - pull request address.
 * @param query - text the login or name contains.
 * @param signal - cancellation of the read.
 * @returns at most 20 accounts, each once, or why GitHub did not list them.
 */
export async function gitHubReviewerCandidates(
  read: GraphqlReader, ref: ChangeRequestRef, query: string, signal: AbortSignal,
): Promise<readonly ForgeReviewerCandidate[] | ForgeFailure> {
  const { host, owner, name } = checkedRepository(ref)
  const search = query.trim()
  const body = await read([
    'api', 'graphql', '--hostname', host, '-f', `query=${CANDIDATES_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
    '-F', `number=${ref.number}`, '-f', `search=${search}`,
  ], signal)
  if (!body.ok) return body.failure
  const parsed = candidatesSchema.safeParse(body.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitHub response to the reviewer listing' }
  const repository = parsed.data.data.repository
  if (repository === null) return { code: 'not-found', message: `repository ${owner}/${name} is not visible` }
  const author = repository.pullRequest?.author?.login.toLowerCase()
  const listed = new Map<string, ForgeReviewerCandidate>()
  const add = (entry: z.infer<typeof account>, suggested: boolean): void => {
    const key = entry.login.toLowerCase()
    if (key !== author && !listed.has(key)) listed.set(key, { login: entry.login, name: entry.name, avatarUrl: entry.avatarUrl, suggested })
  }
  if (search === '') for (const suggestion of repository.pullRequest?.suggestedReviewers ?? []) add(suggestion.reviewer, true)
  for (const user of repository.assignableUsers.nodes) add(user, false)
  return [...listed.values()].slice(0, CANDIDATES)
}
