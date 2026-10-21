import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/macos-package.yml'), 'utf8')) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, {
    'runs-on': string[]
    steps: Array<{ id?: string; name?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown> }>
  }>
}

it('confines signed Mac packaging to manual dispatch and a dedicated Apple Silicon runner', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.jobs.package).not.toHaveProperty('name')
  expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: { test_release_id: { type: 'string', default: '', required: false } } })
  expect(workflow.on.workflow_dispatch).not.toHaveProperty('inputs.publish')
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(workflow.concurrency).toEqual({ group: 'macos-desktop-package', 'cancel-in-progress': false })
  expect(workflow.jobs.package!['runs-on']).toEqual(['self-hosted', 'macOS', 'ARM64', 'dsh-mac-package-trial'])
  const steps = workflow.jobs.package!.steps
  expect(steps.find(step => step.id === 'checkout')?.with).toMatchObject({ 'persist-credentials': false, clean: true })
  for (const step of steps) expect(step.run ?? '').not.toContain('${{ inputs.')
  const uploads = steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  expect(uploads).toHaveLength(2)
  expect(uploads[0]?.if).toBe("always() && steps.checkout.outcome == 'success'")
  expect(uploads[1]?.if).toBe('success()')
  expect(uploads[1]?.with?.path).toBe('${{ steps.retained.outputs.directory }}/*')
})

it('defaults to notarization and labels the explicit debugging option', () => {
  expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: { skip_notarization: {
    type: 'boolean', default: false,
    description: '跳过公证和 stapling：仅限内部调试，禁止发布到 test / production 或用于自动更新；需要发布请勿勾选',
  } } })
  const steps = workflow.jobs.package!.steps
  expect(steps.filter(step => step.run?.includes('args+=(--skip-notarization)'))).toHaveLength(2)
  expect(steps.find(step => step.name === 'Retain installers for the selected mode')?.with?.name).toContain('${{ steps.settings.outputs.mode }}')
})
