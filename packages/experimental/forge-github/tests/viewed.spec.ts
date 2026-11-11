import { describe, expect, it, vi } from 'vitest'
import type { GraphqlReader } from '../src/commits.ts'
import type { GraphqlWriter } from '../src/mutation.ts'
import { PULL_REQUEST_NODE_QUERY } from '../src/pull-request-node.ts'
import { MARK_VIEWED_MUTATION, readViewed, UNMARK_VIEWED_MUTATION, VIEWED_QUERY, writeViewed } from '../src/viewed.ts'
import { pull } from './fixtures.ts'

const HEAD = 'f'.repeat(40)
const signal = new AbortController().signal

/** One files page at `head` with the viewer's marks, followed by the page after `next` when it is a cursor. */
function page(files: readonly [string, string][], options: { head?: string; total?: number; next?: string | null } = {}): unknown {
  return { data: { repository: { pullRequest: { headRefOid: options.head ?? HEAD, files: {
    totalCount: options.total ?? files.length,
    pageInfo: { hasNextPage: options.next != null, endCursor: options.next ?? null },
    nodes: files.map(([path, viewerViewedState]) => ({ path, viewerViewedState })),
  } } } } }
}

/** A reader that answers each request with the next body, recording the requests. */
function reader(...bodies: unknown[]): { read: GraphqlReader; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  return {
    calls,
    read: async (args) => {
      calls.push(args)
      const body = bodies.shift()
      return body instanceof Error ? { ok: false, failure: { code: 'unavailable', message: body.message } } : { ok: true, body }
    },
  }
}

describe('viewed file reads', () => {
  it('reads the marks across pages at the requested head, mapping unknown states to unviewed', async () => {
    const { read, calls } = reader(
      page([['src/a.ts', 'VIEWED'], ['src/b.ts', 'DISMISSED']], { total: 3, next: 'files-1' }),
      page([['src/c.ts', 'LATER_STATE']], { total: 3 }),
    )
    await expect(readViewed(read, pull(7), HEAD.toUpperCase(), 3_000, signal)).resolves.toEqual({
      headSha: HEAD, files: { 'src/a.ts': 'viewed', 'src/b.ts': 'dismissed', 'src/c.ts': 'unviewed' }, truncated: false,
    })
    expect(calls[0]).toEqual(['api', 'graphql', '--hostname', 'github.com', '-f', `query=${VIEWED_QUERY}`, '-f', 'owner=octo', '-f', 'name=demo',
      '-F', 'number=7', '-F', 'first=100'])
    expect(calls[1]?.slice(-2)).toEqual(['-f', 'cursor=files-1'])
  })

  it('keeps paths that name object properties, such as __proto__ and constructor, with their own states', async () => {
    const { read } = reader(page([['__proto__', 'VIEWED'], ['constructor', 'UNVIEWED'], ['toString', 'constructor']], { total: 3 }))
    const result = await readViewed(read, pull(7), HEAD, 3_000, signal)
    if ('code' in result) throw new Error(result.message)
    expect(Object.entries(result.files)).toEqual([['__proto__', 'viewed'], ['constructor', 'unviewed'], ['toString', 'unviewed']])
  })

  it('stops at the limit and reports the rest as truncated', async () => {
    const { read, calls } = reader(page([['src/a.ts', 'VIEWED'], ['src/b.ts', 'UNVIEWED']], { total: 5, next: 'files-1' }))
    await expect(readViewed(read, pull(7), HEAD, 2, signal)).resolves.toEqual({
      headSha: HEAD, files: { 'src/a.ts': 'viewed', 'src/b.ts': 'unviewed' }, truncated: true,
    })
    expect(calls[0]?.at(-1)).toBe('first=2')
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['a head that moved', [page([], { head: 'e'.repeat(40) })], { code: 'stale', message: `the pull request head moved from ${HEAD} to ${'e'.repeat(40)}` }],
    ['a head that moved on a later page', [page([['a', 'VIEWED']], { next: 'files-1' }), page([], { head: 'e'.repeat(40) })], { code: 'stale' }],
    ['a refused read', [new Error('rate limited')], { code: 'unavailable', message: 'rate limited' }],
    ['an unexpected response', [{ data: {} }], { code: 'unavailable', message: 'unexpected GitHub response to the viewed file read' }],
    ['a missing pull request', [{ data: { repository: { pullRequest: null } } }], { code: 'not-found', message: 'pull request 7 was not found' }],
    ['a missing repository', [{ data: { repository: null } }], { code: 'not-found' }],
    ['files GitHub cannot list', [{ data: { repository: { pullRequest: { headRefOid: HEAD, files: null } } } }],
      { code: 'unavailable', message: 'GitHub did not list the pull request files' }],
    ['a page without a cursor', [page([['a', 'VIEWED']], { next: null, total: 9 }), page([])], undefined],
    ['a repeated cursor', [page([['a', 'VIEWED']], { next: 'files-1' }), page([['b', 'VIEWED']], { next: 'files-1' })],
      { code: 'unavailable', message: 'GitHub file pagination did not advance' }],
  ] as const)('refuses %s', async (_label, bodies, failure) => {
    const result = await readViewed(reader(...bodies).read, pull(7), HEAD, 3_000, signal)
    if (failure === undefined) expect(result).toMatchObject({ truncated: true })
    else expect(result).toMatchObject(failure)
  })

  it('reports a next page without a cursor as pagination that did not advance', async () => {
    const body = page([['a', 'VIEWED']], { total: 9 }) as { data: { repository: { pullRequest: { files: { pageInfo: object } } } } }
    body.data.repository.pullRequest.files.pageInfo = { hasNextPage: true, endCursor: null }
    await expect(readViewed(reader(body).read, pull(7), HEAD, 3_000, signal))
      .resolves.toEqual({ code: 'unavailable', message: 'GitHub file pagination did not advance' })
  })

  it('refuses a head that is not a full commit object name before reading', async () => {
    const { read, calls } = reader()
    await expect(readViewed(read, pull(7), 'main', 3_000, signal)).rejects.toThrow('forge-github: invalid head commit "main"')
    expect(calls).toEqual([])
  })
})

