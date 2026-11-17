import type { ForgeCommentId, ForgeThreadId } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { GitLabApi } from '../src/api.ts'
import { discussionOf, draftCommentId, hunkUntil, noteOf, PERMISSIONS_QUERY, readReviewThreads } from '../src/review.ts'
import type { PositionFile, ReviewLimits } from '../src/review.ts'
import { fakeGlab, HOST, json, merge, mrPath, output, sent, sha } from './fixtures.ts'
import type { GlabOutput } from '../src/glab.ts'

const signal = new AbortController().signal
const limits: ReviewLimits = { maxReviewThreads: 1000, maxOutputBytes: 8_000_000, maxConcurrentRequests: 2 }
const HEAD = sha('a')
const OLD = sha('9')

/** A diff note position on the new side of `path` at `head`. */
function position(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    base_sha: sha('b'), start_sha: sha('b'), head_sha: HEAD, old_path: 'src/a.ts', new_path: 'src/a.ts', position_type: 'text',
    old_line: null, new_line: 12, line_range: null, ...overrides,
  }
}

/** One note, a diff note on `position` unless overridden. */
function note(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'DiffNote', body: `Note ${id}`, system: false, created_at: '2026-11-10T08:00:00Z', resolved: false,
    author: { username: 'lin', avatar_url: 'https://avatar/lin' }, position: position(), ...overrides,
  }
}

/** One discussion whose notes are given. */
function discussion(id: string, notes: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { id, notes }
}

/** One page of the permission query, which lists the signed-in user and their rights on the discussions. */
function rightsPage(overrides: {
  readonly viewer?: unknown
  readonly createNote?: boolean
  readonly reviewers?: readonly string[]
  readonly discussions?: readonly unknown[]
  readonly next?: string | null
} = {}): GlabOutput {
  return json({ data: {
    currentUser: overrides.viewer === undefined ? { username: 'octo', avatarUrl: 'https://avatar/octo' } : overrides.viewer,
    project: { mergeRequest: {
      userPermissions: { createNote: overrides.createNote ?? false },
      reviewers: { nodes: (overrides.reviewers ?? []).map(username => ({ username })) },
      discussions: {
        pageInfo: { hasNextPage: (overrides.next ?? null) !== null, endCursor: overrides.next ?? null }, nodes: overrides.discussions ?? [],
      },
    } },
  } })
}

/** The rights the permission query lists on one discussion and its notes, of which those in `admin` the user may change. */
function rightsOf(
  id: string, resolve: boolean, admin: readonly number[], resolvable = true, others: readonly number[] = [], moreNotes = false,
): unknown {
  const notes = [...admin.map(note => [note, true] as const), ...others.map(note => [note, false] as const)]
  return {
    id: `gid://gitlab/Discussion/${id}`, resolvable, userPermissions: { resolveNote: resolve },
    notes: {
      pageInfo: { hasNextPage: moreNotes },
      nodes: notes.map(([note, adminNote]) => ({ id: `gid://gitlab/DiffNote/${note}`, userPermissions: { adminNote } })),
    },
  }
}

/** Answers for discussions pages, the version listing, the permission pages, draft notes, and approvals. */
function gitlab(pages: readonly unknown[][], versions: unknown = [{ id: 2, head_commit_sha: HEAD, state: 'collected' }], answers: {
  readonly rights?: (cursor: unknown) => GlabOutput
  readonly drafts?: GlabOutput
  readonly approvals?: GlabOutput
} = {}) {
  return fakeGlab((path, call) => {
    if (path === 'graphql') return (answers.rights ?? (() => rightsPage()))(sent(call).variables.cursor)
    if (path.endsWith('/draft_notes')) return answers.drafts ?? json([])
    if (path.endsWith('/approvals')) return answers.approvals ?? json({ user_has_approved: false, user_can_approve: false })
    if (path.includes('/versions')) return json(versions)
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1])
    return json(pages[page - 1] ?? [])
  })
}

