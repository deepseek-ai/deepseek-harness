import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  approvalEventFromWorkflowRun,
  approvalEventFromComment,
  approvalEventFromPullRequest,
  createGitHubApi,
  effectiveReviewDecisions,
  evaluateApproval as evaluateWithHistory,
  listPullRequestReviews,
  parseApprovalPolicy,
  runApprovalCheck as runWithHistory,
  publishApprovalPhase,
} from './check-approval.mjs'

const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')
const withoutComments = api => (path, options) => path.includes('/comments?') ? [] : api(path, options)
const evaluateApproval = options => evaluateWithHistory({ getMergedCount: async () => 0, ...options, api: withoutComments(options.api) })
const runApprovalCheck = options => runWithHistory({ getMergedCount: async () => 0, ...options, api: withoutComments(options.api) })
const HEAD_SHA = '1234567890abcdef1234567890abcdef12345678'

const pullRequestEvent = ({ author = 'author', draft = false } = {}) => ({
  repository: { full_name: 'deepseek-harness/deepseek-harness' },
  pull_request: {
    number: 42,
    state: 'open',
    draft,
    user: { login: author, node_id: 'author-id' },
    head: { sha: HEAD_SHA },
  },
})

const review = (login, state, submitted_at = '2026-09-14T00:00:00Z', id = 10) => ({ user: { login }, state, submitted_at, id })

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
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
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
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
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
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
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
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
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
    description: 'Evaluating approval points.',
    target_url: 'https://github.example/actions/runs/1',
  }, {
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
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
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
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
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
  assert.equal(output[0], 'Author credit: not evaluated (reviewer points suffice).')
  assert.equal(output[1], 'Approval score: 2/2.')

  const failures = []
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
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
  assert.equal(failures[0].options.body.state, 'pending')
  assert.equal(failures[1].options.body.state, 'error')
  assert.equal(failures[1].options.body.description, 'Approval evaluation failed.')
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

for (const [ownedLines, totalLines, expectedPoints] of [[9, 100, 1.3599999999999999], [0, 100, 1], [1, 8, 1.5], [24, 100, 1.96], [1, 4, 2], [25, 100, 2], [26, 100, 2], [100, 100, 2], [0, 0, 1]]) {
  test(`scores ${ownedLines}/${totalLines} old production lines as ${expectedPoints} points`, async () => {
    let measurements = 0
    const result = await evaluateApproval({
      event: pullRequestEvent(), policySource,
      getOwnership: async () => {
        measurements++
        return { totalLines, reviewerLines: { writer: ownedLines } }
      },
      api: async path => path.includes('/reviews?')
        ? [review('Writer', 'APPROVED')]
        : { permission: 'write' },
    })
    assert.equal(result.points, expectedPoints)
    assert.equal(result.description, `${Number(expectedPoints.toFixed(3))}/2 approval points (author 0).`)
    assert.equal(result.state, expectedPoints === 2 ? 'success' : 'pending')
    assert.equal(measurements, 1)
    assert.deepEqual(result.approvals[0].ownership, { ownedLines, totalLines })
  })
}

test('does not fetch ownership when a change request blocks approval', async () => {
  let measurements = 0
  const result = await evaluateApproval({
    event: pullRequestEvent(), policySource,
    getOwnership: async () => {
      measurements++
      return { totalLines: 2, reviewerLines: { first: 1, second: 1 } }
    },
    api: async path => path.includes('/reviews?')
      ? [review('first', 'APPROVED'), review('second', 'APPROVED'), review('blocker', 'CHANGES_REQUESTED')]
      : { permission: 'write' },
  })
  assert.equal(measurements, 0)
  assert.equal(result.points, 2)
  assert.equal(result.state, 'pending')
})

test('does not fetch history when approvals already have two-point weights', async () => {
  const result = await evaluateApproval({
    event: pullRequestEvent(), policySource,
    getOwnership: async () => { throw new Error('unexpected history fetch') },
    api: async path => path.includes('/reviews?') ? [review('turtle1999', 'APPROVED')] : { permission: 'write' },
  })
  assert.equal(result.points, 2)
})

test('publishes error when production attribution fails', async () => {
  const states = []
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(), policySource, runUrl: 'https://github.example/run/1',
    getOwnership: async () => { throw new Error('incomplete history') },
    api: async (path, options) => {
      if (path.includes('/reviews?')) return [review('writer', 'APPROVED')]
      if (path.includes('/permission')) return { permission: 'write' }
      if (path.includes('/comments?')) return []
      states.push(options.body.state)
      return {}
    },
  }), /incomplete history/u)
  assert.deepEqual(states, ['pending', 'error'])
})


test('revokes a previous success before starting expensive attribution', async () => {
  const states = []
  await runApprovalCheck({
    event: pullRequestEvent(), policySource, runUrl: 'https://github.example/run/1', write: () => {},
    getOwnership: async () => {
      assert.deepEqual(states, ['pending'])
      return { totalLines: 100, reviewerLines: { writer: 25 } }
    },
    api: async (path, options) => {
      if (path.includes('/reviews?')) return [review('writer', 'APPROVED')]
      if (path.includes('/permission')) return { permission: 'write' }
      states.push(options.body.state)
      return {}
    },
  })
  assert.deepEqual(states, ['pending', 'success'])
})

