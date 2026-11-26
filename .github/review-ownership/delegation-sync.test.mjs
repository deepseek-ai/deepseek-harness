import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { approvalEventFromWorkflowRun, runApprovalCheck } from './check-approval.mjs'
import { runApprovalCheck as runPilot } from './publish-approval.mjs'
import {
  ACTIONS_BOT, HEAD_SHA, PUBLISHER, STATUS_MARKER, accountUser, comment, delegationApi, pullRequestEvent,
} from './review-fixtures.mjs'

const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')
const review = (login, state, id = 10) => ({
  user: accountUser(login),
  state,
  submitted_at: '2026-09-14T00:00:00Z',
  id,
})

async function outputFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-approval-sync-'))
  const output = join(directory, 'github-output')
  const previous = process.env.GITHUB_OUTPUT
  process.env.GITHUB_OUTPUT = output
  t.after(async () => {
    if (previous === undefined) delete process.env.GITHUB_OUTPUT
    else process.env.GITHUB_OUTPUT = previous
    await rm(directory, { recursive: true, force: true })
  })
  return output
}

function approvalApi({ comments = [], reviews = [], dismiss = async () => undefined } = {}) {
  const read = delegationApi({ comments, reviews })
  const calls = []
  const api = async (path, options = {}) => {
    if (path.includes('/statuses/')) return {}
    if (path.includes('/commits/') && path.includes('/check-runs?')) return { total_count: 0, check_runs: [] }
    if (path.endsWith('/check-runs') && options.method === 'POST') return {}
    if (path.endsWith('/dismissals')) {
      calls.push(path)
      return dismiss(path, options)
    }
    if (path.endsWith('/requested_reviewers')) return { users: [] }
    return read(path, options)
  }
  return { api, calls }
}

// Records the writes each publisher makes against one shared review/comment state.
// No review event is synthesized: the called pilot receives the same issue_comment event
// that the reusable workflow passes to it after the legacy publisher completes.
// The workflow token owns reads and status comments; the machine PAT owns identity and reviews.
function statefulApprovalApis({ comments, reviews }) {
  const read = delegationApi({ comments, reviews })
  const pull = pullRequestEvent().pull_request
  const readCalls = []
  const reviewCalls = []
  let nextCommentId = 100
  let nextReviewId = 200
  const api = async (path, options = {}) => {
    if (path === '/user') return { ...PUBLISHER }
    if (path.includes('/statuses/')) return {}
    if (path.includes('/commits/') && path.includes('/check-runs?')) return { total_count: 0, check_runs: [] }
    if (path.endsWith('/check-runs') && options.method === 'POST') return {}
    if (path.endsWith('/pulls/42')) return pull
    if (path.endsWith('/pulls/42/reviews') && options.method === 'POST') {
      const review = {
        id: nextReviewId++,
        user: { ...PUBLISHER },
        state: 'APPROVED',
        commit_id: options.body.commit_id,
        submitted_at: '2026-11-20T00:00:00Z',
        body: options.body.body,
      }
      reviews.push(review)
      return review
    }
    if (path.includes('/reviews/') && path.endsWith('/dismissals')) {
      const id = Number(path.split('/').at(-2))
      const review = reviews.find(entry => entry.id === id)
      review.state = 'DISMISSED'
      return review
    }
    if (path.endsWith('/issues/42/comments') && options.method === 'POST') {
      const record = {
        id: nextCommentId++,
        user: { ...ACTIONS_BOT },
        body: options.body.body,
        created_at: '2026-11-20T00:00:00Z',
      }
      comments.push(record)
      return record
    }
    if (path.includes('/issues/comments/') && options.method === 'DELETE') {
      const id = Number(path.split('/').at(-1))
      const index = comments.findIndex(entry => entry.id === id)
      if (index >= 0) comments.splice(index, 1)
      return {}
    }
    if (path.endsWith('/requested_reviewers')) return { users: [] }
    return read(path, options)
  }
  const readApi = async (path, options = {}) => {
    const method = options.method ?? 'GET'
    readCalls.push({ path, method })
    assert.notEqual(path, '/user')
    assert.ok(!path.endsWith('/dismissals'))
    assert.ok(!(path.endsWith('/pulls/42/reviews') && method === 'POST'))
    return api(path, options)
  }
  const reviewApi = async (path, options = {}) => {
    const method = options.method ?? 'GET'
    reviewCalls.push({ path, method })
    if (path === '/user') return { ...PUBLISHER }
    if (path.endsWith('/pulls/42/reviews') && method === 'POST') return api(path, options)
    if (path.endsWith('/dismissals') && method === 'PUT') return api(path, options)
    throw new Error(`unexpected review API path ${path}`)
  }
  return { api, readApi, reviewApi, readCalls, reviewCalls }
}

