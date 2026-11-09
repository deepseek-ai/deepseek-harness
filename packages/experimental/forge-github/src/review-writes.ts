/** GitHub writes to review threads and the pending review through GraphQL mutations, each after a check of the head. */

import type {
  ChangeRequestRef, ForgeLineComment, ForgeReviewId, ForgeReviewWrite, ForgeReviewWriteResult,
} from '@deepseek-ai/dsh-experimental-forge'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { GraphqlReader } from './commits.ts'
import { GhUnavailableError, type GhOutput, type GhRunner } from './gh.ts'
import { checkedRepository } from './urls.ts'

/**
 * Pull request fields every write checks: its id, its head, and its pending reviews. GitHub lists a pending review only
 * to its author, who has at most one per pull request; the page reads the most GitHub returns, so the viewer's review is
 * found by `viewerDidAuthor` even if another user's were listed first.
 */
const CHECKED_PULL = 'id headRefOid reviews(states: PENDING, first: 100) { nodes { id viewerDidAuthor } }'

/** The pull request, its head, and the signed-in user's pending review; variables `owner` and `name` are strings, `number` an integer. */
export const WRITE_CHECK_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${CHECKED_PULL} } }
}`

/** The same check plus the pull request that holds the thread or comment `target`, a string variable. */
export const WRITE_TARGET_CHECK_QUERY = `query($owner: String!, $name: String!, $number: Int!, $target: ID!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${CHECKED_PULL} } }
  target: node(id: $target) { ... on PullRequestReviewThread { pullRequest { id } } ... on PullRequestReviewComment { pullRequest { id } } }
}`

/** Start a pending review at a commit, with the line threads of `threads`. */
export const ADD_REVIEW_MUTATION = `mutation($pull: ID!, $commit: GitObjectID!, $threads: [DraftPullRequestReviewThread]) {
  addPullRequestReview(input: { pullRequestId: $pull, commitOID: $commit, threads: $threads }) { pullRequestReview { id } }
}`

/** Add one line thread to a pending review. */
export const ADD_THREAD_MUTATION = `mutation($review: ID!, $path: String!, $body: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $review, path: $path, body: $body, line: $line, side: $side, startLine: $startLine, startSide: $startSide
  }) { thread { id } }
}`

/** Reply to a thread, inside the pending review `review` when it is set. */
export const REPLY_MUTATION = `mutation($thread: ID!, $body: String!, $review: ID) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body, pullRequestReviewId: $review }) { comment { id } }
}`

/** Mark a thread resolved. */
export const RESOLVE_MUTATION = 'mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id } } }'

/** Mark a thread unresolved. */
export const UNRESOLVE_MUTATION = 'mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id } } }'

/** Replace the text of a review comment. */
export const EDIT_COMMENT_MUTATION = `mutation($comment: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $comment, body: $body }) { pullRequestReviewComment { id } }
}`

/** Delete a review comment. */
export const DELETE_COMMENT_MUTATION = 'mutation($comment: ID!) { deletePullRequestReviewComment(input: { id: $comment }) { clientMutationId } }'

/** Submit a pending review with a decision and summary. */
export const SUBMIT_REVIEW_MUTATION = `mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $review, event: $event, body: $body }) { pullRequestReview { id } }
}`

/** Delete a pending review with its comments. */
export const DELETE_REVIEW_MUTATION = 'mutation($review: ID!) { deletePullRequestReview(input: { pullRequestReviewId: $review }) { pullRequestReview { id } } }'

const EVENTS = { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' } as const

/** HTTP statuses that mean GitHub refused the request, so it changed nothing. */
const REFUSED = /\(HTTP (?:400|401|403|404|409|422)\)/

/**
 * GraphQL error types that mean GitHub refused a mutation before applying it. An error without one of them, such as
 * GitHub's "Something went wrong … may be the result of a timeout", leaves the outcome unknown.
 */
const REFUSALS: ReadonlySet<string> = new Set(['FORBIDDEN', 'INSUFFICIENT_SCOPES', 'NOT_FOUND', 'RATE_LIMITED', 'UNPROCESSABLE'])

const checkSchema = z.object({ data: z.object({
  repository: z.object({ pullRequest: z.object({
    id: z.string(),
    headRefOid: z.string(),
    reviews: z.object({ nodes: z.array(z.object({ id: z.string(), viewerDidAuthor: z.boolean() })) }),
  }) }),
  target: z.object({ pullRequest: z.object({ id: z.string() }).optional() }).nullable().optional(),
}) })

const graphqlErrors = z.object({ errors: z.array(z.object({ message: z.string(), type: z.string().optional() })).min(1) })

/** One mutation and the payload field that holds its result. */
interface Mutation {
  readonly query: string
  readonly field: string
  readonly variables: Readonly<Record<string, unknown>>
}

/** A mutation's result: the payload on success, else the write's outcome. */
type Sent = { readonly ok: true; readonly payload: unknown } | Extract<ForgeReviewWriteResult, { readonly ok: false }>

const stringId = z.object({ id: z.string() })

/**
 * Write to the review threads or the pending review of a pull request. One read first checks that the head is still
 * `write.headSha`, finds the signed-in user's pending review, and, for a write to a thread or comment, that the pull
 * request holds it; a moved head returns `stale` and a thread or comment elsewhere `failed`, both without writing. A
 * pending reply without a pending review first starts an empty one at `write.headSha`; when the reply then fails, that
 * empty review stays. A reply at once is refused with `failed` while the user has a pending review, since GitHub would
 * add it to that review. Mutations send their variables as JSON on stdin, and none is retried: a refusal GitHub reports
 * returns `failed`, and an answer that does not show whether GitHub applied a mutation returns `unknown`.
 * @param read - runs the check as one GraphQL request.
 * @param gh - bounded, cancellable GitHub CLI runner for the mutations.
 * @param ref - pull request, with an owner and name already checked for inlining.
 * @param write - the write and the head commit the user saw.
 * @param signal - cancellation of the check and the mutations.
 * @returns whether GitHub took the write.
 * @throws with `signal.reason` when the signal aborts before a mutation is sent.
 */
export async function writeGitHubReview(
  read: GraphqlReader, gh: GhRunner, ref: ChangeRequestRef, write: ForgeReviewWrite, signal: AbortSignal,
): Promise<ForgeReviewWriteResult> {
  const { host, owner, name } = checkedRepository(ref)
  const target = targetOf(write)
  const checked = await read(['api', 'graphql', '--hostname', host,
    '-f', `query=${target === null ? WRITE_CHECK_QUERY : WRITE_TARGET_CHECK_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
    '-F', `number=${ref.number}`, ...target === null ? [] : ['-f', `target=${target}`]], signal)
  if (!checked.ok) return { ok: false, code: 'failed', message: checked.failure.message }
  const parsed = checkSchema.safeParse(checked.body)
  if (!parsed.success) return { ok: false, code: 'failed', message: 'unexpected GitHub response to the pull request check' }
  const pull = parsed.data.data.repository.pullRequest
  if (pull.headRefOid.toLowerCase() !== write.headSha.toLowerCase()) {
    return { ok: false, code: 'stale', message: `the pull request head moved from ${write.headSha} to ${pull.headRefOid}` }
  }
  if (target !== null && parsed.data.data.target?.pullRequest?.id !== pull.id) {
    return { ok: false, code: 'failed', message: `${target} is not a review thread or comment of pull request ${ref.number}` }
  }
  const pending = pull.reviews.nodes.find(review => review.viewerDidAuthor)?.id ?? null
  signal.throwIfAborted()
  const send = async (mutation: Mutation): Promise<Sent> => await sendMutation(gh, host, mutation, signal)
  const done = (sent: Sent): ForgeReviewWriteResult => sent.ok ? { ok: true } : sent
  /** Find the pending review, starting one at the head without threads when the user has none. */
  const pendingReview = async (): Promise<{ readonly ok: true; readonly id: string } | Extract<Sent, { readonly ok: false }>> => {
    if (pending !== null) return { ok: true, id: pending }
    const started = await send({ query: ADD_REVIEW_MUTATION, field: 'addPullRequestReview',
      variables: { pull: pull.id, commit: write.headSha, threads: null } })
    if (!started.ok) return started
    const review = z.object({ pullRequestReview: stringId }).safeParse(started.payload)
    return review.success ? { ok: true, id: review.data.pullRequestReview.id }
      : { ok: false, code: 'unknown', message: 'unexpected GitHub response to starting a pending review' }
  }
  switch (write.kind) {
    case 'reply': {
      // GitHub adds every reply of a user with a pending review to that review, even one sent without its id.
      if (!write.pending && pending !== null) {
        return { ok: false, code: 'failed', message: 'GitHub adds a reply to the pending review while one exists; submit or discard it first' }
      }
      const review = write.pending ? await pendingReview() : { ok: true as const, id: null }
      if (!review.ok) return review
      return done(await send({ query: REPLY_MUTATION, field: 'addPullRequestReviewThreadReply',
        variables: { thread: write.thread, body: write.body, review: review.id } }))
    }
    case 'resolve':
      return done(await send(write.resolved
        ? { query: RESOLVE_MUTATION, field: 'resolveReviewThread', variables: { thread: write.thread } }
        : { query: UNRESOLVE_MUTATION, field: 'unresolveReviewThread', variables: { thread: write.thread } }))
    case 'edit-comment':
      return done(await send({ query: EDIT_COMMENT_MUTATION, field: 'updatePullRequestReviewComment',
        variables: { comment: write.comment, body: write.body } }))
    case 'delete-comment':
      return done(await send({ query: DELETE_COMMENT_MUTATION, field: 'deletePullRequestReviewComment', variables: { comment: write.comment } }))
    case 'add-pending':
      return done(await send(pending === null
        ? { query: ADD_REVIEW_MUTATION, field: 'addPullRequestReview',
          variables: { pull: pull.id, commit: write.headSha, threads: [draftThread(write.comment)] } }
        : { query: ADD_THREAD_MUTATION, field: 'addPullRequestReviewThread', variables: { review: pending, ...draftThread(write.comment) } }))
    case 'submit-pending':
      if (pending !== write.review) return missingReview(write.review)
      return done(await send({ query: SUBMIT_REVIEW_MUTATION, field: 'submitPullRequestReview',
        variables: { review: write.review, event: EVENTS[write.event], body: write.body } }))
    case 'discard-pending':
      if (pending !== write.review) return missingReview(write.review)
      return done(await send({ query: DELETE_REVIEW_MUTATION, field: 'deletePullRequestReview', variables: { review: write.review } }))
    /* v8 ignore next -- closed ForgeReviewWrite kind union exhaustiveness guard */
    default: return assertNever(write, 'ForgeReviewWrite.kind')
  }
}

