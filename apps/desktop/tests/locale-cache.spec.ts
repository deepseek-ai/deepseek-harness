import { SHIPPED_LOCALE_IDS } from '../../../scripts/shipped-locales.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readDesktopLocaleCache, writeDesktopLocaleCache } from '../src/locale-cache.ts'
import { resolveDesktopLocale, resolveDesktopStartupLocale } from '../src/locale.ts'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-locale-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  return directory
}

it('uses the confirmed Chinese language for recovery before Host settings are available', () => {
  const directory = fixture()
  expect(readDesktopLocaleCache(directory)).toBeUndefined()
  writeDesktopLocaleCache(directory, 'zh-CN')
  const cached = readDesktopLocaleCache(directory)
  const locale = cached === undefined ? resolveDesktopStartupLocale(null, ['en-US']) : resolveDesktopLocale(cached)
  expect(locale.messages.fatalSummary).toBe('应用无法启动或已意外停止。')
  writeDesktopLocaleCache(directory, 'en')
  expect(readDesktopLocaleCache(directory)).toBe('en')
})

it('uses the confirmed Japanese language for recovery before Host settings are available', () => {
  const directory = fixture()
  writeDesktopLocaleCache(directory, 'ja')
  const cached = readDesktopLocaleCache(directory)
  const locale = cached === undefined ? resolveDesktopStartupLocale(null, ['en-US']) : resolveDesktopLocale(cached)
  expect(locale.id).toBe('ja')
  expect(locale.messages.getDiagnosticReport).toBe('診断レポートを取得')
})

it.each(SHIPPED_LOCALE_IDS)('restores the confirmed shipped language %s before Host settings are available', (id) => {
  const directory = fixture()
  const selected = resolveDesktopLocale(id)
  writeDesktopLocaleCache(directory, selected.id)
  const cached = readDesktopLocaleCache(directory)
  expect(cached).toBe(selected.id)
  expect(resolveDesktopLocale(cached!).messages.getDiagnosticReport).toBe(selected.messages.getDiagnosticReport)
})

it.each(['', 'it', '{invalid'])('falls back to system language for an invalid cache: %s', (value) => {
  const directory = fixture()
  writeDesktopLocaleCache(directory, 'en')
  writeFileSync(join(directory, 'desktop', 'locale-cache'), value)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  expect(readDesktopLocaleCache(directory)).toBeUndefined()
  expect(warn).toHaveBeenCalled()
})

it('keeps read and write failures from blocking recovery', () => {
  const directory = fixture()
  writeFileSync(join(directory, 'desktop'), 'not a directory')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  expect(() => { writeDesktopLocaleCache(directory, 'zh-CN') }).not.toThrow()
  expect(readDesktopLocaleCache(directory)).toBeUndefined()
  expect(warn).toHaveBeenCalled()
})
