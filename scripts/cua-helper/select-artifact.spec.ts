/** Discovery and explicit selection require matching inputs and successful producer evidence. */
import { expect, it, vi } from 'vitest'
import { selectCuaHelperArtifact } from './select-artifact.ts'

const repository = 'deepseek-harness/deepseek-harness'
const base = `repos/${repository}/actions/runs/123`
const key = 'a'.repeat(64)

function fixture() {
  const run = { id: 123, run_attempt: 2, status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
    path: '.github/workflows/cua-helper-package.yml', head_sha: 'c'.repeat(40), repository: { full_name: repository }, head_repository: { full_name: repository } }
  const jobs = [{ jobs: [{ name: 'package', conclusion: 'success', run_attempt: 2 }] }]
  const matchesSource = vi.fn((_commit: string) => true)
  const artifact = { id: 456, name: `cua-helper-123-2-${key}`, expired: false, size_in_bytes: 4096 }
  const artifacts = [{ artifacts: [{ ...artifact, id: 455, name: `cua-helper-123-1-${key}` }] }, { artifacts: [artifact] }]
  const api = vi.fn((path: string, paginate?: boolean) => {
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

it.each(['123', ''])('selects a matching artifact with run ID %j and pins the latest attempt', (runId) => {
  const f = fixture()
  expect(selectCuaHelperArtifact(repository, runId, key, f.api, f.matchesSource))
    .toEqual({ runId: '123', attempt: '2', artifactId: '456' })
  expect(f.api.mock.calls.filter(([path]) => path === base)).toHaveLength(1)
  expect(f.api.mock.calls.some(([path]) => path.includes('/workflows/'))).toBe(runId === '')
})

it('allows successful helper packaging when later npm publication failed', () => {
  const f = fixture()
  f.run.path = '.github/workflows/release-publish.yml'
  f.run.conclusion = 'failure'
  f.jobs[0]!.jobs = [{ name: 'cua-helper / package', conclusion: 'success', run_attempt: 2 }, { name: 'Publish to npm', conclusion: 'failure', run_attempt: 2 }]
  expect(selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)?.artifactId).toBe('456')
})

it.each(['123/other', ' 123', '0', '-1', '2\nartifact-id=9', 'https://github.com/owner/repo/actions/runs/123'])(
  'rejects invalid run ID %j before reading GitHub', (runId) => {
    const f = fixture()
    expect(() => selectCuaHelperArtifact(repository, runId, key, f.api, f.matchesSource)).toThrow('numeric run ID')
    expect(f.api).not.toHaveBeenCalled()
  },
)

it.each(['wrong/repo/extra', '../repo', 'owner/..', 'owner/.'])('rejects invalid repository %s before reading GitHub', (repo) => {
  const f = fixture()
  expect(() => selectCuaHelperArtifact(repo, '123', key, f.api, f.matchesSource)).toThrow('invalid repository')
  expect(f.api).not.toHaveBeenCalled()
})

it.each(['workflow', 'event', 'repository', 'head_repository', 'id', 'attempt', 'running', 'failed'] as const)(
  'rejects explicit %s run evidence', (change) => {
    const f = fixture()
    if (change === 'workflow') f.run.path = '.github/workflows/ci.yml'
    if (change === 'event') f.run.event = 'pull_request'
    if (change === 'repository') f.run.repository.full_name = 'outsider/fork'
    if (change === 'head_repository') f.run.head_repository.full_name = 'outsider/fork'
    if (change === 'id') f.run.id = 124
    if (change === 'attempt') f.run.run_attempt = 1
    if (change === 'running') f.run.status = 'in_progress'
    if (change === 'failed') f.run.conclusion = 'failure'
    expect(() => selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).toThrow()
    expect(f.api.mock.calls.some(([path]) => path.includes('/artifacts'))).toBe(false)
  },
)

it.each(['failure', 'cancelled', 'skipped', 'missing', 'duplicate'])(
  'rejects %s helper jobs without falling back to attempt 1', (status) => {
    const f = fixture()
    f.run.path = '.github/workflows/release-publish.yml'
    f.run.conclusion = 'failure'
    f.jobs[0]!.jobs = status === 'missing' ? [] : status === 'duplicate'
      ? [{ name: 'cua-helper / package', conclusion: 'success', run_attempt: 2 }, { name: 'cua-helper / package', conclusion: 'success', run_attempt: 2 }]
      : [{ name: 'cua-helper / package', conclusion: status, run_attempt: 2 }]
    expect(() => selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).toThrow('last executed cua-helper / package job did not succeed')
    expect(f.api.mock.calls.some(([path]) => path.includes('/attempts/1') || path.includes('/artifacts'))).toBe(false)
  },
)

it.each(['missing', 'expired', 'empty', 'mismatch', 'legacy'] as const)(
  'rebuilds on automatic %s but rejects the same explicit selection', (change) => {
    const f = fixture()
    if (change === 'missing') f.artifacts.pop()
    if (change === 'expired') f.artifact.expired = true
    if (change === 'empty') f.artifact.size_in_bytes = 0
    if (change === 'mismatch') f.artifact.name = `cua-helper-123-2-${'b'.repeat(64)}`
    if (change === 'legacy') f.artifact.name = 'cua-helper-123-2'
    expect(selectCuaHelperArtifact(repository, '', key, f.api, f.matchesSource)).toBeUndefined()
    expect(() => selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).toThrow('CUA reuse: run 123:')
  },
)

it('selects a match across workflows and pages after a newer failed producer', () => {
  const f = fixture()
  const api = vi.fn((path: string, paginate?: boolean): unknown => {
    if (path.includes('/workflows/cua-helper-package.yml/runs?')) return [{ workflow_runs: [] }]
    if (path.includes('/workflows/release-publish.yml/runs?')) return [{ workflow_runs: [{ id: 124 }] }, { workflow_runs: [{ id: 123 }] }]
    if (path.endsWith('/runs/124/artifacts?per_page=100')) return [{ artifacts: [{ ...f.artifact, name: `cua-helper-124-1-${key}` }] }]
    if (path.endsWith('/runs/124')) return { run_attempt: 1 }
    if (path.endsWith('/runs/124/attempts/1')) return { ...f.run, id: 124, run_attempt: 1, conclusion: 'failure' }
    return f.api(path, paginate)
  })
  expect(selectCuaHelperArtifact(repository, '', key, api, f.matchesSource, new Date('2026-11-03T00:00:00Z'))?.runId).toBe('123')
  const paths = api.mock.calls.map(([path]) => path)
  expect(paths.find(path => path.includes('/workflows/'))).toContain(encodeURIComponent('>=2026-10-20T00:00:00.000Z'))
  expect(paths.indexOf(`${base.replace('123', '124')}/attempts/1`)).toBeLessThan(paths.indexOf(base))
})

it.each(['duplicate', 'invalid metadata'] as const)('stops automatic discovery on %s evidence', (change) => {
  const f = fixture()
  if (change === 'duplicate') f.artifacts.push({ artifacts: [{ ...f.artifact, id: 457 }] })
  const api = (path: string, paginate?: boolean): unknown => change === 'invalid metadata' && path.endsWith('/artifacts?per_page=100')
    ? [{ artifacts: [{ ...f.artifact, expired: 'false' }] }] : f.api(path, paginate)
  expect(() => selectCuaHelperArtifact(repository, '', key, api, f.matchesSource)).toThrow()
})

it.each(['', '123'])('propagates unavailable GitHub evidence with selection %j', (runId) => {
  const api = vi.fn(() => { throw new Error('HTTP 403') })
  expect(() => selectCuaHelperArtifact(repository, runId, key, api, () => true)).toThrow('HTTP 403')
  expect(api).toHaveBeenCalledTimes(1)
})

it('does not query job or attempt details when artifact names exclude the requested build key', () => {
  const f = fixture()
  f.artifact.name = 'cua-helper-123-2-legacy'
  f.artifacts.shift()
  expect(selectCuaHelperArtifact(repository, '', key, f.api, f.matchesSource)).toBeUndefined()
  expect(f.api.mock.calls.map(([path]) => path).filter(path => !path.includes('/workflows/')))
    .toEqual([`${base}/artifacts?per_page=100`])
})

it.each(['123', ''])('retains the original helper after a publish-only rerun with selection %j', (runId) => {
  const f = fixture()
  f.run.path = '.github/workflows/release-publish.yml'
  f.jobs[0]!.jobs = [{ name: 'cua-helper / package', conclusion: 'success', run_attempt: 1 },
    { name: 'Publish to npm', conclusion: 'success', run_attempt: 2 }]
  f.artifacts.pop()
  expect(selectCuaHelperArtifact(repository, runId, key, f.api, f.matchesSource))
    .toEqual({ runId: '123', attempt: '1', artifactId: '455' })
  expect(f.matchesSource).toHaveBeenCalledExactlyOnceWith(f.run.head_sha)
})

it('does not reuse an older successful helper after a newer helper execution failed', () => {
  const f = fixture()
  f.run.path = '.github/workflows/release-publish.yml'
  f.jobs[0]!.jobs = [{ name: 'cua-helper / package', conclusion: 'success', run_attempt: 1 },
    { name: 'cua-helper / package', conclusion: 'failure', run_attempt: 2 }]
  expect(selectCuaHelperArtifact(repository, '', key, f.api, f.matchesSource)).toBeUndefined()
  expect(() => selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).toThrow('did not succeed')
  expect(f.matchesSource).not.toHaveBeenCalled()
})

it('rejects forged artifact keys when independent producer source evidence differs', () => {
  const f = fixture()
  f.matchesSource.mockReturnValue(false)
  expect(selectCuaHelperArtifact(repository, '', key, f.api, f.matchesSource)).toBeUndefined()
  expect(() => selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).toThrow('producer commit')
})

it('stops when a new attempt appears during selection', () => {
  const f = fixture()
  f.jobs[0]!.jobs[0]!.run_attempt = 3
  expect(() => selectCuaHelperArtifact(repository, '123', key, f.api, f.matchesSource)).toThrow('run advanced')
})
