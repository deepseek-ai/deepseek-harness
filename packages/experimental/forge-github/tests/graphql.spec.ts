import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ChangeRequestSnapshot, ForgeCheckId } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import {
  actionsRunOf, mapCheckPageResponse, mapHeadResponse, mapPullRequestCommitsResponse, mapSnapshotResponse, mapThreadPageResponse,
  snapshotQuery,
} from '../src/graphql.ts'
import type { SnapshotPages, ThreadPageResult } from '../src/graphql.ts'
import { checkRun, demo, pull, pullRequestNode, repositorySettings, statusContext, threadPage } from './fixtures.ts'

const MAX_THREADS = 1_000

const noMorePages: SnapshotPages = {
  threads: async () => { throw new Error('Unexpected review thread page') },
  checks: async () => { throw new Error('Unexpected check page') },
}

const other = { ...demo, name: 'other' }

/** Map one pull request node of a repository with `settings`, or without readable merge settings when it is null. */
async function single(node: unknown, settings: Record<string, unknown> | null = repositorySettings()): Promise<ChangeRequestSnapshot> {
  const query = snapshotQuery([pull(1)], MAX_THREADS)
  const results = await mapSnapshotResponse({ data: { r0: { ...settings, p0: node } } }, query, noMorePages)
  const result = results.get(changeRequestKey(pull(1)))
  if (result === undefined || 'code' in result) throw new Error(`expected a snapshot, received ${JSON.stringify(result)}`)
  return result
}

describe('snapshot query', () => {
  it('groups change requests by repository and aliases each one', () => {
    const upper = { ...demo, owner: 'Octo', name: 'Demo' }
    const query = snapshotQuery([pull(1), pull(2, upper), pull(1, upper), pull(7, other)], MAX_THREADS)

    expect([...query.targets]).toEqual([['r0.p0', pull(1)], ['r0.p1', pull(2, upper)], ['r1.p0', pull(7, other)]])
    const settings = 'squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerPermission viewerDefaultMergeMethod'
    expect(query.document).toContain(`r0: repository(owner: "octo", name: "demo") { ${settings} p0: pullRequest(number: 1) { ...ChangeRequestFields } p1: pullRequest(number: 2) { ...ChangeRequestFields } }`)
    expect(query.document).toContain(`r1: repository(owner: "octo", name: "other") { ${settings} p0: pullRequest(number: 7) { ...ChangeRequestFields } }`)
    expect(query.document).toContain('fragment ChangeRequestFields on PullRequest {')
  })

  it('refuses owners, names, and numbers that cannot be inlined', () => {
    expect(() => snapshotQuery([pull(1, { ...demo, owner: 'oc"to' })], MAX_THREADS)).toThrow('forge-github: invalid repository "oc\\"to/demo"')
    expect(() => snapshotQuery([pull(1.5)], MAX_THREADS)).toThrow('forge-github: invalid pull request number 1.5')
    expect(() => snapshotQuery([pull(0)], MAX_THREADS)).toThrow('forge-github: invalid pull request number 0')
  })
})

