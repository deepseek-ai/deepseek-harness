import { describe, expect, it } from 'vitest'
import { GitLabApi } from '../src/api.ts'
import type { GlabOutput } from '../src/glab.ts'
import { AWAITED_REVIEW_STATES, GIVEN_REVIEW_STATES } from '../src/status.ts'
import {
  countViewerLists, readInvolvedList, readViewerList, readViewerName, VIEWER_COUNT_QUERY, VIEWER_INVOLVED_QUERY, VIEWER_LIST_QUERIES,
  VIEWER_NAME_QUERY,
} from '../src/viewer.ts'
import { app, fakeGlab, HOST, json, output, sent, sha } from './fixtures.ts'

const signal = new AbortController().signal

/** Every project on {@link HOST}, 20 merge requests. */
const scope = { host: HOST, repository: null, limit: 20 }

/** One merge request as the list queries return it: in `group/sub/app`, with a passed pipeline and no reviewers. */
function row(iid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid, title: `Change ${iid}`, webUrl: `https://${HOST}/group/sub/app/-/merge_requests/${iid}`, draft: false,
    updatedAt: '2026-11-10T08:00:00Z', diffHeadSha: sha('a'), approved: false,
    author: { username: 'octo', avatarUrl: '/uploads/-/system/user/avatar/7/octo.png', bot: false },
    project: { fullPath: 'group/sub/app' }, headPipeline: { status: 'SUCCESS' }, reviewers: { nodes: [] },
    ...overrides,
  }
}

/** One reviewer of a row in `reviewState`, or one GitLab reports no interaction for. */
function reviewer(username: string, reviewState: string | null): Record<string, unknown> {
  return { username, mergeRequestInteraction: reviewState === null ? null : { reviewState } }
}

/** An answer to a query of one connection as `lin`. */
function listAnswer(nodes: readonly unknown[], count = nodes.length): GlabOutput {
  return json({ data: { currentUser: { username: 'lin', list: { count, nodes } } } })
}

function api(answer: GlabOutput) {
  const glab = fakeGlab(() => answer)
  return { subject: new GitLabApi(glab.run), calls: glab.calls }
}

describe('GitLab viewer queries', () => {
  const page = 'state: opened, sort: UPDATED_DESC, first: $first, projectPath: $project'
  const rows = '{ count nodes { ...ViewerRow } }'
  const awaited = 'reviewStates: [UNREVIEWED, REVIEW_STARTED]'
  const reviewed = 'reviewStates: [REVIEWED, REQUESTED_CHANGES, APPROVED, UNAPPROVED], not: { authorUsername: $me }'
  const assigned = 'not: { authorUsername: $me, reviewerUsername: $me }'

  it('selects the open merge requests of each list, most recently updated first', () => {
    expect(VIEWER_LIST_QUERIES['review-requested']).toContain(`list: reviewRequestedMergeRequests(${page}, ${awaited}) ${rows}`)
    expect(VIEWER_LIST_QUERIES.authored).toContain(`list: authoredMergeRequests(${page}) ${rows}`)
    expect(VIEWER_INVOLVED_QUERY).toContain(`reviewed: reviewRequestedMergeRequests(${page}, ${reviewed}) ${rows}`)
    expect(VIEWER_INVOLVED_QUERY).toContain(`assigned: assignedMergeRequests(${page}, ${assigned}) ${rows}`)
    for (const query of [...Object.values(VIEWER_LIST_QUERIES), VIEWER_INVOLVED_QUERY]) {
      expect(query).toContain('reviewers(first: 20) { nodes { username mergeRequestInteraction { reviewState } } }')
    }
  })

  it('counts the same connections in every project', () => {
    expect(VIEWER_COUNT_QUERY).toContain(`awaited: reviewRequestedMergeRequests(state: opened, ${awaited}) { count }`)
    expect(VIEWER_COUNT_QUERY).toContain('authored: authoredMergeRequests(state: opened) { count }')
    expect(VIEWER_COUNT_QUERY).toContain(`reviewed: reviewRequestedMergeRequests(state: opened, ${reviewed}) { count }`)
    expect(VIEWER_COUNT_QUERY).toContain(`assigned: assignedMergeRequests(state: opened, ${assigned}) { count }`)
    expect(VIEWER_COUNT_QUERY).not.toContain('nodes')
  })

  it('selects a reviewed merge request by the user\'s own review state, whatever the other reviewers\' states', () => {
    // GitLab applies a negated review state to every reviewer, so no query negates one.
    for (const query of [VIEWER_INVOLVED_QUERY, VIEWER_COUNT_QUERY]) expect(query).not.toContain('not: { reviewStates')
    // Together the awaited and the given states are the six GitLab defines, and no state is in both lists.
    expect([...AWAITED_REVIEW_STATES, ...GIVEN_REVIEW_STATES].sort())
      .toEqual(['APPROVED', 'REQUESTED_CHANGES', 'REVIEWED', 'REVIEW_STARTED', 'UNAPPROVED', 'UNREVIEWED'])
  })
})

