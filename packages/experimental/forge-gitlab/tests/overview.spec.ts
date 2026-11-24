import type {
  AutoMergeRequest, ChangeRequestCheck, ChangeRequestSnapshot, ForgeCheckId, ForgeFailure,
} from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import { GitLabApi } from '../src/api.ts'
import type { GlabOutput } from '../src/glab.ts'
import {
  AUTO_MERGE_MUTATION, CANDIDATES_QUERY, gitLabReviewerCandidates, REREVIEW_MUTATION, requestGitLabReviews, rerunGitLabChecks,
  REVIEWERS_QUERY, setGitLabAutoMerge, SET_REVIEWERS_MUTATION, updateGitLabBranch,
} from '../src/overview.ts'
import { fakeGlab, HOST, json, merge, mrPath, output, sent, sha } from './fixtures.ts'

const signal = new AbortController().signal
const HEAD = sha('a')
const PIPELINE = 'gid://gitlab/Ci::Pipeline/77' as ForgeCheckId
const refused = (status: number, message = 'no'): GlabOutput => output(JSON.stringify({ message }), 1, `glab: ${message} (HTTP ${status})`)

function check(state: ChangeRequestCheck['state'], rerun: ForgeCheckId | null = PIPELINE): ChangeRequestCheck {
  return { name: state, state, url: null, workflow: null, startedAt: null, completedAt: null, rerun }
}

describe('GitLab pipeline retries', () => {
  const rerun = async (read: ChangeRequestSnapshot | ForgeFailure, answer: GlabOutput = json({ id: 77 }), headSha = HEAD) => {
    const glab = fakeGlab(() => answer)
    const result = await rerunGitLabChecks(new GitLabApi(glab.run), async () => read, merge(6), { headSha }, signal)
    return { result, calls: glab.calls.map(call => call.args.slice(3)) }
  }
  const snapshot = (checks: readonly ChangeRequestCheck[]) => ({ headSha: HEAD, checks }) as ChangeRequestSnapshot

  it('retries the head pipeline once it has failed jobs and none pending', async () => {
    await expect(rerun(snapshot([check('success'), check('failure'), check('cancelled'), check('failure', 'other' as ForgeCheckId), check('pending', null)])))
      .resolves.toEqual({ result: undefined, calls: [['-X', 'POST', 'projects/group%2Fsub%2Fapp/pipelines/77/retry']] })
  })

  it.each([
    ['no failed job', [check('success'), check('failure', null)], 'No failed GitLab job of the head pipeline can be retried'],
    ['a pending job', [check('failure'), check('pending')], 'The head pipeline still runs jobs; retry its failed jobs once they finish'],
  ] as const)('refuses a pipeline with %s', async (_label, checks, message) => {
    await expect(rerun(snapshot(checks))).resolves.toEqual({ result: { code: 'failed', message }, calls: [] })
  })

  it('refuses a moved head, reports a failed read, and reports a retry GitLab refused', async () => {
    await expect(rerun(snapshot([check('failure')]), undefined, sha('9'))).resolves.toEqual({
      result: { code: 'stale', message: `the merge request head moved from ${sha('9')} to ${HEAD}` }, calls: [],
    })
    await expect(rerun({ code: 'unauthenticated', message: 'sign in' })).resolves.toMatchObject({ result: { code: 'unauthenticated' } })
    await expect(rerun({ code: 'unavailable', message: 'down' })).resolves.toMatchObject({ result: { code: 'failed', message: 'down' } })
    await expect(rerun(snapshot([check('failure')]), refused(403))).resolves.toMatchObject({ result: { code: 'failed', message: 'no (HTTP 403)' } })
  })
})

