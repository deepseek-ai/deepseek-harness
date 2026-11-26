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
  return new DesktopUpdateSettings(root)
}

it('forces stable with config version 0 for missing settings without recreating the document', async () => {
  const settings = await fixture()
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'stable', unlocked: false, configVersion: '0' })
  await expect(readFile(settings.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('locks effective channel to stable until unlocked and keeps unlocked true when switching back to stable', async () => {
  const settings = await fixture()
  await writeFile(settings.path, JSON.stringify({
    updates: { allowTestAuthPopupWindow: true, channel: 'nightly', channelUnlocked: true },
    other: 4,
  }))
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'stable', unlocked: false, configVersion: '0' })
  await writeFile(settings.path, JSON.stringify({
    version: '1',
    updates: { allowTestAuthPopupWindow: true, channel: 'nightly' },
    other: 4,
  }))
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'stable', unlocked: false, configVersion: '1' })
  await writeFile(settings.path, JSON.stringify({
    version: '1',
    updates: { allowTestAuthPopupWindow: true, channel: 'nightly', channelUnlocked: false },
    other: 4,
  }))
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'stable', unlocked: false, configVersion: '1' })

  await settings.save('nightly')
  expect(JSON.parse(await readFile(settings.path, 'utf8'))).toEqual({
    version: '1',
    updates: { allowTestAuthPopupWindow: true, channel: 'nightly', channelUnlocked: true },
    other: 4,
  })
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'nightly', unlocked: true, configVersion: '1' })

  await settings.save('stable')
  expect(JSON.parse(await readFile(settings.path, 'utf8'))).toEqual({
    version: '1',
    updates: { allowTestAuthPopupWindow: true, channel: 'stable', channelUnlocked: true },
    other: 4,
  })
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'stable', unlocked: true, configVersion: '1' })
})

it.each([
  '{', 'null', '{"updates":[]}', '{"version":"2"}',
  '{"updates":{"channel":"alpha"}}', '{"updates":{"channel":null}}',
  '{"version":"1","updates":{"channelUnlocked":"yes"}}', '{"version":"1","updates":{"channelUnlocked":null}}',
])('suspends updates for invalid channel or unlock settings: %s', async (raw) => {
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
  const settings = new DesktopUpdateSettings(root)
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'stable', unlocked: false, configVersion: '1' })
  await settings.save('nightly')
  expect(JSON.parse(await readFile(settings.path, 'utf8'))).toEqual({
    version: '1',
    updates: { allowTestAuthPopupWindow: false, channel: 'nightly', channelUnlocked: true },
  })
  expect((await readDesktopSettings(root)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(await settings.load()).toEqual({ kind: 'ready', channel: 'nightly', unlocked: true, configVersion: '1' })
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
