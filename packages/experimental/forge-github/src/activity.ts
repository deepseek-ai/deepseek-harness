/** Pull request activity through GraphQL: the latest timeline entries as comments, reviews, commits, and changes of state. */

import type {
  ChangeRequestActivity, ChangeRequestActivityItem, ChangeRequestRef, ForgeCommentAuthor, ForgeFailure,
} from '@deepseek-ai/dsh-experimental-forge'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { GraphqlReader } from './commits.ts'
import { VERDICTS } from './graphql.ts'
import { viewerMayComment } from './threads.ts'
import { checkedRepository } from './urls.ts'

/** Most entries one read lists, GitHub's connection maximum. */
const ENTRIES = 100

const ACCOUNT = '__typename login avatarUrl(size: 48)'

/** Timeline events that carry only their time and the account that caused them. */
const STATE_EVENTS = [
  'MergedEvent', 'ClosedEvent', 'ReopenedEvent', 'ReadyForReviewEvent', 'ConvertToDraftEvent', 'HeadRefForcePushedEvent',
  'AutoMergeEnabledEvent', 'AutoMergeDisabledEvent',
] as const

/**
 * The latest timeline entries of one pull request, with the fields that decide whether the viewer may comment; variables
 * `owner` and `name` are strings, `number` is an integer.
 */
