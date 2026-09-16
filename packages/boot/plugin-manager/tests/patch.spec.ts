/** Profile patch edits preserve user-authored syntax and are idempotent. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { writePluginEnabled } from '../src/patch.ts'

async function fixture(text?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'manager-patch-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'cordis.patch.yml')
  if (text !== undefined) await writeFile(file, text)
  return file
}

it('preserves comments, expressions, unrelated configuration and the last override', async () => {
  const file = await fixture('# personal configuration\n- id: tool\n  config:\n    value: !!js process.platform\n- id: tool\n  disabled: false # availability\n')
  expect(await writePluginEnabled(file, 'tool', 'package', false)).toBe(true)
  const text = await readFile(file, 'utf8')
  expect(text).toContain('# personal configuration')
  expect(text).toContain('!!js process.platform')
  expect(text).toContain('# availability')
  expect(loadOptionalPatches('test', file)).toEqual([
    { id: 'tool', config: { value: { __jsExpr: 'process.platform' } } }, { id: 'tool', disabled: true },
  ])
  expect(await writePluginEnabled(file, 'tool', 'package', false)).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(text)
  expect(await writePluginEnabled(file, 'tool', 'package', true)).toBe(true)
})

it('creates a missing patch file and appends after insertions', async () => {
  const file = await fixture()
  await writePluginEnabled(file, 'tool', 'package', false)
  expect(loadOptionalPatches('test', file)).toEqual([{ id: 'tool', disabled: true }])
  await writeFile(file, '- insert:\n    - id: tool\n      name: package\n')
  await writePluginEnabled(file, 'tool', 'package', true)
  expect(loadOptionalPatches('test', file)).toEqual([
    { insert: [{ id: 'tool', name: 'package' }] }, { id: 'tool', disabled: false },
  ])
})

it.each(['- id: [broken', 'mapping: true\n'])('refuses malformed documents without overwriting %s', async (text) => {
  const file = await fixture(text)
  await expect(writePluginEnabled(file, 'tool', 'package', true)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe(text)
})


it('retains name-asserting overrides and appends an unambiguous switch', async () => {
  const file = await fixture('- id: tool\n  name: another-package\n  disabled: false\n')
  await writePluginEnabled(file, 'tool', 'package', false)
  expect(loadOptionalPatches('test', file)).toEqual([
    { id: 'tool', name: 'another-package', disabled: false }, { id: 'tool', disabled: true },
  ])
  expect(await writePluginEnabled(file, 'tool', 'package', false)).toBe(false)
})

it('reports read failures without replacing a directory with configuration', async () => {
  const file = await fixture()
  await mkdir(file)
  await expect(writePluginEnabled(file, 'tool', 'package', true)).rejects.toThrow()
})

it('updates the last matching named override and leaves mismatched names untouched', async () => {
  const file = await fixture('- id: tool\n  disabled: true\n- id: tool\n  name: package\n  config:\n    value: !!js process.platform\n  disabled: true # availability\n- id: tool\n  name: another-package\n  disabled: true\n')
  expect(await writePluginEnabled(file, 'tool', 'package', true)).toBe(true)
  const text = await readFile(file, 'utf8')
  expect(text).toContain('!!js process.platform')
  expect(text).toContain('# availability')
  const patches = loadOptionalPatches('test', file)
  expect(patches).toEqual([
    { id: 'tool', disabled: true },
    { id: 'tool', name: 'package', config: { value: { __jsExpr: 'process.platform' } }, disabled: false },
    { id: 'tool', name: 'another-package', disabled: true },
  ])
  expect(applyEntryPatches([{ id: 'tool', name: 'package' }], patches, () => {}))
    .toMatchObject([{ id: 'tool', name: 'package', disabled: false }])
  expect(await writePluginEnabled(file, 'tool', 'package', true)).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(text)
  expect(await writePluginEnabled(file, 'tool', 'package', false)).toBe(true)
  expect(loadOptionalPatches('test', file)).toHaveLength(3)
})
