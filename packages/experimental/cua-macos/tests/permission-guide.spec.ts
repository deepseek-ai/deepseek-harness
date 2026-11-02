/** Native permission preparation belongs to the macOS provider. */
import { expect, it } from 'vitest'
import { CuaConfig } from '@deepseek-ai/dsh-cua'
import { Config } from '../src/index.ts'
import { createPermissionParameters, PermissionGuideParameters, PermissionSettingsParameters } from '../src/permission-guide.ts'

it('keeps the guide interval in macOS configuration and rejects invalid bounds', () => {
  expect(CuaConfig({})).not.toHaveProperty('permissionPollIntervalMs')
  expect(Config({}).permissionPollIntervalMs).toBe(1000)
  expect(Config({ permissionPollIntervalMs: 250 }).permissionPollIntervalMs).toBe(250)
  for (const permissionPollIntervalMs of [99, 100.5, 2 ** 31]) expect(() => Config({ permissionPollIntervalMs })).toThrow()
})

it.each(['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'])('prepares both permissions in %s without sending settings-only callers guide fields', (locale) => {
  const parameters = createPermissionParameters(250)
  for (const permission of ['accessibility', 'screenRecording'] as const) {
    const guide = parameters('requestPermission', permission, locale)
    expect(PermissionGuideParameters.parse(guide)).toMatchObject({ pollIntervalMs: 250 })
    expect(guide.instruction).toContain('{application}')
    expect(guide.instruction).not.toContain('{permission}')
    const settings = parameters('openPermissionSettings', permission, locale)
    expect(settings).toEqual({ permission, settingsMessage: guide.settingsMessage })
    expect(PermissionSettingsParameters.parse(settings)).toEqual({ settingsMessage: guide.settingsMessage })
  }
})

it('matches language variants and falls back to English for unsupported languages', () => {
  const parameters = createPermissionParameters(2000)
  expect(parameters('requestPermission', 'accessibility', 'ZH-CN')).toEqual({
    permission: 'accessibility', pollIntervalMs: 2000,
    instruction: '将 {application} 拖入上方列表以允许辅助功能', backLabel: '返回', finderLabel: '在 Finder 中显示',
    unavailableMessage: '找不到此应用。请重新启用 Computer Use 后重试',
    settingsMessage: '请手动打开系统设置 > 隐私与安全性 > 辅助功能',
  })
  expect(parameters('requestPermission', 'screenRecording', 'it')).toEqual(parameters('requestPermission', 'screenRecording', 'en'))
  expect(() => PermissionGuideParameters.parse({ ...parameters('requestPermission', 'accessibility', 'en'), pollIntervalMs: 0 })).toThrow()
  expect(() => PermissionSettingsParameters.parse({ settingsMessage: '' })).toThrow()
})
