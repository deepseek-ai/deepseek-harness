import { describe, expect, it, vi } from 'vitest'
import type { GraphqlReader } from '../src/commits.ts'
import type { GraphqlWriter } from '../src/mutation.ts'
import {
  CANDIDATES_QUERY, gitHubReviewerCandidates, REQUEST_BOT_REVIEWS_MUTATION, REQUEST_REVIEWS_MUTATION, requestGitHubReviews,
  UPDATE_BRANCH_MUTATION, updateGitHubBranch,
} from '../src/overview.ts'
import { pullRequestNode } from '../src/pull-request-node.ts'
import { pull } from './fixtures.ts'

const HEAD = 'f'.repeat(40)
const signal = new AbortController().signal

function reader(...bodies: unknown[]): { read: GraphqlReader; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  return {
    calls,
    read: async (args) => {
      calls.push(args)
      const body = bodies.shift()
      if (body instanceof Error) return { ok: false, failure: { code: body.message === 'signed out' ? 'unauthenticated' : 'unavailable', message: body.message } }
      return { ok: true, body }
    },
  }
}

const node = (headRefOid = HEAD) => ({ data: { repository: { pullRequest: { id: 'PR_7', headRefOid } } } })

describe('pull request node reads', () => {
  it.each([
    ['a head that moved', node('e'.repeat(40)), HEAD, { code: 'stale', message: `the pull request head moved from ${HEAD} to ${'e'.repeat(40)}` }],
    ['an unexpected response', { data: {} }, HEAD, { code: 'failed', message: 'unexpected GitHub response to the pull request read' }],
    ['a missing pull request', { data: { repository: { pullRequest: null } } }, HEAD, { code: 'failed', message: 'pull request 7 was not found' }],
    ['a missing repository', { data: { repository: null } }, null, { code: 'failed', message: 'pull request 7 was not found' }],
    ['a refused read', new Error('rate limited'), null, { code: 'failed', message: 'rate limited' }],
    ['a missing sign-in', new Error('signed out'), null, { code: 'unauthenticated', message: 'signed out' }],
  ])('refuses %s', async (_label, body, head, failure) => {
    await expect(pullRequestNode(reader(body).read, pull(7), head, signal)).resolves.toEqual(failure)
  })

  it('returns the node id at the head, or at any head without one, comparing heads without regard to case', async () => {
    await expect(pullRequestNode(reader(node()).read, pull(7), HEAD.toUpperCase(), signal)).resolves.toBe('PR_7')
    await expect(pullRequestNode(reader(node('e'.repeat(40))).read, pull(7), null, signal)).resolves.toBe('PR_7')
  })
})

