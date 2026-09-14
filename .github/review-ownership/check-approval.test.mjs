import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  approvalEventFromWorkflowRun,
  createGitHubApi,
  effectiveReviewDecisions,
  evaluateApproval,
  listPullRequestReviews,
  parseApprovalPolicy,
  runApprovalCheck,
} from './check-approval.mjs'

const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')
const HEAD_SHA = '1234567890abcdef1234567890abcdef12345678'

const pullRequestEvent = ({ author = 'author', draft = false } = {}) => ({
  repository: { full_name: 'deepseek-harness/deepseek-harness' },
  pull_request: {
    number: 42,
    draft,
    user: { login: author },
    head: { sha: HEAD_SHA },
  },
})

const review = (login, state) => ({ user: { login }, state })

test('loads the repository approval score policy', () => {
  const policy = parseApprovalPolicy(policySource)
  assert.equal(policy.requiredPoints, 2)
  assert.equal(policy.defaultPoints, 1)
  assert.deepEqual([...policy.reviewerPoints], [
    ['07akioni', 2],
    ['imccyu', 2],
    ['tianyicui', 2],
    ['tianyicui-bot', 2],
    ['turtle1999', 2],
    ['turtle2099', 2],
  ])
})

test('rejects invalid approval score policies', () => {
  for (const [source, message] of [
    ['[]', /must be an object/u],
    ['{"requiredPoints":0,"defaultPoints":1,"reviewerPoints":{}}', /requiredPoints/u],
    ['{"requiredPoints":2,"defaultPoints":0,"reviewerPoints":{}}', /defaultPoints/u],
    ['{"requiredPoints":2,"defaultPoints":1,"reviewerPoints":[]}', /reviewerPoints must be an object/u],
    ['{"requiredPoints":2,"defaultPoints":1,"reviewerPoints":{},"typo":2}', /contain only/u],
    ['{"requiredPoints":2,"defaultPoints":1,"reviewerPoints":{"bad login":2}}', /invalid login/u],
    ['{"requiredPoints":2,"defaultPoints":1,"reviewerPoints":{"User":2,"user":2}}', /duplicate/u],
    ['{"requiredPoints":2,"defaultPoints":1,"reviewerPoints":{"user":-1}}', /positive integer/u],
  ]) {
    assert.throws(() => parseApprovalPolicy(source), message)
  }
})

test('uses each reviewer current decision and clears it on dismissal', () => {
  assert.deepEqual(effectiveReviewDecisions([
    review('first', 'APPROVED'),
    review('first', 'APPROVED'),
    review('first', 'COMMENTED'),
    review('first', 'DISMISSED'),
    review('second', 'CHANGES_REQUESTED'),
    review('second', 'APPROVED'),
    review('third', 'APPROVED'),
    review('third', 'CHANGES_REQUESTED'),
    review('dismissed', 'DISMISSED'),
    { user: null, state: 'APPROVED' },
  ]), [
    { login: 'second', state: 'APPROVED' },
    { login: 'third', state: 'CHANGES_REQUESTED' },
  ])
})

test('resolves a review workflow run to the current pull request and rejects stale heads', async () => {
  const workflowRunEvent = {
    repository: { full_name: 'deepseek-harness/deepseek-harness' },
    workflow_run: {
      name: 'weighted-approval-review-event:42',
      path: '.github/workflows/weighted-approval-review-event.yml',
      event: 'pull_request_review',
      conclusion: 'success',
      head_sha: HEAD_SHA,
      display_title: 'weighted-approval-review-event:42',
      pull_requests: [],
    },
  }
  const current = await approvalEventFromWorkflowRun({
    event: workflowRunEvent,
    api: async path => {
      assert.equal(path, '/repos/deepseek-harness/deepseek-harness/pulls/42')
      return pullRequestEvent().pull_request
    },
  })
  assert.equal(current.pull_request.number, 42)

  for (const invalidRun of [
    { path: '.github/workflows/other.yml' },
    { path: undefined },
    { event: 'push' },
    { conclusion: 'failure' },
  ]) {
    await assert.rejects(approvalEventFromWorkflowRun({
      event: {
        ...workflowRunEvent,
        workflow_run: { ...workflowRunEvent.workflow_run, ...invalidRun },
      },
      api: async () => { throw new Error('invalid source must not call GitHub') },
    }), /successful weighted approval review workflow run/u)
  }

  assert.equal(await approvalEventFromWorkflowRun({
    event: workflowRunEvent,
    api: async () => ({
      ...pullRequestEvent().pull_request,
      head: { sha: 'abcdef1234567890abcdef1234567890abcdef12' },
    }),
  }), null)
  await assert.rejects(approvalEventFromWorkflowRun({
    event: {
      ...workflowRunEvent,
      workflow_run: { ...workflowRunEvent.workflow_run, display_title: '../42' },
    },
    api: async () => { throw new Error('invalid number must not call GitHub') },
  }), /valid run title/u)
})

