#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { productionOwnership, LOGIN } from './blame-ownership.mjs'
import { FIXED_AUTHOR_POINTS, authorCreditPoints, countMergedAuthorPulls } from './author-weight.mjs'

const API_VERSION = '2026-03-10'
const MAX_PULL_REQUEST_RECORDS = 3_000
const PAGE_SIZE = 100
const STATUS_MARKER = '<!-- weighted-approval -->'
const WRITABLE_PERMISSIONS = new Set(['admin', 'write'])
const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'])

class GitHubApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
  }
}

/**
 * Parse the approval score policy.
 * @param {string} source Approval policy JSON.
 * @returns {{requiredPoints: number, defaultPoints: number, reviewerPoints: Map<string, number>}} Validated policy.
 */
export function parseApprovalPolicy(source) {
  const value = JSON.parse(source)
  if (!isRecord(value)) throw new Error('approval policy must be an object')
  const fields = Object.keys(value).sort()
  if (fields.join(',') !== 'defaultPoints,requiredPoints,reviewerPoints') {
    throw new Error('approval policy must contain only defaultPoints, requiredPoints, and reviewerPoints')
  }
  const requiredPoints = positiveInteger(value.requiredPoints, 'requiredPoints')
  const defaultPoints = positiveInteger(value.defaultPoints, 'defaultPoints')
  if (!isRecord(value.reviewerPoints)) throw new Error('reviewerPoints must be an object')
  const reviewerPoints = new Map()
  for (const [login, pointsValue] of Object.entries(value.reviewerPoints)) {
    validateLogin(login, 'approval policy reviewer')
    const key = login.toLowerCase()
    if (reviewerPoints.has(key)) throw new Error(`duplicate approval policy reviewer @${login}`)
    reviewerPoints.set(key, positiveInteger(pointsValue, `reviewerPoints.${login}`))
  }
  return { requiredPoints, defaultPoints, reviewerPoints }
}

/**
 * Select each reviewer's current approval or change-request decision.
 * @param {unknown[]} reviews Pull-request review records in GitHub's chronological order.
 * @returns {Array<{login: string, state: 'APPROVED' | 'CHANGES_REQUESTED'}>} Effective review decisions.
 */
export function effectiveReviewDecisions(reviews) {
  const decisions = new Map()
  for (const review of reviews) {
    if (!isRecord(review)) throw new Error('pull-request review is not an object')
    if (review.user === null) continue
    if (!isRecord(review.user) || typeof review.user.login !== 'string') {
      throw new Error('pull-request review has no reviewer login')
    }
    const login = validateLogin(review.user.login, 'pull-request reviewer')
    if (typeof review.state !== 'string' || !REVIEW_STATES.has(review.state.toUpperCase())) {
      throw new Error(`pull-request review by @${login} has an invalid state`)
    }
    const state = review.state.toUpperCase()
    const key = login.toLowerCase()
    if (state === 'DISMISSED') {
      decisions.delete(key)
    } else if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') {
      decisions.set(key, { login, state })
    }
  }
  return [...decisions.values()]
}

/**
 * Create a repository-scoped GitHub JSON API caller.
 * @param {{token: string, apiUrl?: string, fetchImpl?: typeof fetch}} options API dependencies.
 * @returns {(path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>} API caller.
 */
export function createGitHubApi({ token, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('GITHUB_TOKEN is not set')
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  const root = apiUrl.replace(/\/+$/u, '')
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'deepseek-harness-weighted-approval',
        'X-GitHub-Api-Version': API_VERSION,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const responseBody = await response.text()
      throw new GitHubApiError(
        `GitHub API ${method} ${path} returned ${response.status}: ${JSON.stringify(responseBody)}`,
        response.status,
      )
    }
    if (response.status === 204) return undefined
    return response.json()
  }
}

/**
 * Fetch every pull-request review or fail before scoring a partial list.
 * @param {(path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>} api GitHub API caller.
 * @param {string} repository Owner/name repository identifier.
 * @param {number} pullNumber Pull-request number.
 * @returns {Promise<unknown[]>} Complete review list within the supported limit.
 */
