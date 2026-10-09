import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

function evaluateRunsOn(selector: unknown, context: Record<string, unknown>): unknown {
  if (typeof selector !== 'string') throw new TypeError('Runner selector must be a string')
  return runInNewContext(selector.trim().slice(3, -2), context, { timeout: 1000 })
}

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = /^\$\{\{ runner\.temp \}\}\/setup-pnpm-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/
const nativeWindowsPnpmDestination = '${{ runner.temp }}/setup-pnpm-js-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}'

describe('CI workflow', () => {
  it('keeps at most ten worker jobs active while runtime targets follow the SDK suite', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    const compatibility = workflowJob(ci, 'node-compat')
    const runtime = workflowJob(ci, 'python-runtime')
    if (!isRecord(ci.jobs) || !isRecord(compatibility.strategy) || !isRecord(runtime.with)) {
      throw new TypeError('CI must define jobs, compatibility scheduling, and runtime inputs')
    }
    const compatibilityLimit = compatibility.strategy['max-parallel']
    const targets = runtime.with.targets
    if (typeof compatibilityLimit !== 'number' || typeof targets !== 'string') {
      throw new TypeError('CI requires a numeric compatibility limit and explicit runtime targets')
    }
    expect(Number.isInteger(compatibilityLimit)).toBe(true)
    expect(compatibilityLimit).toBeGreaterThan(0)
    expect(compatibility.strategy).toMatchObject({
      'fail-fast': false,
      matrix: { include: [{ node: '22.19' }, { node: '24.9' }, { node: 26 }] },
    })
    expect(workflowJob(ci, 'all-checks-passed').needs).toContain('node-compat')
    const ordinaryJobs = Object.entries(ci.jobs)
      .filter(([name]) => !['node-compat', 'python-runtime', 'all-checks-passed'].includes(name))
    for (const [name, job] of ordinaryJobs) {
      if (!isRecord(job)) throw new TypeError(`${name} must define a job`)
      expect(job).not.toHaveProperty('strategy')
      expect(job).not.toHaveProperty('uses')
    }
    expect(ordinaryJobs.map(([name]) => name)).toContain('python-sdk')
    expect(runtime.needs).toBe('python-sdk')
    expect(runtime.strategy).toBeUndefined()
    expect(runtime.with).toMatchObject({ targets: 'node24-linux-x64,node24-win-x64' })
    expect(runtime.uses).toBe('./.github/workflows/build-exe-for-python-sdk.yml')

    const builder = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    if (!isRecord(builder.jobs)) throw new TypeError('Python runtime builder must define jobs')
    expect(Object.keys(builder.jobs).sort()).toEqual(['build', 'plan', 'sdk-wheel'])
    const plan = workflowJob(builder, 'plan')
    const wheel = workflowJob(builder, 'sdk-wheel')
    const build = workflowJob(builder, 'build')
    expect(plan.needs).toBeUndefined()
    expect(plan.strategy).toBeUndefined()
    expect(plan.uses).toBeUndefined()
    expect(wheel.needs).toBe('plan')
    expect(wheel.strategy).toBeUndefined()
    expect(wheel.uses).toBeUndefined()
    expect(build.needs).toEqual(['plan', 'sdk-wheel'])
    expect(build.uses).toBeUndefined()
    if (!isRecord(build.strategy)) throw new TypeError('Python runtime build must define its target matrix')
    expect(build.strategy.matrix).toEqual({ include: '${{ fromJSON(needs.plan.outputs.matrix) }}' })

    const beforeSdk = ordinaryJobs.length + compatibilityLimit
    const afterSdk = ordinaryJobs.length - 1 + compatibilityLimit + Math.max(1, targets.split(',').length)
    expect(beforeSdk).toBeLessThanOrEqual(10)
    expect(afterSdk).toBeLessThanOrEqual(10)
  })

  it('retains aggregate diagnostics in required builds and protected publication', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    for (const [name, command] of [
      ['node-24-consumers', 'pnpm run check:ci:consumers'],
      ['windows-build', 'pnpm run check:ci:windows-blocking'],
    ] as const) {
      const job = workflowJob(ci, name)
      expect(job.steps).toContainEqual(expect.objectContaining({ run: command }))
    }
    for (const [file, command] of [
      ['release-publish.yml', 'pnpm run build:official'],
      ['release-vendor-publish.yml', 'pnpm run build:lib:host'],
    ] as const) {
      expect(workflowJob(loadWorkflow('.github/workflows/' + file), 'pack').steps)
        .toContainEqual(expect.objectContaining({ name: 'Build', run: command }))
    }
    const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(scripts.scripts['build:lib:host']).toContain('tsc -b tsconfig.host.json')
    expect(scripts.scripts['build:lib:client']).toContain('tsc -b tsconfig.client.json')
    expect(scripts.scripts.typecheck).toBe('npm run build:lib:host && npm run typecheck:contracts-ready')
  })

  it('selects artifact builds only for PR release and API rehearsals', () => {
    const official = "${{ github.event_name == 'pull_request' && 'pnpm run build --artifacts-only --profile official' || 'pnpm run build:official' }}"
    const vendor = "${{ github.event_name == 'pull_request' && 'pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries' || 'pnpm run build:lib:host' }}"
    for (const [file, jobName, expected] of [
      ['release.yml', 'pack', official],
      ['release-vendor.yml', 'pack', vendor],
      ['e2e.yml', 'e2e', official],
    ] as const) {
      const job = workflowJob(loadWorkflow('.github/workflows/' + file), jobName)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      const step = job.steps.filter(isRecord).find(candidate => typeof candidate.run === 'string'
        && (candidate.run.includes('--artifacts-only') || candidate.run.includes('host-libraries')))
      expect(step?.run).toBe(expected)
      for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
        const expression = expected.slice('${{ '.length, -' }}'.length)
        const selected: unknown = runInNewContext(expression, { github: { event_name: event } }, { timeout: 1000 })
        expect(selected).toBe(event === 'pull_request'
          ? file === 'release-vendor.yml'
            ? 'pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries'
            : 'pnpm run build --artifacts-only --profile official'
          : file === 'release-vendor.yml' ? 'pnpm run build:lib:host' : 'pnpm run build:official')
      }
    }
  })

  it('selects PR artifact compilation inside the Python executable builder', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml'), 'build')
    if (!Array.isArray(job.steps)) throw new TypeError('Python runtime builder must define steps')
    const steps = job.steps.filter(isRecord)
    const execute = steps.find(step => step.name === 'Build single-exe')
    expect(steps.some(step => step.run === 'pnpm run build --artifacts-only')).toBe(false)
    expect(execute).toMatchObject({
      env: { DSH_BUILD_CLIENT_PROFILE: 'official' },
    })
    if (typeof execute?.run !== 'string') throw new TypeError('Python executable builder must define a command')
    const expression = [...execute.run.matchAll(/\$\{\{ ([^{}]+) \}\}/g)]
      .map(match => match[1]).find(value => value?.startsWith('inputs.ci'))
    expect(expression).toBe("inputs.ci && github.event_name == 'pull_request' && '--artifacts-only' || ''")
    if (expression === undefined) throw new TypeError('Python executable builder must select its build mode')
    for (const ci of [false, true]) {
      for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
        const context = { inputs: { ci }, github: { event_name: event } }
        const selected: unknown = runInNewContext(expression, context, { timeout: 1000 })
        expect(selected).toBe(ci && event === 'pull_request' ? '--artifacts-only' : '')
      }
    }
  })

  it('prepares confinement before Node compatibility smokes', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-compat')
    if (!Array.isArray(job.steps)) throw new TypeError('Node compatibility job must define steps')
    const steps = job.steps.filter(isRecord)
    const preparation = steps.findIndex(step => step.run === 'bash scripts/prepare-ci-bubblewrap.sh')
    const smoke = steps.findIndex(step => step.run === 'pnpm run check:node-compat')
    expect(preparation).toBeGreaterThanOrEqual(0)
    expect(smoke).toBeGreaterThan(preparation)
    expect(steps[preparation]).not.toHaveProperty('continue-on-error', true)
  })

  it.each(['ci.yml', 'ci-master.yml', 'e2e.yml', 'release.yml', 'release-vendor.yml'])(
    '%s cancels superseded validation runs without crossing workflow or ref boundaries', (name) => {
      const workflow = loadWorkflow('.github/workflows/' + name)
      expect(workflow.concurrency).toEqual({
        group: '${{ github.workflow }}-${{ github.ref }}',
        'cancel-in-progress': true,
      })
    },
  )

  it('cancels reusable CI builds without cancelling release-owned builds', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    expect(workflow.concurrency).toEqual({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': '${{ !inputs.release }}',
    })
  })

  it('does not cancel protected publication or deployment transactions', () => {
    for (const name of ['release-publish.yml', 'release-vendor-publish.yml']) {
      const publish = workflowJob(loadWorkflow('.github/workflows/' + name), 'publish')
      expect(publish.concurrency).toMatchObject({ 'cancel-in-progress': false })
    }
    for (const name of ['python-release.yml', 'node-addon-system-release.yml', 'docs-pages.yml']) {
      expect(loadWorkflow('.github/workflows/' + name).concurrency).toMatchObject({ 'cancel-in-progress': false })
    }
  })

  it('skips coverage-history uploads on cancellation but retains Wine cleanup', () => {
    const coverage = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'windows-coverage')
    const wine = workflowJob(loadWorkflow('.github/workflows/ci-master.yml'), 'windows')
    expect(coverage.steps).toContainEqual(expect.objectContaining({
      name: 'Save coverage duration history', if: '${{ !cancelled() }}',
    }))
    expect(wine.steps).toContainEqual(expect.objectContaining({ name: 'Shut down wineserver', if: 'always()' }))
  })

  it.each([
    ['node-24-coverage', 'Linux', 'LINUX', 'pnpm run check:ci:coverage'],
    ['windows-coverage', 'Windows', 'WINDOWS', 'pnpm run check:ci:coverage'],
  ])('reuses %s coverage timings only within its platform and runner pool', (jobName, platform, variable, command) => {
    const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), jobName)
    if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
    const steps = job.steps.filter(isRecord)
    const checkout = steps.findIndex(step => step.uses === 'actions/checkout@v7.0.1')
    const restore = steps.findIndex(step => step.name === 'Restore coverage duration history')
    const coverage = steps.findIndex(step => step.run === command)
    const save = steps.findIndex(step => step.name === 'Save coverage duration history')
    const prefix = `coverage-times-${platform}-\${{ runner.environment }}-\${{ vars.DSH_CI_FAILOVER_${variable} || 'enterprise' }}-`
    const key = prefix + '${{ github.run_id }}-${{ github.run_attempt }}'
    expect(checkout).toBeGreaterThanOrEqual(0)
    expect(restore).toBeGreaterThan(checkout)
    expect(coverage).toBeGreaterThan(restore)
    expect(save).toBeGreaterThan(coverage)
    expect(steps[restore]).toMatchObject({
      uses: 'actions/cache/restore@v6.1.0',
      with: { path: '.coverage-times.json', key, 'restore-keys': `${prefix}\n` },
    })
    expect(steps[save]).toMatchObject({
      uses: 'actions/cache/save@v6.1.0',
      if: '${{ !cancelled() }}',
      with: { path: '.coverage-times.json', key },
    })
  })

  it('isolates every pnpm action setup destination per runner', () => {
    const files = ['.github/workflows/ci.yml', '.github/workflows/ci-master.yml']
    const setups: Array<{ jobName: string; step: unknown }> = []
    for (const file of files) {
      const workflow: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'))
      if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job) || !Array.isArray(job.steps)) continue
        for (const step of job.steps) {
          if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
          setups.push({ jobName, step })
        }
      }
    }

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      const stepDest = (step as { with?: { dest?: unknown } }).with?.dest
      if (jobName.startsWith('windows-')) {
        expect(stepDest, `${jobName} must use the native Windows pnpm destination`).toBe(nativeWindowsPnpmDestination)
        expect(step).not.toMatchObject({ with: { standalone: true } })
      } else {
        expect(typeof stepDest, `${jobName} must use a runner-and-run-private pnpm destination`).toBe('string')
        expect(stepDest as string).toMatch(runnerPrivatePnpmDestination)
      }
    }
  })

  it.each(['node-24', 'node-24-coverage', 'node-24-consumers'])(
    '%s keeps tool and fixture temporary files under runner cleanup',
    (jobName) => {
      const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), jobName)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      expect(job.steps[0]).toEqual({
        name: 'Use runner-owned temporary storage',
        run: [
          'echo "TMPDIR=${{ runner.temp }}" >> "$GITHUB_ENV"',
          ...(jobName === 'node-24-consumers'
            ? ['echo "PLAYWRIGHT_BROWSERS_PATH=${RUNNER_TEMP%/*}/ms-playwright" >> "$GITHUB_ENV"']
            : []),
          '',
        ].join('\n'),
      })
      if (jobName === 'node-24-consumers') {
        const browserCache: unknown = job.steps.find(step => isRecord(step) && isRecord(step.with)
          && step.with.path === '${{ env.PLAYWRIGHT_BROWSERS_PATH }}')
        expect(browserCache).toMatchObject({ uses: 'actions/cache/restore@v6.1.0' })
      }
      const store: unknown = job.steps.find(step => isRecord(step) && step.name === 'Configure pnpm store path')
      expect(store).toMatchObject({
        run: [
          'store_root="$HOME/.local/share/pnpm/store"',
          'echo "PNPM_CONFIG_STORE_DIR=$store_root" >> "$GITHUB_ENV"',
          'store_path=$(PNPM_CONFIG_STORE_DIR="$store_root" pnpm store path --silent)',
          'echo "path=$store_path" >> "$GITHUB_OUTPUT"',
          '',
        ].join('\n'),
      })
      for (const step of job.steps) {
        if (isRecord(step) && isRecord(step.env)) {
          expect(step.env.TMPDIR).toBeUndefined()
          expect(step.env.npm_config_cache).toBeUndefined()
        }
      }
    },
  )

  it('isolates the python SDK exe pnpm setup destination per job', () => {
    const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/build-exe-for-python-sdk.yml'), 'utf8'))
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('build-exe-for-python-sdk.yml must define jobs')
    const setups: Array<{ step: unknown }> = []
    for (const job of Object.values(workflow.jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue
      for (const step of job.steps) {
        if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
        setups.push({ step })
      }
    }
    expect(setups.length).toBeGreaterThan(0)
    for (const { step } of setups) {
      expect(step).toMatchObject({
        with: { dest: nativeWindowsPnpmDestination },
      })
    }
  })

  it('keeps split native Windows PR jobs with failover, plus a master-only standby', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const masterWorkflow = loadWorkflow('.github/workflows/ci-master.yml')
    if (!isRecord(workflow.jobs)
      || !isRecord(workflow.jobs['windows-build'])
      || !isRecord(workflow.jobs['windows-coverage'])
      || !isRecord(workflow.jobs['windows-native-tests'])
      || !isRecord(workflow.jobs['node-24'])
      || !isRecord(workflow.jobs['node-24-coverage'])
      || !isRecord(workflow.jobs['node-24-bench'])
      || !isRecord(workflow.jobs['node-24-consumers'])
      || !isRecord(workflow.jobs['node-compat'])
      || !isRecord(workflow.jobs['all-checks-passed'])
      || !isRecord(masterWorkflow.jobs)
      || !isRecord(masterWorkflow.jobs['serial-windows'])) {
      throw new TypeError('CI workflow must define windows-build, windows-coverage, windows-native-tests, node-24, node-24-coverage, node-24-bench, node-24-consumers, node-compat, and all-checks-passed; ci-master must define serial-windows')
    }

    const windowsBuild = workflow.jobs['windows-build']
    const windowsCoverage = workflow.jobs['windows-coverage']
    const windowsNativeTests = workflow.jobs['windows-native-tests']
    const serialWindows = masterWorkflow.jobs['serial-windows']
    const node24 = workflow.jobs['node-24']
    const node24Coverage = workflow.jobs['node-24-coverage']
    const node24Bench = workflow.jobs['node-24-bench']
    const node24Consumers = workflow.jobs['node-24-consumers']
    const nodeCompat = workflow.jobs['node-compat']
    const aggregate = workflow.jobs['all-checks-passed']
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define needs')
    }
    // The split native jobs all resolve their pool through the Windows switch.
    for (const [jobName, job] of [['windows-build', windowsBuild], ['windows-coverage', windowsCoverage], ['windows-native-tests', windowsNativeTests]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Windows failover switch`).toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(job['runs-on'], `${jobName} runs-on must not use the Linux failover switch`).not.toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on']).toContain('self-hosted')
      expect(job['runs-on']).toContain('dsh-win-ci')
      expect(job['runs-on']).toContain('dsh-windows-2025-16core')
      const cores = jobName === 'windows-native-tests' ? 2 : 16
      expect(evaluateRunsOn(job['runs-on'], { vars: { DSH_CI_FAILOVER_WINDOWS: 'blacksmith' } }))
        .toBe(`blacksmith-${cores}vcpu-windows-2025`)
      expect(job.if).toBe("github.event_name == 'pull_request'")
    }

    // windows-build runs the blocking build/site pair.
    expect(windowsBuild.name).toBe('windows node 24 / build & observational')
    const buildSteps = windowsBuild.steps as unknown[]
    const buildCommands = buildSteps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    expect(buildCommands.map(step => step.run)).toContain('pnpm run check:ci:windows-blocking')

    // Native Windows installs branch on the workspace filesystem:
    // clone (ReFS block clone) only on ReFS, plain install elsewhere. This
    // keeps the TS6231 store-path leak (see the Windows ReFS store note) out
    // of the self-hosted pool without forcing clone onto hosted NTFS, which
    // rejects copy-on-write. The branch must stay, or a hosted fallback would
    // fail installs with ERR_PNPM_LINKING_FAILED.
    for (const [jobName, job] of [['windows-build', windowsBuild], ['windows-coverage', windowsCoverage], ['windows-native-tests', windowsNativeTests]] as const) {
      const steps = job.steps as unknown[]
      const install = steps.find((step): step is Record<string, unknown> & { run: string } => (
        isRecord(step) && step.name === 'Install (immutable)' && typeof step.run === 'string'
      ))
      expect(install, `${jobName} must define the filesystem-branched install`).toBeDefined()
      expect(install!.run).toContain("$fs -eq 'ReFS'")
      expect(install!.run).toContain('--package-import-method=clone')
      expect(install!.run).toContain('corepack pnpm install')
      // The else branch must keep the plain hosted install as a distinct line
      // (not the corepack clone line, which contains the same substring);
      // dropping it or making both branches clone would force clone onto
      // NTFS, which rejects copy-on-write (ERR_PNPM_LINKING_FAILED). The
      // YAML folded block keeps the first statement on line 1 and folds the
      // rest with leading two-space indents.
      const installLines = install!.run.split('\n').map(line => line.trim())
      expect(installLines).toContain('} else {')
      expect(installLines.some(line => line === 'pnpm install --frozen-lockfile'), `${jobName} else branch must keep the plain hosted install`).toBe(true)
      // The ReFS branch must not use the interpolated empty-flag form, which
      // passes a stray "" positional argument to pnpm.
      expect(install!.run).not.toContain('$cloneFlag')
    }

    expect(windowsCoverage.name).toBe('windows node 24 / coverage')
    expect(windowsCoverage.env).toMatchObject({ DSH_COVERAGE_PARTITIONS: "${{ vars.DSH_CI_FAILOVER_WINDOWS == 'selfhosted' && github.event.pull_request.user.login != 'dependabot[bot]' && '4' || '' }}" })
    const coverageSteps = windowsCoverage.steps as unknown[]
    const coverageCommands = coverageSteps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    expect(coverageCommands.map(step => step.run)).toContain('pnpm run check:ci:coverage')
    // Windows coverage runs zero-build like the Linux lane: workspace imports
    // resolve to src through the tsconfig paths map, and the lib-consuming
    // suites (webworker-packer image-loadable, webworker-runtime
    // transform-corpus, client ui-trajectory client-bundle) self-skip on
    // unbuilt checkouts. The regex catches a regression spelled as
    // 'corepack pnpm run build' or folded into a multi-line run block, which
    // an exact string match would miss.
    expect(coverageCommands.every(step => !/\bpnpm\s+run\s+build(?:\s|$)/.test(step.run))).toBe(true)

    // windows-native-tests runs the Windows-specific specs.
    expect(windowsNativeTests.name).toBe('windows node 24 / native tests')
    const nativeTestSteps = windowsNativeTests.steps as unknown[]
    const nativeTestCommands = nativeTestSteps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    const nativeTestCommand = nativeTestCommands.map(step => step.run).join('\n')
    expect(nativeTestCommand).toContain('--no-file-parallelism')
    expect(nativeTestCommand).toContain('--testTimeout 90000')
    expect(nativeTestCommand).toContain('tool-pwsh/tests/loader.spec.ts')
    expect(nativeTestCommand).toContain('workflow-ptc.spec.ts')

    expect(workflow.jobs['windows-observational']).toBeUndefined()
    expect(windowsBuild['continue-on-error']).not.toBe(true)
    const observational = buildCommands.find(step => step.id === 'observational')
    expect(observational).toMatchObject({
      run: 'pnpm run check:ci:windows-observational-ready',
      shell: 'pwsh',
      'continue-on-error': true,
      'timeout-minutes': 15,
      env: {
        DSH_GATE_FAIL_FAST: '',
        DSH_PUBLINT_CONCURRENCY: "${{ vars.DSH_CI_FAILOVER_WINDOWS == 'selfhosted' && github.event.pull_request.user.login != 'dependabot[bot]' && '8' || '' }}",
      },
    })
    expect(observational?.if).toBeUndefined()
    expect(buildCommands.findIndex(step => step.id === 'observational'))
      .toBeGreaterThan(buildCommands.findIndex(step => step.run === 'pnpm run check:ci:windows-blocking'))
    const report = buildCommands.find(step => step.name === 'Report Windows observational failures')
    expect(report).toMatchObject({
      'continue-on-error': true,
      if: "steps.observational.outcome == 'failure'",
      shell: 'pwsh',
    })
    expect(report?.run).toContain('::warning::')
    expect(report?.run).toContain('Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append')

    // serial-windows: master-only standby, self-hosted, non-blocking, lives in ci-master.
    expect(serialWindows.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(serialWindows['runs-on']).toEqual(['self-hosted', 'dsh-win-ci', 'windows'])
    expect(serialWindows.name).toBe('serial / windows (self-hosted standby)')
    // Its store must share the ReFS workspace volume for clone; the install
    // must carry the same filesystem branch as the PR jobs.
    const serialSteps = serialWindows.steps as unknown[]
    const serialStore = serialSteps.find((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && step.name === 'Configure persistent pnpm store' && typeof step.run === 'string'
    ))
    expect(serialStore).toBeDefined()
    expect(serialStore!.run).toContain('[IO.Path]::GetPathRoot($env:GITHUB_WORKSPACE)')
    expect(serialStore!.run).toContain("'.pnpm-store'")
    const serialInstall = serialSteps.find((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && step.name === 'Install (immutable)' && typeof step.run === 'string'
    ))
    expect(serialInstall).toBeDefined()
    expect(serialInstall!.run).toContain("$fs -eq 'ReFS'")
    expect(serialInstall!.run).toContain('--package-import-method=clone')
    expect(serialInstall!.run).toContain('corepack pnpm install')
    // Distinct else-branch line, as for the PR jobs: the corepack clone line
    // contains the plain-install substring too.
    expect(serialInstall!.run.split('\n').map(line => line.trim())).toContain('} else {')
    expect(serialInstall!.run.split('\n').map(line => line.trim())).toContain('pnpm install --frozen-lockfile')
    expect(serialInstall!.run).not.toContain('$cloneFlag')
    // The unsharded reference runs the whole coverage inventory at the same
    // per-test budget the PR coverage lane grants; the default 5000ms times
    // out load-sensitive store scans (e.g. gen-third-party-notices).
    const serialGate = serialSteps.find((step): step is Record<string, unknown> & { env?: Record<string, unknown> } => (
      isRecord(step) && step.name === 'Run complete unsharded Windows gate inventory serially'
    ))
    expect(serialGate).toBeDefined()
    expect(serialGate!.env).toMatchObject({ DSH_COVERAGE_TEST_TIMEOUT_MS: '90000' })

    // windows-coverage is temporarily non-blocking while Windows ACP
    // half-close tests are stabilized; observational stays out too.
    expect(aggregate.needs).not.toContain('windows')
    expect(aggregate.needs).toContain('windows-build')
    // The benchmark lane is a required verdict input and runs alone so its
    // wall-clock budgets never share a runner with a concurrent aggregate.
    expect(aggregate.needs).toContain('node-24-bench')
    expect(node24Bench.name).toBe('node 24 / benchmarks')
    expect(node24Bench.env).toBeUndefined()
    expect(node24Bench.steps).toContainEqual({
      name: 'Install benchmark browser and hosted dependencies',
      run: 'pnpm --filter @deepseek-ai/dsh-benchmarks exec playwright install --with-deps chromium',
    })
    expect(JSON.stringify(node24Bench.steps)).not.toContain('DSH_CI_FAILOVER_LINUX')
    expect(node24Bench.steps).toContainEqual({
      name: 'Run performance benchmarks',
      env: { DSH_GATE_VERBOSE: '1' },
      run: 'pnpm run check:ci:bench',
    })
    expect(aggregate.needs).not.toContain('windows-coverage')
    expect(aggregate.needs).toContain('windows-native-tests')
    expect(aggregate.needs).not.toContain('windows-observational')
    expect(aggregate.needs).not.toContain('serial-windows')

    // Linux failover is a separate switch: the three enterprise Linux workers
    // and the verdict job resolve their pool through DSH_CI_FAILOVER_LINUX,
    // never the Windows switch.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Linux failover switch`).toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on'], `${jobName} runs-on must not use the Windows failover switch`).not.toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(job['runs-on']).toContain('vm-backup')
      expect(evaluateRunsOn(job['runs-on'], { vars: { DSH_CI_FAILOVER_LINUX: 'blacksmith' } }))
        .toBe(`blacksmith-${jobName === 'node-24' ? 8 : 16}vcpu-ubuntu-2404`)
    }
    expect(aggregate['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(aggregate['runs-on']).not.toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(aggregate['runs-on']).toContain('vm-backup')
    expect(aggregate['runs-on']).toContain('blacksmith-4vcpu-ubuntu-2404')

    // Evaluating the full selector, not just substring containment, proves the
    // blacksmith branch is standalone: it must not fall through to the
    // self-hosted pool when the two values are mutually exclusive.
    const selectors = {
      linux: node24['runs-on'] as string,
      linuxAggregate: aggregate['runs-on'] as string,
      windows: windowsBuild['runs-on'] as string,
    }
    const evaluate = (expression: string, vars: Record<string, string>, login = 'maintainer'): unknown => {
      return evaluateRunsOn(expression, {
        vars,
        fromJSON: JSON.parse,
        github: { event: { pull_request: { user: { login } } } },
      })
    }
    for (const [name, selector, variable, pool, hosted] of [
      ['linux gates', selectors.linux, 'DSH_CI_FAILOVER_LINUX', ['self-hosted', 'linux', 'x64', 'vm-backup'], 'dsh-ubuntu-24-04-16core'],
      ['linux aggregate', selectors.linuxAggregate, 'DSH_CI_FAILOVER_LINUX', ['self-hosted', 'linux', 'x64', 'vm-backup'], 'ubuntu-latest'],
      ['windows lanes', selectors.windows, 'DSH_CI_FAILOVER_WINDOWS', ['self-hosted', 'dsh-win-ci', 'windows'], 'dsh-windows-2025-16core'],
    ] as const) {
      expect(evaluate(selector, { [variable]: 'blacksmith' }), `${name} blacksmith value`).toMatch(/^blacksmith-/)
      expect(evaluate(selector, { [variable]: 'selfhosted' }), `${name} selfhosted value`).toEqual(pool)
      // The blacksmith branch must not capture the selfhosted pool, and the
      // dependabot exclusion applies to the pool, not to the blacksmith tier.
      expect(evaluate(selector, { [variable]: 'selfhosted' }, 'dependabot[bot]'), `${name} dependabot on selfhosted`).toBe(hosted)
      for (const mode of ['', 'hosted', 'unexpected']) {
        expect(evaluate(selector, { [variable]: mode }), `${name} default on ${mode}`).toBe(hosted)
      }
    }

    // The run-gates aggregate lanes stop at the first blocking gate failure so
    // a red aggregate does not keep burning runner time on the remaining
    // gates. Removing the flag silently reverts to running every independent
    // gate to completion.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers], ['node-compat', nodeCompat]] as const) {
      expect(job.env, `${jobName} must enable fail-fast`).toMatchObject({ DSH_GATE_FAIL_FAST: '1' })
    }

    // The native Windows lanes with run-gates aggregates fail fast for the
    // same reason: a failing gate aborts the sibling gate instead of waiting
    // out the multi-minute instrumented coverage run.
    expect(windowsBuild.env, 'windows-build must enable fail-fast').toMatchObject({ DSH_GATE_FAIL_FAST: '1' })
    expect(windowsCoverage.env, 'windows-coverage must enable fail-fast').toMatchObject({ DSH_GATE_FAIL_FAST: '1' })

    // The observational lane stays complete: it is continue-on-error by design
    // and exists to collect as much Windows-native evidence per run as
    // possible, so the first failure must not truncate the rest.
    expect(observational?.env).toMatchObject({ DSH_GATE_FAIL_FAST: '' })
  })

  it('runs the darwin unit parity inventory at the coverage lanes\' test budget', () => {
    const coverage = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-coverage')
    if (!isRecord(coverage.env) || typeof coverage.env.DSH_COVERAGE_TEST_TIMEOUT_MS !== 'string') {
      throw new TypeError('node-24-coverage must grant DSH_COVERAGE_TEST_TIMEOUT_MS')
    }
    const unitDarwin = workflowJob(loadWorkflow('.github/workflows/sandbox.yml'), 'unit-darwin')
    if (!Array.isArray(unitDarwin.steps)) throw new TypeError('unit-darwin job must define steps')
    const unit = unitDarwin.steps.filter(isRecord).find(step => step.name === 'Unit tests (darwin parity)')
    // The whole unit inventory on a shared macos-latest runner pays the same
    // scheduling delay the coverage lanes absorb; the ci-unit aggregate is the
    // `pnpm run test` path that consumes the variable, and the value is the
    // coverage lane's so the two budget classes cannot drift apart.
    expect(unit).toMatchObject({
      run: 'pnpm run check:ci:unit',
      env: { DSH_COVERAGE_TEST_TIMEOUT_MS: coverage.env.DSH_COVERAGE_TEST_TIMEOUT_MS },
    })
  })

  it('gates standalone keyless blacksmith jobs and benchmark tiers on the failover variables', () => {
    const expectedFilenames = workflowJob(loadWorkflow('.github/workflows/expected-filenames.yml'), 'expected-filenames')
    const sandbox = workflowJob(loadWorkflow('.github/workflows/sandbox.yml'), 'sandbox-e2e')
    expect(expectedFilenames['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(expectedFilenames['runs-on']).toContain("== 'blacksmith'")
    expect(expectedFilenames['runs-on']).toContain('blacksmith-4vcpu-ubuntu-2404')
    expect(expectedFilenames['runs-on']).toContain("'ubuntu-latest'")
    expect(sandbox['runs-on']).toContain("matrix.runner == 'bwrap'")
    expect(sandbox['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(sandbox['runs-on']).toContain('blacksmith-4vcpu-ubuntu-2404')
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark'] as const) {
      const benchmark = workflowJob(loadWorkflow('.github/workflows/ci-master.yml'), name)
      if (!isRecord(benchmark.strategy) || !isRecord(benchmark.strategy.matrix) || !Array.isArray(benchmark.strategy.matrix.include)) {
        throw new TypeError(`${name} must define a matrix include list`)
      }
      expect(benchmark['runs-on']).toContain('matrix.blacksmith')
      expect(benchmark['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
      expect(benchmark['runs-on']).toContain('DSH_CI_FAILOVER_WINDOWS')
      for (const row of benchmark.strategy.matrix.include as Array<Record<string, string>>) {
        expect(typeof row.blacksmith, `${name} ${row.cores}-core row must declare a blacksmith label`).toBe('string')
        if (row.cores === '64' || row.cores === '96') {
          expect(row.blacksmith, `${name} ${row.cores}-core row has no Blacksmith tier`).toBe('')
        } else {
          expect(row.blacksmith).toContain(`blacksmith-${row.cores}vcpu`)
        }
      }
    }
  })

  it('runs required benchmarks on standard hosted Linux independently of failover', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const benchmark = workflowJob(workflow, 'node-24-bench')
    const aggregate = workflowJob(workflow, 'all-checks-passed')

    expect(benchmark['runs-on']).toBe('ubuntu-24.04')
    expect(benchmark.if).toBe("github.event_name == 'pull_request'")
    expect(benchmark.needs).toBeUndefined()
    expect(benchmark['continue-on-error']).toBeUndefined()
    expect(benchmark.env).toBeUndefined()
    expect(aggregate.needs).toContain('node-24-bench')
  })

  it('always restores the hosted benchmark pnpm cache', () => {
    const benchmark = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-bench')
    if (!Array.isArray(benchmark.steps)) throw new TypeError('benchmark job must define steps')
    const caches = benchmark.steps.filter(step => isRecord(step) && step.uses === 'actions/cache/restore@v6.1.0')

    expect(caches).toHaveLength(1)
    expect(caches[0]).not.toHaveProperty('if')
    expect(caches[0]).toMatchObject({
      with: {
        path: '${{ steps.pnpm-store.outputs.path }}',
        key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
      },
    })
  })

  it('bounds the complete benchmark job to twenty minutes', () => {
    const benchmark = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-bench')

    expect(benchmark['timeout-minutes']).toBe(20)
    expect(benchmark.steps).toContainEqual({
      name: 'Run performance benchmarks',
      env: { DSH_GATE_VERBOSE: '1' },
      run: 'pnpm run check:ci:bench',
    })
  })

  it('publishes the scaled benchmark report even when a budget fails', () => {
    const benchmark = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-bench')
    if (!Array.isArray(benchmark.steps)) throw new TypeError('benchmark job must define steps')

    expect(benchmark.steps).toContainEqual({
      name: 'Upload scaled benchmark report',
      if: '${{ !cancelled() }}',
      uses: 'actions/upload-artifact@v7.0.1',
      with: {
        name: 'benchmark-report',
        path: 'benchmarks/.dsh-report/',
        'include-hidden-files': true,
        'if-no-files-found': 'warn',
        'retention-days': 7,
      },
    })

    const uploadIndex = benchmark.steps.findIndex(step => isRecord(step) && step.name === 'Upload scaled benchmark report')
    const benchmarkIndex = benchmark.steps.findIndex(step => isRecord(step) && step.name === 'Run performance benchmarks')
    expect(uploadIndex).toBeGreaterThan(benchmarkIndex)
  })

  it('gives the Wine Host TypeScript compile the repository heap budget', () => {
    const wineGates = readFileSync(resolve(root, 'scripts/wine-windows-gates.sh'), 'utf8')

    expect(wineGates).toContain(
      'wine_node "$scratch/logs/host-tsc.log" --max-old-space-size=4096 "$tsc_js" -b tsconfig.host.json --pretty false',
    )
  })

  it('cancels superseded master runs without changing the post-merge job inventory', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    const prWorkflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('ci-master workflow must define jobs and a workflow-level concurrency block')
    }
    if (!isRecord(prWorkflow.jobs)) {
      throw new TypeError('ci workflow must define jobs')
    }

    expect(workflow.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    })
    expect(prWorkflow.concurrency).toEqual(workflow.concurrency)

    // The exact event sets are what keep master-only jobs out of the PR check
    // panel: ci-master triggers only on push(master) + workflow_dispatch and
    // never on pull_request; ci.yml is exactly pull_request-only. Assert the
    // full sets so losing the wrong event, or gaining an extra one, fails.
    if (!isRecord(workflow.on) || !isRecord(prWorkflow.on)) {
      throw new TypeError('both CI workflows must define on')
    }
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(Object.keys(prWorkflow.on)).toEqual(['pull_request'])

    // Drills share the parent run’s supersession policy.
    for (const name of ['serial-linux-selfhosted', 'serial-windows']) {
      const job = workflow.jobs[name]
      if (!isRecord(job)) throw new TypeError(`${name} must be defined`)
      expect(job.concurrency).toBeUndefined()
      // Standby drills remain post-merge work, but share run cancellation.
      expect(job.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    }

    // Pin the post-merge runtime, Wine, and standby inventory.
    const NOT_PUSH_REACHABLE = new Set([
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'larger-runner-benchmark'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'consolidated-runner-benchmark'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'ssh-helper'",
    ])
    const pushReachable = Object.entries(workflow.jobs)
      .filter(([, job]) => {
        if (!isRecord(job)) return false
        if (job.if === undefined) return true // unconditional: runs on every event
        if (job.if === false) return false // `if: false` parses as a boolean
        if (typeof job.if !== 'string') return true // unrecognized shape: surface it
        return !NOT_PUSH_REACHABLE.has(job.if.trim())
      })
      .map(([name]) => name)
      .sort()
    expect(pushReachable).toEqual(['python-runtime', 'serial-linux-selfhosted', 'serial-windows', 'windows'])

    // Manual benchmarks retain their bounded fan-out.
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark']) {
      const job = workflow.jobs[name]
      if (!isRecord(job) || !isRecord(job.strategy)) {
        throw new TypeError(`${name} must define a matrix strategy`)
      }
      expect(job.strategy['max-parallel']).toBe(12)
      expect(job['timeout-minutes']).toBe(15)
    }
  })

  it('redirects the Node compile cache to the data-volume runner temp before the first pnpm call', () => {
    const prWorkflow = loadWorkflow('.github/workflows/ci.yml')
    const masterWorkflow = loadWorkflow('.github/workflows/ci-master.yml')
    const redirectLanes = [
      [prWorkflow, 'node-24'],
      [prWorkflow, 'node-24-coverage'],
      [prWorkflow, 'node-24-consumers'],
      [masterWorkflow, 'serial-linux-selfhosted'],
    ] as const
    for (const [workflow, jobKey] of redirectLanes) {
      const job = workflowJob(workflow, jobKey)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobKey} must define steps`)
      const redirectStepIndex = job.steps.findIndex((step): step is Record<string, unknown> & { run: string } => (
        isRecord(step) && typeof step.run === 'string'
          && step.run.includes('NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache')
          && step.run.includes('"$GITHUB_ENV"')
      ))
      // Removing this injection would send every pnpm call in the lane (setup,
      // store-path probe, install, and the gate) back to the root partition's
      // /tmp; rationale in
      // .github/workflows/ci.yml.
      expect(redirectStepIndex, `${jobKey} must inject NODE_COMPILE_CACHE into GITHUB_ENV`).toBeGreaterThan(-1)
      const pnpmSetupIndex = job.steps.findIndex((step): step is Record<string, unknown> & { uses: string } => (
        isRecord(step) && typeof step.uses === 'string' && step.uses.includes('pnpm/action-setup')
      ))
      expect(pnpmSetupIndex, `${jobKey} must run pnpm/action-setup`).toBeGreaterThan(-1)
      expect(redirectStepIndex, `${jobKey} must redirect before pnpm/action-setup runs pnpm`).toBeLessThan(pnpmSetupIndex)
    }
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('requires release-shaped Python runtime validation on Linux and Windows x64', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      if: "github.event_name == 'pull_request'",
      name: 'python runtime / release-shaped matrix',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-win-x64',
        ci: true,
      },
      secrets: {
        DEEPSEEK_API_KEY_EXTERNAL: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}',
      },
    })
    expect(aggregate.needs).toContain('python-runtime')
  })

  it('builds SSH executables only for explicit manual or release requests', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(ci.jobs)) throw new Error('PR CI must define jobs')
    expect(Object.values(ci.jobs)).not.toContainEqual(expect.objectContaining({ uses: './.github/workflows/build-exe-for-ssh-helper.yml' }))
    expect(workflowJob(ci, 'all-checks-passed').needs).not.toContain('ssh-helper')
    const master = workflowJob(loadWorkflow('.github/workflows/ci-master.yml'), 'ssh-helper')
    if (typeof master.if !== 'string') throw new Error('SSH manual caller must define its trigger condition')
    for (const [event, suite, expected] of [
      ['push', 'ssh-helper', false], ['pull_request', 'ssh-helper', false],
      ['workflow_dispatch', 'larger-runner-benchmark', false], ['workflow_dispatch', 'ssh-helper', true],
    ] as const) {
      expect(runInNewContext(master.if, { github: { event_name: event, ref: 'refs/heads/master' }, inputs: { suite } }, { timeout: 1000 })).toBe(expected)
    }
    expect(master.with).toEqual({ targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64' })
    const workflow = loadWorkflow('.github/workflows/build-exe-for-ssh-helper.yml')
    if (!isRecord(workflow.on)) throw new Error('SSH builder must define triggers')
    expect(Object.keys(workflow.on).sort()).toEqual(['workflow_call', 'workflow_dispatch'])
  })

  it('requires SSH helper acceptance before uploading artifacts or publishing', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-ssh-helper.yml')
    const build = workflowJob(workflow, 'build')
    if (!Array.isArray(build.steps)) throw new Error('SSH build must define its verification steps')
    const steps = build.steps.filter(isRecord)
    const artifact = steps.findIndex(step => String(step.run).includes('scripts/verify-ssh-helper-artifact.ts'))
    const transport = steps.findIndex(step => String(step.run).includes('scripts/verify-ssh-helper-ssh.ts'))
    const landlock = steps.findIndex(step => String(step.run).includes('--backend=landlock-run'))
    const upload = steps.findIndex(step => String(step.uses).startsWith('actions/upload-artifact@'))
    expect(artifact).toBeGreaterThan(-1)
    expect(landlock).toBeGreaterThan(artifact)
    expect(transport).toBeGreaterThan(artifact)
    expect(upload).toBeGreaterThan(transport)
    for (const index of [artifact, transport, landlock, upload]) expect(steps[index]).not.toHaveProperty('continue-on-error', true)
    const publish = loadWorkflow('.github/workflows/publish-ssh-helper.yml')
    expect(publish.permissions).toEqual({ contents: 'read' })
    expect(workflowJob(publish, 'build')).toMatchObject({ needs: 'validate', with: { release: true } })
    const verify = workflowJob(publish, 'verify')
    expect(verify.needs).toEqual(['validate', 'build'])
    expect(verify).not.toHaveProperty('if')
    expect(verify).not.toHaveProperty('permissions')
    if (!Array.isArray(verify.steps)) throw new Error('Release verification must define steps')
    const verification = verify.steps.findIndex(step => isRecord(step) && String(step.run).includes('scripts/ssh-helper/release.ts'))
    const checksums = verify.steps.findIndex(step => isRecord(step) && String(step.uses).startsWith('actions/upload-artifact@'))
    expect(verification).toBeGreaterThan(-1)
    expect(checksums).toBeGreaterThan(verification)
    expect(verify.steps[verification]).not.toHaveProperty('continue-on-error', true)
    const publication = workflowJob(publish, 'publish')
    expect(publication).toMatchObject({ if: 'inputs.publish', needs: ['validate', 'verify'], permissions: { contents: 'write' } })
    for (const requested of [false, true]) {
      expect(runInNewContext(String(publication.if), { inputs: { publish: requested } }, { timeout: 1000 })).toBe(requested)
    }
  })

  it('validates any ref by default but refuses publication without the matching SSH release tag', () => {
    const workflow = loadWorkflow('.github/workflows/publish-ssh-helper.yml')
    if (!isRecord(workflow.on)) throw new Error('SSH release must define triggers')
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(workflowEvent(workflow, 'workflow_dispatch').inputs).toMatchObject({ publish: { type: 'boolean', default: false } })
    const validate = workflowJob(workflow, 'validate')
    expect(validate.steps).toContainEqual(expect.objectContaining({ id: 'source', env: { PUBLISH: '${{ inputs.publish }}' } }))
    const source = nodeStepSource(validate, 'source')
    const evaluate = (publish: boolean, type: string, name: string): string => {
      let output = ''
      runInNewContext(source, {
        process: { env: { PUBLISH: String(publish), GITHUB_REF_TYPE: type, GITHUB_REF_NAME: name, GITHUB_OUTPUT: 'output' } },
        readFileSync: () => JSON.stringify({ version: '1.2.3' }),
        execFileSync: () => `${'a'.repeat(40)}\n`,
        appendFileSync: (_path: string, text: string) => { output += text },
      }, { timeout: 1000 })
      return output
    }
    const expected = `version=1.2.3\ncommit=${'a'.repeat(40)}\n`
    expect(evaluate(false, 'branch', 'worktree/helper')).toBe(expected)
    expect(evaluate(false, 'tag', 'arbitrary-tag')).toBe(expected)
    expect(evaluate(true, 'tag', 'dsh-v1.2.3')).toBe(expected)
    for (const [type, name] of [['branch', 'dsh-v1.2.3'], ['tag', 'dsh-v1.2.2'], ['tag', 'python-v1.2.3']] as const) {
      expect(() => evaluate(true, type, name)).toThrow('Publication requires the matching dsh-v<version> tag')
    }
  })

  it('validates the SSH native matrix before allocating runners', () => {
    const plan = workflowJob(loadWorkflow('.github/workflows/build-exe-for-ssh-helper.yml'), 'plan')
    const source = nodeStepSource(plan, 'targets')
    const evaluate = (requested: string): unknown => {
      let output = ''
      runInNewContext(source, {
        process: { env: { REQUESTED_TARGETS: requested, GITHUB_OUTPUT: 'output' } },
        appendFileSync: (_path: string, text: string) => { output += text },
      }, { timeout: 1000 })
      return JSON.parse(output.slice('matrix='.length))
    }
    expect(evaluate('')).toHaveLength(4)
    expect(evaluate('node24-linux-arm64')).toEqual([{ target: 'node24-linux-arm64', runner: 'ubuntu-24.04-arm' }])
    for (const invalid of ['node24-linux-arm64,node24-linux-arm64', 'node24-win-x64', 'node24-linux-x64,', ' ']) {
      expect(() => evaluate(invalid)).toThrow('Invalid or duplicate')
    }
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })

  it('applies the lane test budget inside every Vitest project', () => {
    // Each inline project spreads coverageTestTimeoutOptions, the only route
    // for DSH_COVERAGE_TEST_TIMEOUT_MS into projects; the behavior itself is
    // pinned by scripts/lane-test-budget.spec.ts.
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).toContain('const laneTestBudget = coverageTestTimeoutOptions(process.env[COVERAGE_TEST_TIMEOUT_ENV])')
    expect(config.match(/^ {10}\.\.\.laneTestBudget,$/gm)).toHaveLength(2)
  })
})

describe('Runtime and LLM e2e Blacksmith routing', () => {
  it('routes DeepSeek e2e only through the Linux Blacksmith switch', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/e2e.yml'), 'e2e')
    for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
      expect(evaluateRunsOn(job['runs-on'], { vars: { DSH_CI_FAILOVER_LINUX: mode, DSH_CI_FAILOVER_WINDOWS: 'blacksmith' } }))
        .toBe(mode === 'blacksmith' ? 'blacksmith-4vcpu-ubuntu-2404' : 'ubuntu-latest')
    }
  })

  it('keeps native release and dispatch builders hosted while routing x64 CI by platform', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const build = workflowJob(workflow, 'build')
    for (const [target, runner, variable, blacksmith] of [
      ['node24-linux-x64', 'ubuntu-latest', 'DSH_CI_FAILOVER_LINUX', 'blacksmith-2vcpu-ubuntu-2404'],
      ['node24-win-x64', 'windows-2025', 'DSH_CI_FAILOVER_WINDOWS', 'blacksmith-2vcpu-windows-2025'],
      ['node24-linux-arm64', 'ubuntu-24.04-arm', 'DSH_CI_FAILOVER_LINUX', 'ubuntu-24.04-arm'],
      ['node24-macos-arm64', 'macos-latest', 'DSH_CI_FAILOVER_LINUX', 'macos-latest'],
      ['node24-macos-x64', 'macos-15-intel', 'DSH_CI_FAILOVER_LINUX', 'macos-15-intel'],
    ] as const) {
      for (const ci of [false, true]) {
        for (const release of [false, true]) {
          for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
            const vars = { DSH_CI_FAILOVER_LINUX: 'blacksmith', DSH_CI_FAILOVER_WINDOWS: 'blacksmith', [variable]: mode }
            expect(evaluateRunsOn(build['runs-on'], { inputs: { ci, release }, vars, matrix: { target, runner } }), `${target} ci=${ci} release=${release} mode=${mode}`)
              .toBe(ci && !release && mode === 'blacksmith' ? blacksmith : runner)
          }
        }
      }
    }
  })

  it.each(['plan', 'sdk-wheel'])('routes runtime %s only for non-release CI', (name) => {
    const job = workflowJob(loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml'), name)
    for (const ci of [false, true]) {
      for (const release of [false, true]) {
        for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
          expect(evaluateRunsOn(job['runs-on'], { inputs: { ci, release }, vars: { DSH_CI_FAILOVER_LINUX: mode } }))
            .toBe(ci && !release && mode === 'blacksmith' ? 'blacksmith-4vcpu-ubuntu-2404' : 'ubuntu-latest')
        }
      }
    }
  })
})

describe('bubblewrap preparation script', () => {
  it('pins bubblewrap to a recorded Launchpad build and excludes Ubuntu pool downloads', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')
    const url = /^readonly BUBBLEWRAP_URL="([^"]+)"$/mu.exec(script)?.[1]

    expect(url).toMatch(
      /^https:\/\/launchpad\.net\/ubuntu\/\+source\/bubblewrap\/[^/]+\/\+build\/\d+\/\+files\/bubblewrap_[^/]+_amd64\.deb$/u,
    )
    // Ubuntu removes superseded versions from its live package pool.
    expect(script).not.toMatch(/https?:\/\/[^/'"\s]+\/ubuntu(?:-ports)?\/pool\//u)
  })
})

describe('DeepSeek e2e workflow', () => {
  it('prepares bubblewrap from the pinned payload without a package transaction', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const steps = e2e.steps.filter(isRecord)
    expect(steps.find(step => step.name === 'Prepare bubblewrap (unrestrict userns)')).toMatchObject({
      run: 'bash scripts/prepare-ci-bubblewrap.sh',
    })
    expect(JSON.stringify(steps)).not.toContain('apt-get')
  })

  it('bounds profile subprocess fan-out to the tested e2e default', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const step = e2e.steps.filter(isRecord).find(candidate => candidate.name === 'E2E tests (real DeepSeek API)')
    expect(step).toMatchObject({ env: { DSH_E2E_MAX_WORKERS: 4 } })
  })
})

describe('Python release workflows', () => {
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    if (!isRecord(workflow.on)) throw new TypeError('python-release workflow must define on')
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(build).toMatchObject({
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    const pythonCompatSteps = JSON.stringify(pythonCompat.steps)
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_sdk-$VERSION-py3-none-any.whl')
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_runtime_bin-$VERSION-py3-none-manylinux_2_28_x86_64.whl')
    expect(pythonCompatSteps).not.toContain('--find-links')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    expect(Object.keys(workflow.on as Record<string, unknown>).sort()).toEqual(['workflow_call', 'workflow_dispatch'])
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !isRecord(call.secrets) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS payload architecture and deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    const cleanVenvPosix = buildSteps.find(step => isRecord(step) && step.name === 'Install local SDK and runtime wheels into a clean venv (POSIX)')
    const cleanVenvWindows = buildSteps.find(step => isRecord(step) && step.name === 'Install local SDK and runtime wheels into a clean venv (Windows)')
    const installedKeylessPosix = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel keyless black-box tests (POSIX)')
    const installedKeylessWindows = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel keyless black-box tests (Windows)')
    const realApiPreflightPosix = buildSteps.find(step => isRecord(step) && step.name === 'Preflight installed-wheel real API test (POSIX)')
    const realApiPreflightWindows = buildSteps.find(step => isRecord(step) && step.name === 'Preflight installed-wheel real API test (Windows)')
    const installedRealApiPosix = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel real API black-box test (POSIX)')
    const installedRealApiWindows = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel real API black-box test (Windows)')
    if (!isRecord(macosCheck) || typeof macosCheck.run !== 'string'
      || !isRecord(cleanVenvPosix) || !isRecord(cleanVenvWindows)
      || !isRecord(installedKeylessPosix) || !isRecord(installedKeylessWindows)
      || !isRecord(realApiPreflightPosix) || !isRecord(realApiPreflightWindows)
      || !isRecord(installedRealApiPosix) || !isRecord(installedRealApiWindows)) {
      throw new TypeError('Python wheel builder must define native POSIX and Windows installed-wheel steps')
    }
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(call.secrets).toMatchObject({
      DEEPSEEK_API_KEY_EXTERNAL: { required: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(build.defaults).toBeUndefined()
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    const workflowJson = JSON.stringify(workflow)
    expect(workflowJson).toContain('macosx_14_0_arm64')
    expect(workflowJson).toContain('macosx_14_0_x86_64')
    expect(workflowJson).toContain('node24-macos-x64')
    expect(workflowJson).toContain('macos-15-intel')
    expect(workflowJson).toContain('win_amd64')
    expect(workflowJson).toContain('node24-win-x64')
    expect(workflowJson).toContain('windows-2025')
    expect(workflowJson).toContain('dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).not.toContain('--find-links dist-python')
    expect(workflowJson).not.toContain('--find-links /work/dist-python')
    expect(workflowJson).not.toContain('cygpath')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('npm_config_build_from_source=true pnpm --config.verifyDepsBeforeRun=false run install')
    expect(JSON.stringify(manylinuxAddon)).toContain('pnpm_setup_root')
    expect(JSON.stringify(manylinuxAddon)).toContain('$pnpm_setup_root:$pnpm_setup_root:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(macosCheck.run).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck.run).toContain('lipo "$payload" -verify_arch')
    expect(macosCheck.run).toContain('$EXE-rg')
    expect(macosCheck.run).toContain('$EXE-spawn-helper')
    expect(JSON.stringify(installedKeylessPosix)).toContain('--scenario all')
    expect(JSON.stringify(installedKeylessPosix)).toContain('env -u PYTHONPATH')
    expect(JSON.stringify(installedKeylessWindows)).toContain('--scenario all --installed-wheel')
    expect(installedKeylessWindows).toMatchObject({ if: "runner.os == 'Windows'", shell: 'pwsh' })
    expect(cleanVenvWindows).toMatchObject({ if: "runner.os == 'Windows'", shell: 'pwsh' })
    expect(JSON.stringify(cleanVenvWindows)).toContain('Scripts\\\\python.exe')
    expect(realApiPreflightPosix).toMatchObject({
      env: { DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' },
    })
    expect(String(realApiPreflightPosix.if)).toContain('inputs.ci')
    expect(String(realApiPreflightPosix.if)).toContain('head.repo.fork')
    expect(String(realApiPreflightPosix.if)).toContain('dependabot[bot]')
    expect(realApiPreflightWindows).toMatchObject({ shell: 'pwsh' })
    for (const step of [installedRealApiPosix, installedRealApiWindows]) {
      expect(step).toMatchObject({
        env: {
          DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}',
          DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
        },
      })
    }
    expect(JSON.stringify(installedRealApiPosix)).toContain('--scenario sdk-live')
    expect(JSON.stringify(installedRealApiPosix)).toContain('-u DSH_RUNTIME_MODE')
    expect(installedRealApiWindows).toMatchObject({ shell: 'pwsh' })
    expect(JSON.stringify(installedRealApiWindows)).toContain('--scenario sdk-live --installed-wheel')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('${PLATFORM#macos-}'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('lipo "$payload" -verify_arch')
    expect(macosCheck).toContain('"$EXE" "$EXE-rg" "$EXE-spawn-helper"')
  })

  it('builds the macOS x64 wheel on the matching GitLab runner', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const macosX64 = workflow['runtime-macos-x64']
    const publish = workflow['publish-python']
    if (!isRecord(macosX64) || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the macOS x64 runtime and publication jobs')
    }

    expect(macosX64.tags).toEqual(['macos-x64'])
    expect(macosX64.variables).toMatchObject({ PKG_TARGET: 'node24-macos-x64', PLATFORM: 'macos-x64' })
    expect(publish.needs).toContainEqual({ job: 'runtime-macos-x64', artifacts: true })
    expect(JSON.stringify(publish.script)).toContain('macosx_14_0_x86_64.whl')
  })

  it('builds and black-box tests the Windows x64 wheel in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const windows = workflow['runtime-windows-x64']
    const publish = workflow['publish-python']
    if (!isRecord(windows) || !Array.isArray(windows.before_script) || !Array.isArray(windows.script)
      || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the Windows runtime and aggregate publication jobs')
    }

    expect(windows.tags).toEqual(['windows-x64'])
    expect(windows.variables).toMatchObject({ PKG_TARGET: 'node24-win-x64', PLATFORM: 'win-x64' })
    expect(JSON.stringify(windows.before_script)).toContain('.ci-python\\\\Scripts')
    expect(JSON.stringify(windows.before_script)).toContain('[IO.Path]::PathSeparator')
    expect(JSON.stringify(windows.script)).toContain('win_amd64.whl')
    expect(JSON.stringify(windows.script)).toContain('--scenario all --installed-wheel')
    expect(publish.needs).toContainEqual({ job: 'runtime-windows-x64', artifacts: true })
  })
})

describe('Weighted approval workflow', () => {
  it('publishes from the trusted default branch after pull request and review updates', () => {
    const publisher = loadWorkflow('.github/workflows/weighted-approval.yml')
    const reviewEvent = loadWorkflow('.github/workflows/weighted-approval-review-event.yml')
    const pullRequest = workflowEvent(publisher, 'pull_request_target')
    const workflowRun = workflowEvent(publisher, 'workflow_run')
    const review = workflowEvent(reviewEvent, 'pull_request_review')
    const job = workflowJob(publisher, 'publish-status')
    const recordJob = workflowJob(reviewEvent, 'record-review-event')
    if (!isRecord(publisher.on)) throw new TypeError('weighted-approval workflow must define events')
    if (!isRecord(reviewEvent.on)) throw new TypeError('weighted-approval review event workflow must define events')
    if (!Array.isArray(job.steps)) throw new TypeError('weighted-approval job must define steps')
    if (!Array.isArray(recordJob.steps)) throw new TypeError('weighted-approval review event job must define steps')
    const steps = job.steps.filter(isRecord)
    const checkout = steps.find(step => step.name === 'Check out trusted approval policy')
    const publish = steps.find(step => step.name === 'Publish weighted approval status')
    const recordSteps = recordJob.steps.filter(isRecord)
    const record = recordSteps.find(step => step.name === 'Record review event')

    expect(publisher.name).toBe('weighted-approval')
    expect(Object.keys(publisher.on)).toEqual(['pull_request_target', 'issue_comment', 'workflow_run'])
    expect(workflowEvent(publisher, 'issue_comment').types).toEqual(['created', 'edited', 'deleted'])
    expect(pullRequest.types).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft', 'edited'])
    expect(workflowRun).toEqual({ workflows: ['weighted-approval-review-event'], types: ['completed'] })
    expect(reviewEvent.name).toBe('weighted-approval-review-event')
    expect(reviewEvent['run-name']).toBe('weighted-approval-review-event:${{ github.event.pull_request.number }}')
    expect(Object.keys(reviewEvent.on)).toEqual(['pull_request_review'])
    expect(review.types).toEqual(['submitted', 'edited', 'dismissed'])
    expect(reviewEvent.permissions).toEqual({})
    expect(publisher.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      statuses: 'write',
    })
    expect(publisher.concurrency).toEqual({
      group: "weighted-approval-${{ (github.event.pull_request.number || github.event.issue.number) && format('weighted-approval-review-event:{0}', github.event.pull_request.number || github.event.issue.number) || github.event.workflow_run.display_title }}",
      'cancel-in-progress': false,
    })
    expect(job).toMatchObject({
      if: "(github.event_name != 'pull_request_target' || github.event.pull_request.state == 'open') && "
        + "(github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success') && "
        + "(github.event_name != 'issue_comment' || (github.event.issue.pull_request && github.event.issue.state == 'open' &&\n"
        + "  (contains(github.event.comment.body, '/delegate') || contains(github.event.changes.body.from, '/delegate'))))",
      name: 'weighted approval publisher',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 5,
    })
    expect(checkout).toMatchObject({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        ref: '${{ github.event.repository.default_branch }}',
        'persist-credentials': false,
      },
    })
    const setupIndex = steps.findIndex(step => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-python@'))
    expect(steps[setupIndex]?.if).toBe("steps.revoke.outputs.active == 'true'")
    expect(steps[setupIndex]?.uses).toBe('actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1')
    const revokeIndex = steps.findIndex(step => step.id === 'revoke')
    expect(revokeIndex).toBeGreaterThan(steps.indexOf(checkout!))
    expect(revokeIndex).toBeLessThan(setupIndex)
    expect(steps[revokeIndex]?.run).toBe('node .github/review-ownership/check-approval.mjs pending')
    expect(steps.at(-1)).toMatchObject({
      if: "failure() && steps.revoke.outputs.active == 'true'",
      run: 'node .github/review-ownership/check-approval.mjs error',
    })
    const pythonJob = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'python-sdk')
    expect(pythonJob.steps).toContainEqual({
      name: 'Test production blame scoring',
      run: "uv run --python 3.10 --with-requirements .github/review-ownership/requirements.txt python -m unittest discover -s .github/review-ownership -p 'test_*.py'",
    })
    expect(steps.find(step => step.name === 'Install production lexer')).toMatchObject({
      if: "steps.revoke.outputs.active == 'true'",
      run: 'python3 -m pip install -r .github/review-ownership/requirements.txt',
    })
    expect(publish).toMatchObject({
      if: "steps.revoke.outputs.active == 'true'",
      env: {
        GITHUB_TOKEN: '${{ github.token }}',
        GITHUB_RUN_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
      },
      run: 'node .github/review-ownership/check-approval.mjs',
    })
    expect(recordJob).toMatchObject({
      if: "github.event.pull_request.state == 'open'",
      name: 'record weighted approval review event',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 2,
    })
    expect(record).toBeDefined()
    expect(record?.run).toBe("echo 'Recorded a weighted approval review event.'")
    expect(recordSteps).toHaveLength(1)
    expect(JSON.stringify(publisher)).not.toContain('github.event.pull_request.head')
    expect(JSON.stringify(publisher)).not.toContain('secrets.')
    expect(JSON.stringify(reviewEvent)).not.toContain('github.token')
    expect(JSON.stringify(reviewEvent)).not.toContain('secrets.')
  })
})

describe('Issue lifecycle workflow', () => {
  it('allocates lifecycle runners only for events that can change the board', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    if (!Array.isArray(lifecycleJob.steps)) throw new TypeError('Issue lifecycle job must define steps')

    expect(lifecycle.on).toHaveProperty('pull_request')
    expect(lifecycle.on).toHaveProperty('pull_request_review')
    expect(lifecycleJob.if).toContain("github.event.review.state == 'changes_requested'")
    expect(lifecycleJob.if).toContain('github.event.changes.body != null')
    // Keep the subscription-type gates: issue-lifecycle does not re-subscribe
    // ready_for_review (issue-policy owns that) and only reacts to submitted
    // review events.
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    expect(lifecyclePullRequest.types).toContain('opened')
    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    expect(lifecyclePullRequest.types).not.toContain('synchronize')
    expect(lifecyclePullRequest.types).not.toContain('labeled')
    expect(lifecyclePullRequest.types).not.toContain('unlabeled')
    const issueEvents = workflowEvent(lifecycle, 'issues')
    expect(issueEvents.types).not.toContain('assigned')
    expect(issueEvents.types).not.toContain('unassigned')
    expect(issueEvents.types).toContain('typed')
    expect(issueEvents.types).toContain('untyped')
    const steps = lifecycleJob.steps.filter(isRecord)
    const tokenStep = steps.find(s => s.name === 'Create project token')
    const handleStep = steps.find(s => s.name === 'Handle repository event')
    expect(tokenStep?.if).toBeUndefined()
    expect(handleStep?.if).toBeUndefined()

    // issue-policy owns PR validation; it is read-only and a real gate.
    const policyPullRequest = workflowEvent(policy, 'pull_request')
    expect(policyPullRequest.types).toContain('ready_for_review')
  })

  it('mints Project credentials only after preflight and always revalidates current metadata', () => {
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const policyJob = workflowJob(policy, 'policy')
    if (!Array.isArray(policyJob.steps)) throw new TypeError('Issue policy job must define steps')
    const steps = policyJob.steps.filter(isRecord)
    const tokenStep = steps.find(step => step.name === 'Create Project read token')
    const validateStep = steps.find(step => step.name === 'Validate pull request')
    const preflightStep = steps.find(step => step.id === 'preflight')
    expect(preflightStep).toMatchObject({ shell: 'bash' })
    expect(preflightStep?.run).toContain('if [ -f .github/issue-management/selective-preflight.json ]; then')
    expect(preflightStep?.run).toContain('node .github/issue-management/policy.mjs pr-preflight')
    expect(preflightStep?.if).toBeUndefined()
    expect(policyJob.if).toBeUndefined()
    expect(validateStep?.if).toBe("${{ steps.preflight.outputs.legacy-automated != 'true' }}")

    expect(tokenStep).toMatchObject({
      id: 'app-token',
      if: "${{ steps.preflight.outputs.needs-project == 'true' }}",
      uses: 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
      with: {
        'client-id': '${{ vars.DSH_ISSUE_APP_CLIENT_ID }}',
        'private-key': '${{ secrets.DSH_ISSUE_APP_PRIVATE_KEY }}',
        owner: 'deepseek-harness',
        repositories: 'deepseek-harness',
        'permission-issues': 'read',
        'permission-organization-projects': 'read',
      },
    })
    expect(validateStep).toMatchObject({
      env: {
        GITHUB_TOKEN: '${{ github.token }}',
        PROJECT_TOKEN: '${{ steps.app-token.outputs.token }}',
      },
    })
  })
})

describe('npm release workflows', () => {
  it('passes the optional vendor channel as a quoted argument while preserving default publication', () => {
    const workflow = loadWorkflow('.github/workflows/release-vendor-publish.yml')
    expect(workflow.on).toMatchObject({
      workflow_dispatch: {
        inputs: {
          'dist-tag': {
            required: false,
            type: 'string',
            default: '',
          },
        },
      },
    })
    const publish = workflowJob(workflow, 'publish')
    expect(publish.steps).toContainEqual({
      name: 'Publish tarballs',
      env: {
        NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}',
        RELEASE_DIST_TAG: '${{ inputs.dist-tag }}',
      },
      run: [
        'args=()',
        'if [[ -n "$RELEASE_DIST_TAG" ]]; then',
        '  args+=(--dist-tag "$RELEASE_DIST_TAG")',
        'fi',
        'pnpm run release:publish --family vendor --from dist/npm-vendor "${args[@]}"',
        '',
      ].join('\n'),
    })
  })

  it('keeps publication dispatch-only and pack in the PR workflow', () => {
    // pack stays in the PR/master release workflows so a PR proves the set packs.
    for (const file of ['release.yml', 'release-vendor.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      expect(Object.keys(workflow.jobs).sort()).toEqual(file === 'release.yml' ? ['dependencies', 'pack'] : ['pack'])
    }

    // publication is workflow_dispatch-only (never a PR check) and keeps the
    // npm-publish environment plus the shared dist-tag group.
    for (const file of ['release-publish.yml', 'release-vendor-publish.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.on) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define on and jobs`)
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
      const publish = workflow.jobs.publish
      if (!isRecord(publish)) throw new TypeError(`${file} must define a publish job`)
      expect(publish.environment).toBe('npm-publish')
      expect(publish.concurrency).toMatchObject({ group: 'Release-publish' })
    }
  })

  it('runs dependency policy and npm layout checks in the DSH release workflow', () => {
    const workflow = loadWorkflow('.github/workflows/release.yml')
    const dependencies = workflowJob(workflow, 'dependencies')
    if (!isRecord(workflow.on) || !Array.isArray(dependencies.steps)) {
      throw new TypeError('DSH release workflow must define triggers and dependency steps')
    }
    const commands = dependencies.steps.flatMap(step =>
      isRecord(step) && typeof step.run === 'string' ? [step.run] : [])

    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(commands).toContain('pnpm run verify-package-dependencies')
    expect(commands).toContain('pnpm run verify-npm-install-layout')
  })
})

