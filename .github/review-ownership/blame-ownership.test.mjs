import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBlameAuthors } from './blame-ownership.mjs'

const sha = number => number.toString(16).padStart(40, '0')

test('combines commit author accounts and retains unlinked authors in the denominator', async () => {
  const result = await resolveBlameAuthors({
    totalLines: 10, commitLines: { [sha(1)]: 2, [sha(2)]: 3, [sha(3)]: 5 },
  }, 'owner/repo', async (path, { body }) => {
    assert.equal(path, '/graphql')
    assert.deepEqual(body.variables, { owner: 'owner', name: 'repo' })
    assert.equal(body.query, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${[1, 2, 3].map((number, index) => `c${index}: object(oid: "${sha(number)}") { ... on Commit { author { user { login } } } }`).join('\n')} } }`)
    return { data: { repository: {
      c0: { author: { user: { login: 'Writer' } } },
      c1: { author: { user: { login: 'writer' } } },
      c2: { author: { user: null } },
    } } }
  })
  assert.equal(result.totalLines, 10)
  assert.deepEqual({ ...result.reviewerLines }, { writer: 5 })
})

test('batches author lookup and skips zero-line changes', async () => {
  let calls = 0
  await resolveBlameAuthors({
    totalLines: 51, commitLines: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [sha(index), 1])),
  }, 'owner/repo', async (path, { body }) => {
    const offset = calls * 50
    const length = calls++ === 0 ? 50 : 1
    for (let index = 0; index < length; index++) {
      assert.ok(body.query.includes(`c${index}: object(oid: "${sha(offset + index)}") { ... on Commit { author { user { login } } } }`))
    }
    assert.equal((body.query.match(/object\(oid:/gu) ?? []).length, length)
    return { data: { repository: Object.fromEntries(Array.from({ length }, (_, index) =>
      [`c${index}`, { author: { user: null } }])) } }
  })
  assert.equal(calls, 2)
  await resolveBlameAuthors({ totalLines: 0, commitLines: {} }, 'owner/repo', async () => {
    throw new Error('empty changes must not query authors')
  })
})

test('rejects incomplete or failed author lookups rather than lowering the denominator', async () => {
  for (const response of [{ errors: [{ message: 'rate limited' }] }, { data: { repository: { c0: null } } }]) {
    await assert.rejects(resolveBlameAuthors({ totalLines: 1, commitLines: { [sha(1)]: 1 } },
      'owner/repo', async () => response), /author/u)
  }
  await assert.rejects(resolveBlameAuthors({ totalLines: 2, commitLines: { [sha(1)]: 1 } },
    'owner/repo', async () => { throw new Error('invalid counts must not reach GitHub') }), /invalid production/u)
})
