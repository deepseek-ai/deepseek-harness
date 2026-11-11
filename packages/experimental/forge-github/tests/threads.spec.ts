import { describe, expect, it } from 'vitest'
import { GhOutputLimitError, type GhOutput, type GhRunner } from '../src/gh.ts'
import { GitHubProvider } from '../src/provider.ts'
import type { GitHubLimits } from '../src/provider.ts'
import { REVIEW_QUERY, REVIEW_THREADS_QUERY, THREAD_COMMENTS_QUERY } from '../src/threads.ts'
import { demo, pull } from './fixtures.ts'

const head = 'c'.repeat(40)
const older = 'a'.repeat(40)
const pushed = 'd'.repeat(40)
const signal = new AbortController().signal

function output(stdout: unknown, exitCode = 0, stderr = ''): GhOutput {
  return { exitCode, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr }
}

/** Answer each `gh` call through `handler`, recording the arguments. */
function fakeGh(handler: (args: readonly string[]) => GhOutput): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, run: async (args) => { calls.push([...args]); return handler(args) } }
}

function provider(run: GhRunner, limits: Partial<GitHubLimits> = {}): GitHubProvider {
  return new GitHubProvider(run, ['github.com'], { maxOutputBytes: 8_388_608, maxReviewThreads: 1_000, maxCommits: 250, maxViewedFiles: 3_000, ...limits })
}

function page(nodes: readonly unknown[], next: string | null = null): Record<string, unknown> {
  return { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes }
}

/** One review comment node as the thread query selects it. */
function commentNode(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, state: 'SUBMITTED', createdAt: '2026-11-05T08:00:00Z', url: `https://github.com/octo/demo/pull/7#discussion_${id}`, body: `Body of ${id}`,
    viewerCanUpdate: false, viewerCanDelete: false,
    author: { __typename: 'User', login: 'reviewer', avatarUrl: 'https://avatars.githubusercontent.com/u/1?s=48&v=4' },
    ...overrides,
  }
}

/** One review thread node on a new-side line at the head, with one comment. */
function threadNode(id: string, overrides: Record<string, unknown> = {}, root: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, isOutdated: false, isResolved: false, path: 'src/a.ts', diffSide: 'RIGHT', startDiffSide: null,
    line: 12, startLine: null, originalLine: 12, originalStartLine: null, subjectType: 'LINE',
    viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: false,
    root: { nodes: [{ diffHunk: '@@ -10,2 +10,3 @@\n a\n+b\n c', commit: { oid: head }, originalCommit: { oid: head }, ...root }] },
    comments: page([commentNode(`${id}-1`)]),
    ...overrides,
  }
}

function firstPage(
  threads: Record<string, unknown>, headRefOid = head, viewer: unknown = { login: 'octo' }, pull: Record<string, unknown> = {},
  repository: Record<string, unknown> = {},
): Record<string, unknown> {
  return { data: { viewer, repository: { isArchived: false, viewerPermission: 'READ', ...repository, pullRequest: {
    id: 'pull-7', headRefOid, locked: false, reviews: { nodes: [] }, reviewThreads: threads, ...pull,
  } } } }
}

function nextPage(threads: Record<string, unknown>, headRefOid = head): Record<string, unknown> {
  return { data: { node: { headRefOid, reviewThreads: threads } } }
}

/** Whether a scripted answer is `gh` output as printed rather than a JSON body. */
function isRaw(answer: Record<string, unknown> | { readonly raw: GhOutput }): answer is { readonly raw: GhOutput } {
  return 'raw' in answer
}

/** Answer the first thread page with `first`, later thread pages from `later` by cursor, and comment pages from `comments` by cursor. */
function review(
  first: Record<string, unknown> | { readonly raw: GhOutput },
  later: Readonly<Record<string, Record<string, unknown>>> = {},
  comments: Readonly<Record<string, Record<string, unknown>>> = {},
): ReturnType<typeof fakeGh> {
  return fakeGh((args) => {
    const cursor = args.find(arg => arg.startsWith('cursor='))?.slice('cursor='.length) ?? ''
    if (args.includes(`query=${REVIEW_QUERY}`)) return isRaw(first) ? first.raw : output(first)
    if (args.includes(`query=${REVIEW_THREADS_QUERY}`)) return output(later[cursor] ?? { data: { node: null } })
    if (args.includes(`query=${THREAD_COMMENTS_QUERY}`)) return output(comments[cursor] ?? { data: { node: null } })
    throw new Error(`unexpected gh ${args.join(' ')}`)
  })
}