const delegationEvent = () => ({
  ...pullRequestEvent(),
  issue: { number: 42, pull_request: {} },
  action: 'created',
  comment: { id: 1 },
})

test('records dismissed=true after a delegated review is dismissed', async t => {
  const output = await outputFile(t)
  const reviews = [review('turtle1999', 'APPROVED')]
  const { api, calls } = approvalApi({
    comments: [comment('turtle1999', '/delegate @writer')],
    reviews,
    dismiss: async () => {
      reviews[0].state = 'DISMISSED'
      return reviews[0]
    },
  })
  await runApprovalCheck({
    event: delegationEvent(),
    policySource,
    api,
    runUrl: 'https://github.example/run/1',
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  })
  assert.equal(calls.length, 1)
  assert.equal(readFileSync(output, 'utf8'), 'dismissed=true\n')
})

test('records dismissed=true before a failed final status write', async t => {
  const output = await outputFile(t)
  const reviews = [review('turtle1999', 'APPROVED'), review('writer', 'APPROVED', 20)]
  const { api: base } = approvalApi({
    comments: [comment('turtle1999', '/delegate @writer')],
    reviews,
    dismiss: async () => {
      reviews[0].state = 'DISMISSED'
      return reviews[0]
    },
  })
  const api = async (path, options = {}) => {
    if (path.includes('/statuses/') && options.body?.state === 'success') throw new Error('status write failed')
    return base(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: delegationEvent(),
    policySource,
    api,
    runUrl: 'https://github.example/run/1',
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  }), /status write failed/u)
  assert.equal(readFileSync(output, 'utf8'), 'dismissed=true\n')
})

test('records dismissed=true when the delegated review request fails after dismissal', async t => {
  const output = await outputFile(t)
  const reviews = [review('turtle1999', 'APPROVED')]
  const { api: base } = approvalApi({
    comments: [comment('turtle1999', '/delegate @writer')],
    reviews,
    dismiss: async () => {
      reviews[0].state = 'DISMISSED'
      return reviews[0]
    },
  })
  const api = async (path, options = {}) => {
    if (path.endsWith('/requested_reviewers') && options.method === 'POST') throw new Error('review request rejected')
    return base(path, options)
  }
  await runApprovalCheck({
    event: delegationEvent(),
    policySource,
    api,
    runUrl: 'https://github.example/run/1',
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  })
  assert.equal(readFileSync(output, 'utf8'), 'dismissed=true\n')
})

test('records dismissed=true when the re-evaluation after dismissal fails', async t => {
  const output = await outputFile(t)
  const reviews = [review('turtle1999', 'APPROVED')]
  const { api: base } = approvalApi({
    comments: [comment('turtle1999', '/delegate @writer')],
    reviews,
    dismiss: async () => {
      reviews[0].state = 'DISMISSED'
      return reviews[0]
    },
  })
  let reviewLists = 0
  const api = async (path, options = {}) => {
    if (path.includes('/reviews?')) {
      reviewLists += 1
      if (reviewLists === 2) throw new Error('re-evaluation failed')
    }
    return base(path, options)
  }
  await assert.rejects(runApprovalCheck({
    event: delegationEvent(),
    policySource,
    api,
    runUrl: 'https://github.example/run/1',
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  }), /re-evaluation failed/u)
  assert.equal(reviewLists, 2)
  assert.equal(readFileSync(output, 'utf8'), 'dismissed=true\n')
})

test('records dismissed=true once when a later delegated dismissal fails', async t => {
  const output = await outputFile(t)
  const reviews = [review('turtle1999', 'APPROVED', 10), review('turtle1999', 'CHANGES_REQUESTED', 11)]
  const dismissed = []
  const { api } = approvalApi({
    comments: [comment('turtle1999', '/delegate @writer')],
    reviews,
    dismiss: async path => {
      const id = Number(path.split('/').at(-2))
      dismissed.push(id)
      if (id === 11) throw new Error('second dismissal failed')
      const target = reviews.find(review => review.id === id)
      target.state = 'DISMISSED'
      return target
    },
  })
  await assert.rejects(runApprovalCheck({
    event: delegationEvent(),
    policySource,
    api,
    runUrl: 'https://github.example/run/1',
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  }), /second dismissal failed/u)
  assert.deepEqual(dismissed, [10, 11])
  assert.equal(readFileSync(output, 'utf8'), 'dismissed=true\n')
})

