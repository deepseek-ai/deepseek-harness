import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/desktop-publish.yml'), 'utf8')) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<string, {
    defaults?: unknown
    needs?: string | string[]
    env?: Record<string, string>
    if?: string
    environment?: string
    'runs-on': string | string[]
    steps: Array<{ id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }>
  }>
}

it('rejects debugging packages before dependency setup and pins the checked attempt for routing', () => {
  const steps = workflow.jobs.route!.steps
  const preflight = steps.findIndex(step => step.id === 'preflight')
  expect(preflight).toBeGreaterThan(0)
  expect(preflight).toBeLessThan(steps.findIndex(step => step.uses?.startsWith('pnpm/')))
  expect(steps[preflight]?.run).toBe('node apps/desktop/scripts/preflight-desktop-publish.mjs')
  expect(steps.find(step => step.id === 'route')?.env?.DESKTOP_PACKAGE_ATTEMPT).toBe('${{ steps.preflight.outputs.attempt }}')
})

it('selects packages manually and gates production secrets with the production Environment', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: {
    package_run_id: { type: 'string', required: true },
    package_run_attempt: { type: 'string', required: false, default: '' },
  } })
  expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' })
  expect(workflow.jobs.route?.if).toBeUndefined()
  const publish = workflow.jobs.publish!
  expect(publish.defaults).toBeUndefined()
  expect(publish.steps.find(step => step.id === 'key')?.run).toBe('node apps/desktop/scripts/read-desktop-app-key.mjs')
  expect(publish.if).toBeUndefined()
  expect(publish['runs-on']).toEqual(['self-hosted', '${{ needs.route.outputs.runner }}'])
  expect(publish.environment).toBe("${{ needs.prepare.outputs.preset == 'production' && 'desktop-production' || 'desktop-test' }}")
  const ids = publish.steps.map(step => step.id)
  expect(ids.indexOf('check')).toBeLessThan(ids.indexOf('key'))
  expect(ids.indexOf('key')).toBeLessThan(ids.indexOf('app'))
  expect(ids.indexOf('app')).toBeLessThan(ids.indexOf('publish'))
  for (const id of ['key', 'app']) expect(publish.steps.find(step => step.id === id)?.if)
    .toBe("needs.prepare.outputs.preset == 'production'")
  expect(publish.steps.find(step => step.id === 'app')?.with).toMatchObject({ 'permission-contents': 'write' })
  expect(publish.steps.find(step => step.id === 'publish')?.env?.DESKTOP_TAG_TOKEN).toBe('${{ steps.app.outputs.token }}')
})


it('prepares an approval digest without an Environment and binds the approved job to it', () => {
  const prepare = workflow.jobs.prepare!
  const publish = workflow.jobs.publish!
  expect(prepare.environment).toBeUndefined()
  expect(prepare.steps.find(step => step.id === 'local')?.run).toContain('resolve-retained-desktop-publish-ci.ts')
  expect(prepare.steps.find(step => step.id === 'check')?.env?.DESKTOP_PUBLISH_ROUTE).toBe('${{ steps.local.outputs.route }}')
  expect(publish.env?.DESKTOP_PUBLISH_ROUTE).toBe('${{ needs.prepare.outputs.route }}')
  expect(prepare.steps.find(step => step.id === 'check')?.run).toContain('--check')
  expect(prepare.steps.some(step => step.id === 'key' || step.id === 'app')).toBe(false)
  expect(publish.needs).toEqual(['route', 'prepare'])
  expect(publish.env?.DESKTOP_APPROVED_PACKAGE).toBe('${{ needs.prepare.outputs.approval }}')
})


it('rejects non-master dispatch before scheduling a self-hosted job', () => {
  const command = workflow.jobs.route!.steps[0]!.run!
  expect(command.startsWith('node -e "')).toBe(true)
  const program = command.slice('node -e "'.length, -1)
  for (const ref of ['refs/heads/master', 'refs/heads/stale-feature']) {
    const result = spawnSync(process.execPath, ['-e', program], { env: { ...process.env, GITHUB_REF: ref }, encoding: 'utf8' })
    expect(result.signal).toBeNull()
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(ref === 'refs/heads/master' ? 0 : 1)
    if (result.status !== 0) expect(result.stderr).toContain('must be dispatched from master')
  }
})