for (const reviewers of [['first', 'second'], ['turtle1999', 'first']]) {
  test(`does not fetch ownership for sufficient approvals: ${reviewers}`, async () => {
    const result = await evaluateApproval({
      event: pullRequestEvent(), policySource,
      getOwnership: async () => { throw new Error('unnecessary lookup') },
      api: async path => path.includes('/reviews?')
        ? reviewers.map(login => review(login, 'APPROVED')) : { permission: 'write' },
    })
    assert.equal(result.state, 'success')
  })
}

test('uses policy endpoints and formats only the displayed score', async () => {
  const result = await evaluateApproval({
    event: pullRequestEvent(),
    policySource: JSON.stringify({ requiredPoints: 5, defaultPoints: 2, reviewerPoints: {} }),
    getOwnership: async () => ({ totalLines: 100, reviewerLines: { writer: 9 } }),
    api: async path => path.includes('/reviews?') ? [review('writer', 'APPROVED')] : { permission: 'write' },
  })
  assert.equal(result.points, 3.08)
  assert.equal(result.description, '3.08/5 approval points (author 0).')
})

test('publishes setup phases without evaluating or installing dependencies', async () => {
  const states = []
  const options = {
    event: pullRequestEvent(), runUrl: 'https://github.example/run/1',
    api: async (path, { body }) => { assert.match(path, /\/statuses\//u); states.push(body.state) },
  }
  await publishApprovalPhase({ ...options, phase: 'pending' })
  await publishApprovalPhase({ ...options, phase: 'error' })
  assert.deepEqual(states, ['pending', 'error'])
  await assert.rejects(publishApprovalPhase({ ...options, phase: 'success' }), /invalid approval setup phase/u)
})

for (const [mergedCount, credit] of [[0, 0], [1, 0.011], [50, 0.55], [99, 1.089], [100, 1.1], [101, 1.1], [200, 1.1]]) {
  test(`author with ${mergedCount} merged PRs contributes ${credit} points but cannot approve alone`, async () => {
    const result = await evaluateApproval({
      event: pullRequestEvent(), policySource, getMergedCount: async () => mergedCount,
      api: async path => path.includes('/reviews?') ? [review('author', 'APPROVED')] : { permission: 'write' },
    })
    assert.equal(result.points, credit)
    assert.equal(result.authorCredit.points, credit)
    assert.equal(result.state, 'pending')
    assert.deepEqual(result.approvals, [])
  })
}

test('combines author credit and reviewer ownership at the passing threshold', async () => {
  for (let mergedCount = 0; mergedCount <= 90; mergedCount++) {
    const result = await evaluateApproval({
      event: pullRequestEvent(), policySource, getMergedCount: async () => mergedCount,
      getOwnership: async () => ({ totalLines: 1000000, reviewerLines: { writer: 250000 - 2750 * mergedCount } }),
      api: async path => path.includes('/reviews?') ? [review('writer', 'APPROVED')] : { permission: 'write' },
    })
    assert.equal(result.state, 'success', `author merged ${mergedCount}`)
  }
})

for (const [mergedCount, state] of [[90, 'pending'], [91, 'success'], [100, 'success']]) {
  test(`one ordinary approval with ${mergedCount} merged PRs is ${state}`, async () => {
    const result = await evaluateApproval({
      event: pullRequestEvent(), policySource, getMergedCount: async () => mergedCount,
      getOwnership: async () => {
        assert.equal(mergedCount, 90, 'sufficient author credit must skip ownership lookup')
        return { totalLines: 0, reviewerLines: {} }
      },
      api: async path => path.includes('/reviews?') ? [review('writer', 'APPROVED')] : { permission: 'write' },
    })
    assert.equal(result.state, state)
    assert.equal(result.approvals[0].points, 1)
  })
}

test('blockers skip history and ignore non-write reviewers', async () => {
  const result = await evaluateApproval({
    event: pullRequestEvent(), policySource, getMergedCount: async () => { throw new Error('blockers must skip history') },
    getOwnership: async () => { throw new Error('blockers must skip blame') },
    api: async path => path.includes('/reviews?')
      ? [review('writer', 'APPROVED'), review('blocker', 'CHANGES_REQUESTED'), review('reader', 'APPROVED')]
      : { permission: path.includes('/reader/') ? 'read' : 'write' },
  })
  assert.equal(result.state, 'pending')
  assert.equal(result.points, 1)
  assert.equal(result.authorCredit, null)
  assert.deepEqual(result.blockers, ['blocker'])
  assert.deepEqual(result.ignoredReviewers, ['reader'])
})

test('drafts skip history and history failures revoke success with error', async () => {
  await evaluateApproval({
    event: pullRequestEvent({ draft: true }), policySource,
    getMergedCount: async () => { throw new Error('draft must skip history') },
  })
  const states = []
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(), policySource, runUrl: 'https://github.example/run/1',
    getMergedCount: async () => { throw new Error('history unavailable') },
    api: async (path, options) => {
      if (path.includes('/reviews?')) return []
      states.push(options.body.state)
    },
  }), /history unavailable/u)
  assert.deepEqual(states, ['pending', 'error'])
})


