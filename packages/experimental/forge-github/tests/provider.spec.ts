import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import { GhOutputLimitError, GhTimeoutError, GhUnavailableError } from '../src/gh.ts'
import type { GhOutput, GhRunner } from '../src/gh.ts'
import { GitHubProvider } from '../src/provider.ts'
import { checkRun, demo, pull, pullRequestNode } from './fixtures.ts'

const enterprise = { forge: 'github', host: 'ghe.corp.example', owner: 'team', name: 'svc' }
const signal = new AbortController().signal

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

function output(stdout: unknown, exitCode = 0, stderr = ''): GhOutput {
  return { exitCode, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr }
}

function provider(run: GhRunner): GitHubProvider {
  return new GitHubProvider(run, ['github.com', 'GHE.corp.example'], 8_388_608)
}

describe('GitHub provider addressing', () => {
  const subject = provider(fakeGh(() => output('')).run)

  it('serves remotes and pull request URLs on configured hosts only', () => {
    expect(subject.repositoryFromRemote('git@github.com:octo/demo.git')).toEqual(demo)
    expect(subject.repositoryFromRemote('https://ghe.corp.example/team/svc')).toEqual(enterprise)
    expect(subject.repositoryFromRemote('https://gitlab.com/octo/demo')).toBeUndefined()
    expect(subject.repositoryFromRemote('/local/repo')).toBeUndefined()
    expect(subject.changeRequestFromUrl('https://github.com/octo/demo/pull/4')).toEqual(pull(4))
    expect(subject.changeRequestFromUrl('https://gitlab.com/octo/demo/pull/4')).toBeUndefined()
    expect(subject.changeRequestFromUrl('https://github.com/octo/demo/issues/4')).toBeUndefined()
  })

  it('builds canonical pull request URLs', () => {
    expect(subject.changeRequestUrl(pull(4, enterprise))).toBe('https://ghe.corp.example/team/svc/pull/4')
  })

  it('uses a configured HTTP port for URL mapping and GitHub queries', async () => {
    const gh = fakeGh(() => output({ data: { r0: { p0: pullRequestNode(1) } } }))
    const subject = new GitHubProvider(gh.run, ['ghe.example.com:8443'], 8_388_608)
    const repository = subject.repositoryFromRemote('https://ghe.example.com:8443/team/repo.git')!
    const ref = { repository, number: 1 }
    expect(subject.changeRequestFromUrl(subject.changeRequestUrl(ref))).toEqual(ref)
    await subject.fetch([ref], signal)
    expect(gh.calls[0]?.[3]).toBe('ghe.example.com:8443')
  })
})