export async function listPullRequestReviews(api, repository, pullNumber) {
  return listRecords(api, `/repos/${repository}/pulls/${pullNumber}/reviews`, 'pull-request reviews')
}

async function listRecords(api, path, subject) {
  const records = []
  for (let page = 1; ; page++) {
    const response = await api(`${path}?per_page=${PAGE_SIZE}&page=${page}`)
    if (!Array.isArray(response)) throw new Error(`${subject} response is not an array`)
    records.push(...response)
    if (response.length < PAGE_SIZE) return records
    if (records.length >= MAX_PULL_REQUEST_RECORDS) {
      throw new Error(`${subject} exceed ${MAX_PULL_REQUEST_RECORDS} records`)
    }
  }
}

async function delegationCommands(api, comments) {
  const candidates = []
  for (const comment of comments) {
    if (!isRecord(comment)) throw new Error('pull-request comment is not an object')
    if (comment.user === null) continue
    if (typeof comment.body !== 'string') throw new Error('pull-request comment has no body')
    const match = /^\/delegate @([^\s]+)$/u.exec(comment.body.trim())
    if (!match || !LOGIN.test(match[1])) continue
    const login = validateLogin(comment.user?.login, 'delegation author')
    if (!Number.isSafeInteger(comment.id) || comment.id <= 0) throw new Error('delegation comment has no valid ID')
    if (!comment.node_id || !comment.user.node_id) throw new Error('delegation comment has no account or node ID')
    candidates.push({ comment, login, delegate: match[1], createdAt: timestamp(comment.created_at, 'delegation comment') })
  }
  const commands = []
  for (let offset = 0; offset < candidates.length; offset += PAGE_SIZE) {
    const batch = candidates.slice(offset, offset + PAGE_SIZE)
    const response = await api('/graphql', {
      method: 'POST',
      body: {
        query: `query($ids: [ID!]!) {
          nodes(ids: $ids) { ... on IssueComment {
            id body createdAt lastEditedAt
            author { ... on Node { id } }
            editor { ... on Node { id } }
          } }
        }`,
        variables: { ids: batch.map(({ comment }) => comment.node_id) },
      },
    })
    const nodes = response?.data?.nodes
    if (response?.errors?.length || !Array.isArray(nodes) || nodes.length !== batch.length) {
      throw new Error('delegation comment editor history is incomplete')
    }
    for (const [index, command] of batch.entries()) {
      const node = nodes[index]
      const { comment } = command
      if (node?.id !== comment.node_id || node.body !== comment.body || node.createdAt !== comment.created_at
        || node.author?.id !== comment.user.node_id || node.lastEditedAt === undefined) {
        throw new Error('delegation comment changed or editor history is incomplete')
      }
      // Other writers can edit a comment without changing its original author.
      if (node.lastEditedAt !== null && node.editor?.id !== node.author.id) continue
      commands.push(command)
    }
  }
  return commands
}

// Reviews must first pass effectiveReviewDecisions; commands retain creation order after edits.
function effectiveDelegations(commands, reviews, writers) {
  const delegations = new Map()
  for (const { login, delegate, comment, createdAt } of commands) {
    const key = login.toLowerCase()
    if (!writers.has(key) || !writers.has(delegate.toLowerCase())) continue
    if (key === delegate.toLowerCase()) delegations.delete(key)
    else delegations.set(key, { delegate: delegate.toLowerCase(), commentId: comment.id, createdAt })
  }
  for (const review of reviews) {
    if (review.user === null || review.state.toUpperCase() === 'PENDING') continue
    const login = review.user.login.toLowerCase()
    const delegation = delegations.get(login)
    if (delegation && timestamp(review.submitted_at, 'submitted review') >= delegation.createdAt) {
      delegations.delete(login)
    }
  }
  return delegations
}

function timestamp(value, subject) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(time)) throw new Error(`${subject} has no valid timestamp`)
  return time
}

