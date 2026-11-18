/** GitLab merge request discussions and the signed-in user's draft notes, mapped to forge review threads at one head commit. */

import type {
  ChangeRequestRef, ForgeAnchor, ForgeCommentAuthor, ForgeCommentId, ForgeFailure, ForgeReviewComment, ForgeReviewData, ForgeReviewEvent,
  ForgeReviewId, ForgeReviewThread, ForgeThreadId,
} from '@deepseek-ai/dsh-experimental-forge'
import { parsePatch } from 'diff'
import { z } from 'zod'
import type { GitLabApi } from './api.ts'
import { pool } from './pool.ts'
import { avatarUrlOf, checkedProject, mergeRequestPath } from './urls.ts'

/** Discussions per page; GitLab's REST and GraphQL maximum. */
const PAGE = 100

/** Diff versions read to find the version an outdated thread's lines were last seen at. */
const VERSION_PAGE = 100

/**
 * The one pending review a GitLab user has per merge request: their draft notes, which GitLab publishes together and
 * keeps without an identity of their own.
 */
export const DRAFT_REVIEW = 'draft-notes' as ForgeReviewId

/** Prefix of the comment and thread ids of draft notes, which share no id space with published notes. */
const DRAFT = 'draft-'

/**
 * Comment id of a draft note.
 * @param id - GitLab's draft note id.
 * @returns the id the forge contract carries.
 */
export function draftCommentId(id: number): ForgeCommentId {
  return `${DRAFT}${id}` as ForgeCommentId
}

/** Thread id of a draft note that starts a thread; writes to it are refused, as GitLab has no discussion for it yet. */
function draftThreadId(id: number): ForgeThreadId {
  return `${DRAFT}${id}` as ForgeThreadId
}

/**
 * Read a comment id.
 * @param id - id from a forge write.
 * @returns the GitLab note or draft note id, or undefined for an id this provider never issued.
 */
export function noteOf(id: ForgeCommentId): { readonly draft: boolean; readonly id: string } | undefined {
  if (!/^(?:draft-)?[1-9]\d{0,17}$/.test(id)) return undefined
  const draft = id.startsWith(DRAFT)
  return { draft, id: draft ? id.slice(DRAFT.length) : id }
}

/**
 * Read a thread id.
 * @param id - id from a forge write.
 * @returns GitLab's discussion id, or undefined for a draft note's thread or an id this provider never issued.
 */
export function discussionOf(id: ForgeThreadId): string | undefined {
  return /^[0-9a-f]{40}$/.test(id) ? id : undefined
}

const lineSchema = z.object({ old_line: z.number().nullable().optional(), new_line: z.number().nullable().optional() })

/** Position fields that published notes and draft notes report alike. */
const placeFields = {
  old_path: z.string().nullable(),
  new_path: z.string().nullable(),
  old_line: z.number().nullable().optional(),
  new_line: z.number().nullable().optional(),
  line_range: z.object({ start: lineSchema, end: lineSchema }).nullable().optional(),
}

const positionSchema = z.object({ base_sha: z.string(), head_sha: z.string(), position_type: z.string(), ...placeFields })

const noteSchema = z.object({
  id: z.number(),
  type: z.string().nullable(),
  body: z.string(),
  system: z.boolean(),
  created_at: z.string(),
  resolved: z.boolean().optional(),
  author: z.object({ username: z.string(), avatar_url: z.string().nullable() }).nullable(),
  position: positionSchema.nullable().optional(),
})

const discussionSchema = z.object({ id: z.string(), notes: z.array(noteSchema) })

const versionSchema = z.object({ id: z.number(), head_commit_sha: z.string(), state: z.string().optional() })

/** A draft note; GitLab reports a reply's position with every field null. */
const draftSchema = z.object({
  id: z.number(),
  discussion_id: z.string().nullable(),
  note: z.string(),
  position: z.object({
    base_sha: z.string().nullable(), head_sha: z.string().nullable(), position_type: z.string().nullable(), ...placeFields,
  }).nullable().optional(),
})

