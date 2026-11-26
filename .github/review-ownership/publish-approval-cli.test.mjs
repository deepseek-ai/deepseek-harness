import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { comment } from './review-fixtures.mjs'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('publish-approval.mjs', import.meta.url))

const READ_TOKEN = 'actions-app-test-token'
const REVIEW_TOKEN = 'machine-user-test-token'
const ACTIONS_BOT = { id: 41_898_282, login: 'github-actions[bot]' }
const MACHINE = { id: 359_032_549, login: 'deepseek-ai-harness' }
const HUMAN = { id: 4, login: 'turtle1999' }
const REPO = 'example/test'
const SHA = '1'.repeat(40)
const MARKER = '<!-- weighted-approval -->'

const humanReview = (state = 'APPROVED', id = 10) => ({
  id,
  user: { ...HUMAN },
  state,
  commit_id: SHA,
  submitted_at: '2026-12-01T00:00:00Z',
})
const machineReview = (state = 'APPROVED', id = 200) => ({
  id,
  user: { ...MACHINE },
  state,
  commit_id: SHA,
  submitted_at: '2026-12-01T00:00:00Z',
  body: `${MARKER}\nWeighted approval satisfied.`,
})

const pageOf = (url, records) => {
  const perPage = Number(url.searchParams.get('per_page') ?? 100)
  const page = Number(url.searchParams.get('page') ?? 1)
  return records.slice((page - 1) * perPage, page * perPage)
}

// The stub owns two credentials with disjoint route permissions: the workflow token reads the
// repository and maintains the status comment, and the machine PAT identifies itself and writes
// reviews. A request on the other role's route, or with no recognized token, is rejected.
async function startStub(t, initialState = {}) {
  const state = {
    pull: {
      number: 7,
      state: 'open',
      draft: false,
      head: { sha: SHA },
      user: { login: 'turtle2099', node_id: 'author-node' },
    },
    reviews: [],
    comments: [],
    permissions: {},
    identity: { ...MACHINE },
    denyCommentWrite: false,
    denyDismissal: false,
    ...initialState,
  }
  const requests = []
  let nextId = 1000
  const readBody = async req => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname.replace(`/repos/${REPO}`, '')
    const method = req.method
    const authorization = req.headers.authorization
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
    const role = token === READ_TOKEN ? 'read' : token === REVIEW_TOKEN ? 'review' : 'anonymous'
    const raw = await readBody(req)
    const body = raw ? JSON.parse(raw) : undefined
    requests.push({ role, method, path, body })
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(value === undefined ? '' : JSON.stringify(value))
    }
    const forbidden = () => send(403, { message: 'Resource not accessible by integration' })
    if (role === 'anonymous') return send(401, { message: 'Bad credentials' })

    if (role === 'read') {
      if (method === 'GET' && path === '/pulls/7') return send(200, state.pull)
      if (method === 'GET' && path === '/pulls/7/reviews') return send(200, pageOf(url, state.reviews))
      if (method === 'GET' && path === '/issues/7/comments') return send(200, pageOf(url, state.comments))
      const permission = /^\/collaborators\/([^/]+)\/permission$/u.exec(path)
      if (method === 'GET' && permission) {
        return send(200, { permission: state.permissions[decodeURIComponent(permission[1]).toLowerCase()] ?? 'write' })
      }
      if (method === 'POST' && path === '/graphql') {
        if ((body?.variables?.ids ?? []).length > 0) {
          const nodes = body.variables.ids.map(id => {
            const entry = state.comments.find(record => record.node_id === id)
            return entry === undefined ? null : {
              id, body: entry.body, createdAt: entry.created_at,
              author: { id: entry.user.node_id }, lastEditedAt: null, editor: null,
            }
          })
          return send(200, { data: { nodes } })
        }
        return send(200, {
          data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
        })
      }
      if (method === 'POST' && path === '/issues/7/comments') {
        if (state.denyCommentWrite) return forbidden()
        const record = {
          id: nextId++, user: { ...ACTIONS_BOT }, body: body.body, created_at: '2026-12-01T00:00:00Z',
        }
        state.comments.push(record)
        return send(201, record)
      }
      const commentEdit = /^\/issues\/comments\/([0-9]+)$/u.exec(path)
      if (commentEdit && method === 'PATCH') {
        const record = state.comments.find(entry => entry.id === Number(commentEdit[1]))
        if (!record) return send(404, { message: 'Not Found' })
        record.body = body.body
        return send(200, record)
      }
      if (commentEdit && method === 'DELETE') {
        const index = state.comments.findIndex(entry => entry.id === Number(commentEdit[1]))
        if (index < 0) return send(404, { message: 'Not Found' })
        state.comments.splice(index, 1)
        res.writeHead(204)
        res.end()
        return
      }
      return forbidden()
    }

    if (method === 'GET' && path === '/user') return send(200, state.identity)
    if (method === 'POST' && path === '/pulls/7/reviews') {
      const record = {
        id: nextId++, user: { ...state.identity }, state: 'APPROVED', commit_id: body.commit_id,
        submitted_at: '2026-12-01T00:00:00Z', body: body.body,
      }
      state.reviews.push(record)
      return send(201, record)
    }
    const dismissal = /^\/pulls\/7\/reviews\/([0-9]+)\/dismissals$/u.exec(path)
    if (dismissal && method === 'PUT') {
      if (state.denyDismissal) return forbidden()
      const record = state.reviews.find(entry => entry.id === Number(dismissal[1]))
      if (!record) return send(404, { message: 'Not Found' })
      record.state = 'DISMISSED'
      return send(200, record)
    }
    return forbidden()
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject))
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  return {
    state,
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    requestsFor: role => requests.filter(entry => entry.role === role),
  }
}

