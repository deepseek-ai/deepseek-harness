#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { productionOwnership } from './blame-ownership.mjs'
import { countMergedAuthorPulls } from './author-weight.mjs'
import {
  approvalEventFromComment, approvalEventFromPullRequest, approvalEventFromWorkflowRun, createGitHubApi,
  displayedPoints, evaluateApproval, formatPoints, isPublisherAuthored, isRecord, listPullRequestReviews, listRecords,
  positiveInteger, pullRequestFromEvent, PUBLISHER_LOGIN, PUBLISHER_USER_ID, writeList,
} from './check-approval.mjs'

const STATUS_MARKER = '<!-- weighted-approval -->'
const CANONICAL_PULL_NUMBER = /^[1-9][0-9]*$/u

/**
 * Pinned numeric ID of the GitHub Actions bot that authors status comments with the workflow token.
 * Other repository workflows share the account, so a status comment also needs the marker on its first line.
 */
export const ACTIONS_BOT_USER_ID = 41_898_282

/**
 * Prove that the machine-user PAT belongs to the expected account before any review write.
 * @param {(path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>} api Review-write API caller.
 * @returns {Promise<{id: number, login: string}>} Pinned machine-user identity.
 */
export async function verifyPublisherIdentity(api) {
  const user = await api('/user')
  if (!isRecord(user) || user.id !== PUBLISHER_USER_ID
    || typeof user.login !== 'string' || user.login.toLowerCase() !== PUBLISHER_LOGIN) {
    throw new Error(`APPROVAL_TOKEN is not the @${PUBLISHER_LOGIN} machine user (User ID ${PUBLISHER_USER_ID})`)
  }
  return { id: PUBLISHER_USER_ID, login: PUBLISHER_LOGIN }
}

/**
 * Identify a status comment by its first line and the Actions bot account.
 * @param {unknown} record Pull-request comment record.
 * @returns {boolean} Whether the record is a status comment this publisher maintains.
 */
export function isActionsBotComment(record) {
  return isRecord(record) && isRecord(record.user) && record.user.id === ACTIONS_BOT_USER_ID
    && typeof record.body === 'string' && record.body.split('\n', 1)[0] === STATUS_MARKER
}

/**
 * Identify a marked review authored by the machine user.
 * @param {unknown} record Pull-request review record.
 * @returns {boolean} Whether the review belongs to the approval publisher.
 */
export function isPublisherReview(record) {
  return isPublisherAuthored(record) && typeof record.body === 'string' && record.body.includes(STATUS_MARKER)
}

/**
 * Evaluate the approval policy with the Actions App token and publish its outcome, using the machine-user PAT only for a review write.
 * @param {{event: unknown, policySource: string, readApi: (path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>, reviewApi?: (path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>, getOwnership?: typeof productionOwnership, getMergedCount?: typeof countMergedAuthorPulls, write?: (line: string) => void}} options Runtime inputs; readApi owns every repository read and status comment, reviewApi is optional until an approval submit or dismissal.
 * @returns {Promise<Awaited<ReturnType<typeof evaluateApproval>>>} Evaluated approval decision.
 */