test('a score just below the threshold remains pending even if its display rounds to two', async () => {
  const result = await evaluateApproval({
    event: pullRequestEvent(), policySource, getMergedCount: async () => 50,
    getOwnership: async () => ({ totalLines: 1000000, reviewerLines: { writer: 112499 } }),
    api: async path => path.includes('/reviews?') ? [review('writer', 'APPROVED')] : { permission: 'write' },
  })
  assert.equal(result.state, 'pending')
  assert.ok(result.points < 2)
})

test('the publisher counts merged history through the production API path', async () => {
  const event = pullRequestEvent()
  const states = []
  const output = []
  const result = await runWithHistory({
    event, policySource, runUrl: 'https://github.example/run/1', write: line => output.push(line),
    getOwnership: async () => ({ totalLines: 80, reviewerLines: { writer: 9 } }),
    api: async (path, options) => {
      if (path.includes('/comments?')) return []
      if (path === '/graphql') {
        assert.equal(options.body.variables.owner, 'deepseek-harness')
        return { data: { repository: { pullRequests: {
          nodes: Array.from({ length: 25 }, (_, i) => ({
            number: i + (options.body.variables.after ? 200 : 100), author: { id: event.pull_request.user.node_id },
          })),
          pageInfo: { hasNextPage: !options.body.variables.after, endCursor: 'next' },
        } } } }
      }
      if (path.includes('/reviews?')) return [review('writer', 'APPROVED')]
      if (path.includes('/permission')) return { permission: 'write' }
      states.push(options.body.state)
      return {}
    },
  })
  assert.equal(result.points, 2)
  assert.equal(result.authorCredit.points, 0.55)
  assert.equal(result.approvals[0].points, 1.45)
  assert.deepEqual(states, ['pending', 'success'])
  assert.equal(output[0], 'Author credit: 0.55 (50 merged PRs).')
})

test('sufficient reviewer points and drafts publish without querying author history', async () => {
  for (const draft of [false, true]) {
    const output = []
    const result = await runWithHistory({
      event: pullRequestEvent({ draft }), policySource, runUrl: 'https://github.example/run/1',
      write: line => output.push(line),
      api: async path => {
        assert.notEqual(path, '/graphql')
        if (path.includes('/reviews?')) return [review('turtle2099', 'APPROVED')]
        if (path.includes('/permission')) return { permission: 'write' }
        if (path.includes('/comments?')) return []
        return {}
      },
    })
    assert.equal(result.state, draft ? 'pending' : 'success')
    assert.equal(result.authorCredit, null)
    assert.equal(output[0], `Author credit: not evaluated (${draft ? 'draft' : 'reviewer points suffice'}).`)
  }
})

test('rejects missing author node IDs before calling APIs even for drafts', async () => {
  for (const nodeId of [undefined, '', 123]) {
    const event = pullRequestEvent({ draft: true })
    event.pull_request.user.node_id = nodeId
    await assert.rejects(evaluateWithHistory({
      event, policySource, api: async () => assert.fail('invalid events must not call GitHub'),
    }), /account ID/u)
  }
})

test('bot authors receive the same history credit', async () => {
  const event = pullRequestEvent({ author: 'dependabot[bot]' })
  event.pull_request.user.type = 'Bot'
  const result = await evaluateApproval({
    event, policySource, getMergedCount: async () => 100,
    getOwnership: async () => ({ totalLines: 10, reviewerLines: { writer: 1 } }),
    api: async path => path.includes('/reviews?') ? [review('writer', 'APPROVED')] : { permission: 'write' },
  })
  assert.equal(result.authorCredit.points, 1.1)
  assert.equal(result.state, 'success')
})

const comment = (login, body, created_at = '2026-09-15T00:00:00Z', id = 1) => ({
  user: { login, node_id: `account:${login.toLowerCase()}` }, body, created_at, id, node_id: `comment:${login}:${id}:${body}:${created_at}`,
})

function delegationApi({ comments = [], reviews = [], permissions = {} } = {}) {
  return async (path, options) => {
    if (path === '/graphql') return { data: { nodes: options.body.variables.ids.map(id => {
      const entry = comments.find(comment => comment.node_id === id)
      return { id, body: entry.body, createdAt: entry.created_at, author: { id: entry.user.node_id }, lastEditedAt: null, editor: null,
        ...entry.editorMetadata }
    }) } }
    if (path.includes('/comments?')) return comments
    if (path.includes('/reviews?')) return reviews
    const match = /\/collaborators\/([^/]+)\/permission$/u.exec(path)
    if (match) return { permission: permissions[decodeURIComponent(match[1]).toLowerCase()] ?? 'write' }
    throw new Error(`unexpected API path ${path}`)
  }
}

const evaluateDelegation = options => evaluateWithHistory({
  event: pullRequestEvent(), policySource,
  getMergedCount: async () => 0,
  getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
  ...options,
})

