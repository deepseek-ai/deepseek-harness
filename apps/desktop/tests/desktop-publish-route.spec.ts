import { expect, it } from 'vitest'
import { resolveDesktopPublishRoute } from '../scripts/desktop-publish-route.ts'

function fixture() {
  const run = { id: 42, run_attempt: 2, head_sha: 'a'.repeat(40), path: '.github/workflows/macos-package.yml',
    conclusion: 'success', event: 'workflow_dispatch', repository: { full_name: 'owner/repo' } }
  const source = { repository: 'owner/repo', runId: '42', attempt: '2', commit: run.head_sha, runnerName: 'mini',
    workflowCommit: run.head_sha, sourceRef: 'master', channel: 'nightly',
    target: 'mac-arm64', preset: 'test', publishRequested: true, qualification: 'notarized' }
  const jobs = [{ runner_name: 'mini', conclusion: 'success', labels: ['self-hosted', 'dsh-mini'] }]
  const routes = { mini: { label: 'dsh-mini', target: 'mac-arm64' } }
  return { run, source, jobs, routes }
}

it('routes the exact successful attempt to its registered machine', () => {
  const f = fixture()
  expect(resolveDesktopPublishRoute('owner/repo', f.run, { source: f.source }, f.jobs, f.routes))
    .toMatchObject({ runId: '42', attempt: '2', runnerLabel: 'dsh-mini', preset: 'test' })
})

it.each(['attempt', 'repository', 'commit', 'mode', 'request', 'runner', 'workflow'] as const)('rejects mismatched %s evidence', (field) => {
  const f = fixture()
  if (field === 'attempt') f.source.attempt = '1'
  if (field === 'repository') f.source.repository = 'other/repo'
  if (field === 'commit') f.source.workflowCommit = 'b'.repeat(40)
  if (field === 'mode') f.source.qualification = 'unnotarized'
  if (field === 'request') f.source.publishRequested = false
  if (field === 'runner') f.jobs[0]!.runner_name = 'laptop'
  if (field === 'workflow') f.run.path = '.github/workflows/ci.yml'
  expect(() => resolveDesktopPublishRoute('owner/repo', f.run, { source: f.source }, f.jobs, f.routes)).toThrow()
})

it('fails closed when a publishing route or its unique label is missing', () => {
  const f = fixture()
  expect(() => resolveDesktopPublishRoute('owner/repo', f.run, { source: f.source }, f.jobs, {})).toThrow(/no configured/u)
  const duplicates = { ...f.routes, laptop: { label: 'dsh-mini', target: 'mac-arm64' } }
  expect(() => resolveDesktopPublishRoute('owner/repo', f.run, { source: f.source }, f.jobs, duplicates)).toThrow(/unique runner label/u)
})


it('keeps the artifact source separate from the workflow commit', () => {
  const f = fixture()
  f.source.commit = 'b'.repeat(40)
  f.source.sourceRef = 'dsh-v1.0.0'
  expect(resolveDesktopPublishRoute('owner/repo', f.run, { source: f.source }, f.jobs, f.routes))
    .toMatchObject({ commit: 'b'.repeat(40), sourceRef: 'dsh-v1.0.0', channel: 'nightly' })
})
