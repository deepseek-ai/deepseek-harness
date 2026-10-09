import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'
import { desktopTargetBuildPaths } from '../apps/desktop/scripts/desktop-build-paths.mjs'

const root = resolve(import.meta.dirname, '..')
const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/windows-package.yml'), 'utf8')) as {
  on: Record<string, { inputs: Record<string, { required?: boolean }> }>
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, {
    'runs-on': string
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

it('requires explicit manual dispatch on the dedicated Windows runner', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(job['runs-on']).toBe('dsh-win-package-trial')
  expect(workflow.concurrency).toEqual({ group: 'windows-desktop-package', 'cancel-in-progress': false })
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(workflow.on.workflow_dispatch!.inputs.policy_origin!.required).toBe(true)
  const checkout = job.steps.find(step => step.id === 'checkout')!
  expect(checkout.with).toMatchObject({ clean: true, 'persist-credentials': false })
  expect(job.steps.find(step => step.uses?.startsWith('pnpm/action-setup@'))?.with?.dest)
    .toBe('${{ runner.temp }}/setup-pnpm-${{ github.run_id }}-${{ github.run_attempt }}')
})

it('passes user input through environment variables and shares the validated version', () => {
  const settings = job.steps.find(step => step.id === 'settings')!
  expect(settings.env).toEqual({
    PACKAGE_BUILD_VERSION: '${{ inputs.build_version }}', PACKAGE_DEPLOYMENT: '${{ inputs.deployment }}',
    PACKAGE_POLICY_ORIGIN: '${{ inputs.policy_origin }}', PACKAGE_LOGIN_ORIGINS: '${{ inputs.login_origins }}',
  })
  const commands = job.steps.filter(step => step.run?.includes('pnpm run package:desktop:win:x64:unsigned'))
  expect(commands).toHaveLength(2)
  expect(commands[0]!.run).toContain('--check --build-version "$env:PACKAGE_VERSION"')
  expect(commands[1]!.run).toContain('unsigned --build-version "$env:PACKAGE_VERSION"')
  for (const step of commands) {
    expect(step.env?.PACKAGE_VERSION).toBe('${{ steps.settings.outputs.version }}')
    expect(step.run).toContain('exit $LASTEXITCODE')
  }
  for (const step of job.steps) expect(step.run ?? '').not.toContain('${{ inputs.')
  expect(job.steps.indexOf(settings)).toBeLessThan(job.steps.indexOf(commands[0]!))
})

it('retains failure diagnostics and only uploads successful installers from the owned output directory', () => {
  const uploads = job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  const logs = uploads.find(step => step.if === "always() && steps.checkout.outcome == 'success'")!
  expect(logs.with).toMatchObject({ path: 'apps/desktop/.desktop-build/packaging-runs/', 'include-hidden-files': true })
  const installer = uploads.find(step => step !== logs)!
  expect(installer.if).toBeUndefined()
  expect(installer.with).toMatchObject({
    path: `${relative(root, desktopTargetBuildPaths('win-x64').unsignedArtifacts).replaceAll('\\', '/')}/*.exe`,
    'include-hidden-files': true, 'if-no-files-found': 'error',
  })
  const cleanup = job.steps.find(step => step.run?.includes('Remove-Item -LiteralPath apps/desktop/.env.windows'))!
  expect(cleanup.if).toBe("always() && steps.checkout.outcome == 'success'")
  expect(cleanup.run).toContain('Test-Path -LiteralPath apps/desktop/.env.windows')
})
