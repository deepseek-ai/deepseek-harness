/** Read-only PR snapshots and policy preflight/check workflow entry points. */

import fs from 'node:fs'
import process from 'node:process'

import config from './config.json' with { type: 'json' }
import { api, projectContext } from './github.mjs'
import {
  parseReferences,
  retainIssueReferences,
  requiresPullRequestPolicy,
  validatePullRequest,
} from './rules.mjs'

/**
 * Resolve all same-repository body references with REST, excluding pull-request numbers.
 * @param {number} number Pull-request number.
 * @param {{body?: string}} pull Current REST pull-request data.
 * @returns {Promise<object>} Issue-only references and placeholder priorities; never reads Project data.
 */
export async function resolvingReferencesSnapshot(number, pull) {
  const references = parseReferences({
    body: pull.body ?? '',
    repository: `${config.organization}/${config.repository}`,
  })
  const issues = new Map()
  for (const issueNumber of references.all) {
    const issue = await api(
      `/repos/${config.organization}/${config.repository}/issues/${issueNumber}`,
    )
    if (!issue.pull_request) issues.set(issueNumber, { priority: null })
  }
  return {
    number,
    references: retainIssueReferences(references, issues),
    issues,
  }
}

/**
 * Read current PR policy inputs, skipping references for exempt PRs.
 * @param {number} number Pull-request number.
 * @param {boolean} includeProject Read Project Priority for resolving Issues when true.
 * @returns {Promise<object>} Policy snapshot; rejects any failed read and performs no writes.
 */
export async function pullRequestSnapshot(number, includeProject = true) {
  const pull = await api(`/repos/${config.organization}/${config.repository}/pulls/${number}`)
  const snapshot = {
    number,
    isDraft: pull.draft,
    authorType: pull.user?.type ?? 'User',
    reviewRequestCount: 0,
    reviewCount: 0,
    labels: pull.labels.map((label) => label.name),
    references: { all: [], resolving: [], related: [] },
    issues: new Map(),
  }
  if (snapshot.isDraft || ['Bot', 'App'].includes(snapshot.authorType)) return snapshot
  const [reviewRequests, reviews] = await Promise.all([
    api(`/repos/${config.organization}/${config.repository}/pulls/${number}/requested_reviewers`),
    api(`/repos/${config.organization}/${config.repository}/pulls/${number}/reviews?per_page=100`),
  ])
  snapshot.reviewRequestCount = reviewRequests.users.length + reviewRequests.teams.length
  snapshot.reviewCount = reviews.length
  if (!requiresPullRequestPolicy(snapshot)) return snapshot
  Object.assign(snapshot, await resolvingReferencesSnapshot(number, pull))
  if (includeProject) {
    for (const issueNumber of snapshot.references.resolving) {
      const context = await projectContext(issueNumber)
      snapshot.issues.get(issueNumber).priority = context.item?.priorityValue?.name ?? null
    }
  }
  return snapshot
}

/**
 * Read PR creation time and Issue references without review eligibility gating.
 * @param {number} number Pull-request number.
 * @returns {Promise<object>} Lifecycle snapshot without Project reads or writes.
 */
export async function lifecyclePullRequestSnapshot(number) {
  const pull = await api(`/repos/${config.organization}/${config.repository}/pulls/${number}`)
  return {
    ...(await resolvingReferencesSnapshot(number, pull)),
    createdAt: pull.created_at,
  }
}

const EXEMPT_MESSAGE =
  'Issue policy exempt：当前 PR 不在强制范围（Draft、Bot/App 或尚无 review request/review）。\n'

/**
 * Determine current policy eligibility and Project access needs without Project credentials.
 * @param {{pull_request: {number: number}}} event GitHub event identifying the PR.
 * @returns {Promise<{eligible: boolean, needsProject: boolean}>} Trusted workflow decisions.
 */
export async function runPullRequestPreflight(event) {
  const pull = await pullRequestSnapshot(event.pull_request.number, false)
  const eligible = requiresPullRequestPolicy(pull)
  const needsProject = eligible && pull.references.resolving.length > 0
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `eligible=${eligible}\nexempt=${!eligible}\nneeds-project=${needsProject}\n`,
    )
  }
  process.stdout.write(eligible ? 'Issue policy applicable；执行完整校验。\n' : EXEMPT_MESSAGE)
  return { eligible, needsProject }
}

/**
 * Enforce all PR rules against current GitHub state, independently of preflight.
 * @param {{pull_request: {number: number}}} event GitHub event identifying the PR.
 * @returns {Promise<void>} Resolves on success or exemption; rejects policy failures.
 */
export async function runPullRequestCheck(event) {
  const pull = await pullRequestSnapshot(event.pull_request.number)
  const errors = validatePullRequest(pull)
  if (errors.length > 0) {
    for (const error of errors) process.stdout.write(`::error::${error}\n`)
    throw new Error(`Issue policy 未通过，共 ${errors.length} 项`)
  }
  process.stdout.write(
    requiresPullRequestPolicy(pull) ? 'Issue policy 通过。\n' : EXEMPT_MESSAGE,
  )
}
