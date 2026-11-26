import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  effectiveReviewDecisions,
  evaluateApproval as evaluateWithHistory,
} from './check-approval.mjs'
import {
  ACTIONS_BOT_USER_ID,
  approvalEventFromWorkflowDispatch,
  isActionsBotComment,
  isPublisherReview,
  runApprovalCheck as runPublisher,
} from './publish-approval.mjs'
import {
  ACTIONS_BOT,
  HEAD_SHA,
  PUBLISHER,
  STATUS_MARKER,
  accountUser,
  actionsBotComment,
  comment,
  delegationApi,
  evaluateDelegation,
  pullRequestEvent,
} from './review-fixtures.mjs'

const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')
const withoutComments = api => (path, options) =>
  path.includes('/comments?') ? [] : api(path, options)
const evaluateApproval = options => evaluateWithHistory({ getMergedCount: async () => 0, ...options, api: withoutComments(options.api) })
const runWithHistory = options => runPublisher(options)
const runApprovalCheck = options => runWithHistory({ getMergedCount: async () => 0, ...options })
const OLD_SHA = 'abcdef1234567890abcdef1234567890abcdef12'

const review = (login, state, submitted_at = '2026-09-14T00:00:00Z', id = 10, commit_id = HEAD_SHA) => ({
  user: accountUser(login), state, submitted_at, id, commit_id,
})
const publisherReview = (state = 'APPROVED', id = 200, commit_id = HEAD_SHA) => ({
  user: accountUser(PUBLISHER.login), state, submitted_at: '2026-09-14T00:00:00Z', id, commit_id,
  body: `${STATUS_MARKER}\nWeighted approval satisfied.`,
})

// The workflow token owns repository reads and status comments; the machine-user PAT owns only
// identity verification and review writes. Each API caller rejects every path owned by the other.
function pilotApis({
  reviews = [], comments = [], permissions = {}, currentHead = HEAD_SHA,
  currentState = 'open', currentDraft = false,
  submittedReview = { id: 200, state: 'APPROVED', commit_id: HEAD_SHA, user: { ...PUBLISHER } },
  identity = { ...PUBLISHER },
  dismissal = id => ({ id, state: 'DISMISSED' }),
} = {}) {
  const readCalls = []
  const reviewCalls = []
  let nextCommentId = 500
  const pull = () => ({
    ...pullRequestEvent().pull_request, state: currentState, draft: currentDraft, head: { sha: currentHead },
  })
  const readApi = async (path, options = {}) => {
    const method = options.method ?? 'GET'
    readCalls.push({ path, method, body: options.body })
    if (path === '/user') throw new Error('the workflow token must not verify the machine identity')
    if (path.includes('/reviews?')) return reviews
    const permission = /\/collaborators\/([^/]+)\/permission$/u.exec(path)
    if (permission) return { permission: permissions[decodeURIComponent(permission[1]).toLowerCase()] ?? 'write' }
    if (path.includes('/comments?')) return comments
    if (path.endsWith('/issues/42/comments') && method === 'POST') {
      const created = { id: nextCommentId++, user: { ...ACTIONS_BOT }, body: options.body.body }
      comments.push(created)
      return created
    }
    const commentPath = /\/issues\/comments\/([0-9]+)$/u.exec(path)
    if (commentPath && method === 'DELETE') {
      const index = comments.findIndex(entry => entry.id === Number(commentPath[1]))
      if (index >= 0) comments.splice(index, 1)
      return undefined
    }
    if (commentPath && method === 'PATCH') {
      const existing = comments.find(entry => entry.id === Number(commentPath[1]))
      if (!existing) throw new Error(`unknown comment ${commentPath[1]}`)
      existing.body = options.body.body
      return existing
    }
    if (path.endsWith('/pulls/42')) return pull()
    throw new Error(`unexpected read API path ${path}`)
  }
  const reviewApi = async (path, options = {}) => {
    const method = options.method ?? 'GET'
    reviewCalls.push({ path, method, body: options.body })
    if (path === '/user') return identity
    if (path.endsWith('/pulls/42/reviews') && method === 'POST') return submittedReview
    const dismissalPath = /\/reviews\/([0-9]+)\/dismissals$/u.exec(path)
    if (dismissalPath && method === 'PUT') return dismissal(Number(dismissalPath[1]))
    throw new Error(`unexpected review API path ${path}`)
  }
  return { readApi, reviewApi, readCalls, reviewCalls, comments }
}

