import { describe, expect, it } from 'vitest'
import { ACTIVITY_QUERY } from '../src/activity.ts'
import { GhTimeoutError, GhUnavailableError } from '../src/gh.ts'
import type { GhOutput, GhRunner } from '../src/gh.ts'
import { GitHubProvider } from '../src/provider.ts'
import type { GitHubLimits } from '../src/provider.ts'
import { demo, pull } from './fixtures.ts'

const signal = new AbortController().signal

const limits: GitHubLimits = {
  maxOutputBytes: 8_388_608, maxReviewThreads: 1_000, snapshotBatchSize: 8, briefBatchSize: 50,
  maxCommits: 250, maxViewedFiles: 3_000, maxViewerItems: 50,
}

/** One `gh` run: its arguments and what it received on standard input. */
interface Call {
  readonly args: readonly string[]
  readonly input: string | undefined
}

function fakeGh(handler: () => GhOutput | Promise<GhOutput>): { run: GhRunner; calls: Call[] } {
  const calls: Call[] = []
  return { calls, run: async (args, _signal, input) => { calls.push({ args: [...args], input }); return await handler() } }
}

function output(stdout: unknown, exitCode = 0, stderr = ''): GhOutput {
  return { exitCode, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr }
}

function provider(run: GhRunner): GitHubProvider {
  return new GitHubProvider(run, ['github.com'], limits)
}

const octo = { __typename: 'User', login: 'octo', avatarUrl: 'https://avatars.example/octo' }
const actions = { __typename: 'Bot', login: 'github-actions', avatarUrl: 'https://avatars.example/actions' }
const octoActor = { login: 'octo', avatarUrl: 'https://avatars.example/octo', bot: false }
const actionsActor = { login: 'github-actions', avatarUrl: 'https://avatars.example/actions', bot: true }

/** One timeline event that carries only its time and actor. */
function event(type: string, createdAt: string, actor: unknown = octo): Record<string, unknown> {
  return { __typename: type, createdAt, actor }
}

function commit(oid: string, committedDate: string, author: unknown, messageHeadline = `Commit ${oid}`): Record<string, unknown> {
  return { __typename: 'PullRequestCommit', commit: { oid, messageHeadline, committedDate, author } }
}

function review(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'PullRequestReview', createdAt: '2026-11-02T08:00:00Z', submittedAt: '2026-11-02T09:00:00Z',
    url: `https://github.com/octo/demo/pull/7#pullrequestreview-${state}`, body: '', state, author: octo, comments: { totalCount: 0 },
    ...overrides,
  }
}

/** Fields of an activity answer that differ from an open, unlocked pull request a reader sees whole. */
interface Overrides {
  readonly merged?: boolean
  readonly locked?: boolean
  readonly isArchived?: boolean
  readonly viewerPermission?: string | null
  readonly hasPreviousPage?: boolean
}

/** An activity answer for a pull request with `nodes` as its latest timeline entries. */
function activityBody(nodes: readonly unknown[], overrides: Overrides = {}): Record<string, unknown> {
  return { data: { repository: {
    isArchived: overrides.isArchived ?? false,
    viewerPermission: overrides.viewerPermission === undefined ? 'READ' : overrides.viewerPermission,
    pullRequest: {
      locked: overrides.locked ?? false,
      merged: overrides.merged ?? false,
      timelineItems: { pageInfo: { hasPreviousPage: overrides.hasPreviousPage ?? false }, nodes },
    },
  } } }
}

async function kinds(body: unknown): Promise<unknown> {
  const result = await provider(fakeGh(() => output(body)).run).readActivity(pull(7), signal)
  return 'code' in result ? result : result.items.map(item => item.kind)
}

