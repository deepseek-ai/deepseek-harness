import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readDesktopThemeCache, writeDesktopThemeCache } from '../src/theme-cache.ts'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-theme-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  return directory
}

it('uses system appearance until a confirmed source is available', () => {
  const directory = fixture()
  expect(readDesktopThemeCache(directory)).toBe('system')
  for (const source of ['dark', 'light', 'system'] as const) {
    writeDesktopThemeCache(directory, source)
    expect(readDesktopThemeCache(directory)).toBe(source)
  }
})

it.each(['', '{invalid', 'DARK'])('uses system appearance for invalid cached source %j', (source) => {
  const directory = fixture()
  writeDesktopThemeCache(directory, 'dark')
  writeFileSync(join(directory, 'desktop', 'theme-cache'), source)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  expect(readDesktopThemeCache(directory)).toBe('system')
  expect(warn).toHaveBeenCalledOnce()
})

it('keeps an unusable cache from blocking startup or theme changes', () => {
  const directory = fixture()
  writeFileSync(join(directory, 'desktop'), 'not a directory')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  expect(() => { writeDesktopThemeCache(directory, 'dark') }).not.toThrow()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be saved'), expect.any(Error))
  expect(readDesktopThemeCache(directory)).toBe('system')
})
