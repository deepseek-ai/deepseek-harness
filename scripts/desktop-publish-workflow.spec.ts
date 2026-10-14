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

it('routes only completed package requests and gates production secrets with the production Environment', () => {
  expect(workflow.on).toEqual({ workflow_run: {
    workflows: ['Package Desktop · macOS', 'Package Desktop · Windows'], types: ['completed'],
  } })
  expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' })
  expect(workflow.jobs.route?.if).toBe("github.event.workflow_run.conclusion == 'success'")
  const publish = workflow.jobs.publish!
  expect(publish.defaults).toBeUndefined()
  expect(publish.steps.find(step => step.id === 'key')?.run).toBe('node apps/desktop/scripts/read-desktop-app-key.mjs')
  expect(publish.if).toBe("needs.route.outputs.publish == 'true'")
  expect(publish['runs-on']).toEqual(['self-hosted', '${{ needs.route.outputs.runner }}'])
  expect(publish.environment).toBe("${{ needs.route.outputs.preset == 'production' && 'desktop-production' || 'desktop-test' }}")
  const ids = publish.steps.map(step => step.id)
  expect(ids.indexOf('check')).toBeLessThan(ids.indexOf('key'))
  expect(ids.indexOf('key')).toBeLessThan(ids.indexOf('app'))
  expect(ids.indexOf('app')).toBeLessThan(ids.indexOf('publish'))
  for (const id of ['key', 'app']) expect(publish.steps.find(step => step.id === id)?.if)
    .toBe("needs.route.outputs.preset == 'production'")
  expect(publish.steps.find(step => step.id === 'app')?.with).toMatchObject({ 'permission-contents': 'write' })
  expect(publish.steps.find(step => step.id === 'publish')?.env?.DESKTOP_TAG_TOKEN).toBe('${{ steps.app.outputs.token }}')
})


it('prepares an approval digest without an Environment and binds the approved job to it', () => {
  const prepare = workflow.jobs.prepare!
  const publish = workflow.jobs.publish!
  expect(prepare.environment).toBeUndefined()
  expect(prepare.steps.find(step => step.id === 'check')?.run).toContain('--check')
  expect(prepare.steps.some(step => step.id === 'key' || step.id === 'app')).toBe(false)
  expect(publish.needs).toEqual(['route', 'prepare'])
  expect(publish.env?.DESKTOP_APPROVED_PACKAGE).toBe('${{ needs.prepare.outputs.approval }}')
})