const approvalsSchema = z.object({ user_has_approved: z.boolean(), user_can_approve: z.boolean() })

/**
 * The signed-in user, their rights on a merge request, and one page of its discussions with the rights on each;
 * variables `path` and `iid` are strings, `cursor` a string or null.
 */
export const PERMISSIONS_QUERY = `query($path: ID!, $iid: String!, $cursor: String) {
  currentUser { username avatarUrl }
  project(fullPath: $path) { mergeRequest(iid: $iid) {
    userPermissions { createNote }
    reviewers(first: ${PAGE}) { nodes { username } }
    discussions(first: ${PAGE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id resolvable userPermissions { resolveNote }
        notes(first: ${PAGE}) { pageInfo { hasNextPage } nodes { id userPermissions { adminNote } } }
      }
    }
  } }
}`

const permissionsSchema = z.object({
  currentUser: z.object({ username: z.string(), avatarUrl: z.string().nullable() }).nullable(),
  project: z.object({
    mergeRequest: z.object({
      userPermissions: z.object({ createNote: z.boolean() }),
      reviewers: z.object({ nodes: z.array(z.object({ username: z.string() })) }),
      discussions: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(z.object({
          id: z.string(),
          resolvable: z.boolean(),
          userPermissions: z.object({ resolveNote: z.boolean() }),
          notes: z.object({
            pageInfo: z.object({ hasNextPage: z.boolean() }),
            nodes: z.array(z.object({ id: z.string(), userPermissions: z.object({ adminNote: z.boolean() }) })),
          }),
        })),
      }),
    }).nullable(),
  }).nullable(),
})

/** One discussion as GitLab lists it. */
type DiscussionNode = z.infer<typeof discussionSchema>

/** One draft note as GitLab lists it. */
type DraftNode = z.infer<typeof draftSchema>

/** The parts of a position this provider maps. */
type PositionNode = z.infer<typeof positionSchema>

/** Bounds of one review read. */
export interface ReviewLimits {
  /** Most threads one read returns. */
  readonly maxReviewThreads: number
  /** Most JSON bytes of all discussion pages one read keeps, and of the threads it returns. */
  readonly maxOutputBytes: number
  /** Most outdated threads whose hunks are read at once. */
  readonly maxConcurrentRequests: number
}

/** One file of the diff a thread position was last seen in. */
export interface PositionFile {
  /** The diff version at the position's head when GitLab still keeps that version's files, else null. */
  readonly version: number | null
  /** Merge base the position's diff starts at. */
  readonly baseSha: string
  /** Head the position's diff ends at. */
  readonly headSha: string
  /** Path on the old side. */
  readonly oldPath: string
  /** Path on the new side. */
  readonly newPath: string
}

/** Reads the unified patch of one file of a position's diff, or null when it cannot be read. */
export type VersionFilePatch = (file: PositionFile) => Promise<string | null>

/** The signed-in user and what they may do with the threads of one merge request. */
interface Rights {
  /** The signed-in user, or null when GitLab names none. */
  readonly viewer: { readonly username: string; readonly avatarUrl: string | null } | null
  /** Whether the user is a reviewer of the merge request. */
  readonly reviewer: boolean
  /** Whether the user may comment, which lets them reply and keep draft notes. */
  readonly comment: boolean
  /** Discussion ids the user may resolve and unresolve. */
  readonly resolve: ReadonlySet<string>
  /** Note ids the user may edit and delete. */
  readonly admin: ReadonlySet<string>
  /** Whether some discussion or note was left unread, so it grants no right it may hold. */
  readonly truncated: boolean
}