function eventFor(stub, route) {
  const pull = { ...stub.state.pull }
  const repository = { full_name: REPO }
  if (route === 'pull_request_target') {
    return { repository, action: 'synchronize', pull_request: pull }
  }
  if (route === 'issue_comment') {
    return {
      repository,
      action: 'created',
      issue: { number: 7, pull_request: {}, state: 'open' },
      comment: { id: 55, body: '/delegate @writer' },
    }
  }
  if (route === 'workflow_run') {
    return {
      repository,
      workflow_run: {
        path: '.github/workflows/weighted-approval-review-event.yml',
        event: 'pull_request_review',
        conclusion: 'success',
        head_sha: SHA,
        display_title: 'weighted-approval-review-event:7',
        pull_requests: [{ number: 7 }],
      },
    }
  }
  if (route === 'workflow_dispatch') return { repository, inputs: { pull_number: '7' } }
  throw new Error(`unknown route ${route}`)
}

async function eventDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-approval-app-read-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function runCli(stub, eventPath, overrides = {}) {
  const env = {
    PATH: process.env.PATH,
    GITHUB_API_URL: stub.url,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_TOKEN: READ_TOKEN,
    APPROVAL_TOKEN: REVIEW_TOKEN,
    DSH_APPROVAL_REVIEW_SCOPE: '7',
    ...overrides,
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key]
  }
  return exec(process.execPath, [cli], { env })
}

test('publishes the pending comment with the workflow token on every event route', async t => {
  const directory = await eventDirectory(t)
  for (const route of ['pull_request_target', 'issue_comment', 'workflow_run', 'workflow_dispatch']) {
    const stub = await startStub(t)
    const eventPath = join(directory, `${route}.json`)
    await writeFile(eventPath, JSON.stringify(eventFor(stub, route)))
    const { stdout, stderr } = await runCli(stub, eventPath)
    assert.equal(stderr, '', route)
    assert.match(stdout, /0\.2\/2/u, route)
    assert.equal(stub.state.comments.length, 1, route)
    const created = stub.state.comments[0]
    assert.equal(created.user.id, ACTIONS_BOT.id, route)
    assert.equal(created.user.login, ACTIONS_BOT.login, route)
    assert.equal(created.body.split('\n', 1)[0], MARKER, route)
    assert.match(created.body, /0\.2\/2 points/u, route)
    assert.match(created.body, /1\.8 more approval points are required/u, route)
    assert.deepEqual(stub.requestsFor('review'), [], route)
    assert.ok(!stub.requests.some(request => request.path === '/user'), route)
    assert.ok(stub.requests.every(request => request.role === 'read'), route)
    assert.ok(stub.requests.every(request => request.method === 'GET'
      || (request.method === 'POST' && request.path === '/issues/7/comments')
      || request.path === '/graphql'), route)
    assert.ok(stub.requests.some(request => request.method === 'POST' && request.path === '/issues/7/comments'), route)
  }
})

