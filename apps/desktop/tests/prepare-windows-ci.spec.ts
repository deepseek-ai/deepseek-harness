import { parseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import { windowsCiSettings } from '../scripts/prepare-windows-ci.mjs'
import { validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'

const inputs = {
  PACKAGE_BUILD_VERSION: 'auto',
  PACKAGE_DEPLOYMENT: 'test',
  PACKAGE_POLICY_ORIGIN: 'https://policy.example.com',
  PACKAGE_LOGIN_ORIGINS: 'https://login.example.com, https://sso.example.com',
  GITHUB_RUN_NUMBER: '42',
  GITHUB_RUN_ATTEMPT: '2',
}
const productVersion = '0.2.1-alpha.1'
const now = new Date('2026-10-08T23:59:59Z')

describe('manual Windows package inputs', () => {
  it('numbers fresh runners and reruns without storage credentials', () => {
    const result = windowsCiSettings(inputs, productVersion, now)
    expect(result.version).toBe('0.2.1-alpha.1.20261008.42.2')
    const settings = parseEnv(result.settings)
    expect(() => { validateDesktopPackageEnvironment(settings, { platform: 'win32', arch: 'x64' }, { unsigned: true }) }).not.toThrow()
    expect(Object.keys(settings).sort()).toEqual([
      'DSH_DESKTOP_APP_ID', 'DSH_DESKTOP_AUTO_UPDATE_ENV',
      'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN', 'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG',
    ].sort())
  })

  it('accepts an explicit version without a GitHub run identity', () => {
    const result = windowsCiSettings({ ...inputs, PACKAGE_BUILD_VERSION: '0.2.1-alpha.1.20261008.7',
      GITHUB_RUN_NUMBER: undefined, GITHUB_RUN_ATTEMPT: undefined }, productVersion, now)
    expect(result.version).toBe('0.2.1-alpha.1.20261008.7')
  })

  it('uses the stable product test prefix and anonymous production policy', () => {
    const result = windowsCiSettings({ ...inputs, PACKAGE_DEPLOYMENT: 'production', PACKAGE_LOGIN_ORIGINS: '' }, '0.2.1', now)
    expect(result.version).toBe('0.2.1-test.20261008.42.2')
    expect(() => { validateDesktopPackageEnvironment(parseEnv(result.settings), { platform: 'win32', arch: 'x64' }, { unsigned: true }) }).not.toThrow()
  })

  it.each([
    { PACKAGE_BUILD_VERSION: '' },
    { PACKAGE_BUILD_VERSION: '0.3.0' },
    { PACKAGE_DEPLOYMENT: 'staging' },
    { PACKAGE_POLICY_ORIGIN: '' },
    { PACKAGE_POLICY_ORIGIN: 'http://policy.example.com' },
    { PACKAGE_POLICY_ORIGIN: 'https://policy.example.com/path' },
    { PACKAGE_LOGIN_ORIGINS: '' },
    { PACKAGE_LOGIN_ORIGINS: 'https://user:password@login.example.com' },
    { PACKAGE_DEPLOYMENT: 'production' },
    { GITHUB_RUN_NUMBER: '0' },
    { GITHUB_RUN_ATTEMPT: '1\nINJECTED=value' },
  ])('rejects invalid manual settings %j', (override) => {
    expect(() => windowsCiSettings({ ...inputs, ...override }, productVersion, now)).toThrow()
  })
})