describe('Documentation site publication', () => {
  it('keeps Pages deployment dispatch-only from a dsh-v* tag', () => {
    const workflow = loadWorkflow('.github/workflows/docs-pages.yml')
    const build = workflowJob(workflow, 'build')
    const deploy = workflowJob(workflow, 'deploy')
    if (!isRecord(workflow.on) || !isRecord(workflow.env) || !Array.isArray(build.steps)) {
      throw new TypeError('Documentation deployment must define on, env, and build steps')
    }

    // The site presents a released snapshot: a merge must never publish it, and
    // publication must never appear as a PR check.
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])

    // RELEASE_PUBLISH makes release:verify reject every ref that is not a dsh-v*
    // tag naming this tree's version, so the site and the npm sequence share one
    // definition of a released version.
    const steps = build.steps.filter(isRecord)
    const verify = steps.find(step => step.name === 'Verify release version')
    const checkout = steps.find(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )
    expect(verify).toMatchObject({
      env: { RELEASE_PUBLISH: 'true' },
      run: 'pnpm run release:verify --family dsh',
    })
    // Complete history: the release scripts read tags.
    expect(checkout).toMatchObject({ with: { 'fetch-depth': 0 } })

    // Projected source links stay on the public repository's master. That
    // repository advances only to each release commit, so its master never
    // carries unreleased work, while it retains only the most recent tags:
    // following the dispatched tag would leave every source link on a deploy
    // from an older tag unresolvable.
    expect(workflow.env.DOCS_REPOSITORY_REF).toBe('master')

    // The environment owns the deployment tag policy and the required reviewers.
    expect(deploy.environment).toMatchObject({ name: 'github-pages' })
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function nodeStepSource(job: Record<string, unknown>, id: string): string {
  if (!Array.isArray(job.steps)) throw new Error('Node workflow job must define steps')
  const step: unknown = job.steps.find(value => isRecord(value) && value.id === id)
  if (!isRecord(step) || typeof step.run !== 'string') throw new Error(`Missing Node workflow step: ${id}`)
  const source = step.run.split("<<'JS'\n")[1]?.split('\nJS')[0]?.replace(/^import .*;\n/gm, '')
  if (source === undefined) throw new Error(`Workflow step ${id} must contain an executable Node script`)
  return source
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