describe('GitHub provider fetch', () => {
  const firstPage = () => pullRequestNode(1, { commits: { nodes: [{ commit: { statusCheckRollup: {
    id: 'fixed-rollup', state: 'SUCCESS', contexts: { pageInfo: { hasNextPage: true, endCursor: 'page-1' },
      nodes: Array.from({ length: 100 }, (_, index) => ({ ...checkRun('lint', 'COMPLETED', 'FAILURE'), databaseId: index + 1 })) },
  } } }] } })

  it('publishes the first page and other PRs without requesting check continuations', async () => {
    const gh = fakeGh(() => output({ data: { r0: { p0: firstPage(), p1: pullRequestNode(2) } } }))
    const results = await provider(gh.run).fetch([pull(1), pull(2)], signal)
    expect(results.get(changeRequestKey(pull(1)))).toMatchObject({ checksTruncated: true, checksRollup: 'success', checks: [{ state: 'failure' }] })
    expect(results.get(changeRequestKey(pull(2)))).toMatchObject({ title: 'Change 2', checksTruncated: false })
    expect(gh.calls).toHaveLength(1)
  })

  it.each([
    [new GhTimeoutError('timed out'), 'unavailable'],
    [new GhOutputLimitError('too much output'), 'too-large'],
    [new GhUnavailableError('gh missing'), 'unavailable'],
  ] as const)('reports an initial check-detail process failure', async (error, code) => {
    await expect(provider(fakeGh(() => { throw error }).run).fetchChecks(pull(1), signal))
      .resolves.toEqual({ code, message: error.message })
  })

  it('refuses unconfigured hosts before starting a detail read', async () => {
    const gh = fakeGh(() => output(''))
    await expect(provider(gh.run).fetchChecks(pull(1, { ...demo, host: 'unconfigured.example' }), signal))
      .resolves.toMatchObject({ code: 'unavailable' })
    expect(gh.calls).toEqual([])
  })

  it('bounds the complete detail read by combined UTF-8 JSON bytes', async () => {
    const first = output({ data: { r0: { p0: firstPage() } } })
    const last = output({ data: { node: { contexts: { pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [checkRun('检查', 'COMPLETED', 'SUCCESS')] } } } })
    const total = Buffer.byteLength(first.stdout) + Buffer.byteLength(last.stdout)
    for (const limit of [total, total - 1, Buffer.byteLength(first.stdout) - 1]) {
      const gh = fakeGh(args => args.includes('id=fixed-rollup') ? last : first)
      const result = await new GitHubProvider(gh.run, ['github.com'], limit).fetchChecks(pull(1), signal)
      if (limit === total) expect(result).toMatchObject({ checksTruncated: false })
      else expect(result).toMatchObject({ code: 'too-large' })
      expect(gh.calls).toHaveLength(limit < Buffer.byteLength(first.stdout) ? 1 : 2)
    }
  })

  it('reads past 100 historical runs from the pinned rollup and counts only the latest run', async () => {
    const gh = fakeGh(args => output(args.includes('id=fixed-rollup')
      ? { data: { node: { contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { ...checkRun('lint', 'COMPLETED', 'SUCCESS'), databaseId: 101 }, checkRun('test', 'COMPLETED', 'SUCCESS'),
      ] } } } }
      : { data: { r0: { p0: firstPage() } } }))
    const result = await provider(gh.run).fetchChecks(pull(1), signal)
    expect(result).toMatchObject({ checks: [{ name: 'lint', state: 'success' }, { name: 'test', state: 'success' }], checksTruncated: false })
    expect(gh.calls).toHaveLength(2)
    expect(gh.calls[1]).toContain('cursor=page-1')
    expect(gh.calls[1]?.[5]).toContain('node(id: $id)')
  })

  it.each([
    [output({ message: 'API rate limit exceeded' }, 1), 'API rate limit exceeded'],
    [output({ errors: [{ message: 'Check page failed' }] }, 1), 'Check page failed'],
    [output({ data: { node: { contexts: { pageInfo: { hasNextPage: true, endCursor: 'page-1' }, nodes: [] } } } }), 'GitHub check pagination did not advance'],
    [output({ data: { node: { contexts: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } }), 'GitHub check pagination did not advance'],
  ])('rejects an incomplete check read without losing another pull request', async (page, message) => {
    const gh = fakeGh(args => args.includes('id=fixed-rollup') ? page : output({ data: { r0: { p0: firstPage(), p1: pullRequestNode(2) } } }))
    const subject = provider(gh.run)
    const results = await subject.fetch([pull(1), pull(2)], signal)
    const details = await subject.fetchChecks(pull(1), signal)
    expect(details).toEqual({ code: 'unavailable', message })
    expect(results.get(changeRequestKey(pull(2)))).toMatchObject({ title: 'Change 2' })
    expect(gh.calls).toHaveLength(3)
  })

  it('stops before requesting another check page when cancelled', async () => {
    const controller = new AbortController()
    const gh = fakeGh(() => { controller.abort(new Error('cancelled')); return output({ data: { r0: { p0: firstPage() } } }) })
    await expect(provider(gh.run).fetchChecks(pull(1), controller.signal)).rejects.toThrow('cancelled')
    expect(gh.calls).toHaveLength(1)
  })

  it.each([
    [new GhTimeoutError('timed out'), 'unavailable'],
    [new GhOutputLimitError('too much output'), 'too-large'],
    [new GhUnavailableError('gh missing'), 'unavailable'],
  ] as const)(
    'contains a failed continuation process to its pull request', async (error, code) => {
      const gh = fakeGh((args) => {
        if (args.includes('id=fixed-rollup')) throw error
        return output({ data: { r0: { p0: firstPage(), p1: pullRequestNode(2) } } })
      })
      const subject = provider(gh.run)
      const results = await subject.fetch([pull(1), pull(2)], signal)
      const details = await subject.fetchChecks(pull(1), signal)
      expect(details).toEqual({ code, message: error.message })
      expect(results.get(changeRequestKey(pull(2)))).toMatchObject({ title: 'Change 2' })
    },
  )

  it('propagates cancellation and unexpected defects during a continuation', async () => {
    for (const cancel of [true, false]) {
      const controller = new AbortController()
      const gh = fakeGh((args) => {
        if (args.includes('id=fixed-rollup')) {
          if (cancel) controller.abort(new Error('cancelled'))
          throw new Error('unexpected')
        }
        return output({ data: { r0: { p0: firstPage() } } })
      })
      await expect(provider(gh.run).fetchChecks(pull(1), controller.signal)).rejects.toThrow(cancel ? 'cancelled' : 'unexpected')
    }
  })

  it.each([
    [{ message: 'Bad credentials' }, 1, 'gh: Bad credentials (HTTP 401)', 'unauthenticated', 'gh: Bad credentials (HTTP 401)'],
    [{ message: 'API rate limit exceeded' }, 1, 'gh: API rate limit exceeded (HTTP 403)', 'unavailable', 'gh: API rate limit exceeded (HTTP 403)'],
    [{ message: 'Bad credentials' }, 1, '', 'unauthenticated', 'Bad credentials'],
    [{ message: '' }, 0, '', 'unavailable', 'unexpected GitHub response'],
    [null, 1, '', 'unavailable', 'gh exited with 1'],
    [[], 0, '', 'unavailable', 'unexpected GitHub response'],
  ])('preserves HTTP failure diagnostics for %j', async (body, exitCode, stderr, code, message) => {
    const gh = fakeGh(() => output(body, exitCode, stderr))
    const subject = provider(gh.run)
    expect([...(await subject.fetch([pull(1)], signal)).values()]).toEqual([{ code, message }])
    await expect(subject.findByHead(demo, 'topic', signal)).rejects.toThrow(`head branch lookup failed: ${message}`)
  })

  it('rejects unconfigured hosts without querying them and still fetches allowed hosts', async () => {
    const gh = fakeGh(() => output({ data: { r0: { p0: pullRequestNode(1) } } }))
    const denied = pull(2, { ...enterprise, host: 'unconfigured.example' })
    const results = await provider(gh.run).fetch([denied, pull(1)], signal)
    expect(gh.calls.map(call => call[3])).toEqual(['github.com'])
    expect(results.get(changeRequestKey(denied))).toEqual({ code: 'unavailable', message: 'forge-github: host "unconfigured.example" is not configured' })
    expect(results.get(changeRequestKey(pull(1)))).toMatchObject({ title: 'Change 1' })
  })

  it('rejects references retained after their host was removed from configuration', async () => {
    const gh = fakeGh(() => output(''))
    const retained = provider(gh.run).changeRequestFromUrl('https://ghe.corp.example/team/svc/pull/2')!
    const replacement = new GitHubProvider(gh.run, ['github.com'], 8_388_608)
    const results = await replacement.fetch([retained], signal)
    await expect(replacement.findByHead(retained.repository, 'topic', signal)).rejects.toThrow('is not configured')
    expect(results.get(changeRequestKey(retained))).toMatchObject({ code: 'unavailable' })
    expect(gh.calls).toEqual([])
  })

  it('runs one GraphQL request per host and merges the results', async () => {
    const gh = fakeGh((args) => {
      const host = args[3]
      return output({ data: { r0: { p0: pullRequestNode(host === 'github.com' ? 1 : 2) } } })
    })

    const results = await provider(gh.run).fetch([pull(1), pull(2, enterprise)], signal)

    expect(gh.calls.map(call => call.slice(0, 5))).toEqual([
      ['api', 'graphql', '--hostname', 'github.com', '-f'],
      ['api', 'graphql', '--hostname', 'ghe.corp.example', '-f'],
    ])
    expect(gh.calls[0]?.[5]).toMatch(/^query=query \{ r0: repository\(owner: "octo", name: "demo"\)/)
    expect(results.get(changeRequestKey(pull(1)))).toMatchObject({ title: 'Change 1' })
    expect(results.get(changeRequestKey(pull(2, enterprise)))).toMatchObject({ title: 'Change 2' })
  })

  it('maps the JSON of a partial-error response that exits with 1', async () => {
    const gh = fakeGh(() => output({
      data: { r0: { p0: null } },
      errors: [{ type: 'NOT_FOUND', path: ['r0', 'p0'], message: 'Could not resolve to a PullRequest with the number of 1.' }],
    }, 1, 'gh: Could not resolve to a PullRequest with the number of 1.'))

    const results = await provider(gh.run).fetch([pull(1)], signal)

    expect(results.get(changeRequestKey(pull(1)))).toEqual({ code: 'not-found', message: 'Could not resolve to a PullRequest with the number of 1.' })
  })

  it.each([
    ['To get started with GitHub CLI, please run:  gh auth login', 'unauthenticated'],
    ['HTTP 401: Bad credentials (https://api.github.com/graphql)', 'unauthenticated'],
    ['error connecting to api.github.com', 'unavailable'],
  ])('classifies a failure without JSON: %s', async (stderr, code) => {
    const gh = fakeGh(() => output('', 1, `\n${stderr}\n`))

    const results = await provider(gh.run).fetch([pull(1), pull(2)], signal)

    expect([...results.values()]).toEqual([{ code, message: stderr }, { code, message: stderr }])
  })

  it('names the exit code when gh prints nothing', async () => {
    const results = await provider(fakeGh(() => output('', 4)).run).fetch([pull(1)], signal)

    expect(results.get(changeRequestKey(pull(1)))).toEqual({ code: 'unavailable', message: 'gh exited with 4' })
  })

  it('propagates a runner rejection', async () => {
    const subject = provider(async () => {
      throw new Error('aborted')
    })

    await expect(subject.fetch([pull(1)], signal)).rejects.toThrow('aborted')
  })
})

