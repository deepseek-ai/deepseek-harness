import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ChangeRequestSnapshot } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import { mapCheckPageResponse, mapHeadResponse, mapSnapshotResponse, snapshotQuery, type CheckPageResult } from '../src/graphql.ts'
import { checkRun, demo, pull, pullRequestNode, repositorySettings, statusContext } from './fixtures.ts'

const noMoreChecks = async (): Promise<CheckPageResult> => { throw new Error('Unexpected check page') }

const other = { ...demo, name: 'other' }

/** Map one pull request node of a repository with `settings`, or without readable merge settings when it is null. */
async function single(node: unknown, settings: Record<string, unknown> | null = repositorySettings()): Promise<ChangeRequestSnapshot> {
  const query = snapshotQuery([pull(1)])
  const results = await mapSnapshotResponse({ data: { r0: { ...settings, p0: node } } }, query, noMoreChecks)
  const result = results.get(changeRequestKey(pull(1)))
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
  it('maps the pull request fields into a provider-neutral snapshot', async () => {
    expect((await single(pullRequestNode(1, {}, [checkRun('lint', 'COMPLETED', 'SUCCESS')])))).toEqual({
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

  it('keeps the merge or close time of a finished pull request', async () => {
    expect((await single(pullRequestNode(1, { state: 'MERGED', closedAt: '2026-10-09T02:00:00Z' }))).closedAt).toBe('2026-10-09T02:00:00Z')
  })

  it('keeps the start time of a running check and no times for a queued one', async () => {
    const snapshot = (await single(pullRequestNode(1, {}, [checkRun('build', 'IN_PROGRESS', null), checkRun('test', 'QUEUED', null)])))
    expect(snapshot.checks.map(check => [check.startedAt, check.completedAt])).toEqual([['2026-10-09T01:00:00Z', null], [null, null]])
  })

  it('keeps the newest run even when it is queued, and separates workflows, events, apps, and status contexts', async () => {
    const old = checkRun('build', 'COMPLETED', 'FAILURE')
    const newer = { ...checkRun('build', 'QUEUED', null), databaseId: 9 }
    const suite = (app: string, workflow: string, event: string) => ({ app: { id: app },
      workflowRun: { event, workflow: { id: workflow, name: 'CI' } } })
    const result = await single(pullRequestNode(1, {}, [
      old, newer, { ...old, databaseId: 2 },
      { ...old, checkSuite: suite('github-actions', 'ci', 'push') },
      { ...old, checkSuite: suite('github-actions', 'other-workflow', 'pull_request') },
      { ...old, checkSuite: suite('other-app', 'ci', 'pull_request') },
      statusContext('build', 'FAILURE'),
      { ...statusContext('build', 'SUCCESS'), createdAt: '2026-10-10T00:00:00Z' },
    ]))
    expect(result.checks.map(check => check.state)).toEqual(['pending', 'failure', 'failure', 'failure', 'success'])
  })

  it('uses the run id to choose the newer run when start times are equal', async () => {
    const result = await single(pullRequestNode(1, {}, [
      checkRun('test', 'COMPLETED', 'FAILURE'),
      { ...checkRun('test', 'COMPLETED', 'SUCCESS'), databaseId: 2 },
    ]))
    expect(result.checks.map(check => check.state)).toEqual(['success'])
  })

  it.each([
    ['QUEUED', null, 'pending'], ['COMPLETED', 'SUCCESS', 'success'], ['COMPLETED', 'CANCELLED', 'failure'],
    ['COMPLETED', 'ACTION_REQUIRED', 'failure'],
  ] as const)('summarizes the latest %s/%s run instead of a superseded failure', async (status, conclusion, expected) => {
    const result = await single(pullRequestNode(1, {}, [
      checkRun('build', 'COMPLETED', 'FAILURE'), { ...checkRun('build', status, conclusion), databaseId: 2 },
    ], 'FAILURE'))
    expect(result.checks).toHaveLength(1)
    expect(result.checksRollup).toBe(expected)
  })

  it.each(['STALE', null, 'FUTURE_CONCLUSION'])('does not report completed %s as passing', async (conclusion) => {
    const result = await single(pullRequestNode(1, {}, [checkRun('build', 'COMPLETED', conclusion)], 'SUCCESS'))
    expect(result.checksRollup).toBe('pending')
  })

  it('retains unranked runs by node id without guessing their age from missing times', async () => {
    const queued = { ...checkRun('build', 'QUEUED', null), id: 'queued', databaseId: null }
    const failed = { ...checkRun('build', 'COMPLETED', 'FAILURE'), id: 'failed', databaseId: null }
    const passed = { ...checkRun('build', 'COMPLETED', 'SUCCESS'), databaseId: 9 }
    const result = await single(pullRequestNode(1, {}, [queued, failed, queued, passed]))
    expect(result.checks.map(check => check.state)).toEqual(['pending', 'failure', 'success'])
    expect(result.checksRollup).toBe('failure')
    expect(result.checksTruncated).toBe(false)
    expect((await single(pullRequestNode(1, {}, [queued, passed]))).checksRollup).toBe('pending')
    expect((await single(pullRequestNode(1, {}, [failed]))).checksRollup).toBe('failure')
  })

  it.each([-1, '1'])('reports malformed known check id %s instead of publishing a smaller count', async (databaseId) => {
    await expect(single(pullRequestNode(1, {}, [{ ...checkRun('build', 'COMPLETED', 'SUCCESS'), databaseId }])))
      .rejects.toThrow('unexpected GitHub check fields')
  })

  it.each(['FAILURE', 'PENDING'] as const)('preserves the raw %s rollup when an unknown context cannot be summarized', async (state) => {
    const result = await single(pullRequestNode(1, {}, [
      checkRun('build', 'COMPLETED', 'SUCCESS'), { __typename: 'FutureContext' },
    ], state))
    expect(result.checksRollup).toBe(state === 'FAILURE' ? 'failure' : 'pending')
    expect(result.checksTruncated).toBe(false)
  })

  it.each([
    ['OPEN', 'open'],
    ['CLOSED', 'closed'],
    ['MERGED', 'merged'],
  ])('maps state %s to %s', async (state, expected) => {
    expect((await single(pullRequestNode(1, { state }))).state).toBe(expected)
  })

  it.each([
    ['MERGEABLE', 'mergeable'],
    ['CONFLICTING', 'conflicting'],
    ['UNKNOWN', 'unknown'],
  ])('maps mergeable %s to %s', async (mergeable, expected) => {
    expect((await single(pullRequestNode(1, { mergeable }))).mergeability).toBe(expected)
  })

  it.each([
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'changes-requested'],
    ['REVIEW_REQUIRED', 'review-required'],
    [null, 'none'],
  ])('maps review decision %s to %s', async (reviewDecision, expected) => {
    expect((await single(pullRequestNode(1, { reviewDecision }))).reviewDecision).toBe(expected)
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
    ['COMPLETED', 'STALE', 'pending'],
    ['COMPLETED', null, 'pending'],
    ['COMPLETED', 'FUTURE_CONCLUSION', 'pending'],
    ['IN_PROGRESS', null, 'pending'],
    ['QUEUED', null, 'pending'],
  ])('maps check run %s/%s to %s', async (status, conclusion, expected) => {
    expect((await single(pullRequestNode(1, {}, [checkRun('build', status, conclusion)]))).checks[0]?.state).toBe(expected)
  })

  it.each([
    ['SUCCESS', 'success'],
    ['FAILURE', 'failure'],
    ['ERROR', 'failure'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
  ])('maps status context %s to %s', async (state, expected) => {
    expect((await single(pullRequestNode(1, {}, [statusContext('deploy', state)]))).checks).toEqual([{
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
  ])('maps rollup %s to %s', async (state, expected) => {
    expect((await single(pullRequestNode(1, {}, [], state))).checksRollup).toBe(expected)
  })

  it('reads workflows only when GitHub reports one and skips unknown contexts', async () => {
    const snapshot = (await single(pullRequestNode(1, {}, [
      checkRun('a', 'COMPLETED', 'SUCCESS', null),
      { ...checkRun('b', 'COMPLETED', 'SUCCESS'), checkSuite: null },
      { __typename: 'FutureContext', name: 'c' },
    ])))

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
  ])('offers a merge of a pull request %s only when GitHub would merge it now', async (_label, node, settings, ready) => {
    expect((await single(pullRequestNode(1, node), repositorySettings(settings))).mergeReady).toBe(ready)
  })

  it.each([
    ['puts the viewer\'s usual method first', { rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'REBASE' }, ['rebase', 'squash', 'merge']],
    ['keeps the menu order when the usual method is squash', { rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH' }, ['squash', 'merge', 'rebase']],
    ['skips a usual method the repository disallows', { mergeCommitAllowed: false, rebaseMergeAllowed: true }, ['squash', 'rebase']],
    ['lists nothing when the repository allows no method', { squashMergeAllowed: false, mergeCommitAllowed: false }, []],
  ])('lists the merge methods the repository allows: %s', async (_label, settings, methods) => {
    expect((await single(pullRequestNode(1), repositorySettings(settings))).mergeMethods).toEqual(methods)
  })

  it('offers no merge in a repository whose merge settings are unreadable', async () => {
    expect((await single(pullRequestNode(1), null))).toMatchObject({ mergeReady: false, mergeMethods: [] })
    expect((await single(pullRequestNode(1), { squashMergeAllowed: 'yes' }))).toMatchObject({ mergeReady: false, mergeMethods: [] })
  })

  it('keeps a hidden author, drafts, and a commit without rollup', async () => {
    expect(await single(pullRequestNode(1, { isDraft: true, author: null }))).toMatchObject({ draft: true, author: null })
    expect(await single(pullRequestNode(1, { commits: { nodes: [] } }))).toMatchObject({ checks: [], checksRollup: 'none', checksTruncated: false })
  })

  it('maps path-scoped and global errors from the partial-error response', async () => {
    const query = snapshotQuery([pull(1), pull(2), pull(7, other)])
    const body = {
      data: { r0: { p0: pullRequestNode(1), p1: null }, r1: null },
      errors: [
        { type: 'NOT_FOUND', path: ['r0', 'p1'], locations: [{ line: 1, column: 72 }], message: 'Could not resolve to a PullRequest with the number of 2.' },
        { type: 'FORBIDDEN', path: ['r1'], message: 'Resource not accessible by integration' },
      ],
    }

    const results = await mapSnapshotResponse(body, query, noMoreChecks)

    expect(results.get(changeRequestKey(pull(1)))).toMatchObject({ state: 'open' })
    expect(results.get(changeRequestKey(pull(2)))).toEqual({ code: 'not-found', message: 'Could not resolve to a PullRequest with the number of 2.' })
    expect(results.get(changeRequestKey(pull(7, other)))).toEqual({ code: 'unavailable', message: 'Resource not accessible by integration' })
  })

  it('applies an error without a path to every unresolved change request', async () => {
    const query = snapshotQuery([pull(1), pull(2)])
    const results = (await mapSnapshotResponse({ data: null, errors: [{ message: 'API rate limit exceeded' }] }, query, noMoreChecks))

    expect([...results.values()]).toEqual([
      { code: 'unavailable', message: 'API rate limit exceeded' },
      { code: 'unavailable', message: 'API rate limit exceeded' },
    ])
  })

  it('reports a query validation error whose path names a fragment instead of a response alias', async () => {
    const query = snapshotQuery([pull(1)])
    const results = await mapSnapshotResponse({ errors: [{ path: ['fragment ChangeRequestFields', 'invalidField'],
      message: 'Field invalidField does not exist' }] }, query, noMoreChecks)
    expect([...results.values()]).toEqual([{ code: 'unavailable', message: 'Field invalidField does not exist' }])
  })

  it('reports missing nodes, malformed nodes, and malformed bodies', async () => {
    const query = snapshotQuery([pull(1), pull(2)])

    expect([...(await mapSnapshotResponse({ data: { r0: { p0: null, p1: { title: 7 } } } }, query, noMoreChecks)).values()]).toEqual([
      { code: 'not-found', message: 'pull request not found' },
      { code: 'unavailable', message: 'unexpected pull request fields' },
    ])
    expect([...(await mapSnapshotResponse({}, query, noMoreChecks)).values()]).toEqual([
      { code: 'unavailable', message: 'unexpected GitHub response' },
      { code: 'unavailable', message: 'unexpected GitHub response' },
    ])
    expect([...(await mapSnapshotResponse('not json', query, noMoreChecks)).values()]).toEqual([
      { code: 'unavailable', message: 'unexpected GitHub response' },
      { code: 'unavailable', message: 'unexpected GitHub response' },
    ])
  })
})

describe('check page mapping', () => {
  it('validates the next page', () => {
    const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [statusContext('ci', 'SUCCESS')] }
    expect(mapCheckPageResponse({ data: { node: { contexts: page } } })).toEqual({ ok: true, page })
  })

  it.each([
    [{ data: { node: null } }, 'GitHub check page is unavailable'],
    [{ errors: [{ message: 'Rate limited' }] }, 'Rate limited'],
    [{ data: { node: { contexts: {} } } }, 'unexpected GitHub check page'],
  ])('rejects unavailable or malformed pages', (body, message) => {
    expect(mapCheckPageResponse(body)).toEqual({ ok: false, failure: { code: 'unavailable', message } })
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