/**
 * Read the review threads of a merge request at head commit `headSha`. Discussions are read in pages of 100 up to
 * `maxReviewThreads` threads, beside the signed-in user's draft notes, their approval, and GraphQL pages of the rights
 * they hold on each discussion and note; the diff versions are read last, and the newest version must be at `headSha`,
 * else the read is `stale`, so a push during the read is detected after the threads. A thread is a discussion whose
 * first note is a diff note on a file. GitLab keeps one position per thread, the last version its lines were unchanged
 * at: a thread whose position is at `headSha` gets a `current` position, and every line thread keeps that position as
 * `original`. GitLab does not move `line_range` when it carries a thread, so a range's first line is its last line minus
 * the range's length. An outdated thread's hunk comes from the diff its position names: the diff version's file when
 * GitLab keeps it, else a comparison of the file's text at the position's merge base and head.
 *
 * Draft notes are the user's pending review: a draft reply joins its thread as a pending comment, and a draft on a file
 * position is a thread of its own whose id is the draft's. GitLab reports no creation time for a draft, so a draft's
 * comment carries the read's time. The user may review when they may comment; they may approve when GitLab lets them or
 * they already approved, and request changes only as a reviewer, since GitLab records that decision only for reviewers.
 *
 * The read is `truncated` when it stops before the last discussion page, when the rights of a discussion or a note are
 * left unread, or when the threads, with their hunks and draft notes, pass `maxOutputBytes`, in which case the threads
 * past it are dropped.
 * @param api - GitLab reads.
 * @param ref - merge request.
 * @param headSha - head commit the threads must be read at.
 * @param limits - thread and byte bounds.
 * @param filePatch - reads one file's patch at an earlier version, for outdated threads.
 * @param signal - cancellation of the read.
 * @returns the threads, or why GitLab did not provide them.
 */