/**
 * Evaluate approval points from current reviews and repository permissions.
 * @param {{event: unknown, policySource: string, api: (path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>, getOwnership?: typeof productionOwnership, getMergedCount?: typeof countMergedAuthorPulls}} options Runtime inputs.
 * @returns {Promise<{pull: {repository: string, number: number, headSha: string}, state: 'pending' | 'success', description: string, points: number, authorCredit: {mergedCount: number | null, points: number} | null, requiredPoints: number, approvals: Array<{login: string, points: number, delegatedTo?: string, ownership?: {ownedLines: number, totalLines: number}}>, delegations: Array<{login: string, delegatedTo: string, commentId: number, reviewIds: number[], approved: boolean}>, blockers: string[], ignoredReviewers: string[]}>} Approval decision and status payload fields; approval login owns the points, delegatedTo supplies its decision, delegations contains eligible active commands and their superseded decision review IDs, null author credit means credit was not evaluated, and null mergedCount means fixed author points.
 */
export async function evaluateApproval({ event, policySource, api, getOwnership = productionOwnership, getMergedCount = countMergedAuthorPulls }) {
  const pull = pullRequestFromEvent(event)
  const policy = parseApprovalPolicy(policySource)
  if (pull.draft) {
    return approvalResult(pull, policy.requiredPoints, [], [], [], 'pending', 'draft pull request')
  }

  const reviews = await listPullRequestReviews(api, pull.repository, pull.number)
  // The publisher's own approval records the decision; counting it again would let one reviewer
  // reach the threshold with the bot's review alone.
  const decisions = effectiveReviewDecisions(reviews.filter(review => !isApprovalReview(review)))
    .filter(({ login }) => login.toLowerCase() !== pull.author.toLowerCase())
  const comments = await listRecords(api, `/repos/${pull.repository}/issues/${pull.number}/comments`, 'pull-request comments')
  const commands = await delegationCommands(api, comments)
  const participants = new Map(decisions.map(({ login }) => [login.toLowerCase(), login]))
  for (const { login, delegate } of commands) {
    participants.set(login.toLowerCase(), participants.get(login.toLowerCase()) ?? login)
    participants.set(delegate.toLowerCase(), participants.get(delegate.toLowerCase()) ?? delegate)
  }
  participants.delete(pull.author.toLowerCase())
  const writers = new Set()
  const ignoredReviewers = []
  for (const [key, login] of participants) {
    const permission = await reviewerPermission(api, pull.repository, login)
    if (WRITABLE_PERMISSIONS.has(permission)) writers.add(key)
    else ignoredReviewers.push(login)
  }
  const delegations = effectiveDelegations(commands, reviews, writers)
  const approvals = []
  const activeDelegations = []
  const blockers = decisions.filter(({ login, state }) => writers.has(login.toLowerCase()) && state === 'CHANGES_REQUESTED')
    .map(({ login }) => login)
  const approved = new Set(decisions.filter(({ state }) => state === 'APPROVED').map(({ login }) => login.toLowerCase()))
  for (const key of writers) {
    const delegation = delegations.get(key)
    const target = delegation?.delegate
    const delegatedTo = writers.has(target) ? target : undefined
    if (delegatedTo) activeDelegations.push({
      login: participants.get(key), delegatedTo: participants.get(delegatedTo), commentId: delegation.commentId, approved: approved.has(delegatedTo),
      reviewIds: reviews.filter(review => review.user?.login.toLowerCase() === key
        && ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state.toUpperCase()))
        .map(review => positiveInteger(review.id, 'delegated review ID')),
    })
    if (!approved.has(delegatedTo ?? key)) continue
    approvals.push({
      login: participants.get(key),
      points: policy.reviewerPoints.get(key) ?? policy.defaultPoints,
      ...(delegatedTo ? { delegatedTo: participants.get(delegatedTo) } : {}),
    })
  }
  let authorCredit = null
  const reviewerPoints = approvals.reduce((sum, approval) => sum + approval.points, 0)
  if (blockers.length === 0 && reviewerPoints < policy.requiredPoints) {
    const fixedPoints = FIXED_AUTHOR_POINTS.get(pull.author.toLowerCase())
    const mergedCount = fixedPoints === undefined ? await getMergedCount(pull, api) : null
    authorCredit = { mergedCount, points: fixedPoints ?? authorCreditPoints(mergedCount) }
  }
  const pointsBeforeOwnership = reviewerPoints + (authorCredit?.points ?? 0)
  if (blockers.length === 0 && pointsBeforeOwnership < policy.requiredPoints
    && approvals.some(approval => approval.points === policy.defaultPoints)) {
    const ownership = await getOwnership(pull, api)
    for (const approval of approvals) {
      if (approval.points !== policy.defaultPoints) continue
      const ownedLines = ownership.reviewerLines[approval.login.toLowerCase()] ?? 0
      approval.ownership = { ownedLines, totalLines: ownership.totalLines }
      if (ownership.totalLines > 0) approval.points = Math.min(policy.requiredPoints, policy.defaultPoints
        + (policy.requiredPoints - policy.defaultPoints) * 4 * ownedLines / ownership.totalLines)
    }
  }
  approvals.sort((left, right) => left.login.localeCompare(right.login, 'en'))
  blockers.sort((left, right) => left.localeCompare(right, 'en'))
  ignoredReviewers.sort((left, right) => left.localeCompare(right, 'en'))
  const points = approvals.reduce((total, approval) => {
    const next = total + approval.points
    if (!Number.isFinite(next) || next > Number.MAX_SAFE_INTEGER) throw new Error('approval points must be finite and at most Number.MAX_SAFE_INTEGER')
    return next
  }, authorCredit?.points ?? 0)
  if (blockers.length > 0) {
    return approvalResult(pull, policy.requiredPoints, approvals, blockers, ignoredReviewers, 'pending',
      `${blockers.length} blocking change request${blockers.length === 1 ? '' : 's'}`, authorCredit, activeDelegations)
  }
  // Tolerate floating-point addition error without rounding approval scores.
  const state = points + 1e-12 >= policy.requiredPoints ? 'success' : 'pending'
  return approvalResult(
    pull,
    policy.requiredPoints,
    approvals,
    blockers,
    ignoredReviewers,
    state,
    `${Number(points.toFixed(3))}/${policy.requiredPoints} approval points${authorCredit ? ` (author ${authorCredit.points})` : ''}`,
    authorCredit,
    activeDelegations,
  )
}

