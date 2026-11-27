/**
 * Merge request activity: the latest notes through GraphQL and the state changes through REST, mapped to the entries of
 * the forge contract.
 */

import type {
  ChangeRequestActivity, ChangeRequestActivityItem, ChangeRequestRef, ForgeCommentAuthor, ForgeCommit, ForgeFailure, ReviewVerdict,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GitLabApi } from './api.ts'
import { PROJECT_ID, withUploadAddresses } from './description.ts'
import { avatarUrlOf, checkedProject, mergeRequestPath } from './urls.ts'

/** Most entries one read returns, and most notes and most state changes it reads: GitLab's page maximum. */
export const ACTIVITY_PAGE = 100

/**
 * The latest notes of one merge request, oldest first, with the signed-in user's right to add a note and the project's
 * id; variables `path` and `iid` are strings. `position` is set on a note of a diff thread, and
 * `systemNoteMetadata.action` names what a system note records, whatever language its sentence is in.
 */
export const ACTIVITY_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    id
    mergeRequest(iid: $iid) {
      userPermissions { createNote }
      notes(last: ${ACTIVITY_PAGE}) {
        pageInfo { hasPreviousPage }
        nodes { system body createdAt url author { username avatarUrl bot } position { positionType } systemNoteMetadata { action } }
      }
    }
  }
}`

/** A time that orders the entries. */
const time = z.string().refine(value => !Number.isNaN(Date.parse(value)))

const noteSchema = z.object({
  system: z.boolean(),
  body: z.string(),
  createdAt: time,
  url: z.string().nullable(),
  author: z.object({ username: z.string(), avatarUrl: z.string().nullable(), bot: z.boolean() }).nullable(),
  position: z.object({ positionType: z.string() }).nullable(),
  systemNoteMetadata: z.object({ action: z.string().nullable() }).nullable(),
})

const activitySchema = z.object({
  project: z.object({
    id: z.string().regex(PROJECT_ID),
    mergeRequest: z.object({
      userPermissions: z.object({ createNote: z.boolean() }),
      notes: z.object({ pageInfo: z.object({ hasPreviousPage: z.boolean() }), nodes: z.array(noteSchema.nullable()) }),
    }).nullable(),
  }).nullable(),
})

const stateEventSchema = z.object({
  state: z.string(),
  created_at: time,
  user: z.object({ username: z.string(), avatar_url: z.string().nullable() }).nullable(),
})

/** One note of a merge request as {@link ACTIVITY_QUERY} selects it. */
export type ActivityNote = z.infer<typeof noteSchema>

/** One state change of a merge request as the REST `resource_state_events` list reports it. */
type StateEvent = z.infer<typeof stateEventSchema>

/** The time and the account that every entry of one note or state change carries. */
type Origin = Pick<ChangeRequestActivityItem, 'at' | 'actor'>

/** Diff comments one author wrote in a row, from the first of them. */
interface DiffRun {
  readonly first: ActivityNote
  comments: number
}

/** A username after `@`, as GitLab writes an account in a system note. */
const MENTION = /@(?:[\w.][\w.-]*[\w-]|\w)/g

/**
 * The clause that lists the accounts a review request was withdrawn from. Every reviewer note sampled on GitLab 19.5 is
 * in English but one kind: a request that is asked again is in the language of the user who asks.
 */
const REQUESTS_REMOVED = 'removed review request for'

/** A draft mark that was set or cleared. */
const DRAFT_MARK = /^marked this merge request as \*\*(draft|ready)\*\*$/

/** A title change as GitLab 19 writes it: each title in a `code` element whose `span` elements mark the changed words. */
const TITLES_AS_HTML = /<code class="idiff">(.*?)<\/code>.*?<code class="idiff">(.*?)<\/code>/s

/** A title change as earlier versions wrote it: each title in bold, its changed words between `{-` `-}` or `{+` `+}`. */
const TITLES_AS_MARKDOWN = /^changed title from \*\*(.*)\*\* to \*\*(.*)\*\*$/s

/** The marks around the changed words of a title in {@link TITLES_AS_MARKDOWN}. */
const CHANGED_WORDS = /\{-(.*?)-\}|\{\+(.*?)\+\}/gs

/** One item of the list in a note about added commits. */
const LISTED = /<li>(.*?)<\/li>/gs

/**
 * A list item that names one commit: its abbreviated object name, then the first line of its message with HTML
 * escaped. An item with an element of its own, or with a range of object names, counts commits without naming them.
 */
const LISTED_COMMIT = /^([0-9a-f]{7,64}) - ([^<]*)$/

const AUTO_MERGE_ENABLED = /^enabled an automatic merge\b/
const AUTO_MERGE_DISABLED = /^(?:canceled|aborted) the automatic merge\b/

/** Elements whose ends separate words. */
const BLOCK_TAG = /<\/?(?:p|ul|ol|li|br|div)\b[^>]*>/gi

const TAG = /<[^>]+>/g
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g
const MARKDOWN_BOLD = /\*\*(.+?)\*\*/g
const MARKDOWN_CODE = /`([^`]*)`/g

/**
 * Read a merge request's activity through two requests sent together: one GraphQL query for its latest
 * {@link ACTIVITY_PAGE} notes and the signed-in user's right to add one, and one REST read of its state changes, which
 * GitLab does not keep as notes: each is `merged`, `closed`, or `reopened`, and any other state GitLab records is an
 * `other` entry with the state's name. A page that leaves out earlier notes drops the state changes before its first
 * note, and the entries of both are cut to the latest {@link ACTIVITY_PAGE}.
 * @param api - GitLab reads.
 * @param ref - merge request.
 * @param signal - cancellation of the reads.
 * @returns the entries oldest first, or why GitLab did not provide them.
 * @throws when the project path or the number of `ref` is not one GitLab can hold.
 * @see noteEntries
 */
export async function readActivity(
  api: GitLabApi, ref: ChangeRequestRef, signal: AbortSignal,
): Promise<ChangeRequestActivity | ForgeFailure> {
  const { host } = ref.repository
  const [read, states] = await Promise.all([
    api.graphql(host, ACTIVITY_QUERY, { path: checkedProject(ref), iid: String(ref.number) }, signal),
    api.rest(host, `${mergeRequestPath(ref)}/resource_state_events?per_page=${ACTIVITY_PAGE}`, signal),
  ])
  if (!read.ok) return read.failure
  const parsed = activitySchema.safeParse(read.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitLab response to the activity read' }
  const { project } = parsed.data
  const merge = project?.mergeRequest
  if (project === null || merge == null) return { code: 'not-found', message: `merge request ${ref.number} was not found` }
  if (!states.ok) return states.failure
  const events = z.array(stateEventSchema).safeParse(states.body)
  if (!events.success) return { code: 'unavailable', message: 'unexpected GitLab response to the state change read' }
  const notes = merge.notes.nodes.filter(note => note !== null)
  const cut = merge.notes.pageInfo.hasPreviousPage
  const first = cut ? notes.at(0)?.createdAt : undefined
  const since = first === undefined ? Number.NEGATIVE_INFINITY : Date.parse(first)
  const changes = events.data.filter(event => Date.parse(event.created_at) >= since).map(event => stateEntry(host, event))
  // GitLab reports a note's time in whole seconds, so a note sorts before a state change of its second.
  const items = [...noteEntries(host, project.id, notes), ...changes].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  return {
    items: items.slice(-ACTIVITY_PAGE),
    truncated: cut || items.length > ACTIVITY_PAGE,
    viewerCanComment: merge.userPermissions.createNote,
  }
}

/**
 * Name the commits of activity entries in full. GitLab's notes list a pushed commit by an abbreviated object name; an
 * entry whose abbreviation starts the name of exactly one listed commit takes that name, and any other entry keeps the
 * name it has, as does one for a commit the merge request no longer lists.
 * @param items - activity entries.
 * @param commits - the commits the merge request lists.
 * @returns the entries in their order.
 */
export function withListedCommitNames(
  items: readonly ChangeRequestActivityItem[], commits: readonly ForgeCommit[],
): ChangeRequestActivityItem[] {
  return items.map((item) => {
    if (item.kind !== 'commit') return item
    const [only, ...others] = commits.filter(commit => commit.sha.startsWith(item.sha))
    return only === undefined || others.length > 0 ? item : { ...item, sha: only.sha }
  })
}

/**
 * Map notes to activity entries, in their order.
 *
 * A note a person wrote outside the diff is a `comment`, with its uploads at the addresses GitLab serves them from.
 * GitLab has no review that holds comments, so diff comments one author wrote in a row are one `review` with the
 * verdict `commented`, an empty body, their number, and the time and page of the first. A system note in a diff thread
 * is left out.
 *
 * Any other system note maps by `systemNoteMetadata.action`. `approved`, `requested_changes`, and `reviewed` are a
 * `review` with the verdict `approved`, `changes-requested`, or `commented`. `reviewer` is one `review-requested` for
 * each account it asks, and an `other` entry for the requests it withdraws. `title` is `renamed` with both titles as
 * plain text, or `ready-for-review` or `converted-to-draft` for a draft mark. `commit` is one `commit` for each commit
 * its list names, with the abbreviated object name GitLab lists, and an `other` entry for each item that counts commits
 * instead. `merge` is `auto-merge-enabled`, or `auto-merge-disabled` when the automatic merge was cancelled or aborted.
 * Every other action, and a note of these actions whose sentence GitLab words differently, as it may in another
 * language, is an `other` entry with the sentence as plain text.
 * @param host - host the notes were read on.
 * @param project - global id of the merge request's project, which names it in upload addresses.
 * @param notes - notes oldest first.
 * @returns the entries, each with the time and the author of its note.
 */
export function noteEntries(host: string, project: string, notes: readonly ActivityNote[]): ChangeRequestActivityItem[] {
  const items: ChangeRequestActivityItem[] = []
  let run: DiffRun | undefined
  for (const note of notes) {
    const diffComment = note.position !== null && !note.system
    if (diffComment && run !== undefined && run.first.author?.username === note.author?.username) {
      run.comments++
      continue
    }
    if (run !== undefined) items.push(diffReview(host, run))
    run = diffComment ? { first: note, comments: 1 } : undefined
    if (note.position !== null) continue
    const origin = originOf(host, note)
    if (note.system) items.push(...systemEntries(origin, note))
    else items.push({ ...origin, kind: 'comment', body: withUploadAddresses(note.body, host, project), url: note.url })
  }
  if (run !== undefined) items.push(diffReview(host, run))
  return items
}

/**
 * Map one state change: `merged`, `closed`, or `reopened`, or an `other` entry with the state's name for any other
 * state GitLab records. GitLab's REST user carries no bot mark, so the actor is never marked as one.
 */
function stateEntry(host: string, event: StateEvent): ChangeRequestActivityItem {
  const { user, state } = event
  const origin: Origin = {
    at: event.created_at,
    actor: user === null ? null : { login: user.username, avatarUrl: avatarUrlOf(host, user.avatar_url), bot: false },
  }
  switch (state) {
    case 'merged':
    case 'closed':
    case 'reopened': return { ...origin, kind: state }
    // GitLab's set of states is open, and a state without a kind of its own reads as its name.
    default: return { ...origin, kind: 'other', text: state }
  }
}

/** The time and the author of a note. */
function originOf(host: string, note: ActivityNote): Origin {
  const { author } = note
  const actor: ForgeCommentAuthor | null = author === null ? null
    : { login: author.username, avatarUrl: avatarUrlOf(host, author.avatarUrl), bot: author.bot }
  return { at: note.createdAt, actor }
}

/** The review entry of diff comments one author wrote in a row. */
function diffReview(host: string, run: DiffRun): ChangeRequestActivityItem {
  return { ...originOf(host, run.first), kind: 'review', verdict: 'commented', body: '', comments: run.comments, url: run.first.url }
}

/** The entries of a system note outside the diff, by the action GitLab records with it. */
function systemEntries(origin: Origin, note: ActivityNote): ChangeRequestActivityItem[] {
  const { body, url } = note
  const review = (verdict: ReviewVerdict): ChangeRequestActivityItem[] =>
    [{ ...origin, kind: 'review', verdict, body: '', comments: 0, url }]
  switch (note.systemNoteMetadata?.action) {
    case 'approved': return review('approved')
    case 'requested_changes': return review('changes-requested')
    case 'reviewed': return review('commented')
    case 'reviewer': return reviewRequests(origin, body)
    case 'title': return [titleEntry(origin, body)]
    case 'commit': return commitEntries(origin, body)
    case 'merge': return [autoMergeEntry(origin, body)]
    // GitLab's set of actions is open: every other one, and a note without one, has no kind of its own.
    default: return [other(origin, body)]
  }
}

/** A record with no kind of its own. */
function other(origin: Origin, markup: string): ChangeRequestActivityItem {
  return { ...origin, kind: 'other', text: plainText(markup) }
}

/** One request for each account a reviewer note asks, then the clause about the requests it withdraws. */
function reviewRequests(origin: Origin, body: string): ChangeRequestActivityItem[] {
  const removed = body.indexOf(REQUESTS_REMOVED)
  const asked = removed === -1 ? body : body.slice(0, removed)
  const items = (asked.match(MENTION) ?? []).map((mention): ChangeRequestActivityItem =>
    ({ ...origin, kind: 'review-requested', reviewer: mention.slice(1) }))
  if (removed !== -1) items.push(other(origin, body.slice(removed)))
  return items.length > 0 ? items : [other(origin, body)]
}

/** A draft mark or a title change, which GitLab records under one action. */
function titleEntry(origin: Origin, body: string): ChangeRequestActivityItem {
  const mark = DRAFT_MARK.exec(body)
  if (mark !== null) return { ...origin, kind: mark[1] === 'draft' ? 'converted-to-draft' : 'ready-for-review' }
  const html = TITLES_AS_HTML.exec(body)
  if (html !== null) {
    const [, from = '', to = ''] = html
    return { ...origin, kind: 'renamed', from: unescaped(from.replace(TAG, '')), to: unescaped(to.replace(TAG, '')) }
  }
  const markdown = TITLES_AS_MARKDOWN.exec(body)
  if (markdown === null) return other(origin, body)
  const [, from = '', to = ''] = markdown
  return { ...origin, kind: 'renamed', from: from.replace(CHANGED_WORDS, '$1$2'), to: to.replace(CHANGED_WORDS, '$1$2') }
}

/** One entry for each item of the list in a note about added commits, or the note's sentence when it lists none. */
function commitEntries(origin: Origin, body: string): ChangeRequestActivityItem[] {
  const items = [...body.matchAll(LISTED)].map(([, item = '']): ChangeRequestActivityItem => {
    const commit = LISTED_COMMIT.exec(item)
    if (commit === null) return other(origin, item)
    const [, sha = '', title = ''] = commit
    return { ...origin, kind: 'commit', sha, title: unescaped(title) }
  })
  return items.length > 0 ? items : [other(origin, body)]
}

/** A change of the automatic merge, or the sentence of another note about merging, such as one about a merge train. */
function autoMergeEntry(origin: Origin, body: string): ChangeRequestActivityItem {
  if (AUTO_MERGE_ENABLED.test(body)) return { ...origin, kind: 'auto-merge-enabled' }
  return AUTO_MERGE_DISABLED.test(body) ? { ...origin, kind: 'auto-merge-disabled' } : other(origin, body)
}

/**
 * The sentence of a system note without the Markdown and HTML that GitLab writes it with: links read as their text,
 * bold and code as their content, and elements as theirs, on one line.
 */
function plainText(markup: string): string {
  const text = markup.replace(BLOCK_TAG, ' ').replace(TAG, '')
    .replace(MARKDOWN_LINK, '$1').replace(MARKDOWN_BOLD, '$1').replace(MARKDOWN_CODE, '$1')
  return unescaped(text).replace(/\s+/g, ' ').trim()
}

/** Text with the five characters that GitLab escapes in the HTML of a system note. */
function unescaped(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&')
}