export async function readReviewThreads(
  api: GitLabApi, ref: ChangeRequestRef, headSha: string, limits: ReviewLimits, filePatch: VersionFilePatch, signal: AbortSignal,
): Promise<ForgeReviewData | ForgeFailure> {
  const host = ref.repository.host
  const unexpected: ForgeFailure = { code: 'unavailable', message: 'unexpected GitLab response to the discussion read' }
  const [rights, read, listedDrafts, approvals] = await Promise.all([
    readRights(api, ref, limits, signal),
    readDiscussions(api, ref, limits, signal),
    // GitLab lists every draft note of the user at once, without pages.
    api.rest(host, `${mergeRequestPath(ref)}/draft_notes`, signal),
    api.rest(host, `${mergeRequestPath(ref)}/approvals`, signal),
  ])
  if ('code' in read) return read
  if (!listedDrafts.ok) return listedDrafts.failure
  const parsedDrafts = z.array(draftSchema).safeParse(listedDrafts.body)
  if (!parsedDrafts.success) return { code: 'unavailable', message: 'unexpected GitLab response to the draft note read' }
  const drafts = parsedDrafts.data
  if ('code' in rights) return rights
  const { discussions, truncated } = read
  const kept = discussions.slice(0, limits.maxReviewThreads)
  const versions = await api.rest(host, `${mergeRequestPath(ref)}/versions?per_page=${VERSION_PAGE}`, signal)
  if (!versions.ok) return versions.failure
  const listed = z.array(versionSchema).safeParse(versions.body)
  if (!listed.success) return unexpected
  const newest = listed.data[0]?.head_commit_sha
  if (newest?.toLowerCase() !== headSha.toLowerCase()) {
    return { code: 'stale', message: `the merge request head moved from ${headSha} to ${newest ?? 'no diff version'}` }
  }
  const { viewer } = rights
  // GitLab drops the files of a merged merge request's earlier versions, which it then reports `without_files`.
  const versionOf = new Map(listed.data.map(version => [version.head_commit_sha.toLowerCase(), version.state === 'without_files' ? null : version.id]))
  const versionAt = (head: string): number | null | undefined => versionOf.get(head.toLowerCase())
  const place = (position: PositionNode): Promise<Placement> => placementOf(position, headSha, versionAt, filePatch)
  const author: ForgeCommentAuthor | null = viewer === null ? null
    : { login: viewer.username, avatarUrl: avatarUrlOf(host, viewer.avatarUrl), bot: false }
  const readAt = new Date().toISOString()
  const pending = (draft: DraftNode): ForgeReviewComment => ({
    id: draftCommentId(draft.id), author, body: draft.note, createdAt: readAt, pending: true, url: null,
    viewerCanEdit: true, viewerCanDelete: true,
  })
  const replies = new Map<string, ForgeReviewComment[]>()
  const opened: { readonly draft: DraftNode; readonly position: PositionNode }[] = []
  for (const draft of drafts) {
    const position = draftPosition(draft)
    if (draft.discussion_id !== null) replies.set(draft.discussion_id, [...replies.get(draft.discussion_id) ?? [], pending(draft)])
    else if (position !== undefined) opened.push({ draft, position })
  }
  const sources: { readonly position: PositionNode; readonly rest: Omit<ForgeReviewThread, keyof Placement> }[] = [
    ...kept.map((discussion) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- readDiscussions keeps discussions whose first note has a position.
      const first = discussion.notes[0]!
      return {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- as above.
        position: first.position!,
        rest: {
          id: discussion.id as ForgeThreadId,
          resolved: first.resolved === true,
          viewerCanReply: rights.comment,
          viewerCanResolve: rights.resolve.has(discussion.id),
          comments: [
            ...discussion.notes.filter(note => !note.system).map(note => commentOf(ref, note, rights.admin.has(String(note.id)))),
            ...replies.get(discussion.id) ?? [],
          ],
        },
      }
    }),
    ...opened.map(({ draft, position }) => ({
      position,
      rest: { id: draftThreadId(draft.id), resolved: false, viewerCanReply: false, viewerCanResolve: false, comments: [pending(draft)] },
    })),
  ]
  const placed = new Array<ForgeReviewThread>(sources.length)
  await pool([...sources.keys()], limits.maxConcurrentRequests, async (index) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index comes from sources' own keys.
    const source = sources[index]!
    placed[index] = { ...await place(source.position), ...source.rest }
  })
  const threads = withinBytes(placed, limits.maxOutputBytes)
  const approve = approvals.ok ? approvalsSchema.safeParse(approvals.body).data : undefined
  const reviewEvents: ForgeReviewEvent[] = !rights.comment ? [] : [
    'comment',
    ...approve?.user_can_approve === true || approve?.user_has_approved === true ? ['approve' as const] : [],
    ...rights.reviewer ? ['request-changes' as const] : [],
  ]
  return {
    headSha, viewer: viewer?.username ?? null, threads, truncated: truncated || rights.truncated || threads.length < placed.length,
    pendingReview: drafts.length === 0 ? null : { id: DRAFT_REVIEW, comments: drafts.length },
    viewerCanReview: rights.comment, reviewEvents,
  }
}

/** The leading threads whose JSON fits `maxOutputBytes`. */
function withinBytes(threads: readonly ForgeReviewThread[], maxOutputBytes: number): ForgeReviewThread[] {
  let bytes = 0
  for (const [index, thread] of threads.entries()) {
    bytes += Buffer.byteLength(JSON.stringify(thread))
    if (bytes > maxOutputBytes) return threads.slice(0, index)
  }
  return [...threads]
}

/** Read discussion pages until the threads pass `maxReviewThreads`, a page is the last, or the pages pass `maxOutputBytes`. */
async function readDiscussions(
  api: GitLabApi, ref: ChangeRequestRef, limits: ReviewLimits, signal: AbortSignal,
): Promise<{ readonly discussions: DiscussionNode[]; readonly truncated: boolean } | ForgeFailure> {
  const discussions: DiscussionNode[] = []
  let bytes = 0
  for (let page = 1; ; page++) {
    const read = await api.rest(ref.repository.host, `${mergeRequestPath(ref)}/discussions?per_page=${PAGE}&page=${page}`, signal)
    if (!read.ok) return read.failure
    const parsed = z.array(discussionSchema).safeParse(read.body)
    if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitLab response to the discussion read' }
    bytes += Buffer.byteLength(JSON.stringify(read.body))
    if (bytes > limits.maxOutputBytes) {
      if (page === 1) return { code: 'too-large', message: `the discussions of merge request ${ref.number} exceed maxOutputBytes` }
      return { discussions, truncated: true }
    }
    discussions.push(...parsed.data.filter(isThread))
    if (discussions.length > limits.maxReviewThreads) return { discussions, truncated: true }
    if (parsed.data.length < PAGE) return { discussions, truncated: false }
  }
}

