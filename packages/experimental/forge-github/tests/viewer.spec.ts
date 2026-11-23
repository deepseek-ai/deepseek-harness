import { describe, expect, it } from 'vitest'
import type { GhOutput, GhRunner } from '../src/gh.ts'
import { GitHubProvider } from '../src/provider.ts'
import type { GitHubLimits } from '../src/provider.ts'
import { searchText, VIEWER_COUNT_QUERY, VIEWER_LIST_QUERY } from '../src/viewer.ts'

const signal = new AbortController().signal

const limits: GitHubLimits = {
  maxOutputBytes: 8_388_608, maxReviewThreads: 1_000, snapshotBatchSize: 8, briefBatchSize: 50,
  maxCommits: 250, maxViewedFiles: 3_000, maxViewerItems: 50,
}

function fakeGh(handler: (args: readonly string[]) => GhOutput): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, run: async (args) => { calls.push([...args]); return handler(args) } }
}

function output(stdout: unknown, exitCode = 0, stderr = ''): GhOutput {
  return { exitCode, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr }
}

function provider(run: GhRunner): GitHubProvider {
  return new GitHubProvider(run, ['github.com', 'GHE.corp.example'], limits)
}

/** One search result node with the fields the viewer list query selects. */
function row(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    number,
    title: `Change ${number}`,
    url: `https://github.com/octo/demo/pull/${number}`,
    isDraft: false,
    updatedAt: '2026-11-10T09:29:00Z',
    headRefOid: 'f'.repeat(40),
    reviewDecision: null,
    repository: { name: 'demo', owner: { login: 'octo' } },
    author: { __typename: 'User', login: 'turtle', avatarUrl: 'https://avatars.example/turtle' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
    viewerLatestReview: null,
    viewerLatestReviewRequest: { requestedReviewer: { __typename: 'User' } },
    ...overrides,
  }
}

function listBody(nodes: unknown[], issueCount = nodes.length): Record<string, unknown> {
  return { data: { viewer: { login: 'LegGasai' }, search: { issueCount, nodes } } }
}

const query = { host: 'github.com', filter: 'review-requested' as const, repository: null, limit: 20 }

