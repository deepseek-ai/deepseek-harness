/** Release rehearsal routing and persistent-runner isolation, without executing release builds. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it, onTestFinished } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const repository = 'deepseek-harness/deepseek-harness'
const selfhosted = ['self-hosted', 'linux', 'x64', 'vm-backup']
const hosted = 'ubuntu-24.04'

interface Step {
  env?: Record<string, string>
  name?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency?: Record<string, unknown>
  jobs: Record<string, {
    name: string
    'runs-on': string
    steps: Step[]
    uses?: string
    if?: string
    with?: Record<string, unknown>
    needs?: string
    permissions?: Record<string, string>
    outputs?: Record<string, string>
    env?: Record<string, string>
  }>
}

function workflow(file: string): Workflow {
  return load(readFileSync(resolve(root, '.github/workflows', file), 'utf8')) as Workflow
}

// This canonical-case corpus has matching Actions/JavaScript comparison results.
// This is not an Actions interpreter: string case-folding and general coercion differ.
// Missing context properties use the Actions empty-string value.
function evaluate(expression: string, context: Record<string, string | boolean>): unknown {
  const source = expression.trim().replace(/^\$\{\{|\}\}$/g, '')
    .replace(/\b(?:github|vars|runner|inputs|needs|steps)(?:\.[a-zA-Z_][a-zA-Z_0-9-]*)+/g,
      key => JSON.stringify(context[key] ?? ''))
  return runInNewContext(source, {
    fromJSON: JSON.parse, startsWith: (value: string, prefix: string) => value.startsWith(prefix),
    cancelled: () => context['cancelled'] ?? false,
  }, { timeout: 1000 })
}

function assertSharedPersistentStore(run: string | undefined): void {
  expect(run).toContain('store_root="$HOME/.local/share/pnpm/store"')
  expect(run).toContain('echo "PNPM_CONFIG_STORE_DIR=$store_root" >> "$GITHUB_ENV"')
  expect(run).toContain('store_path=$(PNPM_CONFIG_STORE_DIR="$store_root" pnpm store path --silent)')
}

const trustedPr = {
  'vars.DSH_CI_FAILOVER_LINUX': 'selfhosted',
  'github.repository': repository,
  'github.actor': 'maintainer',
  'github.event_name': 'pull_request',
  'github.ref': 'refs/pull/42/merge',
  'github.event.pull_request.head.repo.full_name': repository,
  'github.event.pull_request.head.repo.fork': false,
  'github.event.pull_request.user.login': 'contributor',
}
const trustedPush = {
  'vars.DSH_CI_FAILOVER_LINUX': 'selfhosted',
  'github.repository': repository,
  'github.actor': 'maintainer',
  'github.event_name': 'push',
  'github.ref': 'refs/heads/master',
}
const fallbackCases: Array<[string, Record<string, string | boolean>]> = [
  ['unset switch', { ...trustedPr, 'vars.DSH_CI_FAILOVER_LINUX': '' }],
  ['hosted switch', { ...trustedPr, 'vars.DSH_CI_FAILOVER_LINUX': 'hosted' }],
  ['unknown switch', { ...trustedPr, 'vars.DSH_CI_FAILOVER_LINUX': 'true' }],
  ['fork PR', { ...trustedPr, 'github.event.pull_request.head.repo.full_name': 'outsider/fork', 'github.event.pull_request.head.repo.fork': true }],
  ['different head repository', { ...trustedPr, 'github.event.pull_request.head.repo.full_name': 'outsider/repo' }],
  ['fork flag', { ...trustedPr, 'github.event.pull_request.head.repo.fork': true }],
  ['Dependabot author rerun by maintainer', { ...trustedPr, 'github.event.pull_request.user.login': 'dependabot[bot]' }],
  ['Dependabot PR actor', { ...trustedPr, 'github.actor': 'dependabot[bot]' }],
  ['Dependabot push actor', { ...trustedPush, 'github.actor': 'dependabot[bot]' }],
  ['non-master push', { ...trustedPush, 'github.ref': 'refs/heads/topic' }],
  ['tag push', { ...trustedPush, 'github.ref': 'refs/tags/dsh-v1.0.0' }],
  ['push in another repository', { ...trustedPush, 'github.repository': 'outsider/fork' }],
  ['dispatch on master', { ...trustedPush, 'github.event_name': 'workflow_dispatch' }],
  ['dispatch on topic', { ...trustedPush, 'github.event_name': 'workflow_dispatch', 'github.ref': 'refs/heads/topic' }],
  ['dispatch on tag', { ...trustedPush, 'github.event_name': 'workflow_dispatch', 'github.ref': 'refs/tags/dsh-v1.0.0' }],
  ['pull_request_target', { ...trustedPr, 'github.event_name': 'pull_request_target' }],
  ['missing PR payload', { ...trustedPush, 'github.event_name': 'pull_request' }],
]

for (const [file, jobIds] of [['release.yml', ['dependencies', 'pack']], ['release-vendor.yml', ['pack']]] as const) {
  describe(file, () => {
    const release = workflow(file)
    it('preserves the logical jobs, rehearsal events and read-only permission', () => {
      expect(Object.keys(release.jobs)).toEqual(jobIds)
      expect(release.on).toEqual({ pull_request: null, push: { branches: ['master'] }, workflow_dispatch: null })
      expect(release.permissions).toEqual({ contents: 'read' })
      expect(release.concurrency).toEqual({ group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true })
    })
    for (const jobId of jobIds) {
      describe(jobId, () => {
        const job = release.jobs[jobId]!
        it('routes trusted PRs and master pushes onto the existing Linux pool', () => {
          expect(evaluate(job['runs-on'], trustedPr)).toEqual(selfhosted)
          expect(evaluate(job['runs-on'], trustedPush)).toEqual(selfhosted)
          expect(evaluate(job['runs-on'], { ...trustedPush, 'vars.DSH_CI_FAILOVER_LINUX': '' })).toBe(hosted)
        })
        it.each(fallbackCases)('keeps %s hosted', (_name, context) => {
          expect(evaluate(job['runs-on'], context)).toBe(hosted)
        })
        it('cleans stale checkout output and isolates setup before any pnpm invocation', () => {
          expect(job.steps[0]).toMatchObject({ uses: 'actions/checkout@v7.0.1', with: { clean: true, 'persist-credentials': false } })
          const cacheIndex = job.steps.findIndex(step => step.run?.includes('NODE_COMPILE_CACHE='))
          const pnpmIndex = job.steps.findIndex(step => step.uses?.startsWith('pnpm/') || /\bpnpm\b/.test(step.run ?? ''))
          expect(cacheIndex).toBeGreaterThan(0)
          expect(cacheIndex).toBeLessThan(pnpmIndex)
          expect(job.steps[cacheIndex]?.run).toContain('echo "NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache" >> "$GITHUB_ENV"')
          expect(job.steps[cacheIndex]?.run).toContain('echo "npm_config_devdir=${{ runner.temp }}/node-gyp" >> "$GITHUB_ENV"')
          expect(job.steps[cacheIndex]?.run).toContain('echo "TMPDIR=${{ runner.temp }}" >> "$GITHUB_ENV"')
          expect(job.steps.find(step => step.uses === 'pnpm/action-setup@v5.0.0')?.with?.dest)
            .toBe('${{ runner.temp }}/setup-pnpm-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}')
          expect(job.steps.find(step => step.name === 'Install (immutable)')?.run).toBe('pnpm install --frozen-lockfile')
        })
        it('retains the configured shared npm cache', () => {
          expect(JSON.stringify(release)).not.toMatch(/npm_config_cache/i)
        })
        it.each(['', 'store_root="${RUNNER_TEMP%/*}/pnpm-store"', 'store_root="$RUNNER_TEMP/pnpm-store"'])(
          'rejects missing, runner-private, or job-temporary store placement: %s', (replacement) => {
            const run = job.steps.find(step => step.name === 'Configure pnpm store path')?.run
              ?.replace('store_root="$HOME/.local/share/pnpm/store"', replacement)
            expect(() => { assertSharedPersistentStore(run) }).toThrow()
          },
        )
        it('uses the shared persistent store without remote cache reads or writes on self-hosted', () => {
          assertSharedPersistentStore(job.steps.find(step => step.name === 'Configure pnpm store path')?.run)
          const caches = job.steps.filter(step => step.uses?.startsWith('actions/cache'))
          expect(caches.map(step => step.uses)).toEqual(['actions/cache/restore@v6.1.0'])
          for (const step of caches) {
            expect(evaluate(step.if!, { 'runner.environment': 'self-hosted' })).toBe(false)
            expect(evaluate(step.if!, { 'runner.environment': 'github-hosted' })).toBe(true)
          }
          const nodeSetup = job.steps.find(step => step.uses === 'actions/setup-node@v7.0.0')
          expect(nodeSetup?.with?.cache).toBeUndefined()
          expect(nodeSetup?.with?.['package-manager-cache']).toBe(false)
        })
        it('retains the dependency and pack verification commands', () => {
          const commands = job.steps.flatMap(step => step.run === undefined ? [] : [step.run])
          if (jobId === 'dependencies') {
            // Both verifications share one step so the lane pays the longer half.
            const combined = commands.find(command => command.includes('verify-package-dependencies'))
            expect(combined).toContain('verify-npm-install-layout')
            expect(combined).toContain('wait "$layout_pid"')
          } else {
            const family = file === 'release.yml' ? 'dsh' : 'vendor'
            const output = family === 'dsh' ? 'dist/npm' : 'dist/npm-vendor'
            expect(job.steps[0]?.with?.['fetch-depth']).toBe(0)
            expect(commands).toContain('pnpm run release:verify --family ' + family)
            expect(commands).toContain(family === 'dsh'
              ? "${{ github.event_name == 'pull_request' && 'pnpm run build:artifacts --profile official' || 'pnpm run build:official' }}"
              : "${{ github.event_name == 'pull_request' && 'pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries' || 'pnpm run build:lib:host' }}")
            expect(commands).toContain('pnpm run release:pack --family ' + family + ' --out ' + output + ' --concurrency 8')
            expect(commands).toContain('pnpm run release:verify-packed-install --family ' + family + ' --from ' + output
              + (family === 'dsh' ? ' --from dist/npm-vendor --from dist/npm-landlock' : ''))
            expect(job.steps.at(-1)).toMatchObject({ uses: 'actions/upload-artifact@v7.0.1', with: { path: output + '/*', 'retention-days': 7 } })
          }
          expect(JSON.stringify(job)).not.toMatch(/secrets\.|release:publish|npm-publish/)
        })
      })
    }
  })
}

it('keeps vendor publication manual and entirely hosted', () => {
  const publish = workflow('release-vendor-publish.yml')
  expect(Object.keys(publish.on)).toEqual(['workflow_dispatch'])
  for (const job of Object.values(publish.jobs)) expect(job['runs-on']).toBe(hosted)
})
it('keeps DSH publication manual and delegates all helper selections to the Mac workflow', () => {
  const publish = workflow('release-publish.yml')
  expect(Object.keys(publish.on)).toEqual(['workflow_dispatch'])
  const helper = publish.jobs['cua-helper-macos']!
  expect(helper).toEqual({
    if: "startsWith(github.ref, 'refs/tags/dsh-v') || inputs.skip-tag-check",
    uses: './.github/workflows/cua-helper-package-macos.yml',
    with: { reuse: true, preset: 'production', cua_macos_run_id: '${{ inputs.cua_macos_run_id }}' },
  })
  for (const [name, job] of Object.entries(publish.jobs)) {
    if (name !== 'cua-helper-macos') expect(job['runs-on']).toBe(hosted)
  }
  expect(JSON.stringify(publish)).not.toContain('cua_run_attempt')
  expect(publish.on['workflow_dispatch']).toMatchObject({ inputs: { 'skip-tag-check': {
    description: 'Skip release tag validation for the selected ref; other publication checks still apply.',
  } } })
  expect(publish.jobs['pack']!.needs).toBe('cua-helper-macos')
  expect(publish.jobs['pack']!.if).toBeUndefined()
})

it.each([
  ['refs/tags/dsh-v0.2.1-rc.4', false, true],
  ['refs/heads/master', false, false],
  ['refs/heads/master', true, true],
] as const)('gates helper selection for ref %s, skip=%s', (ref, skip, expected) => {
  const expression = workflow('release-publish.yml').jobs['cua-helper-macos']!.if!
  expect(evaluate(expression, { 'github.ref': ref, 'inputs.skip-tag-check': skip })).toBe(expected)
})

it('skips installation and signing on a helper match and exports the original producer identifiers', () => {
  const helper = workflow('cua-helper-package-macos.yml')
  expect(helper.permissions).toEqual({ contents: 'read', actions: 'read' })
  const job = helper.jobs['package']!
  const select = job.steps.find(step => step.name === 'Find reusable CUA helper')!
  expect(select.run).toBe('node scripts/cua-helper/select-artifact.ts')
  expect(Boolean(evaluate(select.if!, {}))).toBe(false)
  expect(evaluate(select.if!, { 'inputs.reuse': true })).toBe(true)
  expect(select.env?.['CUA_BUILD_KEY']).toBe('${{ steps.build-inputs.outputs.build-key }}')
  const inputs = job.steps.find(step => step.name === 'Record CUA helper build inputs')!
  expect(inputs.run).toBe('node scripts/cua-helper/build-inputs.ts')
  expect(inputs.if).toBeUndefined()
  expect(job.steps.indexOf(inputs)).toBeLessThan(job.steps.indexOf(select))
  const expensive = job.steps.filter(step => step.uses === 'pnpm/action-setup@v5.0.0'
    || step.name === 'Install locked dependencies' || step.name === 'Build and verify notarized applications'
    || step.uses === 'actions/upload-artifact@v7.0.1')
  expect(expensive).toHaveLength(4)
  expect(job.steps.find(step => step.name === 'Install locked dependencies')?.run)
    .toBe('pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile')
  const build = job.steps.find(step => step.name === 'Build and verify notarized applications')!
  expect(build.run).toContain('node --import tsx/esm scripts/cua-helper/package.ts --out dist/cua-helper')
  expect(build.run).not.toContain('pnpm exec')
  for (const step of expensive) {
    expect(job.steps.indexOf(select)).toBeLessThan(job.steps.indexOf(step))
    expect(evaluate(step.if!, { 'steps.retained.outputs.artifact-id': '456' })).toBe(false)
    expect(evaluate(step.if!, { 'steps.retained.outputs.artifact-id': '' })).toBe(true)
  }
  expect(job.outputs).toMatchObject({
    'artifact-id': '${{ steps.retained.outputs.artifact-id || steps.upload.outputs.artifact-id }}',
    'run-id': '${{ steps.retained.outputs.run-id || github.run_id }}',
    'build-key': '${{ steps.build-inputs.outputs.build-key }}',
  })
})

it.each(['macos', 'windows'])('uploads an artifact named for the %s helper and its exact build', (platform) => {
  const steps = workflow(`cua-helper-package-${platform}.yml`).jobs['package']!.steps
  const upload = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  const build = platform === 'macos' ? '${{ steps.build-inputs.outputs.build-key }}' : '${{ steps.metadata.outputs.build-key }}'
  expect(upload?.with?.name).toBe([`cua-helper-${platform}`, '${{ github.run_id }}', '${{ github.run_attempt }}', build].join('-'))
})

it('downloads the selected producer artifact and verifies its build key before packing', () => {
  const publish = workflow('release-publish.yml')
  expect(publish.permissions).toEqual({ contents: 'read', actions: 'read' })
  const pack = publish.jobs['pack']!
  expect(pack.permissions).toEqual({ contents: 'read', actions: 'read' })
  const download = pack.steps.find(step => step.name === 'Download selected macOS CUA helper')!
  expect(download).toMatchObject({ uses: 'actions/download-artifact@v8.0.1', with: {
    'artifact-ids': '${{ needs.cua-helper-macos.outputs.artifact-id }}', 'run-id': '${{ needs.cua-helper-macos.outputs.run-id }}',
    'github-token': '${{ github.token }}', path: 'dist/cua-helper',
  } })
  expect(download.if).toBeUndefined()
  expect(download.with?.name).toBeUndefined()
  const stage = pack.steps.find(step => step.name === 'Stage verified macOS helper applications')!
  expect(stage.if).toBeUndefined()
  expect(stage.env).toEqual({ CUA_EXPECTED_BUILD_KEY: '${{ needs.cua-helper-macos.outputs.build-key }}' })
  expect(stage.run).toContain('scripts/cua-helper/stage.ts --from dist/cua-helper/extracted')
  expect(pack.steps.indexOf(stage)).toBeGreaterThan(pack.steps.indexOf(download))
  expect(pack.steps.indexOf(stage)).toBeLessThan(pack.steps.findIndex(step => step.name === 'Pack release tarballs'))
})

it('checks out the Actions run commit and exposes only the preset on the manual helper form', () => {
  const helper = workflow('cua-helper-package-macos.yml')
  const dispatch = helper.on['workflow_dispatch'] as { inputs: Record<string, unknown> }
  const called = helper.on['workflow_call'] as { inputs: Record<string, unknown> }
  expect(Object.keys(dispatch.inputs)).toEqual(['preset'])
  expect(called.inputs).toEqual({ reuse: { type: 'boolean', default: false },
    cua_macos_run_id: { type: 'string', default: '' }, preset: { type: 'string', default: 'production' } })
  const job = helper.jobs['package']!
  const checkout = job.steps.find(step => step.uses === 'actions/checkout@v7.0.1')!
  expect(checkout.with).toEqual({ 'persist-credentials': false, clean: true })
  expect(job.env).not.toHaveProperty('PACKAGE_SOURCE_REF')
  expect(JSON.stringify(helper)).not.toContain('source_ref')
  expect(workflow('release-publish.yml').jobs['cua-helper-macos']!.with).not.toHaveProperty('source_ref')
})

it.each([
  ['refs/heads/release-candidate', 'test', true, ''],
  ['refs/tags/dsh-v1.2.3', 'production', true, ''],
  ['refs/tags/dsh-v1.2.4', 'production', false, 'Release tag must match product version'],
  ['refs/heads/master', 'invalid', false, 'Invalid preset'],
  ['refs/pull/42/merge', 'test', false, 'Select a trusted repository branch or release tag'],
  ['', 'test', false, 'Select a trusted repository branch or release tag'],
] as const)('validates the run ref %s and preset %s before dependency installation', (ref, preset, accepted, diagnostic) => {
  const directory = mkdtempSync(join(tmpdir(), 'cua-workflow-ref-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  const job = workflow('cua-helper-package-macos.yml').jobs['package']!
  const validation = job.steps.find(step => step.name === 'Validate run ref and preset')!
  const source = /^node -e '([\s\S]+)'$/u.exec(validation.run!.trim())?.[1]
  expect(source).toBeDefined()
  const result = spawnSync(process.execPath, ['-e', source!], {
    cwd: directory, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, GITHUB_REF: ref, DSH_PACKAGING_PRESET: preset, PACKAGE_SOURCE_REF: 'refs/tags/dsh-v0.0.0' },
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(accepted ? 0 : 1)
  if (!accepted) expect(result.stderr).toContain(diagnostic)
  expect(job.steps.indexOf(validation)).toBeLessThan(job.steps.findIndex(step => step.name === 'Record CUA helper build inputs'))
})

it.each([
  [false, '', true],
  [true, '', true],
  [true, '456', false],
] as const)('builds for reuse=%s and selected artifact=%s only when required', (reuse, artifactId, build) => {
  const steps = workflow('cua-helper-package-macos.yml').jobs['package']!.steps
  const selection = steps.find(step => step.name === 'Find reusable CUA helper')!
  expect(Boolean(evaluate(selection.if!, reuse ? { 'inputs.reuse': true } : {}))).toBe(reuse)
  for (const step of steps.filter(step => step.uses === 'pnpm/action-setup@v5.0.0'
    || step.name === 'Install locked dependencies' || step.name === 'Build and verify notarized applications'
    || step.uses === 'actions/upload-artifact@v7.0.1')) {
    expect(evaluate(step.if!, { 'steps.retained.outputs.artifact-id': artifactId })).toBe(build)
  }
})