/**
 * Evaluate the approval policy and publish its outcome as a status comment or an approving review.
 * @param {{event: unknown, policySource: string, api: (path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>, write?: (line: string) => void, getOwnership?: typeof productionOwnership, getMergedCount?: typeof countMergedAuthorPulls}} options Runtime inputs.
 * @returns {Promise<Awaited<ReturnType<typeof evaluateApproval>>>} Evaluated approval decision.
 */
export async function runApprovalCheck({ event, policySource, api, getOwnership = productionOwnership, getMergedCount = countMergedAuthorPulls, write = line => process.stdout.write(`${line}\n`) }) {
  const pull = pullRequestFromEvent(event)
  let result = await evaluateApproval({ event, policySource, api, getOwnership, getMergedCount })
  for (const delegation of result.delegations) {
    for (const reviewId of delegation.reviewIds) {
      const dismissed = await api(`/repos/${pull.repository}/pulls/${pull.number}/reviews/${reviewId}/dismissals`, {
        method: 'PUT',
        body: { message: `@${delegation.login} delegated approval to @${delegation.delegatedTo} via /delegate.`, event: 'DISMISS' },
      })
      if (!isRecord(dismissed) || dismissed.id !== reviewId || dismissed.state !== 'DISMISSED') {
        throw new Error('delegated review dismissal was not confirmed')
      }
      write(`Dismissed @${delegation.login}'s review ${reviewId} for delegation to @${delegation.delegatedTo}.`)
    }
  }
  if (result.delegations.some(({ reviewIds }) => reviewIds.length)) {
    result = await evaluateApproval({ event, policySource, api, getOwnership, getMergedCount })
  }
  write(result.authorCredit
    ? `Author credit: ${result.authorCredit.points} (${result.authorCredit.mergedCount === null ? `fixed for @${pull.author}` : `${result.authorCredit.mergedCount} merged PRs`}).`
    : `Author credit: not evaluated (${pull.draft ? 'draft' : result.blockers.length ? 'blocking review' : 'reviewer points suffice'}).`)
  write(`Approval score: ${formatPoints(result.points)}/${result.requiredPoints}.`)
  writeList(write, 'Counted approvals', result.approvals.map(({ login, points, ownership, delegatedTo }) =>
    `@${login}: ${formatPoints(points)}${delegatedTo ? ` (delegated to @${delegatedTo})` : ''}${ownership ? ` (${ownership.ownedLines}/${ownership.totalLines} old production lines)` : ''}`))
  writeList(write, 'Blocking change requests', result.blockers.map(login => `@${login}`))
  writeList(write, 'Ignored reviewers without write access', result.ignoredReviewers.map(login => `@${login}`))

  const reviews = await listPullRequestReviews(api, pull.repository, pull.number)
  const approvalReviews = reviews.filter(isApprovalReview)
  if (pull.draft) {
    await retractApprovalReviews(api, pull, approvalReviews, write)
    await removeStatusComment(api, pull, write)
  } else if (result.state === 'success') {
    await removeStatusComment(api, pull, write)
    if (latestReviewState(approvalReviews) !== 'APPROVED') {
      await api(`/repos/${pull.repository}/pulls/${pull.number}/reviews`, {
        method: 'POST',
        body: { event: 'APPROVE', body: approvalReviewBody(result) },
      })
      write('Submitted the weighted approval review.')
    }
  } else {
    await retractApprovalReviews(api, pull, approvalReviews, write)
    await upsertStatusComment(api, pull, result, write)
  }
  try {
    await requestDelegatedReviews(result, api, write)
  } catch (error) {
    write(`Review request failed; approval score is unchanged and the next evaluation will retry: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`)
  }
  return result
}

