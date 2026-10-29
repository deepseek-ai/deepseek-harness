/** Release rehearsal routing and persistent-runner isolation, without executing release builds. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const repository = 'deepseek-harness/deepseek-harness'
const selfhosted = ['self-hosted', 'linux', 'x64', 'vm-backup']
const hosted = 'ubuntu-24.04'

interface Step {
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
    .replace(/\b(?:github|vars|runner|inputs|needs)(?:\.[a-zA-Z_][a-zA-Z_0-9-]*)+/g,
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
it('keeps DSH publication manual with hosted npm jobs and an explicit signed-helper producer', () => {
  const publish = workflow('release-publish.yml')
  expect(Object.keys(publish.on)).toEqual(['workflow_dispatch'])
  for (const [name, job] of Object.entries(publish.jobs)) {
    if (name === 'cua-helper') {
      expect(job).toEqual({
        if: "(startsWith(github.ref, 'refs/tags/dsh-v') || inputs.skip-tag-check) && inputs.cua_run_id == '' && inputs.cua_run_attempt == ''",
        uses: './.github/workflows/cua-helper-package.yml',
        with: { source_ref: '${{ github.ref }}', preset: 'production' },
      })
    } else expect(job['runs-on']).toBe(hosted)
  }
})
it.each([
  ['refs/tags/dsh-v0.2.1-rc.4', false, '', '', true],
  ['refs/heads/master', false, '', '', false],
  ['refs/heads/master', true, '', '', true],
  ['refs/tags/dsh-v0.2.1-rc.4', false, '123', '', false],
  ['refs/heads/master', true, '123', '2', false],
  ['refs/tags/dsh-v0.2.1-rc.4', false, '', '2', false],
] as const)('selects the helper producer for ref %s, skip=%s, run=%s, attempt=%s', (ref, skip, runId, attempt, expected) => {
  const expression = workflow('release-publish.yml').jobs['cua-helper']!.if!
  expect(evaluate(expression, { 'github.ref': ref, 'inputs.skip-tag-check': skip,
    'inputs.cua_run_id': runId, 'inputs.cua_run_attempt': attempt })).toBe(expected)
})

it.each([
  ['success', '', '', false, true],
  ['failure', '', '', false, false],
  ['failure', '123', '', false, false],
  ['cancelled', '', '', false, false],
  ['skipped', '', '', false, false],
  ['skipped', '123', '', false, true],
  ['skipped', '123', '2', false, true],
  ['skipped', '', '2', false, true],
  ['skipped', '123', '2', true, false],
] as const)('gates npm packing with helper=%s, run=%s, attempt=%s, cancelled=%s', (result, runId, attempt, cancelled, expected) => {
  const pack = workflow('release-publish.yml').jobs['pack']!
  expect(pack.needs).toBe('cua-helper')
  expect(evaluate(pack.if!, { 'needs.cua-helper.result': result,
    'inputs.cua_run_id': runId, 'inputs.cua_run_attempt': attempt, cancelled })).toBe(expected)
})

it('validates retained attempts before downloading exactly one artifact with read-only Actions access', () => {
  const publish = workflow('release-publish.yml')
  expect(publish.permissions).toEqual({ contents: 'read' })
  const pack = publish.jobs['pack']!
  expect(pack.permissions).toEqual({ contents: 'read', actions: 'read' })
  const select = pack.steps.find(step => step.name === 'Select retained CUA helper')!
  const retained = pack.steps.find(step => step.name === 'Download retained CUA helper')!
  const fresh = pack.steps.find(step => step.name === 'Download freshly built CUA helper')!
  expect(select.run).toBe('pnpm exec tsx scripts/cua-helper/select-artifact.ts')
  expect(pack.steps.indexOf(select)).toBeLessThan(pack.steps.indexOf(retained))
  expect(retained).toMatchObject({ uses: 'actions/download-artifact@v8.0.1', with: {
    'artifact-ids': '${{ steps.retained-cua.outputs.artifact-id }}', 'run-id': '${{ inputs.cua_run_id }}',
    'github-token': '${{ github.token }}', path: 'dist/cua-helper',
  } })
  expect(retained.with?.name).toBeUndefined()
  expect(fresh.with).toEqual({ name: '${{ needs.cua-helper.outputs.artifact }}', path: 'dist/cua-helper' })
  for (const [runId, attempt, reuse] of [['', '', false], ['123', '', true], ['123', '2', true], ['', '2', true]] as const) {
    const context = { 'inputs.cua_run_id': runId, 'inputs.cua_run_attempt': attempt }
    expect(evaluate(select.if!, context)).toBe(reuse)
    expect(evaluate(retained.if!, context)).toBe(reuse)
    expect(evaluate(fresh.if!, context)).toBe(!reuse)
  }
  const stage = pack.steps.find(step => step.name === 'Stage verified native helper applications')!
  expect(stage.if).toBeUndefined()
  expect(stage.run).toContain('scripts/cua-helper/stage.ts --from dist/cua-helper/extracted')
  expect(pack.steps.indexOf(stage)).toBeGreaterThan(pack.steps.indexOf(retained))
  expect(pack.steps.indexOf(stage)).toBeGreaterThan(pack.steps.indexOf(fresh))
  expect(pack.steps.indexOf(stage)).toBeLessThan(pack.steps.findIndex(step => step.name === 'Pack release tarballs'))
})