describe('review requests', () => {
  it('asks users and teams by node id, then bots by login with the bot suffix, adding to the requests GitHub holds', async () => {
    const write = vi.fn<GraphqlWriter>(async () => undefined)
    const reviewers = [
      { kind: 'user' as const, login: 'mona' }, { kind: 'bot' as const, login: 'copilot' }, { kind: 'bot' as const, login: 'helper[bot]' },
      { kind: 'team' as const, login: 'octo/forge' }, { kind: 'user' as const, login: 'lin' },
    ]
    const ids = { data: { u0: { id: 'U_mona' }, u1: { id: 'U_lin' }, t0: { team: { id: 'T_forge' } } } }
    const lookup = reader(node(), ids)
    await expect(requestGitHubReviews(lookup.read, write, pull(7), { reviewers }, signal)).resolves.toBeUndefined()
    // Names travel as variables, never inside the query text.
    expect(lookup.calls[1]).toEqual(['api', 'graphql', '--hostname', 'github.com', '-f',
      'query=query($u0: String!, $u1: String!, $o0: String!, $t0: String!) { u0: user(login: $u0) { id } u1: user(login: $u1) { id } '
        + 't0: organization(login: $o0) { team(slug: $t0) { id } } }',
      '-f', 'u0=mona', '-f', 'u1=lin', '-f', 'o0=octo', '-f', 't0=forge'])
    expect(write.mock.calls.map(call => call[1])).toEqual([
      { query: REQUEST_REVIEWS_MUTATION, field: 'requestReviews',
        variables: { input: { pullRequestId: 'PR_7', union: true, userIds: ['U_mona', 'U_lin'], teamIds: ['T_forge'] } } },
      { query: REQUEST_BOT_REVIEWS_MUTATION, field: 'requestReviewsByLogin',
        variables: { input: { pullRequestId: 'PR_7', union: true, botLogins: ['copilot[bot]', 'helper[bot]'] } } },
    ])
  })

  it('names only the kinds it requests, at any head, and stops at a refusal', async () => {
    const write = vi.fn<GraphqlWriter>(async () => ({ code: 'failed', message: 'Could not resolve user' }))
    const mixed = [{ kind: 'user' as const, login: 'mona' }, { kind: 'bot' as const, login: 'copilot' }]
    await expect(requestGitHubReviews(reader(node('e'.repeat(40)), { data: { u0: { id: 'U_mona' } } }).read, write, pull(7), { reviewers: mixed }, signal))
      .resolves.toEqual({ code: 'failed', message: 'Could not resolve user' })
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]?.[1].variables).toEqual({ input: { pullRequestId: 'PR_7', union: true, userIds: ['U_mona'] } })
    await requestGitHubReviews(reader(node(), { data: { t0: { team: { id: 'T_forge' } } } }).read, write, pull(7),
      { reviewers: [{ kind: 'team', login: 'octo/forge' }] }, signal)
    expect(write.mock.calls[1]?.[1].variables).toEqual({ input: { pullRequestId: 'PR_7', union: true, teamIds: ['T_forge'] } })
    const bots = reader(node())
    await requestGitHubReviews(bots.read, write, pull(7), { reviewers: [{ kind: 'bot', login: 'copilot' }] }, signal)
    expect(bots.calls).toHaveLength(1)
    expect(write.mock.calls[2]?.[1].field).toBe('requestReviewsByLogin')
  })

  it.each([
    ['an unknown user', [{ kind: 'user' as const, login: 'ghost' }], { data: { u0: null } }, 'GitHub has no user ghost'],
    ['a hidden team', [{ kind: 'team' as const, login: 'octo/secret' }], { data: { t0: { team: null } } }, 'GitHub shows the signed-in user no team octo/secret'],
    ['an unexpected lookup', [{ kind: 'user' as const, login: 'mona' }], { errors: [] }, 'unexpected GitHub response to the reviewer lookup'],
  ])('refuses %s without writing', async (_label, reviewers, ids, message) => {
    const write = vi.fn<GraphqlWriter>()
    await expect(requestGitHubReviews(reader(node(), ids).read, write, pull(7), { reviewers }, signal)).resolves.toEqual({ code: 'failed', message })
    expect(write).not.toHaveBeenCalled()
  })

  it.each([
    ['a refused lookup', new Error('rate limited'), { code: 'failed', message: 'rate limited' }],
    ['a lookup without sign-in', new Error('signed out'), { code: 'unauthenticated', message: 'signed out' }],
  ])('passes on %s', async (_label, failure, expected) => {
    const write = vi.fn<GraphqlWriter>()
    await expect(requestGitHubReviews(reader(node(), failure).read, write, pull(7), { reviewers: [{ kind: 'user', login: 'mona' }] }, signal))
      .resolves.toEqual(expected)
  })

  it.each(['octo', 'octo/', '/forge', 'octo/forge/extra'])('refuses team %s, which is not named organization/slug, without reading', async (login) => {
    const write = vi.fn<GraphqlWriter>()
    const none = reader()
    await expect(requestGitHubReviews(none.read, write, pull(7), { reviewers: [{ kind: 'team', login }] }, signal))
      .resolves.toEqual({ code: 'failed', message: `Team ${JSON.stringify(login)} is not named organization/slug` })
    expect(none.calls).toEqual([])
  })

  it('refuses an empty request without reading, and a failed node read without writing', async () => {
    const write = vi.fn<GraphqlWriter>()
    const empty = reader()
    await expect(requestGitHubReviews(empty.read, write, pull(7), { reviewers: [] }, signal)).resolves.toEqual({ code: 'failed', message: 'No reviewer was named' })
    expect(empty.calls).toEqual([])
    await expect(requestGitHubReviews(reader(new Error('down')).read, write, pull(7), { reviewers: [{ kind: 'user', login: 'mona' }] }, signal))
      .resolves.toEqual({ code: 'failed', message: 'down' })
    expect(write).not.toHaveBeenCalled()
  })
})

