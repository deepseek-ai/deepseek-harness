/** GitHub review thread and pending review writes check the head first, send JSON on stdin, and never retry. */
import { describe, expect, it } from 'vitest'
import type { ForgeCommentId, ForgeReviewId, ForgeReviewWrite, ForgeThreadId } from '@deepseek-ai/dsh-experimental-forge'
import { GhTimeoutError, GhUnavailableError, type GhOutput, type GhRunner } from '../src/gh.ts'
import { GitHubProvider } from '../src/provider.ts'
import {
  ADD_REVIEW_MUTATION, ADD_THREAD_MUTATION, DELETE_COMMENT_MUTATION, DELETE_REVIEW_MUTATION, EDIT_COMMENT_MUTATION, REPLY_MUTATION,
  RESOLVE_MUTATION, SUBMIT_REVIEW_MUTATION, UNRESOLVE_MUTATION, WRITE_CHECK_QUERY, WRITE_TARGET_CHECK_QUERY,
} from '../src/review-writes.ts'
import { demo, pull } from './fixtures.ts'

const head = 'c'.repeat(40)
const pushed = 'd'.repeat(40)
const signal = new AbortController().signal
const thread = 'thread-1' as ForgeThreadId
const comment = 'comment-1' as ForgeCommentId
const review = 'review-1' as ForgeReviewId

function output(stdout: unknown, exitCode = 0, stderr = ''): GhOutput {
  return { exitCode, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr }
}

/** The check's answer: the head, the pending review, and the pull request that holds the write's thread or comment. */
function checked(
  pending: string | null = null, headRefOid = head, viewerDidAuthor = true, target: unknown = { pullRequest: { id: 'pull-7' } },
): GhOutput {
  return output({ data: { repository: { pullRequest: {
    id: 'pull-7', headRefOid, reviews: { nodes: pending === null ? [] : [{ id: pending, viewerDidAuthor }] },
  } }, target } })
}

/** One recorded `gh` call: its arguments and, for a mutation, the JSON it sent on stdin. */
interface Call {
  readonly args: readonly string[]
  readonly input: { readonly query: string; readonly variables: Record<string, unknown> } | undefined
}

/** A mutation answer that throws `throws` instead of printing output. */
interface Thrown { readonly throws: unknown }