/** The thread or comment a write changes, or null for a write to the pull request's pending review. */
function targetOf(write: ForgeReviewWrite): string | null {
  switch (write.kind) {
    case 'reply':
    case 'resolve': return write.thread
    case 'edit-comment':
    case 'delete-comment': return write.comment
    case 'add-pending':
    case 'submit-pending':
    case 'discard-pending': return null
    /* v8 ignore next -- closed ForgeReviewWrite kind union exhaustiveness guard */
    default: return assertNever(write, 'ForgeReviewWrite.kind')
  }
}

/** The fields of a line thread in a pending review, for one side of the diff. */
function draftThread(comment: ForgeLineComment): Readonly<Record<string, unknown>> {
  const side = comment.side === 'L' ? 'LEFT' : 'RIGHT'
  return { path: comment.path, body: comment.body, line: comment.endLine, side,
    ...comment.startLine === comment.endLine ? { startLine: null, startSide: null } : { startLine: comment.startLine, startSide: side } }
}

function missingReview(review: ForgeReviewId): ForgeReviewWriteResult {
  return { ok: false, code: 'failed', message: `the pending review ${review} is no longer the signed-in user's pending review` }
}

/**
 * Send one mutation with its query and variables as JSON on stdin.
 * @returns the payload of `mutation.field`; `failed` when GitHub reports a refusal by its HTTP status or GraphQL error
 * type, or `gh` cannot start, else `unknown`.
 */
