/** GitLab writes and reads of the merge request overview: pipeline retries, review requests, reviewer candidates, and rebases. */

import type {
  BranchUpdateRequest, ChangeRequestRef, ChangeRequestSnapshot, ForgeActionFailure, ForgeFailure, ForgeRerunRequest,
  ForgeReviewerCandidate, ForgeReviewersRequest,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GitLabApi } from './api.ts'
import { avatarUrlOf, checkedProject, mergeRequestPath } from './urls.ts'

/** Most accounts one candidate listing returns. */
const CANDIDATES = 20

/** Reviewers read before a review request; more than GitLab's paid tiers usually assign. */
const REVIEWERS = 100

/** Global id of a CI pipeline, which names the rerun of its jobs. */
const PIPELINE = /^gid:\/\/gitlab\/Ci::Pipeline\/([1-9]\d{0,17})$/

/** The merge request's reviewers and whether it takes more than one; variables `path` and `iid` are strings. */
export const REVIEWERS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) { mergeRequest(iid: $iid) { allowsMultipleReviewers reviewers(first: ${REVIEWERS}) { nodes { id username } } } }
}`

/** Add reviewers by username; variables `path`, `iid`, and `usernames` name them. */
export const SET_REVIEWERS_MUTATION = `mutation($path: ID!, $iid: String!, $usernames: [String!]!) {
  mergeRequestSetReviewers(input: { projectPath: $path, iid: $iid, reviewerUsernames: $usernames, operationMode: APPEND }) { errors }
}`

/** Ask a reviewer for another review; variables `path`, `iid`, and `user`, the reviewer's global id. */
export const REREVIEW_MUTATION = `mutation($path: ID!, $iid: String!, $user: UserID!) {
  mergeRequestReviewerRereview(input: { projectPath: $path, iid: $iid, userId: $user }) { errors }
}`

/** Accounts that match a search and the merge request's author; variables `path`, `iid`, and `search` are strings. */
export const CANDIDATES_QUERY = `query($path: ID!, $iid: String!, $search: String!) {
  project(fullPath: $path) { autocompleteUsers(search: $search) { username name avatarUrl } mergeRequest(iid: $iid) { author { username } } }
}`

const reviewersSchema = z.object({
  project: z.object({
    mergeRequest: z.object({
      allowsMultipleReviewers: z.boolean(),
      reviewers: z.object({ nodes: z.array(z.object({ id: z.string(), username: z.string() })) }),
    }).nullable(),
  }).nullable(),
})

const candidatesSchema = z.object({
  project: z.object({
    autocompleteUsers: z.array(z.object({ username: z.string(), name: z.string(), avatarUrl: z.string().nullable() })).nullable(),
    mergeRequest: z.object({ author: z.object({ username: z.string() }).nullable() }).nullable(),
  }).nullable(),
})

/**
 * Retry the head pipeline when it has failed jobs and none pending. GitLab retries a pipeline's failed and cancelled jobs
 * together, so every job names its pipeline as its rerun; the head is read first through `read`, and a head other than
 * `request.headSha` is refused with `stale`.
 * @param api - GitLab writes.
 * @param read - reads the merge request's status with all its checks.
 * @param ref - merge request, with a project path already checked for inlining.
 * @param request - the head commit whose checks the user saw.
 * @param signal - cancellation of the read and the retries.
 * @returns undefined once GitLab accepted every retry, or why it did not.
 */
export async function rerunGitLabChecks(
  api: GitLabApi, read: () => Promise<ChangeRequestSnapshot | ForgeFailure>, ref: ChangeRequestRef, request: ForgeRerunRequest,
  signal: AbortSignal,
): Promise<ForgeActionFailure | undefined> {
  const snapshot = await read()
  if ('code' in snapshot) return { code: snapshot.code === 'unauthenticated' ? 'unauthenticated' : 'failed', message: snapshot.message }
  if (snapshot.headSha.toLowerCase() !== request.headSha.toLowerCase()) {
    return { code: 'stale', message: `the merge request head moved from ${request.headSha} to ${snapshot.headSha}` }
  }
  const failed = new Set<string>()
  const running = new Set<string>()
  for (const check of snapshot.checks) {
    const pipeline = check.rerun === null ? undefined : PIPELINE.exec(check.rerun)?.[1]
    if (pipeline === undefined) continue
    if (check.state === 'failure') failed.add(pipeline)
    else if (check.state === 'pending') running.add(pipeline)
  }
  const pipelines = [...failed].filter(pipeline => !running.has(pipeline))
  if (pipelines.length === 0) {
    return { code: 'failed', message: failed.size === 0 ? 'No failed GitLab job of the head pipeline can be retried'
      : 'The head pipeline still runs jobs; retry its failed jobs once they finish' }
  }
  const project = encodeURIComponent(checkedProject(ref))
  for (const pipeline of pipelines) {
    const retried = await api.write(ref.repository.host, ['-X', 'POST', `projects/${project}/pipelines/${pipeline}/retry`], signal)
    if (!retried.ok) return retried.failure
  }
  return undefined
}

/**
 * Request reviews, adding to GitLab's reviewers. Accounts that are not reviewers yet are added by username; a reviewer
 * named again is asked for another review. GitLab has no team reviewers, and a merge request that takes one reviewer,
 * as on GitLab's free tier, refuses a second before anything is sent.
 * @param api - GitLab reads and writes.
 * @param ref - merge request, with a project path already checked for inlining.
 * @param request - the reviewers to ask.
 * @param signal - cancellation of every request.
 * @returns undefined once GitLab accepted every request, or why it refused; a refused second review request follows
 * accepted earlier ones.
 */
export async function requestGitLabReviews(
  api: GitLabApi, ref: ChangeRequestRef, request: ForgeReviewersRequest, signal: AbortSignal,
): Promise<ForgeActionFailure | undefined> {
  if (request.reviewers.length === 0) return { code: 'failed', message: 'No reviewer was named' }
  if (request.reviewers.some(reviewer => reviewer.kind === 'team')) return { code: 'failed', message: 'GitLab has no team reviewers' }
  const host = ref.repository.host
  const variables = { path: checkedProject(ref), iid: String(ref.number) }
  const read = await api.graphql(host, REVIEWERS_QUERY, variables, signal)
  if (!read.ok) return { code: read.failure.code === 'unauthenticated' ? 'unauthenticated' : 'failed', message: read.failure.message }
  const merge = reviewersSchema.safeParse(read.body).data?.project?.mergeRequest
  if (merge == null) return { code: 'failed', message: 'unexpected GitLab response to the reviewer read' }
  const current = new Map(merge.reviewers.nodes.map(reviewer => [reviewer.username.toLowerCase(), reviewer.id]))
  const again = [...new Set(request.reviewers.flatMap(reviewer => current.get(reviewer.login.toLowerCase()) ?? []))]
  const added: string[] = []
  for (const { login } of request.reviewers) {
    const key = login.toLowerCase()
    if (!current.has(key) && !added.some(entry => entry.toLowerCase() === key)) added.push(login)
  }
  if (!merge.allowsMultipleReviewers && current.size + added.length > 1) {
    return { code: 'failed', message: 'This GitLab merge request takes one reviewer; change its reviewer on GitLab' }
  }
  if (added.length > 0) {
    const set = await api.mutate(host, SET_REVIEWERS_MUTATION, { ...variables, usernames: added }, 'mergeRequestSetReviewers', signal)
    if (!('ok' in set)) return set
  }
  for (const user of again) {
    const asked = await api.mutate(host, REREVIEW_MUTATION, { ...variables, user }, 'mergeRequestReviewerRereview', signal)
    if (!('ok' in asked)) return asked
  }
  return undefined
}

/**
 * List accounts a review can be requested from: GitLab's matches for `query` among the users who can see the project,
 * without the author. GitLab suggests no reviewers on its free tier, so no account is marked suggested.
 * @param api - GitLab reads.
 * @param ref - merge request, with a project path already checked for inlining.
 * @param query - text the login or name contains.
 * @param signal - cancellation of the read.
 * @returns at most 20 accounts, each with an absolute avatar URL, or why GitLab did not list them.
 */
export async function gitLabReviewerCandidates(
  api: GitLabApi, ref: ChangeRequestRef, query: string, signal: AbortSignal,
): Promise<readonly ForgeReviewerCandidate[] | ForgeFailure> {
  const host = ref.repository.host
  const variables = { path: checkedProject(ref), iid: String(ref.number), search: query.trim() }
  const read = await api.graphql(host, CANDIDATES_QUERY, variables, signal)
  if (!read.ok) return read.failure
  const project = candidatesSchema.safeParse(read.body).data?.project
  if (project === undefined) return { code: 'unavailable', message: 'unexpected GitLab response to the reviewer listing' }
  if (project === null) return { code: 'not-found', message: `project ${checkedProject(ref)} is not visible` }
  const author = project.mergeRequest?.author?.username.toLowerCase()
  return (project.autocompleteUsers ?? []).filter(user => user.username.toLowerCase() !== author).slice(0, CANDIDATES).map(user => ({
    login: user.username, name: user.name, suggested: false,
    avatarUrl: avatarUrlOf(host, user.avatarUrl),
  }))
}

/**
 * Rebase the head branch onto the target branch. GitLab names no head commit in a rebase request, so the merge request is
 * read first and the rebase is refused with `stale` once its head is another commit; a push between the read and the
 * request is rebased too. GitLab rebases in the background and answers once it accepted the rebase.
 * @param api - GitLab reads and writes.
 * @param ref - merge request, with a project path already checked for inlining.
 * @param request - update method and the head commit the user confirmed.
 * @param signal - cancellation of the read and the request.
 * @returns undefined once GitLab accepted the rebase, `stale` when the head moved, or why GitLab refused.
 */
export async function updateGitLabBranch(
  api: GitLabApi, ref: ChangeRequestRef, request: BranchUpdateRequest, signal: AbortSignal,
): Promise<ForgeActionFailure | undefined> {
  if (request.method !== 'rebase') return { code: 'failed', message: 'GitLab updates a merge request branch only by rebasing it' }
  const host = ref.repository.host
  const read = await api.rest(host, `${mergeRequestPath(ref)}?include_rebase_in_progress=true`, signal)
  if (!read.ok) return { code: read.failure.code === 'unauthenticated' ? 'unauthenticated' : 'failed', message: read.failure.message }
  const merge = z.object({ sha: z.string(), rebase_in_progress: z.boolean().optional() }).safeParse(read.body)
  if (!merge.success) return { code: 'failed', message: 'unexpected GitLab response to the merge request read' }
  if (merge.data.sha.toLowerCase() !== request.headSha.toLowerCase()) {
    return { code: 'stale', message: `the merge request head moved from ${request.headSha} to ${merge.data.sha}` }
  }
  if (merge.data.rebase_in_progress === true) return { code: 'failed', message: 'GitLab is already rebasing the merge request' }
  const rebased = await api.write(host, ['-X', 'PUT', `${mergeRequestPath(ref)}/rebase`], signal)
  return rebased.ok ? undefined : rebased.failure
}
