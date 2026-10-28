import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parse, resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/windows-package.yml'), 'utf8')) as {
  on: Record<string, { inputs: Record<string, { type?: string; required?: boolean; default?: string; description?: string }> }>
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, {
    'runs-on': string
    env: Record<string, string>
    steps: Array<{
      id?: string
      name?: string
      uses?: string
      run?: string
      if?: string
      'working-directory'?: string
      env?: Record<string, string>
      with?: Record<string, unknown>
    }>
  }>
}
const job = workflow.jobs.package!

it.skipIf(process.platform !== 'win32')('resets only the allocated checkout without following dependency junctions', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'windows-checkout-'))
  try {
    const parent = resolve(directory, 'runner-workspace')
    const workspace = resolve(parent, 'repository')
    const external = resolve(directory, 'external')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(external)
    writeFileSync(resolve(external, 'keep.txt'), 'keep')
    symlinkSync(external, resolve(workspace, 'node_modules'), 'junction')
    const script = resolve(directory, 'reset.ps1')
    writeFileSync(script, job.steps.find(step => step.name === 'Reset packaging checkout')!.run!)
    const run = (target: string) => execFileSync('pwsh', ['-NoProfile', '-File', script], {
      cwd: directory,
      env: { ...process.env, RUNNER_WORKSPACE: parent, GITHUB_WORKSPACE: target },
      stdio: 'pipe',
    })
    run(workspace)
    expect(existsSync(workspace)).toBe(true)
    expect(existsSync(resolve(workspace, 'node_modules'))).toBe(false)
    expect(readFileSync(resolve(external, 'keep.txt'), 'utf8')).toBe('keep')
    expect(() => run(external)).toThrow()
    rmSync(workspace, { recursive: true })
    symlinkSync(external, workspace, 'junction')
    expect(() => run(workspace)).toThrow()
    expect(readFileSync(resolve(external, 'keep.txt'), 'utf8')).toBe('keep')
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

it('routes manual packaging to the dedicated runner with explicit preset and signing selection', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.jobs.package).not.toHaveProperty('name')
  expect(job['runs-on']).toBe('dsh-win-package-trial')
  expect(JSON.stringify(job.env)).not.toContain('runner.')
  expect(job.steps.find(step => step.name === 'Configure persistent pnpm store')?.env?.DSH_DESKTOP_PACKAGE_CACHE_DIR)
    .toBe('${{ runner.tool_cache }}/dsh-desktop-package-cache')
  expect(workflow.concurrency).toEqual({ group: 'windows-desktop-package', 'cancel-in-progress': false })
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(Object.keys(workflow.on.workflow_dispatch!.inputs).sort()).toEqual([
    'build_version', 'cache_namespace', 'compression_level', 'preset', 'signing', 'source_ref', 'test_release_id', 'update_channel', 'version_mode',
  ])
  expect(workflow.on.workflow_dispatch!.inputs.signing!.default).toBe('signed')
  expect(workflow.on.workflow_dispatch!.inputs.compression_level).toMatchObject({ type: 'choice', options: ['3', '7'], default: '3', required: true })
  expect(job.env.PACKAGE_WINDOWS_COMPRESSION_LEVEL).toBe('${{ inputs.compression_level }}')
  expect(workflow.on.workflow_dispatch!.inputs.build_version!.required).toBe(false)
  expect(workflow.on.workflow_dispatch!.inputs.version_mode!.default).toBe('default')
  expect(workflow.on.workflow_dispatch!.inputs.source_ref!.default).toBe('master')
  expect(workflow.on.workflow_dispatch!.inputs.update_channel!.default).toBe('nightly')
  expect(job.env.PACKAGE_VERSION_MODE).toBe('${{ inputs.version_mode }}')
  expect(job.env.PACKAGE_SOURCE_REF).toBe('${{ inputs.source_ref }}')
  expect(job.env.DSH_DESKTOP_UPDATE_CHANNEL).toBe('${{ inputs.update_channel }}')
  expect(job.env.DSH_PACKAGING_PRESET).toBe('${{ inputs.preset }}')
  expect(job.env.PACKAGE_SIGNING).toBe('${{ inputs.signing }}')
  expect(job.steps.find(step => step.id === 'checkout')!.with).toMatchObject({ clean: true, 'persist-credentials': false, ref: '${{ inputs.source_ref }}' })
  expect(job.steps.find(step => step.uses?.startsWith('pnpm/action-setup@'))?.with?.dest)
    .toBe('${{ runner.temp }}/setup-pnpm-${{ github.run_id }}-${{ github.run_attempt }}')
})

