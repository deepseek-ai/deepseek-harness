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
  jobs: Record<string, { name: string; 'runs-on': string; steps: Step[] }>
}

function workflow(file: string): Workflow {
  return load(readFileSync(resolve(root, '.github/workflows', file), 'utf8')) as Workflow
}

// This canonical-case corpus has matching Actions/JavaScript comparison results.
// This is not an Actions interpreter: string case-folding and general coercion differ.
// Missing context properties use the Actions empty-string value.
function evaluate(expression: string, context: Record<string, string | boolean>): unknown {
  const source = expression.trim().replace(/^\$\{\{|\}\}$/g, '')
    .replace(/\b(?:github|vars|runner)(?:\.[a-zA-Z_][a-zA-Z_0-9]*)+/g,
      key => JSON.stringify(context[key] ?? ''))
  return runInNewContext(source, { fromJSON: JSON.parse }, { timeout: 1000 }) as unknown
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
      expect(release.concurrency).toEqual({ group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': false })
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
          expect(job.steps[0]).toMatchObject({ uses: 'actions/checkout@v6', with: { clean: true, 'persist-credentials': false } })
          const cacheIndex = job.steps.findIndex(step => step.run?.includes('NODE_COMPILE_CACHE='))
          const pnpmIndex = job.steps.findIndex(step => step.uses?.startsWith('pnpm/') || /\bpnpm\b/.test(step.run ?? ''))
          expect(cacheIndex).toBeGreaterThan(0)
          expect(cacheIndex).toBeLessThan(pnpmIndex)
          expect(job.steps[cacheIndex]?.run).toContain('echo "NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache" >> "$GITHUB_ENV"')
          expect(job.steps[cacheIndex]?.run).toContain('echo "npm_config_devdir=${{ runner.temp }}/node-gyp" >> "$GITHUB_ENV"')
          expect(job.steps[cacheIndex]?.run).toContain('echo "TMPDIR=${{ runner.temp }}" >> "$GITHUB_ENV"')
          expect(job.steps.find(step => step.uses === 'pnpm/action-setup@v4')?.with?.dest)
            .toBe('${{ runner.temp }}/setup-pnpm-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}')
          expect(job.steps.find(step => step.name === 'Install (immutable)')?.run).toBe('pnpm install --frozen-lockfile')
        })
        it('uses the persistent store without remote cache reads or writes on self-hosted', () => {
          expect(job.steps.find(step => step.name === 'Configure pnpm store path')?.run).toContain('store_root="$HOME/.local/share/pnpm/store"')
          const caches = job.steps.filter(step => step.uses?.startsWith('actions/cache'))
          expect(caches.map(step => step.uses)).toEqual(['actions/cache/restore@v4'])
          for (const step of caches) {
            expect(evaluate(step.if!, { 'runner.environment': 'self-hosted' })).toBe(false)
            expect(evaluate(step.if!, { 'runner.environment': 'github-hosted' })).toBe(true)
          }
          const nodeSetup = job.steps.find(step => step.uses === 'actions/setup-node@v6')
          expect(nodeSetup?.with?.cache).toBeUndefined()
          expect(nodeSetup?.with?.['package-manager-cache']).toBe(false)
        })
        it('retains the dependency and pack verification commands', () => {
          const commands = job.steps.flatMap(step => step.run === undefined ? [] : [step.run])
          if (jobId === 'dependencies') {
            expect(commands).toContain('pnpm run verify-package-dependencies')
            expect(commands).toContain('pnpm run verify-npm-install-layout')
          } else {
            const family = file === 'release.yml' ? 'dsh' : 'vendor'
            const output = family === 'dsh' ? 'dist/npm' : 'dist/npm-vendor'
            expect(job.steps[0]?.with?.['fetch-depth']).toBe(0)
            expect(commands).toContain('pnpm run release:verify --family ' + family)
            expect(commands).toContain('pnpm run ' + (family === 'dsh' ? 'build:official' : 'build:lib:host'))
            expect(commands).toContain('pnpm run release:pack --family ' + family + ' --out ' + output + ' --concurrency 8')
            expect(commands).toContain('pnpm run release:verify-packed-install --family ' + family + ' --from ' + output
              + (family === 'dsh' ? ' --from dist/npm-vendor --from dist/npm-landlock' : ''))
            expect(job.steps.at(-1)).toMatchObject({ uses: 'actions/upload-artifact@v4', with: { path: output + '/*', 'retention-days': 7 } })
          }
          expect(JSON.stringify(job)).not.toMatch(/secrets\.|release:publish|npm-publish/)
        })
      })
    }
  })
}

it.each(['release-publish.yml', 'release-vendor-publish.yml'])('keeps %s manual and entirely hosted', (file) => {
  const publish = workflow(file)
  expect(publish.on).toEqual({ workflow_dispatch: null })
  for (const job of Object.values(publish.jobs)) expect(job['runs-on']).toBe(hosted)
})
