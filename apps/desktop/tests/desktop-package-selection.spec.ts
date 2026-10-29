import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { selectDesktopPackage } from '../scripts/resolve-desktop-publish-ci.ts'
import { resolveRetainedDesktopPublication } from '../scripts/resolve-retained-desktop-publish-ci.ts'
import { retainDesktopRelease, verifyRetainedDesktopRelease } from '../scripts/desktop-release-store.ts'

function fixture() {
  const run = { id: 42, run_attempt: 2, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success',
    event: 'workflow_dispatch', path: '.github/workflows/macos-package.yml', repository: { full_name: 'owner/repo' } }
  const jobs = [{ name: 'package', runner_name: 'mini', conclusion: 'success' }]
  const routes = { mini: { label: 'dsh-mini', target: 'mac-arm64' } }
  const calls: string[] = []
  const api = (path: string, paginate?: boolean) => {
    calls.push(path)
    if (path.endsWith('/jobs?per_page=100')) { expect(paginate).toBe(true); return [{ jobs: [] }, { jobs }] }
    if (path.endsWith('/42')) return { run_attempt: 2 }
    return run
  }
  return { run, jobs, routes, calls, api }
}

it('pins the latest successful attempt and finds the package job across pages', () => {
  const f = fixture()
  expect(selectDesktopPackage('owner/repo', { package_run_id: '42' }, f.routes, f.api))
    .toMatchObject({ run: { run_attempt: 2 }, runnerName: 'mini', runnerLabel: 'dsh-mini' })
  expect(f.calls).toContain('repos/owner/repo/actions/runs/42/attempts/2')
})

it('routes a Windows package through its own configured machine target', () => {
  const f = fixture()
  f.run.path = '.github/workflows/windows-package.yml'
  const routes = { mini: { label: 'dsh-windows', target: 'win-x64' } }
  expect(selectDesktopPackage('owner/repo', { package_run_id: '42' }, routes, f.api)).toMatchObject({ runnerLabel: 'dsh-windows' })
  expect(() => selectDesktopPackage('owner/repo', { package_run_id: '42' }, f.routes, f.api)).toThrow(/no configured/u)
})

it('selects an explicit old attempt without consulting the latest attempt', () => {
  const f = fixture()
  f.run.run_attempt = 1
  selectDesktopPackage('owner/repo', { package_run_id: '42', package_run_attempt: '1' }, f.routes, f.api)
  expect(f.calls).not.toContain('repos/owner/repo/actions/runs/42')
  expect(f.calls).toContain('repos/owner/repo/actions/runs/42/attempts/1')
})

it.each(['failed', 'cancelled', 'running', 'workflow', 'repository', 'attempt', 'run', 'job', 'ambiguous', 'route', 'label'])(
  'rejects %s evidence without falling back to a different attempt', (kind) => {
    const f = fixture()
    if (kind === 'failed') f.run.conclusion = 'failure'
    if (kind === 'cancelled') f.run.conclusion = 'cancelled'
    if (kind === 'running') f.run.status = 'in_progress'
    if (kind === 'workflow') f.run.path = '.github/workflows/ci.yml'
    if (kind === 'repository') f.run.repository.full_name = 'other/repo'
    if (kind === 'attempt') f.run.run_attempt = 1
    if (kind === 'run') f.run.id = 50
    if (kind === 'job') f.jobs[0]!.name = 'other'
    if (kind === 'ambiguous') f.jobs.push({ ...f.jobs[0]! })
    const routes = kind === 'route' ? {} : kind === 'label' ? { ...f.routes, other: f.routes.mini } : f.routes
    expect(() => selectDesktopPackage('owner/repo', { package_run_id: '42' }, routes, f.api)).toThrow()
    expect(f.calls.some(path => path.includes('/attempts/1'))).toBe(false)
  },
)

it.each(['0', '../42', '1\nrunner=x', 'abc'])('rejects malformed package ID %s before API access', (id) => {
  const f = fixture()
  expect(() => selectDesktopPackage('owner/repo', { package_run_id: id }, f.routes, f.api)).toThrow()
  expect(f.calls).toEqual([])
})