test('delegates the sender fixed points once after the recipient approves, retaining both blockers', async () => {
  for (const senderState of [undefined, 'APPROVED', 'CHANGES_REQUESTED']) {
    for (const recipientState of [undefined, 'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']) {
      const result = await evaluateDelegation({ api: delegationApi({
        comments: [comment('Turtle1999', '/delegate @Writer')],
        reviews: [
          ...(senderState ? [review('turtle1999', senderState)] : []),
          ...(recipientState ? [review('writer', recipientState)] : []),
        ],
      }) })
      const points = recipientState === 'APPROVED' ? 3 : 0
      assert.equal(result.points, points)
      assert.equal(result.state, points === 3 && senderState !== 'CHANGES_REQUESTED' ? 'success' : 'pending')
      assert.deepEqual(result.blockers, [
        ...(senderState === 'CHANGES_REQUESTED' ? ['turtle1999'] : []),
        ...(recipientState === 'CHANGES_REQUESTED' ? ['writer'] : []),
      ])
      if (points) assert.deepEqual(result.approvals[0], { login: senderState ? 'turtle1999' : 'Turtle1999', points: 2, delegatedTo: 'writer' })
    }
  }
})

test('uses the newest surviving command and restores previous commands after edits or deletion', async () => {
  const first = comment('turtle1999', '/delegate @writer')
  for (const [comments, points] of [
    [[first], 3],
    [[first, comment('turtle1999', '/delegate @other')], 1],
    [[first, comment('turtle1999', '/delegate @TURTLE1999')], 1],
    [[comment('turtle1999', '/delegate @other')], 1],
    [[first, comment('turtle1999', 'edited to ordinary text')], 3],
    [[], 1],
  ]) {
    const result = await evaluateDelegation({ api: delegationApi({ comments, reviews: [review('writer', 'APPROVED')] }) })
    assert.equal(result.points, points)
  }
  const restored = await evaluateDelegation({ api: delegationApi({
    comments: [first, comment('turtle1999', '/delegate @turtle1999')],
    reviews: [review('turtle1999', 'APPROVED')],
  }) })
  assert.deepEqual(restored.approvals, [{ login: 'turtle1999', points: 2 }])
})

test('commands must occupy the entire conversation comment', async () => {
  for (const body of ['> /delegate @writer', '```\n/delegate @writer\n```', '/delegate @writer extra',
    'Please /delegate @writer', '/delegate writer', '/delegate @bad_user', '/delegate @writer\n/delegate @other']) {
    const result = await evaluateDelegation({ api: delegationApi({
      comments: [comment('turtle1999', body)], reviews: [review('writer', 'APPROVED')],
    }) })
    assert.equal(result.points, 1, body)
  }
  const result = await evaluateDelegation({ api: delegationApi({
    comments: [comment('turtle1999', '\n/delegate @writer\r\n'), { user: null, body: '/delegate @writer' }],
    reviews: [review('writer', 'APPROVED')],
  }) })
  assert.equal(result.points, 3)
})

test('both delegation participants need current write access and neither may be the PR author', async () => {
  for (const [sender, target, permissions, expectedPoints] of [
    ['reader', 'writer', { reader: 'read' }, 1],
    ['turtle1999', 'writer', { turtle1999: 'none' }, 1],
    ['turtle1999', 'writer', { writer: 'read' }, 0],
    ['author', 'writer', {}, 1],
    ['turtle1999', 'author', {}, 1],
  ]) {
    const result = await evaluateDelegation({ api: delegationApi({
      comments: [comment(sender, `/delegate @${target}`)],
      reviews: [review('writer', 'APPROVED'), review('author', 'APPROVED')], permissions,
    }) })
    assert.equal(result.points, expectedPoints)
  }
  const ignoredTarget = await evaluateDelegation({ api: delegationApi({
    comments: [comment('turtle1999', '/delegate @reader')], reviews: [review('turtle1999', 'APPROVED')],
    permissions: { reader: 'read' },
  }) })
  assert.equal(ignoredTarget.points, 2)
})

test('delegated points retain the sender production ownership and transfer only one hop', async () => {
  const api = delegationApi({
    comments: [comment('owner', '/delegate @writer'), comment('writer', '/delegate @waiting')],
    reviews: [review('writer', 'APPROVED')],
  })
  const result = await evaluateDelegation({ api,
    getOwnership: async () => ({ totalLines: 8, reviewerLines: { owner: 1, writer: 7 } }),
  })
  assert.equal(result.points, 1.5)
  assert.deepEqual(result.approvals, [{ login: 'owner', points: 1.5, delegatedTo: 'writer', ownership: { ownedLines: 1, totalLines: 8 } }])
  const chain = await evaluateDelegation({ api: delegationApi({
    comments: [comment('owner', '/delegate @writer'), comment('writer', '/delegate @waiting')],
    reviews: [review('waiting', 'APPROVED')],
  }) })
  assert.deepEqual(chain.approvals.map(({ login }) => login), ['waiting', 'writer'])
})