test('keeps the machine PAT for review writes and the workflow token for the comment lifecycle', async t => {
  const directory = await eventDirectory(t)
  const stub = await startStub(t)
  const eventPath = join(directory, 'dispatch.json')
  await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))

  await runCli(stub, eventPath)
  assert.equal(stub.state.comments.length, 1)
  assert.equal(stub.state.comments[0].user.id, ACTIONS_BOT.id)
  assert.equal(stub.state.comments[0].user.login, ACTIONS_BOT.login)
  assert.equal(stub.state.comments[0].body.split('\n', 1)[0], MARKER)
  assert.deepEqual(stub.requestsFor('review'), [])
  assert.deepEqual(stub.requestsFor('read').filter(request => request.path.includes('/comments') && request.method !== 'GET')
    .map(request => `${request.method} ${request.path}`), ['POST /issues/7/comments'])

  stub.requests.length = 0
  stub.state.reviews.push({ ...humanReview('CHANGES_REQUESTED'), id: 11, user: { id: 12, login: 'blocker' } })
  await runCli(stub, eventPath)
  assert.equal(stub.state.comments.length, 1)
  assert.match(stub.state.comments[0].body, /Blocking change requests:\n- @blocker/u)
  assert.deepEqual(stub.requests.filter(request => request.path.includes('/comments') && request.method !== 'GET')
    .map(request => `${request.role} ${request.method} ${request.path}`), [
    'read PATCH /issues/comments/1000',
  ])
  assert.deepEqual(stub.requestsFor('review'), [])
  stub.state.reviews = stub.state.reviews.filter(entry => entry.id !== 11)

  stub.requests.length = 0
  stub.state.reviews.push(humanReview())
  await runCli(stub, eventPath)
  const approval = stub.state.reviews.find(entry => entry.user.id === MACHINE.id)
  assert.equal(approval.state, 'APPROVED')
  assert.equal(approval.commit_id, SHA)
  assert.equal(approval.body.split('\n', 1)[0], MARKER)
  assert.equal(stub.state.comments.length, 0)
  assert.deepEqual(stub.requestsFor('review').map(request => `${request.method} ${request.path}`), [
    'GET /user',
    'POST /pulls/7/reviews',
  ])
  assert.deepEqual(stub.requests.filter(request => request.path.includes('/comments') && request.method !== 'GET')
    .map(request => `${request.role} ${request.method} ${request.path}`), [
    'read DELETE /issues/comments/1000',
  ])

  stub.requests.length = 0
  stub.state.reviews = stub.state.reviews.filter(entry => entry.id !== 10)
  await runCli(stub, eventPath)
  assert.equal(approval.state, 'DISMISSED')
  assert.equal(stub.state.comments.length, 1)
  assert.equal(stub.state.comments[0].user.id, ACTIONS_BOT.id)
  assert.deepEqual(stub.requestsFor('review').map(request => `${request.method} ${request.path}`), [
    'GET /user',
    'PUT /pulls/7/reviews/1001/dismissals',
  ])
  assert.deepEqual(stub.requests.filter(request => request.path.includes('/comments') && request.method !== 'GET')
    .map(request => `${request.role} ${request.method} ${request.path}`), [
    'read POST /issues/7/comments',
  ])
  assert.ok(stub.requestsFor('read').every(request => request.path !== '/user'))
  assert.ok(stub.requestsFor('review').every(request => request.path === '/user'
    || (request.method === 'POST' && request.path === '/pulls/7/reviews')
    || (request.method === 'PUT' && request.path.endsWith('/dismissals'))))
})

test('ignores Actions bot comments whose marker is not on the first line', async t => {
  const directory = await eventDirectory(t)
  const stub = await startStub(t, {
    comments: [
      {
        id: 80,
        user: { ...ACTIONS_BOT },
        body: `A maintainer posted this status earlier:\n\n${MARKER}\n## Weighted approval: 1/2 points`,
        created_at: '2026-11-30T00:00:00Z',
      },
      {
        id: 81,
        user: { ...ACTIONS_BOT },
        body: `The marker ${MARKER} appears only in quoted prose.`,
        created_at: '2026-11-30T00:00:00Z',
      },
    ],
  })
  const eventPath = join(directory, 'dispatch.json')
  await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))
  await runCli(stub, eventPath)

  const commentWrites = stub.requests.filter(request => request.path.includes('/comments') && request.method !== 'GET')
  assert.deepEqual(commentWrites.map(request => `${request.method} ${request.path}`), ['POST /issues/7/comments'])
  assert.ok(!stub.requests.some(request => request.path === '/issues/comments/80'))
  assert.ok(!stub.requests.some(request => request.path === '/issues/comments/81'))
  assert.equal(stub.state.comments.length, 3)
  assert.equal(stub.state.comments[2].body.split('\n', 1)[0], MARKER)
})