test('fetches every pull-request review and rejects an unbounded history', async () => {
  let calls = 0
  const reviews = await listPullRequestReviews(async () => {
    calls++
    return calls === 1 ? Array.from({ length: 100 }, () => review('user', 'COMMENTED')) : []
  }, 'owner/repo', 42)
  assert.equal(reviews.length, 100)
  assert.equal(calls, 2)

  calls = 0
  await assert.rejects(listPullRequestReviews(async () => {
    calls++
    return Array.from({ length: 100 }, () => review('user', 'COMMENTED'))
  }, 'owner/repo', 42), /exceed 3000/u)
  assert.equal(calls, 30)
})

test('accepts one two-point approval from a write-capable reviewer', async () => {
  const calls = []
  const result = await evaluateApproval({
    event: pullRequestEvent(),
    policySource,
    api: async (path) => {
      calls.push(path)
      if (path.includes('/reviews?')) return [review('07akioni', 'APPROVED')]
      if (path.includes('/collaborators/07akioni/permission')) return { permission: 'write' }
      throw new Error(`unexpected API path ${path}`)
    },
  })
  assert.equal(result.state, 'success')
  assert.equal(result.points, 2)
  assert.deepEqual(result.approvals, [{ login: '07akioni', points: 2 }])
  assert.equal(calls.length, 2)
})

test('accepts two one-point approvals and ignores reviews without write access', async () => {
  const result = await evaluateApproval({
    event: pullRequestEvent(),
    policySource,
    api: async (path) => {
      if (path.includes('/reviews?')) {
        return [
          review('reader', 'APPROVED'),
          review('writer-b', 'APPROVED'),
          review('writer-a', 'APPROVED'),
        ]
      }
      if (path.includes('/collaborators/reader/permission')) return { permission: 'read' }
      if (path.includes('/collaborators/writer-a/permission')) return { permission: 'admin' }
      if (path.includes('/collaborators/writer-b/permission')) return { permission: 'write' }
      throw new Error(`unexpected API path ${path}`)
    },
  })
  assert.equal(result.state, 'success')
  assert.equal(result.points, 2)
  assert.deepEqual(result.approvals, [
    { login: 'writer-a', points: 1 },
    { login: 'writer-b', points: 1 },
  ])
  assert.deepEqual(result.ignoredReviewers, ['reader'])
})

test('keeps one one-point approval pending without failing the status', async () => {
  const result = await evaluateApproval({
    event: pullRequestEvent(),
    policySource,
    api: async (path) => {
      if (path.includes('/reviews?')) return [review('writer', 'APPROVED')]
      if (path.includes('/collaborators/writer/permission')) return { permission: 'write' }
      throw new Error(`unexpected API path ${path}`)
    },
  })
  assert.equal(result.state, 'pending')
  assert.equal(result.points, 1)
})

