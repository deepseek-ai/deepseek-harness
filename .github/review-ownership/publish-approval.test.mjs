import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  effectiveReviewDecisions,
  evaluateApproval as evaluateWithHistory,
} from './check-approval.mjs'
import {
  approvalEventFromWorkflowDispatch,
  runApprovalCheck as runPublisher,
} from './publish-approval.mjs'
import {
  HEAD_SHA,
  PUBLISHER,
  accountUser,
  comment,
  delegationApi,
  evaluateDelegation,
  pullRequestEvent,
} from './review-fixtures.mjs'

const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')
const STATUS_MARKER = '<!-- weighted-approval -->'
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
const statusComment = (body = `${STATUS_MARKER}\nold status`, id = 90, login = PUBLISHER.login) => ({
  id, body, user: accountUser(login),
})

function publicationApi({
  reviews = [], comments = [], permissions = {}, currentHead = HEAD_SHA,
  currentState = 'open', currentDraft = false,
  submittedReview = { id: 200, state: 'APPROVED', commit_id: HEAD_SHA, user: accountUser(PUBLISHER.login) },
} = {}) {
  const calls = []
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET'
    calls.push({ path, method, body: options.body })
    if (path === '/user') return { ...PUBLISHER }
    if (path.includes('/reviews?')) return reviews
    const permission = /\/collaborators\/([^/]+)\/permission$/u.exec(path)
    if (permission) return { permission: permissions[decodeURIComponent(permission[1]).toLowerCase()] ?? 'write' }
    if (path.includes('/comments?')) return comments
    if (path.endsWith('/issues/42/comments')) return { id: 100 }
    if (path.includes('/issues/comments/')) return {}
    if (path.endsWith('/pulls/42')) {
      return { ...pullRequestEvent().pull_request, state: currentState, draft: currentDraft, head: { sha: currentHead } }
    }
    if (path.endsWith('/pulls/42/reviews') && method === 'POST') return submittedReview
    const dismissal = /\/reviews\/([0-9]+)\/dismissals$/u.exec(path)
    if (dismissal) return { id: Number(dismissal[1]), state: 'DISMISSED' }
    throw new Error(`unexpected API path ${path}`)
  }
  return { api, calls }
}

test('rejects reviews without immutable account IDs', () => {
  for (const user of [{ login: 'writer' }, { login: 'writer', id: 0 }, { login: 'writer', id: '7' }]) {
    assert.throws(() => effectiveReviewDecisions([{ user, state: 'APPROVED' }]), /no valid account ID/u)
  }
})

