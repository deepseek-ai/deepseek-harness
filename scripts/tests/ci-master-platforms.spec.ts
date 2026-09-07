/** Scheduling policy for post-merge native runtime carriers and Wine. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { gatesForMode } from '../run-gates.ts'

const root = resolve(import.meta.dirname, '../..')
const masterPush = "github.event_name == 'push' && github.ref == 'refs/heads/master'"
const runtimeBuilder = './.github/workflows/build-exe-for-python-sdk.yml'

interface Job {
  if?: string | boolean
  uses?: string
  needs?: string[]
  with?: Record<string, unknown>
  secrets?: Record<string, string>
  steps?: Array<{ name?: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown> }>
  'runs-on'?: string | string[]
  'continue-on-error'?: boolean
}

interface Workflow {
  on: Record<string, unknown>
  jobs: Record<string, Job>
  concurrency?: Record<string, unknown>
}

function workflow(name: string): Workflow {
  return load(readFileSync(resolve(root, '.github/workflows', name), 'utf8')) as Workflow
}

function commands(job: Job): string[] {
  return (job.steps ?? []).flatMap(step => step.run ? [step.run] : [])
}

describe('master-only platform scheduling', () => {
  it('keeps only Linux and Windows x64 runtimes in required PR CI', () => {
    const pr = workflow('ci.yml')
    expect(Object.keys(pr.on)).toEqual(['pull_request'])
    expect(pr.jobs['python-runtime']).toMatchObject({
      if: "github.event_name == 'pull_request'",
      uses: runtimeBuilder,
      with: { ci: true, targets: 'node24-linux-x64,node24-win-x64' },
    })
    expect(pr.jobs.windows).toBeUndefined()
    expect(JSON.stringify(pr.jobs)).not.toMatch(/wine-windows-gates|check:windows-wine/)
    const aggregate = pr.jobs['all-checks-passed']!
    expect(aggregate.needs).toContain('python-runtime')
    expect(aggregate.needs).not.toContain('windows')
    expect(aggregate.needs!.every(id => id in pr.jobs)).toBe(true)
    expect(aggregate.if).toBe("always() && github.event_name == 'pull_request'")
    expect(aggregate.steps).toContainEqual(expect.objectContaining({
      if: "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')",
    }))
  })

  it('runs all three deferred carriers on master pushes with fail-loud API credentials', () => {
    const master = workflow('ci-master.yml')
    expect(master.on.push).toEqual({ branches: ['master'] })
    expect(Object.keys(master.on).sort()).toEqual(['push', 'workflow_dispatch'])
    const runtime = master.jobs['python-runtime']!
    expect(runtime).toMatchObject({
      if: masterPush,
      uses: runtimeBuilder,
      with: { ci: true, targets: 'node24-linux-arm64,node24-macos-arm64,node24-macos-x64' },
      secrets: { DEEPSEEK_API_KEY_EXTERNAL: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' },
    })
    expect(runtime.needs).toBeUndefined()
    expect(runtime['continue-on-error']).toBeUndefined()
    const builder = workflow('build-exe-for-python-sdk.yml')
    expect(builder.concurrency?.['cancel-in-progress']).toBe(
      "${{ github.event_name != 'push' || github.ref != 'refs/heads/master' }}",
    )
    const build = builder.jobs.build!
    const preflight = build.steps!.find(step => step.name === 'Preflight installed-wheel real API test (POSIX)')!
    expect(preflight.if).toContain('inputs.ci')
    expect(preflight.if).toContain("github.event_name != 'pull_request'")
    expect(preflight.if).toContain('github.event.pull_request.head.repo.fork')
    expect(preflight.if).toContain("github.event.pull_request.user.login == 'dependabot[bot]'")
    expect(preflight.run).toContain('exit 1')
  })

  it('runs Wine once on hosted master CI and seeds its own apt cache', () => {
    const master = workflow('ci-master.yml')
    const wine = master.jobs.windows!
    expect(wine).toMatchObject({ if: masterPush, 'runs-on': 'ubuntu-latest' })
    expect(wine.needs).toBeUndefined()
    expect(wine['continue-on-error']).toBeUndefined()
    expect(master.jobs['wine-apt-cache']).toBeUndefined()
    expect(Object.values(master.jobs).flatMap(commands).filter(command => command.includes('wine-windows-gates.sh')))
      .toEqual(['bash scripts/wine-windows-gates.sh'])
    expect(wine.steps).toContainEqual(expect.objectContaining({
      uses: 'actions/cache@v4', with: { path: '~/wine-debs', key: '${{ steps.wine-cache-key.outputs.key }}' },
    }))
    expect(commands(wine).join('\n')).toContain('--download-only wine')
    expect(wine.steps).toContainEqual(expect.objectContaining({ name: 'Shut down wineserver', if: 'always()' }))
    // Graph construction needs a pnpm entrypoint but never launches it.
    const previous = process.env.npm_execpath
    process.env.npm_execpath = '/test/pnpm.cjs'
    try {
      for (const mode of ['ci-linux-primary', 'ci-windows-complete'] as const) {
        expect(gatesForMode(mode).map(gate => gate.displayCommand).join('\n')).not.toMatch(/wine/i)
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
      else process.env.npm_execpath = previous
    }
    expect(process.env.npm_execpath).toBe(previous)
  })

  it('retains the complete release matrix independently of CI scheduling', () => {
    const release = workflow('python-release.yml')
    const calls = Object.values(release.jobs).filter(job => job.uses === runtimeBuilder)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.with).toMatchObject({
      release: true,
      targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64',
    })
  })
})