describe('GitHub provider head branch lookup', () => {
  it('passes the repository and branch as GraphQL variables', async () => {
    const gh = fakeGh(() => output({ data: { repository: { defaultBranchRef: { name: 'master' }, pullRequests: { nodes: [{ number: 5, isCrossRepository: false }] } } } }))

    await expect(provider(gh.run).findByHead(demo, 'topic', signal)).resolves.toEqual([pull(5)])
    expect(gh.calls[0]?.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'github.com'])
    expect(gh.calls[0]?.slice(6)).toEqual(['-f', 'owner=octo', '-f', 'name=demo', '-f', 'branch=topic'])
  })

  it('reports gh diagnostics when the lookup prints no JSON', async () => {
    await expect(provider(fakeGh(() => output('', 1, 'HTTP 502')).run).findByHead(demo, 'topic', signal))
      .rejects.toThrow('forge-github: head branch lookup failed: HTTP 502')
    await expect(provider(fakeGh(() => output('', 2)).run).findByHead(demo, 'topic', signal))
      .rejects.toThrow('forge-github: head branch lookup failed: gh exited with 2')
  })
})

describe('GitHub provider readiness', () => {
  it('is ready when gh auth status succeeds for the host', async () => {
    const gh = fakeGh(() => output('Logged in to github.com'))

    await expect(provider(gh.run).readiness('github.com', signal)).resolves.toEqual({ state: 'ready', message: null })
    expect(gh.calls).toEqual([['auth', 'status', '--hostname', 'github.com']])
  })

  it('reports the first diagnostic line when gh is not signed in', async () => {
    await expect(provider(fakeGh(() => output('', 1, 'You are not logged into any GitHub hosts.\nRun gh auth login')).run).readiness('github.com', signal))
      .resolves.toEqual({ state: 'unauthenticated', message: 'You are not logged into any GitHub hosts.' })
    await expect(provider(fakeGh(() => output('github.com\n  X Failed to log in', 1)).run).readiness('github.com', signal))
      .resolves.toEqual({ state: 'unauthenticated', message: 'github.com' })
    await expect(provider(fakeGh(() => output('', 1)).run).readiness('github.com', signal))
      .resolves.toEqual({ state: 'unauthenticated', message: 'gh is not signed in to github.com' })
  })

  it('is unavailable when gh cannot start and rethrows other failures', async () => {
    await expect(provider(() => Promise.reject(new GhUnavailableError('gh could not start: spawn gh ENOENT')))
      .readiness('github.com', signal)).resolves.toEqual({ state: 'unavailable', message: 'gh could not start: spawn gh ENOENT' })
    await expect(provider(() => Promise.reject(new Error('timed out'))).readiness('github.com', signal)).rejects.toThrow('timed out')
  })
})