describe('viewed file writes', () => {
  const node = { data: { repository: { pullRequest: { id: 'PR_7', headRefOid: HEAD } } } }

  it.each([
    [true, MARK_VIEWED_MUTATION, 'markFileAsViewed'],
    [false, UNMARK_VIEWED_MUTATION, 'unmarkFileAsViewed'],
  ])('confirms the head, then sends the mutation for viewed %s with the node id and path as variables', async (viewed, query, field) => {
    const { read, calls } = reader(node)
    const write = vi.fn<GraphqlWriter>(async () => undefined)
    await expect(writeViewed(read, write, pull(7), { path: 'src/a b.ts', viewed, headSha: HEAD }, signal)).resolves.toBeUndefined()
    expect(calls[0]).toContain(`query=${PULL_REQUEST_NODE_QUERY}`)
    expect(write).toHaveBeenCalledWith('github.com', { query, field, variables: { id: 'PR_7', path: 'src/a b.ts' } }, signal)
  })

  it('refuses to write once the head moved, and passes a refused write on', async () => {
    const write = vi.fn<GraphqlWriter>(async () => ({ code: 'failed', message: 'Resource not accessible' }))
    const moved = { data: { repository: { pullRequest: { id: 'PR_7', headRefOid: 'e'.repeat(40) } } } }
    await expect(writeViewed(reader(moved).read, write, pull(7), { path: 'a', viewed: true, headSha: HEAD }, signal))
      .resolves.toMatchObject({ code: 'stale' })
    expect(write).not.toHaveBeenCalled()
    await expect(writeViewed(reader(node).read, write, pull(7), { path: 'a', viewed: true, headSha: HEAD }, signal))
      .resolves.toEqual({ code: 'failed', message: 'Resource not accessible' })
  })

  it('refuses a head that is not a full commit object name before reading', async () => {
    const { read, calls } = reader()
    await expect(writeViewed(read, vi.fn(), pull(7), { path: 'a', viewed: true, headSha: 'main' }, signal))
      .rejects.toThrow('forge-github: invalid head commit "main"')
    expect(calls).toEqual([])
  })
})
