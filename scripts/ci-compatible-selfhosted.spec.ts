import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  name?: string
  uses?: string
  if?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

interface CompatibilityJob {
  'runs-on': string
  if: string
  env: Record<string, string>
  strategy: { 'fail-fast': boolean; matrix: { include: Array<{ node: string | number; name: string; runner: string; gate_concurrency: string }> } }
  steps: Step[]
}

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8')) as {
  jobs: { 'node-compat': CompatibilityJob; 'python-sdk': { 'runs-on': string } }
}
const job = workflow.jobs['node-compat']
const labels = ['self-hosted', 'linux', 'x64', 'vm-backup']

// This wiring check uses equal-typed, canonical-case fixtures. Actions compares
// strings case-insensitively; JavaScript does not. This is not an Actions evaluator.
function evaluate(expression: string, context: Record<string, unknown>): unknown {
  const body = expression.trim().slice(3, -2)
  return runInNewContext(body, {
    ...context, fromJSON: JSON.parse,
  }, { timeout: 1000 }) as unknown
}

function route(options: { mode?: string; author?: string; repository?: string; fork?: boolean; actor?: string } = {}): unknown {
  return evaluate(job['runs-on'], {
    vars: { DSH_CI_FAILOVER_LINUX: options.mode ?? 'selfhosted' },
    github: {
      repository: 'deepseek-harness/deepseek-harness',
      actor: options.actor ?? 'maintainer',
      event: { pull_request: {
        user: { login: options.author ?? 'maintainer' },
        head: { repo: { full_name: options.repository ?? 'deepseek-harness/deepseek-harness', fork: options.fork ?? false } },
      } },
    },
    matrix: { runner: 'ubuntu-latest' },
  })
}