describe('GitLab review requests', () => {
  const reviewers = (nodes: readonly { readonly id: string; readonly username: string }[], allowsMultipleReviewers = true): GlabOutput =>
    json({ data: { project: { mergeRequest: { allowsMultipleReviewers, reviewers: { nodes } } } } })
  const request = async (logins: readonly { readonly kind: 'user' | 'bot' | 'team'; readonly login: string }[], current: GlabOutput,
    mutation: (field: string) => GlabOutput = field => json({ data: { [field]: { errors: [] } } })) => {
    const glab = fakeGlab((_path, call) => {
      const { query } = sent(call)
      return query === REVIEWERS_QUERY ? current : mutation(query === SET_REVIEWERS_MUTATION ? 'mergeRequestSetReviewers' : 'mergeRequestReviewerRereview')
    })
    const result = await requestGitLabReviews(new GitLabApi(glab.run), merge(6), { reviewers: logins }, signal)
    return { result, sent: glab.calls.map(call => sent(call)).filter(body => body.query !== REVIEWERS_QUERY) }
  }

  it('adds new reviewers once each and asks current reviewers again', async () => {
    const { result, sent: mutations } = await request(
      [{ kind: 'user', login: 'Lin' }, { kind: 'bot', login: 'ci-bot' }, { kind: 'user', login: 'lin' }, { kind: 'user', login: 'ZHOU' }],
      reviewers([{ id: 'gid://gitlab/User/5', username: 'zhou' }]))
    expect(result).toBeUndefined()
    expect(mutations).toEqual([
      { query: SET_REVIEWERS_MUTATION, variables: { path: 'group/sub/app', iid: '6', usernames: ['Lin', 'ci-bot'] } },
      { query: REREVIEW_MUTATION, variables: { path: 'group/sub/app', iid: '6', user: 'gid://gitlab/User/5' } },
    ])
  })

  it('refuses a second reviewer where GitLab takes one, team reviewers, and an empty request', async () => {
    await expect(request([{ kind: 'user', login: 'lin' }], reviewers([{ id: 'u1', username: 'zhou' }], false))).resolves.toEqual({
      result: { code: 'failed', message: 'This GitLab merge request takes one reviewer; change its reviewer on GitLab' }, sent: [],
    })
    await expect(request([{ kind: 'user', login: 'zhou' }], reviewers([{ id: 'u1', username: 'zhou' }], false))).resolves.toMatchObject({ result: undefined })
    await expect(request([{ kind: 'team', login: 'group/team' }], reviewers([]))).resolves.toEqual({
      result: { code: 'failed', message: 'GitLab has no team reviewers' }, sent: [],
    })
    await expect(request([], reviewers([]))).resolves.toEqual({ result: { code: 'failed', message: 'No reviewer was named' }, sent: [] })
  })

  it('reports a failed reviewer read and a refused request', async () => {
    await expect(request([{ kind: 'user', login: 'lin' }], output('', 1, 'glab: (HTTP 401)'))).resolves.toMatchObject({ result: { code: 'unauthenticated' } })
    await expect(request([{ kind: 'user', login: 'lin' }], output('', 1, 'glab: (HTTP 404)'))).resolves.toMatchObject({ result: { code: 'failed' } })
    await expect(request([{ kind: 'user', login: 'lin' }], json({ data: { project: null } }))).resolves.toMatchObject({
      result: { code: 'failed', message: 'unexpected GitLab response to the reviewer read' },
    })
    const refusing = (field: string) => json({ data: { [field]: { errors: ['nope'] } } })
    await expect(request([{ kind: 'user', login: 'lin' }], reviewers([]), refusing)).resolves.toMatchObject({ result: { code: 'failed', message: 'nope' } })
    await expect(request([{ kind: 'user', login: 'zhou' }], reviewers([{ id: 'u1', username: 'zhou' }]), refusing)).resolves.toMatchObject({ result: { code: 'failed', message: 'nope' } })
  })
})