it('validates before building and passes the same mode and version to checks and packaging', () => {
  const settings = job.steps.find(step => step.id === 'settings')!
  expect(settings.env).toEqual({ PACKAGE_BUILD_VERSION: '${{ inputs.build_version }}' })
  const commands = job.steps.filter(step => step.run?.includes('package:desktop:win:x64'))
  expect(commands).toHaveLength(2)
  expect(commands[0]!.run).toContain("'--check'")
  for (const step of commands) {
    expect(step.env?.PACKAGE_VERSION).toBe('${{ steps.settings.outputs.version }}')
    expect(step.run).toContain("if ($env:PACKAGE_SIGNING -eq 'unsigned') { $packageArgs += '--unsigned' }")
    expect(step.run).toContain('exit $LASTEXITCODE')
  }
  for (const step of job.steps) expect(step.run ?? '').not.toContain('${{ inputs.')
  expect(job.steps.indexOf(settings)).toBeLessThan(job.steps.indexOf(commands[0]!))
  expect(job.steps.some(step => step.run?.includes('.env.windows'))).toBe(false)
})

it('retains failure diagnostics and uploads only the selected successful installer', () => {
  const uploads = job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  expect(uploads).toHaveLength(3)
  expect(uploads[0]!.if).toBe("always() && steps.checkout.outcome == 'success'")
  expect(uploads[0]!.with).toMatchObject({
    path: '${{ github.workspace }}/apps/desktop/.desktop-build/packaging-runs/',
    'include-hidden-files': true,
  })
  for (const mode of ['unsigned', 'signed']) {
    const upload = uploads.find(step => step.if === `success() && inputs.signing == '${mode}'`)!
    expect(upload.with).toMatchObject({ path: '${{ steps.retained.outputs.directory }}/*', 'if-no-files-found': 'error', 'compression-level': 0 })
  }
})

it('normalizes priority in the dependency and packaging shells before launching their children', () => {
  const command = '& "$env:PACKAGE_CI_HELPERS/windows-packaging-priority.ps1" -BestEffort'
  expect(job.steps.find(entry => entry.name === 'Validate selected source and adapter support')!.run)
    .not.toContain('windows-packaging-priority.ps1')
  for (const name of ['Install locked dependencies', 'Build installer and verify packaged runtime']) {
    const step = job.steps.find(entry => entry.name === name)!
    expect(step.run!.trimStart().startsWith(command + '\n')).toBe(true)
  }
})

