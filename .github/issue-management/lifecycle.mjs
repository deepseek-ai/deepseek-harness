/** Repository event orchestration and Issue audit comments. */

import config from './config.json' with { type: 'json' }
import {
  api,
  ensureProjectItem,
  initializeIssueStartDate,
  issueSnapshot,
  projectContext,
  setStatus,
  updateStatus,
} from './github.mjs'
import { lifecyclePullRequestSnapshot } from './pull-request.mjs'
import {
  isInvalidIssueLabel,
  nextResolvingIssueStatus,
  projectDate,
  resolvingIssueStatusCommand,
  validateIssue,
} from './rules.mjs'

const AUDIT_MARKER = '<!-- dsh-issue-policy -->'

/**
 * Initialize every referenced Issue from a newly opened PR.
 * @param {{createdAt: string, references: {all: number[]}}} pull Pull-request snapshot.
 * @param {string} action Pull-request event action.
 * @param {(number: number, date: string) => Promise<void>} initialize Date writer.
 * @returns {Promise<void>} Resolves after all eligible Issues are processed.
 */
export async function initializePullRequestStartDates(
  pull,
  action,
  initialize = initializeIssueStartDate,
) {
  if (action !== 'opened') return
  const date = projectDate(pull.createdAt)
  for (const number of pull.references.all) await initialize(number, date)
}

async function upsertAudit(number, errors) {
  const comments = await api(
    `/repos/${config.organization}/${config.repository}/issues/${number}/comments?per_page=100`,
  )
  const existing = comments.find(
    (comment) => comment.user?.type === 'Bot' && comment.body?.includes(AUDIT_MARKER),
  )
  if (errors.length === 0) {
    if (existing) {
      await api(`/repos/${config.organization}/${config.repository}/issues/comments/${existing.id}`, {
        method: 'DELETE',
      })
    }
    return
  }
  const body = `${AUDIT_MARKER}\n⚠️ Issue policy 未通过：\n\n${errors.map((error) => `- ${error}`).join('\n')}`
  if (existing) {
    if (existing.body === body) return
    await api(`/repos/${config.organization}/${config.repository}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
      headers: { 'Content-Type': 'application/json' },
    })
  } else {
    await api(`/repos/${config.organization}/${config.repository}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/**
 * Remove pull-request kinds and retired aliases from one Issue snapshot.
 * @param {{number: number, labels: string[]}} issue Issue snapshot.
 * @returns {Promise<object>} Snapshot containing only labels that remain on the Issue.
 */
export async function repairIssueLabels(issue) {
  const invalidLabels = issue.labels.filter(isInvalidIssueLabel)
  for (const label of invalidLabels) {
    await api(
      `/repos/${config.organization}/${config.repository}/issues/${issue.number}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE', allow404: true },
    )
  }
  return {
    ...issue,
    labels: issue.labels.filter((label) => !isInvalidIssueLabel(label)),
  }
}

/**
 * Repair deterministic Issue metadata violations and publish the remaining audit result.
 * @param {number} number Same-repository Issue number.
 * @param {string[]} extraErrors Errors supplied by the triggering lifecycle operation.
 * @param {string|null|undefined} status Optional known Project status.
 * @returns {Promise<string[]>} Violations that remain after repair.
 */
export async function auditIssue(number, extraErrors = [], status = undefined) {
  const issue = await issueSnapshot(number, status)
  if (!issue) return []
  const repairedIssue = await repairIssueLabels(issue)
  const errors = [...extraErrors, ...validateIssue(repairedIssue)]
  await upsertAudit(number, errors)
  return errors
}

async function transitionResolvingIssues(pull, command) {
  for (const number of pull.references.resolving) {
    const context = await projectContext(number, command === 'changes-requested')
    const target = nextResolvingIssueStatus(
      context.item?.fieldValueByName?.name ?? null,
      command,
      context.statusActor,
    )
    if (!target) continue
    // TODO: Replace this latest-state guard with per-Issue serialization or a
    // conditional ProjectV2 update; GraphQL currently has no compare-and-swap.
    await updateStatus(context, target)
    await auditIssue(number)
  }
}

/**
 * Apply repository lifecycle events; irrelevant PR events perform no requests.
 * @param {string} eventName GitHub event name.
 * @param {object} event GitHub event payload.
 * @returns {Promise<void>} Resolves after lifecycle updates and audits.
 */
export async function runLifecycle(eventName, event) {
  if (eventName === 'issues') {
    const number = event.issue.number
    if (event.action === 'opened') await setStatus(number, 'Inbox')
    if (event.action === 'closed') {
      const target = event.issue.state_reason === 'not_planned' ? 'No action' : 'Done'
      await setStatus(number, target)
    }
    if (event.action === 'reopened') {
      await setStatus(number, 'Inbox')
    }
    await ensureProjectItem(number)
    await auditIssue(number)
    return
  }

  if (eventName === 'pull_request' || eventName === 'pull_request_review') {
    const command = resolvingIssueStatusCommand(eventName, event)
    if (!command) return
    const pull = await lifecyclePullRequestSnapshot(event.pull_request.number)
    await transitionResolvingIssues(pull, command)
    if (eventName === 'pull_request') {
      await initializePullRequestStartDates(pull, event.action)
    }
  }
}
