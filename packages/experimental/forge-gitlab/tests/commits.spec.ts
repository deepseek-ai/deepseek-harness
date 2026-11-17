import { describe, expect, it } from 'vitest'
import { GitLabApi } from '../src/api.ts'
import { readCommits } from '../src/commits.ts'
import { fakeGlab, merge, mrPath, output } from './fixtures.ts'

const signal = new AbortController().signal

/** Commit `n` of a merge request whose commits are numbered oldest first from 1. */
function commit(n: number): Record<string, unknown> {
  return { id: n.toString(16).padStart(40, '0'), parent_ids: n === 1 ? [] : [(n - 1).toString(16).padStart(40, '0'), 'f'.repeat(40)], title: `Commit ${n}`, author_name: n % 2 === 0 ? null : 'Lin', authored_date: `2026-11-0${(n % 9) + 1}T00:00:00Z` }
}

/** A `glab api -i` page of commits newest first, `total` in all. */
function page(total: number | null, numbers: readonly number[]): ReturnType<typeof output> {
  return output(`HTTP/1.1 200 OK\r\n${total === null ? '' : `X-Total: ${total}\r\n`}\r\n${JSON.stringify(numbers.map(commit))}`)
}

/** Commits `from` down to `to`, newest first. */
function range(from: number, to: number): number[] {
  return Array.from({ length: from - to + 1 }, (_, index) => from - index)
}

describe('GitLab commit listing', () => {
  it('lists one page oldest first', async () => {
    const glab = fakeGlab(() => page(3, range(3, 1)))
    const listed = await readCommits(new GitLabApi(glab.run), merge(6), 250, signal)
    expect(listed).toEqual({
      headSha: commit(3).id,
      commits: [1, 2, 3].map(n => ({ sha: commit(n).id, parent: n === 1 ? null : commit(n - 1).id, title: `Commit ${n}`, author: n % 2 === 0 ? null : 'Lin', authoredAt: commit(n).authored_date })),
      truncated: false,
    })
    expect(glab.calls.map(call => call.args.at(-1))).toEqual([`${mrPath(6)}/commits?per_page=100&page=1`])
  })

  it('reads the pages that hold the oldest commits when there are more than the limit', async () => {
    const glab = fakeGlab((path) => {
      const n = Number(/[?&]page=(\d+)/.exec(path)?.[1])
      return page(250, range(250 - (n - 1) * 100, Math.max(1, 250 - n * 100 + 1)))
    })
    const listed = await readCommits(new GitLabApi(glab.run), merge(6), 120, signal)
    if ('code' in listed) throw new Error(listed.message)
    expect(listed.truncated).toBe(true)
    expect(listed.headSha).toBe(commit(250).id)
    expect(listed.commits.map(entry => entry.title)).toEqual(range(120, 1).reverse().map(n => `Commit ${n}`))
    expect(glab.calls.map(call => /[?&]page=(\d+)/.exec(call.args.at(-1) ?? '')?.[1])).toEqual(['1', '2', '3'])
  })

  it('counts the first page when GitLab gives no total', async () => {
    const listed = await readCommits(new GitLabApi(fakeGlab(() => page(null, range(2, 1))).run), merge(6), 250, signal)
    expect(listed).toMatchObject({ truncated: false, commits: [{ title: 'Commit 1' }, { title: 'Commit 2' }] })
  })

  it.each([
    ['a failed first page', () => output('', 1, 'glab: (HTTP 404)'), { code: 'not-found', message: '(HTTP 404)' }],
    ['an unexpected first page', () => output('HTTP/1.1 200 OK\r\n\r\n{"x":1}'), { code: 'unavailable', message: 'unexpected GitLab response to the commit listing' }],
    ['no commits', () => page(0, []), { code: 'unavailable', message: 'merge request 6 lists no commits' }],
    ['a failed later page', (path: string) => path.endsWith('page=1') ? page(150, range(150, 51)) : output('', 1, 'glab: (HTTP 500)'), { code: 'unavailable', message: '(HTTP 500)' }],
    ['an unexpected later page', (path: string) => path.endsWith('page=1') ? page(150, range(150, 51)) : output('HTTP/1.1 200 OK\r\n\r\n{}'), { code: 'unavailable', message: 'unexpected GitLab response to the commit listing' }],
  ])('reports %s', async (_label, answer, failure) => {
    await expect(readCommits(new GitLabApi(fakeGlab(answer).run), merge(6), 250, signal)).resolves.toEqual(failure)
  })
})
