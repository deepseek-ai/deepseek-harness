import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ChangeRequestSnapshot } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import { mapHeadResponse, mapSnapshotResponse, snapshotQuery } from '../src/graphql.ts'
import { checkRun, demo, pull, pullRequestNode, repositorySettings, statusContext } from './fixtures.ts'

const other = { ...demo, name: 'other' }

/** Map one pull request node of a repository with `settings`, or without readable merge settings when it is null. */
function single(node: unknown, settings: Record<string, unknown> | null = repositorySettings()): ChangeRequestSnapshot {
  const query = snapshotQuery([pull(1)])
  const result = mapSnapshotResponse({ data: { r0: { ...settings, p0: node } } }, query).get(changeRequestKey(pull(1)))
  if (result === undefined || 'code' in result) throw new Error(`expected a snapshot, received ${JSON.stringify(result)}`)
  return result
}

describe('snapshot query', () => {
  it('groups change requests by repository and aliases each one', () => {
    const upper = { ...demo, owner: 'Octo', name: 'Demo' }
    const query = snapshotQuery([pull(1), pull(2, upper), pull(1, upper), pull(7, other)])

    expect([...query.targets]).toEqual([['r0.p0', pull(1)], ['r0.p1', pull(2, upper)], ['r1.p0', pull(7, other)]])
    const settings = 'squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerPermission viewerDefaultMergeMethod'
    expect(query.document).toContain(`r0: repository(owner: "octo", name: "demo") { ${settings} p0: pullRequest(number: 1) { ...ChangeRequestFields } p1: pullRequest(number: 2) { ...ChangeRequestFields } }`)
    expect(query.document).toContain(`r1: repository(owner: "octo", name: "other") { ${settings} p0: pullRequest(number: 7) { ...ChangeRequestFields } }`)
    expect(query.document).toContain('fragment ChangeRequestFields on PullRequest {')
  })

  it('refuses owners, names, and numbers that cannot be inlined', () => {
    expect(() => snapshotQuery([pull(1, { ...demo, owner: 'oc"to' })])).toThrow('forge-github: invalid repository "oc\\"to/demo"')
    expect(() => snapshotQuery([pull(1.5)])).toThrow('forge-github: invalid pull request number 1.5')
    expect(() => snapshotQuery([pull(0)])).toThrow('forge-github: invalid pull request number 0')
  })
})

