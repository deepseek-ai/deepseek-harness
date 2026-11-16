import type {
  ForgeCommentId, ForgeLineComment, ForgeReviewId, ForgeReviewRequest, ForgeReviewWrite, ForgeThreadId,
} from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import { GitLabApi } from '../src/api.ts'
import type { GlabOutput } from '../src/glab.ts'
import type { VersionFile } from '../src/position.ts'
import { submitGitLabReview, writeGitLabReview } from '../src/writes.ts'
import type { VersionFiles } from '../src/writes.ts'
import { fakeGlab, json, merge, mrPath, output, sha } from './fixtures.ts'
import type { GlabCall } from './fixtures.ts'

const signal = new AbortController().signal
const HEAD = sha('a')
const DISCUSSION = 'f'.repeat(40) as ForgeThreadId
const REVIEW = 'draft-notes' as ForgeReviewId
const URL = 'https://gitlab.example.test/group/sub/app/-/merge_requests/6'

const file: VersionFile = { oldPath: 'src/a.ts', newPath: 'src/a.ts', diff: '@@ -1,2 +1,2 @@\n a\n-b\n+B\n' }
const files: VersionFiles = async version => version === 3 ? new Map([['src/a.ts', file]]) : undefined
const version = { id: 3, head_commit_sha: HEAD, base_commit_sha: sha('b'), start_commit_sha: sha('c') }
const comment: ForgeLineComment = { path: 'src/a.ts', side: 'R', startLine: 2, endLine: 2, body: 'Fix this' }
const position = {
  position_type: 'text', base_sha: sha('b'), start_sha: sha('c'), head_sha: HEAD, old_path: 'src/a.ts', new_path: 'src/a.ts', old_line: null, new_line: 2,
}

/** A review write without the head commit, for each kind of write. */
type WriteBody = ForgeReviewWrite extends infer Write ? Write extends ForgeReviewWrite ? Omit<Write, 'headSha'> : never : never

/** One scripted answer per request, keyed by method and path below the merge request. */
type Answers = Readonly<Record<string, GlabOutput | (() => GlabOutput)>>

/** A `glab` whose merge request is at `HEAD` unless `answers` overrides a request. */
function gitlab(answers: Answers = {}) {
  return fakeGlab((path, call) => {
    const method = call.args[call.args.indexOf('-X') + 1] ?? 'GET'
    const key = `${call.args.includes('-X') ? method : 'GET'} ${path.startsWith(mrPath(6)) ? path.slice(mrPath(6).length) : path}`
    const answer = answers[key] ?? defaults[key]
    if (answer === undefined) throw new Error(`unexpected request ${key}`)
    return typeof answer === 'function' ? answer() : answer
  })
}

const defaults: Answers = {
  'GET /versions?per_page=1': json([version]),
  'GET /draft_notes': json([]),
  'GET /approvals': json({ user_has_approved: false }),
}

/** One write request: its method, its path below the merge request, and its parsed body when it sent one. */
type Sent = readonly [method: string, path: string, body?: unknown]

/** The write requests a run sent. */
function writes(calls: readonly GlabCall[]): Sent[] {
  return calls.filter(call => call.args.includes('-X')).map((call): Sent => {
    const method = call.args[call.args.indexOf('-X') + 1] ?? ''
    const path = (call.args[call.args.indexOf('-X') + 2] ?? '').slice(mrPath(6).length)
    if (call.input === undefined) return [method, path]
    const body: unknown = JSON.parse(call.input)
    return [method, path, body]
  })
}

async function write(body: WriteBody, answers: Answers = {}, headSha = HEAD) {
  const glab = gitlab(answers)
  const result = await writeGitLabReview(new GitLabApi(glab.run), files, merge(6), { ...body, headSha }, signal)
  return { result, sent: writes(glab.calls) }
}

async function submit(request: ForgeReviewRequest, answers: Answers = {}) {
  const glab = gitlab(answers)
  const result = await submitGitLabReview(new GitLabApi(glab.run), files, merge(6), request, signal)
  return { result, sent: writes(glab.calls) }
}