describe('GitLab reviewer candidates', () => {
  const candidates = async (answer: GlabOutput, query = ' li ') => {
    const glab = fakeGlab(() => answer)
    const result = await gitLabReviewerCandidates(new GitLabApi(glab.run), merge(6), query, signal)
    return { result, sent: sent(glab.calls[0]) }
  }

  it('lists GitLab\'s matches without the author, with absolute avatars', async () => {
    const users = [
      { username: 'octo', name: 'Octo', avatarUrl: null },
      { username: 'lin', name: 'Lin', avatarUrl: '/uploads/-/system/user/avatar/1/a.png' },
      ...Array.from({ length: 25 }, (_, index) => ({ username: `u${index}`, name: `U ${index}`, avatarUrl: 'https://avatar/u' })),
    ]
    const { result, sent: query } = await candidates(json({ data: { project: { autocompleteUsers: users, mergeRequest: { author: { username: 'OCTO' } } } } }))
    expect(query).toEqual({ query: CANDIDATES_QUERY, variables: { path: 'group/sub/app', iid: '6', search: 'li' } })
    expect(Array.isArray(result) ? result.slice(0, 2) : result).toEqual([
      { login: 'lin', name: 'Lin', avatarUrl: `https://${HOST}/uploads/-/system/user/avatar/1/a.png`, suggested: false },
      { login: 'u0', name: 'U 0', avatarUrl: 'https://avatar/u', suggested: false },
    ])
    expect(Array.isArray(result) ? result.length : 0).toBe(20)
  })

  it('lists no one for a project without matches or a merge request, and reports a hidden project or a failed read', async () => {
    await expect(candidates(json({ data: { project: { autocompleteUsers: null, mergeRequest: null } } })))
      .resolves.toMatchObject({ result: [] })
    await expect(candidates(json({ data: { project: { autocompleteUsers: [{ username: 'a', name: 'A', avatarUrl: null }], mergeRequest: { author: null } } } })))
      .resolves.toMatchObject({ result: [{ login: 'a', avatarUrl: null }] })
    await expect(candidates(json({ data: { project: null } }))).resolves.toMatchObject({ result: { code: 'not-found', message: 'project group/sub/app is not visible' } })
    await expect(candidates(json({ data: { project: 'nope' } }))).resolves.toMatchObject({ result: { code: 'unavailable' } })
    await expect(candidates(output('', 1, 'glab: (HTTP 404)'))).resolves.toMatchObject({ result: { code: 'not-found' } })
  })
})

describe('GitLab rebases', () => {
  const update = async (answers: Readonly<Record<string, GlabOutput>>, method: 'merge' | 'rebase' = 'rebase', headSha = HEAD) => {
    const glab = fakeGlab(path => answers[path] ?? json({}))
    const result = await updateGitLabBranch(new GitLabApi(glab.run), merge(6), { method, headSha }, signal)
    return { result, calls: glab.calls.map(call => call.args.slice(3)) }
  }
  const read = `${mrPath(6)}?include_rebase_in_progress=true`

  it('reads the head and rebases while it is the confirmed commit', async () => {
    await expect(update({ [read]: json({ sha: HEAD.toUpperCase(), rebase_in_progress: false }), [`${mrPath(6)}/rebase`]: json({ rebase_in_progress: true }) }))
      .resolves.toEqual({ result: undefined, calls: [[read], ['-X', 'PUT', `${mrPath(6)}/rebase`]] })
  })

  it('refuses a merge, a moved head, a rebase in progress, and reports reads and rebases GitLab refused', async () => {
    await expect(update({}, 'merge')).resolves.toEqual({ result: { code: 'failed', message: 'GitLab updates a merge request branch only by rebasing it' }, calls: [] })
    await expect(update({ [read]: json({ sha: sha('9') }) })).resolves.toEqual({
      result: { code: 'stale', message: `the merge request head moved from ${HEAD} to ${sha('9')}` }, calls: [[read]],
    })
    await expect(update({ [read]: json({ sha: HEAD, rebase_in_progress: true }) })).resolves.toMatchObject({ result: { code: 'failed', message: 'GitLab is already rebasing the merge request' } })
    await expect(update({ [read]: json({ id: 1 }) })).resolves.toMatchObject({ result: { code: 'failed', message: 'unexpected GitLab response to the merge request read' } })
    await expect(update({ [read]: output('', 1, 'glab: (HTTP 401)') })).resolves.toMatchObject({ result: { code: 'unauthenticated' } })
    await expect(update({ [read]: output('', 1, 'glab: (HTTP 404)') })).resolves.toMatchObject({ result: { code: 'failed' } })
    await expect(update({ [read]: json({ sha: HEAD }), [`${mrPath(6)}/rebase`]: refused(403) })).resolves.toMatchObject({ result: { code: 'failed', message: 'no (HTTP 403)' } })
  })
})

