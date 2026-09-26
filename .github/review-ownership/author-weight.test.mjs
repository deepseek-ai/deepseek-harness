import assert from 'node:assert/strict'
import test from 'node:test'
import { countMergedAuthorPulls } from './author-weight.mjs'

const pull = { repository: 'owner/repo', number: 999, authorId: 'account-id' }
const entry = (number, id = pull.authorId) => ({ number, author: id === null ? null : { id } })
const page = (nodes, hasNextPage = false, endCursor = null) => ({
  data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } } } },
})

test('counts only the same account and excludes the current PR and deleted accounts', async () => {
  const count = await countMergedAuthorPulls(pull, async (path, { method, body }) => {
    assert.equal(path, '/graphql')
    assert.equal(method, 'POST')
    assert.deepEqual(body.variables, { owner: 'owner', name: 'repo', after: null })
    assert.match(body.query, /pullRequests\(states: MERGED, first: 100, after: \$after/u)
    assert.match(body.query, /author \{ \.\.\. on Node \{ id \} \}/u)
    return page([entry(1), entry(2, 'another-id'), entry(3, null), entry(999)])
  })
  assert.equal(count, 1)
})

test('follows cursors, deduplicates overlapping pages, and stops at 100', async () => {
  let calls = 0
  const count = await countMergedAuthorPulls(pull, async (path, { body }) => {
    calls++
    if (calls === 1) return page(Array.from({ length: 100 }, (_, i) => entry(i + 1, i < 50 ? pull.authorId : 'another-id')), true, 'next')
    assert.equal(calls, 2)
    assert.equal(body.variables.after, 'next')
    return page(Array.from({ length: 100 }, (_, i) => entry(i + 51)), true, 'unused')
  })
  assert.equal(count, 100)
  assert.equal(calls, 2)
})

test('returns zero only for a complete empty history', async () => {
  assert.equal(await countMergedAuthorPulls(pull, async () => page([])), 0)
  for (const response of [{}, { errors: [{ message: 'rate limited' }], ...page([]) },
    page([null]), page([{ number: 1 }]), page([], true, null)]) {
    await assert.rejects(countMergedAuthorPulls(pull, async () => response), /GitHub/u)
  }
  await assert.rejects(countMergedAuthorPulls(pull, async () => { throw new Error('offline') }), /offline/u)
})

test('rejects a repeated cursor instead of looping over a partial history', async () => {
  await assert.rejects(countMergedAuthorPulls(pull, async () => page([], true, 'same')), /did not advance/u)
})
