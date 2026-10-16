import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/windows-package.yml'), 'utf8')) as {
  on: Record<string, { inputs: Record<string, { required?: boolean; default?: string; description?: string }> }>
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
  expect(workflow.concurrency).toEqual({ group: 'windows-desktop-package', 'cancel-in-progress': false })
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(Object.keys(workflow.on.workflow_dispatch!.inputs).sort()).toEqual([
    'build_version', 'preset', 'signing', 'source_ref', 'test_release_id', 'update_channel', 'version_mode',
  ])
  expect(workflow.on.workflow_dispatch!.inputs.signing!.default).toBe('signed')
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
  expect(uploads[0]!.with).toMatchObject({ path: 'apps/desktop/.desktop-build/packaging-runs/', 'include-hidden-files': true })
  for (const mode of ['unsigned', 'signed']) {
    const upload = uploads.find(step => step.if === `success() && inputs.signing == '${mode}'`)!
    expect(upload.with).toMatchObject({ path: '${{ steps.retained.outputs.directory }}/*', 'if-no-files-found': 'error' })
  }
})