/**
 * Resolve the reviewed pull request from a completed run of the review-event workflow file.
 * @param {{event: unknown, api: (path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>}} options Trusted workflow inputs.
 * @returns {Promise<Record<string, unknown> | null>} Event with a current pull request, or null after the PR closes or its head changes.
 */
export async function approvalEventFromWorkflowRun({ event, api }) {
  const repository = repositoryFromEvent(event)
  // GitHub can expand run-name into name; the file path identifies the source workflow.
  if (!isRecord(event.workflow_run)
    || event.workflow_run.path !== '.github/workflows/weighted-approval-review-event.yml'
    || event.workflow_run.event !== 'pull_request_review' || event.workflow_run.conclusion !== 'success') {
    throw new Error('event has no successful weighted approval review workflow run')
  }
  const expectedHeadSha = validateHeadSha(event.workflow_run.head_sha, 'workflow run')
  const pullNumber = parsePullNumber(event.workflow_run.display_title)
  if (!Array.isArray(event.workflow_run.pull_requests)) {
    throw new Error('workflow run has no pull_requests array')
  }
  if (event.workflow_run.pull_requests.length > 0
    && !event.workflow_run.pull_requests.some(pull => isRecord(pull) && pull.number === pullNumber)) {
    throw new Error(`workflow run is not associated with pull request #${pullNumber}`)
  }
  const pull = await api(`/repos/${repository}/pulls/${pullNumber}`)
  if (!isRecord(pull) || !isRecord(pull.head)) throw new Error(`pull request #${pullNumber} response is invalid`)
  if (!['open', 'closed'].includes(pull.state)) throw new Error('pull request has an invalid state')
  if (pull.state === 'closed' || pull.head.sha !== expectedHeadSha) return null
  return { ...event, pull_request: pull }
}