test('pins the workflow and machine identities and their record markers', () => {
  assert.equal(ACTIONS_BOT_USER_ID, 41_898_282)
  assert.equal(PUBLISHER.id, 359_032_549)
  assert.equal(ACTIONS_BOT.id, ACTIONS_BOT_USER_ID)
  assert.equal(ACTIONS_BOT.login, 'github-actions[bot]')
  assert.equal(isActionsBotComment(actionsBotComment()), true)
  assert.equal(isPublisherReview(publisherReview()), true)
})

test('recognizes a workflow comment only when the marker is its first line', () => {
  assert.equal(isActionsBotComment({ ...actionsBotComment(), body: `${STATUS_MARKER}\n## Weighted approval` }), true)
  for (const body of [
    `Quoted status:\n${STATUS_MARKER}\n## Weighted approval`,
    `The marker ${STATUS_MARKER} appears in prose.`,
    `${STATUS_MARKER} trailing text`,
    'no marker',
  ]) {
    assert.equal(isActionsBotComment({ id: 91, body, user: { ...ACTIONS_BOT } }), false, body)
  }
  assert.equal(isActionsBotComment({ id: 92, body: `${STATUS_MARKER}\nstatus`, user: accountUser('reviewer') }), false)
  assert.equal(isActionsBotComment({ id: 93, body: `${STATUS_MARKER}\nstatus`, user: { id: '41898282' } }), false)
  assert.equal(isActionsBotComment({ id: 94, body: `${STATUS_MARKER}\nstatus` }), false)
  assert.equal(isActionsBotComment({ id: 95, user: { ...ACTIONS_BOT } }), false)
  assert.equal(isActionsBotComment(null), false)
  assert.equal(isActionsBotComment([]), false)
})

test('recognizes a machine review by account and marker anywhere in its body', () => {
  assert.equal(isPublisherReview(publisherReview()), true)
  assert.equal(isPublisherReview({ ...publisherReview(), body: `Quoted marker ${STATUS_MARKER}` }), true)
  assert.equal(isPublisherReview({ ...publisherReview(), user: accountUser('reviewer') }), false)
  assert.equal(isPublisherReview({ ...publisherReview(), body: 'manual machine review' }), false)
  assert.equal(isPublisherReview({ ...publisherReview(), body: undefined }), false)
  assert.equal(isPublisherReview({ state: 'APPROVED' }), false)
})

test('rejects reviews without immutable account IDs', () => {
  for (const user of [{ login: 'writer' }, { login: 'writer', id: 0 }, { login: 'writer', id: '7' }]) {
    assert.throws(() => effectiveReviewDecisions([{ user, state: 'APPROVED' }]), /no valid account ID/u)
  }
})