describe('GitLab review threads', () => {
  it('maps discussions on files to threads at the head and leaves out other discussions', async () => {
    const glab = gitlab([[
      discussion('d1', [note(1, { resolved: true }), note(2, { type: 'DiffNote', system: true, body: 'changed this line' }), note(3, { position: null, author: null })]),
      discussion('d2', [note(4, { type: null, position: null })]),
      discussion('d3', [note(5, { position: position({ position_type: 'image' }) })]),
      discussion('d4', []),
      discussion('d5', [note(6, { position: position({ position_type: 'file', new_line: null }) })]),
      discussion('d6', [note(7, { position: position({ old_line: 4, new_line: null, old_path: 'src/old.ts', new_path: 'src/new.ts' }) })]),
      discussion('d7', [note(8, { position: position({ old_line: 5, new_line: null, old_path: null, new_path: 'src/b.ts' }) })]),
      discussion('d8', [note(9, { position: position({ new_path: null, old_path: 'src/gone.ts' }) })]),
      discussion('d9', [note(10, { position: position({ new_path: null, old_path: null, new_line: null }) })]),
    ]])
    const filePatch = vi.fn()
    const read = await readReviewThreads(new GitLabApi(glab.run), merge(6), HEAD, limits, filePatch, signal)
    expect(read).toEqual({
      headSha: HEAD, viewer: 'octo', truncated: false, pendingReview: null, viewerCanReview: false, reviewEvents: [],
      threads: [
        {
          id: 'd1', path: 'src/a.ts', side: 'R', subject: 'line', current: { commit: HEAD, startLine: 12, endLine: 12 },
          original: { commit: HEAD, startLine: 12, endLine: 12 }, diffHunk: null, resolved: true,
          viewerCanReply: false, viewerCanResolve: false,
          comments: [
            {
              id: '1', author: { login: 'lin', avatarUrl: 'https://avatar/lin', bot: false }, body: 'Note 1', createdAt: '2026-11-10T08:00:00Z',
              pending: false, url: `https://${HOST}/group/sub/app/-/merge_requests/6#note_1`, viewerCanEdit: false, viewerCanDelete: false,
            },
            {
              id: '3', author: null, body: 'Note 3', createdAt: '2026-11-10T08:00:00Z',
              pending: false, url: `https://${HOST}/group/sub/app/-/merge_requests/6#note_3`, viewerCanEdit: false, viewerCanDelete: false,
            },
          ],
        },
        expect.objectContaining({ id: 'd5', path: 'src/a.ts', side: 'R', subject: 'file', current: null, original: null, diffHunk: null }),
        expect.objectContaining({ id: 'd6', path: 'src/old.ts', side: 'L', current: { commit: HEAD, startLine: 4, endLine: 4 } }),
        expect.objectContaining({ id: 'd7', path: 'src/b.ts', side: 'L' }),
        expect.objectContaining({ id: 'd8', path: 'src/gone.ts', side: 'R', subject: 'line' }),
        expect.objectContaining({ id: 'd9', path: '', side: 'R', subject: 'file', current: null, original: null }),
      ],
    })
    expect(filePatch).not.toHaveBeenCalled()
    expect(glab.calls.map(call => call.args.at(-1))).toEqual(expect.arrayContaining([
      `${mrPath(6)}/discussions?per_page=100&page=1`, `${mrPath(6)}/versions?per_page=100`, `${mrPath(6)}/draft_notes`, `${mrPath(6)}/approvals`,
    ]))
    expect(sent(glab.calls.find(call => call.args.includes('graphql')))).toEqual({
      query: PERMISSIONS_QUERY, variables: { path: 'group/sub/app', iid: '6', cursor: null },
    })
  })

  it('finds a range\'s first line from its length, since GitLab does not move the range with the thread', async () => {
    const range = (start: Record<string, unknown>, end: Record<string, unknown>) => ({ start, end })
    const glab = gitlab([[
      discussion('moved', [note(1, { position: position({ new_line: 20, line_range: range({ old_line: null, new_line: 9 }, { old_line: null, new_line: 14 }) }) })]),
      discussion('top', [note(2, { position: position({ new_line: 3, line_range: range({ old_line: null, new_line: 10 }, { old_line: null, new_line: 14 }) }) })]),
      discussion('mixed', [note(3, { position: position({ new_line: 8, line_range: range({ old_line: 7, new_line: null }, { old_line: null, new_line: 8 }) }) })]),
      discussion('backwards', [note(4, { position: position({ new_line: 8, line_range: range({ old_line: null, new_line: 9 }, { old_line: null, new_line: 5 }) }) })]),
      discussion('left', [note(5, { position: position({ old_line: 6, new_line: null, line_range: range({ old_line: 4, new_line: null }, { old_line: 6, new_line: null }) }) })]),
    ]])
    const read = await readReviewThreads(new GitLabApi(glab.run), merge(6), HEAD, limits, vi.fn(), signal)
    expect('threads' in read ? read.threads.map(thread => [thread.id, thread.current?.startLine, thread.current?.endLine]) : []).toEqual([
      ['moved', 15, 20], ['top', 1, 3], ['mixed', 8, 8], ['backwards', 8, 8], ['left', 4, 6],
    ])
  })

  it('gives outdated threads the hunk of the diff their position names', async () => {
    const versions = [
      { id: 3, head_commit_sha: HEAD, state: 'collected' },
      { id: 2, head_commit_sha: OLD, state: 'collected' },
      { id: 1, head_commit_sha: sha('8') },
      { id: 0, head_commit_sha: sha('7'), state: 'without_files' },
    ]
    const glab = gitlab([[
      discussion('kept', [note(1, { position: position({ head_sha: OLD, new_line: 2 }) })]),
      discussion('dropped', [note(2, { position: position({ head_sha: sha('7'), base_sha: sha('6'), new_line: 2 }) })]),
      discussion('unknown', [note(3, { position: position({ head_sha: sha('5'), new_line: 2, old_path: null }) })]),
      discussion('renamed', [note(4, { position: position({ head_sha: sha('5'), new_line: 2, new_path: null, old_path: 'src/was.ts' }) })]),
    ]], versions)
    const patch = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n'
    const files: PositionFile[] = []
    const filePatch = async (file: PositionFile): Promise<string> => { files.push(file); return patch }
    const read = await readReviewThreads(new GitLabApi(glab.run), merge(6), HEAD, limits, filePatch, signal)
    expect('threads' in read ? read.threads.map(thread => [thread.id, thread.current, thread.original?.commit, thread.diffHunk]) : []).toEqual([
      ['kept', null, OLD, '@@ -1,2 +1,2 @@\n a\n-b\n+B'],
      ['dropped', null, sha('7'), '@@ -1,2 +1,2 @@\n a\n-b\n+B'],
      ['unknown', null, sha('5'), '@@ -1,2 +1,2 @@\n a\n-b\n+B'],
      ['renamed', null, sha('5'), '@@ -1,2 +1,2 @@\n a\n-b\n+B'],
    ])
    expect(files).toEqual(expect.arrayContaining([
      { version: 2, baseSha: sha('b'), headSha: OLD, oldPath: 'src/a.ts', newPath: 'src/a.ts' },
      { version: null, baseSha: sha('6'), headSha: sha('7'), oldPath: 'src/a.ts', newPath: 'src/a.ts' },
      { version: null, baseSha: sha('b'), headSha: sha('5'), oldPath: 'src/a.ts', newPath: 'src/a.ts' },
      { version: null, baseSha: sha('b'), headSha: sha('5'), oldPath: 'src/was.ts', newPath: 'src/was.ts' },
    ]))
  })

  it('reads further pages, and stops at maxReviewThreads or at a page over maxOutputBytes', async () => {
    const full = Array.from({ length: 100 }, (_, index) => discussion(`p1-${index}`, [note(index)]))
    const second = [discussion('p2-0', [note(200)])]
    const read = await readReviewThreads(new GitLabApi(gitlab([full, second]).run), merge(6), HEAD, limits, vi.fn(), signal)
    expect(read).toMatchObject({ truncated: false })
    expect('threads' in read ? read.threads.length : 0).toBe(101)
    const capped = await readReviewThreads(new GitLabApi(gitlab([full, second]).run), merge(6), HEAD, { ...limits, maxReviewThreads: 3 },
      vi.fn(), signal)
    expect(capped).toMatchObject({ truncated: true })
    expect('threads' in capped ? capped.threads.length : 0).toBe(3)
    const bytes = Buffer.byteLength(JSON.stringify(full))
    const over = await readReviewThreads(new GitLabApi(gitlab([full, second]).run), merge(6), HEAD,
      { ...limits, maxOutputBytes: bytes + 10 }, vi.fn(), signal)
    expect(over).toMatchObject({ truncated: true })
    // The returned threads fit the limit as well as the pages read.
    const kept = 'threads' in over ? over.threads : []
    expect(kept.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(kept.map(thread => JSON.stringify(thread)).join(''))).toBeLessThanOrEqual(bytes + 10)
    await expect(readReviewThreads(new GitLabApi(gitlab([full]).run), merge(6), HEAD, { ...limits, maxOutputBytes: 10 }, vi.fn(), signal))
      .resolves.toEqual({ code: 'too-large', message: 'the discussions of merge request 6 exceed maxOutputBytes' })
  })

  it.each([
    ['moved head', [{ id: 3, head_commit_sha: sha('c') }], { code: 'stale', message: `the merge request head moved from ${HEAD} to ${sha('c')}` }],
    ['no versions', [], { code: 'stale', message: `the merge request head moved from ${HEAD} to no diff version` }],
    ['an unexpected listing', { message: 'nope' }, { code: 'unavailable', message: 'unexpected GitLab response to the discussion read' }],
  ])('reports %s after the discussions', async (_label, versions, failure) => {
    await expect(readReviewThreads(new GitLabApi(gitlab([[]], versions).run), merge(6), HEAD, limits, vi.fn(), signal))
      .resolves.toEqual(failure)
  })

  it('reports failed and unexpected reads, and reads without a viewer when GitLab names none', async () => {
    const read = async (glab: ReturnType<typeof fakeGlab>) =>
      await readReviewThreads(new GitLabApi(glab.run), merge(6), HEAD, limits, vi.fn(), signal)
    await expect(read(fakeGlab(path => path === 'graphql' ? rightsPage() : output('', 1, 'glab: (HTTP 404)'))))
      .resolves.toEqual({ code: 'not-found', message: '(HTTP 404)' })
    await expect(read(fakeGlab(path => path === 'graphql' ? rightsPage() : json({ discussions: 'nope' }))))
      .resolves.toEqual({ code: 'unavailable', message: 'unexpected GitLab response to the discussion read' })
    await expect(read(gitlab([[]], undefined, { drafts: output('', 1, 'glab: (HTTP 403)') }))).resolves.toEqual({ code: 'unavailable', message: '(HTTP 403)' })
    await expect(read(gitlab([[]], undefined, { drafts: json({ drafts: 'nope' }) })))
      .resolves.toEqual({ code: 'unavailable', message: 'unexpected GitLab response to the draft note read' })
    await expect(read(gitlab([[]], undefined, { rights: () => output('', 1, 'glab: (HTTP 404)') }))).resolves.toEqual({ code: 'not-found', message: '(HTTP 404)' })
    await expect(read(gitlab([[]], undefined, { rights: () => json({ data: { currentUser: null, project: null } }) })))
      .resolves.toEqual({ code: 'unavailable', message: 'unexpected GitLab response to the permission read' })
    await expect(read(gitlab([[]], undefined, { rights: () => json({ data: { project: 'nope' } }) })))
      .resolves.toEqual({ code: 'unavailable', message: 'unexpected GitLab response to the permission read' })
    const versionsFail = fakeGlab(path => path === 'graphql' ? rightsPage() : path.includes('/versions') ? output('', 1, 'glab: (HTTP 500)') : json([]))
    await expect(read(versionsFail)).resolves.toEqual({ code: 'unavailable', message: '(HTTP 500)' })
    await expect(read(gitlab([[]], undefined, { rights: () => rightsPage({ viewer: null }) }))).resolves.toMatchObject({ viewer: null })
  })

  it('grants the rights GitLab lists on every page of discussions, and none past maxOutputBytes', async () => {
    const pages = new Map<unknown, GlabOutput>([
      [null, rightsPage({ createNote: true, discussions: [rightsOf('d1', true, [1], true, [2]), rightsOf('d2', true, [], false)], next: 'c1' })],
      ['c1', rightsPage({ createNote: false, discussions: [rightsOf('d3', false, [4])] })],
    ])
    const glab = gitlab([[discussion('d1', [note(1), note(2)]), discussion('d2', [note(3)]), discussion('d3', [note(4)])]], undefined,
      { rights: cursor => pages.get(cursor) ?? json({}) })
    const read = await readReviewThreads(new GitLabApi(glab.run), merge(6), HEAD, limits, vi.fn(), signal)
    expect('threads' in read ? read.threads.map(thread => [thread.id, thread.viewerCanReply, thread.viewerCanResolve, thread.comments.map(comment => comment.viewerCanEdit)]) : [])
      .toEqual([['d1', true, true, [true, false]], ['d2', true, false, [false]], ['d3', true, false, [true]]])
    expect(read).toMatchObject({ viewerCanReview: true, reviewEvents: ['comment'] })
    // The first page lists more discussions than the one REST page holds, so only the permission pages pass the limit.
    const wide = rightsPage({ discussions: Array.from({ length: 20 }, (_, index) => rightsOf(`x${index}`, true, [100 + index])), next: 'c1' })
    const answer: unknown = JSON.parse(wide.stdout)
    const bytes = Buffer.byteLength(JSON.stringify(z.object({ data: z.unknown() }).parse(answer).data))
    const capped = gitlab([[discussion('d3', [note(4)])]], undefined, { rights: cursor => cursor === null ? wide : pages.get(cursor) ?? json({}) })
    const short = await readReviewThreads(new GitLabApi(capped.run), merge(6), HEAD, { ...limits, maxOutputBytes: bytes - 1 }, vi.fn(),
      signal)
    expect('threads' in short ? short.threads[0]?.comments[0]?.viewerCanEdit : undefined).toBe(false)
    expect(short).toMatchObject({ truncated: true })
    expect(capped.calls.filter(call => call.args.includes('graphql'))).toHaveLength(1)
    // A discussion with more than one page of notes leaves the rights of the later notes unread.
    const longRights = () => rightsPage({ discussions: [rightsOf('d1', true, [1], true, [], true)] })
    const long = gitlab([[discussion('d1', [note(1)])]], undefined, { rights: longRights })
    const reread = async (run: typeof glab.run) => await readReviewThreads(new GitLabApi(run), merge(6), HEAD, limits, vi.fn(), signal)
    await expect(reread(long.run)).resolves.toMatchObject({ truncated: true })
    await expect(reread(glab.run)).resolves.toMatchObject({ truncated: false })
  })

  it('drops the threads whose hunks bring the result past maxOutputBytes', async () => {
    const outdated = (id: string, line: number) => discussion(id, [note(line, { position: position({ head_sha: OLD, new_line: line }) })])
    const lines = Array.from({ length: 40 }, (_, line) => ` ${'x'.repeat(40)}${line}`).join('\n')
    const hunk = `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,40 +1,40 @@\n${lines}\n`
    const glab = gitlab([[outdated('d1', 39), outdated('d2', 40)]], [{ id: 3, head_commit_sha: HEAD }, { id: 2, head_commit_sha: OLD }])
    const read = await readReviewThreads(new GitLabApi(glab.run), merge(6), HEAD, { ...limits, maxOutputBytes: 3000 }, async () => hunk,
      signal)
    expect(read).toMatchObject({ truncated: true })
    expect('threads' in read ? read.threads.map(thread => thread.id) : []).toEqual(['d1'])
  })

  it.each([
    ['a user who may only comment', {}, { user_has_approved: false, user_can_approve: false }, ['comment']],
    ['a user who may approve', {}, { user_has_approved: false, user_can_approve: true }, ['comment', 'approve']],
    ['a user who approved', {}, { user_has_approved: true, user_can_approve: false }, ['comment', 'approve']],
    ['a reviewer', { reviewers: ['other', 'OCTO'] }, { user_has_approved: false, user_can_approve: false }, ['comment', 'request-changes']],
    ['a reviewer GitLab names no user for', { reviewers: ['octo'], viewer: null }, {}, ['comment']],
  ] as const)('offers review decisions to %s', async (_label, rights, approvals, events) => {
    const glab = gitlab([[]], undefined, { rights: () => rightsPage({ createNote: true, ...rights }), approvals: json(approvals) })
    await expect(readReviewThreads(new GitLabApi(glab.run), merge(6), HEAD, limits, vi.fn(), signal))
      .resolves.toMatchObject({ reviewEvents: events })
  })

  it('offers no decision to a user who may not comment, and keeps comments when the approval read fails', async () => {
    const silent = gitlab([[]], undefined, { approvals: json({ user_can_approve: true, user_has_approved: false }) })
    await expect(readReviewThreads(new GitLabApi(silent.run), merge(6), HEAD, limits, vi.fn(), signal))
      .resolves.toMatchObject({ viewerCanReview: false, reviewEvents: [] })
    const failed = gitlab([[]], undefined, { rights: () => rightsPage({ createNote: true }), approvals: output('', 1, 'glab: (HTTP 500)') })
    await expect(readReviewThreads(new GitLabApi(failed.run), merge(6), HEAD, limits, vi.fn(), signal)).resolves.toMatchObject({ reviewEvents: ['comment'] })
  })

  it('shows the signed-in user\'s draft notes as their pending review', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-11T08:00:00Z'), toFake: ['Date'] })
    try {
      const reply = { id: 41, discussion_id: 'd1', note: 'Draft reply', position: { base_sha: null, head_sha: null, old_path: null, new_path: null, position_type: 'text' } }
      const opened = { id: 42, discussion_id: null, note: 'Draft thread', position: position({ new_line: 9, line_range: { start: { new_line: 7 }, end: { new_line: 9 } } }) }
      const stale = { id: 43, discussion_id: null, note: 'Old draft', position: position({ head_sha: OLD, new_line: 2 }) }
      const overview = { id: 44, discussion_id: null, note: 'Overview draft', position: null }
      const image = { id: 45, discussion_id: null, note: 'Image draft', position: { ...position(), position_type: 'image' } }
      const elsewhere = { id: 46, discussion_id: 'gone', note: 'Reply elsewhere' }
      const glab = gitlab([[discussion('d1', [note(1)])]], [{ id: 3, head_commit_sha: HEAD }, { id: 2, head_commit_sha: OLD }],
        { rights: () => rightsPage({ createNote: true }), drafts: json([reply, opened, stale, overview, image, elsewhere]) })
      const files: PositionFile[] = []
      const read = await readReviewThreads(new GitLabApi(glab.run), merge(6), HEAD, limits, async (file) => {
        files.push(file)
        return '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n'
      }, signal)
      const pending = (id: number, body: string) => ({
        id: `draft-${id}`, author: { login: 'octo', avatarUrl: 'https://avatar/octo', bot: false }, body, createdAt: '2026-11-11T08:00:00.000Z',
        pending: true, url: null, viewerCanEdit: true, viewerCanDelete: true,
      })
      expect(read).toMatchObject({ pendingReview: { id: 'draft-notes', comments: 6 } })
      expect('threads' in read ? read.threads : []).toEqual([
        expect.objectContaining({ id: 'd1', comments: [expect.objectContaining({ id: '1', pending: false }), pending(41, 'Draft reply')] }),
        {
          id: 'draft-42', path: 'src/a.ts', side: 'R', subject: 'line', current: { commit: HEAD, startLine: 7, endLine: 9 },
          original: { commit: HEAD, startLine: 7, endLine: 9 }, diffHunk: null, resolved: false,
          viewerCanReply: false, viewerCanResolve: false,
          comments: [pending(42, 'Draft thread')],
        },
        expect.objectContaining({ id: 'draft-43', current: null, original: { commit: OLD, startLine: 2, endLine: 2 }, diffHunk: '@@ -1,2 +1,2 @@\n a\n-b\n+B' }),
      ])
      expect(files).toEqual([{ version: 2, baseSha: sha('b'), headSha: OLD, oldPath: 'src/a.ts', newPath: 'src/a.ts' }])
      const anonymous = gitlab([[]], undefined, { rights: () => rightsPage({ viewer: null }), drafts: json([opened]) })
      const unsigned = await readReviewThreads(new GitLabApi(anonymous.run), merge(6), HEAD, limits, vi.fn(), signal)
      expect('threads' in unsigned ? unsigned.threads[0]?.comments[0]?.author : undefined).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('GitLab review ids', () => {
  it('resolves uploaded avatars, which GitLab names by their path on the host', async () => {
    const glab = gitlab([[discussion('d1', [note(1, { author: { username: 'lin', avatar_url: '/uploads/lin.png' } })])]], undefined, {
      rights: () => rightsPage({ viewer: { username: 'octo', avatarUrl: '/uploads/octo.png' }, createNote: true }),
      drafts: json([{ id: 41, discussion_id: 'd1', note: 'Draft reply' }]),
    })
    const read = await readReviewThreads(new GitLabApi(glab.run), merge(6), HEAD, limits, async () => null, signal)
    const comments = 'threads' in read ? read.threads[0]?.comments ?? [] : []
    expect(comments.map(comment => comment.author?.avatarUrl)).toEqual([`https://${HOST}/uploads/lin.png`, `https://${HOST}/uploads/octo.png`])
  })

  it('reads the ids this provider issues and refuses others', () => {
    expect(draftCommentId(7)).toBe('draft-7')
    expect(noteOf('721587' as ForgeCommentId)).toEqual({ draft: false, id: '721587' })
    expect(noteOf('draft-4646' as ForgeCommentId)).toEqual({ draft: true, id: '4646' })
    for (const id of ['', '0', 'draft-', 'draft-x', '1/2', '../1', '12345678901234567890']) expect(noteOf(id as ForgeCommentId)).toBeUndefined()
    expect(discussionOf('a'.repeat(40) as ForgeThreadId)).toBe('a'.repeat(40))
    for (const id of ['draft-42', 'A'.repeat(40), 'a'.repeat(39), `${'a'.repeat(40)}/notes`]) expect(discussionOf(id as ForgeThreadId)).toBeUndefined()
  })
})

describe('hunk cutting', () => {
  const patch = '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file\n@@ -10,2 +10,3 @@\n x\n+y\n z\n'

  it('cuts the hunk that holds a line, ending at it', () => {
    expect(hunkUntil(patch, 'R', 2)).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+B')
    expect(hunkUntil(patch, 'L', 2)).toBe('@@ -1,2 +1,1 @@\n a\n-b')
    expect(hunkUntil(patch, 'R', 11)).toBe('@@ -10,1 +10,2 @@\n x\n+y')
    expect(hunkUntil(patch, 'R', 3)).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')
  })

  it('finds no hunk for an unknown patch or a line no hunk holds', () => {
    expect(hunkUntil(null, 'R', 1)).toBeNull()
    expect(hunkUntil(patch, 'R', 7)).toBeNull()
    expect(hunkUntil('', 'R', 1)).toBeNull()
    expect(hunkUntil('@@ -1,5 +1,5 @@\n a\n@@ -9 +9 @@\n b\n', 'R', 1)).toBeNull()
  })
})