describe('branch updates', () => {
  it.each([['merge', 'MERGE'], ['rebase', 'REBASE']] as const)('updates by %s with the confirmed head as GitHub expects it', async (method, updateMethod) => {
    const write = vi.fn<GraphqlWriter>(async () => undefined)
    await expect(updateGitHubBranch(reader(node()).read, write, pull(7), { method, headSha: HEAD }, signal)).resolves.toBeUndefined()
    expect(write).toHaveBeenCalledWith('github.com', { query: UPDATE_BRANCH_MUTATION, field: 'updatePullRequestBranch',
      variables: { input: { pullRequestId: 'PR_7', expectedHeadOid: HEAD, updateMethod } } }, signal)
  })

  it('refuses a moved head without writing and an invalid head without reading', async () => {
    const write = vi.fn<GraphqlWriter>()
    await expect(updateGitHubBranch(reader(node('e'.repeat(40))).read, write, pull(7), { method: 'merge', headSha: HEAD }, signal))
      .resolves.toMatchObject({ code: 'stale' })
    expect(write).not.toHaveBeenCalled()
    const none = reader()
    await expect(updateGitHubBranch(none.read, write, pull(7), { method: 'merge', headSha: 'main' }, signal))
      .rejects.toThrow('forge-github: invalid head commit "main"')
    expect(none.calls).toEqual([])
  })
})

describe('reviewer candidates', () => {
  const account = (login: string, name: string | null = null) => ({ login, name, avatarUrl: null })
  const listing = (suggested: readonly unknown[], users: readonly unknown[], author: unknown = { login: 'Octo' }) => ({ data: { repository: {
    assignableUsers: { nodes: users },
    pullRequest: { author, suggestedReviewers: suggested.map(reviewer => ({ reviewer })) },
  } } })

  it('lists the suggestions first without the author, then the accounts, each once', async () => {
    const { read, calls } = reader(listing([account('lin', 'Lin'), account('octo')], [account('LIN'), account('mona', 'Mona'), account('octo')]))
    await expect(gitHubReviewerCandidates(read, pull(7), ' ', signal)).resolves.toEqual([
      { login: 'lin', name: 'Lin', avatarUrl: null, suggested: true },
      { login: 'mona', name: 'Mona', avatarUrl: null, suggested: false },
    ])
    expect(calls[0]).toEqual(['api', 'graphql', '--hostname', 'github.com', '-f', `query=${CANDIDATES_QUERY}`, '-f', 'owner=octo', '-f', 'name=demo',
      '-F', 'number=7', '-f', 'search='])
  })

  it('leaves suggestions out of a search and keeps at most twenty accounts', async () => {
    const users = Array.from({ length: 25 }, (_, index) => account(`user${index}`))
    const result = await gitHubReviewerCandidates(reader(listing([account('lin')], users, null)).read, pull(7), 'user', signal)
    expect('code' in result ? result : result.map(entry => entry.login)).toEqual(users.slice(0, 20).map(user => user.login))
  })

  it('lists accounts when the pull request is gone', async () => {
    const body = { data: { repository: { assignableUsers: { nodes: [account('mona')] }, pullRequest: null } } }
    await expect(gitHubReviewerCandidates(reader(body).read, pull(7), '', signal))
      .resolves.toEqual([{ login: 'mona', name: null, avatarUrl: null, suggested: false }])
  })

  it.each([
    ['a refused read', new Error('down'), { code: 'unavailable', message: 'down' }],
    ['an unexpected response', { data: {} }, { code: 'unavailable', message: 'unexpected GitHub response to the reviewer listing' }],
    ['a hidden repository', { data: { repository: null } }, { code: 'not-found', message: 'repository octo/demo is not visible' }],
  ])('reports %s', async (_label, body, failure) => {
    await expect(gitHubReviewerCandidates(reader(body).read, pull(7), '', signal)).resolves.toEqual(failure)
  })
})