test('cycles do not create approvals and repeated commands do not multiply points', async () => {
  const comments = [comment('one', '/delegate @two'), comment('one', '/delegate @two'), comment('two', '/delegate @one')]
  for (const reviews of [[], [review('one', 'APPROVED'), review('two', 'APPROVED')]]) {
    const result = await evaluateDelegation({ api: delegationApi({ comments, reviews }) })
    assert.equal(result.points, reviews.length)
  }
})

test('recipient dismissal revokes delegated approvals and comments do not reinstate them', async () => {
  const result = await evaluateDelegation({ api: delegationApi({
    comments: [comment('turtle1999', '/delegate @writer')],
    reviews: [review('writer', 'APPROVED'), review('writer', 'DISMISSED'), review('writer', 'COMMENTED')],
  }) })
  assert.equal(result.points, 0)
})

test('a sender submitted review takes back delegation, including comment-only and dismissed reviews', async () => {
  for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']) {
    for (const submittedAt of ['2026-09-15T00:00:00Z', '2026-09-16T00:00:00Z']) {
      const result = await evaluateDelegation({ api: delegationApi({
        comments: [comment('turtle1999', '/delegate @writer')],
        reviews: [review('writer', 'APPROVED'), review('Turtle1999', state, state === 'PENDING' ? null : submittedAt)],
      }) })
      assert.equal(result.delegations.length, state === 'PENDING' ? 1 : 0)
      assert.equal(result.points, state === 'APPROVED' || state === 'PENDING' ? 3 : 1)
      assert.equal(result.state, state === 'APPROVED' || state === 'PENDING' ? 'success' : 'pending')
      if (state === 'APPROVED') assert.equal(result.approvals.find(({ login }) => login === 'Turtle1999').delegatedTo, undefined)
    }
  }
})

test('a fresh delegation after a review works, while editing an older command does not reactivate it', async () => {
  const reviews = [review('writer', 'APPROVED'), review('turtle1999', 'COMMENTED', '2026-09-16T00:00:00Z')]
  const old = { ...comment('turtle1999', '/delegate @writer'), updated_at: '2026-09-18T00:00:00Z' }
  for (const [comments, expected] of [
    [[old], 1],
    [[old, comment('turtle1999', '/delegate @writer', '2026-09-17T00:00:00Z', 2)], 3],
  ]) {
    const result = await evaluateDelegation({ api: delegationApi({ comments, reviews }) })
    assert.equal(result.points, expected)
  }
})

test('missing command identity or review timing fails evaluation instead of preserving delegation', async () => {
  for (const [comments, reviews, message] of [
    [[{ ...comment('turtle1999', '/delegate @writer'), id: undefined }], [], /valid ID/u],
    [[{ ...comment('turtle1999', '/delegate @writer'), created_at: 'invalid' }], [], /valid timestamp/u],
    [[comment('turtle1999', '/delegate @writer')], [review('turtle1999', 'COMMENTED', null)], /valid timestamp/u],
  ]) {
    await assert.rejects(evaluateDelegation({ api: delegationApi({ comments, reviews }) }), message)
  }
})

test('an active delegate command requests review once and preserves other requested reviewers', async () => {
  for (const action of ['created', 'edited']) {
    for (const alreadyRequested of [false, true]) {
      const requests = []
      const output = []
      const api = delegationApi({ comments: [comment('turtle1999', '/delegate @writer')] })
      const result = await runWithHistory({
        event: { ...pullRequestEvent(), issue: { number: 42, pull_request: {} }, action, comment: { id: 1 } },
        policySource, runUrl: 'https://github.example/run/1', getMergedCount: async () => 0,
        write: line => output.push(line),
        api: async (path, options) => {
          if (path.endsWith('/requested_reviewers')) {
            if (options?.method === 'POST') { requests.push(options.body); return {} }
            return { users: [{ login: 'another-reviewer' }, ...(alreadyRequested ? [{ login: 'WRITER' }] : [])], teams: [] }
          }
          if (path.includes('/statuses/')) return {}
          return api(path, options)
        },
      })
      assert.equal(result.points, 0)
      assert.deepEqual(requests, alreadyRequested ? [] : [{ reviewers: ['writer'] }])
      assert.equal(output.includes("Requested delegated reviews from @writer."), !alreadyRequested)
    }
  }
})

test('inactive commands and drafts do not request review', async () => {
  const command = comment('turtle1999', '/delegate @writer')
  for (const scenario of [
    { comments: [comment('turtle1999', '/delegate @turtle1999')] },
    { reviews: [review('turtle1999', 'COMMENTED', '2026-09-16T00:00:00Z')] },
    { permissions: { turtle1999: 'read' } },
    { permissions: { writer: 'read' } },
    { draft: true },
  ]) {
    const api = delegationApi({ comments: [command], reviews: [review('turtle1999', 'CHANGES_REQUESTED')], ...scenario })
    await runWithHistory({
      event: { ...pullRequestEvent({ draft: scenario.draft }),
        ...(scenario.event ?? { issue: { number: 42, pull_request: {} }, action: 'created', comment: { id: 1 } }),
      },
      policySource, runUrl: 'https://github.example/run/1', getMergedCount: async () => 0, write: () => {},
      api: async (path, options) => {
        assert.ok(!path.endsWith('/requested_reviewers'))
        if (path.includes('/statuses/')) return {}
        return api(path, options)
      },
    })
  }
})