test('comments a write-capable change request while ignoring the author and read-only reviewers', async () => {
  const { readApi, reviewApi, readCalls, reviewCalls } = pilotApis({
    reviews: [
      review('turtle1999', 'APPROVED'),
      review('blocker', 'CHANGES_REQUESTED'),
      review('reader', 'CHANGES_REQUESTED'),
      review('author', 'CHANGES_REQUESTED'),
    ],
    permissions: { reader: 'read' },
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent({ author: 'author' }),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    reviewApi,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  assert.equal(result.description, '1 blocking change request.')
  assert.equal(result.points, 2)
  assert.deepEqual(result.blockers, ['blocker'])
  assert.deepEqual(result.ignoredReviewers, ['reader'])
  const created = readCalls.find(call => call.path.endsWith('/issues/42/comments'))
  assert.equal(created?.method, 'POST')
  assert.match(created.body.body, /2\/2 points/u)
  assert.match(created.body.body, /Blocking change requests:\n- @blocker/u)
  assert.match(created.body.body, /Reviews without write access are not counted: @reader\./u)
  assert.equal(created.body.body.split('\n', 1)[0], STATUS_MARKER)
  assert.deepEqual(reviewCalls, [])
})

test('submits the approving review and removes a stale status comment', async () => {
  const output = []
  const { readApi, reviewApi, readCalls, reviewCalls, comments } = pilotApis({
    reviews: [review('turtle2099', 'APPROVED')],
    comments: [actionsBotComment()],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    reviewApi,
    write: line => output.push(line),
  })
  assert.equal(result.state, 'success')
  assert.equal(output[0], 'Author credit: not evaluated (reviewer points suffice).')
  assert.equal(output[1], 'Approval score: 2/2.')
  assert.equal(readCalls.find(call => call.path.endsWith('/issues/comments/90'))?.method, 'DELETE')
  assert.equal(comments.length, 0)
  const approval = readCalls.find(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST')
  assert.equal(approval, undefined)
  const submitted = reviewCalls.find(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST')
  assert.equal(submitted?.body.event, 'APPROVE')
  assert.equal(submitted.body.commit_id, HEAD_SHA)
  assert.match(submitted.body.body, /Weighted approval satisfied: 2\/2 points\./u)
  assert.match(submitted.body.body, /- @turtle2099: 2 points/u)
  assert.deepEqual(reviewCalls.map(call => `${call.method} ${call.path}`), [
    'GET /user',
    'POST /repos/deepseek-harness/deepseek-harness/pulls/42/reviews',
  ])
  assert.ok(!readCalls.some(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST'))
})

test('keeps its approval out of the score and does not submit a second review', async () => {
  const { readApi, readCalls, reviewCalls } = pilotApis({
    reviews: [publisherReview(), review('writer', 'APPROVED'), review('second', 'APPROVED')],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    write: () => {},
  })
  assert.equal(result.state, 'success')
  assert.equal(result.points, 2)
  assert.ok(!readCalls.some(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST'))
  assert.ok(!readCalls.some(call => call.path.endsWith('/dismissals')))
  assert.deepEqual(reviewCalls, [])
})

test('fails without publishing when evaluation fails', async () => {
  const calls = []
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    readApi: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' })
      if (path.includes('/reviews?')) throw new Error('reviews unavailable')
      throw new Error(`unexpected API path ${path}`)
    },
  }), /reviews unavailable; retracting the previous weighted approval also failed: reviews unavailable/u)
  assert.deepEqual(calls.map(call => call.path), [
    '/repos/deepseek-harness/deepseek-harness/pulls/42/reviews?per_page=100&page=1',
    '/repos/deepseek-harness/deepseek-harness/pulls/42/reviews?per_page=100&page=1',
  ])
})

test('retracts its own approval when scoring fails after identity verification', async () => {
  const { readApi: baseRead, reviewApi, reviewCalls } = pilotApis({ reviews: [publisherReview('APPROVED', 77)] })
  const original = new Error('scoring unavailable')
  let reviewReads = 0
  const readApi = async (path, options) => {
    if (path.includes('/reviews?')) {
      reviewReads++
      if (reviewReads === 1) throw original
    }
    return baseRead(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    readApi,
    reviewApi,
    write: () => {},
  }), (error) => {
    assert.equal(error, original)
    return true
  })
  assert.equal(reviewReads, 2)
  assert.ok(reviewCalls.some(call => call.path.endsWith('/reviews/77/dismissals') && call.method === 'PUT'))
  assert.ok(!reviewCalls.some(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST'))
})

test('preserves both scoring and retraction diagnostics when dismissal fails', async () => {
  const { readApi: baseRead, reviewApi } = pilotApis({ reviews: [publisherReview('APPROVED', 77)] })
  let reviewReads = 0
  const readApi = async (path, options = {}) => {
    if (path.includes('/reviews?')) {
      reviewReads++
      if (reviewReads === 1) throw new Error('scoring failed')
    }
    return baseRead(path, options)
  }
  const failing = async (path, options = {}) => {
    if (path.endsWith('/reviews/77/dismissals') && options.method === 'PUT') {
      throw new Error('dismissal rejected')
    }
    return reviewApi(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    readApi,
    reviewApi: failing,
    write: () => {},
  }), (error) => {
    assert.match(error.message, /scoring failed/u)
    assert.match(error.message, /dismissal rejected/u)
    return true
  })
})

test('does not retract a nonowned or unmarked approval', async () => {
  const { readApi: baseRead, reviewCalls } = pilotApis({ reviews: [
    { ...publisherReview('APPROVED', 77), user: accountUser('reviewer') },
    { ...publisherReview('APPROVED', 78), body: 'manual machine review' },
  ] })
  let reviewReads = 0
  const readApi = async (path, options) => {
    if (path.includes('/reviews?')) {
      reviewReads++
      if (reviewReads === 1) throw new Error('scoring unavailable')
    }
    return baseRead(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    readApi,
    write: () => {},
  }), /scoring unavailable/u)
  assert.equal(reviewReads, 2)
  assert.ok(!reviewCalls.some(call => call.path.endsWith('/dismissals')))
})

test('does not retract when the publisher identity is unverified', async () => {
  const { readApi, reviewApi, reviewCalls } = pilotApis({
    reviews: [publisherReview('APPROVED', 77)],
    identity: { id: 1, login: 'other' },
  })
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    readApi,
    reviewApi,
    write: () => {},
  }), /not the @deepseek-ai-harness machine user/u)
  assert.deepEqual(reviewCalls.map(call => call.path), ['/user'])
})