describe('snapshot mapping', () => {
  it('maps the pull request fields into a provider-neutral snapshot', () => {
    expect(single(pullRequestNode(1, {}, [checkRun('lint', 'COMPLETED', 'SUCCESS')]))).toEqual({
      ref: pull(1),
      url: 'https://github.com/octo/demo/pull/1',
      title: 'Change 1',
      state: 'open',
      draft: false,
      author: 'octo',
      headBranch: 'topic-1',
      headSha: 'f'.repeat(40),
      baseBranch: 'master',
      additions: 128,
      deletions: 14,
      mergeability: 'mergeable',
      mergeReady: true,
      mergeMethods: ['merge', 'squash'],
      reviewDecision: 'none',
      checks: [{
        name: 'lint',
        state: 'success',
        url: 'https://github.com/octo/demo/actions/runs/1/job/lint',
        workflow: 'ci',
        startedAt: '2026-10-09T01:00:00Z',
        completedAt: '2026-10-09T01:02:07Z',
      }],
      checksRollup: 'success',
      checksTruncated: false,
      unresolvedThreads: 2,
      updatedAt: '2026-10-09T01:02:03Z',
      closedAt: null,
    })
  })

  it('keeps the merge or close time of a finished pull request', () => {
    expect(single(pullRequestNode(1, { state: 'MERGED', closedAt: '2026-10-09T02:00:00Z' })).closedAt).toBe('2026-10-09T02:00:00Z')
  })

  it('keeps the start time of a running check and no times for a queued one', () => {
    const snapshot = single(pullRequestNode(1, {}, [checkRun('build', 'IN_PROGRESS', null), checkRun('test', 'QUEUED', null)]))
    expect(snapshot.checks.map(check => [check.startedAt, check.completedAt])).toEqual([['2026-10-09T01:00:00Z', null], [null, null]])
  })

  it.each([
    ['OPEN', 'open'],
    ['CLOSED', 'closed'],
    ['MERGED', 'merged'],
  ])('maps state %s to %s', (state, expected) => {
    expect(single(pullRequestNode(1, { state })).state).toBe(expected)
  })

  it.each([
    ['MERGEABLE', 'mergeable'],
    ['CONFLICTING', 'conflicting'],
    ['UNKNOWN', 'unknown'],
  ])('maps mergeable %s to %s', (mergeable, expected) => {
    expect(single(pullRequestNode(1, { mergeable })).mergeability).toBe(expected)
  })

  it.each([
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'changes-requested'],
    ['REVIEW_REQUIRED', 'review-required'],
    [null, 'none'],
  ])('maps review decision %s to %s', (reviewDecision, expected) => {
    expect(single(pullRequestNode(1, { reviewDecision })).reviewDecision).toBe(expected)
  })

  it.each([
    ['COMPLETED', 'SUCCESS', 'success'],
    ['COMPLETED', 'FAILURE', 'failure'],
    ['COMPLETED', 'TIMED_OUT', 'failure'],
    ['COMPLETED', 'STARTUP_FAILURE', 'failure'],
    ['COMPLETED', 'ACTION_REQUIRED', 'failure'],
    ['COMPLETED', 'CANCELLED', 'cancelled'],
    ['COMPLETED', 'SKIPPED', 'skipped'],
    ['COMPLETED', 'NEUTRAL', 'neutral'],
    ['COMPLETED', 'STALE', 'neutral'],
    ['COMPLETED', null, 'neutral'],
    ['IN_PROGRESS', null, 'pending'],
    ['QUEUED', null, 'pending'],
  ])('maps check run %s/%s to %s', (status, conclusion, expected) => {
    expect(single(pullRequestNode(1, {}, [checkRun('build', status, conclusion)])).checks[0]?.state).toBe(expected)
  })

  it.each([
    ['SUCCESS', 'success'],
    ['FAILURE', 'failure'],
    ['ERROR', 'failure'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
  ])('maps status context %s to %s', (state, expected) => {
    expect(single(pullRequestNode(1, {}, [statusContext('deploy', state)])).checks).toEqual([{
      name: 'deploy', state: expected, url: null, workflow: null, startedAt: null, completedAt: null,
    }])
  })

  it.each([
    ['SUCCESS', 'success'],
    ['FAILURE', 'failure'],
    ['ERROR', 'failure'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
    [null, 'none'],
  ])('maps rollup %s to %s', (state, expected) => {
    expect(single(pullRequestNode(1, {}, [], state)).checksRollup).toBe(expected)
  })

  it('reads workflows only when GitHub reports one and skips unknown contexts', () => {
    const snapshot = single(pullRequestNode(1, {}, [
      checkRun('a', 'COMPLETED', 'SUCCESS', null),
      { ...checkRun('b', 'COMPLETED', 'SUCCESS'), checkSuite: null },
      { __typename: 'FutureContext', name: 'c' },
    ]))

    expect(snapshot.checks.map(check => [check.name, check.workflow])).toEqual([['a', null], ['b', null]])
  })

  it.each([
    ['clean', {}, {}, true],
    ['mergeable with hooks', { mergeStateStatus: 'HAS_HOOKS' }, {}, true],
    ['mergeable with failing checks that are not required', { mergeStateStatus: 'UNSTABLE' }, {}, true],
    ['blocked by a rule', { mergeStateStatus: 'BLOCKED' }, {}, false],
    ['behind its base', { mergeStateStatus: 'BEHIND' }, {}, false],
    ['conflicting', { mergeStateStatus: 'DIRTY' }, {}, false],
    ['still computing', { mergeStateStatus: 'UNKNOWN' }, {}, false],
    ['a draft', { isDraft: true }, {}, false],
    ['merged', { state: 'MERGED' }, {}, false],
    ['closed', { state: 'CLOSED' }, {}, false],
    ['for a maintainer', {}, { viewerPermission: 'MAINTAIN' }, true],
    ['for an administrator', {}, { viewerPermission: 'ADMIN' }, true],
    ['for a triager', {}, { viewerPermission: 'TRIAGE' }, false],
    ['for a reader', {}, { viewerPermission: 'READ' }, false],
    ['for a viewer without a permission', {}, { viewerPermission: null }, false],
  ])('offers a merge of a pull request %s only when GitHub would merge it now', (_label, node, settings, ready) => {
    expect(single(pullRequestNode(1, node), repositorySettings(settings)).mergeReady).toBe(ready)
  })

  it.each([
    ['puts the viewer\'s usual method first', { rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'REBASE' }, ['rebase', 'squash', 'merge']],
    ['keeps the menu order when the usual method is squash', { rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH' }, ['squash', 'merge', 'rebase']],
    ['skips a usual method the repository disallows', { mergeCommitAllowed: false, rebaseMergeAllowed: true }, ['squash', 'rebase']],
    ['lists nothing when the repository allows no method', { squashMergeAllowed: false, mergeCommitAllowed: false }, []],
  ])('lists the merge methods the repository allows: %s', (_label, settings, methods) => {
    expect(single(pullRequestNode(1), repositorySettings(settings)).mergeMethods).toEqual(methods)
  })

  it('offers no merge in a repository whose merge settings are unreadable', () => {
    expect(single(pullRequestNode(1), null)).toMatchObject({ mergeReady: false, mergeMethods: [] })
    expect(single(pullRequestNode(1), { squashMergeAllowed: 'yes' })).toMatchObject({ mergeReady: false, mergeMethods: [] })
  })

  it('marks truncated checks, a hidden author, drafts, and a commit without rollup', () => {
    const truncated = pullRequestNode(1, {
      isDraft: true,
      author: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { pageInfo: { hasNextPage: true }, nodes: [] } } } }] },
    })

    expect(single(truncated)).toMatchObject({ draft: true, author: null, checksTruncated: true })
    expect(single(pullRequestNode(1, { commits: { nodes: [] } }))).toMatchObject({ checks: [], checksRollup: 'none', checksTruncated: false })
  })

  it('maps path-scoped and global errors from the partial-error response', () => {
    const query = snapshotQuery([pull(1), pull(2), pull(7, other)])
    const body = {
      data: { r0: { p0: pullRequestNode(1), p1: null }, r1: null },
      errors: [
        { type: 'NOT_FOUND', path: ['r0', 'p1'], locations: [{ line: 1, column: 72 }], message: 'Could not resolve to a PullRequest with the number of 2.' },
        { type: 'FORBIDDEN', path: ['r1'], message: 'Resource not accessible by integration' },
      ],
    }

    const results = mapSnapshotResponse(body, query)

    expect(results.get(changeRequestKey(pull(1)))).toMatchObject({ state: 'open' })
    expect(results.get(changeRequestKey(pull(2)))).toEqual({ code: 'not-found', message: 'Could not resolve to a PullRequest with the number of 2.' })
    expect(results.get(changeRequestKey(pull(7, other)))).toEqual({ code: 'unavailable', message: 'Resource not accessible by integration' })
  })

  it('applies an error without a path to every unresolved change request', () => {
    const query = snapshotQuery([pull(1), pull(2)])
    const results = mapSnapshotResponse({ data: null, errors: [{ message: 'API rate limit exceeded' }] }, query)

    expect([...results.values()]).toEqual([
      { code: 'unavailable', message: 'API rate limit exceeded' },
      { code: 'unavailable', message: 'API rate limit exceeded' },
    ])
  })

  it('reports missing nodes, malformed nodes, and malformed bodies', () => {
    const query = snapshotQuery([pull(1), pull(2)])

    expect([...mapSnapshotResponse({ data: { r0: { p0: null, p1: { title: 7 } } } }, query).values()]).toEqual([
      { code: 'not-found', message: 'pull request not found' },
      { code: 'unavailable', message: 'unexpected pull request fields' },
    ])
    expect([...mapSnapshotResponse({}, query).values()]).toEqual([
      { code: 'unavailable', message: 'unexpected GitHub response' },
      { code: 'unavailable', message: 'unexpected GitHub response' },
    ])
    expect([...mapSnapshotResponse('not json', query).values()]).toEqual([
      { code: 'unavailable', message: 'unexpected GitHub response' },
      { code: 'unavailable', message: 'unexpected GitHub response' },
    ])
  })
})

describe('head branch lookup mapping', () => {
  const body = (defaultBranch: string | null, nodes: { number: number; isCrossRepository: boolean }[]) => ({
    data: { repository: { defaultBranchRef: defaultBranch === null ? null : { name: defaultBranch }, pullRequests: { nodes } } },
  })

  it('returns same-repository pull requests for the branch', () => {
    expect(mapHeadResponse(body('master', [{ number: 9, isCrossRepository: false }, { number: 8, isCrossRepository: true }]), demo, 'topic')).toEqual([pull(9)])
    expect(mapHeadResponse(body(null, [{ number: 9, isCrossRepository: false }]), demo, 'topic')).toEqual([pull(9)])
  })

  it('returns nothing for the default branch', () => {
    expect(mapHeadResponse(body('master', [{ number: 9, isCrossRepository: false }]), demo, 'master')).toEqual([])
  })

  it('throws for an invisible repository or a malformed response', () => {
    expect(() => mapHeadResponse({ data: { repository: null } }, demo, 'topic')).toThrow('forge-github: repository octo/demo is not visible')
    expect(() => mapHeadResponse({ data: {} }, demo, 'topic')).toThrow('forge-github: unexpected GitHub response to the head branch lookup')
  })
})