describe('snapshot mapping', () => {
  it.each([['missing', undefined], ['null', null], ['not a full commit', 'HEAD~1']])(
    'keeps the status and leaves out the base commit when GitHub reports it %s', async (_case, baseRefOid) => {
      const snapshot = await single(pullRequestNode(1, { baseRefOid }))
      expect(snapshot).not.toHaveProperty('baseSha')
      expect(snapshot.headSha).toBe('f'.repeat(40))
    })

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
      baseSha: 'b'.repeat(40),
      additions: 128,
      deletions: 14,
      mergeability: 'mergeable',
      mergeReady: true,
      mergeMethods: ['merge', 'squash'],
      branchUpdates: [],
      reviewDecision: 'none',
      reviewers: [],
      reviewersTruncated: false,
      canRequestReviews: true,
      checks: [{
        name: 'lint',
        state: 'success',
        url: 'https://github.com/octo/demo/actions/runs/1/job/lint',
        workflow: 'ci',
        startedAt: '2026-10-09T01:00:00Z',
        completedAt: '2026-10-09T01:02:07Z',
        rerun: 'actions:7',
      }],
      checksRollup: 'success',
      checksTruncated: false,
      canRerunChecks: true,
      unresolvedThreads: 2,
      threadsTruncated: false,
      closingIssues: [],
      closingIssuesTruncated: false,
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
      workflowRun: { databaseId: 7, event, workflow: { id: workflow, name: 'CI' } } })
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
      name: 'deploy', state: expected, url: null, workflow: null, startedAt: null, completedAt: null, rerun: null,
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
    const query = snapshotQuery([pull(1), pull(2), pull(7, other)], MAX_THREADS)
    const body = {
      data: { r0: { p0: pullRequestNode(1), p1: null }, r1: null },
      errors: [
        { type: 'NOT_FOUND', path: ['r0', 'p1'], locations: [{ line: 1, column: 72 }], message: 'Could not resolve to a PullRequest with the number of 2.' },
        { type: 'FORBIDDEN', path: ['r1'], message: 'Resource not accessible by integration' },
      ],
    }

    const results = await mapSnapshotResponse(body, query, noMorePages)

    expect(results.get(changeRequestKey(pull(1)))).toMatchObject({ state: 'open' })
    expect(results.get(changeRequestKey(pull(2)))).toEqual({ code: 'not-found', message: 'Could not resolve to a PullRequest with the number of 2.' })
    expect(results.get(changeRequestKey(pull(7, other)))).toEqual({ code: 'unavailable', message: 'Resource not accessible by integration' })
  })

  it('applies an error without a path to every unresolved change request', async () => {
    const query = snapshotQuery([pull(1), pull(2)], MAX_THREADS)
    const results = (await mapSnapshotResponse({ data: null, errors: [{ message: 'API rate limit exceeded' }] }, query, noMorePages))

    expect([...results.values()]).toEqual([
      { code: 'unavailable', message: 'API rate limit exceeded' },
      { code: 'unavailable', message: 'API rate limit exceeded' },
    ])
  })

  it('reports a query validation error whose path names a fragment instead of a response alias', async () => {
    const query = snapshotQuery([pull(1)], MAX_THREADS)
    const results = await mapSnapshotResponse({ errors: [{ path: ['fragment ChangeRequestFields', 'invalidField'],
      message: 'Field invalidField does not exist' }] }, query, noMorePages)
    expect([...results.values()]).toEqual([{ code: 'unavailable', message: 'Field invalidField does not exist' }])
  })

  it('reports missing nodes, malformed nodes, and malformed bodies', async () => {
    const query = snapshotQuery([pull(1), pull(2)], MAX_THREADS)

    expect([...(await mapSnapshotResponse({ data: { r0: { p0: null, p1: { title: 7 } } } }, query, noMorePages)).values()]).toEqual([
      { code: 'not-found', message: 'pull request not found' },
      { code: 'unavailable', message: 'unexpected pull request fields' },
    ])
    expect([...(await mapSnapshotResponse({}, query, noMorePages)).values()]).toEqual([
      { code: 'unavailable', message: 'unexpected GitHub response' },
      { code: 'unavailable', message: 'unexpected GitHub response' },
    ])
    expect([...(await mapSnapshotResponse('not json', query, noMorePages)).values()]).toEqual([
      { code: 'unavailable', message: 'unexpected GitHub response' },
      { code: 'unavailable', message: 'unexpected GitHub response' },
    ])
  })
})