test('standalone pending, legacy dismissal, called pilot approval in one stateful trajectory', async t => {
  const output = await outputFile(t)
  const comments = [comment('turtle1999', '/delegate @writer')]
  const reviews = [
    { user: accountUser('turtle1999'), state: 'CHANGES_REQUESTED', submitted_at: '2026-09-14T00:00:00Z', id: 10 },
    { user: accountUser('writer'), state: 'APPROVED', submitted_at: '2026-09-14T00:00:00Z', id: 20 },
  ]
  const stateful = statefulApprovalApis({ comments, reviews })
  const { readApi, reviewApi, readCalls, reviewCalls } = stateful
  const event = delegationEvent()
  const options = {
    event,
    policySource,
    api: stateful.api,
    readApi,
    reviewApi,
    runUrl: 'https://github.example/run/1',
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  }

  const standalone = await runPilot(options)
  assert.equal(standalone.state, 'pending')
  assert.deepEqual(standalone.blockers, ['turtle1999'])
  assert.equal(comments.length, 2)
  assert.equal(comments[1].user.id, ACTIONS_BOT.id)
  assert.equal(comments[1].user.login, ACTIONS_BOT.login)
  assert.equal(comments[1].body.split('\n', 1)[0], STATUS_MARKER)
  assert.match(comments[1].body, /Blocking change requests/u)
  assert.equal(reviews.filter(entry => entry.user.id === PUBLISHER.id && entry.state === 'APPROVED').length, 0)

  const legacy = await runApprovalCheck({ ...options, checkApi: stateful.api, checkAppSlug: 'github-actions' })
  assert.equal(legacy.state, 'success')
  assert.deepEqual(legacy.blockers, [])
  assert.equal(reviews.find(entry => entry.id === 10).state, 'DISMISSED')
  assert.equal(readFileSync(output, 'utf8'), 'dismissed=true\n')
  assert.equal(comments.length, 2)

  // The called pilot receives the same issue_comment event, not a synthesized review event.
  const called = await runPilot(options)
  assert.equal(called.state, 'success')
  assert.equal(comments.length, 1)
  const approvals = reviews.filter(entry => entry.user.id === PUBLISHER.id && entry.state === 'APPROVED')
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].commit_id, HEAD_SHA)

  // The workflow token never identifies the machine user or writes a review; the PAT never touches
  // repository reads or the status comment.
  assert.ok(readCalls.every(call => call.path !== '/user'))
  assert.ok(readCalls.every(call => !call.path.endsWith('/dismissals')))
  assert.ok(readCalls.every(call => !(call.path.endsWith('/pulls/42/reviews') && call.method === 'POST')))
  assert.ok(reviewCalls.every(call => call.path === '/user'
    || (call.path.endsWith('/pulls/42/reviews') && call.method === 'POST')
    || (call.path.endsWith('/dismissals') && call.method === 'PUT')))
  assert.ok(reviewCalls.some(call => call.path === '/user'))
  assert.ok(reviewCalls.some(call => call.method === 'POST' && call.path.endsWith('/pulls/42/reviews')))
})

test('does not record dismissed=true without a delegated dismissal', async t => {
  const output = await outputFile(t)
  const { api, calls } = approvalApi({ reviews: [review('writer', 'APPROVED', 20), review('other', 'APPROVED', 21)] })
  await runApprovalCheck({
    event: delegationEvent(),
    policySource,
    api,
    runUrl: 'https://github.example/run/1',
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  })
  assert.deepEqual(calls, [])
  assert.equal(existsSync(output), false)
})

test('does not record dismissed=true when the dismissal fails', async t => {
  const output = await outputFile(t)
  const { api } = approvalApi({
    comments: [comment('turtle1999', '/delegate @writer')],
    reviews: [review('turtle1999', 'APPROVED')],
    dismiss: async () => {
      throw new Error('dismissal denied')
    },
  })
  await assert.rejects(runApprovalCheck({
    event: delegationEvent(),
    policySource,
    api,
    runUrl: 'https://github.example/run/1',
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  }), /dismissal denied/u)
  assert.equal(existsSync(output), false)
})

test('does not dismiss a machine-authored delegation command or review', async t => {
  const output = await outputFile(t)
  const { api, calls } = approvalApi({
    comments: [comment('deepseek-ai-harness', '/delegate @writer')],
    reviews: [review('deepseek-ai-harness', 'APPROVED')],
  })
  await runApprovalCheck({
    event: delegationEvent(),
    policySource,
    api,
    runUrl: 'https://github.example/run/1',
    getMergedCount: async () => 0,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
    write: () => {},
  })
  assert.deepEqual(calls, [])
  assert.equal(existsSync(output), false)
})

test('rejects the legacy publisher run as a review-event handoff', async () => {
  await assert.rejects(approvalEventFromWorkflowRun({
    event: {
      repository: { full_name: 'deepseek-harness/deepseek-harness' },
      workflow_run: {
        path: '.github/workflows/weighted-approval.yml',
        event: 'issue_comment',
        conclusion: 'success',
        head_sha: '1'.repeat(40),
        display_title: 'a pull request title',
        pull_requests: [],
      },
    },
    api: async () => {
      throw new Error('the legacy run must not reach the pull-request API')
    },
  }), /no successful weighted approval review workflow run/u)
})
