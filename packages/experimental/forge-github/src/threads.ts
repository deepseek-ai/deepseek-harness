/** Reads the review threads of a GitHub pull request at one head commit through GraphQL. */

import { Buffer } from 'node:buffer'
import type {
  ChangeRequestRef, ForgeAnchor, ForgeCommentId, ForgeFailure, ForgeReviewComment, ForgeReviewData, ForgeReviewId, ForgeReviewThread,
  ForgeThreadId,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GraphqlReader } from './commits.ts'
import { checkedRepository, isCommit } from './urls.ts'

/** Most nodes GitHub returns in one connection page. */
const PAGE_SIZE = 100

/** Repository permissions that may comment on a locked conversation. */
const WRITERS: ReadonlySet<string> = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

const COMMENT_FIELDS = 'id state createdAt url body viewerCanUpdate viewerCanDelete author { __typename login avatarUrl(size: 48) }'

const COMMENT_PAGE = `comments(first: ${PAGE_SIZE}, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }`

/**
 * Thread fields. `root` reads the commits and diff hunk of the first comment once, since replies repeat them; the
 * first page of comments starts without a cursor.
 */
const THREAD_FIELDS = `id isOutdated isResolved path diffSide startDiffSide line startLine originalLine originalStartLine subjectType
  viewerCanReply viewerCanResolve viewerCanUnresolve
  root: comments(first: 1) { nodes { diffHunk commit { oid } originalCommit { oid } } }
  ${COMMENT_PAGE.replace(', after: $cursor', '')}`

const THREAD_PAGE = `pageInfo { hasNextPage endCursor } nodes { ${THREAD_FIELDS} }`

/**
 * First thread page with the head, the viewer, whether the viewer may comment, and the viewer's pending review; variables
 * `owner` and `name` are strings, `number` and `first` integers.
 */