/**
 * Read the signed-in user, whether they may comment and are a reviewer, and their rights on every discussion and note,
 * in GraphQL pages of 100 discussions until GitLab lists no more or the pages pass `maxOutputBytes`; a discussion or note
 * the pages do not list grants no right, and the rights are then `truncated`. A page lists the first 100 notes of a
 * discussion.
 */
async function readRights(
  api: GitLabApi, ref: ChangeRequestRef, limits: ReviewLimits, signal: AbortSignal,
): Promise<Rights | ForgeFailure> {
  const unexpected: ForgeFailure = { code: 'unavailable', message: 'unexpected GitLab response to the permission read' }
  const resolve = new Set<string>()
  const admin = new Set<string>()
  let rights: Pick<Rights, 'viewer' | 'reviewer' | 'comment'> | undefined
  let cursor: string | null = null
  let bytes = 0
  let unread = false
  do {
    const variables = { path: checkedProject(ref), iid: String(ref.number), cursor }
    const read = await api.graphql(ref.repository.host, PERMISSIONS_QUERY, variables, signal)
    if (!read.ok) return read.failure
    const page = permissionsSchema.safeParse(read.body)
    if (!page.success || page.data.project?.mergeRequest == null) return unexpected
    const request = page.data.project.mergeRequest
    const viewer = page.data.currentUser
    rights ??= {
      viewer, comment: request.userPermissions.createNote,
      reviewer: viewer !== null && request.reviewers.nodes.some(entry => entry.username.toLowerCase() === viewer.username.toLowerCase()),
    }
    for (const discussion of request.discussions.nodes) {
      if (discussion.resolvable && discussion.userPermissions.resolveNote) resolve.add(tailOf(discussion.id))
      for (const note of discussion.notes.nodes) if (note.userPermissions.adminNote) admin.add(tailOf(note.id))
      unread ||= discussion.notes.pageInfo.hasNextPage
    }
    bytes += Buffer.byteLength(JSON.stringify(read.body))
    cursor = request.discussions.pageInfo.hasNextPage ? request.discussions.pageInfo.endCursor : null
  } while (cursor !== null && bytes <= limits.maxOutputBytes)
  return { ...rights, resolve, admin, truncated: unread || cursor !== null }
}

/** The last path segment of a GitLab global id, which is the REST id. */
function tailOf(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1)
}

/** Whether a discussion starts with a diff note on a text or file position. */
function isThread(discussion: DiscussionNode): boolean {
  const first = discussion.notes[0]
  return first !== undefined && first.type === 'DiffNote' && first.position != null && isFilePosition(first.position.position_type)
}

/** Whether a position is on a file's lines or the whole file, rather than an image. */
function isFilePosition(type: string | null): type is 'text' | 'file' {
  return type === 'text' || type === 'file'
}

/** The file position of a draft that starts a thread, or undefined for a reply or a draft on the overview or an image. */
function draftPosition(draft: DraftNode): PositionNode | undefined {
  const position = draft.position
  if (position == null || position.base_sha === null || position.head_sha === null) return undefined
  if (!isFilePosition(position.position_type)) return undefined
  return { ...position, base_sha: position.base_sha, head_sha: position.head_sha, position_type: position.position_type }
}

/** Where a thread is: its file, side, lines at the head and as last seen, and the hunk of an outdated thread. */
type Placement = Pick<ForgeReviewThread, 'path' | 'side' | 'subject' | 'current' | 'original' | 'diffHunk'>