async function sendMutation(gh: GhRunner, host: string, mutation: Mutation, signal: AbortSignal): Promise<Sent> {
  let output: GhOutput
  try {
    output = await gh(['api', 'graphql', '--hostname', host, '--input', '-'], signal,
      JSON.stringify({ query: mutation.query, variables: mutation.variables }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: error instanceof GhUnavailableError ? 'failed' : 'unknown', message }
  }
  const body = parse(output.stdout)
  // A payload means GitHub applied the mutation, even beside errors about the fields it selects.
  const payload = z.object({ data: z.record(z.string(), z.unknown()) }).safeParse(body)
  const value = payload.success ? payload.data.data[mutation.field] : undefined
  if (value !== undefined && value !== null) return { ok: true, payload: value }
  const errors = graphqlErrors.safeParse(body)
  if (errors.success) {
    const refused = errors.data.errors.every(error => error.type !== undefined && REFUSALS.has(error.type))
    return { ok: false, code: refused ? 'failed' : 'unknown', message: errors.data.errors.map(error => error.message).join('; ') }
  }
  if (output.exitCode !== 0) {
    const message = output.stderr.trim() || output.stdout.trim() || `gh exited with ${output.exitCode}`
    return { ok: false, code: REFUSED.test(output.stderr) ? 'failed' : 'unknown', message }
  }
  return { ok: false, code: 'unknown', message: `unexpected GitHub response to ${mutation.field}` }
}

function parse(text: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    void error // gh prints diagnostics instead of JSON when a request fails before GitHub answers.
    return undefined
  }
  return value
}