it('resolves an old locally retained package with publishRequested=false without a GitHub artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-selection-'))
  try {
    const f = fixture()
    const selection = selectDesktopPackage('owner/repo', { package_run_id: '42' }, f.routes, f.api)
    const file = join(root, 'installer.dmg')
    await writeFile(file, 'fixture')
    const source = { repository: 'owner/repo', runId: '42', attempt: '2', commit: 'a'.repeat(40),
      workflowCommit: 'a'.repeat(40), sourceRef: 'master', channel: 'nightly' as const, runnerName: 'mini',
      target: 'mac-arm64' as const, preset: 'test' as const, productVersion: '1.0.0', version: '1.0.0',
      testReleaseId: 'b'.repeat(32), publishRequested: false, qualification: 'notarized' as const }
    await retainDesktopRelease(join(root, 'releases'), source, [file])
    const env = { GITHUB_REPOSITORY: 'owner/repo', RUNNER_NAME: 'mini', DSH_PACKAGING_CONFIG_DIR: join(root, 'packaging'),
      DESKTOP_PACKAGE_SELECTION: JSON.stringify(selection) }
    const apiCalls: string[] = []
    const api = (path: string) => {
      apiCalls.push(path)
      if (path.includes('/compare/')) return { status: 'ahead' }
      if (path.includes('/environments/')) return { protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }] }
      return { sha: source.commit }
    }
    expect(await resolveRetainedDesktopPublication(env, api)).toMatchObject({ runId: '42', attempt: '2', preset: 'test' })
    expect(apiCalls.some(path => path.includes('/artifacts'))).toBe(false)
    await expect(resolveRetainedDesktopPublication({ ...env, RUNNER_NAME: 'other' }, api)).rejects.toThrow(/different machine/u)
    await expect(resolveRetainedDesktopPublication(env, path => path.includes('/environments/') ? { protection_rules: [] } : api(path)))
      .rejects.toThrow(/reviewers/u)
    await expect(resolveRetainedDesktopPublication(env, path => path.includes('/compare/') ? { status: 'diverged' } : api(path)))
      .rejects.toThrow(/not on the selected repository branch/u)
    const manifestPath = join(root, 'releases/42/2/manifest.json')
    const original = await readFile(manifestPath, 'utf8')
    const tagged = await verifyRetainedDesktopRelease(join(root, 'releases'), '42', '2')
    tagged.source.sourceRef = 'feature/desktop-update'
    await writeFile(manifestPath, JSON.stringify(tagged))
    expect(await resolveRetainedDesktopPublication(env, api)).toMatchObject({ sourceRef: 'feature/desktop-update', commit: source.commit })
    expect(apiCalls).toContain(`repos/owner/repo/compare/${source.commit}...refs%2Fheads%2Ffeature%2Fdesktop-update`)
    await expect(resolveRetainedDesktopPublication(env, path => path.includes('/compare/') ? { status: 'diverged' } : api(path)))
      .rejects.toThrow(/selected repository branch/u)
    await expect(resolveRetainedDesktopPublication(env, (path) => {
      if (path.includes('/compare/')) throw new Error('branch deleted or missing')
      return api(path)
    })).rejects.toThrow(/branch deleted/u)
    tagged.source.sourceRef = 'dsh-v1.0.0'
    await writeFile(manifestPath, JSON.stringify(tagged))
    expect(await resolveRetainedDesktopPublication(env, api)).toMatchObject({ sourceRef: 'dsh-v1.0.0' })
    await expect(resolveRetainedDesktopPublication(env, path => path.endsWith('/commits/refs%2Ftags%2Fdsh-v1.0.0') ? { sha: 'c'.repeat(40) } : api(path)))
      .rejects.toThrow(/source tag changed/u)
    await writeFile(manifestPath, original)
    await writeFile(join(root, 'releases/42/2/installer.dmg'), 'changed')
    await expect(resolveRetainedDesktopPublication(env, api)).rejects.toThrow(/changed file/u)
    await rm(join(root, 'releases/42/2'), { recursive: true })
    await expect(resolveRetainedDesktopPublication(env, api)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('routes both Mac architectures to one machine without authorizing an unlisted target', () => {
  const f = fixture()
  const routes = { mini: { label: 'dsh-mini', target: ['mac-arm64', 'mac-x64'] } }
  for (const path of ['macos-package.yml', 'macos-intel-package.yml']) {
    f.run.path = `.github/workflows/${path}`
    expect(selectDesktopPackage('owner/repo', { package_run_id: '42' }, routes, f.api))
      .toMatchObject({ runnerName: 'mini', runnerLabel: 'dsh-mini' })
  }
  expect(() => selectDesktopPackage('owner/repo', { package_run_id: '42' }, f.routes, f.api)).toThrow(/no configured/u)
  for (const target of [[], ['mac-x64', 'linux-x64']]) {
    expect(() => selectDesktopPackage('owner/repo', { package_run_id: '42' }, { mini: { label: 'dsh-mini', target } }, f.api)).toThrow()
  }
})