/** Place a thread by its position. */
async function placementOf(
  position: PositionNode, headSha: string, versionOf: (head: string) => number | null | undefined, filePatch: VersionFilePatch,
): Promise<Placement> {
  const side = position.new_line == null && position.old_line != null ? 'L' : 'R'
  const path = (side === 'L' ? position.old_path ?? position.new_path : position.new_path ?? position.old_path) ?? ''
  const anchor = position.position_type === 'text' ? anchorOf(position, side) : null
  const current = anchor !== null && position.head_sha.toLowerCase() === headSha.toLowerCase() ? { ...anchor, commit: headSha } : null
  const diffHunk = anchor === null || current !== null ? null : hunkUntil(await filePatch({
    version: versionOf(anchor.commit) ?? null, baseSha: position.base_sha, headSha: position.head_sha,
    oldPath: position.old_path ?? path, newPath: position.new_path ?? path,
  }), side, anchor.endLine)
  return { path, side, subject: anchor === null ? 'file' : 'line', current, original: anchor, diffHunk }
}

/** The lines of a text position on the commit it names, its first line found from the range's length. */
function anchorOf(position: PositionNode, side: 'L' | 'R'): ForgeAnchor | null {
  const end = side === 'R' ? position.new_line : position.old_line
  if (end == null) return null
  const range = position.line_range
  const lineOf = (line: z.infer<typeof lineSchema>): number | null | undefined => side === 'R' ? line.new_line : line.old_line
  const rangeStart = range == null ? null : lineOf(range.start)
  const rangeEnd = range == null ? null : lineOf(range.end)
  const start = rangeStart == null || rangeEnd == null || rangeEnd < rangeStart ? end : Math.max(1, end - (rangeEnd - rangeStart))
  return { commit: position.head_sha, startLine: start, endLine: end }
}

/** Map one published note to a comment. */
function commentOf(ref: ChangeRequestRef, note: z.infer<typeof noteSchema>, admin: boolean): ForgeReviewComment {
  const { host, owner, name } = ref.repository
  return {
    id: String(note.id) as ForgeCommentId,
    author: note.author === null ? null : { login: note.author.username, avatarUrl: avatarUrlOf(host, note.author.avatar_url), bot: false },
    body: note.body,
    createdAt: note.created_at,
    pending: false,
    url: `https://${host}/${owner}/${name}/-/merge_requests/${ref.number}#note_${note.id}`,
    viewerCanEdit: admin,
    viewerCanDelete: admin,
  }
}

/**
 * Cut the hunk of a one-file patch that holds a line, ending at that line, with a header that counts the kept lines.
 * @param patch - the file's patch, or null when it is unknown.
 * @param side - side the line numbers.
 * @param line - last line to keep.
 * @returns the hunk, or null when no hunk holds the line or the patch cannot be parsed.
 */
export function hunkUntil(patch: string | null, side: 'L' | 'R', line: number): string | null {
  if (patch === null) return null
  let hunks: ReturnType<typeof parsePatch>[number]['hunks']
  try {
    hunks = parsePatch(patch).flatMap(file => file.hunks)
  } catch (error) {
    void error // A patch whose hunk counts disagree with its lines places no line.
    return null
  }
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    const kept: string[] = []
    for (const text of hunk.lines) {
      if (text.startsWith('\\')) continue
      const atLine = side === 'R' ? !text.startsWith('-') && newLine === line : !text.startsWith('+') && oldLine === line
      kept.push(text)
      if (atLine) {
        const oldCount = kept.filter(entry => !entry.startsWith('+')).length
        const newCount = kept.filter(entry => !entry.startsWith('-')).length
        // Git numbers a side without lines from the line before it, as an added file's old side starts at 0.
        const start = (line: number, count: number): number => count === 0 ? line - 1 : line
        return `@@ -${start(hunk.oldStart, oldCount)},${oldCount} +${start(hunk.newStart, newCount)},${newCount} @@\n${kept.join('\n')}`
      }
      if (!text.startsWith('+')) oldLine++
      if (!text.startsWith('-')) newLine++
    }
  }
  return null
}
