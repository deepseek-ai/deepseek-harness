import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ChangeRequestSnapshot, ForgeFailure, ForgeReviewData } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import type { GlabOutput } from '../src/glab.ts'
import { GitLabProvider } from '../src/provider.ts'
import type { GitLabLimits } from '../src/provider.ts'
import type { MergeRequestNode } from '../src/status.ts'
import { app, fakeGlab, HOST, json, merge, mrPath, output, pathOf, sent, sha } from './fixtures.ts'
import type { GlabCall } from './fixtures.ts'
import { job, mergeRequestNode, PIPELINE } from './status.spec.ts'

const signal = new AbortController().signal
const limits: GitLabLimits = {
  maxOutputBytes: 8_000_000, maxReviewThreads: 1000, maxCommits: 250, statusBatchSize: 2, maxConcurrentRequests: 2,
  maxCachedVersionBytes: 1_000_000,
}

function provider(answer: (path: string, call: GlabCall) => GlabOutput | Promise<GlabOutput>, overrides: Partial<GitLabLimits> = {}) {
  const glab = fakeGlab(answer)
  return { subject: new GitLabProvider(glab.run, [HOST, 'GitLab.com', 'gitlab.com'], { ...limits, ...overrides }), calls: glab.calls }
}

/** A status query answer that gives merge request `iid` its node, null for a missing project, or a missing merge request. */
function statusAnswer(call: GlabCall, nodes: Readonly<Record<string, unknown>>): GlabOutput {
  const { variables } = sent(call)
  const data: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(variables)) {
    if (!name.startsWith('i')) continue
    const node = nodes[String(value)]
    data[`m${name.slice(1)}`] = node === undefined ? { mergeRequestsFfOnlyEnabled: false, mergeRequest: null } : node
  }
  return json({ data })
}

/** The project of a status answer with one merge request node. */
function project(node: unknown, fastForwardOnly = false): unknown {
  return { mergeRequestsFfOnlyEnabled: fastForwardOnly, mergeRequest: node }
}

const noIssues = (): GlabOutput => json([])

/** A head pipeline the signed-in user may retry, whose first job page is `jobs`. */
function pipeline(jobs: JobPage, status = 'SUCCESS'): MergeRequestNode['headPipeline'] {
  return { id: PIPELINE, status, userPermissions: { updatePipeline: true }, jobs }
}

/** One page of a pipeline's jobs. */
type JobPage = NonNullable<NonNullable<MergeRequestNode['headPipeline']>['jobs']>

/** Answers for the review read's permission page, draft notes, and approvals, or undefined for another path. */
function reviewSide(path: string): GlabOutput | undefined {
  if (path === 'graphql') {
    return json({ data: { currentUser: { username: 'lin', avatarUrl: null }, project: { mergeRequest: {
      userPermissions: { createNote: true }, reviewers: { nodes: [] },
      discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    } } } })
  }
  if (path.endsWith('/draft_notes')) return json([])
  if (path.endsWith('/approvals')) return json({ user_has_approved: false, user_can_approve: true })
  return undefined
}

describe('GitLab provider addressing', () => {
  const { subject } = provider(() => json({}))

  it('lists its hosts once each in lowercase and names GitLab merge requests', () => {
    expect(subject.hosts).toEqual([HOST, 'gitlab.com'])
    expect(subject.label).toBe('GitLab')
    expect(subject.changeRequestNoun).toBe('merge-request')
  })

  it('serves remotes and merge request URLs on its hosts only', () => {
    expect(subject.repositoryFromRemote(`git@${HOST}:group/sub/app.git`)).toEqual(app)
    expect(subject.repositoryFromRemote('git@elsewhere.test:group/app.git')).toBeUndefined()
    expect(subject.repositoryFromRemote('/local/repo')).toBeUndefined()
    expect(subject.changeRequestFromUrl(`https://${HOST}/group/sub/app/-/merge_requests/6/diffs`)).toEqual(merge(6))
    expect(subject.changeRequestFromUrl('https://elsewhere.test/group/app/-/merge_requests/6')).toBeUndefined()
    expect(subject.changeRequestFromUrl('https://github.com/octo/demo/pull/6')).toBeUndefined()
  })

  it('builds canonical merge request and file URLs', () => {
    expect(subject.changeRequestUrl(merge(6))).toBe(`https://${HOST}/group/sub/app/-/merge_requests/6`)
    expect(subject.fileUrl(merge(6), sha('a'), 'docs/a b.md')).toBe(`https://${HOST}/group/sub/app/-/blob/${sha('a')}/docs/a%20b.md`)
  })
})