export async function runApprovalCheck({ event, policySource, readApi, reviewApi, getOwnership = productionOwnership, getMergedCount = countMergedAuthorPulls, write = line => process.stdout.write(`${line}\n`) }) {
  if (typeof readApi !== 'function') throw new Error('runApprovalCheck requires the Actions App token API as readApi')
  const pull = pullRequestFromEvent(event)
  const reviewWrite = lazyReviewWrite(reviewApi)
  let result
  try {
    result = await evaluateApproval({ event, policySource, api: readApi, getOwnership, getMergedCount })
  } catch (error) {
    try {
      await retractApprovalOnScoringFailure({ readApi, reviewWrite, pull, write })
    } catch (retractionError) {
      throw new Error(
        `${errorMessage(error)}; retracting the previous weighted approval also failed: ${errorMessage(retractionError)}`,
        { cause: error },
      )
    }
    throw error
  }
  write(result.authorCredit
    ? `Author credit: ${result.authorCredit.points} (${result.authorCredit.mergedCount === null ? `fixed for @${pull.author}` : `${result.authorCredit.mergedCount} merged PRs`}).`
    : `Author credit: not evaluated (${pull.draft ? 'draft' : result.blockers.length ? 'blocking review' : 'reviewer points suffice'}).`)
  write(`Approval score: ${result.state === 'success' ? formatPoints(result.points) : displayedPoints(result.points)}/${result.requiredPoints}.`)
  writeList(write, 'Counted approvals', result.approvals.map(({ login, points, ownership, delegatedTo }) =>
    `@${login}: ${result.state === 'success' ? formatPoints(points) : displayedPoints(points)}${delegatedTo ? ` (delegated to @${delegatedTo})` : ''}${ownership ? ` (${ownership.ownedLines}/${ownership.totalLines} old production lines)` : ''}`))
  writeList(write, 'Blocking change requests', result.blockers.map(login => `@${login}`))
  writeList(write, 'Ignored reviewers without write access', result.ignoredReviewers.map(login => `@${login}`))

  const reviews = await listPullRequestReviews(readApi, pull.repository, pull.number)
  const approvalReviews = reviews.filter(isApprovalReview)
  if (pull.draft) {
    await retractApprovalReviews({ reviewWrite, pull, reviews: approvalReviews, write })
    await removeStatusComment(readApi, pull, write)
  } else if (result.state === 'success') {
    // A pushed head between evaluation and publication must not receive an approval for older code.
    await requireEvaluatedHead(readApi, pull)
    if (latestReviewState(approvalReviews, pull.headSha) !== 'APPROVED') {
      const submitted = await reviewWrite(`/repos/${pull.repository}/pulls/${pull.number}/reviews`, {
        method: 'POST',
        body: { event: 'APPROVE', commit_id: pull.headSha, body: approvalReviewBody(result) },
      })
      if (!isRecord(submitted) || submitted.commit_id !== pull.headSha
        || typeof submitted.state !== 'string' || submitted.state.toUpperCase() !== 'APPROVED'
        || !isRecord(submitted.user) || submitted.user.id !== PUBLISHER_USER_ID) {
        throw new Error('approval review was not recorded for the evaluated head and machine user')
      }
      write('Submitted the weighted approval review.')
    }
    // Keep the pending comment until the approval is confirmed, so a failed review leaves the
    // previous, still-accurate status visible.
    await removeStatusComment(readApi, pull, write)
  } else {
    await retractApprovalReviews({ reviewWrite, pull, reviews: approvalReviews, write })
    await upsertStatusComment(readApi, pull, result, write)
  }
  return result
}

/**
 * Resolve a manual refresh dispatch from its canonical pull-request number, ignoring payload state.
 * @param {{event: unknown, readApi: (path: string) => Promise<unknown>}} options Workflow-dispatch event and read API caller.
 * @returns {Promise<Record<string, unknown> | null>} Current PR event, or null for a closed PR.
 */
export async function approvalEventFromWorkflowDispatch({ event, readApi }) {
  if (!isRecord(event.inputs) || typeof event.inputs.pull_number !== 'string'
    || !/^[1-9][0-9]*$/u.test(event.inputs.pull_number)) {
    throw new Error('workflow dispatch has no valid pull-request number')
  }
  const number = Number(event.inputs.pull_number)
  if (!Number.isSafeInteger(number)) throw new Error('workflow dispatch pull-request number is not a safe integer')
  return approvalEventFromComment({
    event: { repository: event.repository, issue: { number, pull_request: {} } },
    api: readApi,
  })
}

function lazyReviewWrite(reviewApi) {
  let verified = false
  return async (path, options) => {
    if (typeof reviewApi !== 'function') {
      throw new Error('APPROVAL_TOKEN is not set; submitting or dismissing a machine review requires the machine-user PAT')
    }
    if (!verified) {
      await verifyPublisherIdentity(reviewApi)
      verified = true
    }
    return reviewApi(path, options)
  }
}

function isApprovalReview(review) {
  return isPublisherReview(review) && typeof review.state === 'string'
}

// An approval for an older commit does not publish the decision for the evaluated head.
function latestReviewState(reviews, headSha) {
  const latest = reviews.at(-1)
  return typeof latest?.state === 'string' && latest.commit_id === headSha ? latest.state.toUpperCase() : undefined
}

async function requireEvaluatedHead(readApi, pull) {
  const current = await readApi(`/repos/${pull.repository}/pulls/${pull.number}`)
  if (!isRecord(current) || current.state !== 'open' || current.draft !== false
    || !isRecord(current.head) || current.head.sha !== pull.headSha) {
    throw new Error('pull request closed, became a draft, or changed head before approval publication')
  }
}

async function retractApprovalReviews({ reviewWrite, pull, reviews, write }) {
  for (const review of reviews) {
    if (review.state.toUpperCase() !== 'APPROVED') continue
    const reviewId = positiveInteger(review.id, 'approval review ID')
    const dismissed = await reviewWrite(`/repos/${pull.repository}/pulls/${pull.number}/reviews/${reviewId}/dismissals`, {
      method: 'PUT',
      body: { message: 'Weighted approval no longer holds.', event: 'DISMISS' },
    })
    if (!isRecord(dismissed) || dismissed.id !== reviewId || dismissed.state !== 'DISMISSED') {
      throw new Error('approval review dismissal was not confirmed')
    }
    write(`Dismissed the weighted approval review ${reviewId}.`)
  }
}