test('comments a write-capable change request while ignoring the author and read-only reviewers', async () => {
  const { api, calls } = publicationApi({
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
    api,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  assert.equal(result.description, '1 blocking change request.')
  assert.equal(result.points, 2)
  assert.deepEqual(result.blockers, ['blocker'])
  assert.deepEqual(result.ignoredReviewers, ['reader'])
  const comment = calls.find(call => call.path.endsWith('/issues/42/comments'))
  assert.equal(comment?.method, 'POST')
  assert.match(comment.body.body, /2\/2 points/u)
  assert.match(comment.body.body, /Blocking change requests:\n- @blocker/u)
  assert.match(comment.body.body, /Reviews without write access are not counted: @reader\./u)
  assert.ok(!calls.some(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST'))
})

test('submits the approving review and removes a stale status comment', async () => {
  const output = []
  const { api, calls } = publicationApi({
    reviews: [review('turtle2099', 'APPROVED')],
    comments: [statusComment()],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    api,
    write: line => output.push(line),
  })
  assert.equal(result.state, 'success')
  assert.equal(output[0], 'Author credit: not evaluated (reviewer points suffice).')
  assert.equal(output[1], 'Approval score: 2/2.')
  assert.equal(calls.find(call => call.path.endsWith('/issues/comments/90'))?.method, 'DELETE')
  const approval = calls.find(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST')
  assert.equal(approval?.body.event, 'APPROVE')
  assert.equal(approval.body.commit_id, HEAD_SHA)
  assert.match(approval.body.body, /Weighted approval satisfied: 2\/2 points\./u)
  assert.match(approval.body.body, /- @turtle2099: 2 points/u)
  assert.ok(!calls.some(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST'))
})

test('keeps its approval out of the score and does not submit a second review', async () => {
  const { api, calls } = publicationApi({
    reviews: [publisherReview(), review('writer', 'APPROVED'), review('second', 'APPROVED')],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    api,
    write: () => {},
  })
  assert.equal(result.state, 'success')
  assert.equal(result.points, 2)
  assert.ok(!calls.some(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST'))
  assert.ok(!calls.some(call => call.path.endsWith('/dismissals')))
})

test('fails without publishing when evaluation fails', async () => {
  const calls = []
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    api: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' })
      if (path === '/user') return { ...PUBLISHER }
      if (path.includes('/reviews?')) throw new Error('reviews unavailable')
      throw new Error(`unexpected API path ${path}`)
    },
  }), /reviews unavailable; retracting the previous weighted approval also failed: reviews unavailable/u)
  assert.deepEqual(calls.map(call => call.path), [
    '/user',
    '/repos/deepseek-harness/deepseek-harness/pulls/42/reviews?per_page=100&page=1',
    '/repos/deepseek-harness/deepseek-harness/pulls/42/reviews?per_page=100&page=1',
  ])
})

test('retracts its own approval when scoring fails after identity verification', async () => {
  const read = publicationApi({ reviews: [publisherReview('APPROVED', 77)] })
  const original = new Error('scoring unavailable')
  let reviewReads = 0
  const api = async (path, options) => {
    if (path.includes('/reviews?')) {
      reviewReads++
      if (reviewReads === 1) throw original
    }
    return read.api(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    api,
    write: () => {},
  }), (error) => {
    assert.equal(error, original)
    return true
  })
  assert.equal(reviewReads, 2)
  assert.ok(read.calls.some(call => call.path.endsWith('/reviews/77/dismissals') && call.method === 'PUT'))
  assert.ok(!read.calls.some(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST'))
})

test('preserves both scoring and retraction diagnostics when dismissal fails', async () => {
  const read = publicationApi({ reviews: [publisherReview('APPROVED', 77)] })
  let reviewReads = 0
  const api = async (path, options = {}) => {
    if (path.includes('/reviews?')) {
      reviewReads++
      if (reviewReads === 1) throw new Error('scoring failed')
    }
    if (path.endsWith('/reviews/77/dismissals') && options.method === 'PUT') {
      throw new Error('dismissal rejected')
    }
    return read.api(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    api,
    write: () => {},
  }), (error) => {
    assert.match(error.message, /scoring failed/u)
    assert.match(error.message, /dismissal rejected/u)
    return true
  })
})

test('does not retract a nonowned or unmarked approval', async () => {
  const read = publicationApi({ reviews: [
    { ...publisherReview('APPROVED', 77), user: accountUser('reviewer') },
    { ...publisherReview('APPROVED', 78), body: 'manual machine review' },
  ] })
  let reviewReads = 0
  const api = async (path, options) => {
    if (path.includes('/reviews?')) {
      reviewReads++
      if (reviewReads === 1) throw new Error('scoring unavailable')
    }
    return read.api(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    api,
    write: () => {},
  }), /scoring unavailable/u)
  assert.equal(reviewReads, 2)
  assert.ok(!read.calls.some(call => call.path.endsWith('/dismissals')))
})

test('does not retract when the publisher identity is unverified', async () => {
  const { api, calls } = publicationApi({ reviews: [publisherReview('APPROVED', 77)] })
  const unverified = async (path, options) => {
    if (path === '/user') return { id: 1, login: 'other' }
    return api(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    api: unverified,
    write: () => {},
  }), /not the @deepseek-ai-harness machine user/u)
  assert.ok(!calls.some(call => call.path.includes('/reviews?')))
  assert.ok(!calls.some(call => call.path.endsWith('/dismissals')))
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
  const { api, calls } = publicationApi({ reviews: [
    { ...publisherReview('APPROVED', 77), body: 'manual machine review' },
    publisherReview('APPROVED', 78),
    review('writer', 'APPROVED'),
  ] })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    api,
    write: () => {},
  })
  assert.equal(result.points, 1)
  assert.ok(calls.some(call => call.path.endsWith('/reviews/78/dismissals')))
  assert.ok(!calls.some(call => call.path.endsWith('/reviews/77/dismissals')))
})

test('publishes an approval for the current head after an older approval', async () => {
  const { api, calls } = publicationApi({
    reviews: [publisherReview('APPROVED', 200, OLD_SHA), review('turtle2099', 'APPROVED')],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    api,
    write: () => {},
  })
  assert.equal(result.state, 'success')
  const approval = calls.find(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST')
  assert.equal(approval?.body.commit_id, HEAD_SHA)
})

test('rejects an approval response for another commit, state, or reviewer', async () => {
  for (const submittedReview of [
    { id: 200, state: 'APPROVED', commit_id: OLD_SHA, user: accountUser(PUBLISHER.login) },
    { id: 200, state: 'CHANGES_REQUESTED', commit_id: HEAD_SHA, user: accountUser(PUBLISHER.login) },
    { id: 200, state: 'APPROVED', commit_id: HEAD_SHA, user: accountUser('other-reviewer') },
    { id: 200, state: 'APPROVED', commit_id: HEAD_SHA },
  ]) {
    const { api } = publicationApi({ reviews: [review('turtle2099', 'APPROVED')], submittedReview })
    await assert.rejects(runApprovalCheck({
      event: pullRequestEvent(),
      policySource,
      getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
      api,
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
    const { api, calls } = publicationApi({ reviews: [review('turtle2099', 'APPROVED')], ...current })
    await assert.rejects(runApprovalCheck({
      event: pullRequestEvent(),
      policySource,
      getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
      api,
      write: () => {},
    }), /closed, became a draft, or changed head/u)
    assert.ok(!calls.some(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST'))
  }
})

test('verifies the pinned machine user before any API write', async () => {
  for (const user of [
    { id: PUBLISHER.id, login: 'someone-else' },
    { id: 1, login: PUBLISHER.login },
    { id: String(PUBLISHER.id), login: PUBLISHER.login },
    null,
  ]) {
    const calls = []
    await assert.rejects(runApprovalCheck({
      event: pullRequestEvent(),
      policySource,
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method ?? 'GET' })
        if (path === '/user') return user
        throw new Error(`unexpected write ${path}`)
      },
      write: () => {},
    }), /not the @deepseek-ai-harness machine user/u)
    assert.deepEqual(calls, [{ path: '/user', method: 'GET' }])
  }

  const appTokenCalls = []
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    api: async (path, options = {}) => {
      appTokenCalls.push({ path, method: options.method ?? 'GET' })
      throw new Error('Resource not accessible by integration')
    },
    write: () => {},
  }), /Resource not accessible by integration/u)
  assert.deepEqual(appTokenCalls, [{ path: '/user', method: 'GET' }])
})

test('fails without publishing when production attribution fails', async () => {
  const { api, calls } = publicationApi({ reviews: [review('writer', 'APPROVED')] })
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(), policySource,
    getOwnership: async () => { throw new Error('incomplete history') },
    api, write: () => {},
  }), /incomplete history/u)
  assert.ok(calls.every(call => call.method === 'GET'))
})