const refused = (status: number, message = 'no'): GlabOutput => output(JSON.stringify({ message }), 1, `glab: ${message} (HTTP ${status})`)

/** Answer the draft note list with `first`, then with `later` on every later read. */
function listed(first: readonly { readonly id: number }[], later: GlabOutput | readonly { readonly id: number }[]): () => GlabOutput {
  let reads = 0
  return () => reads++ === 0 ? json(first) : Array.isArray(later) ? json(later) : later as GlabOutput
}

describe('GitLab review writes', () => {
  it.each([
    ['a reply at once', { kind: 'reply', thread: DISCUSSION, body: 'Yes', pending: false }, ['POST', `/discussions/${DISCUSSION}/notes`, { body: 'Yes' }]],
    ['a pending reply', { kind: 'reply', thread: DISCUSSION, body: 'Yes', pending: true },
      ['POST', '/draft_notes', { note: 'Yes', in_reply_to_discussion_id: DISCUSSION }]],
    ['a resolution', { kind: 'resolve', thread: DISCUSSION, resolved: true }, ['PUT', `/discussions/${DISCUSSION}`, { resolved: true }]],
    ['an unresolution', { kind: 'resolve', thread: DISCUSSION, resolved: false }, ['PUT', `/discussions/${DISCUSSION}`, { resolved: false }]],
    ['an edit', { kind: 'edit-comment', comment: '12' as ForgeCommentId, body: 'New' }, ['PUT', '/notes/12', { body: 'New' }]],
    ['a draft edit', { kind: 'edit-comment', comment: 'draft-7' as ForgeCommentId, body: 'New' }, ['PUT', '/draft_notes/7', { note: 'New' }]],
    ['a deletion', { kind: 'delete-comment', comment: '12' as ForgeCommentId }, ['DELETE', '/notes/12']],
    ['a draft deletion', { kind: 'delete-comment', comment: 'draft-7' as ForgeCommentId }, ['DELETE', '/draft_notes/7']],
    ['a pending comment', { kind: 'add-pending', comment }, ['POST', '/draft_notes', { note: 'Fix this', position }]],
  ] as const)('sends %s through the merge request', async (_label, body, request) => {
    const { result, sent } = await write(body, { [`${request[0]} ${request[1]}`]: json({ id: 1 }) })
    expect(result).toEqual({ ok: true })
    expect(sent).toEqual([request])
  })

  it('refuses a moved head and ids it never issued without writing', async () => {
    await expect(write({ kind: 'resolve', thread: DISCUSSION, resolved: true }, {}, sha('9'))).resolves.toEqual({
      result: { ok: false, code: 'stale', message: `the merge request head moved from ${sha('9')} to ${HEAD}` }, sent: [],
    })
    const unknown = { ok: false, code: 'failed', message: 'merge request 6 has no discussion or note with that id' }
    for (const body of [
      { kind: 'reply', thread: 'draft-4' as ForgeThreadId, body: 'x', pending: false },
      { kind: 'resolve', thread: '../x' as ForgeThreadId, resolved: true },
      { kind: 'edit-comment', comment: '1/2' as ForgeCommentId, body: 'x' },
      { kind: 'delete-comment', comment: 'note-1' as ForgeCommentId },
    ] as const) {
      await expect(write(body)).resolves.toEqual({ result: unknown, sent: [] })
    }
    await expect(write({ kind: 'resolve', thread: DISCUSSION, resolved: true }, { 'GET /versions?per_page=1': refused(500, 'down') }))
      .resolves.toEqual({ result: { ok: false, code: 'failed', message: 'down (HTTP 500)' }, sent: [] })
  })

  it('refuses a comment on lines the newest version does not change', async () => {
    const result = { ok: false, code: 'failed', message: 'merge request 6 does not change lines 2-2 of src/b.ts on that side' }
    await expect(write({ kind: 'add-pending', comment: { ...comment, path: 'src/b.ts' } })).resolves.toEqual({ result, sent: [] })
    await expect(write({ kind: 'add-pending', comment }, { 'GET /versions?per_page=1': json([{ ...version, id: 4 }]) })).resolves.toEqual({
      result: { ok: false, code: 'failed', message: 'GitLab did not list the changed files of the merge request' }, sent: [],
    })
  })

  it.each([
    [refused(404), 'failed', 'no (HTTP 404)'],
    [refused(401), 'failed', 'no (HTTP 401)'],
    [output('', 1, 'glab: connection reset'), 'unknown', 'connection reset'],
  ] as const)('reports a write GitLab did not take as %s', async (answer, code, message) => {
    await expect(write({ kind: 'resolve', thread: DISCUSSION, resolved: true }, { [`PUT /discussions/${DISCUSSION}`]: answer }))
      .resolves.toMatchObject({ result: { ok: false, code, message } })
  })

  it('submits the pending review with a summary and the decision\'s review state', async () => {
    const pending = { 'GET /draft_notes': json([{ id: 7 }, { id: 8 }]), 'POST /draft_notes/bulk_publish': output('') }
    await expect(write({ kind: 'submit-pending', review: REVIEW, event: 'request-changes', body: 'Please fix' }, pending)).resolves.toEqual({
      result: { ok: true }, sent: [['POST', '/draft_notes/bulk_publish', { note: 'Please fix', reviewer_state: 'requested_changes' }]],
    })
    await expect(write({ kind: 'submit-pending', review: REVIEW, event: 'comment', body: ' ' }, pending)).resolves.toEqual({
      result: { ok: true }, sent: [['POST', '/draft_notes/bulk_publish', { reviewer_state: 'reviewed' }]],
    })
  })

  it('approves at the head before it submits an approving review, unless the user already approved', async () => {
    const pending = { 'GET /draft_notes': json([{ id: 7 }]), 'POST /approve': json({}), 'POST /draft_notes/bulk_publish': output('') }
    await expect(write({ kind: 'submit-pending', review: REVIEW, event: 'approve', body: 'LGTM' }, pending)).resolves.toEqual({
      result: { ok: true }, sent: [['POST', '/approve', { sha: HEAD }], ['POST', '/draft_notes/bulk_publish', { note: 'LGTM' }]],
    })
    await expect(write({ kind: 'submit-pending', review: REVIEW, event: 'approve', body: '' },
      { ...pending, 'GET /approvals': json({ user_has_approved: true }) })).resolves.toEqual({
      result: { ok: true }, sent: [['POST', '/draft_notes/bulk_publish', {}]],
    })
    await expect(write({ kind: 'submit-pending', review: REVIEW, event: 'approve', body: '' }, { ...pending, 'POST /approve': refused(409, 'SHA does not match') }))
      .resolves.toEqual({ result: { ok: false, code: 'stale', message: 'SHA does not match (HTTP 409)' }, sent: [['POST', '/approve', { sha: HEAD }]] })
    await expect(write({ kind: 'submit-pending', review: REVIEW, event: 'approve', body: '' }, { ...pending, 'POST /approve': refused(403) }))
      .resolves.toMatchObject({ result: { ok: false, code: 'failed' } })
    await expect(write({ kind: 'submit-pending', review: REVIEW, event: 'approve', body: '' }, { ...pending, 'GET /approvals': refused(500, 'down') }))
      .resolves.toEqual({ result: { ok: false, code: 'failed', message: 'down (HTTP 500)' }, sent: [] })
    await expect(write({ kind: 'submit-pending', review: REVIEW, event: 'approve', body: '' }, { ...pending, 'GET /approvals': json({}) }))
      .resolves.toEqual({ result: { ok: false, code: 'failed', message: 'unexpected GitLab response to the approval read' }, sent: [] })
  })

  it('refuses to submit or discard a pending review the user no longer has', async () => {
    const gone = { ok: false, code: 'failed', message: 'the pending review draft-notes is no longer the signed-in user\'s pending review' }
    await expect(write({ kind: 'submit-pending', review: REVIEW, event: 'comment', body: '' })).resolves.toEqual({ result: gone, sent: [] })
    await expect(write({ kind: 'discard-pending', review: 'other' as ForgeReviewId }, { 'GET /draft_notes': json([{ id: 7 }]) }))
      .resolves.toEqual({ result: { ...gone, message: 'the pending review other is no longer the signed-in user\'s pending review' }, sent: [] })
    await expect(write({ kind: 'discard-pending', review: REVIEW }, { 'GET /draft_notes': refused(500, 'down') }))
      .resolves.toEqual({ result: { ok: false, code: 'failed', message: 'down (HTTP 500)' }, sent: [] })
    await expect(write({ kind: 'discard-pending', review: REVIEW }, { 'GET /draft_notes': json({ drafts: [] }) }))
      .resolves.toEqual({ result: { ok: false, code: 'failed', message: 'unexpected GitLab response to the draft note read' }, sent: [] })
  })

  it('discards the pending review one draft at a time and reports how far it got', async () => {
    const drafts = { 'GET /draft_notes': json([{ id: 7 }, { id: 8 }]), 'DELETE /draft_notes/7': output(''), 'DELETE /draft_notes/8': output('') }
    await expect(write({ kind: 'discard-pending', review: REVIEW }, drafts)).resolves.toEqual({
      result: { ok: true }, sent: [['DELETE', '/draft_notes/7'], ['DELETE', '/draft_notes/8']],
    })
    await expect(write({ kind: 'discard-pending', review: REVIEW }, { ...drafts, 'DELETE /draft_notes/8': refused(404) })).resolves.toMatchObject({
      result: { ok: false, code: 'failed', message: 'GitLab deleted 1 of 2 pending comments: no (HTTP 404)' },
    })
    await expect(write({ kind: 'discard-pending', review: REVIEW }, { ...drafts, 'DELETE /draft_notes/7': output('', 1, 'glab: reset') })).resolves.toMatchObject({
      result: { ok: false, code: 'unknown', message: 'reset' }, sent: [['DELETE', '/draft_notes/7']],
    })
  })
})