describe('GitLab provider status', () => {
  it('reads merge requests in batches and maps each, with its closing issues', async () => {
    const { subject, calls } = provider((path, call) => {
      if (path === 'graphql') return statusAnswer(call, { 1: project(mergeRequestNode({ iid: '1' })), 2: project(mergeRequestNode({ iid: '2' }), true), 3: null })
      return json([{ iid: 9, title: 'Bug', state: 'opened', web_url: `https://${HOST}/group/sub/app/-/issues/9` }])
    })
    const results = await subject.fetch([merge(1), merge(2), merge(3), merge(4), merge(5, { ...app, host: 'elsewhere.test' })], signal)
    expect(results.get(changeRequestKey(merge(1)))).toMatchObject({ state: 'open', mergeMethods: ['merge', 'squash'], closingIssues: [{ number: 9 }] })
    expect(results.get(changeRequestKey(merge(2)))).toMatchObject({ mergeMethods: ['rebase', 'squash'] })
    expect(results.get(changeRequestKey(merge(3)))).toEqual({ code: 'not-found', message: 'merge request 3 was not found' })
    expect(results.get(changeRequestKey(merge(4)))).toEqual({ code: 'not-found', message: 'merge request 4 was not found' })
    expect(results.get(changeRequestKey(merge(5, { ...app, host: 'elsewhere.test' })))).toEqual({
      code: 'unavailable', message: 'forge-gitlab does not serve elsewhere.test; add it to the provider\'s hosts setting',
    })
    const queries = calls.filter(call => call.args.includes('graphql'))
    expect(queries.map(call => sent(call).variables)).toEqual([
      { jobs: 50, p0: 'group/sub/app', i0: '1', p1: 'group/sub/app', i1: '2' },
      { jobs: 50, p0: 'group/sub/app', i0: '3', p1: 'group/sub/app', i1: '4' },
    ])
    expect(calls.filter(call => !call.args.includes('graphql')).map(call => call.args.at(-1))).toEqual(
      expect.arrayContaining([`${mrPath(1)}/closes_issues?per_page=26`, `${mrPath(2)}/closes_issues?per_page=26`]))
  })

  it('halves a batch GitLab refuses as too complex, and fails a single merge request it refuses', async () => {
    const { subject, calls } = provider((path, call) => {
      if (path !== 'graphql') return noIssues()
      const count = Object.keys(sent(call).variables).filter(name => name.startsWith('i')).length
      if (count > 1) return output(JSON.stringify({ errors: [{ message: 'Query has complexity of 270, which exceeds max complexity of 250' }] }), 1)
      return sent(call).variables.i0 === '3' ? output('', 1, 'glab: 502 Bad Gateway (HTTP 502)') : statusAnswer(call, { 1: project(mergeRequestNode()), 2: project(mergeRequestNode()) })
    }, { statusBatchSize: 3 })
    const results = await subject.fetch([merge(1), merge(2), merge(3)], signal)
    expect([...results.values()].map(result => 'code' in result ? result.code : result.state)).toEqual(['open', 'open', 'unavailable'])
    expect(calls.filter(call => call.args.includes('graphql'))).toHaveLength(5)
  })

  it('asks GitLab to check a merge request it has not checked since a change, reporting its mergeability unknown', async () => {
    const { subject, calls } = provider((path, call) => path === 'graphql'
      ? statusAnswer(call, { 1: project(mergeRequestNode({ mergeStatusEnum: 'CANNOT_BE_MERGED_RECHECK', detailedMergeStatus: 'CONFLICT' })), 2: project(mergeRequestNode()) })
      : path === mrPath(1) ? json({ iid: 1 }) : noIssues())
    const results = await subject.fetch([merge(1), merge(2)], signal)
    expect([...results.values()].map(result => 'code' in result ? result.code : result.mergeability)).toEqual(['unknown', 'mergeable'])
    expect(calls.filter(call => call.args.at(-1) === mrPath(1))).toHaveLength(1)
    expect(calls.filter(call => call.args.at(-1) === mrPath(2))).toHaveLength(0)
  })

  it('reports an answer it cannot read as unavailable', async () => {
    const { subject } = provider((path, call) => path === 'graphql' ? statusAnswer(call, { 1: { mergeRequestsFfOnlyEnabled: 'no' } }) : noIssues())
    await expect(subject.fetch([merge(1)], signal)).resolves.toEqual(new Map([[changeRequestKey(merge(1)), { code: 'unavailable', message: 'unexpected GitLab response to the status read' }]]))
  })

  it('reuses closing issues read at the same update time and keeps the last list when a read fails', async () => {
    let updatedAt = 'T1'
    let issues: GlabOutput = json([{ iid: 9, title: 'Bug', state: 'closed', web_url: `https://${HOST}/group/sub/app/-/issues/9` }])
    const { subject, calls } = provider((path, call) => path === 'graphql' ? statusAnswer(call, { 1: project(mergeRequestNode({ updatedAt })) }) : issues)
    const closing = async () => {
      const result = (await subject.fetch([merge(1)], signal)).get(changeRequestKey(merge(1))) as ChangeRequestSnapshot
      return [result.closingIssues.map(issue => issue.number), result.closingIssuesTruncated]
    }
    await expect(closing()).resolves.toEqual([[9], false])
    await expect(closing()).resolves.toEqual([[9], false])
    expect(calls.filter(call => !call.args.includes('graphql'))).toHaveLength(1)
    updatedAt = 'T2'
    issues = output('', 1, 'glab: (HTTP 500)')
    await expect(closing()).resolves.toEqual([[9], true])
    const { subject: fresh } = provider((path, call) => path === 'graphql' ? statusAnswer(call, { 1: project(mergeRequestNode()) }) : json({ unexpected: true }))
    expect((await fresh.fetch([merge(1)], signal)).get(changeRequestKey(merge(1))))
      .toMatchObject({ closingIssues: [], closingIssuesTruncated: true })
  })

  it('reads every job page for a complete check read', async () => {
    const page = (names: string[], next: string | null) => ({ pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: names.map(name => job(name, 'SUCCESS')) })
    const { subject, calls } = provider((path, call) => {
      if (path !== 'graphql') return noIssues()
      if (sent(call).query.includes('after: $cursor')) {
        const cursor = sent(call).variables.cursor
        return json({ data: { project: { mergeRequest: { diffRefs: { headSha: sha('a') }, headPipeline: { jobs: cursor === 'c1' ? page(['b'], 'c2') : page(['c'], null) } } } } })
      }
      return statusAnswer(call, { 6: project(mergeRequestNode({ headPipeline: pipeline(page(['a'], 'c1')) })) })
    })
    const result = await subject.fetchChecks(merge(6), signal)
    expect('checks' in result ? [result.checks.map(check => check.name), result.checksTruncated] : result).toEqual([['a', 'b', 'c'], false])
    expect(sent(calls.find(call => call.args.includes('graphql'))).variables.jobs).toBe(100)
  })

  it.each([
    ['a page without a cursor', () => json({}), { hasNextPage: true, endCursor: null }, { code: 'unavailable', message: 'GitLab job pagination did not advance' }],
    ['a failed page', () => output('', 1, 'glab: (HTTP 500)'), undefined, { code: 'unavailable', message: '(HTTP 500)' }],
    ['an unexpected page', () => json({ data: { project: null } }), undefined, { code: 'unavailable', message: 'unexpected GitLab response to the job read' }],
    ['a page that is not a project', () => json({ data: { project: 5 } }), undefined, { code: 'unavailable', message: 'unexpected GitLab response to the job read' }],
    ['a page without jobs', () => json({ data: { project: { mergeRequest: { diffRefs: null, headPipeline: null } } } }), undefined, { code: 'unavailable', message: 'unexpected GitLab response to the job read' }],
    ['a moved head', () => json({ data: { project: { mergeRequest: { diffRefs: { headSha: sha('d') }, headPipeline: { jobs: { pageInfo: { hasNextPage: false }, nodes: [] } } } } } }), undefined, { code: 'unavailable', message: 'the merge request head moved while its checks were read' }],
    ['pages over maxOutputBytes', () => json({ data: { project: { mergeRequest: { diffRefs: { headSha: sha('a') }, headPipeline: { jobs: { pageInfo: { hasNextPage: false }, nodes: [job('x'.repeat(5000), 'SUCCESS')] } } } } } }), undefined, { code: 'too-large', message: 'the checks of merge request 6 exceed maxOutputBytes' }],
  ])('fails a complete check read with %s', async (_label, next, pageInfo, failure) => {
    const { subject } = provider((path, call) => {
      if (path !== 'graphql') return noIssues()
      if (sent(call).query.includes('after: $cursor')) return next()
      return statusAnswer(call, { 6: project(mergeRequestNode({ headPipeline: pipeline({ pageInfo: pageInfo ?? { hasNextPage: true, endCursor: 'c1' }, nodes: [] }) })) })
    }, { maxOutputBytes: 4000 })
    await expect(subject.fetchChecks(merge(6), signal)).resolves.toEqual(failure)
  })

  it('reads a merge request without a pipeline as having no checks', async () => {
    const { subject } = provider((path, call) => path === 'graphql' ? statusAnswer(call, { 6: project(mergeRequestNode({ headPipeline: null })) }) : noIssues())
    await expect(subject.fetchChecks(merge(6), signal)).resolves.toMatchObject({ checks: [], checksTruncated: false, checksRollup: 'none' })
  })

  it('refuses a check read on an unserved host', async () => {
    await expect(provider(() => json({})).subject.fetchChecks(merge(6, { ...app, host: 'elsewhere.test' }), signal)).resolves.toMatchObject({ code: 'unavailable' })
  })
})