/**
 * Resolve a PR conversation comment to the current pull request; ordinary issues are skipped.
 * @param {{event: unknown, api: (path: string) => Promise<unknown>}} options Comment event and API caller.
 * @returns {Promise<Record<string, unknown> | null>} Current PR event, or null for an issue or closed PR.
 */
export async function approvalEventFromComment({ event, api }) {
  const repository = repositoryFromEvent(event)
  if (!isRecord(event.issue)) throw new Error('comment event has no issue')
  if (!isRecord(event.issue.pull_request)) return null
  const number = event.issue.number
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('comment event has no valid pull-request number')
  const pull = await api(`/repos/${repository}/pulls/${number}`)
  if (!isRecord(pull) || pull.number !== number || !['open', 'closed'].includes(pull.state)) {
    throw new Error('comment pull-request response is invalid')
  }
  if (pull.state === 'closed') return null
  const resolved = { ...event, pull_request: pull }
  pullRequestFromEvent(resolved)
  return resolved
}

/**
 * Refresh a pull-request event before any API write; closed PRs and stale heads are skipped.
 * @param {{event: unknown, api: (path: string) => Promise<unknown>}} options Pull-request event and API caller.
 * @returns {Promise<Record<string, unknown> | null>} Live event, or null for a closed PR or superseded head.
 */
export async function approvalEventFromPullRequest({ event, api }) {
  const expected = pullRequestFromEvent(event)
  const resolved = await approvalEventFromComment({ event: { ...event, issue: { number: expected.number, pull_request: {} } }, api })
  if (resolved === null || resolved.pull_request.head.sha !== expected.headSha) return null
  return { ...event, pull_request: resolved.pull_request }
}

async function requestDelegatedReviews(result, api, write) {
  const recipients = new Map(result.delegations.filter(({ approved }) => !approved)
    .map(({ delegatedTo }) => [delegatedTo.toLowerCase(), delegatedTo]))
  if (!recipients.size) return
  const path = `/repos/${result.pull.repository}/pulls/${result.pull.number}/requested_reviewers`
  const requested = await api(path)
  if (!isRecord(requested) || !Array.isArray(requested.users)) throw new Error('requested reviewers response has no users array')
  for (const user of requested.users) recipients.delete(validateLogin(user?.login, 'requested reviewer').toLowerCase())
  if (!recipients.size) return
  await api(path, { method: 'POST', body: { reviewers: [...recipients.values()] } })
  write(`Requested delegated reviews from ${[...recipients.values()].map(login => `@${login}`).join(', ')}.`)
}

function approvalResult(pull, requiredPoints, approvals, blockers, ignoredReviewers, state, detail, authorCredit = null, delegations = []) {
  return {
    pull: { repository: pull.repository, number: pull.number, headSha: pull.headSha },
    state,
    description: `${detail}.`,
    points: approvals.reduce((total, approval) => total + approval.points, authorCredit?.points ?? 0),
    authorCredit,
    requiredPoints,
    approvals,
    delegations,
    blockers,
    ignoredReviewers,
  }
}

async function reviewerPermission(api, repository, login) {
  let response
  try {
    response = await api(`/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`)
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return 'none'
    throw error
  }
  if (!isRecord(response) || typeof response.permission !== 'string') {
    throw new Error(`collaborator permission response for @${login} has no permission`)
  }
  return response.permission.toLowerCase()
}

// Only bot reviews and comments carrying the marker belong to the approval publisher; a reviewer
// can copy the marker, so the account type keeps a copied body from being edited or dismissed.
function isApprovalReview(review) {
  return isRecord(review) && isRecord(review.user) && review.user.type === 'Bot'
    && typeof review.state === 'string' && typeof review.body === 'string' && review.body.includes(STATUS_MARKER)
}

function isStatusComment(comment) {
  return isRecord(comment) && isRecord(comment.user) && comment.user.type === 'Bot'
    && typeof comment.body === 'string' && comment.body.includes(STATUS_MARKER)
}

