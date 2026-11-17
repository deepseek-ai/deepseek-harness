import { describe, expect, it } from 'vitest'
import { closingIssuesOf, JOBS_QUERY, mergeRequestSchema, snapshotOf, statusQuery } from '../src/status.ts'
import type { JobNode, MergeRequestNode, StatusParts } from '../src/status.ts'
import { HOST, merge, sha } from './fixtures.ts'

/** Global id of the head pipeline of {@link mergeRequestNode}. */
export const PIPELINE = 'gid://gitlab/Ci::Pipeline/77'

/** A merge request node as the status query returns it, open and mergeable by default. */
export function mergeRequestNode(overrides: Partial<MergeRequestNode> = {}): MergeRequestNode {
  return mergeRequestSchema.parse({
    iid: '6', title: 'Add it', webUrl: `https://${HOST}/group/sub/app/-/merge_requests/6`, state: 'opened', draft: false,
    updatedAt: '2026-11-10T08:00:00Z', closedAt: null, mergedAt: null, author: { username: 'octo' },
    sourceBranch: 'feat', targetBranch: 'main', diffRefs: { baseSha: sha('b'), headSha: sha('a') },
    diffStatsSummary: { additions: 12, deletions: 3 }, detailedMergeStatus: 'MERGEABLE', mergeStatusEnum: 'CAN_BE_MERGED', conflicts: false,
    divergedFromTargetBranch: false, rebaseInProgress: false, squash: false, squashOnMerge: false, squashReadOnly: false, approved: false,
    resolvableDiscussionsCount: 3, resolvedDiscussionsCount: 1,
    userPermissions: { canMerge: true, pushToSourceBranch: true, updateMergeRequest: true },
    approvedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewers: { pageInfo: { hasNextPage: false }, nodes: [] },
    headPipeline: { id: PIPELINE, status: 'SUCCESS', userPermissions: { updatePipeline: true }, jobs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    ...overrides,
  })
}

/** One job as GitLab returns it. */
export function job(name: string, status: string | null, overrides: Partial<JobNode> = {}): JobNode {
  return {
    name, status, allowFailure: false, stage: { name: 'test' }, webPath: `/group/sub/app/-/jobs/${name}`,
    startedAt: '2026-11-10T08:01:00Z', finishedAt: '2026-11-10T08:02:00Z', ...overrides,
  }
}

function parts(node: MergeRequestNode, overrides: Partial<StatusParts> = {}): StatusParts {
  return {
    ref: merge(6), fastForwardOnly: false, node, jobs: [], jobsTruncated: false, closingIssues: [], closingIssuesTruncated: false,
    ...overrides,
  }
}

describe('GitLab status query', () => {
  it('reads each merge request under its own alias and variables', () => {
    const query = statusQuery(2)
    expect(query).toContain('query($jobs: Int!, $p0: ID!, $i0: String!, $p1: ID!, $i1: String!)')
    expect(query).toContain('m1: project(fullPath: $p1) { mergeRequestsFfOnlyEnabled mergeRequest(iid: $i1) { ...MergeRequestStatus } }')
    expect(query).toContain('fragment MergeRequestStatus on MergeRequest')
    // GitLab lists a job a retry replaced beside its retry unless asked not to.
    expect(query).toContain('jobs(first: $jobs, retried: false)')
    expect(JOBS_QUERY).toContain('retried: false')
    expect(query.indexOf('detailedMergeStatus')).toBeLessThan(query.indexOf('diffStatsSummary'))
  })
})

describe('GitLab snapshots', () => {
  it('maps an open, mergeable merge request', () => {
    expect(snapshotOf(parts(mergeRequestNode(), { jobs: [job('lint', 'SUCCESS')], closingIssuesTruncated: true }))).toEqual({
      ref: merge(6), url: `https://${HOST}/group/sub/app/-/merge_requests/6`, title: 'Add it', state: 'open', draft: false, author: 'octo',
      headBranch: 'feat', headSha: sha('a'), baseBranch: 'main', baseSha: sha('b'), additions: 12, deletions: 3,
      mergeability: 'mergeable', mergeReady: true, mergeMethods: ['merge', 'squash'], branchUpdates: [], reviewDecision: 'none',
      reviewers: [], reviewersTruncated: false, canRequestReviews: true,
      checks: [{
        name: 'lint', state: 'success', url: `https://${HOST}/group/sub/app/-/jobs/lint`, workflow: 'test',
        startedAt: '2026-11-10T08:01:00Z', completedAt: '2026-11-10T08:02:00Z', rerun: PIPELINE,
      }],
      checksRollup: 'success', checksTruncated: false, canRerunChecks: true, unresolvedThreads: 2, threadsTruncated: false,
      closingIssues: [], closingIssuesTruncated: true, updatedAt: '2026-11-10T08:00:00Z', closedAt: null,
    })
  })

  it('maps states, close times, and a merge request without counts, author, or base', () => {
    const merged = snapshotOf(parts(mergeRequestNode({ state: 'merged', mergedAt: 'M', closedAt: 'C', divergedFromTargetBranch: true })))
    expect(merged).toMatchObject({ state: 'merged', closedAt: 'M', mergeReady: false, branchUpdates: [], canRequestReviews: false, canRerunChecks: false })
    expect(snapshotOf(parts(mergeRequestNode({ state: 'merged', mergedAt: null, closedAt: 'C' })))).toMatchObject({ closedAt: 'C' })
    expect(snapshotOf(parts(mergeRequestNode({ state: 'closed', closedAt: 'C' })))).toMatchObject({ state: 'closed', closedAt: 'C' })
    expect(snapshotOf(parts(mergeRequestNode({ state: 'locked' })))).toMatchObject({ state: 'open' })
    const bare = snapshotOf(parts(mergeRequestNode({
      author: null, diffRefs: { baseSha: null, headSha: sha('a') }, diffStatsSummary: null,
      resolvableDiscussionsCount: null, resolvedDiscussionsCount: 2, detailedMergeStatus: null, approvedBy: null, headPipeline: null,
    })))
    expect(bare).toMatchObject({
      author: null, additions: 0, deletions: 0, unresolvedThreads: 0, mergeability: 'unknown', checksRollup: 'none', reviewersTruncated: false,
      canRerunChecks: false,
    })
    expect(bare).not.toHaveProperty('baseSha')
    expect(snapshotOf(parts(mergeRequestNode({ resolvableDiscussionsCount: 4, resolvedDiscussionsCount: null }))))
      .toMatchObject({ unresolvedThreads: 4 })
  })

  it('refuses a merge request without a diff', () => {
    expect(snapshotOf(parts(mergeRequestNode({ diffRefs: null })))).toEqual({ code: 'unavailable', message: 'merge request 6 has no diff yet' })
  })

  it.each([
    [{ conflicts: true }, 'conflicting', false],
    [{ detailedMergeStatus: 'CONFLICT' }, 'conflicting', false],
    [{ detailedMergeStatus: 'CHECKING' }, 'unknown', false],
    [{ detailedMergeStatus: 'UNCHECKED', conflicts: true }, 'unknown', false],
    [{ detailedMergeStatus: 'CONFLICT', mergeStatusEnum: 'CANNOT_BE_MERGED_RECHECK' }, 'unknown', false],
    [{ mergeStatusEnum: 'CHECKING' }, 'unknown', false],
    [{ detailedMergeStatus: 'CONFLICT', mergeStatusEnum: null }, 'conflicting', false],
    [{ detailedMergeStatus: 'NEED_REBASE' }, 'mergeable', false],
    [{ draft: true }, 'mergeable', false],
    [{ userPermissions: { canMerge: false, pushToSourceBranch: true, updateMergeRequest: true } }, 'mergeable', false],
  ])('decides mergeability and readiness from %j', (overrides, mergeability, mergeReady) => {
    expect(snapshotOf(parts(mergeRequestNode(overrides)))).toMatchObject({ mergeability, mergeReady })
  })

  it.each([
    [{ divergedFromTargetBranch: true }, ['rebase']],
    [{ divergedFromTargetBranch: true, rebaseInProgress: true }, []],
    [{ divergedFromTargetBranch: true, conflicts: true }, []],
    [{ divergedFromTargetBranch: true, userPermissions: { canMerge: true, pushToSourceBranch: false, updateMergeRequest: true } }, []],
    [{ divergedFromTargetBranch: false }, []],
  ])('offers a rebase for %j', (overrides, updates) => {
    expect(snapshotOf(parts(mergeRequestNode(overrides)))).toMatchObject({ branchUpdates: updates })
  })

  it('lets the signed-in user request reviews and rerun checks as GitLab permits', () => {
    const denied = mergeRequestNode({
      userPermissions: { canMerge: true, pushToSourceBranch: true, updateMergeRequest: false },
      headPipeline: { id: PIPELINE, status: 'FAILED', userPermissions: { updatePipeline: false }, jobs: null },
    })
    expect(snapshotOf(parts(denied))).toMatchObject({ canRequestReviews: false, canRerunChecks: false })
  })

  it.each([
    [false, {}, ['merge', 'squash']],
    [true, {}, ['rebase', 'squash']],
    [false, { squash: true }, ['squash', 'merge']],
    [false, { squashReadOnly: true, squashOnMerge: true }, ['squash']],
    [true, { squashReadOnly: true, squashOnMerge: false }, ['rebase']],
  ])('offers merge methods for fast-forward %s and %j', (fastForwardOnly, overrides, methods) => {
    expect(snapshotOf(parts(mergeRequestNode(overrides), { fastForwardOnly }))).toMatchObject({ mergeMethods: methods })
  })

  it('lists reviewers then approvers once each, never the author, with their latest outcome', () => {
    const reviewer = (username: string, reviewState: string | null, bot = false) => ({
      username, avatarUrl: null, bot, mergeRequestInteraction: { reviewState },
    })
    const node = mergeRequestNode({
      approved: true,
      reviewers: {
        pageInfo: { hasNextPage: false },
        nodes: [
          reviewer('lin', 'UNREVIEWED'), reviewer('ci-bot', 'REVIEWED', true), reviewer('zhou', 'APPROVED'),
          reviewer('wang', 'UNAPPROVED'), reviewer('li', 'REVIEW_STARTED'), reviewer('chen', 'SOMETHING_NEW'),
          { username: 'OCTO', avatarUrl: null, bot: false, mergeRequestInteraction: null },
        ],
      },
      approvedBy: { pageInfo: { hasNextPage: true }, nodes: [{ username: 'Zhou', avatarUrl: 'a.png', bot: false }, { username: 'sun', avatarUrl: '/uploads/-/system/user/avatar/7/sun.png', bot: false }, { username: 'merge-bot', avatarUrl: null, bot: true }] },
    })
    const snapshot = snapshotOf(parts(node))
    // An uploaded avatar is a path on the host.
    expect('reviewers' in snapshot ? snapshot.reviewers.find(entry => entry.login === 'sun')?.avatarUrl : undefined)
      .toBe(`https://${parts(node).ref.repository.host}/uploads/-/system/user/avatar/7/sun.png`)
    expect(snapshot).toMatchObject({ reviewDecision: 'approved', reviewersTruncated: true })
    expect('reviewers' in snapshot ? snapshot.reviewers.map(entry => [entry.login, entry.kind, entry.requested, entry.verdict]) : []).toEqual([
      ['lin', 'user', true, null], ['ci-bot', 'bot', false, 'commented'], ['zhou', 'user', false, 'approved'],
      ['wang', 'user', false, 'dismissed'], ['li', 'user', true, null], ['chen', 'user', false, null], ['sun', 'user', false, 'approved'],
      ['merge-bot', 'bot', false, 'approved'],
    ])
  })

  it.each([
    [{ reviewers: { pageInfo: { hasNextPage: true }, nodes: [{ username: 'lin', avatarUrl: null, bot: false, mergeRequestInteraction: { reviewState: 'REQUESTED_CHANGES' } }] }, approved: true }, 'changes-requested'],
    [{ detailedMergeStatus: 'NOT_APPROVED' }, 'review-required'],
    [{}, 'none'],
  ])('decides the review outcome from %j', (overrides, decision) => {
    expect(snapshotOf(parts(mergeRequestNode(overrides)))).toMatchObject({ reviewDecision: decision })
  })

  it('maps job states, a job without a page or stage, and pipeline outcomes', () => {
    const jobs = [
      job('ok', 'SUCCESS'), job('broken', 'FAILED'), job('flaky', 'FAILED', { allowFailure: true }), job('stopped', 'CANCELED'),
      job('stopping', 'CANCELING'), job('skipped', 'SKIPPED'), job('gate', 'MANUAL'), job('optional', 'MANUAL', { allowFailure: true }),
      job('queued', 'PENDING', { webPath: null, stage: null, startedAt: null, finishedAt: null }), job('unknown', null),
    ]
    const snapshot = snapshotOf(parts(mergeRequestNode({ headPipeline: { id: PIPELINE, status: 'RUNNING', userPermissions: { updatePipeline: true }, jobs: null } }),
      { jobs, jobsTruncated: true }))
    expect('checks' in snapshot ? snapshot.checks.map(check => check.state) : []).toEqual(
      ['success', 'failure', 'neutral', 'cancelled', 'cancelled', 'skipped', 'pending', 'skipped', 'pending', 'pending'])
    expect(snapshot).toMatchObject({ checksRollup: 'pending', checksTruncated: true })
    expect('checks' in snapshot ? snapshot.checks[8] : undefined).toMatchObject({ url: null, workflow: null, startedAt: null, completedAt: null })
    for (const [status, rollup] of [['SKIPPED', 'success'], ['FAILED', 'failure'], ['CANCELED', 'failure'], ['MANUAL', 'pending']] as const) {
      const headPipeline = { id: PIPELINE, status, userPermissions: { updatePipeline: true }, jobs: null }
      expect(snapshotOf(parts(mergeRequestNode({ headPipeline })))).toMatchObject({ checksRollup: rollup })
    }
  })
})

describe('GitLab closing issues', () => {
  it('maps issues whose page names a project, keeping the first ones', () => {
    const issue = (iid: number, state: string, url: string) => ({ iid, title: `Issue ${iid}`, state, web_url: url })
    expect(closingIssuesOf([
      issue(1, 'opened', `https://${HOST}/group/sub/app/-/issues/1`),
      issue(2, 'closed', `https://${HOST}/group/other/-/work_items/2`),
      issue(3, 'opened', 'https://elsewhere.test/not-an-issue'),
      issue(4, 'opened', `https://${HOST}/group/sub/app/-/issues/4`),
    ], 2)).toEqual({
      issues: [
        { repository: { forge: 'gitlab', host: HOST, owner: 'group/sub', name: 'app' }, number: 1, title: 'Issue 1', state: 'open', url: `https://${HOST}/group/sub/app/-/issues/1` },
        { repository: { forge: 'gitlab', host: HOST, owner: 'group', name: 'other' }, number: 2, title: 'Issue 2', state: 'closed', url: `https://${HOST}/group/other/-/work_items/2` },
      ],
      truncated: true,
    })
    expect(closingIssuesOf([], 25)).toEqual({ issues: [], truncated: false })
    expect(closingIssuesOf({ message: 'nope' }, 25)).toBeUndefined()
  })
})