describe('GitLab provider lookups and readiness', () => {
  it('finds open merge requests of a branch in the project itself', async () => {
    const { subject, calls } = provider(path => path.endsWith('group%2Fsub%2Fapp') ? json({ default_branch: 'main' })
      : json([{ iid: 7, source_project_id: 1, target_project_id: 1 }, { iid: 8, source_project_id: 2, target_project_id: 1 }]))
    await expect(subject.findByHead(app, 'feat/x', signal)).resolves.toEqual([merge(7)])
    await expect(subject.findByHead(app, 'main', signal)).resolves.toEqual([])
    expect(calls[1]?.args.at(-1)).toBe('projects/group%2Fsub%2Fapp/merge_requests?state=opened&source_branch=feat%2Fx&order_by=created_at&sort=desc&per_page=20')
  })

  it.each([
    [(path: string) => path.endsWith('app') ? output('', 1, 'glab: (HTTP 404)') : json([]), 'forge-gitlab: head branch lookup failed: (HTTP 404)'],
    [(path: string) => path.endsWith('app') ? json({ default_branch: null }) : output('', 1, 'glab: (HTTP 500)'), 'forge-gitlab: head branch lookup failed: (HTTP 500)'],
    [(path: string) => path.endsWith('app') ? json({}) : json([]), 'forge-gitlab: unexpected GitLab response to the head branch lookup'],
  ])('rejects a lookup GitLab did not answer', async (answer, message) => {
    await expect(provider(answer).subject.findByHead(app, 'feat', signal)).rejects.toThrow(message)
  })

  it('rejects a lookup on an unserved host', async () => {
    await expect(provider(() => json([])).subject.findByHead({ ...app, host: 'elsewhere.test' }, 'feat', signal)).rejects.toThrow('does not serve elsewhere.test')
  })

  it('reports readiness with the sign-in command glab needs', async () => {
    await expect(provider(() => json({ username: 'lin' })).subject.readiness(HOST, signal)).resolves.toEqual({ state: 'ready', message: null, signIn: null })
    await expect(provider(() => output('', 1, '   ERROR  \n Unauthenticated. ')).subject.readiness('gitlab.com', signal))
      .resolves.toEqual({ state: 'unauthenticated', message: 'Unauthenticated.', signIn: { command: 'glab auth login --hostname gitlab.com' } })
    await expect(provider(() => output('', 1, 'glab: dial tcp: lookup failed')).subject.readiness(HOST, signal))
      .resolves.toEqual({ state: 'unavailable', message: 'dial tcp: lookup failed', signIn: null })
    await expect(provider(() => json({})).subject.readiness('elsewhere.test', signal)).resolves.toMatchObject({ state: 'unavailable', signIn: null })
  })
})