test('ignores a reviewer whose collaborator permission lookup returns 404', async () => {
  const api = createGitHubApi({
    token: 'secret',
    fetchImpl: async (url) => {
      if (url.includes('/reviews?')) {
        return new Response(JSON.stringify([review('former-writer', 'APPROVED')]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/collaborators/former-writer/permission')) return new Response('Not Found', { status: 404 })
      throw new Error(`unexpected API URL ${url}`)
    },
  })
  const result = await evaluateApproval({ event: pullRequestEvent(), policySource, api })
  assert.equal(result.state, 'pending')
  assert.deepEqual(result.ignoredReviewers, ['former-writer'])
})

test('keeps the status pending on a write-capable change request while ignoring the author and read-only reviewers', async () => {
  const statuses = []
  const result = await runApprovalCheck({
    event: pullRequestEvent({ author: 'author' }),
    policySource,
    runUrl: 'https://github.example/actions/runs/1',
    api: async (path, options = {}) => {
      if (path.includes('/reviews?')) {
        return [
          review('turtle1999', 'APPROVED'),
          review('blocker', 'CHANGES_REQUESTED'),
          review('reader', 'CHANGES_REQUESTED'),
          review('author', 'CHANGES_REQUESTED'),
        ]
      }
      if (path.includes('/collaborators/turtle1999/permission')) return { permission: 'admin' }
      if (path.includes('/collaborators/blocker/permission')) return { permission: 'write' }
      if (path.includes('/collaborators/reader/permission')) return { permission: 'read' }
      if (path.includes('/statuses/')) {
        statuses.push(options.body)
        return {}
      }
      throw new Error(`unexpected API path ${path}`)
    },
    write: () => {},
  })
  assert.equal(result.state, 'pending')
  assert.equal(result.description, '1 blocking change request.')
  assert.equal(result.points, 2)
  assert.deepEqual(result.blockers, ['blocker'])
  assert.deepEqual(result.ignoredReviewers, ['reader'])
  assert.deepEqual(statuses, [{
    state: 'pending',
    context: 'weighted approval',
    description: '1 blocking change request.',
    target_url: 'https://github.example/actions/runs/1',
  }])
})

test('keeps drafts pending without reading reviews', async () => {
  const result = await evaluateApproval({
    event: pullRequestEvent({ draft: true }),
    policySource,
    api: async () => { throw new Error('draft evaluation must not call GitHub') },
  })
  assert.equal(result.state, 'pending')
  assert.equal(result.points, 0)
  assert.match(result.description, /draft pull request/u)
})

test('publishes the required status and replaces stale success with error on evaluation failure', async () => {
  const calls = []
  const output = []
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    runUrl: 'https://github.example/actions/runs/1',
    api: async (path, options = {}) => {
      calls.push({ path, options })
      if (path.includes('/reviews?')) return [review('turtle2099', 'APPROVED')]
      if (path.includes('/collaborators/turtle2099/permission')) return { permission: 'write' }
      if (path.includes('/statuses/')) return {}
      throw new Error(`unexpected API path ${path}`)
    },
    write: line => output.push(line),
  })
  assert.equal(result.state, 'success')
  assert.deepEqual(calls.at(-1), {
    path: `/repos/deepseek-harness/deepseek-harness/statuses/${HEAD_SHA}`,
    options: {
      method: 'POST',
      body: {
        state: 'success',
        context: 'weighted approval',
        description: '2/2 approval points.',
        target_url: 'https://github.example/actions/runs/1',
      },
    },
  })
  assert.equal(output[0], 'Approval score: 2/2.')

  const failures = []
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    runUrl: 'https://github.example/actions/runs/2',
    api: async (path, options = {}) => {
      if (path.includes('/reviews?')) throw new Error('reviews unavailable')
      if (path.includes('/statuses/')) {
        failures.push({ path, options })
        return {}
      }
      throw new Error(`unexpected API path ${path}`)
    },
    write: () => {},
  }), /reviews unavailable/u)
  assert.equal(failures[0].options.body.state, 'error')
  assert.equal(failures[0].options.body.description, 'Approval evaluation failed.')
})

test('sends authenticated JSON and escapes an API error body', async () => {
  const requests = []
  const api = createGitHubApi({
    token: 'secret',
    apiUrl: 'https://github.example/api/v3/',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  assert.deepEqual(await api('/repos/owner/repo', { method: 'POST', body: { value: 1 } }), { ok: true })
  assert.equal(requests[0].url, 'https://github.example/api/v3/repos/owner/repo')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret')
  assert.equal(requests[0].options.body, '{"value":1}')

  const failing = createGitHubApi({
    token: 'secret',
    fetchImpl: async () => new Response('::error::untrusted\nbody', { status: 422 }),
  })
  await assert.rejects(failing('/failure'), /"::error::untrusted\\nbody"/u)
})