/** Answer the check with `check`, then each mutation in turn from `mutations`. */
function fakeGh(check: GhOutput, ...mutations: Array<GhOutput | Thrown>): { run: GhRunner; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...mutations]
  return { calls, run: async (args, _signal, input) => {
    calls.push({ args: [...args], input: input === undefined ? undefined : JSON.parse(input) as Call['input'] })
    if (input === undefined) return check
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected gh ${args.join(' ')}`)
    if ('throws' in next) throw next.throws
    return next
  } }
}

function provider(run: GhRunner): GitHubProvider {
  return new GitHubProvider(run, ['github.com'], { maxOutputBytes: 8_388_608, maxReviewThreads: 1_000, maxCommits: 250, maxViewedFiles: 3_000 })
}

function payload(field: string, value: unknown = { id: 'x' }): GhOutput {
  return output({ data: { [field]: value } })
}

const MUTATION_ARGS = ['api', 'graphql', '--hostname', 'github.com', '--input', '-']

describe('GitHub review writes', () => {
  it('checks the head with the pull request as variables and replies at once without a pending review', async () => {
    const gh = fakeGh(checked(), payload('addPullRequestReviewThreadReply', { comment: { id: 'reply-1' } }))

    await expect(provider(gh.run).writeReview(pull(7), { kind: 'reply', headSha: head, thread, body: 'Fixed in `$(x)`', pending: false }, signal))
      .resolves.toEqual({ ok: true })
    expect(gh.calls).toEqual([
      { args: ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${WRITE_TARGET_CHECK_QUERY}`, '-f', `owner=${demo.owner}`,
        '-f', `name=${demo.name}`, '-F', 'number=7', '-f', `target=${thread}`], input: undefined },
      { args: MUTATION_ARGS, input: { query: REPLY_MUTATION, variables: { thread, body: 'Fixed in `$(x)`', review: null } } },
    ])
  })

  it('refuses a reply at once without a mutation while the viewer has a pending review, which GitHub would add it to', async () => {
    const gh = fakeGh(checked('review-9'))

    await expect(provider(gh.run).writeReview(pull(7), { kind: 'reply', headSha: head, thread, body: 'Now', pending: false }, signal))
      .resolves.toEqual({ ok: false, code: 'failed',
        message: 'GitHub adds a reply to the pending review while one exists; submit or discard it first' })
    expect(gh.calls).toHaveLength(1)
  })

  it('replies inside the existing pending review', async () => {
    const gh = fakeGh(checked('review-9'), payload('addPullRequestReviewThreadReply'))

    await provider(gh.run).writeReview(pull(7), { kind: 'reply', headSha: head, thread, body: 'Later', pending: true }, signal)

    expect(gh.calls[1]?.input).toEqual({ query: REPLY_MUTATION, variables: { thread, body: 'Later', review: 'review-9' } })
  })

  it('starts a pending review at the head before a pending reply when the viewer has none', async () => {
    const gh = fakeGh(checked('review-of-other', head, false),
      payload('addPullRequestReview', { pullRequestReview: { id: 'review-new' } }), payload('addPullRequestReviewThreadReply'))

    await expect(provider(gh.run).writeReview(pull(7), { kind: 'reply', headSha: head, thread, body: 'Later', pending: true }, signal))
      .resolves.toEqual({ ok: true })
    expect(gh.calls.slice(1).map(call => call.input)).toEqual([
      { query: ADD_REVIEW_MUTATION, variables: { pull: 'pull-7', commit: head, threads: null } },
      { query: REPLY_MUTATION, variables: { thread, body: 'Later', review: 'review-new' } },
    ])
  })

  it('returns the failure of starting a pending review and an unexpected start without replying', async () => {
    const write: ForgeReviewWrite = { kind: 'reply', headSha: head, thread, body: 'Later', pending: true }
    const refused = fakeGh(checked(), output({ data: { addPullRequestReview: null }, errors: [{ type: 'UNPROCESSABLE', message: 'Pull request is locked' }] }, 1))
    await expect(provider(refused.run).writeReview(pull(7), write, signal))
      .resolves.toEqual({ ok: false, code: 'failed', message: 'Pull request is locked' })
    expect(refused.calls).toHaveLength(2)

    const odd = fakeGh(checked(), payload('addPullRequestReview', { pullRequestReview: null }))
    await expect(provider(odd.run).writeReview(pull(7), write, signal))
      .resolves.toEqual({ ok: false, code: 'unknown', message: 'unexpected GitHub response to starting a pending review' })
    expect(odd.calls).toHaveLength(2)
  })

  it.each([
    [true, RESOLVE_MUTATION, 'resolveReviewThread'],
    [false, UNRESOLVE_MUTATION, 'unresolveReviewThread'],
  ] as const)('marks a thread resolved %s through its mutation', async (resolved, query, field) => {
    const gh = fakeGh(checked(), payload(field, { thread: { id: thread } }))

    await expect(provider(gh.run).writeReview(pull(7), { kind: 'resolve', headSha: head, thread, resolved }, signal)).resolves.toEqual({ ok: true })
    expect(gh.calls[1]?.input).toEqual({ query, variables: { thread } })
  })

  it('edits and deletes a comment', async () => {
    const edit = fakeGh(checked(), payload('updatePullRequestReviewComment'))
    await provider(edit.run).writeReview(pull(7), { kind: 'edit-comment', headSha: head, comment, body: 'Reworded' }, signal)
    expect(edit.calls[1]?.input).toEqual({ query: EDIT_COMMENT_MUTATION, variables: { comment, body: 'Reworded' } })

    const remove = fakeGh(checked(), payload('deletePullRequestReviewComment', { clientMutationId: null }))
    await expect(provider(remove.run).writeReview(pull(7), { kind: 'delete-comment', headSha: head, comment }, signal)).resolves.toEqual({ ok: true })
    expect(remove.calls[1]?.input).toEqual({ query: DELETE_COMMENT_MUTATION, variables: { comment } })
  })

  it('starts a pending review at the head holding a new comment when the viewer has none', async () => {
    const gh = fakeGh(checked(), payload('addPullRequestReview', { pullRequestReview: { id: 'review-new' } }))

    await provider(gh.run).writeReview(pull(7), { kind: 'add-pending', headSha: head,
      comment: { path: 'src/a.ts', side: 'L', startLine: 3, endLine: 5, body: 'Range' } }, signal)

    expect(gh.calls[1]?.input).toEqual({ query: ADD_REVIEW_MUTATION, variables: { pull: 'pull-7', commit: head, threads: [
      { path: 'src/a.ts', body: 'Range', line: 5, side: 'LEFT', startLine: 3, startSide: 'LEFT' },
    ] } })
  })

  it('adds a new single-line comment to the existing pending review', async () => {
    const gh = fakeGh(checked('review-9'), payload('addPullRequestReviewThread', { thread: { id: 'thread-new' } }))

    await provider(gh.run).writeReview(pull(7), { kind: 'add-pending', headSha: head,
      comment: { path: 'src/a.ts', side: 'R', startLine: 8, endLine: 8, body: 'Line' } }, signal)

    expect(gh.calls[1]?.input).toEqual({ query: ADD_THREAD_MUTATION, variables: {
      review: 'review-9', path: 'src/a.ts', body: 'Line', line: 8, side: 'RIGHT', startLine: null, startSide: null,
    } })
  })

  it.each([
    ['comment', 'COMMENT'], ['approve', 'APPROVE'], ['request-changes', 'REQUEST_CHANGES'],
  ] as const)('submits the pending review as a %s review', async (event, graphqlEvent) => {
    const gh = fakeGh(checked(review), payload('submitPullRequestReview', { pullRequestReview: { id: review } }))

    await expect(provider(gh.run).writeReview(pull(7), { kind: 'submit-pending', headSha: head, review, event, body: 'Summary' }, signal))
      .resolves.toEqual({ ok: true })
    expect(gh.calls[1]?.input).toEqual({ query: SUBMIT_REVIEW_MUTATION, variables: { review, event: graphqlEvent, body: 'Summary' } })
  })

  it('discards the pending review', async () => {
    const gh = fakeGh(checked(review), payload('deletePullRequestReview', { pullRequestReview: { id: review } }))

    await expect(provider(gh.run).writeReview(pull(7), { kind: 'discard-pending', headSha: head, review }, signal)).resolves.toEqual({ ok: true })
    expect(gh.calls[1]?.input).toEqual({ query: DELETE_REVIEW_MUTATION, variables: { review } })
  })

  it.each([
    ['submit', { kind: 'submit-pending', headSha: head, review, event: 'comment', body: '' }],
    ['discard', { kind: 'discard-pending', headSha: head, review }],
  ] as const)('refuses to %s a pending review that is no longer the viewer\'s without a mutation', async (_label, write) => {
    for (const pending of [null, 'review-other']) {
      const gh = fakeGh(checked(pending))
      await expect(provider(gh.run).writeReview(pull(7), write, signal))
        .resolves.toEqual({ ok: false, code: 'failed', message: 'the pending review review-1 is no longer the signed-in user\'s pending review' })
      expect(gh.calls).toHaveLength(1)
    }
  })

  it('refuses a moved head without a mutation and accepts a head in another case', async () => {
    const write: ForgeReviewWrite = { kind: 'resolve', headSha: head, thread, resolved: true }
    const moved = fakeGh(checked(null, pushed))
    await expect(provider(moved.run).writeReview(pull(7), write, signal))
      .resolves.toEqual({ ok: false, code: 'stale', message: `the pull request head moved from ${head} to ${pushed}` })
    expect(moved.calls).toHaveLength(1)

    const upper = fakeGh(checked(null, head.toUpperCase()), payload('resolveReviewThread'))
    await expect(provider(upper.run).writeReview(pull(7), write, signal)).resolves.toEqual({ ok: true })
  })

  it('checks without a target for a write to the pending review', async () => {
    const gh = fakeGh(checked(review), payload('deletePullRequestReview', { pullRequestReview: { id: review } }))

    await provider(gh.run).writeReview(pull(7), { kind: 'discard-pending', headSha: head, review }, signal)

    expect(gh.calls[0]?.args).toEqual(['api', 'graphql', '--hostname', 'github.com', '-f', `query=${WRITE_CHECK_QUERY}`,
      '-f', `owner=${demo.owner}`, '-f', `name=${demo.name}`, '-F', 'number=7'])
  })

  it.each([
    ['another pull request', { pullRequest: { id: 'pull-8' } }],
    ['nothing GitHub knows', null],
    ['a node that is not a thread or comment', {}],
  ] as const)('refuses a thread or comment on %s without a mutation', async (_label, target) => {
    const writes: ReadonlyArray<readonly [ForgeReviewWrite, string]> = [
      [{ kind: 'reply', headSha: head, thread, body: 'Hi', pending: false }, thread],
      [{ kind: 'resolve', headSha: head, thread, resolved: true }, thread],
      [{ kind: 'edit-comment', headSha: head, comment, body: 'Text' }, comment],
      [{ kind: 'delete-comment', headSha: head, comment }, comment],
    ]
    for (const [write, named] of writes) {
      const gh = fakeGh(checked(null, head, true, target))
      await expect(provider(gh.run).writeReview(pull(7), write, signal))
        .resolves.toEqual({ ok: false, code: 'failed', message: `${named} is not a review thread or comment of pull request 7` })
      expect(gh.calls).toHaveLength(1)
    }
  })

  it('reports a failed or unexpected check as failed without a mutation', async () => {
    const write: ForgeReviewWrite = { kind: 'resolve', headSha: head, thread, resolved: true }
    const down = fakeGh(output('', 1, 'gh: Server Error (HTTP 502)'))
    await expect(provider(down.run).writeReview(pull(7), write, signal))
      .resolves.toEqual({ ok: false, code: 'failed', message: 'gh: Server Error (HTTP 502)' })

    const odd = fakeGh(output({ data: { repository: { pullRequest: null } } }))
    await expect(provider(odd.run).writeReview(pull(7), write, signal))
      .resolves.toEqual({ ok: false, code: 'failed', message: 'unexpected GitHub response to the pull request check' })
    expect([down.calls, odd.calls].map(calls => calls.length)).toEqual([1, 1])
  })

  it.each([
    ['a gh that cannot start', { throws: new GhUnavailableError('gh could not start: ENOENT') }, 'failed', 'gh could not start: ENOENT'],
    ['a gh that times out', { throws: new GhTimeoutError('gh api timed out after 30000ms') }, 'unknown', 'gh api timed out after 30000ms'],
    ['a thrown value that is not an error', { throws: 'lost' }, 'unknown', 'lost'],
    ['GraphQL refusals', output({ data: { resolveReviewThread: null }, errors: [{ type: 'NOT_FOUND', message: 'one' }, { type: 'FORBIDDEN', message: 'two' }] }, 1),
      'failed', 'one; two'],
    ['a GraphQL error without a type, as for a timeout', output({ data: null, errors: [{ message: 'Something went wrong while executing your query' }] }, 1),
      'unknown', 'Something went wrong while executing your query'],
    ['a refusal beside an error of another type', output({ errors: [{ type: 'UNPROCESSABLE', message: 'one' }, { type: 'INTERNAL', message: 'two' }] }, 1),
      'unknown', 'one; two'],
    ['an HTTP refusal', output('', 1, 'gh: Validation Failed (HTTP 422)'), 'failed', 'gh: Validation Failed (HTTP 422)'],
    ['a server error', output('', 1, 'gh: Server Error (HTTP 502)'), 'unknown', 'gh: Server Error (HTTP 502)'],
    ['a failure printed on stdout', output('connection reset', 1), 'unknown', 'connection reset'],
    ['a failure without output', output('', 1), 'unknown', 'gh exited with 1'],
    ['an answer that is not JSON', output('<html>'), 'unknown', 'unexpected GitHub response to resolveReviewThread'],
    ['an empty payload', payload('resolveReviewThread', null), 'unknown', 'unexpected GitHub response to resolveReviewThread'],
  ] as const)('reports a mutation ending in %s as %s', async (_label, answer, code, message) => {
    const gh = fakeGh(checked(), answer)

    await expect(provider(gh.run).writeReview(pull(7), { kind: 'resolve', headSha: head, thread, resolved: true }, signal))
      .resolves.toEqual({ ok: false, code, message })
  })

  it('treats a payload beside errors about its fields as applied', async () => {
    const gh = fakeGh(checked(), output({ data: { resolveReviewThread: { thread: null } }, errors: [{ message: 'thread is not visible' }] }))

    await expect(provider(gh.run).writeReview(pull(7), { kind: 'resolve', headSha: head, thread, resolved: true }, signal))
      .resolves.toEqual({ ok: true })
  })

  it('throws the abort reason when the signal aborts before a mutation is sent', async () => {
    const controller = new AbortController()
    const reason = new Error('closed')
    const run: GhRunner = async () => { controller.abort(reason); return checked() }

    await expect(provider(run).writeReview(pull(7), { kind: 'resolve', headSha: head, thread, resolved: true }, controller.signal)).rejects.toBe(reason)
  })

  it('refuses an unconfigured host without starting gh and a head that is not a commit object name', async () => {
    const gh = fakeGh(checked())
    const write: ForgeReviewWrite = { kind: 'resolve', headSha: head, thread, resolved: true }

    await expect(provider(gh.run).writeReview(pull(7, { ...demo, host: 'ghe.other.example' }), write, signal))
      .resolves.toEqual({ ok: false, code: 'failed', message: 'forge-github: host "ghe.other.example" is not configured' })
    await expect(provider(gh.run).writeReview(pull(7), { ...write, headSha: 'main' }, signal)).rejects.toThrow('forge-github: invalid head commit "main"')
    expect(gh.calls).toEqual([])
  })
})