describe('GitLab provider actions', () => {
  it('marks a draft ready through GraphQL', async () => {
    const { subject, calls } = provider(() => json({ data: { mergeRequestSetDraft: { errors: [] } } }))
    await expect(subject.markReady(merge(6), signal)).resolves.toBeUndefined()
    expect(calls[0]?.args).toEqual(['api', '--hostname', HOST, 'graphql', '--input', '-', '-H', 'Content-Type: application/json'])
    expect(sent(calls[0]).variables).toEqual({ path: 'group/sub/app', iid: '6' })
  })

  it.each([
    [json({ data: { mergeRequestSetDraft: { errors: ['You cannot do that'] } } }), { code: 'failed', message: 'You cannot do that' }],
    [output(JSON.stringify({ errors: [{ message: 'does not exist' }], data: { mergeRequestSetDraft: null } }), 1), { code: 'failed', message: 'does not exist' }],
    [json({ unexpected: true }), { code: 'unknown', message: 'unexpected GitLab response to mergeRequestSetDraft' }],
    [output('', 1, 'glab: 401 Unauthorized (HTTP 401)'), { code: 'unauthenticated', message: '401 Unauthorized (HTTP 401)' }],
  ])('reports a ready mark GitLab did not take', async (answer, failure) => {
    await expect(provider(() => answer).subject.markReady(merge(6), signal)).resolves.toEqual(failure)
  })

  it('merges at the confirmed head with the chosen squashing', async () => {
    const { subject, calls } = provider(() => json({ state: 'merged' }))
    await expect(subject.merge(merge(6), { method: 'squash', headSha: sha('a') }, signal)).resolves.toBeUndefined()
    await expect(subject.merge(merge(6), { method: 'rebase', headSha: sha('a') }, signal)).resolves.toBeUndefined()
    expect(calls.map(call => call.args.slice(3))).toEqual([
      ['-X', 'PUT', `${mrPath(6)}/merge`, '-f', `sha=${sha('a')}`, '-F', 'squash=true'],
      ['-X', 'PUT', `${mrPath(6)}/merge`, '-f', `sha=${sha('a')}`, '-F', 'squash=false'],
    ])
  })

  it('reports a merge GitLab refused, and refuses an unserved host or an invalid head', async () => {
    await expect(provider(() => output('', 1, 'glab: 409 SHA does not match HEAD of source branch (HTTP 409)')).subject.merge(merge(6), { method: 'merge', headSha: sha('a') }, signal))
      .resolves.toEqual({ code: 'stale', message: '409 SHA does not match HEAD of source branch (HTTP 409)' })
    await expect(provider(() => output('', 1, 'glab: 405 Method Not Allowed (HTTP 405)')).subject.merge(merge(6), { method: 'merge', headSha: sha('a') }, signal))
      .resolves.toEqual({ code: 'failed', message: '405 Method Not Allowed (HTTP 405)' })
    const unserved = merge(6, { ...app, host: 'elsewhere.test' })
    await expect(provider(() => json({})).subject.merge(unserved, { method: 'merge', headSha: sha('a') }, signal)).resolves.toMatchObject({ code: 'failed' })
    await expect(provider(() => json({})).subject.markReady(unserved, signal)).resolves.toMatchObject({ code: 'failed' })
    await expect(provider(() => json({})).subject.merge(merge(6), { method: 'merge', headSha: 'HEAD' }, signal)).rejects.toThrow('forge-gitlab: invalid head commit "HEAD"')
  })
})