test('excludes unmarked machine reviews from scoring and blocking', async () => {
  for (const state of ['APPROVED', 'CHANGES_REQUESTED']) {
    const result = await evaluateApproval({
      event: pullRequestEvent(),
      policySource,
      getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
      api: async path => {
        if (path.includes('/reviews?')) {
          return [{
            user: accountUser(PUBLISHER.login), state, submitted_at: '2026-09-14T00:00:00Z', id: 300,
          }, review('writer', 'APPROVED')]
        }
        if (path.includes('/collaborators/writer/permission')) return { permission: 'write' }
        throw new Error(`unexpected API path ${path}`)
      },
    })
    assert.equal(result.points, 1)
    assert.deepEqual(result.approvals.map(({ login, points }) => ({ login, points })), [{ login: 'writer', points: 1 }])
    assert.deepEqual(result.blockers, [])
  }
})

test('machine reviews do not reclaim delegated points', async () => {
  const result = await evaluateDelegation({ api: delegationApi({
    comments: [comment('turtle1999', '/delegate @writer')],
    reviews: [review('writer', 'APPROVED'),
      { ...publisherReview('COMMENTED', 300), submitted_at: '2026-09-16T00:00:00Z' }],
  }) })
  assert.equal(result.points, 3)
  assert.equal(result.delegations.length, 1)
})

test('machine-authored commands and machine recipients do not delegate', async () => {
  const ignoredCommand = await evaluateDelegation({ api: delegationApi({
    comments: [comment(PUBLISHER.login, '/delegate @writer')],
    reviews: [review('writer', 'APPROVED')],
  }) })
  assert.equal(ignoredCommand.points, 1)
  assert.deepEqual(ignoredCommand.delegations, [])

  const read = delegationApi({
    comments: [comment('turtle1999', `/delegate @${PUBLISHER.login}`)],
    reviews: [review('writer', 'APPROVED')],
  })
  const result = await evaluateDelegation({ api: (path, options) => {
    assert.ok(!path.includes(`/collaborators/${PUBLISHER.login}/`))
    return read(path, options)
  } })
  assert.equal(result.points, 1)
  assert.deepEqual(result.delegations, [])
})

test('only the machine identity with the marker owns reviews', async () => {
  const { readApi, reviewApi, reviewCalls } = pilotApis({ reviews: [
    { ...publisherReview('APPROVED', 77), body: 'manual machine review' },
    publisherReview('APPROVED', 78),
    review('writer', 'APPROVED'),
  ] })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    reviewApi,
    write: () => {},
  })
  assert.equal(result.points, 1)
  assert.ok(reviewCalls.some(call => call.path.endsWith('/reviews/78/dismissals')))
  assert.ok(!reviewCalls.some(call => call.path.endsWith('/reviews/77/dismissals')))
})