describe('GitHub viewer lists', () => {
  it('declares the three lists on every configured host with its item limit', () => {
    expect(provider(fakeGh(() => output('')).run).viewer).toEqual({
      hosts: ['github.com', 'ghe.corp.example'], filters: new Set(['review-requested', 'authored', 'involved']), maxItems: 50,
    })
  })

  it('builds one search per list, scoped to a repository when asked, and refuses a name that cannot be a qualifier', () => {
    expect(searchText('review-requested', null)).toBe('is:pr is:open archived:false review-requested:@me sort:updated-desc')
    expect(searchText('authored', { owner: 'octo', name: 'demo' })).toBe('is:pr is:open archived:false author:@me repo:octo/demo sort:updated-desc')
    expect(searchText('involved', null))
      .toBe('is:pr is:open archived:false involves:@me -author:@me -review-requested:@me sort:updated-desc')
    expect(searchText('authored', { owner: 'octo demo', name: 'x' })).toBeUndefined()
    expect(searchText('authored', { owner: 'octo', name: 'a:b' })).toBeUndefined()
  })

  it('reads one list through one search on the queried host and maps each pull request', async () => {
    const gh = fakeGh(() => output(listBody([
      row(8225),
      row(7155, {
        isDraft: true,
        reviewDecision: 'CHANGES_REQUESTED',
        author: { __typename: 'Bot', login: 'dependabot', avatarUrl: null },
        commits: { nodes: [] },
        viewerLatestReview: { state: 'CHANGES_REQUESTED', commit: { oid: '2'.repeat(40) } },
        viewerLatestReviewRequest: { requestedReviewer: { __typename: 'Team', combinedSlug: 'octo/core' } },
      }),
      row(6, { author: null, viewerLatestReview: { state: 'PENDING', commit: null }, viewerLatestReviewRequest: null }),
      row(7, { viewerLatestReview: { state: 'COMMENTED', commit: null }, viewerLatestReviewRequest: { requestedReviewer: { __typename: 'Team' } } }),
      row(8, { viewerLatestReviewRequest: { requestedReviewer: null } }),
      row(9, { repository: { name: 'bad name', owner: { login: 'octo' } } }),
      { __typename: 'Issue' },
      {},
    ], 32)))

    const result = await provider(gh.run).listForViewer(query, signal)

    expect(gh.calls).toEqual([['api', 'graphql', '--hostname', 'github.com', '-f', `query=${VIEWER_LIST_QUERY}`,
      '-f', 'q=is:pr is:open archived:false review-requested:@me sort:updated-desc', '-F', 'first=20']])
    expect(result).toEqual({
      viewer: 'LegGasai',
      total: 32,
      items: [
        {
          ref: { repository: { forge: 'github', host: 'github.com', owner: 'octo', name: 'demo' }, number: 8225 },
          url: 'https://github.com/octo/demo/pull/8225',
          title: 'Change 8225',
          draft: false,
          author: { login: 'turtle', avatarUrl: 'https://avatars.example/turtle', bot: false },
          headSha: 'f'.repeat(40),
          checksRollup: 'failure',
          reviewDecision: 'none',
          viewerReview: null,
          viewerRequest: { team: null },
          updatedAt: '2026-11-10T09:29:00Z',
        },
        expect.objectContaining({
          draft: true,
          author: { login: 'dependabot', avatarUrl: null, bot: true },
          checksRollup: 'none',
          reviewDecision: 'changes-requested',
          viewerReview: { verdict: 'changes-requested', reviewedSha: '2'.repeat(40) },
          viewerRequest: { team: 'octo/core' },
        }),
        expect.objectContaining({ title: 'Change 6', author: null, viewerReview: null, viewerRequest: null }),
        expect.objectContaining({ title: 'Change 7', viewerReview: { verdict: 'commented', reviewedSha: null }, viewerRequest: { team: null } }),
        expect.objectContaining({ title: 'Change 8', viewerRequest: null }),
      ],
    })
  })

  it('scopes a read to one repository and refuses a repository name search cannot express without asking GitHub', async () => {
    const gh = fakeGh(() => output(listBody([])))
    const subject = provider(gh.run)
    await subject.listForViewer({ ...query, filter: 'authored', repository: { owner: 'octo', name: 'demo' } }, signal)
    expect(gh.calls[0]).toContain('q=is:pr is:open archived:false author:@me repo:octo/demo sort:updated-desc')
    await expect(subject.listForViewer({ ...query, repository: { owner: 'octo', name: 'a b' } }, signal))
      .resolves.toEqual({ code: 'not-found', message: 'the repository name cannot be searched' })
    expect(gh.calls).toHaveLength(1)
  })

  it.each([0, -1, 1.5, 51])('rejects a limit of %s outside 1 to maxViewerItems', async (limit) => {
    const gh = fakeGh(() => output(listBody([])))
    await expect(provider(gh.run).listForViewer({ ...query, limit }, signal))
      .rejects.toThrow('forge-github: viewer list limit must be a positive integer no greater than 50')
    expect(gh.calls).toEqual([])
  })

  it('refuses an unconfigured host without asking GitHub', async () => {
    const gh = fakeGh(() => output(listBody([])))
    const subject = provider(gh.run)
    const denied = { code: 'unavailable', message: 'forge-github: host "unconfigured.example" is not configured' }
    await expect(subject.listForViewer({ ...query, host: 'unconfigured.example' }, signal)).resolves.toEqual(denied)
    await expect(subject.countForViewer('unconfigured.example', signal)).resolves.toEqual(denied)
    expect(gh.calls).toEqual([])
  })

  it.each([
    ['a body that is not a search', output({ data: { viewer: { login: 'octo' } } }), { code: 'unavailable', message: 'unexpected GitHub response to the pull request search' }],
    ['a rate limit', output({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] }, 1, 'gh: API rate limit exceeded for user ID 1.'),
      { code: 'rate-limited', message: 'gh: API rate limit exceeded for user ID 1.' }],
    ['a secondary rate limit', output({ message: 'You have exceeded a secondary rate limit.' }, 1, 'gh: You have exceeded a secondary rate limit. (HTTP 403)'),
      { code: 'rate-limited', message: 'You have exceeded a secondary rate limit.' }],
    ['too many requests', output('', 1, 'gh: Too Many Requests (HTTP 429)'), { code: 'rate-limited', message: 'gh: Too Many Requests (HTTP 429)' }],
    ['a rate limit error in a complete answer', output({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'Throttled' }] }),
      { code: 'rate-limited', message: 'Throttled' }],
    ['a sign-in failure', output({ message: 'Bad credentials' }, 1, 'gh: Bad credentials (HTTP 401)'), { code: 'unauthenticated', message: 'Bad credentials' }],
  ])('reports %s', async (_, answer, failure) => {
    await expect(provider(fakeGh(() => answer).run).listForViewer(query, signal)).resolves.toEqual(failure)
  })

  it('counts every list on a host in one request', async () => {
    const gh = fakeGh(() => output({ data: { review: { issueCount: 32 }, authored: { issueCount: 23 }, involved: { issueCount: 15 } } }))
    await expect(provider(gh.run).countForViewer('ghe.corp.example', signal))
      .resolves.toEqual(new Map([['review-requested', 32], ['authored', 23], ['involved', 15]]))
    expect(gh.calls).toEqual([['api', 'graphql', '--hostname', 'ghe.corp.example', '-f', `query=${VIEWER_COUNT_QUERY}`,
      '-f', 'review=is:pr is:open archived:false review-requested:@me', '-f', 'authored=is:pr is:open archived:false author:@me',
      '-f', 'involved=is:pr is:open archived:false involves:@me -author:@me -review-requested:@me']])
  })

  it('reports a count GitHub refuses or answers unexpectedly', async () => {
    await expect(provider(fakeGh(() => output('', 1, 'gh: Something went wrong (HTTP 502)')).run).countForViewer('github.com', signal))
      .resolves.toEqual({ code: 'unavailable', message: 'gh: Something went wrong (HTTP 502)' })
    await expect(provider(fakeGh(() => output({ data: { review: { issueCount: 1 } } })).run).countForViewer('github.com', signal))
      .resolves.toEqual({ code: 'unavailable', message: 'unexpected GitHub response to the pull request count' })
  })
})