describe('Node compatibility self-hosted routing', () => {
  it('uses the Linux pool only for opted-in repository-owned PRs', () => {
    expect(route()).toEqual(labels)
    for (const mode of ['', 'hosted', 'unexpected']) expect(route({ mode })).toBe('ubuntu-latest')
    expect(route({ author: 'dependabot[bot]', actor: 'maintainer' })).toBe('ubuntu-latest')
    expect(route({ repository: 'outsider/fork', fork: true })).toBe('ubuntu-latest')
    expect(route({ repository: 'outsider/fork', fork: false })).toBe('ubuntu-latest')
    expect(route({ fork: true })).toBe('ubuntu-latest')
    expect(route({ repository: '' })).toBe('ubuntu-latest')
  })

  it('preserves all three required version jobs and their concurrency', () => {
    expect(job.if).toBe("github.event_name == 'pull_request'")
    expect(job.strategy['fail-fast']).toBe(false)
    expect(job.strategy.matrix.include).toEqual([
      { node: '22.19', name: 'node 22.19', runner: 'ubuntu-latest', gate_concurrency: '1' },
      { node: '24.9', name: 'node 24.9', runner: 'ubuntu-latest', gate_concurrency: '1' },
      { node: 26, name: 'node 26', runner: 'ubuntu-latest', gate_concurrency: '1' },
    ])
    expect(job.env.DSH_GATE_CONCURRENCY).toBe('${{ matrix.gate_concurrency }}')
    expect(job.steps.map(step => step.run)).toContain('pnpm run check:node-compat')
    expect(job.steps.map(step => step.run)).toContain('pnpm exec vitest run packages/boot/app-boot/tests/loader-shape.compat.spec.ts')
    expect(workflow.jobs['python-sdk']['runs-on']).toBe('ubuntu-latest')
  })

  it('isolates version installs and enables hosted package caching only on hosted runners', () => {
    const setup = job.steps.find(step => step.uses === 'actions/setup-node@v6')!
    expect(setup.env).toEqual({
      NODE_OPTIONS: "${{ runner.environment == 'self-hosted' && '--import=./scripts/ci-compatible-toolcache.mjs' || '' }}",
    })
    expect(setup.with?.['node-version']).toBe('${{ matrix.node }}')
    expect(setup.with?.['package-manager-cache']).toBe(false)
    for (const [environment, cache] of [['github-hosted', 'pnpm'], ['self-hosted', '']]) {
      const context = { runner: { environment, temp: '/runner/temp', tool_cache: '/runner/toolcache' } }
      expect(evaluate(setup.with?.cache as string, context)).toBe(cache)
      expect(evaluate(setup.env!.NODE_OPTIONS!, context)).toBe(
        environment === 'self-hosted' ? '--import=./scripts/ci-compatible-toolcache.mjs' : '',
      )
    }
    expect(job.steps[0]?.with).toEqual({ 'persist-credentials': false })
    expect(job.steps.some(step => step.uses?.startsWith('actions/cache/'))).toBe(false)
  })

  it('overrides runner exports inside setup-node without affecting later Node processes', () => {
    const setup = job.steps.find(step => step.uses === 'actions/setup-node@v6')!
    const nodeOptions = evaluate(setup.env!.NODE_OPTIONS!, { runner: { environment: 'self-hosted' } }) as string
    const root = mkdtempSync(join(tmpdir(), 'ci-compatible preload-'))
    try {
      const env = { PATH: process.env.PATH, RUNNER_TEMP: root, RUNNER_TOOL_CACHE: join(root, 'persistent') }
      const probe = (options: Record<string, string | undefined>) => {
        const child = spawnSync(process.execPath, ['-p', 'process.env.RUNNER_TOOL_CACHE'], {
          cwd: resolve(import.meta.dirname, '..'), env: options, encoding: 'utf8', timeout: 10_000,
        })
        expect(child.error).toBeUndefined()
        expect(child.signal).toBeNull()
        return child
      }
      const setupChild = probe({ ...env, NODE_OPTIONS: nodeOptions })
      expect(setupChild.status, setupChild.stderr).toBe(0)
      expect(setupChild.stdout.trim()).toBe(join(root, 'node-compat-toolcache'))
      const normalChild = probe(env)
      expect(normalChild.status, normalChild.stderr).toBe(0)
      expect(normalChild.stdout.trim()).toBe(env.RUNNER_TOOL_CACHE)
      const missingTemp = probe({ ...env, RUNNER_TEMP: undefined, NODE_OPTIONS: nodeOptions })
      expect(missingTemp.status).not.toBe(0)
      expect(missingTemp.stderr).toContain('requires an absolute RUNNER_TEMP')
      expect(job.env).not.toHaveProperty('NODE_OPTIONS')
      expect(job.steps.filter(step => step.env?.NODE_OPTIONS)).toEqual([setup])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a Node executable outside its runner temporary installation', () => {
    const step = job.steps.find(candidate => candidate.name === 'Verify isolated Node installation')!
    expect(step.if).toBe("runner.environment == 'self-hosted'")
    for (const [executable, status] of [
      ['/runner temp/node-compat-toolcache/node/24.9.0/x64/bin/node', 0],
      ['/shared/toolcache/node/24.9.0/x64/bin/node', 1],
      ['/runner temp/node-compat-toolcache-other/node', 1],
    ] as const) {
      const child = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', 'node() { printf "%s" "$TEST_EXECUTABLE"; }; ' + step.run!], {
        env: { PATH: process.env.PATH, RUNNER_TEMP: '/runner temp', TEST_EXECUTABLE: executable }, encoding: 'utf8', timeout: 10_000,
      })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status, child.stderr).toBe(status)
    }
  })

  it.skipIf(process.platform === 'win32')('configures generated caches before pnpm without changing HOME or global links', () => {
    const index = job.steps.findIndex(step => step.name === 'Isolate compatibility caches')
    const step = job.steps[index]!
    expect(index).toBeGreaterThan(0)
    expect(index).toBeLessThan(job.steps.findIndex(candidate => candidate.uses === 'pnpm/action-setup@v4'))
    expect(step.if).toBe("runner.environment == 'self-hosted'")
    const root = mkdtempSync(join(tmpdir(), 'ci-compatible-selfhosted-'))
    try {
      const outputs = ['runner-a', 'runner-b'].map((runner) => {
        const envFile = join(root, runner + '.env')
        const temp = join(root, runner)
        const child = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', step.run!], {
          env: { PATH: process.env.PATH, HOME: join(root, 'shared home'), RUNNER_TEMP: temp, GITHUB_ENV: envFile },
          encoding: 'utf8', timeout: 10_000,
        })
        expect(child.error).toBeUndefined()
        expect(child.signal).toBeNull()
        expect(child.status, child.stderr).toBe(0)
        const output = readFileSync(envFile, 'utf8')
        expect(output).toBe([
          'NODE_COMPILE_CACHE=' + temp + '/node-compile-cache',
          'npm_config_devdir=' + temp + '/node-gyp',
          'PNPM_CONFIG_STORE_DIR=' + join(root, 'shared home') + '/.local/share/pnpm/store',
          '',
        ].join('\n'))
        return output
      })
      expect(outputs[0]).not.toBe(outputs[1])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