test('fails before any request when GITHUB_TOKEN is missing', async t => {
  const directory = await eventDirectory(t)
  const stub = await startStub(t)
  const eventPath = join(directory, 'dispatch.json')
  await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))
  await assert.rejects(runCli(stub, eventPath, { GITHUB_TOKEN: undefined }), /GITHUB_TOKEN is not set/u)
  assert.deepEqual(stub.requests, [])
})

test('fails before dismissing when the machine PAT is missing', async t => {
  const directory = await eventDirectory(t)
  const stub = await startStub(t, { reviews: [machineReview()] })
  const eventPath = join(directory, 'dispatch.json')
  await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))
  await assert.rejects(runCli(stub, eventPath, { APPROVAL_TOKEN: undefined }), /APPROVAL_TOKEN is not set/u)
  assert.equal(stub.state.reviews[0].state, 'APPROVED')
  assert.equal(stub.state.comments.length, 0)
  assert.deepEqual(stub.requestsFor('review'), [])
  assert.ok(stub.requests.every(request => request.method === 'GET'))
})

test('leaves the status comment untouched when the approval dismissal fails', async t => {
  const directory = await eventDirectory(t)
  const stub = await startStub(t, {
    reviews: [machineReview()],
    comments: [{ id: 90, user: { ...ACTIONS_BOT }, body: `${MARKER}\nold status`, created_at: '2026-11-30T00:00:00Z' }],
    denyDismissal: true,
  })
  const eventPath = join(directory, 'dispatch.json')
  await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))
  await assert.rejects(runCli(stub, eventPath), /returned 403/u)
  assert.equal(stub.state.reviews[0].state, 'APPROVED')
  assert.equal(stub.state.comments.length, 1)
  assert.equal(stub.state.comments[0].body, `${MARKER}\nold status`)
  assert.ok(!stub.requests.some(request => request.path.includes('/comments') && request.method !== 'GET'))
  assert.deepEqual(stub.requestsFor('review').map(request => `${request.method} ${request.path}`), [
    'GET /user',
    'PUT /pulls/7/reviews/200/dismissals',
  ])
})

test('fails before a review write when the PAT identity is wrong', async t => {
  const directory = await eventDirectory(t)
  for (const identity of [
    { ...ACTIONS_BOT },
    { id: MACHINE.id, login: 'someone-else' },
    { id: 1, login: MACHINE.login },
    null,
  ]) {
    const stub = await startStub(t, {
      reviews: [humanReview()],
      comments: [{ id: 90, user: { ...ACTIONS_BOT }, body: `${MARKER}\nold status`, created_at: '2026-11-30T00:00:00Z' }],
      identity,
    })
    const eventPath = join(directory, `dispatch-${identity?.id ?? 'null'}-${identity?.login ?? 'null'}.json`)
    await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))
    await assert.rejects(runCli(stub, eventPath), /not the @deepseek-ai-harness machine user/u)
    assert.deepEqual(stub.requestsFor('review').map(request => `${request.method} ${request.path}`), ['GET /user'])
    assert.ok(!stub.requests.some(request => request.method === 'POST' && request.path === '/pulls/7/reviews'))
    assert.ok(!stub.requests.some(request => request.method === 'DELETE' && request.path === '/issues/comments/90'))
    assert.equal(stub.state.comments.length, 1)
    assert.equal(stub.state.reviews.length, 1)
  }
})

test('fails loudly when the workflow token cannot write the status comment', async t => {
  const directory = await eventDirectory(t)
  const stub = await startStub(t, { denyCommentWrite: true })
  const eventPath = join(directory, 'dispatch.json')
  await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))
  await assert.rejects(runCli(stub, eventPath), /returned 403/u)
  assert.equal(stub.state.comments.length, 0)
  assert.deepEqual(stub.requestsFor('review'), [])
})

test('reads pull request, reviews, comments, permissions, and delegation with the workflow token', async t => {
  const directory = await eventDirectory(t)
  const delegation = comment('turtle1999', '/delegate @writer')
  const stub = await startStub(t, {
    reviews: [{ ...humanReview(), submitted_at: '2026-11-30T00:00:00Z' }],
    comments: [{ ...delegation, created_at: '2026-12-01T00:00:00Z' }],
  })
  const eventPath = join(directory, 'dispatch.json')
  await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))
  await runCli(stub, eventPath)

  const graphql = stub.requests.filter(request => request.path === '/graphql')
  assert.equal(graphql.length, 1)
  assert.equal(graphql[0].role, 'read')
  assert.deepEqual(graphql[0].body.variables.ids, [delegation.node_id])
  assert.ok(stub.requests.some(request => request.role === 'read' && request.path === '/pulls/7'))
  assert.ok(stub.requests.some(request => request.role === 'read' && request.path === '/pulls/7/reviews'))
  assert.ok(stub.requests.some(request => request.role === 'read' && request.path === '/issues/7/comments'))
  assert.ok(stub.requests.some(request => request.role === 'read' && request.path === '/collaborators/turtle1999/permission'))
  assert.ok(stub.requests.some(request => request.role === 'read' && request.path === '/collaborators/writer/permission'))
  assert.deepEqual(stub.requestsFor('review'), [])
  assert.equal(stub.state.comments.length, 2)
  assert.equal(stub.state.comments[1].user.id, ACTIONS_BOT.id)
})