it.skipIf(process.platform !== 'win32')('keeps the dependency store stable across run-specific pnpm homes', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'windows-package-store-'))
  try {
    const workspace = resolve(directory, 'runner', 'repo')
    const packageCache = resolve(directory, 'tool-cache', 'desktop')
    const store = resolve(parse(directory).root, '.pnpm-store')
    const step = job.steps.find(entry => entry.name === 'Configure persistent pnpm store')!
    expect(job.steps.indexOf(step)).toBeLessThan(job.steps.findIndex(entry => entry.name === 'Install locked dependencies'))
    const script = resolve(directory, 'store.ps1')
    writeFileSync(script, "$ErrorActionPreference = 'Stop'\n" + step.run!)
    const outputs = ['first', 'second'].map((run) => {
      const environmentFile = resolve(directory, run + '.env')
      execFileSync('pwsh', ['-NoProfile', '-File', script], {
        env: { ...process.env, GITHUB_WORKSPACE: workspace,
          PACKAGE_CACHE_NAMESPACE: '', DSH_DESKTOP_PACKAGE_CACHE_DIR: packageCache,
          PNPM_HOME: resolve(directory, run, 'pnpm'), GITHUB_ENV: environmentFile },
        stdio: 'pipe',
      })
      return readFileSync(environmentFile, 'utf8').trim()
    })
    expect(outputs.map(output => output.split(/\r?\n/u))).toEqual(Array.from({ length: 2 }, () => [
      `DSH_DESKTOP_PACKAGE_CACHE_DIR=${packageCache}`, `PNPM_CONFIG_STORE_DIR=${store}`,
    ]))
    const runNamespace = (namespace: string) => {
      const output = resolve(directory, 'namespace.env')
      rmSync(output, { force: true })
      execFileSync('pwsh', ['-NoProfile', '-File', script], {
        env: { ...process.env, GITHUB_WORKSPACE: workspace,
          PACKAGE_CACHE_NAMESPACE: namespace, DSH_DESKTOP_PACKAGE_CACHE_DIR: packageCache, GITHUB_ENV: output },
        stdio: 'pipe',
      })
      return readFileSync(output, 'utf8').trim().split(/\r?\n/u)
    }
    expect(runNamespace('perf-1')).toEqual([
      `DSH_DESKTOP_PACKAGE_CACHE_DIR=${resolve(packageCache, 'perf-1')}`, `PNPM_CONFIG_STORE_DIR=${resolve(store, 'perf-1')}`,
    ])
    for (const invalid of ['../escape', 'Upper', 'has space', 'con', 'perf\n', 'a'.repeat(65)]) {
      expect(() => runNamespace(invalid)).toThrow()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

it('pins environment helpers to the workflow commit before selecting product source', () => {
  const helper = job.steps.find(step => step.name === 'Checkout workflow helpers')!
  const stage = job.steps.find(step => step.name === 'Stage workflow helpers')!
  const source = job.steps.find(step => step.id === 'checkout')!
  expect(helper.with).toMatchObject({ ref: '${{ github.workflow_sha }}', 'persist-credentials': false })
  expect(job.steps.indexOf(helper)).toBeLessThan(job.steps.indexOf(stage))
  expect(job.steps.indexOf(stage)).toBeLessThan(job.steps.indexOf(source))
  expect(stage.run).toContain('RUNNER_TEMP')
  expect(stage.run).toContain('windows-packaging-priority.ps1')
  for (const step of job.steps.filter(step => step.name !== 'Stage workflow helpers')) {
    expect(step.run ?? '').not.toContain('./apps/desktop/scripts/windows-packaging-priority.ps1')
  }
})

it.skipIf(process.platform !== 'win32')('stages helpers that remain usable when product source lacks them', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'workflow-helpers-'))
  try {
    const source = resolve(directory, 'source')
    const scripts = resolve(source, 'apps/desktop/scripts')
    const temporary = resolve(directory, 'temporary')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(temporary)
    for (const name of ['windows-packaging-priority.ps1']) {
      writeFileSync(resolve(scripts, name), readFileSync(resolve(root, 'apps/desktop/scripts', name)))
    }
    const stage = resolve(directory, 'stage.ps1')
    writeFileSync(stage, job.steps.find(step => step.name === 'Stage workflow helpers')!.run!)
    const env = { ...process.env, RUNNER_TEMP: temporary, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_ENV: resolve(directory, 'env') }
    execFileSync('pwsh', ['-NoProfile', '-File', stage], { cwd: source, env, stdio: 'pipe' })
    rmSync(scripts, { recursive: true })
    const helper = resolve(temporary, 'packaging-helpers-123-1/windows-packaging-priority.ps1')
    expect(execFileSync('pwsh', ['-NoProfile', '-File', helper, '-InspectOnly'], { cwd: source, stdio: 'pipe' }).toString())
      .toContain('packaging-process-priority')
    expect(() => execFileSync('pwsh', ['-NoProfile', '-File', stage], {
      cwd: source, env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, stdio: 'pipe',
    })).toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
