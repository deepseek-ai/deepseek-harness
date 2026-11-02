import { expect, it } from 'vitest'
import { channelSaveFailure, configurationFailure, configurationMessage } from '../src/update-configuration.ts'
import { DesktopSettingsFileError } from '../src/settings-file.ts'
import { en, zh } from '../src/locale.ts'

it('keeps startup suspensions distinct from transient save failures', () => {
  const json = new DesktopSettingsFileError({ kind: 'invalid', reason: 'json' }, '/settings.json')
  const structure = new DesktopSettingsFileError({ kind: 'invalid', reason: 'structure' }, '/settings.json')
  const channel = new DesktopSettingsFileError({ kind: 'invalid', reason: 'field', field: 'channel' }, '/settings.json')
  const popup = new DesktopSettingsFileError({ kind: 'invalid', reason: 'field', field: 'allowTestAuthPopupWindow' }, '/settings.json')
  expect(configurationFailure(json)).toBe('format')
  expect(configurationFailure(structure)).toBe('format')
  expect(configurationFailure(channel)).toBe('channel')
  expect(configurationFailure(popup)).toBe('format')
  expect(configurationFailure(new DesktopSettingsFileError({ kind: 'read' }, '/settings.json'))).toBe('read')
  expect(channelSaveFailure(json)).toBe('format')
  expect(channelSaveFailure(new Error('native apply failed'))).toBe('apply')
})

it('only exposes a permission hint for a known filesystem permission failure', () => {
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    const cause = Object.assign(new Error('private filesystem detail'), { code })
    const error = new DesktopSettingsFileError({ kind: 'write', operation: 'save', effect: 'unknown' }, '/private/path', { cause })
    expect(channelSaveFailure(error)).toBe(code === 'EIO' ? 'save' : 'permission')
  }
  expect(channelSaveFailure(new DesktopSettingsFileError({ kind: 'read' }, '/private/path'))).toBe('save')
  expect(channelSaveFailure(new DesktopSettingsFileError({ kind: 'read' }, '/private/path', { cause: 'private detail' }))).toBe('save')
})

it('provides distinct localized reasons and recovery without raw errors', () => {
  expect(configurationMessage('read', en)).toContain('cannot read settings')
  expect(configurationMessage('format', en)).toContain('invalid settings')
  expect(configurationMessage('channel', zh)).toContain('nightly 或 stable')
  expect(configurationMessage('cleanup', zh)).toContain('请重启应用')
  expect(configurationMessage('cleanup', en)).not.toContain('settings file')
})
