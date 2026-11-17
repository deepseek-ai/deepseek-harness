import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { load } from 'js-yaml'
import { z } from 'zod'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const step = z.object({
  uses: z.string().optional(), run: z.string().optional(),
  'working-directory': z.string().optional(),
  with: z.object({ path: z.string().optional() }).loose().optional(),
}).loose()
const workflowSchema = z.object({ jobs: z.record(z.string(), z.object({ steps: z.array(step) }).loose()) })

it('loads every rollout entry from its own installed package and the correct job checkout', () => {
  const workflow = workflowSchema.parse(load(readFileSync(resolve(root, '.github/workflows/desktop-rollout.yml'), 'utf8')))
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find(entry => entry.uses?.startsWith('actions/checkout@'))
    const checkoutRoot = resolve(root, checkout?.with?.path ?? '.')
    const install = job.steps.find(entry => entry.run?.includes(' install '))
    expect(install?.run).toContain('--filter @deepseek-ai/dsh-desktop-publisher --fail-if-no-match install --prod --frozen-lockfile --ignore-scripts')
    for (const entry of job.steps) {
      if (!entry.run?.startsWith('node --import tsx ')) continue
      const directory = relative(checkoutRoot, resolve(root, entry['working-directory'] ?? '.'))
      expect(directory).toBe(join('apps', 'desktop-publisher'))
      const script = entry.run.split(' ')[3]!
      expect(existsSync(resolve(root, directory, script))).toBe(true)
    }
    expect(job.steps.some(entry => entry.run?.includes('pnpm exec'))).toBe(false)
  }
})

it.each(['desktop-rollout.yml', 'desktop-publish.yml'])('keeps %s preflights executable before install', (filename) => {
  const workflow = workflowSchema.parse(load(readFileSync(resolve(root, '.github/workflows', filename), 'utf8')))
  let preflights = 0
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find(entry => entry.uses?.startsWith('actions/checkout@'))
    const checkoutRoot = resolve(root, checkout?.with?.path ?? '.')
    for (const [index, entry] of job.steps.entries()) {
      if (!entry.run?.startsWith('node apps/desktop-publisher/src/preflight-')) continue
      preflights++
      const directory = relative(checkoutRoot, resolve(root, entry['working-directory'] ?? '.'))
      expect(directory).toBe('')
      expect(existsSync(resolve(root, entry.run.split(' ')[1]!))).toBe(true)
      expect(index).toBeLessThan(job.steps.findIndex(candidate => candidate.run?.includes(' install ')))
    }
  }
  expect(preflights).toBe(5)
})

it('separates rollout checkouts from full-workspace publication checkouts', () => {
  const read = (filename: string) => workflowSchema.parse(load(readFileSync(resolve(root, '.github/workflows', filename), 'utf8')))
  const paths = (filename: string) => Object.values(read(filename).jobs).flatMap(job => job.steps.flatMap(entry => entry.uses?.startsWith('actions/checkout@') && entry.with?.path ? [entry.with.path] : []))
  const full = new Set(paths('desktop-publish.yml'))
  for (const path of paths('desktop-rollout.yml')) expect(full.has(path)).toBe(false)
})
