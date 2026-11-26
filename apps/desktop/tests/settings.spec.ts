import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { readDesktopSettings } from '../src/settings.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'dsh-desktop-settings-'))
  onTestFinished(() => { rmSync(userData, { recursive: true, force: true }) })
  const directory = join(userData, 'desktop')
  mkdirSync(directory)
  return { userData, path: join(directory, 'settings.json') }
}

it('creates a discoverable version 1 default file on first launch without touching other preferences', async () => {
  const { userData, path } = fixture()
  rmSync(join(userData, 'desktop'), { recursive: true })
  writeFileSync(join(userData, 'keybindings.json'), 'existing shortcuts\n')
  expect(await readDesktopSettings(userData)).toEqual({ updates: { allowTestAuthPopupWindow: false } })
  expect(readFileSync(path, 'utf8')).toBe('{\n  "version": "1",\n  "updates": {\n    "allowTestAuthPopupWindow": false\n  }\n}\n')
  expect(readFileSync(join(userData, 'keybindings.json'), 'utf8')).toBe('existing shortcuts\n')
})

it('migrates unversioned documents to version 1 and resets legacy nightly preferences to stable', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{"other": 1, "updates": {"other": true, "channel": "nightly"}}')
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    version: '1',
    other: 1,
    updates: { other: true, channel: 'stable' },
  })
})

it('loads explicit opt-in and opt-out on version 1 documents without rewriting them or changing an earlier snapshot', async () => {
  const { userData, path } = fixture()
  for (const allow of [true, false]) {
    const raw = JSON.stringify({ version: '1', updates: { allowTestAuthPopupWindow: allow }, custom: 'preserve' })
    writeFileSync(path, raw)
    expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(allow)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  }
  const previous = await readDesktopSettings(userData)
  writeFileSync(path, '{"version":"1","updates":{"allowTestAuthPopupWindow":true}}')
  expect(previous.updates.allowTestAuthPopupWindow).toBe(false)
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(true)
})

it.each([
  '', '{', 'null', '[]', '{"updates":null}', '{"updates":[]}', '{"version":"2"}', '{"version":1}',
  '{"updates":{"allowTestAuthPopupWindow":"false"}}', '{"updates":{"allowTestAuthPopupWindow":1}}',
  '{"updates":{"allowTestAuthPopupWindow":null}}',
])('reports invalid settings with their path and preserves the original: %s', async (raw) => {
  const { userData, path } = fixture()
  writeFileSync(path, raw)
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('reports filesystem errors instead of replacing unreadable settings', async () => {
  const { userData, path } = fixture()
  mkdirSync(path)
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
  expect(fs.statSync(path).isDirectory()).toBe(true)
})

it.each(['mkdir', 'writeFile'] as const)('continues with disabled popups when %s fails', async (operation) => {
  const { userData, path } = fixture()
  const failure = Object.assign(new Error('settings creation denied'), { code: 'EACCES' })
  vi.spyOn(fsp, operation).mockRejectedValue(failure)
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.objectContaining({ cause: failure }))
})

it('continues with defaults even when warning output fails', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{')
  vi.mocked(console.warn).mockImplementation(() => { throw new Error('output unavailable') })
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe('{')
})