export const REVIEW_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    isArchived viewerPermission
    pullRequest(number: $number) {
      id headRefOid locked
      reviews(states: PENDING, first: 100) { nodes { id viewerDidAuthor comments { totalCount } } }
      reviewThreads(first: $first) { ${THREAD_PAGE} }
    }
  }
}`

/** Following thread page with the head it was read at; variables `id` and `cursor` are strings, `first` an integer. */
export const REVIEW_THREADS_QUERY = `query($id: ID!, $cursor: String!, $first: Int!) {
  node(id: $id) { ... on PullRequest { headRefOid reviewThreads(first: $first, after: $cursor) { ${THREAD_PAGE} } } }
}`

/** Following comment page of one thread; variables `id` and `cursor` are strings. */
export const THREAD_COMMENTS_QUERY = `query($id: ID!, $cursor: String!) {
  node(id: $id) { ... on PullRequestReviewThread { ${COMMENT_PAGE} } }
}`

/** Bounds of one review read. */
export interface ReviewLimits {
  /** Most threads read. */
  readonly maxReviewThreads: number
  /**
   * Most JSON bytes of all pages together: a later page that would pass it ends the read as truncated, and a first
   * page whose output alone passes it fails the read as `too-large`.
   */
  readonly maxOutputBytes: number
}

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })

const commitSchema = z.object({ oid: z.string().refine(isCommit) }).nullable()

const commentSchema = z.object({
  id: z.string(),
  state: z.string(),
  createdAt: z.string(),
  url: z.string().nullable(),
  body: z.string(),
  viewerCanUpdate: z.boolean(),
  viewerCanDelete: z.boolean(),
  author: z.object({ __typename: z.string(), login: z.string(), avatarUrl: z.string().nullable() }).nullable(),
})

const commentPageSchema = z.object({ pageInfo: pageInfoSchema, nodes: z.array(commentSchema) })

const threadSchema = z.object({
  id: z.string(),
  isOutdated: z.boolean(),
  isResolved: z.boolean(),
  path: z.string(),
  diffSide: z.string(),
  startDiffSide: z.string().nullable(),
  line: z.number().int().nullable(),
  startLine: z.number().int().nullable(),
  originalLine: z.number().int().nullable(),
  originalStartLine: z.number().int().nullable(),
  subjectType: z.string(),
  viewerCanReply: z.boolean(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  root: z.object({ nodes: z.array(z.object({ diffHunk: z.string(), commit: commitSchema, originalCommit: commitSchema })) }),
  comments: commentPageSchema,
})

const threadPageSchema = z.object({ pageInfo: pageInfoSchema, nodes: z.array(threadSchema) })

const pendingSchema = z.object({
  id: z.string(),
  viewerDidAuthor: z.boolean(),
  comments: z.object({ totalCount: z.number().int().nonnegative() }),
})

const pullRequestSchema = z.object({
  id: z.string(),
  headRefOid: z.string(),
  locked: z.boolean(),
  reviews: z.object({ nodes: z.array(pendingSchema) }),
  reviewThreads: threadPageSchema,
})

const firstPageSchema = z.object({ data: z.object({
  viewer: z.object({ login: z.string() }).nullable(),
  repository: z.object({
    isArchived: z.boolean(),
    viewerPermission: z.string().nullable(),
    pullRequest: pullRequestSchema.nullable(),
  }).nullable(),
}) })

const nextPageSchema = z.object({ data: z.object({ node: z.object({ headRefOid: z.string(), reviewThreads: threadPageSchema }) }) })

const commentsPageSchema = z.object({ data: z.object({ node: z.object({ comments: commentPageSchema }) }) })

type ThreadNode = z.infer<typeof threadSchema>
type CommentNode = z.infer<typeof commentSchema>

/**
 * Read the review threads of a pull request while its head is `headSha`. The first page also names the head; every
 * following thread page names the head again, so a head that moves during the read returns
 * `stale`, while a thread's comment pages do not. Threads are read up to `maxReviewThreads`, each with all of its
 * comments. A later page that would bring the pages read, measured as JSON, past `maxOutputBytes` is dropped with the
 * threads after it, and the result is marked truncated; `read` fails a first page whose output alone passes the limit.
 * @param read - runs one GraphQL request.
 * @param ref - pull request, with an owner and name already checked for inlining.
 * @param headSha - head commit the threads must be read at.
 * @param limits - thread and byte bounds.
 * @param signal - cancellation of the read.
 * @returns the threads, or why GitHub did not provide them at `headSha`.
 */
export async function readReviewThreads(
  read: GraphqlReader, ref: ChangeRequestRef, headSha: string, limits: ReviewLimits, signal: AbortSignal,
): Promise<ForgeReviewData | ForgeFailure> {
  const { host, owner, name } = checkedRepository(ref)
  const graphql = async (variables: readonly string[]): Promise<{ readonly body: unknown; readonly bytes: number } | ForgeFailure> => {
    const output = await read(['api', 'graphql', '--hostname', host, ...variables], signal)
    if (!output.ok) return output.failure
    return { body: output.body, bytes: Buffer.byteLength(JSON.stringify(output.body)) }
  }
  const unexpected: ForgeFailure = { code: 'unavailable', message: 'unexpected GitHub response to the review thread read' }
  const stale = (head: string): ForgeFailure | undefined => head.toLowerCase() === headSha.toLowerCase() ? undefined
    : { code: 'stale', message: `the pull request head moved from ${headSha} to ${head}` }
  const first = await graphql(['-f', `query=${REVIEW_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
    '-F', `number=${ref.number}`, '-F', `first=${Math.min(PAGE_SIZE, limits.maxReviewThreads)}`])
  if ('code' in first) return first
  const parsed = firstPageSchema.safeParse(first.body)
  if (!parsed.success) return unexpected
  const repository = parsed.data.data.repository
  const pull = repository?.pullRequest
  if (repository == null || pull == null) return { code: 'not-found', message: `pull request ${ref.number} was not found` }
  const moved = stale(pull.headRefOid)
  if (moved !== undefined) return moved
  let bytes = first.bytes
  let page = pull.reviewThreads
  const threads: ForgeReviewThread[] = []
  const viewer = parsed.data.data.viewer?.login ?? null
  // GitHub lists a pending review only to its author; reading up to 100 finds the viewer's even if others were listed first.
  const pending = pull.reviews.nodes.find(review => review.viewerDidAuthor)
  const pendingReview = pending === undefined ? null : { id: pending.id as ForgeReviewId, comments: pending.comments.totalCount }
  // GitHub refuses every write to an archived repository, and comments on a locked conversation from anyone without write access.
  const viewerCanReview = !repository.isArchived && (!pull.locked || WRITERS.has(repository.viewerPermission ?? ''))
  const result = (truncated: boolean): ForgeReviewData => ({ headSha, viewer, threads, truncated, pendingReview, viewerCanReview })
  const cursors = new Set<string>()
  for (;;) {
    for (const node of page.nodes.slice(0, limits.maxReviewThreads - threads.length)) {
      const comments = [...node.comments.nodes]
      const commentCursors = new Set<string>()
      let more = node.comments.pageInfo
      while (more.hasNextPage) {
        const cursor = more.endCursor
        if (cursor === null || commentCursors.has(cursor)) return { code: 'unavailable', message: 'GitHub review comment pagination did not advance' }
        commentCursors.add(cursor)
        const next = await graphql(['-f', `query=${THREAD_COMMENTS_QUERY}`, '-f', `id=${node.id}`, '-f', `cursor=${cursor}`])
        if ('code' in next) return next
        const comment = commentsPageSchema.safeParse(next.body)
        if (!comment.success) return unexpected
        bytes += next.bytes
        if (bytes > limits.maxOutputBytes) return result(true)
        comments.push(...comment.data.data.node.comments.nodes)
        more = comment.data.data.node.comments.pageInfo
      }
      if (comments.length > 0) threads.push(toThread(node, comments, headSha))
    }
    if (threads.length >= limits.maxReviewThreads || !page.pageInfo.hasNextPage) return result(page.pageInfo.hasNextPage)
    const cursor = page.pageInfo.endCursor
    if (cursor === null || cursors.has(cursor)) return { code: 'unavailable', message: 'GitHub review thread pagination did not advance' }
    cursors.add(cursor)
    const next = await graphql(['-f', `query=${REVIEW_THREADS_QUERY}`, '-f', `id=${pull.id}`, '-f', `cursor=${cursor}`,
      '-F', `first=${Math.min(PAGE_SIZE, limits.maxReviewThreads - threads.length)}`])
    if ('code' in next) return next
    const following = nextPageSchema.safeParse(next.body)
    if (!following.success) return unexpected
    const movedLater = stale(following.data.data.node.headRefOid)
    if (movedLater !== undefined) return movedLater
    bytes += next.bytes
    if (bytes > limits.maxOutputBytes) return result(true)
    page = following.data.data.node.reviewThreads
  }
}