test('failed review requests preserve the computed score and report the retry', async () => {
  for (const failedRead of [false, true]) {
    const statuses = []
    const api = delegationApi({ comments: [comment('turtle1999', '/delegate @writer')], reviews: [review('imccyu', 'APPROVED')] })
    const output = []
    await runWithHistory({
      event: { ...pullRequestEvent(), issue: { number: 42, pull_request: {} }, action: 'created', comment: { id: 1 } },
      policySource, runUrl: 'https://github.example/run/1', getMergedCount: async () => 0, getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }), write: line => output.push(line),
      api: async (path, options) => {
        if (path.includes('/statuses/')) { statuses.push(options.body.state); return {} }
        if (path.endsWith('/requested_reviewers')) {
          if (options?.method === 'POST') throw new Error('request rejected')
          return failedRead ? {} : { users: [] }
        }
        return api(path, options)
      },
    })
    assert.match(output.at(-1), failedRead ? /no users array/u : /request rejected/u)
    assert.match(output.at(-1), /score is unchanged.*will retry/u)
    assert.deepEqual(statuses, ['pending', 'success'])
  }
})

test('delegation dismisses only the sender old decisions and stays active across dismissal events', async () => {
  const reviews = [review('turtle1999', 'APPROVED', undefined, 10), review('turtle1999', 'CHANGES_REQUESTED', undefined, 11),
    review('turtle1999', 'COMMENTED', undefined, 12), review('turtle1999', 'PENDING', null, 13),
    review('writer', 'APPROVED', undefined, 20), review('other', 'CHANGES_REQUESTED', undefined, 21)]
  const calls = []
  const states = []
  const read = delegationApi({ comments: [comment('turtle1999', '/delegate @writer')], reviews })
  const api = async (path, options) => {
    if (path.includes('/statuses/')) { states.push(options.body.state); return {} }
    if (path.endsWith('/dismissals')) {
      calls.push(options)
      const id = Number(path.split('/').at(-2))
      const dismissed = reviews.find(review => review.id === id)
      assert.ok([10, 11].includes(id))
      dismissed.state = 'DISMISSED'
      return dismissed
    }
    if (path.endsWith('/requested_reviewers')) {
      if (options?.method === 'POST') calls.push(options)
      return { users: [] }
    }
    return read(path, options)
  }
  const result = await runWithHistory({ event: { ...pullRequestEvent(), issue: { number: 42, pull_request: {} }, action: 'created', comment: { id: 1 } },
    policySource, api, runUrl: 'https://github.example/run/1', write: () => {}, getMergedCount: async () => 0,
  })
  assert.deepEqual(calls.map(call => call.method), ['PUT', 'PUT'])
  assert.equal(calls[0].body.event, 'DISMISS')
  assert.equal(calls[0].body.message, '@turtle1999 delegated approval to @writer via /delegate.')
  assert.deepEqual(result.blockers, ['other'])
  assert.equal(result.delegations.length, 1)
  assert.deepEqual(result.delegations[0].reviewIds, [])
  assert.deepEqual(states, ['pending', 'pending'])
  reviews.find(review => review.id === 21).state = 'DISMISSED'
  for (const state of ['APPROVED', 'DISMISSED', 'COMMENTED', 'APPROVED']) {
    reviews.find(review => review.id === 20).state = state
    const next = await evaluateDelegation({ api })
    assert.equal(next.delegations.length, 1)
    assert.equal(next.state, state === 'APPROVED' ? 'success' : 'pending')
  }
  reviews.push(review('turtle1999', 'COMMENTED', '2026-09-16T00:00:00Z', 30))
  const reclaimed = await evaluateDelegation({ api })
  assert.deepEqual(reclaimed.delegations, [])
  assert.equal(reclaimed.points, 1)
})

test('a new sender review arriving during dismissal is not dismissed or delegated', async () => {
  const reviews = [review('turtle1999', 'CHANGES_REQUESTED')]
  const read = delegationApi({ comments: [comment('turtle1999', '/delegate @writer')], reviews })
  const result = await runWithHistory({ event: { ...pullRequestEvent(), issue: { number: 42, pull_request: {} }, action: 'created', comment: { id: 1 } },
    policySource, runUrl: 'https://github.example/run/1', write: () => {}, getMergedCount: async () => 0,
    api: async (path, options) => {
      if (path.includes('/statuses/')) return {}
      if (path.endsWith('/dismissals')) {
        assert.ok(path.endsWith('/reviews/10/dismissals'))
        reviews[0].state = 'DISMISSED'
        reviews.push(review('turtle1999', 'CHANGES_REQUESTED', '2026-09-16T00:00:00Z', 11))
        return reviews[0]
      }
      assert.ok(!path.endsWith('/requested_reviewers'))
      return read(path, options)
    },
  })
  assert.deepEqual(result.delegations, [])
  assert.deepEqual(result.blockers, ['turtle1999'])
})

