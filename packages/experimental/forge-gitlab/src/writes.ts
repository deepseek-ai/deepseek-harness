/** GitLab writes to merge request discussions, draft notes, and reviews, each after a check of the head. */

import type {
  ChangeRequestRef, ForgeActionFailure, ForgeLineComment, ForgeReviewEvent, ForgeReviewRequest, ForgeReviewResult, ForgeReviewWrite,
  ForgeReviewWriteResult,
} from '@deepseek-ai/dsh-experimental-forge'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { GitLabApi, WriteResult } from './api.ts'
import { newestVersion } from './diff.ts'
import type { DiffVersion } from './diff.ts'
import { textPosition } from './position.ts'
import type { VersionFile } from './position.ts'
import { discussionOf, DRAFT_REVIEW, noteOf } from './review.ts'
import { mergeRequestPath } from './urls.ts'

/** Reads the changed files of one diff version by their path on either side, or undefined when GitLab does not list them. */
export type VersionFiles = (version: number) => Promise<ReadonlyMap<string, VersionFile> | undefined>

/** The review state GitLab records for a reviewer who publishes with a decision; an approval records its own. */
const REVIEWER_STATES: Readonly<Record<ForgeReviewEvent, string | undefined>> = {
  comment: 'reviewed', 'request-changes': 'requested_changes', approve: undefined,
}

const draftList = z.array(z.object({ id: z.number() }))

/** A failed review write or submission. */
type Refusal = Extract<ForgeReviewWriteResult, { readonly ok: false }>

/** Writes for one merge request, each sent once. */
class Writer {
  constructor(
    private readonly api: GitLabApi, private readonly ref: ChangeRequestRef, private readonly files: VersionFiles,
    private readonly signal: AbortSignal,
  ) {}

  /** The newest diff version once it is at `headSha`, else `stale` or why it could not be read. */
  async version(headSha: string): Promise<DiffVersion | Refusal> {
    const version = await newestVersion(this.api, this.ref, headSha, this.signal)
    if (!('code' in version)) return version
    return { ok: false, code: version.code === 'stale' ? 'stale' : 'failed', message: version.message }
  }

  /** Send one REST write, with `body` as JSON on stdin when it is given. */
  async send(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: Readonly<Record<string, unknown>>): Promise<WriteResult> {
    const args = ['-X', method, `${mergeRequestPath(this.ref)}${path}`]
    if (body === undefined) return await this.api.write(this.ref.repository.host, args, this.signal)
    return await this.api.write(this.ref.repository.host, [...args, '--input', '-', '-H', 'Content-Type: application/json'], this.signal,
      JSON.stringify(body))
  }

  /** The ids of the signed-in user's draft notes, which GitLab lists at once. */
  async drafts(): Promise<number[] | Refusal> {
    const read = await this.api.rest(this.ref.repository.host, `${mergeRequestPath(this.ref)}/draft_notes`, this.signal)
    if (!read.ok) return { ok: false, code: 'failed', message: read.failure.message }
    const parsed = draftList.safeParse(read.body)
    return parsed.success ? parsed.data.map(draft => draft.id)
      : { ok: false, code: 'failed', message: 'unexpected GitLab response to the draft note read' }
  }

  /** The position of a comment on the lines of `version`, or a refusal when GitLab could not place it. */
  async position(
    version: DiffVersion, comment: ForgeLineComment,
  ): Promise<{ readonly position: Readonly<Record<string, unknown>> } | Refusal> {
    const files = await this.files(version.id)
    if (files === undefined) return { ok: false, code: 'failed', message: 'GitLab did not list the changed files of the merge request' }
    const file = files.get(comment.path)
    const position = file === undefined ? undefined
      : textPosition({ base: version.base_commit_sha, start: version.start_commit_sha, head: version.head_commit_sha }, file, comment)
    return position !== undefined ? { position } : {
      ok: false, code: 'failed',
      message: `merge request ${this.ref.number} does not change lines ${comment.startLine}-${comment.endLine} of ${comment.path} on that side`,
    }
  }

  /**
   * Approve at `headSha` unless the signed-in user already approved; GitLab refuses an approval with HTTP 409 once the
   * head is another commit, and answers a second approval with HTTP 401, which this check avoids.
   */
  async approve(headSha: string): Promise<Refusal | undefined> {
    const read = await this.api.rest(this.ref.repository.host, `${mergeRequestPath(this.ref)}/approvals`, this.signal)
    const approvals = read.ok ? z.object({ user_has_approved: z.boolean() }).safeParse(read.body) : undefined
    if (approvals?.success !== true) return { ok: false, code: 'failed', message: read.ok ? 'unexpected GitLab response to the approval read' : read.failure.message }
    if (approvals.data.user_has_approved) return undefined
    const approved = await this.send('POST', '/approve', { sha: headSha })
    if (approved.ok) return undefined
    if (approved.status === 409) return { ok: false, code: 'stale', message: approved.failure.message }
    return refusal(approved.failure)
  }