describe('GitLab automatic merges', () => {
  const set = async (request: AutoMergeRequest, answer: GlabOutput) => {
    const glab = fakeGlab(() => answer)
    const result = await setGitLabAutoMerge(new GitLabApi(glab.run), merge(6), request, signal)
    return { result, calls: glab.calls }
  }
  const accepted = json({ data: { mergeRequestAccept: { errors: [] } } })
  const refusing = (error: string): GlabOutput => json({ data: { mergeRequestAccept: { errors: [error] } } })
  const failure = (code: string, message: string) => ({ code, message })
  const MOVED = 'The merge-head is not at the anticipated SHA'
  const SCHEDULED = 'The merge request is already scheduled to be merged'
  const forbidden = output(JSON.stringify({ errors: [{ message: 'no permission' }], data: { mergeRequestAccept: null } }), 1)

  it.each([
    ['squash', true],
    ['merge', false],
    ['rebase', false],
  ] as const)('turns it on at the confirmed head for the %s method, waiting for the merge checks', async (method, squash) => {
    const { result, calls } = await set({ enabled: true, method, headSha: HEAD }, accepted)
    expect(result).toBeUndefined()
    expect(calls.map(call => call.args.slice(3))).toEqual([['graphql', '--input', '-', '-H', 'Content-Type: application/json']])
    expect(sent(calls[0])).toEqual({ query: AUTO_MERGE_MUTATION, variables: { path: 'group/sub/app', iid: '6', sha: HEAD, squash } })
    expect(AUTO_MERGE_MUTATION).toContain('strategy: MERGE_WHEN_CHECKS_PASS')
  })

  it.each([
    ['a moved head', refusing(MOVED), failure('stale', MOVED)],
    ['an automatic merge that is on', refusing(SCHEDULED), failure('failed', SCHEDULED)],
    ['a merge request the user may not merge', forbidden, failure('failed', 'no permission')],
    ['rejected credentials', refused(401, '401 Unauthorized'), failure('unauthenticated', '401 Unauthorized (HTTP 401)')],
    ['a server error', refused(502, '502 Bad Gateway'), failure('unknown', '502 Bad Gateway (HTTP 502)')],
    ['an answer without the mutation', json({ data: {} }), failure('unknown', 'unexpected GitLab response to mergeRequestAccept')],
  ])('reports %s when turning it on, sending the request once', async (_label, answer, expected) => {
    const { result, calls } = await set({ enabled: true, method: 'merge', headSha: HEAD }, answer)
    expect(result).toEqual(expected)
    expect(calls).toHaveLength(1)
  })

  it('turns it off through one request that cancels it', async () => {
    const { result, calls } = await set({ enabled: false }, json({ iid: 6, merge_when_pipeline_succeeds: false }))
    expect(result).toBeUndefined()
    expect(calls.map(call => call.args)).toEqual([['api', '--hostname', HOST, '-X', 'POST', `${mrPath(6)}/cancel_auto_merge`]])
    expect(calls[0]?.input).toBeUndefined()
  })

  it.each([
    ['an automatic merge that is off', refused(409, '409 Conflict'), failure('failed', '409 Conflict (HTTP 409)')],
    ['a user who may not cancel it', refused(403, '403 Forbidden'), failure('failed', '403 Forbidden (HTTP 403)')],
    ['a GitLab without the request', refused(404, '404 Not Found'), failure('failed', '404 Not Found (HTTP 404)')],
    ['rejected credentials', refused(401, '401 Unauthorized'), failure('unauthenticated', '401 Unauthorized (HTTP 401)')],
    ['a server error', refused(502, '502 Bad Gateway'), failure('unknown', '502 Bad Gateway (HTTP 502)')],
  ])('reports %s when turning it off, sending the request once', async (_label, answer, expected) => {
    const { result, calls } = await set({ enabled: false }, answer)
    expect(result).toEqual(expected)
    expect(calls).toHaveLength(1)
  })
})