describe('GitLab review submissions', () => {
  it('starts a discussion for one comment and links its first note', async () => {
    const started = { 'POST /discussions': json({ id: 'd', notes: [{ id: 41 }] }) }
    await expect(submit({ kind: 'comment', headSha: HEAD, comment }, started)).resolves.toEqual({
      result: { ok: true, url: `${URL}#note_41` }, sent: [['POST', '/discussions', { body: 'Fix this', position }]],
    })
    await expect(submit({ kind: 'comment', headSha: HEAD, comment }, { 'POST /discussions': output('') }))
      .resolves.toMatchObject({ result: { ok: true, url: URL } })
    await expect(submit({ kind: 'comment', headSha: HEAD, comment }, { 'POST /discussions': refused(400, 'line_code invalid') }))
      .resolves.toMatchObject({ result: { ok: false, code: 'failed', message: 'line_code invalid (HTTP 400)' } })
    await expect(submit({ kind: 'comment', headSha: HEAD, comment: { ...comment, path: 'x' } })).resolves.toMatchObject({ result: { ok: false, code: 'failed' }, sent: [] })
    await expect(submit({ kind: 'comment', headSha: sha('9'), comment })).resolves.toMatchObject({ result: { ok: false, code: 'stale' }, sent: [] })
  })

  it('publishes a review as draft notes with its summary and review state', async () => {
    let next = 70
    const answers = { 'POST /draft_notes': () => json({ id: next++ }), 'POST /draft_notes/bulk_publish': output('') }
    const second = { ...comment, side: 'L' as const, startLine: 2, endLine: 2, body: 'And this' }
    await expect(submit({ kind: 'review', headSha: HEAD, event: 'comment', body: '', comments: [comment, second] }, answers)).resolves.toEqual({
      result: { ok: true, url: URL },
      sent: [
        ['POST', '/draft_notes', { note: 'Fix this', position }],
        ['POST', '/draft_notes', { note: 'And this', position: { ...position, old_line: 2, new_line: null } }],
        ['POST', '/draft_notes/bulk_publish', { reviewer_state: 'reviewed' }],
      ],
    })
  })

  it('approves after writing the drafts and skips publishing an approval without text', async () => {
    const answers = { 'POST /draft_notes': json({ id: 70 }), 'POST /approve': json({}), 'POST /draft_notes/bulk_publish': output('') }
    const approved = await submit({ kind: 'review', headSha: HEAD, event: 'approve', body: 'LGTM', comments: [comment] }, answers)
    expect(approved.result).toEqual({ ok: true, url: URL })
    expect(approved.sent.map(([method, path]) => `${method} ${path}`)).toEqual(['POST /draft_notes', 'POST /approve', 'POST /draft_notes/bulk_publish'])
    expect(approved.sent[2]?.[2]).toEqual({ note: 'LGTM' })
    await expect(submit({ kind: 'review', headSha: HEAD, event: 'approve', body: '', comments: [] }, answers)).resolves.toEqual({
      result: { ok: true, url: URL }, sent: [['POST', '/approve', { sha: HEAD }]],
    })
  })

  it('deletes the drafts it wrote when GitLab refuses a draft, the approval, or the publication', async () => {
    let next = 70
    const base = { 'POST /draft_notes': () => json({ id: next++ }), 'DELETE /draft_notes/70': output(''), 'DELETE /draft_notes/71': output('') }
    const two = [comment, { ...comment, body: 'Again' }]
    next = 70
    const draftRefused = await submit({ kind: 'review', headSha: HEAD, event: 'comment', body: '', comments: two },
      { ...base, 'POST /draft_notes': () => next === 70 ? json({ id: next++ }) : refused(400, 'bad position') })
    expect(draftRefused).toEqual({
      result: { ok: false, code: 'failed', message: 'bad position (HTTP 400)' },
      sent: [['POST', '/draft_notes', expect.anything()], ['POST', '/draft_notes', expect.anything()], ['DELETE', '/draft_notes/70']],
    })
    next = 70
    const odd = await submit({ kind: 'review', headSha: HEAD, event: 'comment', body: '', comments: two }, { ...base, 'POST /draft_notes': () => json({}) })
    expect(odd.result).toEqual({ ok: false, code: 'unknown', message: 'unexpected GitLab response to a draft note' })
    next = 70
    const stale = await submit({ kind: 'review', headSha: HEAD, event: 'approve', body: '', comments: two }, { ...base, 'POST /approve': refused(409, 'SHA does not match') })
    expect(stale.result).toMatchObject({ ok: false, code: 'stale' })
    expect(stale.sent).toEqual(expect.arrayContaining([['DELETE', '/draft_notes/70'], ['DELETE', '/draft_notes/71']]))
    next = 70
    const unpublished = await submit({ kind: 'review', headSha: HEAD, event: 'comment', body: '', comments: two },
      { ...base, 'GET /draft_notes': listed([], [{ id: 70 }, { id: 71 }]), 'POST /draft_notes/bulk_publish': refused(403) })
    expect(unpublished.result).toEqual({ ok: false, code: 'failed', message: 'no (HTTP 403)' })
    expect(unpublished.sent).toEqual(expect.arrayContaining([['DELETE', '/draft_notes/70'], ['DELETE', '/draft_notes/71']]))
    next = 70
    const uncertain = await submit({ kind: 'review', headSha: HEAD, event: 'comment', body: '', comments: two },
      { ...base, 'POST /draft_notes/bulk_publish': output('', 1, 'glab: timeout') })
    expect(uncertain.result).toEqual({ ok: false, code: 'unknown', message: 'timeout' })
    expect(uncertain.sent).not.toContainEqual(['DELETE', '/draft_notes/70'])
  })

  it('keeps the drafts and asks for a check when GitLab may have published them before refusing the publication', async () => {
    let next = 70
    const two = [comment, { ...comment, body: 'Again' }]
    const answers = (after: GlabOutput) => ({
      'POST /draft_notes': () => json({ id: next++ }), 'GET /draft_notes': listed([], after), 'POST /draft_notes/bulk_publish': refused(422, 'Note is too long'),
    })
    const message = 'Note is too long (HTTP 422); GitLab may have published the comments of this review, so check the merge request before you submit again'
    for (const after of [json([]), json([{ id: 71 }]), refused(500, 'down')]) {
      next = 70
      await expect(submit({ kind: 'review', headSha: HEAD, event: 'comment', body: 'x'.repeat(8), comments: two }, answers(after))).resolves.toEqual({
        result: { ok: false, code: 'unknown', message },
        sent: [['POST', '/draft_notes', expect.anything()], ['POST', '/draft_notes', expect.anything()], ['POST', '/draft_notes/bulk_publish', expect.anything()]],
      })
    }
  })

  it('reports the drafts a rollback could not delete', async () => {
    let next = 70
    const two = [comment, { ...comment, body: 'Again' }]
    const result = await submit({ kind: 'review', headSha: HEAD, event: 'approve', body: '', comments: two }, {
      'POST /draft_notes': () => json({ id: next++ }), 'POST /approve': refused(409, 'SHA does not match'),
      'DELETE /draft_notes/70': refused(500, 'down'), 'DELETE /draft_notes/71': output(''),
    })
    expect(result.result).toEqual({
      ok: false, code: 'unknown',
      message: 'SHA does not match (HTTP 409); 1 pending comment of yours may remain on merge request 6, so check its pending comments before you submit again',
    })
    next = 70
    const both = await submit({ kind: 'review', headSha: HEAD, event: 'approve', body: '', comments: two }, {
      'POST /draft_notes': () => json({ id: next++ }), 'POST /approve': refused(409, 'SHA does not match'),
      'DELETE /draft_notes/70': refused(500, 'down'), 'DELETE /draft_notes/71': output('', 1, 'glab: timeout'),
    })
    expect(both.result.ok ? '' : both.result.message).toContain('2 pending comments of yours may remain')
    expect(both.result).toMatchObject({ code: 'unknown' })
  })

  it('refuses a review while the user has drafts, an empty comment review, and a comment it cannot place', async () => {
    await expect(submit({ kind: 'review', headSha: HEAD, event: 'comment', body: 'x', comments: [] }, { 'GET /draft_notes': json([{ id: 7 }]) })).resolves.toEqual({
      result: { ok: false, code: 'failed', message: 'GitLab holds pending comments of yours on this merge request; submit or discard them first' }, sent: [],
    })
    await expect(submit({ kind: 'review', headSha: HEAD, event: 'comment', body: ' ', comments: [] })).resolves.toEqual({
      result: { ok: false, code: 'failed', message: 'A review without a decision needs a comment or a summary' }, sent: [],
    })
    await expect(submit({ kind: 'review', headSha: HEAD, event: 'comment', body: '', comments: [comment, { ...comment, path: 'x' }] }))
      .resolves.toMatchObject({ result: { ok: false, code: 'failed' }, sent: [] })
    await expect(submit({ kind: 'review', headSha: HEAD, event: 'comment', body: 'x', comments: [] }, { 'GET /draft_notes': refused(500, 'down') }))
      .resolves.toEqual({ result: { ok: false, code: 'failed', message: 'down (HTTP 500)' }, sent: [] })
    await expect(submit({ kind: 'review', headSha: sha('9'), event: 'comment', body: 'x', comments: [] })).resolves.toMatchObject({ result: { ok: false, code: 'stale' } })
  })
})