test('a failed or unconfirmed dismissal prevents review requests and publishes error', async () => {
  for (const rejected of [false, true]) {
    const states = []
    const read = delegationApi({ comments: [comment('turtle1999', '/delegate @writer')], reviews: [review('turtle1999', 'CHANGES_REQUESTED')] })
    await assert.rejects(runWithHistory({ event: { ...pullRequestEvent(), issue: { number: 42, pull_request: {} }, action: 'created', comment: { id: 1 } },
      policySource, runUrl: 'https://github.example/run/1', write: () => {},
      api: async (path, options) => {
        if (path.includes('/statuses/')) { states.push(options.body.state); return {} }
        if (path.endsWith('/dismissals')) {
          if (rejected) throw new Error('dismissal denied')
          return { id: 10, state: 'CHANGES_REQUESTED' }
        }
        assert.ok(!path.endsWith('/requested_reviewers'))
        return read(path, options)
      },
    }), rejected ? /dismissal denied/u : /dismissal was not confirmed/u)
    assert.deepEqual(states, ['pending', 'error'])
  }
})

test('reads all comment pages, logs the score owner, and fails closed on missing comment history', async () => {
  const statuses = []
  const output = []
  const pageCommand = comment('turtle1999', '/delegate @writer')
  const api = delegationApi({ comments: [pageCommand], reviews: [review('writer', 'APPROVED')] })
  const run = comments => runWithHistory({
    event: pullRequestEvent(), policySource, runUrl: 'https://github.example/run/1',
    getMergedCount: async () => 0, write: line => output.push(line),
    api: async (path, options) => {
      if (path.includes('/statuses/')) { statuses.push(options.body.state); return {} }
      if (path.includes('/comments?')) return comments(path)
      return api(path, options)
    },
  })
  const pages = []
  await run(path => {
    pages.push(path)
    return path.endsWith('page=1') ? Array.from({ length: 100 }, () => comment('writer', 'text'))
      : [pageCommand]
  })
  assert.equal(pages.length, 2)
  assert.ok(output.includes('- @turtle1999: 2 (delegated to @writer)'))
  assert.deepEqual(statuses.splice(0), ['pending', 'success'])
  for (const [comments, message] of [
    [() => { throw new Error('comment API unavailable') }, /comment API unavailable/u],
    [() => ({}), /comments response is not an array/u],
    [() => [null], /comment is not an object/u],
    [() => [{ user: { login: 'writer' } }], /comment has no body/u],
    [() => [{ user: {}, body: '/delegate @writer' }], /delegation author has an invalid login/u],
    [() => Array.from({ length: 100 }, () => comment('writer', 'text')), /comments exceed 3000/u],
  ]) {
    await assert.rejects(run(comments), message)
    assert.deepEqual(statuses.splice(0), ['pending', 'error'])
  }
})