test('publishes an approval for the current head after an older approval', async () => {
  const { readApi, reviewApi, reviewCalls } = pilotApis({
    reviews: [publisherReview('APPROVED', 200, OLD_SHA), review('turtle2099', 'APPROVED')],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    reviewApi,
    write: () => {},
  })
  assert.equal(result.state, 'success')
  const approval = reviewCalls.find(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST')
  assert.equal(approval?.body.commit_id, HEAD_SHA)
})

test('rejects an approval response for another commit, state, or reviewer', async () => {
  for (const submittedReview of [
    { id: 200, state: 'APPROVED', commit_id: OLD_SHA, user: { ...PUBLISHER } },
    { id: 200, state: 'CHANGES_REQUESTED', commit_id: HEAD_SHA, user: { ...PUBLISHER } },
    { id: 200, state: 'APPROVED', commit_id: HEAD_SHA, user: accountUser('other-reviewer') },
    { id: 200, state: 'APPROVED', commit_id: HEAD_SHA },
  ]) {
    const { readApi, reviewApi } = pilotApis({ reviews: [review('turtle2099', 'APPROVED')], submittedReview })
    await assert.rejects(runApprovalCheck({
      event: pullRequestEvent(),
      policySource,
      getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
      readApi,
      reviewApi,
      write: () => {},
    }), /evaluated head and machine user/u)
  }
})

test('does not approve after the head changes, the PR closes, or it becomes a draft', async () => {
  for (const current of [
    { currentHead: OLD_SHA },
    { currentState: 'closed' },
    { currentDraft: true },
  ]) {
    const { readApi, reviewApi, readCalls, reviewCalls, comments } = pilotApis({
      reviews: [review('turtle2099', 'APPROVED')], comments: [actionsBotComment()], ...current,
    })
    await assert.rejects(runApprovalCheck({
      event: pullRequestEvent(),
      policySource,
      getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
      readApi,
      reviewApi,
      write: () => {},
    }), /closed, became a draft, or changed head/u)
    assert.ok(!reviewCalls.some(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST'))
    assert.equal(comments.length, 1)
    assert.ok(!readCalls.some(call => call.method === 'DELETE' && call.path.endsWith('/issues/comments/90')))
  }
})

test('verifies the pinned machine user before any review write', async () => {
  for (const identity of [
    { id: PUBLISHER.id, login: 'someone-else' },
    { id: 1, login: PUBLISHER.login },
    { id: String(PUBLISHER.id), login: PUBLISHER.login },
    { ...ACTIONS_BOT },
    null,
  ]) {
    const { readApi, reviewApi, readCalls, reviewCalls } = pilotApis({
      reviews: [review('turtle2099', 'APPROVED')], comments: [actionsBotComment()], identity,
    })
    await assert.rejects(runApprovalCheck({
      event: pullRequestEvent(),
      policySource,
      readApi,
      reviewApi,
      write: () => {},
    }), /not the @deepseek-ai-harness machine user/u)
    assert.deepEqual(reviewCalls.map(call => call.path), ['/user'])
    assert.ok(!readCalls.some(call => call.method !== 'GET'))
    assert.ok(!readCalls.some(call => call.path.endsWith('/issues/comments/90')))
  }

  const { readApi, reviewCalls } = pilotApis({ reviews: [review('turtle2099', 'APPROVED')] })
  const appTokenIdentity = async (path, options = {}) => {
    assert.equal(path, '/user')
    assert.equal(options.method ?? 'GET', 'GET')
    throw new Error('Resource not accessible by integration')
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    readApi,
    reviewApi: appTokenIdentity,
    write: () => {},
  }), /Resource not accessible by integration/u)
  assert.deepEqual(reviewCalls, [])
})

test('fails without publishing when production attribution fails', async () => {
  const { readApi, readCalls, reviewCalls } = pilotApis({ reviews: [review('writer', 'APPROVED')] })
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(), policySource,
    getOwnership: async () => { throw new Error('incomplete history') },
    readApi, write: () => {},
  }), /incomplete history/u)
  assert.ok(readCalls.every(call => call.method === 'GET'))
  assert.deepEqual(reviewCalls, [])
})

