/** File failures between validation and commit must not persist partial edits. */
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { configurationFixture } from './configuration-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn(original.readFile) }
})
afterEach(() => { vi.mocked(fs.readFile).mockReset() })

it.each([
  ['denied read', Object.assign(new Error('denied read'), { code: 'EACCES' })],
  ['truncated YAML', '- id: ['],
  ['wrong document', '{}'],
] as const)('refuses %s observed after initial validation', async (_name, result) => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  const before = readFileSync(profile.patchPath, 'utf8')
  const read = vi.mocked(fs.readFile)
  if (typeof result === 'string') read.mockResolvedValueOnce(result)
  else read.mockRejectedValueOnce(result)
  await expect(ctx.configEditor.edit(entry, raw => ({ ...raw, count: 6 }))).rejects.toThrow()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})

it('creates a patch removed between validation and reading the document', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error('removed'), { code: 'ENOENT' }))
  await ctx.configEditor.edit(entry, raw => ({ ...raw, count: 6 }))
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('count: 6')
})