  /**
   * Delete draft notes this provider created, keeping going past failures, since nobody else sees them.
   * @returns the ids GitLab did not confirm deleting.
   */
  async discard(ids: readonly number[]): Promise<number[]> {
    const left: number[] = []
    for (const id of ids) if (!(await this.send('DELETE', `/draft_notes/${id}`)).ok) left.push(id)
    return left
  }

  /** Delete the draft notes of a review that stopped, and report `failure` with any draft that may remain. */
  async rollBack(failure: Refusal, ids: readonly number[]): Promise<Refusal> {
    const left = await this.discard(ids)
    if (left.length === 0) return failure
    return {
      ok: false, code: 'unknown',
      message: `${failure.message}; ${left.length} pending ${left.length === 1 ? 'comment' : 'comments'} of yours may remain on merge request `
        + `${this.ref.number}, so check its pending comments before you submit again`,
    }
  }
}

/**
 * Write to the discussions or the draft notes of a merge request. The newest diff version is read first and the write
 * is refused with `stale` once its head is another commit. Replies and resolutions name a discussion and edits and
 * deletions a note or draft note through the merge request's own paths, so GitLab refuses ids of another merge request;
 * an id this provider never issued, such as the thread of a draft note, is refused without a write. A pending reply or
 * comment is a draft note, which only its author sees; a comment's position addresses the lines of the newest version.
 * Submitting publishes every draft note with the summary, after approving at the head when the decision is `approve`;
 * requesting changes or commenting records that review state for a reviewer. Discarding deletes the draft notes one by
 * one. No write is retried: a refusal GitLab reports returns `failed`, and an answer that does not show whether GitLab
 * applied a write returns `unknown`.
 * @param api - GitLab reads and writes.
 * @param files - reads the changed files of a diff version.
 * @param ref - merge request, with a project path already checked for inlining.
 * @param write - the write and the head commit the user saw.
 * @param signal - cancellation of the reads and writes.
 * @returns whether GitLab took the write.
 */
export async function writeGitLabReview(
  api: GitLabApi, files: VersionFiles, ref: ChangeRequestRef, write: ForgeReviewWrite, signal: AbortSignal,
): Promise<ForgeReviewWriteResult> {
  const writer = new Writer(api, ref, files, signal)
  const unknownTarget: Refusal = { ok: false, code: 'failed', message: `merge request ${ref.number} has no discussion or note with that id` }
  const version = await writer.version(write.headSha)
  if ('ok' in version) return version
  switch (write.kind) {
    case 'reply': {
      const discussion = discussionOf(write.thread)
      if (discussion === undefined) return unknownTarget
      return done(write.pending
        ? await writer.send('POST', '/draft_notes', { note: write.body, in_reply_to_discussion_id: discussion })
        : await writer.send('POST', `/discussions/${discussion}/notes`, { body: write.body }))
    }
    case 'resolve': {
      const discussion = discussionOf(write.thread)
      if (discussion === undefined) return unknownTarget
      return done(await writer.send('PUT', `/discussions/${discussion}`, { resolved: write.resolved }))
    }
    case 'edit-comment': {
      const note = noteOf(write.comment)
      if (note === undefined) return unknownTarget
      return done(note.draft
        ? await writer.send('PUT', `/draft_notes/${note.id}`, { note: write.body })
        : await writer.send('PUT', `/notes/${note.id}`, { body: write.body }))
    }
    case 'delete-comment': {
      const note = noteOf(write.comment)
      if (note === undefined) return unknownTarget
      return done(await writer.send('DELETE', note.draft ? `/draft_notes/${note.id}` : `/notes/${note.id}`))
    }
    case 'add-pending': {
      const placed = await writer.position(version, write.comment)
      if ('ok' in placed) return placed
      return done(await writer.send('POST', '/draft_notes', { note: write.comment.body, position: placed.position }))
    }
    case 'submit-pending': {
      const drafts = await pendingDrafts(writer, write.review)
      if ('ok' in drafts) return drafts
      if (write.event === 'approve') {
        const refused = await writer.approve(write.headSha)
        if (refused !== undefined) return refused
      }
      return done(await publish(writer, write.event, write.body))
    }
    case 'discard-pending': {
      const drafts = await pendingDrafts(writer, write.review)
      if ('ok' in drafts) return drafts
      for (const [index, id] of drafts.entries()) {
        const deleted = await writer.send('DELETE', `/draft_notes/${id}`)
        if (!deleted.ok) {
          const failure = refusal(deleted.failure)
          return index === 0 ? failure : { ...failure, message: `GitLab deleted ${index} of ${drafts.length} pending comments: ${failure.message}` }
        }
      }
      return { ok: true }
    }
    /* v8 ignore next -- closed ForgeReviewWrite kind union exhaustiveness guard */
    default: return assertNever(write, 'ForgeReviewWrite.kind')
  }
}

