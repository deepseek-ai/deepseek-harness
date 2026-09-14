import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { bundleWorkflowGuest, generateWorkflowGuest } from './gen-workflow-guest.ts'

async function fixture(source: string): Promise<{ root: string; entry: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-guest-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'packages/workflow/workflow-ptc/src')
  await mkdir(directory, { recursive: true })
  await writeFile(join(root, 'tsconfig.base.json'), '{"compilerOptions":{"target":"es2024"}}\n')
  const entry = join(directory, 'guest.ts')
  await writeFile(entry, source)
  return { root, entry, output: join(directory, 'guest-source.ts') }
}

it('bundles source imports into a module that loads without their files', async () => {
  const { root, entry } = await fixture('import { answer } from "./answer.ts"; import { isBuiltin } from "node:module"; export const result = [answer, isBuiltin("node:vm")];')
  await writeFile(join(entry, '..', 'answer.ts'), 'export const answer: number = 42;')
  const source = await bundleWorkflowGuest(root)
  await rm(join(root, 'packages'), { recursive: true })
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`) as { result: unknown }
  expect(module.result).toEqual([42, true])
  expect(source).not.toContain(root)
})

it('rejects unresolved imports instead of shipping an unavailable guest dependency', async () => {
  const { root } = await fixture('import "dsh-nonexistent-workflow-dependency";')
  await expect(bundleWorkflowGuest(root)).rejects.toThrow('workflow guest has an unresolved import')
})

it('checks the generated artifact against the current source and does not rewrite stale output', async () => {
  const { root, entry, output } = await fixture('export const answer: number = 42;')
  await generateWorkflowGuest(root, false)
  const original = await readFile(output, 'utf8')
  await generateWorkflowGuest(root, true)
  await generateWorkflowGuest(root, false)
  expect(await readFile(output, 'utf8')).toBe(original)
  await writeFile(entry, 'export const answer: number = 43;')
  await expect(generateWorkflowGuest(root, true)).rejects.toThrow('workflow guest source is stale')
  expect(await readFile(output, 'utf8')).toBe(original)
})