test('does not publish before evaluating expensive attribution', async () => {
  const { readApi, readCalls, reviewApi } = pilotApis({ reviews: [review('writer', 'APPROVED')] })
  await runApprovalCheck({
    event: pullRequestEvent(), policySource, write: () => {},
    getOwnership: async () => {
      assert.ok(readCalls.every(call => call.method === 'GET'))
      return { totalLines: 100, reviewerLines: { writer: 25 } }
    },
    readApi,
    reviewApi,
  })
})

test('reuses one status comment and updates it when the score changes', async () => {
  const { readApi, readCalls, reviewCalls, comments } = pilotApis({
    reviews: [review('writer', 'APPROVED')],
    comments: [actionsBotComment()],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  const update = readCalls.find(call => call.path.endsWith('/issues/comments/90'))
  assert.equal(update?.method, 'PATCH')
  assert.match(update.body.body, /1\/2 points/u)
  assert.match(update.body.body, /- @writer: 1 point\n/u)
  assert.match(update.body.body, /1 more approval point is required\./u)
  assert.ok(!readCalls.some(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST'))
  assert.equal(comments.length, 1)
  assert.deepEqual(reviewCalls, [])
})

test('does not round a pending score up to the threshold or show zero remaining', async () => {
  const { readApi, readCalls } = pilotApis({ reviews: [review('writer', 'APPROVED')] })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 1_000_000, reviewerLines: { writer: 249_941 } }),
    readApi,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  assert.ok(result.points < 2 && result.points > 1.999)
  assert.match(result.description, /^1\.999\/2 approval points/u)
  const created = readCalls.find(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST')
  assert.match(created.body.body, /Weighted approval: 1\.999\/2 points/u)
  assert.match(created.body.body, /- @writer: 1\.999 points/u)
  assert.match(created.body.body, /0\.001 more approval points are required\./u)
  assert.doesNotMatch(created.body.body, /2\/2 points/u)
  assert.doesNotMatch(created.body.body, /0 more approval/u)
})

test('creates a status comment and ignores a copied marker', async () => {
  const copied = { id: 91, body: `${STATUS_MARKER}\nnot the approval publisher`, user: accountUser('reviewer') }
  const { readApi, readCalls, comments } = pilotApis({ comments: [copied] })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  const created = readCalls.find(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST')
  assert.match(created.body.body, /0\/2 points/u)
  assert.match(created.body.body, /2 more approval points are required/u)
  assert.ok(!readCalls.some(call => call.path.includes('/issues/comments/91')))
  assert.equal(comments.length, 2)
})

test('ignores an Actions bot comment whose marker is not the first line', async () => {
  const quoted = {
    id: 92,
    body: `A maintainer posted this status earlier:\n\n${STATUS_MARKER}\n## Weighted approval: 1/2 points`,
    user: { ...ACTIONS_BOT },
  }
  const { readApi, readCalls, comments } = pilotApis({ comments: [quoted] })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  assert.ok(!readCalls.some(call => call.path.includes('/issues/comments/92')))
  const created = readCalls.find(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST')
  assert.equal(created?.body.body.split('\n', 1)[0], STATUS_MARKER)
  assert.equal(comments.length, 2)
})

test('dismisses its approval when the policy no longer holds', async () => {
  const { readApi, reviewApi, readCalls, reviewCalls } = pilotApis({
    reviews: [publisherReview('APPROVED', 77), review('writer', 'APPROVED')],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    reviewApi,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  assert.equal(result.points, 1)
  const dismissal = reviewCalls.find(call => call.path.endsWith('/reviews/77/dismissals'))
  assert.equal(dismissal?.method, 'PUT')
  assert.equal(dismissal.body.event, 'DISMISS')
  assert.ok(readCalls.some(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST'))
})

test('approves again after its previous approval was dismissed', async () => {
  const { readApi, reviewApi, reviewCalls } = pilotApis({
    reviews: [publisherReview('DISMISSED', 77), review('turtle2099', 'APPROVED')],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    reviewApi,
    write: () => {},
  })
  assert.equal(result.state, 'success')
  assert.ok(reviewCalls.some(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST'))
})

test('fails when the approval dismissal is not confirmed', async () => {
  const { readApi, reviewApi, readCalls, comments } = pilotApis({
    reviews: [publisherReview('APPROVED', 77)],
    comments: [actionsBotComment()],
    dismissal: id => ({ id, state: 'APPROVED' }),
  })
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    reviewApi,
    write: () => {},
  }), /approval review dismissal was not confirmed/u)
  assert.ok(readCalls.every(call => call.method === 'GET'))
  assert.equal(comments.length, 1)
  assert.equal(comments[0].body, actionsBotComment().body)
})

test('retracts its approval and removes the comment on a draft', async () => {
  const { readApi, reviewApi, readCalls, reviewCalls, comments } = pilotApis({
    reviews: [publisherReview('APPROVED', 77)],
    comments: [actionsBotComment()],
  })
  await runApprovalCheck({
    event: pullRequestEvent({ draft: true }),
    policySource,
    readApi,
    reviewApi,
    write: () => {},
  })
  assert.ok(reviewCalls.some(call => call.method === 'PUT' && call.path.endsWith('/reviews/77/dismissals')))
  assert.ok(readCalls.some(call => call.method === 'DELETE' && call.path.endsWith('/issues/comments/90')))
  assert.equal(comments.length, 0)
})

test('fails when the approval review cannot be submitted and keeps the status comment', async () => {
  const { readApi, reviewApi, readCalls, comments } = pilotApis({
    reviews: [review('turtle2099', 'APPROVED')],
    comments: [actionsBotComment()],
  })
  const failing = async (path, options) => {
    if (path.endsWith('/pulls/42/reviews') && options?.method === 'POST') throw new Error('review rejected')
    return reviewApi(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    reviewApi: failing,
    write: () => {},
  }), /review rejected/u)
  assert.ok(!readCalls.some(call => call.method === 'DELETE' && call.path.endsWith('/issues/comments/90')))
  assert.equal(comments.length, 1)
})

test('requires the machine PAT before dismissing an existing approval', async () => {
  const { readApi, readCalls, comments } = pilotApis({
    reviews: [publisherReview('APPROVED', 77)],
    comments: [actionsBotComment()],
  })
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    write: () => {},
  }), /APPROVAL_TOKEN is not set/u)
  assert.ok(readCalls.every(call => call.method === 'GET'))
  assert.equal(comments.length, 1)
  assert.equal(comments[0].body, actionsBotComment().body)
})

test('requires the machine PAT before submitting an approval', async () => {
  const { readApi, readCalls, comments } = pilotApis({
    reviews: [review('turtle2099', 'APPROVED')],
    comments: [actionsBotComment()],
  })
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    write: () => {},
  }), /APPROVAL_TOKEN is not set/u)
  assert.ok(readCalls.every(call => call.method === 'GET'))
  assert.equal(comments.length, 1)
})

test('does not construct the machine PAT for a pending evaluation without a marked approval', async () => {
  const { readApi, reviewCalls } = pilotApis()
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  assert.deepEqual(reviewCalls, [])
})

test('does not check the machine identity when no review write is needed', async () => {
  const { readApi, reviewApi, reviewCalls } = pilotApis({ identity: { ...ACTIONS_BOT } })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    readApi,
    reviewApi,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  assert.deepEqual(reviewCalls, [])
})

test('reads ownership and merged history through the read-only API', async () => {
  let mergedApi
  let ownershipApi
  const readApi = async () => { throw new Error('scoring must use the injected history readers') }
  const result = await evaluateApproval({
    event: pullRequestEvent(),
    policySource,
    readApi,
    getMergedCount: async (_pull, used) => { mergedApi = used; return 0 },
    getOwnership: async (_pull, used) => { ownershipApi = used; return { totalLines: 0, reviewerLines: {} } },
    api: async path => path.includes('/reviews?') ? [review('writer', 'APPROVED')] : { permission: 'write' },
  })
  assert.equal(mergedApi, readApi)
  assert.equal(ownershipApi, readApi)
  assert.equal(result.state, 'pending')
})

test('uses the workflow token for reads and the machine PAT only for review writes', async () => {
  const { readApi, reviewApi, readCalls, reviewCalls } = pilotApis({ reviews: [review('turtle2099', 'APPROVED')] })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    readApi,
    reviewApi,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  })
  assert.equal(result.state, 'success')
  assert.ok(readCalls.some(call => call.path.endsWith('/pulls/42')))
  assert.ok(!reviewCalls.some(call => call.path.endsWith('/pulls/42')))
  assert.deepEqual(reviewCalls.map(call => `${call.method} ${call.path}`), [
    'GET /user',
    'POST /repos/deepseek-harness/deepseek-harness/pulls/42/reviews',
  ])
})

