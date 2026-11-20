import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('publish-approval.mjs', import.meta.url))

test('manual refresh verifies the token and reconciles a complete review lifecycle through the CLI', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-approval-pilot-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const eventPath = join(dir, 'event.json')
  const repo = 'example/test'
  await writeFile(eventPath, JSON.stringify({ repository: { full_name: repo }, inputs: { pull_number: '7' } }))
  const pat = 'machine-test-token'
  const reader = 'reader-test-token'
  const machine = { id: 359032549, login: 'deepseek-ai-harness' }
  const human = { id: 4, login: 'turtle1999' }
  const sha = '1'.repeat(40)
  const pull = { number: 7, state: 'open', draft: false, head: { sha }, user: { login: 'turtle2099', node_id: 'author-node' } }
  let identity = { ...machine, id: machine.id + 1 }
  let humanApproved = false
  let review = null
  let comment = null
  const mutations = []
  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0].replace(`/repos/${repo}`, '')
    const method = req.method
    let result
    if (method === 'GET') {
      if (path === '/user' && req.headers.authorization === `Bearer ${pat}`) result = identity
      if (path === '/pulls/7') result = pull
      if (path === '/issues/7/comments') result = comment ? [comment] : []
      if (path === '/collaborators/turtle1999/permission') result = { permission: 'write' }
      if (path === '/pulls/7/reviews') result = [
        ...(humanApproved ? [{ id: 11, user: human, state: 'APPROVED' }] : []), ...(review ? [review] : []),
      ]
    } else if (req.headers.authorization === `Bearer ${pat}`) {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const data = raw ? JSON.parse(raw) : {}
      mutations.push(`${method} ${path}`)
      if (method === 'POST' && path === '/issues/7/comments') result = comment = { ...data, user: machine, id: 12 }
      if (method === 'POST' && path === '/pulls/7/reviews' && data.event === 'APPROVE') result = review = { ...data, user: machine, id: 13, state: 'APPROVED' }
      if (method === 'DELETE' && path === '/issues/comments/12') { comment = null; result = {} }
      if (method === 'PUT' && path === '/pulls/7/reviews/13/dismissals') result = review = { ...review, state: 'DISMISSED' }
    }
    res.writeHead(result === undefined ? 400 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result ?? { message: `unexpected ${method} ${path}` }))
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const run = () => exec(process.execPath, [cli], { env: {
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_EVENT_PATH: eventPath,
    GITHUB_TOKEN: reader, APPROVAL_TOKEN: pat, DSH_APPROVAL_REVIEW_SCOPE: '7',
  } })
  await assert.rejects(run(), /not the @deepseek-ai-harness machine user/u)
  assert.deepEqual(mutations, [])
  identity = machine
  await run()
  assert.match(comment.body, /more approval points are required/u)
  assert.equal(review, null)
  humanApproved = true
  await run()
  await run()
  assert.equal(review.user.id, machine.id)
  assert.equal(review.commit_id, sha)
  assert.equal(review.state, 'APPROVED')
  assert.equal(comment, null)
  humanApproved = false
  await run()
  assert.equal(review.state, 'DISMISSED')
  assert.match(comment.body, /more approval points are required/u)
  assert.deepEqual(mutations, [
    'POST /issues/7/comments', 'POST /pulls/7/reviews', 'DELETE /issues/comments/12',
    'PUT /pulls/7/reviews/13/dismissals', 'POST /issues/7/comments',
  ])
})

test('rejects a review scope that is unset, another pull request, or malformed before any write', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-approval-scope-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const eventPath = join(dir, 'event.json')
  const repo = 'example/test'
  await writeFile(eventPath, JSON.stringify({ repository: { full_name: repo }, inputs: { pull_number: '7' } }))
  const pat = 'machine-test-token'
  const reader = 'reader-test-token'
  const machine = { id: 359032549, login: 'deepseek-ai-harness' }
  const sha = '1'.repeat(40)
  const pull = { number: 7, state: 'open', draft: false, head: { sha }, user: { login: 'turtle2099', node_id: 'author-node' } }

  const startFixture = async () => {
    let comment = null
    const mutations = []
    const server = createServer(async (req, res) => {
      const path = req.url.split('?')[0].replace(`/repos/${repo}`, '')
      const method = req.method
      let result
      if (method === 'GET') {
        if (path === '/user' && req.headers.authorization === `Bearer ${pat}`) result = machine
        if (path === '/pulls/7') result = pull
        if (path === '/pulls/7/reviews') result = []
        if (path === '/issues/7/comments') result = comment ? [comment] : []
      } else if (req.headers.authorization === `Bearer ${pat}`) {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const data = raw ? JSON.parse(raw) : {}
        mutations.push(`${method} ${path}`)
        if (method === 'POST' && path === '/issues/7/comments') result = comment = { ...data, user: machine, id: 12 }
      }
      res.writeHead(result === undefined ? 400 : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result ?? { message: `unexpected ${method} ${path}` }))
    })
    server.listen(0, '127.0.0.1')
    await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const run = (scope) => {
      const env = {
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_TOKEN: reader,
        APPROVAL_TOKEN: pat,
      }
      if (scope !== undefined) env.DSH_APPROVAL_REVIEW_SCOPE = scope
      return exec(process.execPath, [cli], { env })
    }
    return { mutations, run }
  }

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
    const { mutations, run } = await startFixture()
    await assert.rejects(run(scope), message, label)
    assert.deepEqual(mutations, [], label)
  }

  for (const scope of ['all', '7']) {
    const { mutations, run } = await startFixture()
    await run(scope)
    assert.deepEqual(mutations, ['POST /issues/7/comments'], scope)
  }
})