describe('GitHub activity reads', () => {
  it('reads the latest timeline entries in one request and maps each to the activity kind of the same meaning', async () => {
    const gh = fakeGh(() => output(activityBody([
      commit('a'.repeat(40), '2026-11-01T08:00:00Z', { user: octo }, 'feat: add the panel'),
      commit('b'.repeat(40), '2026-11-01T08:01:00Z', { user: { __typename: 'User', login: 'dependabot[bot]', avatarUrl: null } }),
      commit('c'.repeat(40), '2026-11-01T08:02:00Z', { user: null }),
      commit('d'.repeat(40), '2026-11-01T08:03:00Z', null),
      { __typename: 'IssueComment', createdAt: '2026-11-01T09:00:00Z', url: 'https://github.com/octo/demo/pull/7#issuecomment-1',
        body: 'Coverage **92%**', author: actions },
      { __typename: 'IssueComment', createdAt: '2026-11-01T09:01:00Z', url: 'https://github.com/octo/demo/pull/7#issuecomment-2',
        body: 'from a deleted account', author: null },
      { ...event('RenamedTitleEvent', '2026-11-01T10:00:00Z'), previousTitle: 'Old title', currentTitle: 'New title' },
      event('ReadyForReviewEvent', '2026-11-01T10:01:00Z'),
      event('ConvertToDraftEvent', '2026-11-01T10:02:00Z'),
      { ...event('ReviewRequestedEvent', '2026-11-01T10:03:00Z'), requestedReviewer: { login: 'hubot' } },
      { ...event('ReviewRequestedEvent', '2026-11-01T10:04:00Z'), requestedReviewer: { combinedSlug: 'octo/reviewers' } },
      { ...event('ReviewRequestedEvent', '2026-11-01T10:05:00Z'), requestedReviewer: null },
      { ...event('ReviewRequestedEvent', '2026-11-01T10:06:00Z', null), requestedReviewer: {} },
      review('COMMENTED', { body: 'Two notes', comments: { totalCount: 2 } }),
      review('CHANGES_REQUESTED'),
      review('DISMISSED'),
      review('APPROVED', { createdAt: '2026-11-02T10:00:00Z', submittedAt: null, author: null }),
      event('HeadRefForcePushedEvent', '2026-11-03T08:00:00Z'),
      event('AutoMergeEnabledEvent', '2026-11-03T08:01:00Z'),
      event('AutoMergeDisabledEvent', '2026-11-03T08:02:00Z'),
      event('ClosedEvent', '2026-11-03T08:03:00Z'),
      event('ReopenedEvent', '2026-11-03T08:04:00Z'),
      event('MergedEvent', '2026-11-03T08:05:00Z'),
    ])))

    const result = await provider(gh.run).readActivity(pull(7), signal)

    expect(gh.calls).toEqual([{ input: undefined, args: ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${ACTIVITY_QUERY}`,
      '-f', 'owner=octo', '-f', 'name=demo', '-F', 'number=7'] }])
    const reviewUrl = (state: string): string => `https://github.com/octo/demo/pull/7#pullrequestreview-${state}`
    expect(result).toEqual({
      truncated: false,
      viewerCanComment: true,
      items: [
        { kind: 'commit', at: '2026-11-01T08:00:00Z', actor: octoActor, sha: 'a'.repeat(40), title: 'feat: add the panel' },
        { kind: 'commit', at: '2026-11-01T08:01:00Z', actor: { login: 'dependabot[bot]', avatarUrl: null, bot: true }, sha: 'b'.repeat(40),
          title: `Commit ${'b'.repeat(40)}` },
        { kind: 'commit', at: '2026-11-01T08:02:00Z', actor: null, sha: 'c'.repeat(40), title: `Commit ${'c'.repeat(40)}` },
        { kind: 'commit', at: '2026-11-01T08:03:00Z', actor: null, sha: 'd'.repeat(40), title: `Commit ${'d'.repeat(40)}` },
        { kind: 'comment', at: '2026-11-01T09:00:00Z', actor: actionsActor, body: 'Coverage **92%**',
          url: 'https://github.com/octo/demo/pull/7#issuecomment-1' },
        { kind: 'comment', at: '2026-11-01T09:01:00Z', actor: null, body: 'from a deleted account',
          url: 'https://github.com/octo/demo/pull/7#issuecomment-2' },
        { kind: 'renamed', at: '2026-11-01T10:00:00Z', actor: octoActor, from: 'Old title', to: 'New title' },
        { kind: 'ready-for-review', at: '2026-11-01T10:01:00Z', actor: octoActor },
        { kind: 'converted-to-draft', at: '2026-11-01T10:02:00Z', actor: octoActor },
        { kind: 'review-requested', at: '2026-11-01T10:03:00Z', actor: octoActor, reviewer: 'hubot' },
        { kind: 'review-requested', at: '2026-11-01T10:04:00Z', actor: octoActor, reviewer: 'octo/reviewers' },
        { kind: 'review-requested', at: '2026-11-01T10:05:00Z', actor: octoActor, reviewer: null },
        { kind: 'review-requested', at: '2026-11-01T10:06:00Z', actor: null, reviewer: null },
        { kind: 'review', at: '2026-11-02T09:00:00Z', actor: octoActor, verdict: 'commented', body: 'Two notes', comments: 2,
          url: reviewUrl('COMMENTED') },
        { kind: 'review', at: '2026-11-02T09:00:00Z', actor: octoActor, verdict: 'changes-requested', body: '', comments: 0,
          url: reviewUrl('CHANGES_REQUESTED') },
        { kind: 'review', at: '2026-11-02T09:00:00Z', actor: octoActor, verdict: 'dismissed', body: '', comments: 0,
          url: reviewUrl('DISMISSED') },
        { kind: 'review', at: '2026-11-02T10:00:00Z', actor: null, verdict: 'approved', body: '', comments: 0, url: reviewUrl('APPROVED') },
        { kind: 'force-pushed', at: '2026-11-03T08:00:00Z', actor: octoActor },
        { kind: 'auto-merge-enabled', at: '2026-11-03T08:01:00Z', actor: octoActor },
        { kind: 'auto-merge-disabled', at: '2026-11-03T08:02:00Z', actor: octoActor },
        { kind: 'closed', at: '2026-11-03T08:03:00Z', actor: octoActor },
        { kind: 'reopened', at: '2026-11-03T08:04:00Z', actor: octoActor },
        { kind: 'merged', at: '2026-11-03T08:05:00Z', actor: octoActor },
      ],
    })
  })

  it('asks GitHub for the latest 100 entries of every timeline type it maps', () => {
    expect(ACTIVITY_QUERY).toContain('timelineItems(last: 100, itemTypes: [')
    const types = ['PullRequestCommit', 'IssueComment', 'PullRequestReview', 'ReviewRequestedEvent', 'RenamedTitleEvent', 'MergedEvent',
      'ClosedEvent', 'ReopenedEvent', 'ReadyForReviewEvent', 'ConvertToDraftEvent', 'HeadRefForcePushedEvent', 'AutoMergeEnabledEvent',
      'AutoMergeDisabledEvent']
    for (const type of types) {
      expect(ACTIVITY_QUERY).toContain(`... on ${type} {`)
      expect(ACTIVITY_QUERY).toMatch(new RegExp(String.raw`\b${type.replaceAll(/(?<!^)[A-Z]/g, letter => `_${letter}`).toUpperCase()}\b`))
    }
  })

  it('leaves out a pending review and an entry GitHub does not show', async () => {
    await expect(kinds(activityBody([review('PENDING', { submittedAt: null }), null, review('APPROVED')]))).resolves.toEqual(['review'])
  })

  it('leaves out the close a merge records, and keeps a close the pull request was reopened after', async () => {
    const closed = event('ClosedEvent', '2026-11-03T08:00:00Z')
    const reopened = event('ReopenedEvent', '2026-11-03T08:01:00Z')
    const merged = event('MergedEvent', '2026-11-03T08:02:00Z')
    const implied = event('ClosedEvent', '2026-11-03T08:03:00Z')
    await expect(kinds(activityBody([merged, implied], { merged: true }))).resolves.toEqual(['merged'])
    await expect(kinds(activityBody([implied, merged], { merged: true }))).resolves.toEqual(['merged'])
    await expect(kinds(activityBody([closed, reopened, merged, implied], { merged: true })))
      .resolves.toEqual(['closed', 'reopened', 'merged'])
    // The merge is older than the latest 100 entries, and its close is among them.
    await expect(kinds(activityBody([implied, review('APPROVED')], { merged: true, hasPreviousPage: true }))).resolves.toEqual(['review'])
    await expect(kinds(activityBody([closed, reopened, implied]))).resolves.toEqual(['closed', 'reopened', 'closed'])
  })

  it('marks the activity truncated when the pull request has older entries', async () => {
    const read = async (hasPreviousPage: boolean): Promise<unknown> =>
      await provider(fakeGh(() => output(activityBody([], { hasPreviousPage }))).run).readActivity(pull(7), signal)
    await expect(read(true)).resolves.toEqual({ items: [], truncated: true, viewerCanComment: true })
    await expect(read(false)).resolves.toEqual({ items: [], truncated: false, viewerCanComment: true })
  })

  it.each([
    ['an open conversation for a reader', {}, true],
    ['an archived repository', { isArchived: true, viewerPermission: 'ADMIN' }, false],
    ['a locked conversation for a reader', { locked: true }, false],
    ['a locked conversation for a user without a permission', { locked: true, viewerPermission: null }, false],
    ['a locked conversation for a writer', { locked: true, viewerPermission: 'WRITE' }, true],
  ] as const)('tells whether the viewer may comment on %s', async (_label, overrides, viewerCanComment) => {
    await expect(provider(fakeGh(() => output(activityBody([], overrides))).run).readActivity(pull(7), signal))
      .resolves.toMatchObject({ viewerCanComment })
  })

  it.each([
    ['a missing pull request', output({ data: { repository: { isArchived: false, viewerPermission: 'READ', pullRequest: null } } }),
      { code: 'not-found', message: 'pull request 7 was not found' }],
    ['a missing repository', output({ data: { repository: null } }), { code: 'not-found', message: 'pull request 7 was not found' }],
    ['an entry of a type it did not ask for', output(activityBody([event('LockedEvent', '2026-11-03T08:00:00Z')])),
      { code: 'unavailable', message: 'unexpected GitHub response to the activity read' }],
    ['an entry without its fields', output(activityBody([{ __typename: 'IssueComment' }])),
      { code: 'unavailable', message: 'unexpected GitHub response to the activity read' }],
    ['a refusal', output('', 1, 'gh: Something went wrong (HTTP 502)'),
      { code: 'unavailable', message: 'gh: Something went wrong (HTTP 502)' }],
  ])('reports %s', async (_label, answer, failure) => {
    await expect(provider(fakeGh(() => answer).run).readActivity(pull(7), signal)).resolves.toEqual(failure)
  })

  it('refuses an unconfigured host without asking GitHub', async () => {
    const gh = fakeGh(() => output(''))
    await expect(provider(gh.run).readActivity(pull(1, { ...demo, host: 'other.example' }), signal))
      .resolves.toEqual({ code: 'unavailable', message: 'forge-github: host "other.example" is not configured' })
    expect(gh.calls).toEqual([])
  })
})

describe('GitHub comments', () => {
  const saved = { id: 6939417101, html_url: 'https://github.com/octo/demo/pull/7#issuecomment-6939417101', body: 'Looks right' }

  it('posts the comment once with its text as JSON on standard input', async () => {
    const gh = fakeGh(() => output(saved))
    const body = 'Looks right\n\n- [ ] one "quoted" `-F field=@file`'

    await expect(provider(gh.run).addComment(pull(7), body, signal)).resolves.toBeUndefined()

    expect(gh.calls).toEqual([{
      args: ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/octo/demo/issues/7/comments', '--input', '-'],
      input: JSON.stringify({ body }),
    }])
  })

  it.each([
    ['a locked conversation', output({ message: 'The conversation is locked.' }, 1, 'gh: The conversation is locked. (HTTP 403)'),
      { code: 'failed', message: 'The conversation is locked.' }],
    ['a pull request GitHub does not have', output({ message: 'Not Found' }, 1, 'gh: Not Found (HTTP 404)'),
      { code: 'failed', message: 'Not Found' }],
    ['text GitHub does not accept', output({ message: 'Validation Failed' }, 1, 'gh: Validation Failed (HTTP 422)'),
      { code: 'failed', message: 'Validation Failed' }],
    ['rejected credentials', output({ message: 'Bad credentials' }, 1, 'gh: Bad credentials (HTTP 401)'),
      { code: 'unauthenticated', message: 'Bad credentials' }],
    ['a gh that is not signed in', output('', 4, 'To get started with GitHub CLI, please run:  gh auth login'),
      { code: 'unauthenticated', message: 'To get started with GitHub CLI, please run:  gh auth login' }],
  ])('reports %s as a refusal that changed nothing', async (_label, answer, failure) => {
    await expect(provider(fakeGh(() => answer).run).addComment(pull(7), 'Looks right', signal)).resolves.toEqual(failure)
  })

  it.each([
    ['a server error', (): GhOutput => output('', 1, 'gh: Something went wrong (HTTP 502)'), 'gh: Something went wrong (HTTP 502)'],
    ['an answer without the saved comment', (): GhOutput => output({ message: 'accepted' }), 'unexpected GitHub response to the comment'],
    ['an answer that is not JSON', (): GhOutput => output('<html>'), 'unexpected GitHub response to the comment'],
    ['a gh that times out', (): GhOutput => { throw new GhTimeoutError('gh api timed out after 30000ms') },
      'gh api timed out after 30000ms'],
    // A runner rejects with the reason of the signal that cancelled it, which need not be an error.
    ['a request cancelled after it was sent', (): GhOutput => { throw 'the user left the page' }, 'the user left the page'],
  ])('reports %s as an unknown outcome without sending the comment again', async (_label, answer, message) => {
    const gh = fakeGh(answer)
    await expect(provider(gh.run).addComment(pull(7), 'Looks right', signal)).resolves.toEqual({ code: 'unknown', message })
    expect(gh.calls).toHaveLength(1)
  })

  it('reports a gh that cannot start as a failure', async () => {
    const run: GhRunner = () => Promise.reject(new GhUnavailableError('gh could not start: spawn gh ENOENT'))
    await expect(provider(run).addComment(pull(7), 'Looks right', signal))
      .resolves.toEqual({ code: 'failed', message: 'gh could not start: spawn gh ENOENT' })
  })

  it('sends nothing once the request is cancelled, for an unconfigured host, or for a repository name that cannot be a path', async () => {
    const gh = fakeGh(() => output(saved))
    const subject = provider(gh.run)
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled before the request'))

    await expect(subject.addComment(pull(7), 'Looks right', cancelled.signal)).rejects.toThrow('cancelled before the request')
    await expect(subject.addComment(pull(7, { ...demo, host: 'other.example' }), 'Looks right', signal))
      .resolves.toEqual({ code: 'failed', message: 'forge-github: host "other.example" is not configured' })
    await expect(subject.addComment(pull(7, { ...demo, name: 'de/mo' }), 'Looks right', signal))
      .rejects.toThrow('forge-github: invalid repository "octo/de/mo"')
    expect(gh.calls).toEqual([])
  })
})