test('records author credit in the published approval', async () => {
  const { readApi, reviewApi, reviewCalls } = pilotApis({ reviews: [review('writer', 'APPROVED')] })
  const result = await runWithHistory({
    event: pullRequestEvent(), policySource,
    getMergedCount: async () => 50,
    getOwnership: async () => ({ totalLines: 80, reviewerLines: { writer: 9 } }),
    readApi,
    reviewApi,
    write: () => {},
  })
  assert.equal(result.state, 'success')
  const approval = reviewCalls.find(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST')
  assert.match(approval.body.body, /Author credit: 0\.55 points\./u)
})

test('publishes without dismissing delegated human reviews or requesting reviewers', async () => {
  const comments = [comment('turtle1999', '/delegate @writer')]
  const reviews = [review('turtle1999', 'APPROVED', undefined, 10), review('writer', 'APPROVED')]
  const read = delegationApi({ comments, reviews })
  const readCalls = []
  const readApi = async (path, options = {}) => {
    const method = options.method ?? 'GET'
    readCalls.push({ path, method })
    assert.notEqual(path, '/user')
    assert.ok(!path.endsWith('/dismissals'))
    assert.ok(!path.endsWith('/requested_reviewers'))
    assert.ok(!(path.endsWith('/pulls/42/reviews') && method === 'POST'))
    return read(path, options)
  }
  const { reviewApi, reviewCalls } = pilotApis()
  const result = await runWithHistory({
    event: pullRequestEvent(),
    policySource,
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
    readApi,
    reviewApi,
  })
  assert.equal(result.state, 'success')
  assert.equal(result.delegations.length, 1)
  assert.deepEqual(result.delegations[0].reviewIds, [10])
  assert.deepEqual(reviewCalls.map(call => `${call.method} ${call.path}`), [
    'GET /user',
    'POST /repos/deepseek-harness/deepseek-harness/pulls/42/reviews',
  ])
  assert.ok(!readCalls.some(call => call.path.endsWith('/dismissals')))
  assert.ok(!readCalls.some(call => call.path.endsWith('/requested_reviewers')))
})

test('rejects a delegation author without an immutable account ID', async () => {
  await assert.rejects(evaluateDelegation({
    api: delegationApi({ comments: [{ user: {}, body: '/delegate @writer' }] }),
  }), /delegation author has no valid account ID/u)
})

test('manual dispatch resolves only a canonical number to the live PR', async () => {
  const event = { repository: pullRequestEvent().repository, inputs: { pull_number: '42' } }
  let calls = 0
  const resolved = await approvalEventFromWorkflowDispatch({ event, readApi: async path => {
    calls++
    assert.equal(path, '/repos/deepseek-harness/deepseek-harness/pulls/42')
    return pullRequestEvent().pull_request
  } })
  assert.equal(resolved.pull_request.number, 42)
  assert.equal(calls, 1)
  assert.equal(await approvalEventFromWorkflowDispatch({ event,
    readApi: async () => ({ ...pullRequestEvent().pull_request, state: 'closed' }) }), null)
  for (const inputs of [
    undefined,
    {},
    { pull_number: '0' },
    { pull_number: '00' },
    { pull_number: '-1' },
    { pull_number: '+1' },
    { pull_number: '01' },
    { pull_number: ' 1' },
    { pull_number: '1 ' },
    { pull_number: '1.0' },
    { pull_number: 42 },
    { pull_number: '9007199254740992' },
  ]) {
    await assert.rejects(approvalEventFromWorkflowDispatch({
      event: { repository: event.repository, inputs },
      readApi: async () => assert.fail('invalid dispatch must not call the API'),
    }), /workflow dispatch/u)
  }
})