describe('GitLab viewer lists', () => {
  it('reads the merge requests that await the user\'s review through one request and maps each', async () => {
    const { subject, calls } = api(listAnswer([
      row('8'),
      row('7', {
        draft: true, author: { username: 'renovate', avatarUrl: null, bot: true }, headPipeline: null, project: { fullPath: 'group/app' },
        reviewers: { nodes: [reviewer('zhou', 'REQUESTED_CHANGES'), reviewer('Lin', 'REVIEW_STARTED')] },
      }),
      row('6', { author: null, approved: true, headPipeline: { status: 'FAILED' } }),
      row('5', { project: { fullPath: 'app' } }),
      row('4', { project: { fullPath: 'group/bad name/app' } }),
      row('0'),
      row('1e3'),
      row('3', { diffHeadSha: null }),
    ], 32))

    const list = await readViewerList(subject, 'review-requested', scope, signal)

    expect(calls.map(call => call.args))
      .toEqual([['api', 'graphql', '--hostname', HOST, '--input', '-', '-H', 'Content-Type: application/json']])
    expect(sent(calls[0])).toEqual({ query: VIEWER_LIST_QUERIES['review-requested'], variables: { first: 20, project: null } })
    expect(list).toEqual({
      viewer: 'lin',
      total: 32,
      items: [
        {
          ref: { repository: app, number: 8 },
          url: `https://${HOST}/group/sub/app/-/merge_requests/8`,
          title: 'Change 8',
          draft: false,
          author: { login: 'octo', avatarUrl: `https://${HOST}/uploads/-/system/user/avatar/7/octo.png`, bot: false },
          headSha: sha('a'),
          checksRollup: 'success',
          reviewDecision: 'none',
          viewerReview: null,
          viewerRequest: { team: null },
          updatedAt: '2026-11-10T08:00:00Z',
        },
        expect.objectContaining({
          ref: { repository: { forge: 'gitlab', host: HOST, owner: 'group', name: 'app' }, number: 7 },
          draft: true,
          author: { login: 'renovate', avatarUrl: null, bot: true },
          checksRollup: 'none',
          reviewDecision: 'changes-requested',
          viewerReview: null,
          viewerRequest: { team: null },
        }),
        expect.objectContaining({ title: 'Change 6', author: null, checksRollup: 'failure', reviewDecision: 'approved' }),
      ],
    })
  })

  it('reads the merge requests the user wrote in one project, with the user\'s own review state on each', async () => {
    const { subject, calls } = api(listAnswer([
      row('9', { reviewers: { nodes: [reviewer('zhou', 'UNREVIEWED'), reviewer('lin', 'APPROVED')] } }),
      row('8', { reviewers: { nodes: [reviewer('lin', null)] } }),
      row('7', { reviewers: { nodes: [reviewer('lin', 'SOMETHING_NEW')] } }),
      row('6', { reviewers: { nodes: [reviewer('zhou', 'REVIEWED')] } }),
    ]))

    const inProject = { host: HOST, repository: { owner: 'group/sub', name: 'app' }, limit: 5 }
    const list = await readViewerList(subject, 'authored', inProject, signal)

    expect(sent(calls[0])).toEqual({ query: VIEWER_LIST_QUERIES.authored, variables: { first: 5, project: 'group/sub/app' } })
    expect('items' in list ? list.items.map(item => [item.ref.number, item.viewerReview, item.viewerRequest]) : list).toEqual([
      [9, { verdict: 'approved', reviewedSha: null }, null],
      [8, null, { team: null }],
      [7, null, null],
      [6, null, null],
    ])
    expect(list).toMatchObject({ viewer: 'lin', total: 4 })
  })

  it('merges the reviewed and the assigned merge requests most recently updated first, cut to the limit', async () => {
    const { subject, calls } = api(json({ data: { currentUser: {
      username: 'lin',
      reviewed: { count: 4, nodes: [
        row('1', { updatedAt: '2026-11-10T10:00:00Z', reviewers: { nodes: [reviewer('lin', 'REVIEWED')] } }),
        row('3', { updatedAt: '2026-11-10T08:00:00Z' }),
        row('5', { updatedAt: '2026-11-10T11:00:00Z', diffHeadSha: null }),
      ] },
      assigned: { count: 5, nodes: [
        // An instance in another time zone reports the same instant with its offset.
        row('2', { updatedAt: '2026-11-10T17:30:00+08:00' }),
        row('4', { updatedAt: '2026-11-10T07:00:00Z' }),
      ] },
    } } }))

    const list = await readInvolvedList(subject, { ...scope, limit: 3 }, 'lin', signal)

    expect(sent(calls[0])).toEqual({ query: VIEWER_INVOLVED_QUERY, variables: { first: 3, project: null, me: 'lin' } })
    expect(calls).toHaveLength(1)
    expect('items' in list ? list.items.map(item => [item.ref.number, item.viewerReview, item.viewerRequest]) : list).toEqual([
      [1, { verdict: 'commented', reviewedSha: null }, null],
      [2, null, null],
      [3, null, null],
    ])
    expect(list).toMatchObject({ viewer: 'lin', total: 9 })
  })

  it('refuses a project path GitLab cannot hold without a request', async () => {
    const { subject, calls } = api(listAnswer([]))
    const refused = { code: 'not-found', message: 'the project path cannot be searched' }
    const within = (owner: string, name: string) => ({ ...scope, repository: { owner, name } })
    await expect(readViewerList(subject, 'authored', within('group/bad name', 'app'), signal)).resolves.toEqual(refused)
    await expect(readViewerList(subject, 'review-requested', within('group', 'sub/app'), signal)).resolves.toEqual(refused)
    await expect(readInvolvedList(subject, within('..', 'app'), 'lin', signal)).resolves.toEqual(refused)
    expect(calls).toEqual([])
  })

  it('counts every list in one request, the involved list as the sum of its two connections', async () => {
    const { subject, calls } = api(json({ data: { currentUser: {
      username: 'lin', awaited: { count: 32 }, authored: { count: 23 }, reviewed: { count: 4 }, assigned: { count: 11 },
    } } }))
    await expect(countViewerLists(subject, HOST, 'lin', signal)).resolves.toEqual({
      viewer: 'lin', counts: new Map([['review-requested', 32], ['authored', 23], ['involved', 15]]),
    })
    expect(calls.map(sent)).toEqual([{ query: VIEWER_COUNT_QUERY, variables: { me: 'lin' } }])
  })

  it('reads the username of the signed-in user', async () => {
    const { subject, calls } = api(json({ data: { currentUser: { username: 'lin' } } }))
    await expect(readViewerName(subject, HOST, signal)).resolves.toBe('lin')
    expect(calls.map(sent)).toEqual([{ query: VIEWER_NAME_QUERY, variables: {} }])
  })

  const reads = {
    'a list': async (subject: GitLabApi) => await readViewerList(subject, 'review-requested', scope, signal),
    'the involved list': async (subject: GitLabApi) => await readInvolvedList(subject, scope, 'lin', signal),
    'the counts': async (subject: GitLabApi) => await countViewerLists(subject, HOST, 'lin', signal),
    'the username': async (subject: GitLabApi) => await readViewerName(subject, HOST, signal),
  }

  it.each(Object.entries(reads))('reports %s GitLab answers without a signed-in user as unauthenticated', async (_label, read) => {
    await expect(read(api(json({ data: { currentUser: null } })).subject))
      .resolves.toEqual({ code: 'unauthenticated', message: `GitLab named no signed-in user on ${HOST}` })
  })

  it.each([
    ['a list', 'merge request list'], ['the involved list', 'merge request list'], ['the counts', 'merge request count'],
    ['the username', 'user read'],
  ] as const)('reports an answer to %s it cannot read as unavailable', async (label, read) => {
    const unexpected = { code: 'unavailable', message: `unexpected GitLab response to the ${read}` }
    await expect(reads[label](api(json({ data: { currentUser: { username: 7 } } })).subject)).resolves.toEqual(unexpected)
    await expect(reads[label](api(json({ data: { project: null } })).subject)).resolves.toEqual(unexpected)
  })

  it.each([
    ['a signed-out glab', output('', 1, 'Unauthenticated.'), { code: 'unauthenticated', message: 'Unauthenticated.' }],
    ['a gateway error', output('', 1, 'glab: 502 Bad Gateway (HTTP 502)'), { code: 'unavailable', message: '502 Bad Gateway (HTTP 502)' }],
    ['a query over GitLab\'s complexity limit',
      output(JSON.stringify({ errors: [{ message: 'Query has complexity of 270, which exceeds max complexity of 250' }] }), 1),
      { code: 'too-large', message: 'Query has complexity of 270, which exceeds max complexity of 250' }],
  ])('reports %s for every read', async (_label, answer, failure) => {
    for (const read of Object.values(reads)) await expect(read(api(answer).subject)).resolves.toEqual(failure)
  })
})