export const ACTIVITY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    isArchived viewerPermission
    pullRequest(number: $number) {
      locked merged
      timelineItems(last: ${ENTRIES}, itemTypes: [
        PULL_REQUEST_COMMIT, ISSUE_COMMENT, PULL_REQUEST_REVIEW, REVIEW_REQUESTED_EVENT, RENAMED_TITLE_EVENT, MERGED_EVENT, CLOSED_EVENT,
        REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, AUTO_MERGE_ENABLED_EVENT,
        AUTO_MERGE_DISABLED_EVENT
      ]) {
        pageInfo { hasPreviousPage }
        nodes {
          __typename
          ... on PullRequestCommit { commit { oid messageHeadline committedDate author { user { ${ACCOUNT} } } } }
          ... on IssueComment { createdAt url body author { ${ACCOUNT} } }
          ... on PullRequestReview { createdAt submittedAt url body state author { ${ACCOUNT} } comments { totalCount } }
          ... on ReviewRequestedEvent {
            createdAt actor { ${ACCOUNT} } requestedReviewer { ... on Actor { login } ... on Team { combinedSlug } }
          }
          ... on RenamedTitleEvent { createdAt actor { ${ACCOUNT} } previousTitle currentTitle }
          ${STATE_EVENTS.map(type => `... on ${type} { createdAt actor { ${ACCOUNT} } }`).join('\n          ')}
        }
      }
    }
  }
}`

const accountSchema = z.object({ __typename: z.string(), login: z.string(), avatarUrl: z.string().nullable() })

const entrySchema = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('PullRequestCommit'),
    commit: z.object({
      oid: z.string(),
      messageHeadline: z.string(),
      committedDate: z.string(),
      author: z.object({ user: accountSchema.nullable() }).nullable(),
    }),
  }),
  z.object({
    __typename: z.literal('IssueComment'),
    createdAt: z.string(),
    url: z.string(),
    body: z.string(),
    author: accountSchema.nullable(),
  }),
  z.object({
    __typename: z.literal('PullRequestReview'),
    createdAt: z.string(),
    submittedAt: z.string().nullable(),
    url: z.string(),
    body: z.string(),
    state: z.string(),
    author: accountSchema.nullable(),
    comments: z.object({ totalCount: z.number().int().nonnegative() }),
  }),
  z.object({
    __typename: z.literal('ReviewRequestedEvent'),
    createdAt: z.string(),
    actor: accountSchema.nullable(),
    requestedReviewer: z.object({ login: z.string().optional(), combinedSlug: z.string().optional() }).nullable(),
  }),
  z.object({
    __typename: z.literal('RenamedTitleEvent'),
    createdAt: z.string(),
    actor: accountSchema.nullable(),
    previousTitle: z.string(),
    currentTitle: z.string(),
  }),
  z.object({ __typename: z.enum(STATE_EVENTS), createdAt: z.string(), actor: accountSchema.nullable() }),
])

const activitySchema = z.object({
  data: z.object({
    repository: z.object({
      isArchived: z.boolean(),
      viewerPermission: z.string().nullable(),
      pullRequest: z.object({
        locked: z.boolean(),
        merged: z.boolean(),
        timelineItems: z.object({
          pageInfo: z.object({ hasPreviousPage: z.boolean() }),
          // GitHub answers null for an entry it does not show the viewer.
          nodes: z.array(entrySchema.nullable()),
        }),
      }).nullable(),
    }).nullable(),
  }),
})

type Entry = z.infer<typeof entrySchema>

/**
 * Read the latest 100 entries of a pull request's timeline in one request. They keep GitHub's order, which is oldest
 * first by the time each entry reports: a commit's committer date, a review's submission, and the creation of every
 * other entry. A pending review is left out, and so is the close GitHub records with a merge. GitHub's schema has no
 * field that tells whether the viewer may comment, so `viewerCanComment` follows {@link viewerMayComment}; GitHub can
 * still refuse the comment of a user it blocks or limits.
 * @param read - runs one GraphQL request.
 * @param ref - pull request.
 * @param signal - cancellation of the read.
 * @returns the activity, or why GitHub did not provide it.
 */
export async function readActivity(
  read: GraphqlReader, ref: ChangeRequestRef, signal: AbortSignal,
): Promise<ChangeRequestActivity | ForgeFailure> {
  const { host, owner, name } = checkedRepository(ref)
  const output = await read(['api', 'graphql', '--hostname', host, '-f', `query=${ACTIVITY_QUERY}`, '-f', `owner=${owner}`,
    '-f', `name=${name}`, '-F', `number=${ref.number}`], signal)
  if (!output.ok) return output.failure
  const parsed = activitySchema.safeParse(output.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitHub response to the activity read' }
  const repository = parsed.data.data.repository
  const pull = repository?.pullRequest
  if (repository == null || pull == null) return { code: 'not-found', message: `pull request ${ref.number} was not found` }
  const { nodes, pageInfo } = pull.timelineItems
  // A pull request is open when it merges, so on a merged one a close that no reopening follows is the one the merge recorded.
  const impliedAfter = pull.merged ? nodes.findLastIndex(node => node?.__typename === 'ReopenedEvent') : nodes.length
  const items: ChangeRequestActivityItem[] = []
  for (const [index, node] of nodes.entries()) {
    if (node === null || (node.__typename === 'ClosedEvent' && index > impliedAfter)) continue
    const item = itemOf(node)
    if (item !== undefined) items.push(item)
  }
  return { items, truncated: pageInfo.hasPreviousPage, viewerCanComment: viewerMayComment(repository, pull.locked) }
}

/**
 * Map one timeline entry.
 * @param node - the entry as GitHub returned it.
 * @returns the activity item, or undefined for a review that is not submitted.
 */
function itemOf(node: Entry): ChangeRequestActivityItem | undefined {
  switch (node.__typename) {
    case 'PullRequestCommit': {
      const { commit } = node
      // A commit whose author has no GitHub account names no account. GitHub shortens a long `messageHeadline` with an ellipsis.
      const actor = accountOf(commit.author?.user ?? null)
      return { kind: 'commit', at: commit.committedDate, actor, sha: commit.oid, title: commit.messageHeadline }
    }
    case 'IssueComment':
      return { kind: 'comment', at: node.createdAt, actor: accountOf(node.author), body: node.body, url: node.url }
    case 'PullRequestReview': {
      const verdict = VERDICTS[node.state]
      if (verdict === undefined) return undefined
      const { body, url, comments: { totalCount: comments } } = node
      return { kind: 'review', at: node.submittedAt ?? node.createdAt, actor: accountOf(node.author), verdict, body, comments, url }
    }
    case 'ReviewRequestedEvent': {
      // A team is named `organization/slug`, as the snapshot's reviewers and a review request name it.
      const reviewer = node.requestedReviewer?.combinedSlug ?? node.requestedReviewer?.login ?? null
      return { kind: 'review-requested', at: node.createdAt, actor: accountOf(node.actor), reviewer }
    }
    case 'RenamedTitleEvent':
      return { kind: 'renamed', at: node.createdAt, actor: accountOf(node.actor), from: node.previousTitle, to: node.currentTitle }
    case 'MergedEvent': return { kind: 'merged', at: node.createdAt, actor: accountOf(node.actor) }
    case 'ClosedEvent': return { kind: 'closed', at: node.createdAt, actor: accountOf(node.actor) }
    case 'ReopenedEvent': return { kind: 'reopened', at: node.createdAt, actor: accountOf(node.actor) }
    case 'ReadyForReviewEvent': return { kind: 'ready-for-review', at: node.createdAt, actor: accountOf(node.actor) }
    case 'ConvertToDraftEvent': return { kind: 'converted-to-draft', at: node.createdAt, actor: accountOf(node.actor) }
    case 'HeadRefForcePushedEvent': return { kind: 'force-pushed', at: node.createdAt, actor: accountOf(node.actor) }
    case 'AutoMergeEnabledEvent': return { kind: 'auto-merge-enabled', at: node.createdAt, actor: accountOf(node.actor) }
    case 'AutoMergeDisabledEvent': return { kind: 'auto-merge-disabled', at: node.createdAt, actor: accountOf(node.actor) }
    /* v8 ignore next -- closed timeline entry union exhaustiveness guard */
    default: return assertNever(node, 'GitHub timeline entry')
  }
}

/**
 * Map one account. A commit's author is always typed `User`, so an app that authored a commit is told by the `[bot]`
 * suffix GitHub gives its login there.
 */
function accountOf(account: z.infer<typeof accountSchema> | null): ForgeCommentAuthor | null {
  if (account === null) return null
  return { login: account.login, avatarUrl: account.avatarUrl, bot: account.__typename === 'Bot' || account.login.endsWith('[bot]') }
}
