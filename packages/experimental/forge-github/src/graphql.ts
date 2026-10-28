/** GitHub GraphQL documents and their mapping into provider-neutral results. */

import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  ChangeRequestCheck, ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, CheckState, ChecksRollup, ForgeFailure, ForgeRepository,
  Mergeability, MergeMethod, ReviewDecision,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import { checkedRepository } from './urls.ts'

const PULL_REQUEST_FIELDS = `number url title state isDraft updatedAt closedAt
  author { login }
  headRefName headRefOid baseRefName additions deletions mergeable mergeStateStatus reviewDecision
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl startedAt completedAt checkSuite { workflowRun { workflow { name } } } }
      ... on StatusContext { context state targetUrl }
    }
  } } } } }`

const REPOSITORY_FIELDS = 'squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerPermission viewerDefaultMergeMethod'

/** Head-branch lookup; variables `owner`, `name`, and `branch` are passed as strings. */
export const HEAD_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(headRefName: $branch, states: OPEN, first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number isCrossRepository } }
  }
}`

const checkRunSchema = z.object({
  __typename: z.literal('CheckRun'),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  detailsUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  checkSuite: z.object({
    workflowRun: z.object({ workflow: z.object({ name: z.string() }) }).nullable(),
  }).nullable(),
})

const statusContextSchema = z.object({
  __typename: z.literal('StatusContext'),
  context: z.string(),
  state: z.string(),
  targetUrl: z.string().nullable(),
})

const pullRequestSchema = z.object({
  url: z.string(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  author: z.object({ login: z.string() }).nullable(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  reviewThreads: z.object({ nodes: z.array(z.object({ isResolved: z.boolean() })) }),
  commits: z.object({
    nodes: z.array(z.object({
      commit: z.object({
        statusCheckRollup: z.object({
          state: z.string(),
          contexts: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(z.unknown()) }),
        }).nullable(),
      }),
    })),
  }),
})

const repositorySchema = z.object({
  squashMergeAllowed: z.boolean(),
  mergeCommitAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
  viewerPermission: z.string().nullable(),
  viewerDefaultMergeMethod: z.string(),
})

const responseSchema = z.object({
  data: z.record(z.string(), z.record(z.string(), z.unknown()).nullable()).nullable().optional(),
  errors: z.array(z.object({
    type: z.string().optional(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
    message: z.string(),
  })).optional(),
}).refine(hasGraphqlFields)

/**
 * Distinguish GraphQL response fields from HTTP error bodies.
 * @param body - parsed JSON returned by GitHub.
 * @returns whether the object carries GraphQL data or errors; field validation remains with the query mapper.
 */
export function hasGraphqlFields(body: unknown): boolean {
  return typeof body === 'object' && body !== null && ('data' in body || 'errors' in body)
}

const headSchema = z.object({
  data: z.object({
    repository: z.object({
      defaultBranchRef: z.object({ name: z.string() }).nullable(),
      pullRequests: z.object({ nodes: z.array(z.object({ number: z.number(), isCrossRepository: z.boolean() })) }),
    }).nullable(),
  }),
})

type PullRequestNode = z.infer<typeof pullRequestSchema>
type RepositoryNode = z.infer<typeof repositorySchema>

/** GitHub merge states in which the merge button works: mergeable, with passing or non-required failing checks. */
const MERGEABLE_NOW: ReadonlySet<string> = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE'])

/** Repository permissions that may merge. */
const MERGERS: ReadonlySet<string> = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

/** Merge methods in menu order, with the repository setting that allows each and GitHub's name for it. */
const METHODS: readonly {
  readonly method: MergeMethod
  readonly allowed: 'squashMergeAllowed' | 'mergeCommitAllowed' | 'rebaseMergeAllowed'
  readonly name: string
}[] = [
  { method: 'squash', allowed: 'squashMergeAllowed', name: 'SQUASH' },
  { method: 'merge', allowed: 'mergeCommitAllowed', name: 'MERGE' },
  { method: 'rebase', allowed: 'rebaseMergeAllowed', name: 'REBASE' },
]

/** One batched snapshot query and the change request behind each alias. */
export interface SnapshotQuery {
  /** GraphQL document with one aliased field per change request. */
  readonly document: string
  /** Change requests keyed by alias path `r<i>.p<j>`. */
  readonly targets: ReadonlyMap<string, ChangeRequestRef>
}

/**
 * Build one query that reads every change request in `refs`, grouping them by
 * repository. Owners, names, and numbers are validated before they are inlined.
 * @param refs - change requests on one host.
 * @returns the document and its alias targets.
 * @throws when an owner, name, or number cannot be inlined safely.
 */
export function snapshotQuery(refs: readonly ChangeRequestRef[]): SnapshotQuery {
  const repositories = new Map<string, { repository: ForgeRepository; numbers: Map<number, ChangeRequestRef> }>()
  for (const ref of refs) {
    const { owner, name } = checkedRepository(ref)
    const id = `${owner}/${name}`.toLowerCase()
    let entry = repositories.get(id)
    if (entry === undefined) {
      entry = { repository: ref.repository, numbers: new Map() }
      repositories.set(id, entry)
    }
    if (!entry.numbers.has(ref.number)) entry.numbers.set(ref.number, ref)
  }
  const targets = new Map<string, ChangeRequestRef>()
  const fields: string[] = []
  for (const [r, { repository, numbers }] of [...repositories.values()].entries()) {
    const pulls: string[] = []
    for (const [p, [number, ref]] of [...numbers].entries()) {
      pulls.push(`p${p}: pullRequest(number: ${number}) { ...ChangeRequestFields }`)
      targets.set(`r${r}.p${p}`, ref)
    }
    const owner = JSON.stringify(repository.owner)
    fields.push(`r${r}: repository(owner: ${owner}, name: ${JSON.stringify(repository.name)}) { ${REPOSITORY_FIELDS} ${pulls.join(' ')} }`)
  }
  return { document: `query { ${fields.join(' ')} }\nfragment ChangeRequestFields on PullRequest { ${PULL_REQUEST_FIELDS} }`, targets }
}

/**
 * Map a snapshot response, including GitHub's partial-error form, into one
 * result per alias target. Path-scoped errors apply to their repository or
 * pull request; errors without a path apply to every unresolved target. A
 * repository without readable merge settings offers no merge.
 * @param body - parsed JSON printed by `gh api graphql`.
 * @param query - the query that produced the response.
 * @returns a snapshot or failure for every target.
 */
export function mapSnapshotResponse(body: unknown, query: SnapshotQuery): Map<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure> {
  const results = new Map<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>()
  const parsed = responseSchema.safeParse(body)
  for (const [alias, ref] of query.targets) {
    const key = changeRequestKey(ref)
    if (!parsed.success) {
      results.set(key, { code: 'unavailable', message: 'unexpected GitHub response' })
      continue
    }
    const [repositoryAlias = '', pullAlias = ''] = alias.split('.')
    const errors = parsed.data.errors ?? []
    const error = errors.find(entry => entry.path?.[0] === repositoryAlias && (entry.path.length === 1 || entry.path[1] === pullAlias))
      ?? errors.find(entry => entry.path === undefined)
    const raw = parsed.data.data?.[repositoryAlias]?.[pullAlias]
    const node = pullRequestSchema.safeParse(raw)
    const settings = repositorySchema.safeParse(parsed.data.data?.[repositoryAlias])
    if (node.success) results.set(key, toSnapshot(ref, node.data, settings.success ? settings.data : undefined))
    else if (error !== undefined) results.set(key, { code: error.type === 'NOT_FOUND' ? 'not-found' : 'unavailable', message: error.message })
    else if (raw === null || raw === undefined) results.set(key, { code: 'not-found', message: 'pull request not found' })
    else results.set(key, { code: 'unavailable', message: 'unexpected pull request fields' })
  }
  return results
}

/**
 * Map a head-branch lookup of {@link HEAD_QUERY}, which selects open pull requests, into change requests.
 * @param body - parsed JSON printed by `gh api graphql`.
 * @param repository - repository that was queried.
 * @param branch - head branch that was queried.
 * @returns open non-fork change requests for `branch`, or none when it is the default branch.
 * @throws when the response is malformed or the repository is not visible.
 */
export function mapHeadResponse(body: unknown, repository: ForgeRepository, branch: string): ChangeRequestRef[] {
  const parsed = headSchema.safeParse(body)
  if (!parsed.success) throw new Error('forge-github: unexpected GitHub response to the head branch lookup')
  const found = parsed.data.data.repository
  if (found === null) throw new Error(`forge-github: repository ${repository.owner}/${repository.name} is not visible`)
  if (found.defaultBranchRef?.name === branch) return []
  return found.pullRequests.nodes.filter(node => !node.isCrossRepository).map(node => ({ repository, number: node.number }))
}

function toSnapshot(ref: ChangeRequestRef, node: PullRequestNode, settings: RepositoryNode | undefined): ChangeRequestSnapshot {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null
  const checks: ChangeRequestCheck[] = []
  for (const context of rollup?.contexts.nodes ?? []) {
    const run = checkRunSchema.safeParse(context)
    if (run.success) {
      checks.push({
        name: run.data.name,
        state: checkRunState(run.data.status, run.data.conclusion),
        url: run.data.detailsUrl,
        workflow: run.data.checkSuite?.workflowRun?.workflow.name ?? null,
        startedAt: run.data.startedAt,
        completedAt: run.data.completedAt,
      })
      continue
    }
    const status = statusContextSchema.safeParse(context)
    if (status.success) {
      checks.push({
        name: status.data.context,
        state: statusContextState(status.data.state),
        url: status.data.targetUrl,
        workflow: null,
        startedAt: null,
        completedAt: null,
      })
    }
  }
  return {
    ref,
    url: node.url,
    title: node.title,
    state: changeRequestState(node.state),
    draft: node.isDraft,
    author: node.author?.login ?? null,
    headBranch: node.headRefName,
    headSha: node.headRefOid,
    baseBranch: node.baseRefName,
    additions: node.additions,
    deletions: node.deletions,
    mergeability: mergeability(node.mergeable),
    mergeReady: settings !== undefined && MERGERS.has(settings.viewerPermission ?? '') && node.state === 'OPEN' && !node.isDraft
      && MERGEABLE_NOW.has(node.mergeStateStatus),
    mergeMethods: settings === undefined ? [] : mergeMethods(settings),
    reviewDecision: reviewDecision(node.reviewDecision),
    checks,
    checksRollup: checksRollup(rollup?.state),
    checksTruncated: rollup?.contexts.pageInfo.hasNextPage ?? false,
    unresolvedThreads: node.reviewThreads.nodes.filter(thread => !thread.isResolved).length,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
  }
}

/** The methods the repository allows, the viewer's default first. */
function mergeMethods(settings: RepositoryNode): MergeMethod[] {
  const allowed = METHODS.filter(entry => settings[entry.allowed])
  const usual = allowed.filter(entry => entry.name === settings.viewerDefaultMergeMethod)
  return [...usual, ...allowed.filter(entry => !usual.includes(entry))].map(entry => entry.method)
}

function changeRequestState(state: PullRequestNode['state']): ChangeRequestSnapshot['state'] {
  switch (state) {
    case 'OPEN': return 'open'
    case 'CLOSED': return 'closed'
    case 'MERGED': return 'merged'
  }
}

/** GitHub enum values outside the documented set read as the most conservative state. */
function checkRunState(status: string, conclusion: string | null): CheckState {
  if (status !== 'COMPLETED') return 'pending'
  switch (conclusion) {
    case 'SUCCESS': return 'success'
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
    case 'ACTION_REQUIRED': return 'failure'
    case 'CANCELLED': return 'cancelled'
    case 'SKIPPED': return 'skipped'
    default: return 'neutral'
  }
}

function statusContextState(state: string): CheckState {
  switch (state) {
    case 'SUCCESS': return 'success'
    case 'FAILURE':
    case 'ERROR': return 'failure'
    default: return 'pending'
  }
}

function checksRollup(state: string | undefined): ChecksRollup {
  switch (state) {
    case undefined: return 'none'
    case 'SUCCESS': return 'success'
    case 'FAILURE':
    case 'ERROR': return 'failure'
    default: return 'pending'
  }
}

function mergeability(value: string): Mergeability {
  switch (value) {
    case 'MERGEABLE': return 'mergeable'
    case 'CONFLICTING': return 'conflicting'
    default: return 'unknown'
  }
}

function reviewDecision(value: string | null): ReviewDecision {
  switch (value) {
    case 'APPROVED': return 'approved'
    case 'CHANGES_REQUESTED': return 'changes-requested'
    case 'REVIEW_REQUIRED': return 'review-required'
    default: return 'none'
  }
}