describe('GitHub provider actions', () => {
  const head = 'c'.repeat(40)

  it('marks a pull request ready for review through gh pr ready on its host', async () => {
    const gh = fakeGh(() => output(''))

    await expect(provider(gh.run).markReady(pull(7, enterprise), signal)).resolves.toBeUndefined()
    expect(gh.calls).toEqual([['pr', 'ready', '7', '--repo', 'ghe.corp.example/team/svc']])
  })

  it('merges a pull request through the REST merge endpoint with the confirmed head', async () => {
    const gh = fakeGh(() => output({ sha: 'd'.repeat(40), merged: true, message: 'Pull Request successfully merged' }))

    await expect(provider(gh.run).merge(pull(7), { method: 'squash', headSha: head }, signal)).resolves.toBeUndefined()
    expect(gh.calls).toEqual([[
      'api', '--hostname', 'github.com', '--method', 'PUT', 'repos/octo/demo/pulls/7/merge', '-f', 'merge_method=squash', '-f', `sha=${head}`,
    ]])
  })

  it.each([
    ['a moved head', { message: 'Head branch was modified. Review and try the merge again.' }, 'gh: Head branch was modified. Review and try the merge again. (HTTP 409)',
      { code: 'stale', message: 'Head branch was modified. Review and try the merge again.' }],
    ['an unmet merge rule', { message: 'Pull Request is not mergeable' }, 'gh: Pull Request is not mergeable (HTTP 405)',
      { code: 'failed', message: 'Pull Request is not mergeable' }],
    ['rejected credentials', { message: 'Bad credentials' }, 'gh: Bad credentials (HTTP 401)', { code: 'unauthenticated', message: 'Bad credentials' }],
    ['an error body without a message', { errors: [] }, 'gh: Validation Failed (HTTP 422)', { code: 'failed', message: 'gh: Validation Failed (HTTP 422)' }],
    ['an empty message', { message: ' ' }, 'gh: Not Found (HTTP 404)', { code: 'failed', message: 'gh: Not Found (HTTP 404)' }],
    ['no output', '', '', { code: 'failed', message: 'gh exited with 1' }],
  ])('reports a merge refused for %s', async (_label, body, stderr, failure) => {
    await expect(provider(fakeGh(() => output(body, 1, stderr)).run).merge(pull(7), { method: 'merge', headSha: head }, signal)).resolves.toEqual(failure)
  })

  it('reports a failed ready mark by the first diagnostic line, recognizing a missing sign-in', async () => {
    await expect(provider(fakeGh(() => output('', 1, '\nGraphQL: Resource not accessible by integration (markPullRequestReadyForReview)\n')).run)
      .markReady(pull(7), signal)).resolves.toEqual({ code: 'failed', message: 'GraphQL: Resource not accessible by integration (markPullRequestReadyForReview)' })
    await expect(provider(fakeGh(() => output('', 4, 'To get started with GitHub CLI, please run:  gh auth login')).run).markReady(pull(7), signal))
      .resolves.toEqual({ code: 'unauthenticated', message: 'To get started with GitHub CLI, please run:  gh auth login' })
  })

  it('reports an action as failed when gh cannot start and rethrows other failures', async () => {
    await expect(provider(() => Promise.reject(new GhUnavailableError('gh could not start: spawn gh ENOENT'))).markReady(pull(7), signal))
      .resolves.toEqual({ code: 'failed', message: 'gh could not start: spawn gh ENOENT' })
    await expect(provider(() => Promise.reject(new Error('aborted'))).merge(pull(7), { method: 'rebase', headSha: head }, signal)).rejects.toThrow('aborted')
  })

  it('refuses to address a pull request or head commit that cannot be inlined', async () => {
    const gh = fakeGh(() => output(''))
    const subject = provider(gh.run)

    await expect(subject.markReady(pull(7, { ...demo, owner: 'oc/to' }), signal)).rejects.toThrow('forge-github: invalid repository "oc/to/demo"')
    await expect(subject.merge(pull(0), { method: 'merge', headSha: head }, signal)).rejects.toThrow('forge-github: invalid pull request number 0')
    await expect(subject.merge(pull(7), { method: 'merge', headSha: 'HEAD' }, signal)).rejects.toThrow('forge-github: invalid head commit "HEAD"')
    await expect(subject.merge(pull(7), { method: 'merge', headSha: 'e'.repeat(64) }, signal)).resolves.toBeUndefined()
    expect(gh.calls).toHaveLength(1)
  })
})

