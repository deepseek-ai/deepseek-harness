/** GitLab merge request status through GraphQL, mapped to forge snapshots. */

import type {
  ChangeRequestAutoMerge, ChangeRequestCheck, ChangeRequestIssue, ChangeRequestRef, ChangeRequestReviewer, ChangeRequestSnapshot,
  ChecksRollup, CheckState, ForgeCheckId, ForgeFailure, MergeMethod, ReviewDecision, ReviewVerdict,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import { avatarUrlOf, parseIssueUrl } from './urls.ts'

/** Reviewers and approvers read per merge request; GitLab counts list sizes toward a query's complexity. */
export const PEOPLE_PAGE = 20

/** Jobs of the head pipeline a status poll reads; `fetchChecks` reads the rest. */
export const POLL_JOBS = 50

/** Jobs per page of a complete check read. */
export const JOB_PAGE = 100

/** The automatic merge strategy that merges once every merge check passes, as `availableAutoMergeStrategies` names it. */
const CHECKS_PASS_STRATEGY = 'merge_when_checks_pass'

/** Job fields every job page reads. */
const JOB_FIELDS = 'name status allowFailure stage { name } webPath startedAt finishedAt'

/**
 * Merge request fields one status read takes; `$jobs` sizes the first page of head pipeline jobs, which leaves out jobs a
 * retry replaced, since GitLab lists those beside their retries. The merge status comes before `diffStatsSummary`, after
 * which GitLab 19.5 reports `CONFLICT` for a merge request it found mergeable.
 */
export const MERGE_REQUEST_FRAGMENT = `fragment MergeRequestStatus on MergeRequest {
  iid title webUrl state draft updatedAt closedAt mergedAt
  author { username }
  sourceBranch targetBranch
  diffRefs { baseSha headSha }
  detailedMergeStatus mergeStatusEnum conflicts divergedFromTargetBranch rebaseInProgress
  autoMergeEnabled availableAutoMergeStrategies mergeUser { username }
  diffStatsSummary { additions deletions }
  squash squashOnMerge squashReadOnly approved
  resolvableDiscussionsCount resolvedDiscussionsCount
  userPermissions { canMerge pushToSourceBranch updateMergeRequest }
  approvedBy(first: ${PEOPLE_PAGE}) { pageInfo { hasNextPage } nodes { username avatarUrl bot } }
  reviewers(first: ${PEOPLE_PAGE}) { pageInfo { hasNextPage } nodes { username avatarUrl bot mergeRequestInteraction { reviewState } } }
  headPipeline { id status userPermissions { updatePipeline } jobs(first: $jobs, retried: false) { pageInfo { hasNextPage endCursor } nodes { ${JOB_FIELDS} } } }
}`

/** Following page of head pipeline jobs, without jobs a retry replaced; variables `path`, `iid`, and `cursor` are strings. */
export const JOBS_QUERY = `query($path: ID!, $iid: String!, $cursor: String!) {
  project(fullPath: $path) { mergeRequest(iid: $iid) { diffRefs { headSha } headPipeline { jobs(first: ${JOB_PAGE}, after: $cursor, retried: false) {
    pageInfo { hasNextPage endCursor } nodes { ${JOB_FIELDS} } } } } }
}`

/**
 * Build one query that reads the signed-in user's username and the status of several merge requests, each under the
 * alias `m<index>` with the variables `p<index>` (project path) and `i<index>` (number as a string). GitLab 19.5 answers
 * `CONFLICT` for every merge request it found mergeable after the first one of a query, since each selects
 * `diffStatsSummary`.
 * @param count - number of merge requests.
 * @returns the GraphQL document.
 */
export function statusQuery(count: number): string {
  const declared = Array.from({ length: count }, (_, index) => `$p${index}: ID!, $i${index}: String!`)
  const selected = Array.from({ length: count }, (_, index) =>
    `m${index}: project(fullPath: $p${index}) { mergeRequestsFfOnlyEnabled mergeRequest(iid: $i${index}) { ...MergeRequestStatus } }`)
  const fields = ['currentUser { username }', ...selected].join('\n  ')
  return `query(${['$jobs: Int!', ...declared].join(', ')}) {\n  ${fields}\n}\n${MERGE_REQUEST_FRAGMENT}`
}

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable().optional() })
const person = z.object({ username: z.string(), avatarUrl: z.string().nullable(), bot: z.boolean() })
const jobSchema = z.object({
  name: z.string(),
  status: z.string().nullable(),
  allowFailure: z.boolean(),
  stage: z.object({ name: z.string() }).nullable(),
  webPath: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
const jobPageSchema = z.object({ pageInfo, nodes: z.array(jobSchema) })

/** One merge request as {@link MERGE_REQUEST_FRAGMENT} reads it. */
export const mergeRequestSchema = z.object({
  iid: z.string(),
  title: z.string(),
  webUrl: z.string(),
  state: z.string(),
  draft: z.boolean(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  mergedAt: z.string().nullable(),
  author: z.object({ username: z.string() }).nullable(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  diffRefs: z.object({ baseSha: z.string().nullable(), headSha: z.string() }).nullable(),
  diffStatsSummary: z.object({ additions: z.number(), deletions: z.number() }).nullable(),
  detailedMergeStatus: z.string().nullable(),
  mergeStatusEnum: z.string().nullable(),
  conflicts: z.boolean(),
  divergedFromTargetBranch: z.boolean(),
  rebaseInProgress: z.boolean(),
  autoMergeEnabled: z.boolean(),
  availableAutoMergeStrategies: z.array(z.string()).nullable(),
  mergeUser: z.object({ username: z.string() }).nullable(),
  squash: z.boolean(),
  squashOnMerge: z.boolean(),
  squashReadOnly: z.boolean(),
  approved: z.boolean(),
  resolvableDiscussionsCount: z.number().nullable(),
  resolvedDiscussionsCount: z.number().nullable(),
  userPermissions: z.object({ canMerge: z.boolean(), pushToSourceBranch: z.boolean(), updateMergeRequest: z.boolean() }),
  approvedBy: z.object({ pageInfo, nodes: z.array(person) }).nullable(),
  reviewers: z.object({
    pageInfo,
    nodes: z.array(person.extend({ mergeRequestInteraction: z.object({ reviewState: z.string().nullable() }).nullable() })),
  }),
  headPipeline: z.object({
    id: z.string(),
    status: z.string(),
    userPermissions: z.object({ updatePipeline: z.boolean() }),
    jobs: jobPageSchema.nullable(),
  }).nullable(),
})

/** One aliased project of a status query. */
export const projectSchema = z.object({
  mergeRequestsFfOnlyEnabled: z.boolean(),
  mergeRequest: mergeRequestSchema.nullable(),
}).nullable()

/**
 * Read the signed-in user's username from the answer to a status query.
 * @param data - the `data` object of the answer.
 * @returns the username, or null when the answer names no signed-in user.
 */
export function statusViewer(data: Readonly<Record<string, unknown>>): string | null {
  return z.object({ username: z.string() }).safeParse(data['currentUser']).data?.username ?? null
}

/** A following page of head pipeline jobs as {@link JOBS_QUERY} reads it. */
export const jobsPageSchema = z.object({
  project: z.object({
    mergeRequest: z.object({
      diffRefs: z.object({ headSha: z.string() }).nullable(),
      headPipeline: z.object({ jobs: jobPageSchema.nullable() }).nullable(),
    }).nullable(),
  }).nullable(),
})

/** One merge request as GitLab returned it. */
export type MergeRequestNode = z.infer<typeof mergeRequestSchema>

/** One job as GitLab returned it. */
export type JobNode = z.infer<typeof jobSchema>

/** Merge statuses during which GitLab has not decided whether the merge request can merge. */
const UNDECIDED = new Set(['UNCHECKED', 'CHECKING', 'PREPARING', 'APPROVALS_SYNCING'])

/**
 * Conflict states GitLab has not checked since the merge request or its target changed. GitLab checks them again only
 * when a REST read of the merge request asks it to, and meanwhile reports its last outcome, such as `CONFLICT`.
 */
const UNCHECKED = new Set(['UNCHECKED', 'CANNOT_BE_MERGED_RECHECK'])

/**
 * Whether GitLab has not checked the merge request for conflicts since it or its target changed.
 * @param node - the merge request.
 * @returns whether a REST read of the merge request should ask GitLab to check it.
 */
export function needsMergeCheck(node: MergeRequestNode): boolean {
  return node.mergeStatusEnum !== null && UNCHECKED.has(node.mergeStatusEnum)
}

/** Review states of a reviewer whose review is still awaited. */
export const AWAITED_REVIEW_STATES: ReadonlySet<string> = new Set(['UNREVIEWED', 'REVIEW_STARTED'])

/** The outcome each review state of a reviewer who gave a review stands for. */
const REVIEW_VERDICTS: Readonly<Record<string, ReviewVerdict>> = {
  REVIEWED: 'commented',
  REQUESTED_CHANGES: 'changes-requested',
  APPROVED: 'approved',
  UNAPPROVED: 'dismissed',
}

/** Review states of a reviewer who gave a review; with the awaited ones, every state GitLab 19.5 defines. */
export const GIVEN_REVIEW_STATES: ReadonlySet<string> = new Set(Object.keys(REVIEW_VERDICTS))

/** One reviewer's review state as GitLab returns it with a merge request. */
export interface ReviewerInteraction {
  /** The reviewer's interaction with the merge request, or null when GitLab reports none. */
  readonly mergeRequestInteraction: { readonly reviewState: string | null } | null
}

/** The approval and reviewers of a merge request, which decide its aggregate review outcome with its merge status. */
export interface ReviewedMergeRequest {
  /** Whether GitLab reports the merge request approved. */
  readonly approved: boolean
  /** The reviewers GitLab listed. */
  readonly reviewers: { readonly nodes: readonly ReviewerInteraction[] }
}

/** A merge request whose status is known, and the parts of it read elsewhere. */
export interface StatusParts {
  /** The merge request. */
  readonly ref: ChangeRequestRef
  /** Whether the project merges by fast-forward only. */
  readonly fastForwardOnly: boolean
  /** Username of the signed-in user, or null when GitLab named none. */
  readonly viewer: string | null
  /** The merge request node. */
  readonly node: MergeRequestNode
  /** Every job read for the head pipeline, in GitLab's order. */
  readonly jobs: readonly JobNode[]
  /** Whether GitLab listed more jobs than `jobs` holds. */
  readonly jobsTruncated: boolean
  /** Issues the merge request closes, in GitLab's order. */
  readonly closingIssues: readonly ChangeRequestIssue[]
  /** Whether GitLab listed more closing issues than `closingIssues` holds. */
  readonly closingIssuesTruncated: boolean
}

/**
 * Map a merge request to a forge snapshot. GitLab's open, closed, merged, and locked states map to open, closed, merged,
 * and open; the merge status decides mergeability: a status GitLab has not decided or not checked since a change is
 * unknown, whatever `conflicts` and `CONFLICT` say, and `CONFLICT` is conflicting even while `conflicts` is false. Every
 * job of the head pipeline names the pipeline as its rerun, since GitLab retries a pipeline's failed and cancelled jobs
 * together. GitLab updates a head branch only by rebasing it onto the target branch, which a user who can push to the
 * head branch may start while the branches have diverged without conflicts and no rebase runs.
 * @param parts - the merge request and the parts read with it.
 * @returns the snapshot, or a failure when GitLab reports no head commit.
 */
export function snapshotOf(parts: StatusParts): ChangeRequestSnapshot | ForgeFailure {
  const { ref, node } = parts
  if (node.diffRefs === null) return { code: 'unavailable', message: `merge request ${ref.number} has no diff yet` }
  const state = node.state === 'merged' ? 'merged' : node.state === 'closed' ? 'closed' : 'open'
  const status = node.detailedMergeStatus ?? 'UNCHECKED'
  const undecided = UNDECIDED.has(status) || needsMergeCheck(node) || node.mergeStatusEnum === 'CHECKING'
  const mergeability = undecided ? 'unknown' : node.conflicts || status === 'CONFLICT' ? 'conflicting' : 'mergeable'
  const host = ref.repository.host
  const open = state === 'open'
  const rerun = (node.headPipeline?.id ?? null) as ForgeCheckId | null
  const rebase = open && node.divergedFromTargetBranch && !node.rebaseInProgress && mergeability !== 'conflicting'
    && node.userPermissions.pushToSourceBranch
  return {
    ref,
    url: node.webUrl,
    title: node.title,
    state,
    draft: node.draft,
    author: node.author?.username ?? null,
    headBranch: node.sourceBranch,
    headSha: node.diffRefs.headSha,
    baseBranch: node.targetBranch,
    ...node.diffRefs.baseSha === null ? {} : { baseSha: node.diffRefs.baseSha },
    additions: node.diffStatsSummary?.additions ?? 0,
    deletions: node.diffStatsSummary?.deletions ?? 0,
    mergeability,
    mergeReady: open && !node.draft && status === 'MERGEABLE' && mergeability === 'mergeable' && node.userPermissions.canMerge,
    mergeMethods: mergeMethods(parts.fastForwardOnly, node),
    autoMerge: autoMergeOf(parts, open),
    branchUpdates: rebase ? ['rebase'] : [],
    reviewDecision: reviewDecision(node, status),
    reviewers: reviewers(node, host),
    reviewersTruncated: node.reviewers.pageInfo.hasNextPage || (node.approvedBy?.pageInfo.hasNextPage ?? false),
    canRequestReviews: open && node.userPermissions.updateMergeRequest,
    checks: parts.jobs.map(job => checkOf(host, job, rerun)),
    checksRollup: rollup(node.headPipeline?.status ?? null),
    checksTruncated: parts.jobsTruncated,
    canRerunChecks: open && (node.headPipeline?.userPermissions.updatePipeline ?? false),
    unresolvedThreads: Math.max(0, (node.resolvableDiscussionsCount ?? 0) - (node.resolvedDiscussionsCount ?? 0)),
    threadsTruncated: false,
    closingIssues: parts.closingIssues,
    closingIssuesTruncated: parts.closingIssuesTruncated,
    updatedAt: node.updatedAt,
    closedAt: state === 'merged' ? node.mergedAt ?? node.closedAt : state === 'closed' ? node.closedAt : null,
  }
}

/**
 * The methods a merge may use: the project's fast-forward setting decides between a merge commit and a rebase, and the
 * merge request's squash setting adds or forces squashing, with GitLab's default for the merge request first.
 */
function mergeMethods(fastForwardOnly: boolean, node: MergeRequestNode): MergeMethod[] {
  const base: MergeMethod = fastForwardOnly ? 'rebase' : 'merge'
  if (node.squashReadOnly) return [node.squashOnMerge ? 'squash' : base]
  return node.squash ? ['squash', base] : [base, 'squash']
}

/**
 * How a merge request stands with GitLab's automatic merge, which counts as on only while the merge request is open.
 * Its method is the one a merge uses then: squashing when GitLab reports that the merge squashes, else the project's
 * merge commit or fast-forward. It can be turned on while the merge request is open and not a draft, the signed-in user
 * may merge it, and GitLab lists the strategy that waits for every merge check as available; GitLab lists none for a
 * merge request that can merge now, and a merge train strategy does not count. Every user who may merge it can turn it
 * off, and so can its author.
 */
function autoMergeOf(parts: StatusParts, open: boolean): ChangeRequestAutoMerge {
  const { node } = parts
  const enabled = open && node.autoMergeEnabled
  const mayMerge = node.userPermissions.canMerge
  const authored = node.author?.username === parts.viewer
  return {
    enabled,
    method: !enabled ? null : node.squashOnMerge ? 'squash' : parts.fastForwardOnly ? 'rebase' : 'merge',
    enabledBy: enabled ? node.mergeUser?.username ?? null : null,
    canEnable: open && !node.draft && !node.autoMergeEnabled && mayMerge
      && (node.availableAutoMergeStrategies ?? []).includes(CHECKS_PASS_STRATEGY),
    canDisable: enabled && (mayMerge || authored),
  }
}

/**
 * Decide a merge request's aggregate review outcome: a reviewer who requested changes decides first, then an approval,
 * then GitLab's demand for one.
 * @param node - the merge request's approval and reviewers.
 * @param status - the merge request's `detailedMergeStatus`, or null for a read that does not select it, which then
 * reports a demanded approval as `none`.
 * @returns the review decision.
 */
export function reviewDecision(node: ReviewedMergeRequest, status: string | null): ReviewDecision {
  if (node.reviewers.nodes.some(reviewer => reviewer.mergeRequestInteraction?.reviewState === 'REQUESTED_CHANGES')) return 'changes-requested'
  if (node.approved) return 'approved'
  if (status === 'NOT_APPROVED') return 'review-required'
  return 'none'
}

/** Reviewers in GitLab's order, then approvers who are not reviewers; the author is never listed. */
function reviewers(node: MergeRequestNode, host: string): ChangeRequestReviewer[] {
  const author = node.author?.username.toLowerCase()
  const listed: ChangeRequestReviewer[] = []
  const seen = new Set<string>()
  const add = (login: string, entry: ChangeRequestReviewer): void => {
    if (login.toLowerCase() === author || seen.has(login.toLowerCase())) return
    seen.add(login.toLowerCase())
    listed.push(entry)
  }
  for (const reviewer of node.reviewers.nodes) {
    add(reviewer.username, {
      kind: reviewer.bot ? 'bot' : 'user', login: reviewer.username, avatarUrl: avatarUrlOf(host, reviewer.avatarUrl), codeOwner: false,
      ...reviewOf(reviewer), reviewedSha: null,
    })
  }
  for (const approver of node.approvedBy?.nodes ?? []) {
    add(approver.username, {
      kind: approver.bot ? 'bot' : 'user', login: approver.username, avatarUrl: avatarUrlOf(host, approver.avatarUrl), requested: false,
      codeOwner: false, verdict: 'approved', reviewedSha: null,
    })
  }
  return listed
}

/**
 * Read one reviewer's review state; a reviewer GitLab reports no state for has not reviewed.
 * @param reviewer - the reviewer as GitLab returned it.
 * @returns whether the reviewer's review is still awaited, and the outcome of their latest review.
 */
export function reviewOf(reviewer: ReviewerInteraction): Pick<ChangeRequestReviewer, 'requested' | 'verdict'> {
  const state = reviewer.mergeRequestInteraction?.reviewState ?? 'UNREVIEWED'
  return { requested: AWAITED_REVIEW_STATES.has(state), verdict: verdictOf(state) }
}

/** A reviewer state as the outcome of their latest review; states outside the documented set read as none. */
function verdictOf(state: string): ReviewVerdict | null {
  return REVIEW_VERDICTS[state] ?? null
}

/**
 * Map one job to a check. A failed job allowed to fail is neutral, as GitLab shows it passing with a warning; a manual
 * job allowed to fail is skipped, and one that blocks the pipeline is pending until someone runs it.
 * @param host - GitLab host, for the job's page.
 * @param job - the job.
 * @param rerun - global id of the job's pipeline, which a rerun retries.
 * @returns the check.
 */
export function checkOf(host: string, job: JobNode, rerun: ForgeCheckId | null): ChangeRequestCheck {
  return {
    name: job.name,
    state: jobState(job),
    url: job.webPath === null ? null : `https://${host}${job.webPath}`,
    workflow: job.stage?.name ?? null,
    startedAt: job.startedAt,
    completedAt: job.finishedAt,
    rerun,
  }
}

/** A job status as a check state; statuses outside the documented set read as pending. */
function jobState(job: JobNode): CheckState {
  switch (job.status) {
    case 'SUCCESS': return 'success'
    case 'FAILED': return job.allowFailure ? 'neutral' : 'failure'
    case 'CANCELED':
    case 'CANCELING': return 'cancelled'
    case 'SKIPPED': return 'skipped'
    case 'MANUAL': return job.allowFailure ? 'skipped' : 'pending'
    default: return 'pending'
  }
}

/**
 * Map a pipeline status to the combined check outcome; statuses outside the documented set read as pending.
 * @param status - status of the head pipeline, or null for a merge request without a pipeline.
 * @returns the combined outcome, `none` without a pipeline.
 */
export function rollup(status: string | null): ChecksRollup {
  switch (status) {
    case null: return 'none'
    case 'SUCCESS':
    case 'SKIPPED': return 'success'
    case 'FAILED':
    case 'CANCELED': return 'failure'
    default: return 'pending'
  }
}

/** One closing issue as REST `closes_issues` lists it. */
const issueSchema = z.object({ iid: z.number(), title: z.string(), state: z.string(), web_url: z.string() })

/**
 * Map the REST list of issues a merge request closes, keeping the ones whose page names a project.
 * @param body - the parsed `closes_issues` answer.
 * @param limit - the most issues to keep.
 * @returns the issues and whether more were listed, or undefined when the answer is not such a list.
 */
export function closingIssuesOf(
  body: unknown, limit: number,
): { readonly issues: ChangeRequestIssue[]; readonly truncated: boolean } | undefined {
  const parsed = z.array(issueSchema).safeParse(body)
  if (!parsed.success) return undefined
  const issues = parsed.data.flatMap((issue): ChangeRequestIssue[] => {
    const location = parseIssueUrl(issue.web_url)
    return location === undefined ? [] : [{
      repository: { forge: 'gitlab', host: location.host, owner: location.owner, name: location.name },
      number: issue.iid, title: issue.title, state: issue.state === 'closed' ? 'closed' : 'open', url: issue.web_url,
    }]
  })
  return { issues: issues.slice(0, limit), truncated: issues.length > limit }
}
