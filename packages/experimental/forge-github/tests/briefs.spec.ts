/** The brief read of the GitHub provider: its query, its mapping, and its queries per `briefBatchSize`. */
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ChangeRequestBrief, ChangeRequestRef, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import { GhOutputLimitError, GhTimeoutError, GhUnavailableError } from '../src/gh.ts'
import type { GhOutput, GhRunner } from '../src/gh.ts'
import { briefQuery, mapBriefResponse } from '../src/graphql.ts'
import { GitHubProvider } from '../src/provider.ts'
import type { GitHubLimits } from '../src/provider.ts'
import { briefNode, demo, pull } from './fixtures.ts'

const enterprise = { forge: 'github', host: 'ghe.corp.example', owner: 'team', name: 'svc' }
const other = { ...demo, name: 'other' }
const signal = new AbortController().signal
const limits: GitHubLimits = {
  maxOutputBytes: 8_388_608, maxReviewThreads: 1_000, snapshotBatchSize: 8, briefBatchSize: 50,
  maxCommits: 250, maxViewedFiles: 3_000, maxViewerItems: 50,
}

/** The brief of `briefNode(number)`. */
function brief(target: ChangeRequestRef, overrides: Partial<ChangeRequestBrief> = {}): ChangeRequestBrief {
  return {
    ref: target,
    url: `https://github.com/octo/demo/pull/${target.number}`,
    title: `Change ${target.number}`,
    state: 'open',
    draft: false,
    mergeability: 'mergeable',
    reviewDecision: 'none',
    checksRollup: 'success',
    ...overrides,
  }
}

function output(stdout: unknown, exitCode = 0, stderr = ''): GhOutput {
  return { exitCode, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr }
}

/** Pull request numbers one brief query reads, in alias order. */
function queried(args: readonly string[]): number[] {
  const query = args.find(arg => arg.startsWith('query=')) ?? ''
  return [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map(match => Number(match[1]))
}

/** Answer a brief query of `demo` pull requests with one node each. */
function answer(args: readonly string[]): GhOutput {
  return output({ data: { r0: Object.fromEntries(queried(args).map((number, index) => [`p${index}`, briefNode(number)])) } })
}

function fakeGh(handler: (args: readonly string[]) => GhOutput | Promise<GhOutput>): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run: async (args) => {
      calls.push([...args])
      return await handler(args)
    },
  }
}

function pulls(count: number): ChangeRequestRef[] {
  return Array.from({ length: count }, (_, index) => pull(index + 1))
}

function provider(run: GhRunner, overrides: Partial<GitHubLimits> = {}): GitHubProvider {
  return new GitHubProvider(run, ['github.com', 'ghe.corp.example'], { ...limits, ...overrides })
}

describe('brief query', () => {
  it('reads the brief fields of each pull request and no repository fields', () => {
    const query = briefQuery([pull(1), pull(2), pull(7, other)])

    expect([...query.targets]).toEqual([['r0.p0', pull(1)], ['r0.p1', pull(2)], ['r1.p0', pull(7, other)]])
    expect(query.document).toContain('r0: repository(owner: "octo", name: "demo") {  p0: pullRequest(number: 1) { ...ChangeRequestFields } p1: pullRequest(number: 2) { ...ChangeRequestFields } }')
    expect(query.document).toContain('fragment ChangeRequestFields on PullRequest { url title state isDraft mergeable reviewDecision '
      + 'commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }')
  })

  it('refuses a reference that cannot be inlined', () => {
    expect(() => briefQuery([pull(1, { ...demo, owner: 'oc"to' })])).toThrow('forge-github: invalid repository "oc\\"to/demo"')
  })
})

