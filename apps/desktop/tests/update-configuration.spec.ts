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
    const error = new DesktopSettingsFileError({ kind: 'write', operation: 'save', effect: 'unchanged' }, '/private/path', { cause })
    expect(channelSaveFailure(error)).toBe(code === 'EIO' ? 'save' : 'permission')
  }
  expect(channelSaveFailure(new DesktopSettingsFileError({ kind: 'read' }, '/private/path'))).toBe('save')
  expect(channelSaveFailure(new DesktopSettingsFileError({ kind: 'read' }, '/private/path', { cause: 'private detail' }))).toBe('save')
})

it('keeps settings errors concise and cleanup recovery distinct', () => {
  expect(configurationMessage('read', en)).toBe('Settings file error; updates are paused')
  expect(configurationMessage('format', en)).toBe('Settings file error; updates are paused')
  expect(configurationMessage('channel', zh)).toBe('配置文件异常，更新已暂停')
  expect(configurationMessage('cleanup', zh)).toContain('请重启应用')
  expect(configurationMessage('cleanup', en)).not.toContain('settings file')
})

it('reports an uncertain write separately even when its cause is permission denied', () => {
  const error = new DesktopSettingsFileError({ kind: 'write', operation: 'save', effect: 'unknown' }, '/settings.json',
    { cause: Object.assign(new Error('denied'), { code: 'EACCES' }) })
  expect(channelSaveFailure(error)).toBe('uncertain')
})