/**
 * Map one thread. GitHub keeps a thread's `line` on the commit of its first comment, which stays an older commit for
 * a comment written on a commit the head no longer is; such a thread, like one GitHub marks outdated or leaves
 * without a line, has no position at `head`. A range whose start is on the other side of the diff keeps its last line.
 */
function toThread(node: ThreadNode, comments: readonly CommentNode[], head: string): ForgeReviewThread {
  const root = node.root.nodes[0]
  const line = node.subjectType !== 'FILE'
  const sameSide = node.startDiffSide === null || node.startDiffSide === node.diffSide
  const placed = line && !node.isOutdated && node.line !== null && root?.commit?.oid.toLowerCase() === head.toLowerCase()
  return {
    id: node.id as ForgeThreadId,
    path: node.path,
    side: node.diffSide === 'LEFT' ? 'L' : 'R',
    subject: line ? 'line' : 'file',
    current: placed && node.line !== null ? anchor(head, sameSide ? node.startLine : null, node.line) : null,
    original: line && node.originalLine !== null && root?.originalCommit != null
      ? anchor(root.originalCommit.oid, sameSide ? node.originalStartLine : null, node.originalLine) : null,
    diffHunk: root === undefined || root.diffHunk === '' ? null : root.diffHunk,
    resolved: node.isResolved,
    viewerCanReply: node.viewerCanReply,
    viewerCanResolve: node.isResolved ? node.viewerCanUnresolve : node.viewerCanResolve,
    comments: comments.map(toComment),
  }
}

function anchor(commit: string, start: number | null, end: number): ForgeAnchor {
  return { commit, startLine: start !== null && start >= 1 && start <= end ? start : end, endLine: end }
}

function toComment(node: CommentNode): ForgeReviewComment {
  return {
    id: node.id as ForgeCommentId,
    author: node.author === null ? null : { login: node.author.login, avatarUrl: node.author.avatarUrl, bot: node.author.__typename === 'Bot' },
    body: node.body,
    createdAt: node.createdAt,
    pending: node.state === 'PENDING',
    url: node.url,
    viewerCanEdit: node.viewerCanUpdate,
    viewerCanDelete: node.viewerCanDelete,
  }
}