function latestReviewState(reviews) {
  const latest = reviews.at(-1)
  return typeof latest?.state === 'string' ? latest.state.toUpperCase() : undefined
}

async function retractApprovalReviews(api, pull, reviews, write) {
  for (const review of reviews) {
    if (review.state.toUpperCase() !== 'APPROVED') continue
    const reviewId = positiveInteger(review.id, 'approval review ID')
    const dismissed = await api(`/repos/${pull.repository}/pulls/${pull.number}/reviews/${reviewId}/dismissals`, {
      method: 'PUT',
      body: { message: 'Weighted approval no longer holds.', event: 'DISMISS' },
    })
    if (!isRecord(dismissed) || dismissed.id !== reviewId || dismissed.state !== 'DISMISSED') {
      throw new Error('approval review dismissal was not confirmed')
    }
    write(`Dismissed the weighted approval review ${reviewId}.`)
  }
}

async function upsertStatusComment(api, pull, result, write) {
  const comments = await listRecords(api, `/repos/${pull.repository}/issues/${pull.number}/comments`, 'pull-request comments')
  const existing = comments.find(isStatusComment)
  const body = statusCommentBody(result)
  if (!existing) {
    await api(`/repos/${pull.repository}/issues/${pull.number}/comments`, { method: 'POST', body: { body } })
    write('Created the weighted approval comment.')
    return
  }
  const commentId = positiveInteger(existing.id, 'approval comment ID')
  if (existing.body === body) return
  await api(`/repos/${pull.repository}/issues/comments/${commentId}`, { method: 'PATCH', body: { body } })
  write(`Updated the weighted approval comment ${commentId}.`)
}

async function removeStatusComment(api, pull, write) {
  const comments = await listRecords(api, `/repos/${pull.repository}/issues/${pull.number}/comments`, 'pull-request comments')
  for (const comment of comments.filter(isStatusComment)) {
    const commentId = positiveInteger(comment.id, 'approval comment ID')
    await api(`/repos/${pull.repository}/issues/comments/${commentId}`, { method: 'DELETE' })
    write(`Deleted the weighted approval comment ${commentId}.`)
  }
}

function statusCommentBody(result) {
  const lines = [
    STATUS_MARKER,
    `## Weighted approval: ${formatPoints(result.points)}/${result.requiredPoints} points`,
    '',
    'Counted approvals:',
    ...countedApprovalLines(result),
  ]
  if (result.authorCredit) lines.push('', `Author credit: ${pointLabel(result.authorCredit.points)}.`)
  const remaining = result.requiredPoints - result.points
  if (remaining > 1e-12) lines.push('', `${formatPoints(remaining)} more approval ${formatPoints(remaining) === 1 ? 'point is' : 'points are'} required.`)
  if (result.blockers.length > 0) {
    lines.push('', 'Blocking change requests:')
    for (const login of result.blockers) lines.push(`- @${login}`)
  }
  const waiting = result.delegations.filter(({ approved }) => !approved)
  if (waiting.length > 0) {
    lines.push('', 'Delegated reviews awaited:')
    for (const delegation of waiting) lines.push(`- @${delegation.delegatedTo} for @${delegation.login}`)
  }
  if (result.ignoredReviewers.length > 0) {
    lines.push('', `Reviews without write access are not counted: ${result.ignoredReviewers.map(login => `@${login}`).join(', ')}.`)
  }
  lines.push('', 'This comment is updated on each evaluation and removed when the policy holds.')
  return `${lines.join('\n')}\n`
}

function approvalReviewBody(result) {
  const lines = [
    STATUS_MARKER,
    `Weighted approval satisfied: ${formatPoints(result.points)}/${result.requiredPoints} points.`,
    '',
    'Counted approvals:',
    ...countedApprovalLines(result),
  ]
  if (result.authorCredit) lines.push('', `Author credit: ${pointLabel(result.authorCredit.points)}.`)
  return `${lines.join('\n')}\n`
}

