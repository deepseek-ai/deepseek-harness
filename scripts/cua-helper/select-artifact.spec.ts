/** Retained CUA selection stays within one producer, attempt and immutable artifact. */
import { expect, it, vi } from 'vitest'
import { selectCuaHelperArtifact } from './select-artifact.ts'

const repository = 'deepseek-harness/deepseek-harness'
const base = `repos/${repository}/actions/runs/123`

function fixture() {
  const run = { id: 123, run_attempt: 2, status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
    path: '.github/workflows/cua-helper-package.yml', repository: { full_name: repository } }
  const jobs = [{ jobs: [{ name: 'package', conclusion: 'success' }] }]
  const artifact = { id: 456, name: 'cua-helper-123-2', expired: false, size_in_bytes: 4096 }
  const artifacts = [{ artifacts: [{ ...artifact, id: 455, name: 'cua-helper-123-1' }] }, { artifacts: [artifact] }]
  const api = vi.fn((path: string, paginate?: boolean) => {
    if (path === base) { expect(paginate).toBeUndefined(); return { run_attempt: 2 } }
    if (path === `${base}/attempts/2`) { expect(paginate).toBeUndefined(); return run }
    expect(paginate).toBe(true)
    if (path === `${base}/attempts/2/jobs?per_page=100`) return jobs
    if (path === `${base}/artifacts?per_page=100`) return artifacts
    throw new Error(`Unexpected GitHub request ${path}`)
  })
  return { run, jobs, artifact, artifacts, api }
}

it.each([undefined, '', '2'])('pins attempt %s and finds its artifact across pages', (attempt) => {
  const f = fixture()
  expect(selectCuaHelperArtifact(repository, { cua_run_id: '123', cua_run_attempt: attempt }, f.api))
    .toEqual({ runId: '123', attempt: '2', artifactId: '456' })
  expect(f.api.mock.calls.some(([path]) => path === base)).toBe(attempt !== '2')
})

it('allows successful CUA packaging when later publication jobs failed', () => {
  const f = fixture()
  f.run.path = '.github/workflows/release-publish.yml'
  f.run.conclusion = 'failure'
  f.jobs[0]!.jobs = [{ name: 'cua-helper / package', conclusion: 'success' }, { name: 'Publish to npm', conclusion: 'failure' }]
  expect(selectCuaHelperArtifact(repository, { cua_run_id: '123' }, f.api).artifactId).toBe('456')
})

it.each([
  {}, { cua_run_attempt: '2' }, { cua_run_id: '' }, { cua_run_id: '123/other' }, { cua_run_id: ' 123' },
  { cua_run_id: '0' }, { cua_run_id: '123', cua_run_attempt: '-1' }, { cua_run_id: '123', cua_run_attempt: '2\nartifact-id=9' },
])('rejects invalid selection fields before reading GitHub: %j', (inputs) => {
  const f = fixture()
  expect(() => selectCuaHelperArtifact(repository, inputs, f.api)).toThrow()
  expect(f.api).not.toHaveBeenCalled()
})

it.each(['wrong/repo/extra', '../repo', 'owner/..', 'owner/.'])('rejects invalid repository %s before reading GitHub', (repo) => {
  const f = fixture()
  expect(() => selectCuaHelperArtifact(repo, { cua_run_id: '123' }, f.api)).toThrow('invalid repository')
  expect(f.api).not.toHaveBeenCalled()
})

it.each(['workflow', 'event', 'repository', 'id', 'attempt', 'running', 'failed'] as const)('rejects %s run evidence', (change) => {
  const f = fixture()
  if (change === 'workflow') f.run.path = '.github/workflows/ci.yml'
  if (change === 'event') f.run.event = 'pull_request'
  if (change === 'repository') f.run.repository.full_name = 'outsider/fork'
  if (change === 'id') f.run.id = 124
  if (change === 'attempt') f.run.run_attempt = 1
  if (change === 'running') f.run.status = 'in_progress'
  if (change === 'failed') f.run.conclusion = 'failure'
  expect(() => selectCuaHelperArtifact(repository, { cua_run_id: '123' }, f.api)).toThrow()
  expect(f.api.mock.calls.some(([path]) => path.includes('/artifacts'))).toBe(false)
})

it.each(['failure', 'cancelled', 'skipped', 'missing', 'duplicate'])(
  'rejects %s helper jobs without falling back to attempt 1', (status) => {
    const f = fixture()
    f.run.path = '.github/workflows/release-publish.yml'
    f.run.conclusion = 'failure'
    f.jobs[0]!.jobs = status === 'missing' ? [] : status === 'duplicate'
      ? [{ name: 'cua-helper / package', conclusion: 'success' }, { name: 'cua-helper / package', conclusion: 'success' }]
      : [{ name: 'cua-helper / package', conclusion: status }]
    expect(() => selectCuaHelperArtifact(repository, { cua_run_id: '123' }, f.api)).toThrow('successful cua-helper / package job')
    expect(f.api.mock.calls.some(([path]) => path.includes('/attempts/1') || path.includes('/artifacts'))).toBe(false)
  },
)

it.each(['missing', 'expired', 'empty', 'duplicate'] as const)('rejects %s artifacts instead of another attempt', (change) => {
  const f = fixture()
  if (change === 'missing') f.artifacts.pop()
  if (change === 'expired') f.artifact.expired = true
  if (change === 'empty') f.artifact.size_in_bytes = 0
  if (change === 'duplicate') f.artifacts.push({ artifacts: [{ ...f.artifact, id: 457 }] })
  expect(() => selectCuaHelperArtifact(repository, { cua_run_id: '123' }, f.api)).toThrow('select an available build or rebuild')
})

it('propagates unavailable GitHub evidence without returning a selection', () => {
  const api = vi.fn(() => { throw new Error('HTTP 404') })
  expect(() => selectCuaHelperArtifact(repository, { cua_run_id: '123' }, api)).toThrow('HTTP 404')
  expect(api).toHaveBeenCalledTimes(1)
})
