/** The file clock ModuleFiles compares module files with. */
import * as fs from 'node:fs'
import { expect, it, vi } from 'vitest'
import { ModuleFiles } from '../src/module-files.ts'

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }))

it('reads the time from a new marker file and removes it', () => {
  const created = vi.spyOn(fs, 'mkdtempSync')
  try {
    const time = new ModuleFiles().now()
    expect(time).toBeGreaterThan(0)
    const directory = created.mock.results[0]?.value as string
    expect(fs.existsSync(directory)).toBe(false)
  } finally { created.mockRestore() }
})

it('falls back to the system clock when no marker can be created', () => {
  const created = vi.spyOn(fs, 'mkdtempSync').mockImplementationOnce(() => { throw new Error('read-only') })
  try {
    const before = Date.now()
    expect(new ModuleFiles().now()).toBeGreaterThanOrEqual(before)
  } finally { created.mockRestore() }
})