function countedApprovalLines(result) {
  if (result.approvals.length === 0) return ['- (none)']
  return result.approvals.map(({ login, points, delegatedTo, ownership }) => {
    const details = [
      delegatedTo ? `delegated to @${delegatedTo}` : undefined,
      ownership && ownership.totalLines > 0 ? `${ownership.ownedLines}/${ownership.totalLines} changed production lines` : undefined,
    ].filter(detail => detail !== undefined)
    return `- @${login}: ${pointLabel(points)}${details.length > 0 ? ` (${details.join('; ')})` : ''}`
  })
}

function pointLabel(points) {
  const formatted = formatPoints(points)
  return `${formatted} ${formatted === 1 ? 'point' : 'points'}`
}

function formatPoints(points) {
  return Number(points.toFixed(3))
}

function pullRequestFromEvent(event) {
  const repository = repositoryFromEvent(event)
  if (!isRecord(event.pull_request) || !isRecord(event.pull_request.user)
    || !isRecord(event.pull_request.head)) {
    throw new Error('event has no pull_request')
  }
  const pull = event.pull_request
  if (!Number.isSafeInteger(pull.number) || pull.number <= 0) throw new Error('pull request has no valid number')
  if (typeof pull.draft !== 'boolean') throw new Error('pull request has no draft flag')
  const author = validateLogin(pull.user.login, 'pull-request author')
  // REST node_id and GraphQL id identify the same global account node.
  if (typeof pull.user.node_id !== 'string' || !pull.user.node_id) throw new Error('pull request has no author account ID')
  const headSha = validateHeadSha(pull.head.sha, 'pull request')
  return {
    repository,
    number: pull.number,
    draft: pull.draft,
    author,
    authorId: pull.user.node_id,
    headSha,
  }
}

function repositoryFromEvent(event) {
  if (!isRecord(event) || !isRecord(event.repository) || typeof event.repository.full_name !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(event.repository.full_name)) {
    throw new Error('event has no valid repository.full_name')
  }
  return event.repository.full_name
}

function validateHeadSha(value, subject) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${subject} has no valid head SHA`)
  }
  return value
}

function parsePullNumber(source) {
  if (typeof source !== 'string') throw new Error('review event has no valid run title')
  const match = /^weighted-approval-review-event:([1-9][0-9]*)$/u.exec(source)
  if (!match) throw new Error('review event has no valid run title')
  const pullNumber = Number(match[1])
  if (!Number.isSafeInteger(pullNumber)) throw new Error('review event pull request number is not a safe integer')
  return pullNumber
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`)
  return value
}

function validateLogin(value, subject) {
  if (typeof value !== 'string' || !LOGIN.test(value)) throw new Error(`${subject} has an invalid login`)
  return value
}

function writeList(write, title, entries) {
  write(`${title}:`)
  if (entries.length === 0) write('- (none)')
  else for (const entry of entries) write(`- ${entry}`)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set')
  let event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')
  // The approval App token owns every write: the status comment, the approving review, and the
  // review dismissal that takes it back. GitHub counts an App approval toward required reviews only
  // while the App has Contents write, so the workflow requests that permission explicitly.
  const token = process.env.APPROVAL_TOKEN
  if (!token) throw new Error('APPROVAL_TOKEN is not set')
  const api = createGitHubApi({ token, apiUrl: process.env.GITHUB_API_URL })
  if (isRecord(event) && isRecord(event.issue)) {
    event = await approvalEventFromComment({ event, api })
  } else if (isRecord(event) && isRecord(event.workflow_run)) {
    event = await approvalEventFromWorkflowRun({ event, api })
  } else {
    event = await approvalEventFromPullRequest({ event, api })
  }
  if (event === null) {
    process.stdout.write('Skipped an issue, closed pull request, or superseded pull-request head.\n')
    return
  }
  await runApprovalCheck({
    event,
    policySource,
    api,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`weighted approval failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