describe('GitHub provider reads', () => {
  const head = 'c'.repeat(40)

  it('reads the pull request diff through gh pr diff on its host', async () => {
    const gh = fakeGh(() => output('diff --git a/x b/x\n'))

    await expect(provider(gh.run).diff(pull(7, enterprise), signal)).resolves.toBe('diff --git a/x b/x\n')
    expect(gh.calls).toEqual([['pr', 'diff', '7', '--repo', 'ghe.corp.example/team/svc', '--color', 'never']])
  })

  it('reads a file at a commit through the raw contents API, encoding each path segment', async () => {
    const gh = fakeGh(() => output('line\n'))

    await expect(provider(gh.run).fileText(pull(7), head, 'docs/中文 notes/#1.md', signal)).resolves.toBe('line\n')
    expect(gh.calls).toEqual([[
      'api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github.raw+json',
      `repos/octo/demo/contents/docs/${encodeURIComponent('中文 notes')}/%231.md?ref=${head}`,
    ]])
  })

  it('builds the web page of a file at a commit', () => {
    expect(provider(fakeGh(() => output('')).run).fileUrl(pull(7), head, 'src/a b.ts')).toBe(`https://github.com/octo/demo/blob/${head}/src/a%20b.ts`)
  })

  it.each([
    ['a missing pull request', '', 'GraphQL: Could not resolve to a PullRequest with the number of 7. (repository.pullRequest)',
      { code: 'not-found', message: 'GraphQL: Could not resolve to a PullRequest with the number of 7. (repository.pullRequest)' }],
    ['a missing file', { message: 'Not Found' }, 'gh: Not Found (HTTP 404)', { code: 'not-found', message: 'Not Found' }],
    // What gh 2.100 prints for a pull request over 300 files.
    ['a diff over GitHub\'s size limit', '', [
      'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using \'List pull '
      + 'requests files\' API or locally cloning the repository instead. (https://api.github.com/repos/octo/demo/pulls/7)',
      'PullRequest.diff too_large',
    ].join('\n'), {
      code: 'too-large',
      message: 'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using '
        + '\'List pull requests files\' API or locally cloning the repository instead. (https://api.github.com/repos/octo/demo/pulls/7)',
    }],
    ['a file over the contents API limit', {
      message: 'This API returns blobs up to 1 MB in size. The requested blob is too large to fetch via the API.',
      errors: [{ resource: 'Blob', field: 'data', code: 'too_large' }],
    }, 'gh: This API returns blobs up to 1 MB in size. The requested blob is too large to fetch via the API. (HTTP 403)', {
      code: 'too-large', message: 'This API returns blobs up to 1 MB in size. The requested blob is too large to fetch via the API.',
    }],
    ['another refusal', { message: 'Server Error' }, 'gh: Server Error (HTTP 502)', { code: 'unavailable', message: 'Server Error' }],
    ['a missing sign-in', '', 'To get started with GitHub CLI, please run:  gh auth login',
      { code: 'unauthenticated', message: 'To get started with GitHub CLI, please run:  gh auth login' }],
    ['no output', '', '', { code: 'unavailable', message: 'gh exited with 1' }],
  ])('reports a read refused for %s', async (_label, body, stderr, failure) => {
    await expect(provider(fakeGh(() => output(body, 1, stderr)).run).diff(pull(7), signal)).resolves.toEqual(failure)
  })

  it('reports a read as unavailable when gh cannot start, rethrows other failures, and refuses an invalid commit', async () => {
    await expect(provider(() => Promise.reject(new GhUnavailableError('gh could not start: spawn gh ENOENT'))).diff(pull(7), signal))
      .resolves.toEqual({ code: 'unavailable', message: 'gh could not start: spawn gh ENOENT' })
    await expect(provider(() => Promise.reject(new Error('aborted'))).fileText(pull(7), head, 'a', signal)).rejects.toThrow('aborted')
    await expect(provider(fakeGh(() => output('')).run).fileText(pull(7), 'main', 'a', signal)).rejects.toThrow('forge-github: invalid commit "main"')
  })

  it('reports output over maxOutputBytes as too large and a run past timeoutMs as unavailable', async () => {
    await expect(provider(() => Promise.reject(new GhOutputLimitError('gh pr output exceeds maxOutputBytes'))).diff(pull(7), signal))
      .resolves.toEqual({ code: 'too-large', message: 'gh pr output exceeds maxOutputBytes' })
    await expect(provider(() => Promise.reject(new GhTimeoutError('gh api timed out after 30000ms'))).fileText(pull(7), head, 'a', signal))
      .resolves.toEqual({ code: 'unavailable', message: 'gh api timed out after 30000ms' })
  })
})

it('rejects readiness, actions, and content reads for an unconfigured host without starting gh', async () => {
  const gh = fakeGh(() => output('unexpected'))
  const subject = provider(gh.run)
  const target = pull(7, { ...demo, host: 'unconfigured.example' })
  const message = 'forge-github: host "unconfigured.example" is not configured'
  await expect(subject.readiness(target.repository.host, signal)).resolves.toEqual({ state: 'unavailable', message })
  await expect(subject.markReady(target, signal)).resolves.toEqual({ code: 'failed', message })
  await expect(subject.merge(target, { method: 'squash', headSha: 'a'.repeat(40) }, signal)).resolves.toEqual({ code: 'failed', message })
  await expect(subject.diff(target, signal)).resolves.toEqual({ code: 'unavailable', message })
  await expect(subject.fileText(target, 'a'.repeat(40), 'file.txt', signal)).resolves.toEqual({ code: 'unavailable', message })
  expect(gh.calls).toEqual([])
})