describe('brief mapping', () => {
  it('maps the state, draft flag, mergeability, review decision, and combined check state', () => {
    const query = briefQuery([pull(1), pull(2), pull(3), pull(4), pull(5)])
    const results = mapBriefResponse({ data: { r0: {
      p0: briefNode(1),
      p1: briefNode(2, { state: 'MERGED', mergeable: 'UNKNOWN', reviewDecision: 'APPROVED', commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }),
      p2: briefNode(3, { state: 'CLOSED', isDraft: true, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED',
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }),
      p3: briefNode(4, { reviewDecision: 'REVIEW_REQUIRED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }),
      p4: briefNode(5, { commits: { nodes: [] } }),
    } } }, query)

    expect([...results.values()]).toEqual([
      brief(pull(1)),
      brief(pull(2), { state: 'merged', mergeability: 'unknown', reviewDecision: 'approved', checksRollup: 'none' }),
      brief(pull(3), { state: 'closed', draft: true, mergeability: 'conflicting', reviewDecision: 'changes-requested', checksRollup: 'failure' }),
      brief(pull(4), { reviewDecision: 'review-required', checksRollup: 'pending' }),
      brief(pull(5), { checksRollup: 'none' }),
    ])
  })

  it('fails only the pull requests an error names, a missing node, and a node without the brief fields', () => {
    const query = briefQuery([pull(1), pull(2), pull(3), pull(4), pull(7, other)])
    const results = mapBriefResponse({
      data: { r0: { p0: briefNode(1), p1: null, p2: null, p3: { title: 4 } }, r1: null },
      errors: [
        { type: 'NOT_FOUND', path: ['r0', 'p1'], message: 'Could not resolve to a PullRequest with the number of 2.' },
        { type: 'RATE_LIMITED', path: ['r1'], message: 'API rate limit exceeded' },
      ],
    }, query)

    expect([...results.values()]).toEqual([
      brief(pull(1)),
      { code: 'not-found', message: 'Could not resolve to a PullRequest with the number of 2.' },
      { code: 'not-found', message: 'pull request not found' },
      { code: 'unavailable', message: 'unexpected pull request fields' },
      { code: 'rate-limited', message: 'API rate limit exceeded' },
    ])
  })

  it('applies an error without a path to every pull request, and fails every one of a body that is not GraphQL', () => {
    const query = briefQuery([pull(1), pull(2)])
    const timeout: ForgeFailure = { code: 'unavailable', message: 'Something went wrong while executing your query.' }

    expect([...mapBriefResponse({ data: null, errors: [{ message: timeout.message }] }, query).values()]).toEqual([timeout, timeout])
    expect([...mapBriefResponse([], query).values()]).toEqual([
      { code: 'unavailable', message: 'unexpected GitHub response' }, { code: 'unavailable', message: 'unexpected GitHub response' },
    ])
  })
})

describe('GitHub provider briefs', () => {
  it.each([
    [1, 50, [1]],
    [50, 50, [50]],
    [51, 50, [50, 1]],
    [7, 3, [3, 3, 1]],
    [3, 1, [1, 1, 1]],
  ])('reads %i pull requests with briefBatchSize %i in queries of %j, in order', async (count, briefBatchSize, sizes) => {
    const gh = fakeGh(answer)
    const refs = pulls(count)

    const results = await provider(gh.run, { briefBatchSize }).fetchBriefs(refs, signal)

    expect(gh.calls.map(call => queried(call).length)).toEqual(sizes)
    expect(gh.calls.flatMap(queried)).toEqual(refs.map(ref => ref.number))
    expect(gh.calls[0]?.slice(0, 5)).toEqual(['api', 'graphql', '--hostname', 'github.com', '-f'])
    expect([...results.values()]).toEqual(refs.map(ref => brief(ref)))
  })

  it('sends a query only after the previous one is answered', async () => {
    const first = Promise.withResolvers<undefined>()
    const gh = fakeGh(async (args) => {
      if (queried(args)[0] === 1) await first.promise
      return answer(args)
    })

    const read = provider(gh.run, { briefBatchSize: 2 }).fetchBriefs(pulls(3), signal)
    await new Promise(resolve => setImmediate(resolve))
    expect(gh.calls).toHaveLength(1)
    first.resolve(undefined)

    expect((await read).size).toBe(3)
    expect(gh.calls).toHaveLength(2)
  })

  it.each([
    ['times out', () => { throw new GhTimeoutError('gh api timed out after 30000ms') }, 'unavailable', 'gh api timed out after 30000ms'],
    ['prints over its limit', () => { throw new GhOutputLimitError('gh api output exceeds maxOutputBytes') }, 'too-large',
      'gh api output exceeds maxOutputBytes'],
    ['cannot start', () => { throw new GhUnavailableError('gh could not start: spawn gh ENOENT') }, 'unavailable',
      'gh could not start: spawn gh ENOENT'],
    ['is refused', () => output('', 1, 'HTTP 502: Bad Gateway (https://api.github.com/graphql)'), 'unavailable',
      'HTTP 502: Bad Gateway (https://api.github.com/graphql)'],
  ] as const)('fails only the pull requests of a query that %s', async (_, fail, code, message) => {
    const gh = fakeGh(args => queried(args)[0] === 3 ? fail() : answer(args))
    const refs = pulls(6)

    const results = await provider(gh.run, { briefBatchSize: 2 }).fetchBriefs(refs, signal)

    expect(gh.calls).toHaveLength(3)
    expect([...results.values()]).toEqual([
      brief(pull(1)), brief(pull(2)), { code, message }, { code, message }, brief(pull(5)), brief(pull(6)),
    ])
  })

  it.each([
    ['after a query is answered', false],
    ['while a query runs', true],
  ])('sends no further query once cancelled %s', async (_, during) => {
    const controller = new AbortController()
    const gh = fakeGh((args) => {
      if (queried(args)[0] !== 3) return answer(args)
      controller.abort(new Error('cancelled'))
      if (during) throw controller.signal.reason
      return answer(args)
    })

    await expect(provider(gh.run, { briefBatchSize: 2 }).fetchBriefs(pulls(6), controller.signal)).rejects.toThrow('cancelled')
    expect(gh.calls).toHaveLength(2)
  })

  it('passes on a runner defect', async () => {
    const gh = fakeGh(() => { throw new Error('defect') })

    await expect(provider(gh.run).fetchBriefs(pulls(1), signal)).rejects.toThrow('defect')
  })

  it('builds every query before the first request, across hosts', async () => {
    const gh = fakeGh(answer)

    await expect(provider(gh.run).fetchBriefs([pull(1), pull(2, { ...enterprise, owner: 'te"am' })], signal)).rejects.toThrow('invalid repository')
    expect(gh.calls).toEqual([])
  })

  it('reads each configured host with its own queries and fails references of other hosts without a request', async () => {
    const gh = fakeGh(answer)
    const denied = pull(9, { ...demo, host: 'unconfigured.example' })

    const results = await provider(gh.run).fetchBriefs([pull(1), denied, pull(2, enterprise), pull(3)], signal)

    expect(gh.calls.map(call => [call[3], queried(call)])).toEqual([['github.com', [1, 3]], ['ghe.corp.example', [2]]])
    expect(results.get(changeRequestKey(denied))).toEqual({ code: 'unavailable', message: 'forge-github: host "unconfigured.example" is not configured' })
    expect(results.get(changeRequestKey(pull(3)))).toEqual(brief(pull(3)))
    expect(results.size).toBe(4)
  })
})
