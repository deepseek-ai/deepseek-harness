/** GitHub writes and reads of the change request overview: review requests, reviewer candidates, and branch updates. */

import type {
  BranchUpdateRequest, ChangeRequestRef, ForgeActionFailure, ForgeFailure, ForgeReviewerCandidate, ForgeReviewersRequest,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GraphqlReader } from './commits.ts'
import type { GraphqlWriter } from './mutation.ts'
import { pullRequestNode } from './pull-request-node.ts'
import { checkedRepository, isCommit } from './urls.ts'

/** Add review requests by login; variable `input` is a `RequestReviewsByLoginInput`. */
export const REQUEST_REVIEWS_MUTATION = `mutation($input: RequestReviewsByLoginInput!) {
  requestReviewsByLogin(input: $input) { clientMutationId }
}`

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
 * Request reviews by login with `requestReviewsByLogin`, adding to the requests GitHub holds; a bot is named with
 * GitHub's `[bot]` suffix and a team by `organization/slug`.
 * @param read - runs one GraphQL query.
 * @param write - runs one GraphQL mutation.
 * @param ref - pull request address.
 * @param request - the reviewers to ask.
 * @param signal - cancellation of both requests.
 * @returns undefined once GitHub accepted the request, or why it refused.
 */
export async function requestGitHubReviews(
  read: GraphqlReader, write: GraphqlWriter, ref: ChangeRequestRef, request: ForgeReviewersRequest, signal: AbortSignal,
): Promise<ForgeActionFailure | undefined> {
  if (request.reviewers.length === 0) return { code: 'failed', message: 'No reviewer was named' }
  const id = await pullRequestNode(read, ref, null, signal)
  if (typeof id !== 'string') return id
  const logins = (kind: string): string[] => request.reviewers.filter(reviewer => reviewer.kind === kind).map(reviewer => reviewer.login)
  const input: Record<string, unknown> = { pullRequestId: id, union: true }
  const users = logins('user')
  const bots = logins('bot').map(login => login.endsWith('[bot]') ? login : `${login}[bot]`)
  const teams = logins('team')
  if (users.length > 0) input.userLogins = users
  if (bots.length > 0) input.botLogins = bots
  if (teams.length > 0) input.teamSlugs = teams
  return await write(ref.repository.host, { query: REQUEST_REVIEWS_MUTATION, field: 'requestReviewsByLogin', variables: { input } }, signal)
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
