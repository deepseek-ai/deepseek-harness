import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readDesktopSettings } from '../src/settings.ts'
import { DesktopUpdateSettings } from '../src/update-settings.ts'
import { DesktopSettingsFile, DesktopSettingsFileError } from '../src/settings-file.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-channel-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'desktop'))
  return new DesktopUpdateSettings(root, 'stable')
}

it('uses the packaged channel for missing settings without recreating the document', async () => {
  const settings = await fixture()
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'stable' })
  await expect(readFile(settings.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves other fields during explicit saves and only rereads external edits on load', async () => {
  const settings = await fixture()
  await writeFile(settings.path, JSON.stringify({ updates: { allowTestAuthPopupWindow: true }, other: 4 }))
  const startup = await settings.load()
  await settings.save('nightly')
  expect(startup).toEqual({ kind: 'ready', channel: 'stable' })
  expect(JSON.parse(await readFile(settings.path, 'utf8'))).toEqual({ updates: { allowTestAuthPopupWindow: true, channel: 'nightly' }, other: 4 })
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'nightly' })
  await writeFile(settings.path, '{}')
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'stable' })
})

it.each(['{', 'null', '{"updates":[]}', '{"updates":{"channel":"alpha"}}', '{"updates":{"channel":null}}'])('suspends updates for invalid channel settings: %s', async (raw) => {
  const settings = await fixture()
  await writeFile(settings.path, raw)
  expect(await settings.load()).toMatchObject({ kind: 'error', error: { problem: { kind: 'invalid' }, path: settings.path } })
  expect(await readFile(settings.path, 'utf8')).toBe(raw)
})

it('refuses to replace malformed user JSON during a UI save', async () => {
  const settings = await fixture()
  await writeFile(settings.path, '{')
  await expect(settings.save('nightly')).rejects.toBeInstanceOf(DesktopSettingsFileError)
  expect(await readFile(settings.path, 'utf8')).toBe('{')
})

it('reports unreadable configuration instead of silently choosing a default', async () => {
  const settings = await fixture()
  await mkdir(settings.path)
  expect(await settings.load()).toMatchObject({ kind: 'error', error: { problem: { kind: 'read' } } })
})

it('updates the document initialized by shell settings without losing the popup preference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-shared-settings-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  expect((await readDesktopSettings(root)).updates.allowTestAuthPopupWindow).toBe(false)
  const settings = new DesktopUpdateSettings(root, 'stable')
  await settings.save('nightly')
  expect(JSON.parse(await readFile(settings.path, 'utf8'))).toEqual({
    updates: { allowTestAuthPopupWindow: false, channel: 'nightly' },
  })
  expect((await readDesktopSettings(root)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'nightly' })
})

// Storage has already classified the write; the channel consumer must not retry it.
it.each(['written', 'unknown', 'unchanged'] as const)('handles the %s write outcome without retrying', async (effect) => {
  const settings = await fixture()
  const failure = new DesktopSettingsFileError({ kind: 'write', operation: 'save', effect }, settings.path,
    { cause: new Error('injected storage failure') })
  const save = vi.spyOn(DesktopSettingsFile.prototype, 'saveUpdates').mockRejectedValueOnce(failure)
  const read = vi.spyOn(DesktopSettingsFile.prototype, 'read')
  try {
    if (effect === 'written') await expect(settings.save('nightly')).resolves.toBeUndefined()
    else await expect(settings.save('nightly')).rejects.toBe(failure)
    expect(save).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(`${settings.path}.save.jsonl`, 'utf8'))).toMatchObject({ effect })
  } finally { save.mockRestore(); read.mockRestore() }
})