async function retractApprovalOnScoringFailure({ readApi, reviewWrite, pull, write }) {
  const reviews = await listPullRequestReviews(readApi, pull.repository, pull.number)
  await retractApprovalReviews({ reviewWrite, pull, reviews: reviews.filter(isApprovalReview), write })
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function upsertStatusComment(readApi, pull, result, write) {
  const comments = await listRecords(readApi, `/repos/${pull.repository}/issues/${pull.number}/comments`, 'pull-request comments')
  const existing = comments.find(isActionsBotComment)
  const body = statusCommentBody(result)
  if (!existing) {
    await readApi(`/repos/${pull.repository}/issues/${pull.number}/comments`, { method: 'POST', body: { body } })
    write('Created the weighted approval comment.')
    return
  }
  const commentId = positiveInteger(existing.id, 'approval comment ID')
  if (existing.body === body) return
  await readApi(`/repos/${pull.repository}/issues/comments/${commentId}`, { method: 'PATCH', body: { body } })
  write(`Updated the weighted approval comment ${commentId}.`)
}

async function removeStatusComment(readApi, pull, write) {
  const comments = await listRecords(readApi, `/repos/${pull.repository}/issues/${pull.number}/comments`, 'pull-request comments')
  for (const comment of comments.filter(isActionsBotComment)) {
    const commentId = positiveInteger(comment.id, 'approval comment ID')
    await readApi(`/repos/${pull.repository}/issues/comments/${commentId}`, { method: 'DELETE' })
    write(`Deleted the weighted approval comment ${commentId}.`)
  }
}

function statusCommentBody(result) {
  const lines = [
    STATUS_MARKER,
    `## Weighted approval: ${displayedPoints(result.points)}/${result.requiredPoints} points`,
    '',
    'Counted approvals:',
    ...countedApprovalLines(result),
  ]
  if (result.authorCredit) lines.push('', `Author credit: ${pointLabel(result.authorCredit.points)}.`)
  const remaining = remainingPoints(result.points, result.requiredPoints)
  if (remaining > 0) lines.push('', `${remaining} more approval ${remaining === 1 ? 'point is' : 'points are'} required.`)
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
  const formatted = displayedPoints(points)
  return `${formatted} ${formatted === 1 ? 'point' : 'points'}`
}

function remainingPoints(points, required) {
  return Number((Math.ceil((required - points) * 1000) / 1000).toFixed(3))
}

// The workflow job filter is a separate layer; the entrypoint refuses to publish for any pull
// request the configured scope does not select even if that filter stops applying.
function requireReviewScope(scope, pullNumber) {
  if (scope === undefined || scope === '') {
    throw new Error('DSH_APPROVAL_REVIEW_SCOPE is not set; refusing to publish a machine review')
  }
  if (scope === 'all') return
  const number = Number(scope)
  if (!CANONICAL_PULL_NUMBER.test(scope) || !Number.isSafeInteger(number)) {
    throw new Error(`DSH_APPROVAL_REVIEW_SCOPE must be 'all' or a canonical pull-request number, not ${JSON.stringify(scope)}`)
  }
  if (number !== pullNumber) {
    throw new Error(`DSH_APPROVAL_REVIEW_SCOPE selects pull request #${number}, not #${pullNumber}`)
  }
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set')
  let event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')
  const apiUrl = process.env.GITHUB_API_URL
  // The workflow token owns every repository read and every status comment. The machine-user PAT is
  // captured for review writes, verified only when one is needed, and removed before ownership or
  // classifier child processes run, so those processes never inherit it.
  const readToken = process.env.GITHUB_TOKEN
  if (!readToken) throw new Error('GITHUB_TOKEN is not set')
  const readApi = createGitHubApi({ token: readToken, apiUrl })
  const reviewToken = process.env.APPROVAL_TOKEN
  const reviewApi = reviewToken ? createGitHubApi({ token: reviewToken, apiUrl }) : undefined
  delete process.env.APPROVAL_TOKEN
  if (isRecord(event) && Object.hasOwn(event, 'inputs')) {
    event = await approvalEventFromWorkflowDispatch({ event, readApi })
  } else if (isRecord(event) && isRecord(event.issue)) {
    event = await approvalEventFromComment({ event, api: readApi })
  } else if (isRecord(event) && isRecord(event.workflow_run)) {
    event = await approvalEventFromWorkflowRun({ event, api: readApi })
  } else {
    event = await approvalEventFromPullRequest({ event, api: readApi })
  }
  if (event === null) {
    process.stdout.write('Skipped an issue, closed pull request, or superseded pull-request head.\n')
    return
  }
  requireReviewScope(process.env.DSH_APPROVAL_REVIEW_SCOPE, pullRequestFromEvent(event).number)
  await runApprovalCheck({
    event,
    policySource,
    readApi,
    reviewApi,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`weighted approval failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