/** The REST body of a diff version at `sha('a')` from `sha('b')` that changes `diffs`, each with GitLab's other file fields. */
function versionBody(diffs: readonly Readonly<Record<string, unknown>>[]): GlabOutput {
  return json({
    base_commit_sha: sha('b'), head_commit_sha: sha('a'), start_commit_sha: sha('b'),
    diffs: diffs.map(diff => ({ a_mode: '100644', b_mode: '100644', new_file: false, renamed_file: false, deleted_file: false, ...diff })),
  })
}

describe('GitLab provider reads', () => {
  const versions = json([{ id: 41, head_commit_sha: sha('a'), base_commit_sha: sha('b'), start_commit_sha: sha('b'), real_size: '1' }])
  const files = (diff: string, extra: Record<string, unknown> = {}) => versionBody([{ old_path: 'a.ts', new_path: 'a.ts', diff, ...extra }])

  it('reads the patch of the newest version at the head, comparing collapsed files from their texts', async () => {
    const { subject, calls } = provider((path) => {
      if (path.endsWith('versions?per_page=1')) return versions
      if (path.includes('/raw?ref=')) return output(path.includes(sha('b')) ? 'a\n' : 'b\n')
      return files('', { collapsed: true })
    })
    await expect(subject.diff(merge(6), sha('a'), signal)).resolves.toBe('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n')
    expect(calls.map(call => call.args.at(-1))).toContain(`${mrPath(6)}/versions/41?unidiff=true`)
  })

  it('reports a moved head, and refuses unserved hosts and invalid commits', async () => {
    await expect(provider(() => versions).subject.diff(merge(6), sha('d'), signal)).resolves.toMatchObject({ code: 'stale' })
    const unserved = merge(6, { ...app, host: 'elsewhere.test' })
    const { subject } = provider(() => json({}))
    for (const read of [
      subject.diff(unserved, sha('a'), signal), subject.fileText(unserved, sha('a'), 'a', signal), subject.commits(unserved, signal),
      subject.compare(unserved, sha('a'), sha('b'), signal), subject.mergeBase(unserved, sha('a'), sha('b'), signal), subject.readReview(unserved, sha('a'), signal),
    ]) await expect(read).resolves.toMatchObject({ code: 'unavailable' })
    await expect(subject.diff(merge(6), 'HEAD', signal)).rejects.toThrow('forge-gitlab: invalid head commit "HEAD"')
    await expect(subject.fileText(merge(6), 'HEAD', 'a', signal)).rejects.toThrow('forge-gitlab: invalid commit "HEAD"')
    await expect(subject.compare(merge(6), 'HEAD', sha('a'), signal)).rejects.toThrow('forge-gitlab: invalid commits')
    await expect(subject.mergeBase(merge(6), sha('a'), 'HEAD', signal)).rejects.toThrow('forge-gitlab: invalid commits')
  })

  it('reads file texts, commits, comparisons, and merge bases', async () => {
    const { subject } = provider((path) => {
      if (path.includes('/raw?ref=')) return output('text')
      if (path.includes('/commits?')) return output(`HTTP/1.1 200 OK\r\nX-Total: 1\r\n\r\n${JSON.stringify([{ id: sha('a'), parent_ids: [sha('b')], title: 'T', author_name: 'Lin', authored_date: 'D' }])}`)
      if (path.includes('merge_base')) return json({ id: sha('c') })
      if (path.includes('/compare?')) return json({ diffs: [], compare_timeout: false })
      return json({})
    })
    await expect(subject.fileText(merge(6), sha('a'), 'a.ts', signal)).resolves.toBe('text')
    await expect(subject.commits(merge(6), signal)).resolves.toMatchObject({ headSha: sha('a'), truncated: false })
    await expect(subject.compare(merge(6), sha('b'), sha('a'), signal)).resolves.toBe('')
    const collapsed = provider(path => path.includes('/raw?ref=') ? output('x\n') : json({ diffs: [{
      old_path: 'a.ts', new_path: 'a.ts', a_mode: '100644', b_mode: '100644', new_file: true, renamed_file: false, deleted_file: false, diff: '', collapsed: true,
    }] }))
    await expect(collapsed.subject.compare(merge(6), sha('b'), sha('a'), signal))
      .resolves.toBe('diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+x\n')
    await expect(subject.mergeBase(merge(6), sha('b'), sha('a'), signal)).resolves.toBe(sha('c'))
  })

  /** A merge request whose only thread is outdated at version `version` and whose newest version is at `sha('a')`. */
  function outdated(versionState: string, versionDiff: () => GlabOutput, raw: (path: string) => GlabOutput) {
    return (path: string): GlabOutput => {
      const side = reviewSide(path)
      if (side !== undefined) return side
      if (path.includes('/discussions?')) {
        return json([{ id: 'd1', notes: [{
          id: 1, type: 'DiffNote', body: 'b', system: false, created_at: 'C', resolved: false, author: null,
          position: { base_sha: sha('8'), head_sha: sha('9'), old_path: 'a.ts', new_path: 'a.ts', position_type: 'text', old_line: null, new_line: 2 },
        }] }])
      }
      if (path.endsWith('/versions?per_page=100')) return json([{ id: 41, head_commit_sha: sha('a') }, { id: 40, head_commit_sha: sha('9'), state: versionState }])
      if (path.includes('/versions/40')) return versionDiff()
      return raw(path)
    }
  }
  const hunkOf = (read: ForgeReviewData | ForgeFailure): string | null | undefined => 'code' in read ? undefined : read.threads[0]?.diffHunk

  it('cuts an outdated thread\'s hunk from its version and keeps the version for later reads', async () => {
    const { subject, calls } = provider(outdated('collected', () => files('--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n'), () => output('')))
    expect(hunkOf(await subject.readReview(merge(6), sha('a'), signal))).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+B')
    expect(hunkOf(await subject.readReview(merge(6), sha('a'), signal))).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+B')
    expect(calls.filter(call => call.args.at(-1)?.includes('/versions/40'))).toHaveLength(1)
  })

  it('compares the file\'s texts when GitLab dropped the version\'s files or the version lacks the file', async () => {
    const raw = (path: string): GlabOutput => output(path.includes(sha('8')) ? 'a\nb\n' : 'a\nB\n')
    const dropped = provider(outdated('without_files', () => output('', 1, 'not read'), raw))
    expect(hunkOf(await dropped.subject.readReview(merge(6), sha('a'), signal))).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+B')
    expect(dropped.calls.some(call => call.args.at(-1)?.includes('/versions/40'))).toBe(false)
    const empty = provider(outdated('collected', () => files(''), raw))
    expect(hunkOf(await empty.subject.readReview(merge(6), sha('a'), signal))).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+B')
    const unreadable = provider(outdated('collected', () => output('', 1, 'glab: (HTTP 500)'), raw))
    expect(hunkOf(await unreadable.subject.readReview(merge(6), sha('a'), signal))).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+B')
    const added = provider(outdated('without_files', () => json({}), path => path.includes(sha('8')) ? output('', 1, 'glab: (HTTP 404)') : output('a\nB\n')))
    expect(hunkOf(await added.subject.readReview(merge(6), sha('a'), signal))).toBe('@@ -0,0 +1,2 @@\n+a\n+B')
    const failing = provider(outdated('without_files', () => json({}), () => output('', 1, 'glab: (HTTP 500)')))
    expect(hunkOf(await failing.subject.readReview(merge(6), sha('a'), signal))).toBeNull()
  })

  it('shares one cache fill among threads on one file and drops the least recently read entries over its limit', async () => {
    let releases: (() => void)[] = []
    const reads: string[] = []
    const answer = (path: string): GlabOutput | Promise<GlabOutput> => {
      const side = reviewSide(path)
      if (side !== undefined) return side
      if (path.includes('/discussions?')) {
        const note = (id: number, head: string, file: string) => ({ id: `d${id}`, notes: [{
          id, type: 'DiffNote', body: 'b', system: false, created_at: 'C', author: null,
          position: { base_sha: sha('8'), head_sha: head, old_path: file, new_path: file, position_type: 'text', old_line: null, new_line: 1 },
        }] })
        return json([note(1, sha('9'), 'a.ts'), note(2, sha('9'), 'a.ts'), note(3, sha('7'), 'b.ts')])
      }
      if (path.endsWith('/versions?per_page=100')) return json([{ id: 41, head_commit_sha: sha('a') }, { id: 40, head_commit_sha: sha('9') }, { id: 39, head_commit_sha: sha('7') }])
      reads.push(path)
      const file = path.includes('/versions/40') ? 'a.ts' : 'b.ts'
      return new Promise((resolve) => { releases.push(() => { resolve(versionBody([{ old_path: file, new_path: file, diff: `@@ -0,0 +1 @@\n+${'x'.repeat(40)}\n` }])) }) })
    }
    const { subject } = provider(answer, { maxCachedVersionBytes: 60, maxConcurrentRequests: 3 })
    const first = subject.readReview(merge(6), sha('a'), signal)
    await new Promise(resolve => setTimeout(resolve, 20))
    for (const release of releases) release()
    releases = []
    const read = await first
    if ('code' in read) throw new Error(read.message)
    expect(read.threads.map(thread => thread.diffHunk?.split('\n')[0])).toEqual(['@@ -0,0 +1,1 @@', '@@ -0,0 +1,1 @@', '@@ -0,0 +1,1 @@'])
    expect(reads.filter(path => path.includes('/versions/40'))).toHaveLength(1)
    const again = subject.readReview(merge(6), sha('a'), signal)
    await new Promise(resolve => setTimeout(resolve, 20))
    for (const release of releases) release()
    await again
    expect(reads.filter(path => path.includes('/versions/40')).length + reads.filter(path => path.includes('/versions/39')).length).toBe(3)
  })
})

