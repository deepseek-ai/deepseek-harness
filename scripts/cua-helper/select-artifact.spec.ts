/** Discovery and explicit selection require matching inputs and successful producer evidence. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { createGitHubJsonReader, selectCuaHelperArtifact } from './select-artifact.ts'

const repository = 'deepseek-harness/deepseek-harness'
const base = `repos/${repository}/actions/runs/123`
const key = 'a'.repeat(64)

function fixture() {
  const run = { id: 123, run_attempt: 2, status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
    path: '.github/workflows/cua-helper-package.yml', head_sha: 'c'.repeat(40), repository: { full_name: repository }, head_repository: { full_name: repository } }
  const jobs = [{ jobs: [{ name: 'package', conclusion: 'success', run_attempt: 2 }] }]
  const matchesSource = vi.fn(async (_commit: string) => true)
  const artifact = { id: 456, name: `cua-helper-123-2-${key}`, expired: false, size_in_bytes: 4096 }
  const artifacts = [{ artifacts: [{ ...artifact, id: 455, name: `cua-helper-123-1-${key}` }] }, { artifacts: [artifact] }]
  const api = vi.fn(async (path: string, paginate?: boolean) => {
    if (path === base) { expect(paginate).toBeUndefined(); return { run_attempt: 2 } }
    if (path === `${base}/attempts/2`) { expect(paginate).toBeUndefined(); return run }
    expect(paginate).toBe(true)
    if (path.includes('/workflows/cua-helper-package.yml/runs?')) return [{ workflow_runs: [{ id: 123 }] }]
    if (path.includes('/workflows/release-publish.yml/runs?')) return [{ workflow_runs: [] }]
    if (path === `${base}/jobs?filter=all&per_page=100`) return jobs
    if (path === `${base}/artifacts?per_page=100`) return artifacts
    throw new Error(`Unexpected GitHub request ${path}`)
  })
  return { run, jobs, artifact, artifacts, api, matchesSource }
}

it.each(['123', ''])('selects a matching artifact with run ID %j and pins the latest attempt', async (runId) => {
  const f = fixture()
  expect(await selectCuaHelperArtifact(repository, runId, key, f.api, f.matchesSource))
    .toEqual({ runId: '123', attempt: '2', artifactId: '456' })
  expect(f.api.mock.calls.filter(([path]) => path === base)).toHaveLength(1)
  expect(f.api.mock.calls.some(([path]) => path.includes('/workflows/'))).toBe(runId === '')
})

it('allows successful helper packaging when later npm publication failed', async () => {
  const f = fixture()
  f.run.path = '.github/workflows/release-publish.yml'
  f.run.conclusion = 'failure'
  f.jobs[0]!.jobs = [{ name: 'cua-helper / package', conclusion: 'success', run_attempt: 2 }, { name: 'Publish to npm', conclusion: 'failure', run_attempt: 2 }]
  expect((await selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource))?.artifactId).toBe('456')
})

it.each(['123/other', ' 123', '0', '-1', '2\nartifact-id=9', 'https://github.com/owner/repo/actions/runs/123'])(
  'rejects invalid run ID %j before reading GitHub', async (runId) => {
    const f = fixture()
    await expect(selectCuaHelperArtifact(repository, runId, key, f.api, f.matchesSource)).rejects.toThrow('numeric run ID')
    expect(f.api).not.toHaveBeenCalled()
  },
)

it.each(['wrong/repo/extra', '../repo', 'owner/..', 'owner/.'])('rejects invalid repository %s before reading GitHub', async (repo) => {
  const f = fixture()
  await expect(selectCuaHelperArtifact(repo, '123', key, f.api, f.matchesSource)).rejects.toThrow('invalid repository')
  expect(f.api).not.toHaveBeenCalled()
})

it.each(['workflow', 'event', 'repository', 'head_repository', 'id', 'attempt', 'running', 'failed'] as const)(
  'rejects explicit %s run evidence', async (change) => {
    const f = fixture()
    if (change === 'workflow') f.run.path = '.github/workflows/ci.yml'
    if (change === 'event') f.run.event = 'pull_request'
    if (change === 'repository') f.run.repository.full_name = 'outsider/fork'
    if (change === 'head_repository') f.run.head_repository.full_name = 'outsider/fork'
    if (change === 'id') f.run.id = 124
    if (change === 'attempt') f.run.run_attempt = 1
    if (change === 'running') f.run.status = 'in_progress'
    if (change === 'failed') f.run.conclusion = 'failure'
    await expect(selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).rejects.toThrow()
    expect(f.api.mock.calls.some(([path]) => path.includes('/artifacts'))).toBe(false)
  },
)

it.each(['failure', 'cancelled', 'skipped', 'missing', 'duplicate'])(
  'rejects %s helper jobs without falling back to attempt 1', async (status) => {
    const f = fixture()
    f.run.path = '.github/workflows/release-publish.yml'
    f.run.conclusion = 'failure'
    f.jobs[0]!.jobs = status === 'missing' ? [] : status === 'duplicate'
      ? [{ name: 'cua-helper / package', conclusion: 'success', run_attempt: 2 }, { name: 'cua-helper / package', conclusion: 'success', run_attempt: 2 }]
      : [{ name: 'cua-helper / package', conclusion: status, run_attempt: 2 }]
    await expect(selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).rejects.toThrow('last executed cua-helper / package job did not succeed')
    expect(f.api.mock.calls.some(([path]) => path.includes('/attempts/1') || path.includes('/artifacts'))).toBe(false)
  },
)

it.each(['missing', 'expired', 'empty', 'mismatch', 'legacy'] as const)(
  'rebuilds on automatic %s but rejects the same explicit selection', async (change) => {
    const f = fixture()
    if (change === 'missing') f.artifacts.pop()
    if (change === 'expired') f.artifact.expired = true
    if (change === 'empty') f.artifact.size_in_bytes = 0
    if (change === 'mismatch') f.artifact.name = `cua-helper-123-2-${'b'.repeat(64)}`
    if (change === 'legacy') f.artifact.name = 'cua-helper-123-2'
    expect(await selectCuaHelperArtifact(repository, '', key, f.api, f.matchesSource)).toBeUndefined()
    await expect(selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).rejects.toThrow('CUA reuse: run 123:')
  },
)

it('selects a match across workflows and pages after a newer failed producer', async () => {
  const f = fixture()
  const api = vi.fn(async (path: string, paginate?: boolean): Promise<unknown> => {
    if (path.includes('/workflows/cua-helper-package.yml/runs?')) return [{ workflow_runs: [] }]
    if (path.includes('/workflows/release-publish.yml/runs?')) return [{ workflow_runs: [{ id: 124 }] }, { workflow_runs: [{ id: 123 }] }]
    if (path.endsWith('/runs/124/artifacts?per_page=100')) return [{ artifacts: [{ ...f.artifact, name: `cua-helper-124-1-${key}` }] }]
    if (path.endsWith('/runs/124')) return { run_attempt: 1 }
    if (path.endsWith('/runs/124/attempts/1')) return { ...f.run, id: 124, run_attempt: 1, conclusion: 'failure' }
    return f.api(path, paginate)
  })
  expect((await selectCuaHelperArtifact(repository, '', key, api, f.matchesSource, new Date('2026-11-03T00:00:00Z')))?.runId).toBe('123')
  const paths = api.mock.calls.map(([path]) => path)
  expect(paths.find(path => path.includes('/workflows/'))).toContain(encodeURIComponent('>=2026-10-20T00:00:00.000Z'))
  expect(paths.indexOf(`${base.replace('123', '124')}/attempts/1`)).toBeLessThan(paths.indexOf(base))
})

it.each(['duplicate', 'invalid metadata'] as const)('stops automatic discovery on %s evidence', async (change) => {
  const f = fixture()
  if (change === 'duplicate') f.artifacts.push({ artifacts: [{ ...f.artifact, id: 457 }] })
  const api = async (path: string, paginate?: boolean): Promise<unknown> => change === 'invalid metadata' && path.endsWith('/artifacts?per_page=100')
    ? [{ artifacts: [{ ...f.artifact, expired: 'false' }] }] : f.api(path, paginate)
  await expect(selectCuaHelperArtifact(repository, '', key, api, f.matchesSource)).rejects.toThrow()
})

it.each(['', '123'])('propagates unavailable GitHub evidence with selection %j', async (runId) => {
  const api = vi.fn(async () => { throw new Error('HTTP 403') })
  await expect(selectCuaHelperArtifact(repository, runId, key, api, async () => true)).rejects.toThrow('HTTP 403')
  expect(api).toHaveBeenCalledTimes(1)
})

it('does not query job or attempt details when artifact names exclude the requested build key', async () => {
  const f = fixture()
  f.artifact.name = 'cua-helper-123-2-legacy'
  f.artifacts.shift()
  expect(await selectCuaHelperArtifact(repository, '', key, f.api, f.matchesSource)).toBeUndefined()
  expect(f.api.mock.calls.map(([path]) => path).filter(path => !path.includes('/workflows/')))
    .toEqual([`${base}/artifacts?per_page=100`])
})

it.each(['123', ''])('retains the original helper after a publish-only rerun with selection %j', async (runId) => {
  const f = fixture()
  f.run.path = '.github/workflows/release-publish.yml'
  f.jobs[0]!.jobs = [{ name: 'cua-helper / package', conclusion: 'success', run_attempt: 1 },
    { name: 'Publish to npm', conclusion: 'success', run_attempt: 2 }]
  f.artifacts.pop()
  expect(await selectCuaHelperArtifact(repository, runId, key, f.api, f.matchesSource))
    .toEqual({ runId: '123', attempt: '1', artifactId: '455' })
  expect(f.matchesSource).toHaveBeenCalledExactlyOnceWith(f.run.head_sha)
})

it('does not reuse an older successful helper after a newer helper execution failed', async () => {
  const f = fixture()
  f.run.path = '.github/workflows/release-publish.yml'
  f.jobs[0]!.jobs = [{ name: 'cua-helper / package', conclusion: 'success', run_attempt: 1 },
    { name: 'cua-helper / package', conclusion: 'failure', run_attempt: 2 }]
  expect(await selectCuaHelperArtifact(repository, '', key, f.api, f.matchesSource)).toBeUndefined()
  await expect(selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).rejects.toThrow('did not succeed')
  expect(f.matchesSource).not.toHaveBeenCalled()
})

it('rejects forged artifact keys when independent producer source evidence differs', async () => {
  const f = fixture()
  f.matchesSource.mockResolvedValue(false)
  expect(await selectCuaHelperArtifact(repository, '', key, f.api, f.matchesSource)).toBeUndefined()
  await expect(selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).rejects.toThrow('producer commit')
})

it('stops when a new attempt appears during selection', async () => {
  const f = fixture()
  f.jobs[0]!.jobs[0]!.run_attempt = 3
  await expect(selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).rejects.toThrow('run advanced')
})

it('authenticates native HTTP requests and follows canonical GitHub pagination links', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ jobs: [{ id: 1 }] }, {
      headers: { link: '<https://api.github.com/repositories/42/actions/jobs?page=2>; rel="next"' },
    }))
    .mockResolvedValueOnce(Response.json({ jobs: [{ id: 2 }] }))
  const api = createGitHubJsonReader({ GH_TOKEN: 'fixture-token' }, request)
  await expect(api('repos/owner/repo/actions/jobs?page=1', true)).resolves.toEqual([
    { jobs: [{ id: 1 }] }, { jobs: [{ id: 2 }] },
  ])
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1]![1]?.signal).toBe(request.mock.calls[0]![1]?.signal)
  expect(request.mock.calls[1]![0]).toHaveProperty('href', 'https://api.github.com/repositories/42/actions/jobs?page=2')
  for (const [, options] of request.mock.calls) {
    const headers = new Headers(options?.headers)
    expect(headers.get('authorization')).toBe('Bearer fixture-token')
    expect(headers.get('accept')).toBe('application/vnd.github+json')
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.redirect).toBe('error')
  }
})

it('uses the configured GitHub API base path and leaves non-paginated JSON unwrapped', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ run_attempt: 2 }))
  const api = createGitHubJsonReader({ GH_TOKEN: 'fixture-token', GITHUB_API_URL: 'https://github.example.test/api/v3' }, request)
  await expect(api('repos/owner/repo/actions/runs/123')).resolves.toEqual({ run_attempt: 2 })
  expect(request.mock.calls[0]![0]).toHaveProperty('href', 'https://github.example.test/api/v3/repos/owner/repo/actions/runs/123')
})

it.each([401, 403, 429, 500, 503])('rejects HTTP %s without returning a partial page list or response credentials', async (status) => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ jobs: [{ id: 1 }] }, {
      headers: { link: '<https://api.github.com/repos/owner/repo/jobs?page=2>; rel="next"' },
    }))
    .mockResolvedValueOnce(new Response('private-response-value', { status }))
  const api = createGitHubJsonReader({ GH_TOKEN: 'fixture-token' }, request)
  const result = api('repos/owner/repo/jobs?page=1', true)
  await expect(result).rejects.toThrow(`HTTP ${status}`)
  await expect(result).rejects.not.toThrow('private-response-value')
  await expect(result).rejects.not.toThrow('fixture-token')
})

it.each(['connection reset', 'request timeout'])('reports %s as a failed query', async (failure) => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(new Error(failure))
  const api = createGitHubJsonReader({ GH_TOKEN: 'fixture-token' }, request)
  await expect(api('repos/owner/repo')).rejects.toThrow('failed or timed out')
})

it('rejects invalid JSON without exposing its content', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-response-value'))
  const result = createGitHubJsonReader({ GH_TOKEN: 'fixture-token' }, request)('repos/owner/repo')
  await expect(result).rejects.toThrow('invalid JSON')
  await expect(result).rejects.not.toThrow('private-response-value')
})

it.each([
  'https://outside.example.test/page/2',
  'https://fixture-token@api.github.com/repos/owner/repo/jobs?page=2',
  'https://api.github.com/repos/owner/repo/jobs?page=1',
])('rejects unsafe or cyclic pagination %s before sending another request', async (next) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ jobs: [] }, { headers: { link: `<${next}>; rel="next"` } }))
  const api = createGitHubJsonReader({ GH_TOKEN: 'fixture-token' }, request)
  await expect(api('repos/owner/repo/jobs?page=1', true)).rejects.toThrow('CUA reuse: GitHub')
  expect(request).toHaveBeenCalledTimes(1)
})

it('rejects a malformed next-page header', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { headers: { link: 'missing-url; rel="next"' } }))
  await expect(createGitHubJsonReader({ GH_TOKEN: 'fixture-token' }, request)('repos/owner/repo/jobs', true))
    .rejects.toThrow('invalid pagination link')
})

it('stops reading an oversized response and cancels its stream', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  })
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
  await expect(createGitHubJsonReader({ GH_TOKEN: 'fixture-token' }, request)('repos/owner/repo/git/trees/fixture'))
    .rejects.toThrow('exceeds 32 MiB')
  expect(cancelled).toBe(true)
})

it.each(['', 'not-a-url', 'http://api.github.com', 'https://user:private@api.github.com', 'https://api.github.com?token=private'])(
  'rejects invalid API configuration %j before requesting data', (url) => {
    const request = vi.fn<typeof fetch>()
    expect(() => createGitHubJsonReader({ GH_TOKEN: 'fixture-token', GITHUB_API_URL: url }, request)).toThrow('GITHUB_API_URL')
    expect(request).not.toHaveBeenCalled()
  },
)

it('requires an explicit Actions token instead of relying on gh credentials', () => {
  const request = vi.fn<typeof fetch>()
  expect(() => createGitHubJsonReader({}, request)).toThrow('GH_TOKEN is required')
  expect(request).not.toHaveBeenCalled()
})

it('propagates an asynchronous source verification failure', async () => {
  const f = fixture()
  f.matchesSource.mockRejectedValue(new Error('source evidence unavailable'))
  await expect(selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).rejects.toThrow('source evidence unavailable')
})

it('passes the 60-second abort signal to the HTTP transport', async () => {
  const controller = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  onTestFinished(() => { timeout.mockRestore() })
  const request: typeof fetch = async (_url, options) => {
    expect(options?.signal).toBe(controller.signal)
    controller.abort(new DOMException('fixture timeout', 'TimeoutError'))
    options?.signal?.throwIfAborted()
    throw new Error('Expected an aborted request')
  }
  await expect(createGitHubJsonReader({ GH_TOKEN: 'fixture-token' }, request)('repos/owner/repo')).rejects.toThrow('timed out')
  expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000)
})