test('does not publish before evaluating expensive attribution', async () => {
  const { api, calls } = publicationApi({ reviews: [review('writer', 'APPROVED')] })
  await runApprovalCheck({
    event: pullRequestEvent(), policySource, write: () => {},
    getOwnership: async () => {
      assert.ok(calls.every(call => call.method === 'GET'))
      return { totalLines: 100, reviewerLines: { writer: 25 } }
    },
    api,
  })
})

test('reuses one status comment and updates it when the score changes', async () => {
  const { api, calls } = publicationApi({
    reviews: [review('writer', 'APPROVED')],
    comments: [statusComment()],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    api,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  const update = calls.find(call => call.path.endsWith('/issues/comments/90'))
  assert.equal(update?.method, 'PATCH')
  assert.match(update.body.body, /1\/2 points/u)
  assert.match(update.body.body, /- @writer: 1 point\n/u)
  assert.match(update.body.body, /1 more approval point is required\./u)
  assert.ok(!calls.some(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST'))
})

test('does not round a pending score up to the threshold or show zero remaining', async () => {
  const { api, calls } = publicationApi({ reviews: [review('writer', 'APPROVED')] })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 1_000_000, reviewerLines: { writer: 249_941 } }),
    api,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  assert.ok(result.points < 2 && result.points > 1.999)
  assert.match(result.description, /^1\.999\/2 approval points/u)
  const created = calls.find(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST')
  assert.match(created.body.body, /Weighted approval: 1\.999\/2 points/u)
  assert.match(created.body.body, /- @writer: 1\.999 points/u)
  assert.match(created.body.body, /0\.001 more approval points are required\./u)
  assert.doesNotMatch(created.body.body, /2\/2 points/u)
  assert.doesNotMatch(created.body.body, /0 more approval/u)
})

test('creates a status comment and ignores a copied marker', async () => {
  const copied = statusComment(`${STATUS_MARKER}\nnot the approval publisher`, 91, 'reviewer')
  const { api, calls } = publicationApi({ comments: [copied] })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    api,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  const created = calls.find(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST')
  assert.match(created.body.body, /0\/2 points/u)
  assert.match(created.body.body, /2 more approval points are required/u)
  assert.ok(!calls.some(call => call.path.includes('/issues/comments/91')))
})

test('dismisses its approval when the policy no longer holds', async () => {
  const { api, calls } = publicationApi({
    reviews: [publisherReview('APPROVED', 77), review('writer', 'APPROVED')],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    api,
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  assert.equal(result.points, 1)
  const dismissal = calls.find(call => call.path.endsWith('/reviews/77/dismissals'))
  assert.equal(dismissal?.method, 'PUT')
  assert.equal(dismissal.body.event, 'DISMISS')
  assert.ok(calls.some(call => call.path.endsWith('/issues/42/comments') && call.method === 'POST'))
})

test('approves again after its previous approval was dismissed', async () => {
  const { api, calls } = publicationApi({
    reviews: [publisherReview('DISMISSED', 77), review('turtle2099', 'APPROVED')],
  })
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    api,
    write: () => {},
  })
  assert.equal(result.state, 'success')
  assert.ok(calls.some(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST'))
})

test('fails when the approval dismissal is not confirmed', async () => {
  const { api } = publicationApi({ reviews: [publisherReview('APPROVED', 77)] })
  const failing = async (path, options) => {
    if (path.endsWith('/reviews/77/dismissals')) return { id: 77, state: 'APPROVED' }
    return api(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    api: failing,
    write: () => {},
  }), /approval review dismissal was not confirmed/u)
})

test('retracts its approval and removes the comment on a draft', async () => {
  const { api, calls } = publicationApi({
    reviews: [publisherReview('APPROVED', 77)],
    comments: [statusComment()],
  })
  await runApprovalCheck({
    event: pullRequestEvent({ draft: true }),
    policySource,
    api,
    write: () => {},
  })
  assert.ok(calls.some(call => call.method === 'PUT' && call.path.endsWith('/reviews/77/dismissals')))
  assert.ok(calls.some(call => call.method === 'DELETE' && call.path.endsWith('/issues/comments/90')))
})

test('fails when the approval review cannot be submitted and keeps the status comment', async () => {
  const { api, calls } = publicationApi({
    reviews: [review('turtle2099', 'APPROVED')],
    comments: [statusComment()],
  })
  const failing = async (path, options) => {
    if (path.endsWith('/pulls/42/reviews') && options?.method === 'POST') throw new Error('review rejected')
    return api(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    api: failing,
    write: () => {},
  }), /review rejected/u)
  assert.ok(!calls.some(call => call.method === 'DELETE' && call.path.endsWith('/issues/comments/90')))
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

test('uses the read-only API for the pre-approval head check and the PAT for writes', async () => {
  const patCalls = []
  const readCalls = []
  const { api } = publicationApi({ reviews: [review('turtle2099', 'APPROVED')] })
  const readApi = async (path) => {
    readCalls.push(path)
    if (path.endsWith('/pulls/42')) return pullRequestEvent().pull_request
    throw new Error(`unexpected read API path ${path}`)
  }
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    readApi,
    api: async (path, options) => {
      patCalls.push(path)
      return api(path, options)
    },
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  })
  assert.equal(result.state, 'success')
  assert.ok(readCalls.some(path => path.endsWith('/pulls/42')))
  assert.ok(!patCalls.some(path => path.endsWith('/pulls/42')))
  assert.ok(patCalls.some(path => path.endsWith('/pulls/42/reviews')))
})

test('records author credit in the published approval', async () => {
  const { api, calls } = publicationApi({ reviews: [review('writer', 'APPROVED')] })
  const result = await runWithHistory({
    event: pullRequestEvent(), policySource,
    getMergedCount: async () => 50,
    getOwnership: async () => ({ totalLines: 80, reviewerLines: { writer: 9 } }),
    api,
    write: () => {},
  })
  assert.equal(result.state, 'success')
  const approval = calls.find(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST')
  assert.match(approval.body.body, /Author credit: 0\.55 points\./u)
})

test('publishes without dismissing delegated human reviews or requesting reviewers', async () => {
  const comments = [comment('turtle1999', '/delegate @writer')]
  const reviews = [review('turtle1999', 'APPROVED', undefined, 10), review('writer', 'APPROVED')]
  const read = delegationApi({ comments, reviews })
  const calls = []
  const result = await runWithHistory({
    event: pullRequestEvent(),
    policySource,
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
    api: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' })
      assert.ok(!path.endsWith('/dismissals'))
      assert.ok(!path.endsWith('/requested_reviewers'))
      return read(path, options)
    },
  })
  assert.equal(result.state, 'success')
  assert.equal(result.delegations.length, 1)
  assert.deepEqual(result.delegations[0].reviewIds, [10])
  assert.ok(calls.some(call => call.path.endsWith('/pulls/42/reviews') && call.method === 'POST'))
  assert.ok(calls.every(call => !['PUT', 'DELETE'].includes(call.method) || call.path.includes('/issues/')))
})

test('rejects a delegation author without an immutable account ID', async () => {
  await assert.rejects(evaluateDelegation({
    api: delegationApi({ comments: [{ user: {}, body: '/delegate @writer' }] }),
  }), /delegation author has no valid account ID/u)
})

test('manual dispatch resolves only a canonical number to the live PR', async () => {
  const event = { repository: pullRequestEvent().repository, inputs: { pull_number: '42' } }
  let calls = 0
  const resolved = await approvalEventFromWorkflowDispatch({ event, api: async path => {
    calls++
    assert.equal(path, '/repos/deepseek-harness/deepseek-harness/pulls/42')
    return pullRequestEvent().pull_request
  } })
  assert.equal(resolved.pull_request.number, 42)
  assert.equal(calls, 1)
  assert.equal(await approvalEventFromWorkflowDispatch({ event,
    api: async () => ({ ...pullRequestEvent().pull_request, state: 'closed' }) }), null)
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
      api: async () => assert.fail('invalid dispatch must not call the API'),
    }), /workflow dispatch/u)
  }
})