describe('review thread counting', () => {
  /** Map pull request 1, whose first page holds `first` and whose following pages hold `rest`, counting at most `max` threads. */
  async function counted(max: number, first: readonly boolean[], rest: readonly (readonly boolean[])[]) {
    const reads: [string, string, number][] = []
    const threads: SnapshotPages['threads'] = async (id, cursor, size) => {
      reads.push([id, cursor, size])
      const index = Number(cursor.slice('page-'.length))
      const resolved = rest[index - 1]
      if (resolved === undefined) throw new Error(`Unexpected review thread page ${cursor}`)
      const more = index < rest.length || size < resolved.length
      return { ok: true, page: threadPage(resolved.slice(0, size), more ? `page-${index + 1}` : null) }
    }
    const query = snapshotQuery([pull(1)], max)
    const node = pullRequestNode(1, { reviewThreads: threadPage(first, rest.length > 0 ? 'page-1' : null) })
    const results = await mapSnapshotResponse({ data: { r0: { ...repositorySettings(), p0: node } } }, query, { threads })
    const result = results.get(changeRequestKey(pull(1)))
    return { result, reads, document: query.document }
  }
  const hundred = (unresolved: number): boolean[] => Array.from({ length: 100 }, (_, index) => index >= unresolved)

  it('counts unresolved threads across every page of a pull request with more than 100 threads', async () => {
    const { result, reads } = await counted(MAX_THREADS, hundred(1), [hundred(2), [false, true, false]])

    expect(result).toMatchObject({ unresolvedThreads: 5, threadsTruncated: false })
    expect(reads).toEqual([['pull-1', 'page-1', 100], ['pull-1', 'page-2', 100]])
  })

  it.each([
    ['exactly the bound', 203, 5, false, [100, 3]],
    ['one thread below the total', 202, 4, true, [100, 2]],
    ['a bound inside the second page', 150, 3, true, [50]],
  ] as const)('stops counting at %s and marks the count as a lower bound past it', async (_label, max, unresolved, truncated, sizes) => {
    const { result, reads } = await counted(max, hundred(1), [hundred(2), [false, true, false]])

    expect(result).toMatchObject({ unresolvedThreads: unresolved, threadsTruncated: truncated })
    expect(reads.map(([, , size]) => size)).toEqual(sizes)
  })

  it('reads a first page no larger than a bound below 100', async () => {
    const { result, reads, document } = await counted(2, [false, false], [[false]])

    expect(document).toContain('reviewThreads(first: 2)')
    expect(result).toMatchObject({ unresolvedThreads: 2, threadsTruncated: true })
    expect(reads).toEqual([])
    expect((await counted(MAX_THREADS, [false], [])).document).toContain('reviewThreads(first: 100)')
  })

  it.each([
    ['a failed page', { ok: false, failure: { code: 'unavailable', message: 'Rate limited' } }, 'Rate limited'],
    ['a page that repeats its cursor', { ok: true, page: threadPage([false], 'page-1') }, 'GitHub review thread pagination did not advance'],
    ['a page without a cursor', { ok: true, page: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } },
      'GitHub review thread pagination did not advance'],
  ] satisfies [string, ThreadPageResult, string][])('fails the pull request for %s without losing another one', async (_label, page, message) => {
    const query = snapshotQuery([pull(1), pull(2)], MAX_THREADS)
    const body = { data: { r0: { ...repositorySettings(), p0: pullRequestNode(1, { reviewThreads: threadPage(hundred(0), 'page-1') }), p1: pullRequestNode(2) } } }

    const results = await mapSnapshotResponse(body, query, { threads: async () => page })

    expect(results.get(changeRequestKey(pull(1)))).toEqual({ code: 'unavailable', message })
    expect(results.get(changeRequestKey(pull(2)))).toMatchObject({ unresolvedThreads: 2, threadsTruncated: false })
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

describe('review thread page mapping', () => {
  it('validates the next page', () => {
    const page = threadPage([true, false], 'next')
    expect(mapThreadPageResponse({ data: { node: { reviewThreads: page } } })).toEqual({ ok: true, page })
  })

  it.each([
    [{ data: { node: null } }, 'GitHub review thread page is unavailable'],
    [{ data: { node: { reviewThreads: threadPage([true]) } }, errors: [{ message: 'Rate limited' }] }, 'Rate limited'],
    [{ data: { node: { reviewThreads: { nodes: [] } } } }, 'unexpected GitHub review thread page'],
  ])('rejects unavailable, partial, or malformed pages', (body, message) => {
    expect(mapThreadPageResponse(body)).toEqual({ ok: false, failure: { code: 'unavailable', message } })
  })
})

describe('pull request commit mapping', () => {
  const answer = (headRefOid: string, baseRefOid: string) => ({ data: { repository: { pullRequest: { headRefOid, baseRefOid } } } })

  it('returns the head and base commits, or nothing for a response that does not name both as commit object names', () => {
    expect(mapPullRequestCommitsResponse(answer('a'.repeat(40), 'b'.repeat(64)))).toEqual({ head: 'a'.repeat(40), base: 'b'.repeat(64) })
    expect(mapPullRequestCommitsResponse(answer('a'.repeat(40), 'main'))).toBeUndefined()
    expect(mapPullRequestCommitsResponse(answer('HEAD', 'b'.repeat(40)))).toBeUndefined()
    expect(mapPullRequestCommitsResponse({ data: { repository: { pullRequest: null } } })).toBeUndefined()
    expect(mapPullRequestCommitsResponse('not json')).toBeUndefined()
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

describe('overview mapping', () => {
  const user = (login: string) => ({ __typename: 'User', login, avatarUrl: `https://avatars.example/${login}` })
  const review = (state: string, author: unknown, oid: string | null = 'f'.repeat(40)) => ({ state, commit: oid === null ? null : { oid }, author })

  it('lists requested reviewers in host order, then other reviewers, each with their latest outcome', async () => {
    const snapshot = await single(pullRequestNode(1, {
      reviewRequests: { totalCount: 4, nodes: [
        { asCodeOwner: false, requestedReviewer: user('lin') },
        { asCodeOwner: true, requestedReviewer: { __typename: 'Team', combinedSlug: 'octo/forge', avatarUrl: null } },
        { asCodeOwner: false, requestedReviewer: { __typename: 'Bot', login: 'copilot', avatarUrl: null } },
        { asCodeOwner: false, requestedReviewer: { __typename: 'Mannequin', login: 'ghost' } },
        { asCodeOwner: false, requestedReviewer: null },
      ] },
      latestReviews: { totalCount: 4, nodes: [
        review('COMMENTED', { __typename: 'Bot', login: 'review-bot', avatarUrl: null }),
        review('COMMENTED', user('zhou'), 'e'.repeat(40)),
        review('COMMENTED', user('octo')),
        review('PENDING', user('qian')),
        review('COMMENTED', null),
      ] },
      latestOpinionatedReviews: { totalCount: 2, nodes: [review('CHANGES_REQUESTED', user('zhou'), 'e'.repeat(40)), review('APPROVED', user('LIN'), null)] },
    }))
    expect(snapshot.reviewers).toEqual([
      { kind: 'user', login: 'LIN', avatarUrl: 'https://avatars.example/lin', requested: true, codeOwner: false, verdict: 'approved', reviewedSha: null },
      { kind: 'team', login: 'octo/forge', avatarUrl: null, requested: true, codeOwner: true, verdict: null, reviewedSha: null },
      { kind: 'bot', login: 'copilot', avatarUrl: null, requested: true, codeOwner: false, verdict: null, reviewedSha: null },
      { kind: 'bot', login: 'review-bot', avatarUrl: null, requested: false, codeOwner: false, verdict: 'commented', reviewedSha: 'f'.repeat(40) },
      { kind: 'user', login: 'zhou', avatarUrl: 'https://avatars.example/zhou', requested: false, codeOwner: false,
        verdict: 'changes-requested', reviewedSha: 'e'.repeat(40) },
    ])
    expect(snapshot.reviewersTruncated).toBe(false)
  })

  it.each([
    ['review requests', { reviewRequests: { totalCount: 30, nodes: [] } }],
    ['reviews', { latestReviews: { totalCount: 30, nodes: [] } }],
    ['opinionated reviews', { latestOpinionatedReviews: { totalCount: 30, nodes: [] } }],
  ])('reports more %s than it read as an incomplete reviewer list', async (_label, overrides) => {
    expect((await single(pullRequestNode(1, overrides))).reviewersTruncated).toBe(true)
  })

  it.each([
    ['an open, mergeable head the viewer may update', {}, ['merge']],
    ['a head that can also be rebased', { canBeRebased: true }, ['merge', 'rebase']],
    ['a conflicting head', { mergeable: 'CONFLICTING' }, []],
    ['a closed pull request', { state: 'CLOSED' }, []],
    // GitHub answers false both for a head that is up to date and for one the viewer may not update.
    ['a head up to date or one the viewer may not update', { viewerCanUpdateBranch: false }, []],
    ['a head behind its base whose merge state is blocked', { mergeStateStatus: 'BLOCKED' }, ['merge']],
  ])('offers branch updates for %s', async (_label, overrides, updates) => {
    expect((await single(pullRequestNode(1, { viewerCanUpdateBranch: true, ...overrides }))).branchUpdates).toEqual(updates)
  })

  it.each([
    ['TRIAGE', 'OPEN', true, false],
    ['WRITE', 'OPEN', true, true],
    ['READ', 'OPEN', false, false],
    ['ADMIN', 'MERGED', false, true],
  ])('lets a %s viewer of a %s pull request request reviews: %s, and rerun checks: %s', async (permission, state, requests, reruns) => {
    const snapshot = await single(pullRequestNode(1, { state }), repositorySettings({ viewerPermission: permission }))
    expect([snapshot.canRequestReviews, snapshot.canRerunChecks]).toEqual([requests, reruns])
  })

  it('grants neither without readable repository settings', async () => {
    const snapshot = await single(pullRequestNode(1), null)
    expect([snapshot.canRequestReviews, snapshot.canRerunChecks]).toEqual([false, false])
  })

  it('names a rerun only for a check of a workflow run with a database id', async () => {
    const run = checkRun('lint', 'COMPLETED', 'FAILURE')
    const snapshot = await single(pullRequestNode(1, {}, [
      run,
      { ...checkRun('test', 'COMPLETED', 'FAILURE'), checkSuite: { app: { id: 'github-actions' }, workflowRun: null } },
      { ...checkRun('e2e', 'COMPLETED', 'FAILURE'), checkSuite: { app: { id: 'github-actions' },
        workflowRun: { databaseId: null, event: 'pull_request', workflow: { id: 'e2e', name: 'e2e' } } } },
    ]))
    expect(snapshot.checks.map(check => [check.name, check.rerun])).toEqual([['lint', 'actions:7'], ['test', null], ['e2e', null]])
    expect(actionsRunOf('actions:7' as ForgeCheckId)).toBe(7)
    expect(actionsRunOf('status:7' as ForgeCheckId)).toBeUndefined()
  })

  it('maps the linked issues of any repository on the host, noting more than it read', async () => {
    const snapshot = await single(pullRequestNode(1, { closingIssuesReferences: { totalCount: 3, nodes: [
      { number: 6, title: 'Show progress', state: 'OPEN', url: 'https://github.com/octo/demo/issues/6', repository: { name: 'demo', owner: { login: 'octo' } } },
      { number: 2, title: 'Rerun', state: 'CLOSED', url: 'https://github.com/octo/tracker/issues/2', repository: { name: 'tracker', owner: { login: 'octo' } } },
    ] } }))
    expect(snapshot.closingIssues).toEqual([
      { repository: demo, number: 6, title: 'Show progress', state: 'open', url: 'https://github.com/octo/demo/issues/6' },
      { repository: { ...demo, name: 'tracker' }, number: 2, title: 'Rerun', state: 'closed', url: 'https://github.com/octo/tracker/issues/2' },
    ])
    expect(snapshot.closingIssuesTruncated).toBe(true)
  })
})