describe('GitLab provider writes', () => {
  const versions = json([{ id: 41, head_commit_sha: sha('a'), base_commit_sha: sha('b'), start_commit_sha: sha('c') }])
  const fileList = versionBody([{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1,1 +1,1 @@\n-a\n+b\n' }])
  const comment = { path: 'a.ts', side: 'R', startLine: 1, endLine: 1, body: 'Why?' } as const

  it('places comments on the newest version, reading its files once for later writes', async () => {
    const { subject, calls } = provider((path) => {
      if (path.endsWith('versions?per_page=1')) return versions
      if (path.endsWith('/versions/41?unidiff=true')) return fileList
      if (path.endsWith('/discussions')) return json({ id: 'd', notes: [{ id: 9 }] })
      return json({ id: 3 })
    })
    await expect(subject.writeReview(merge(6), { kind: 'add-pending', headSha: sha('a'), comment }, signal)).resolves.toEqual({ ok: true })
    await expect(subject.submitReview(merge(6), { kind: 'comment', headSha: sha('a'), comment }, signal))
      .resolves.toEqual({ ok: true, url: `https://${HOST}/group/sub/app/-/merge_requests/6#note_9` })
    expect(calls.filter(call => call.args.at(-1)?.endsWith('/versions/41?unidiff=true'))).toHaveLength(1)
    expect(JSON.parse(calls.find(call => pathOf(call.args).endsWith('/draft_notes'))?.input ?? '{}')).toMatchObject({
      note: 'Why?', position: { base_sha: sha('b'), start_sha: sha('c'), head_sha: sha('a'), new_line: 1, old_line: null },
    })
  })

  it('serves a version over maxCachedVersionBytes without keeping it', async () => {
    const big = versionBody([{ old_path: 'a.ts', new_path: 'a.ts', diff: `@@ -1,1 +1,1 @@\n-a\n+${'b'.repeat(40)}\n` }])
    const { subject, calls } = provider(path => path.endsWith('versions?per_page=1') ? versions : path.endsWith('/versions/41?unidiff=true') ? big : json({ id: 3 }),
      { maxCachedVersionBytes: 32 })
    for (let write = 0; write < 2; write++) {
      await expect(subject.writeReview(merge(6), { kind: 'add-pending', headSha: sha('a'), comment }, signal)).resolves.toEqual({ ok: true })
    }
    expect(calls.filter(call => call.args.at(-1)?.endsWith('/versions/41?unidiff=true'))).toHaveLength(2)
  })

  it('places a comment on the file a new path names after chained renames', async () => {
    const renamed = versionBody([
      { old_path: 'a.txt', new_path: 'b.txt', renamed_file: true, diff: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      { old_path: 'b.txt', new_path: 'c.txt', renamed_file: true, diff: '@@ -1,1 +1,1 @@\n-x\n+c\n' },
    ])
    const { subject, calls } = provider(path => path.endsWith('versions?per_page=1') ? versions : path.endsWith('/versions/41?unidiff=true') ? renamed : json({ id: 3 }))
    await expect(subject.writeReview(merge(6), { kind: 'add-pending', headSha: sha('a'), comment: { ...comment, path: 'b.txt' } }, signal))
      .resolves.toEqual({ ok: true })
    expect(JSON.parse(calls.find(call => pathOf(call.args).endsWith('/draft_notes'))?.input ?? '{}')).toMatchObject({
      position: { old_path: 'a.txt', new_path: 'b.txt', new_line: 1, old_line: null },
    })
  })

  it('places a comment on an added line of a file GitLab collapsed, and refuses it when the texts cannot be read', async () => {
    const collapsed = versionBody([{ old_path: 'a.ts', new_path: 'a.ts', diff: '', collapsed: true }])
    const answer = (raw: (path: string) => GlabOutput) => (path: string): GlabOutput => path.endsWith('versions?per_page=1') ? versions
      : path.endsWith('/versions/41?unidiff=true') ? collapsed : path.includes('/raw?ref=') ? raw(path) : json({ id: 3 })
    const readable = provider(answer(path => output(path.includes(sha('b')) ? 'a\n' : 'a\nb\n')))
    await expect(readable.subject.writeReview(merge(6), { kind: 'add-pending', headSha: sha('a'), comment: { ...comment, startLine: 2, endLine: 2 } }, signal))
      .resolves.toEqual({ ok: true })
    expect(JSON.parse(readable.calls.find(call => pathOf(call.args).endsWith('/draft_notes'))?.input ?? '{}')).toMatchObject({
      position: { new_line: 2, old_line: null },
    })
    const unreadable = provider(answer(() => output('', 1, 'glab: (HTTP 500)')))
    await expect(unreadable.subject.writeReview(merge(6), { kind: 'add-pending', headSha: sha('a'), comment }, signal))
      .resolves.toEqual({ ok: false, code: 'failed', message: 'GitLab did not list the changed files of the merge request' })
  })

  it('reruns checks from a complete check read, requests reviews, lists candidates, and rebases', async () => {
    const { subject, calls } = provider((path, call) => {
      if (path === 'graphql') {
        const { query } = sent(call)
        if (query.includes('allowsMultipleReviewers')) return json({ data: { project: { mergeRequest: { allowsMultipleReviewers: true, reviewers: { nodes: [] } } } } })
        if (query.includes('mergeRequestSetReviewers')) return json({ data: { mergeRequestSetReviewers: { errors: [] } } })
        if (query.includes('autocompleteUsers')) return json({ data: { project: { autocompleteUsers: [{ username: 'zhou', name: 'Zhou', avatarUrl: null }], mergeRequest: null } } })
        const failed = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [job('test', 'FAILED')] }
        return statusAnswer(call, { 6: project(mergeRequestNode({ headPipeline: pipeline(failed, 'FAILED') })) })
      }
      if (path.endsWith('?include_rebase_in_progress=true')) return json({ sha: sha('a') })
      return path.endsWith('/closes_issues?per_page=26') ? noIssues() : json({})
    })
    await expect(subject.rerunChecks(merge(6), { headSha: sha('a') }, signal)).resolves.toBeUndefined()
    await expect(subject.requestReviews(merge(6), { reviewers: [{ kind: 'user', login: 'zhou' }] }, signal)).resolves.toBeUndefined()
    await expect(subject.reviewerCandidates(merge(6), 'zh', signal)).resolves.toEqual([{ login: 'zhou', name: 'Zhou', avatarUrl: null, suggested: false }])
    await expect(subject.updateBranch(merge(6), { method: 'rebase', headSha: sha('a') }, signal)).resolves.toBeUndefined()
    expect(calls.filter(call => call.args.includes('-X')).map(call => call.args.slice(3, 6))).toEqual([
      ['-X', 'POST', 'projects/group%2Fsub%2Fapp/pipelines/77/retry'], ['-X', 'PUT', `${mrPath(6)}/rebase`],
    ])
    expect(sent(calls.find(call => sent(call).query?.includes('mergeRequestSetReviewers'))).variables).toMatchObject({ usernames: ['zhou'] })
  })

  it('refuses writes on an unserved host and invalid heads', async () => {
    const unserved = merge(6, { ...app, host: 'elsewhere.test' })
    const { subject, calls } = provider(() => json({}))
    const refused = { ok: false, code: 'failed', message: 'forge-gitlab does not serve elsewhere.test; add it to the provider\'s hosts setting' }
    await expect(subject.writeReview(unserved, { kind: 'add-pending', headSha: sha('a'), comment }, signal)).resolves.toEqual(refused)
    await expect(subject.submitReview(unserved, { kind: 'comment', headSha: sha('a'), comment }, signal)).resolves.toEqual(refused)
    for (const action of [
      subject.rerunChecks(unserved, { headSha: sha('a') }, signal), subject.requestReviews(unserved, { reviewers: [] }, signal),
      subject.updateBranch(unserved, { method: 'rebase', headSha: sha('a') }, signal),
    ]) await expect(action).resolves.toMatchObject({ code: 'failed' })
    await expect(subject.reviewerCandidates(unserved, '', signal)).resolves.toMatchObject({ code: 'unavailable' })
    await expect(subject.writeReview(merge(6), { kind: 'add-pending', headSha: 'HEAD', comment }, signal)).rejects.toThrow('forge-gitlab: invalid head commit "HEAD"')
    await expect(subject.submitReview(merge(6), { kind: 'comment', headSha: 'HEAD', comment }, signal)).rejects.toThrow('invalid head commit')
    await expect(subject.rerunChecks(merge(6), { headSha: 'HEAD' }, signal)).rejects.toThrow('invalid head commit')
    await expect(subject.updateBranch(merge(6), { method: 'rebase', headSha: 'HEAD' }, signal)).rejects.toThrow('invalid head commit')
    expect(calls).toEqual([])
  })
})

/** Narrow a fetch result for assertions. */
export function isFailure(result: ChangeRequestSnapshot | ForgeFailure | undefined): result is ForgeFailure {
  return result !== undefined && 'code' in result
}