describe('GitHub provider review threads', () => {
  it('reads the first page with the head, the viewer, and the pull request as variables, and maps a thread placed at the head', async () => {
    const gh = review(firstPage(page([threadNode('t1', { isResolved: true })])))

    await expect(provider(gh.run).readReview(pull(7), head, signal)).resolves.toEqual({
      headSha: head,
      viewer: 'octo',
      truncated: false,
      pendingReview: null,
      viewerCanReview: true,
      threads: [{
        id: 't1', path: 'src/a.ts', side: 'R', subject: 'line',
        current: { commit: head, startLine: 12, endLine: 12 },
        original: { commit: head, startLine: 12, endLine: 12 },
        diffHunk: '@@ -10,2 +10,3 @@\n a\n+b\n c',
        resolved: true,
        viewerCanReply: true,
        viewerCanResolve: false,
        comments: [{
          id: 't1-1', body: 'Body of t1-1', createdAt: '2026-11-05T08:00:00Z', pending: false,
          url: 'https://github.com/octo/demo/pull/7#discussion_t1-1',
          author: { login: 'reviewer', avatarUrl: 'https://avatars.githubusercontent.com/u/1?s=48&v=4', bot: false },
          viewerCanEdit: false, viewerCanDelete: false,
        }],
      }],
    })
    expect(gh.calls).toEqual([['api', 'graphql', '--hostname', 'github.com', '-f', `query=${REVIEW_QUERY}`,
      '-f', `owner=${demo.owner}`, '-f', `name=${demo.name}`, '-F', 'number=7', '-F', 'first=100']])
  })

  it('places a thread GitHub moved to the head at its current lines and keeps the lines it was written on', async () => {
    const gh = review(firstPage(page([threadNode('moved', { line: 136, originalLine: 135 }, { originalCommit: { oid: older } })])))

    const result = await provider(gh.run).readReview(pull(7), head, signal)

    expect(result).toMatchObject({ threads: [{
      current: { commit: head, startLine: 136, endLine: 136 }, original: { commit: older, startLine: 135, endLine: 135 },
    }] })
  })

  it.each([
    ['GitHub marks it outdated without a line', { isOutdated: true, line: null }, {}],
    ['GitHub marks it outdated but keeps a line', { isOutdated: true, line: 303, startLine: 294 }, {}],
    ['GitHub reports no line', { line: null }, {}],
    ['its comment is on a commit other than the head', {}, { commit: { oid: older }, originalCommit: { oid: older } }],
    ['its comment has no commit', {}, { commit: null }],
  ] as const)('gives a thread no current position when %s', async (_label, thread, root) => {
    const gh = review(firstPage(page([threadNode('old', { originalLine: 9, ...thread }, root)])))

    const result = await provider(gh.run).readReview(pull(7), head, signal)

    expect(result).toMatchObject({ threads: [{ current: null, original: { startLine: 9, endLine: 9 } }] })
  })

  it('maps a file thread without positions or hunk, an old-side range, and a range that starts on the other side', async () => {
    const gh = review(firstPage(page([
      threadNode('file', { subjectType: 'FILE', line: null, originalLine: null }, { diffHunk: '' }),
      threadNode('left', { diffSide: 'LEFT', startDiffSide: 'LEFT', startLine: 3, line: 5, originalStartLine: 3, originalLine: 5 }),
      threadNode('cross', { diffSide: 'RIGHT', startDiffSide: 'LEFT', startLine: 4, line: 6, originalStartLine: 4, originalLine: 6 }),
      threadNode('reversed', { startLine: 8, line: 6, originalStartLine: 0, originalLine: 6 }),
    ])))

    const result = await provider(gh.run).readReview(pull(7), head, signal)

    expect(result).toMatchObject({ threads: [
      { id: 'file', subject: 'file', side: 'R', current: null, original: null, diffHunk: null },
      { id: 'left', side: 'L', current: { startLine: 3, endLine: 5 }, original: { startLine: 3, endLine: 5 } },
      { id: 'cross', side: 'R', current: { startLine: 6, endLine: 6 }, original: { startLine: 6, endLine: 6 } },
      { id: 'reversed', current: { startLine: 6, endLine: 6 }, original: { startLine: 6, endLine: 6 } },
    ] })
  })

  it('maps pending comments, bots, and deleted authors, and drops a thread without comments', async () => {
    const gh = review(firstPage(page([
      threadNode('t1', { comments: page([
        commentNode('c1', { author: { __typename: 'Bot', login: 'ci', avatarUrl: null } }),
        commentNode('c2', { state: 'PENDING', author: null, url: null }),
      ]) }),
      threadNode('empty', { comments: page([]) }, { diffHunk: '' }),
    ])))

    const result = await provider(gh.run).readReview(pull(7), head, signal)

    expect(result).toMatchObject({ threads: [{ id: 't1', comments: [
      { id: 'c1', author: { login: 'ci', avatarUrl: null, bot: true }, pending: false },
      { id: 'c2', author: null, pending: true, url: null },
    ] }] })
    expect(result).toMatchObject({ threads: { length: 1 } })
  })

  it('maps the permissions of the viewer on threads and comments, resolving an unresolved thread and unresolving a resolved one', async () => {
    const gh = review(firstPage(page([
      threadNode('open', { viewerCanReply: false, viewerCanResolve: true, viewerCanUnresolve: false, comments: page([
        commentNode('mine', { viewerCanUpdate: true, viewerCanDelete: true }),
      ]) }),
      threadNode('settled', { isResolved: true, viewerCanResolve: false, viewerCanUnresolve: true }),
    ])))

    const result = await provider(gh.run).readReview(pull(7), head, signal)

    expect(result).toMatchObject({ threads: [
      { id: 'open', viewerCanReply: false, viewerCanResolve: true, comments: [{ id: 'mine', viewerCanEdit: true, viewerCanDelete: true }] },
      { id: 'settled', viewerCanReply: true, viewerCanResolve: true },
    ] })
  })

  it('reports no viewer when GitHub names none', async () => {
    const gh = review(firstPage(page([]), head, null))

    await expect(provider(gh.run).readReview(pull(7), head, signal)).resolves.toMatchObject({ viewer: null })
  })

  it('reports the pending review the viewer authored with its comment count, after another user\'s', async () => {
    const reviews = { nodes: [
      { id: 'review-other', viewerDidAuthor: false, comments: { totalCount: 5 } },
      { id: 'review-1', viewerDidAuthor: true, comments: { totalCount: 2 } },
    ] }
    const gh = review(firstPage(page([]), head, { login: 'octo' }, { reviews }))

    await expect(provider(gh.run).readReview(pull(7), head, signal))
      .resolves.toEqual(expect.objectContaining({ pendingReview: { id: 'review-1', comments: 2 } }))
  })

  it('reports no pending review for one another user authored', async () => {
    const node = { id: 'review-2', viewerDidAuthor: false, comments: { totalCount: 1 } }
    const gh = review(firstPage(page([]), head, { login: 'octo' }, { reviews: { nodes: [node] } }))

    await expect(provider(gh.run).readReview(pull(7), head, signal)).resolves.toMatchObject({ pendingReview: null })
  })

  it.each([
    ['an archived repository', {}, { isArchived: true, viewerPermission: 'ADMIN' }, false],
    ['a locked conversation without write access', { locked: true }, { viewerPermission: 'TRIAGE' }, false],
    ['a locked conversation without a known permission', { locked: true }, { viewerPermission: null }, false],
    ['a locked conversation with write access', { locked: true }, { viewerPermission: 'WRITE' }, true],
    ['an open conversation with read access', {}, { viewerPermission: 'READ' }, true],
  ] as const)('reports whether the viewer can review in %s', async (_label, pullFields, repository, expected) => {
    const gh = review(firstPage(page([]), head, { login: 'octo' }, pullFields, repository))

    await expect(provider(gh.run).readReview(pull(7), head, signal)).resolves.toMatchObject({ viewerCanReview: expected })
  })

  it('reads the following thread and comment pages, asking only for the threads left under maxReviewThreads', async () => {
    const gh = review(
      firstPage(page([threadNode('t1', { comments: page([commentNode('c1')], 'comments-1') })], 'threads-1')),
      { 'threads-1': nextPage(page([threadNode('t2')], 'threads-2')) },
      { 'comments-1': { data: { node: { comments: page([commentNode('c2')]) } } } },
    )

    const result = await provider(gh.run, { maxReviewThreads: 2 }).readReview(pull(7), head, signal)

    expect(result).toMatchObject({ truncated: true, threads: [
      { id: 't1', comments: [{ id: 'c1' }, { id: 'c2' }] }, { id: 't2' },
    ] })
    expect(gh.calls.slice(1)).toEqual([
      ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${THREAD_COMMENTS_QUERY}`, '-f', 'id=t1', '-f', 'cursor=comments-1'],
      ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${REVIEW_THREADS_QUERY}`, '-f', 'id=pull-7', '-f', 'cursor=threads-1', '-F', 'first=1'],
    ])
    expect(gh.calls[0]).toContain('first=2')
  })

  it('reports a head other than the requested commit as stale, on the first page or on a later one', async () => {
    const moved = review(firstPage(page([threadNode('t1')]), pushed))
    await expect(provider(moved.run).readReview(pull(7), head, signal))
      .resolves.toEqual({ code: 'stale', message: `the pull request head moved from ${head} to ${pushed}` })

    const later = review(firstPage(page([threadNode('t1')], 'threads-1')), { 'threads-1': nextPage(page([threadNode('t2')]), pushed) })
    await expect(provider(later.run).readReview(pull(7), head.toUpperCase(), signal))
      .resolves.toEqual({ code: 'stale', message: `the pull request head moved from ${head.toUpperCase()} to ${pushed}` })
  })

  it('keeps the threads read before a page that passes maxOutputBytes and marks the result truncated', async () => {
    const first = firstPage(page([threadNode('t1', { comments: page([commentNode('c1')], 'comments-1') })], 'threads-1'))
    const size = JSON.stringify(first).length
    const comments = { 'comments-1': { data: { node: { comments: page([commentNode('c2')]) } } } }
    const threads = { 'threads-1': nextPage(page([threadNode('t2')])) }

    const byComments = review(first, threads, comments)
    await expect(provider(byComments.run, { maxOutputBytes: size + 10 }).readReview(pull(7), head, signal))
      .resolves.toEqual({ headSha: head, viewer: 'octo', threads: [], truncated: true, pendingReview: null, viewerCanReview: true })

    const commentBytes = JSON.stringify(comments['comments-1']).length
    const byThreads = review(first, threads, comments)
    await expect(provider(byThreads.run, { maxOutputBytes: size + commentBytes + 10 }).readReview(pull(7), head, signal))
      .resolves.toMatchObject({ threads: [{ id: 't1' }], truncated: true })
  })

  it('fails a read whose first page alone passes maxOutputBytes as too-large', async () => {
    const run: GhRunner = async () => { throw new GhOutputLimitError('gh output exceeds maxOutputBytes') }

    await expect(provider(run).readReview(pull(7), head, signal)).resolves.toEqual({ code: 'too-large', message: 'gh output exceeds maxOutputBytes' })
  })

  it.each([
    ['a thread page without a cursor', firstPage({ pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] }), {}, {},
      'GitHub review thread pagination did not advance'],
    ['a thread page that repeats its cursor', firstPage(page([], 'threads-1')), { 'threads-1': nextPage(page([], 'threads-1')) }, {},
      'GitHub review thread pagination did not advance'],
    ['a comment page that repeats its cursor', firstPage(page([threadNode('t1', { comments: page([commentNode('c1')], 'comments-1') })])), {},
      { 'comments-1': { data: { node: { comments: page([], 'comments-1') } } } }, 'GitHub review comment pagination did not advance'],
    ['a comment page without a cursor', firstPage(page([threadNode('t1', { comments: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } })])),
      {}, {}, 'GitHub review comment pagination did not advance'],
    ['an unexpected first page', { data: { repository: { pullRequest: { id: 'pull-7' } } } }, {}, {}, 'unexpected GitHub response to the review thread read'],
    ['an unexpected thread page', firstPage(page([], 'threads-1')), {}, {}, 'unexpected GitHub response to the review thread read'],
    ['an unexpected comment page', firstPage(page([threadNode('t1', { comments: page([], 'comments-1') })])), {}, {},
      'unexpected GitHub response to the review thread read'],
  ] as const)('reports %s as unavailable', async (_label, first, later, comments, message) => {
    const gh = review(first, later, comments)

    await expect(provider(gh.run).readReview(pull(7), head, signal)).resolves.toEqual({ code: 'unavailable', message })
  })

  it.each([
    ['a pull request', { data: { viewer: { login: 'octo' }, repository: { isArchived: false, viewerPermission: 'READ', pullRequest: null } } }],
    ['a repository', { data: { viewer: { login: 'octo' }, repository: null } }],
  ])('reports %s GitHub does not have as not-found, as the commit listing does', async (_label, first) => {
    await expect(provider(review(first).run).readReview(pull(7), head, signal))
      .resolves.toEqual({ code: 'not-found', message: 'pull request 7 was not found' })
  })

  it('passes on the failure of any page read and of a response that is not JSON', async () => {
    const missing = review({ raw: output('', 1, 'gh: Could not resolve to a PullRequest with the number of 7.') })
    await expect(provider(missing.run).readReview(pull(7), head, signal))
      .resolves.toEqual({ code: 'not-found', message: 'gh: Could not resolve to a PullRequest with the number of 7.' })

    const garbled = review({ raw: output('not json') })
    await expect(provider(garbled.run).readReview(pull(7), head, signal)).resolves.toEqual({ code: 'unavailable', message: 'unexpected GitHub response' })

    const refused = review({ raw: output({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }) })
    await expect(provider(refused.run).readReview(pull(7), head, signal))
      .resolves.toEqual({ code: 'unavailable', message: 'Resource not accessible by integration' })

    const failing = fakeGh(args => args.includes(`query=${REVIEW_QUERY}`)
      ? output(firstPage(page([threadNode('t1', { comments: page([], 'comments-1') })], 'threads-1')))
      : output('', 1, 'gh: Server Error (HTTP 502)'))
    await expect(provider(failing.run).readReview(pull(7), head, signal)).resolves.toEqual({ code: 'unavailable', message: 'gh: Server Error (HTTP 502)' })

    const failingThreads = fakeGh(args => args.includes(`query=${REVIEW_QUERY}`)
      ? output(firstPage(page([threadNode('t1')], 'threads-1')))
      : output('', 1, 'gh: Server Error (HTTP 502)'))
    await expect(provider(failingThreads.run).readReview(pull(7), head, signal))
      .resolves.toEqual({ code: 'unavailable', message: 'gh: Server Error (HTTP 502)' })
  })

  it('refuses an unconfigured host without starting gh and a head that is not a commit object name', async () => {
    const gh = review(firstPage(page([])))
    const elsewhere = { ...demo, host: 'ghe.other.example' }

    await expect(provider(gh.run).readReview(pull(7, elsewhere), head, signal))
      .resolves.toEqual({ code: 'unavailable', message: 'forge-github: host "ghe.other.example" is not configured' })
    await expect(provider(gh.run).readReview(pull(7), 'main', signal)).rejects.toThrow('forge-github: invalid head commit "main"')
    expect(gh.calls).toEqual([])
  })
})