test('reads merged author history with the workflow token when author credit is not fixed', async t => {
  const directory = await eventDirectory(t)
  const stub = await startStub(t, {
    pull: {
      number: 7,
      state: 'open',
      draft: false,
      head: { sha: SHA },
      user: { login: 'fresh-author', node_id: 'fresh-author-node' },
    },
  })
  const eventPath = join(directory, 'dispatch.json')
  await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))
  await runCli(stub, eventPath)

  const graphql = stub.requests.filter(request => request.path === '/graphql')
  assert.equal(graphql.length, 1)
  assert.equal(graphql[0].role, 'read')
  assert.match(graphql[0].body.query, /pullRequests\(states: MERGED/u)
  assert.deepEqual(graphql[0].body.variables, { owner: 'example', name: 'test', after: null })
  assert.equal(stub.state.comments.length, 1)
  assert.equal(stub.state.comments[0].user.id, ACTIONS_BOT.id)
  assert.match(stub.state.comments[0].body, /0\/2 points/u)
  assert.deepEqual(stub.requestsFor('review'), [])
})

test('the stub rejects each credential on the other credentials routes', async t => {
  const stub = await startStub(t)
  const call = (token, method, path, body) => fetch(`${stub.url}/repos/${REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  assert.equal((await call(READ_TOKEN, 'GET', '/pulls/7')).status, 200)
  assert.equal((await call(READ_TOKEN, 'GET', '/user')).status, 403)
  assert.equal((await call(REVIEW_TOKEN, 'GET', '/pulls/7')).status, 403)
  assert.equal((await call(READ_TOKEN, 'POST', '/pulls/7/reviews', { event: 'APPROVE', commit_id: SHA, body: MARKER })).status, 403)
  assert.equal((await call(REVIEW_TOKEN, 'POST', '/issues/7/comments', { body: MARKER })).status, 403)
  assert.equal((await call(REVIEW_TOKEN, 'GET', '/user')).status, 200)
  assert.equal((await fetch(`${stub.url}/repos/${REPO}/pulls/7`)).status, 401)
})

test('rejects a review scope that is unset, another pull request, or malformed before any write', async t => {
  const directory = await eventDirectory(t)
  for (const [label, scope, message] of [
    ['unset', undefined, /DSH_APPROVAL_REVIEW_SCOPE is not set/u],
    ['empty', '', /DSH_APPROVAL_REVIEW_SCOPE is not set/u],
    ['another pull request', '8', /selects pull request #8, not #7/u],
    ['leading zero', '07', /must be 'all' or a canonical pull-request number/u],
    ['suffix', '7x', /must be 'all' or a canonical pull-request number/u],
    ['surrounding whitespace', ' 7', /must be 'all' or a canonical pull-request number/u],
    ['uppercase all', 'ALL', /must be 'all' or a canonical pull-request number/u],
    ['unsafe integer', '99999999999999999999', /must be 'all' or a canonical pull-request number/u],
  ]) {
    const stub = await startStub(t)
    const eventPath = join(directory, `${label}.json`)
    await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))
    await assert.rejects(runCli(stub, eventPath, { DSH_APPROVAL_REVIEW_SCOPE: scope }), message, label)
    assert.equal(stub.state.comments.length, 0, label)
    assert.equal(stub.state.reviews.length, 0, label)
    assert.ok(stub.requests.every(request => request.method === 'GET'), label)
  }

  for (const scope of ['all', '7']) {
    const stub = await startStub(t)
    const eventPath = join(directory, `scope-${scope}.json`)
    await writeFile(eventPath, JSON.stringify(eventFor(stub, 'workflow_dispatch')))
    await runCli(stub, eventPath, { DSH_APPROVAL_REVIEW_SCOPE: scope })
    assert.deepEqual(stub.state.comments.map(entry => entry.user.id), [ACTIONS_BOT.id], scope)
    assert.deepEqual(stub.requestsFor('review'), [], scope)
  }
})