/**
 * Publish one comment or one complete review on a merge request. The newest diff version is read first and the
 * submission is refused with `stale` once its head is another commit; comment positions address its lines, and every
 * position is found before anything is written. A comment starts a discussion at once. A review is refused while the
 * signed-in user has draft notes, which publishing would include; otherwise each comment becomes a draft note, an
 * `approve` decision approves at the head, and the drafts are published with the summary and the decision's review state.
 * A refused draft or approval deletes the drafts written before it, so a refused review changes nothing; a refused
 * publication deletes them too, keeping only an approval, which a retry does not repeat. Nothing is retried.
 * @param api - GitLab reads and writes.
 * @param files - reads the changed files of a diff version.
 * @param ref - merge request, with a project path already checked for inlining.
 * @param request - the comment or review and the head commit the user reviewed.
 * @param signal - cancellation of the reads and writes.
 * @returns the page of the published comment or of the merge request, or why GitLab did not take it.
 */
export async function submitGitLabReview(
  api: GitLabApi, files: VersionFiles, ref: ChangeRequestRef, request: ForgeReviewRequest, signal: AbortSignal,
): Promise<ForgeReviewResult> {
  const writer = new Writer(api, ref, files, signal)
  const { host, owner, name } = ref.repository
  const url = `https://${host}/${owner}/${name}/-/merge_requests/${ref.number}`
  const version = await writer.version(request.headSha)
  if ('ok' in version) return version
  if (request.kind === 'comment') {
    const placed = await writer.position(version, request.comment)
    if ('ok' in placed) return placed
    const started = await writer.send('POST', '/discussions', { body: request.comment.body, position: placed.position })
    if (!started.ok) return refusal(started.failure)
    const note = z.object({ notes: z.array(z.object({ id: z.number() })).min(1) }).safeParse(started.body).data?.notes[0]
    return { ok: true, url: note === undefined ? url : `${url}#note_${note.id}` }
  }
  const existing = await writer.drafts()
  if ('ok' in existing) return existing
  if (existing.length > 0) {
    return { ok: false, code: 'failed', message: 'GitLab holds pending comments of yours on this merge request; submit or discard them first' }
  }
  if (request.event === 'comment' && request.comments.length === 0 && request.body.trim() === '') {
    return { ok: false, code: 'failed', message: 'A review without a decision needs a comment or a summary' }
  }
  const positions: Readonly<Record<string, unknown>>[] = []
  for (const comment of request.comments) {
    const placed = await writer.position(version, comment)
    if ('ok' in placed) return placed
    positions.push(placed.position)
  }
  const written: number[] = []
  for (const [index, comment] of request.comments.entries()) {
    const draft = await writer.send('POST', '/draft_notes', { note: comment.body, position: positions[index] })
    const id = draft.ok ? z.object({ id: z.number() }).safeParse(draft.body).data?.id : undefined
    if (id === undefined) {
      return await writer.rollBack(draft.ok ? { ok: false, code: 'unknown', message: 'unexpected GitLab response to a draft note' } : refusal(draft.failure),
        written)
    }
    written.push(id)
  }
  if (request.event === 'approve') {
    const refused = await writer.approve(request.headSha)
    if (refused !== undefined) return await writer.rollBack(refused, written)
    if (written.length === 0 && request.body.trim() === '') return { ok: true, url }
  }
  const published = await publish(writer, request.event, request.body)
  if (published.ok) return { ok: true, url }
  if (published.failure.code === 'unknown') return refusal(published.failure)
  return await afterRefusedPublish(writer, written, refusal(published.failure))
}

/**
 * Settle a publication GitLab refused. GitLab can publish the draft notes before it refuses the summary or the review
 * state, so the drafts are read again: when every draft remains, nothing was published and they are deleted; when one
 * is gone, the comments may be public, so none is deleted and the outcome is reported for the user to check.
 */
async function afterRefusedPublish(writer: Writer, written: readonly number[], failure: Refusal): Promise<Refusal> {
  const drafts = await writer.drafts()
  if (!('ok' in drafts) && written.every(id => drafts.includes(id))) return await writer.rollBack(failure, written)
  return {
    ok: false, code: 'unknown',
    message: `${failure.message}; GitLab may have published the comments of this review, so check the merge request before you submit again`,
  }
}

/** The ids of the pending review's draft notes, or a refusal when `review` is not the user's pending review. */
async function pendingDrafts(writer: Writer, review: string): Promise<number[] | Refusal> {
  const drafts = review === DRAFT_REVIEW ? await writer.drafts() : []
  if ('ok' in drafts) return drafts
  return drafts.length > 0 ? drafts : { ok: false, code: 'failed', message: `the pending review ${review} is no longer the signed-in user's pending review` }
}

/** Publish every draft note with an optional summary and the review state of `event`. */
async function publish(writer: Writer, event: ForgeReviewEvent, body: string): Promise<WriteResult> {
  const state = REVIEWER_STATES[event]
  return await writer.send('POST', '/draft_notes/bulk_publish', {
    ...body.trim() === '' ? {} : { note: body }, ...state === undefined ? {} : { reviewer_state: state },
  })
}

/** The result of one write that ends a review write. */
function done(written: WriteResult): ForgeReviewWriteResult {
  return written.ok ? { ok: true } : refusal(written.failure)
}

/** A write failure as a review result, in which missing credentials are a refusal. */
function refusal(failure: ForgeActionFailure): Refusal {
  return { ok: false, code: failure.code === 'unauthenticated' ? 'failed' : failure.code, message: failure.message }
}
