import type { ChangeRequestRef, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'

/** Repository on github.com used across the provider tests. */
export const demo: ForgeRepository = { forge: 'github', host: 'github.com', owner: 'octo', name: 'demo' }

/** Build a pull request reference in `demo` or another repository. */
export function pull(number: number, repository: ForgeRepository = demo): ChangeRequestRef {
  return { repository, number }
}

/** One CheckRun context node as GitHub returns it. */
export function checkRun(name: string, status: string, conclusion: string | null, workflow: string | null = 'ci'): Record<string, unknown> {
  return {
    __typename: 'CheckRun', id: 'check-1', databaseId: 1,
    name,
    status,
    conclusion,
    detailsUrl: `https://github.com/octo/demo/actions/runs/1/job/${name}`,
    startedAt: status === 'QUEUED' ? null : '2026-10-09T01:00:00Z',
    completedAt: status === 'COMPLETED' ? '2026-10-09T01:02:07Z' : null,
    checkSuite: {
      app: { id: 'github-actions' },
      workflowRun: workflow === null ? null : { databaseId: 7, event: 'pull_request', workflow: { id: workflow, name: workflow } },
    },
  }
}

/** One StatusContext node as GitHub returns it. */
export function statusContext(context: string, state: string): Record<string, unknown> {
  return { __typename: 'StatusContext', context, state, targetUrl: null, createdAt: '2026-10-09T01:00:00Z' }
}

/** Merge settings of a repository that allows squash and merge commits and whose viewer may merge, usually with a merge commit. */
export function repositorySettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    squashMergeAllowed: true,
    mergeCommitAllowed: true,
    rebaseMergeAllowed: false,
    viewerPermission: 'WRITE',
    viewerDefaultMergeMethod: 'MERGE',
    ...overrides,
  }
}

/** A pull request node with the fields the snapshot query selects. */
export function pullRequestNode(number: number, overrides: Record<string, unknown> = {}, contexts: unknown[] = [], rollupState: string | null = 'SUCCESS'): Record<string, unknown> {
  return {
    id: `pull-${number}`,
    number,
    url: `https://github.com/octo/demo/pull/${number}`,
    title: `Change ${number}`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: '2026-10-09T01:02:03Z',
    closedAt: null,
    author: { login: 'octo' },
    headRefName: `topic-${number}`,
    headRefOid: 'f'.repeat(40),
    baseRefName: 'master',
    baseRefOid: 'b'.repeat(40),
    additions: 128,
    deletions: 14,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    viewerCanUpdateBranch: false,
    canBeRebased: false,
    reviewThreads: threadPage([true, false, false]),
    reviewRequests: { totalCount: 0, nodes: [] },
    latestReviews: { totalCount: 0, nodes: [] },
    latestOpinionatedReviews: { totalCount: 0, nodes: [] },
    closingIssuesReferences: { totalCount: 0, nodes: [] },
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: rollupState === null ? null : {
            id: `rollup-${number}`, state: rollupState,
            contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: contexts },
          },
        },
      }],
    },
    ...overrides,
  }
}

/** A review thread connection page as GitHub returns it. */
export interface ThreadPage {
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null }
  readonly nodes: { readonly isResolved: boolean }[]
}

/** One review thread connection page with the threads' resolution, followed by the page after `next` when it is a cursor. */
export function threadPage(resolved: readonly boolean[], next: string | null = null): ThreadPage {
  return { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: resolved.map(isResolved => ({ isResolved })) }
}