test('comment events resolve the live PR head and skip ordinary issues and closed PRs', async () => {
  const event = { repository: pullRequestEvent().repository, issue: { number: 42, pull_request: {} } }
  const pull = { ...pullRequestEvent().pull_request, state: 'open' }
  const resolved = await approvalEventFromComment({ event, api: async path => {
    assert.equal(path, '/repos/deepseek-harness/deepseek-harness/pulls/42')
    return pull
  } })
  assert.deepEqual(resolved.pull_request, pull)
  assert.equal(await approvalEventFromComment({ event: { ...event, issue: { number: 42 } },
    api: async () => assert.fail('ordinary issues must not fetch a PR'),
  }), null)
  assert.equal(await approvalEventFromComment({ event, api: async () => ({ ...pull, state: 'closed' }) }), null)
  for (const number of [0, -1, '42', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(approvalEventFromComment({ event: { ...event, issue: { ...event.issue, number } },
      api: async () => assert.fail('invalid number must not call GitHub'),
    }), /valid pull-request number/u)
  }
  for (const response of [null, { ...pull, number: 1 }, { ...pull, state: 'unknown' }, { ...pull, head: {} }]) {
    await assert.rejects(approvalEventFromComment({ event, api: async () => response }))
  }
})

test('only the author can authorize a command edit, on every event reconstruction', async () => {
  for (const editor of [{ id: 'account:attacker' }, null, { id: 'account:turtle1999' }]) {
    const command = { ...comment('turtle1999', '/delegate @attacker'), editorMetadata: {
      lastEditedAt: '2026-09-15T01:00:00Z', editor,
    } }
    const result = await evaluateDelegation({ api: delegationApi({ comments: [command], reviews: [review('attacker', 'APPROVED')] }) })
    assert.equal(result.points, editor?.id === 'account:turtle1999' ? 3 : 1)
    assert.equal(result.delegations.length, editor?.id === 'account:turtle1999' ? 1 : 0)
  }
})

test('ineligible or third-party edited commands do not replace an earlier eligible delegation', async () => {
  for (const later of [comment('turtle1999', '/delegate @reader'), comment('turtle1999', '/delegate @author'),
    { ...comment('turtle1999', '/delegate @turtle1999'), editorMetadata: { lastEditedAt: '2026-09-15T01:00:00Z', editor: { id: 'account:attacker' } } }]) {
    const result = await evaluateDelegation({ api: delegationApi({
      comments: [comment('turtle1999', '/delegate @writer'), later],
      reviews: [review('writer', 'APPROVED')], permissions: { reader: 'read' },
    }) })
    assert.equal(result.points, 3)
    assert.equal(result.delegations[0].delegatedTo, 'writer')
  }
})

test('missing, partial, changed, or failed editor metadata prevents scoring', async () => {
  const command = comment('turtle1999', '/delegate @writer')
  const read = delegationApi({ comments: [command], reviews: [review('writer', 'APPROVED')] })
  for (const response of [null, {}, { data: { nodes: [] } }, { data: { nodes: [null] } }, { errors: [{ message: 'forbidden' }] }]) {
    await assert.rejects(evaluateDelegation({ api: (path, options) => path === '/graphql' ? response : read(path, options) }), /editor history/u)
  }
  for (const patch of [{ body: '/delegate @attacker' }, { author: { id: 'account:attacker' } }, { lastEditedAt: undefined }, { id: 'other-comment' }]) {
    await assert.rejects(evaluateDelegation({ api: delegationApi({ comments: [{ ...command, editorMetadata: patch }] }) }), /editor history/u)
  }
  await assert.rejects(evaluateDelegation({ api: (path, options) => {
    if (path === '/graphql') throw new Error('editor API unavailable')
    return read(path, options)
  } }), /editor API unavailable/u)
})

test('editor verification batches complete command history', async () => {
  const comments = Array.from({ length: 101 }, (_, index) => comment('turtle1999', '/delegate @writer', undefined, index + 1))
  const read = delegationApi({ comments })
  const batches = []
  const result = await evaluateDelegation({ api: (path, options) => {
    if (path.includes('/comments?')) return path.endsWith('page=1') ? comments.slice(0, 100) : comments.slice(100)
    if (path === '/graphql') batches.push(options.body.variables.ids.length)
    return read(path, options)
  } })
  assert.deepEqual(batches, [100, 1])
  assert.equal(result.delegations[0].commentId, 101)
})

test('later events reconcile all active delegations after a draft or replaced comment event', async () => {
  for (const action of ['ready_for_review', 'synchronize', 'submitted', 'deleted']) {
    const reviews = [review('Turtle1999', 'CHANGES_REQUESTED', undefined, 10), review('second', 'APPROVED', undefined, 11)]
    const read = delegationApi({ comments: [comment('Turtle1999', '/delegate @Writer'), comment('second', '/delegate @WRITER')], reviews })
    const effects = []
    const requested = []
    const api = async (path, options) => {
      if (path.includes('/statuses/')) return {}
      if (path.endsWith('/dismissals')) {
        const old = reviews.find(review => path.endsWith(`/reviews/${review.id}/dismissals`))
        effects.push(old.id)
        old.state = 'DISMISSED'
        return old
      }
      if (path.endsWith('/requested_reviewers')) {
        if (options?.method === 'POST') { effects.push(options.body); requested.push({ login: 'writer' }) }
        return { users: requested }
      }
      return read(path, options)
    }
    const run = draft => runWithHistory({ event: { ...pullRequestEvent({ draft }), action }, policySource, api,
      runUrl: 'https://github.example/run/1', getMergedCount: async () => 0, write: () => {},
    })
    await run(true)
    assert.deepEqual(effects, [])
    const result = await run(false)
    assert.deepEqual(effects, [10, 11, { reviewers: ['Writer'] }])
    assert.equal(result.delegations[0].login, 'Turtle1999')
    await run(false)
    assert.equal(effects.length, 3)
  }
})

test('already approved delegates need no new request', async () => {
  const read = delegationApi({ comments: [comment('turtle1999', '/delegate @writer')],
    reviews: [review('writer', 'APPROVED')],
  })
  const result = await runWithHistory({ event: pullRequestEvent(), policySource, runUrl: 'https://github.example/run/1', write: () => {},
    api: (path, options) => {
      if (path.includes('/statuses/')) return {}
      assert.ok(!path.endsWith('/requested_reviewers'))
      return read(path, options)
    },
  })
  assert.equal(result.state, 'success')
})

test('pull-request events use live state and skip closed, merged, and superseded PRs', async () => {
  const event = pullRequestEvent()
  for (const patch of [{ state: 'closed' }, { state: 'closed', merged: true, merge_commit_sha: HEAD_SHA },
    { head: { sha: 'abcdef1234567890abcdef1234567890abcdef12' } }]) {
    assert.equal(await approvalEventFromPullRequest({ event, api: async () => ({ ...event.pull_request, ...patch }) }), null)
  }
  const ready = await approvalEventFromPullRequest({ event: pullRequestEvent({ draft: true }), api: async () => event.pull_request })
  assert.equal(ready.pull_request.draft, false)
  assert.equal(await approvalEventFromWorkflowRun({ event: {
    repository: event.repository,
    workflow_run: { path: '.github/workflows/weighted-approval-review-event.yml', event: 'pull_request_review',
      conclusion: 'success', head_sha: HEAD_SHA, display_title: 'weighted-approval-review-event:42', pull_requests: [] },
  }, api: async () => ({ ...event.pull_request, state: 'closed', merged: true }) }), null)
})
