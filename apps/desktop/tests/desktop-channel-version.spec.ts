import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { desktopCiVersion } from '../scripts/desktop-ci-version.mjs'
import { desktopBuildVersionPrefix } from '../scripts/desktop-build-version.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

it.each(['nightly', 'stable'] as const)('resolves every CI version mode independently of %s', (channel) => {
  const now = new Date('2026-11-03T00:00:00Z')
  for (const version of ['1.2.3', '1.2.3-alpha.1', '1.2.3-rc.1']) {
    const env = { DSH_DESKTOP_UPDATE_CHANNEL: channel, GITHUB_RUN_NUMBER: '7', GITHUB_RUN_ATTEMPT: '2' }
    const generated = `${desktopBuildVersionPrefix(version)}20261103.7.2`
    expect(desktopCiVersion({ ...env, PACKAGE_VERSION_MODE: 'follow-dsh' }, version, now)).toBe(version)
    for (const preset of ['test', 'production']) {
      expect(desktopCiVersion({ ...env, DSH_PACKAGING_PRESET: preset, PACKAGE_VERSION_MODE: 'build-number' }, version, now)).toBe(generated)
    }
    expect(desktopCiVersion({ ...env, PACKAGE_VERSION_MODE: 'product' }, version, now)).toBe(version)
    expect(desktopCiVersion({ ...env, PACKAGE_VERSION_MODE: 'auto' }, version, now)).toBe(generated)
    expect(desktopCiVersion({ ...env, PACKAGE_VERSION_MODE: 'manual', PACKAGE_BUILD_VERSION: generated }, version, now)).toBe(generated)
    expect(desktopCiVersion({ ...env, PACKAGE_VERSION_MODE: 'default', DSH_PACKAGING_PRESET: 'production' }, version, now)).toBe(version)
    expect(desktopCiVersion({ ...env, PACKAGE_VERSION_MODE: 'default', DSH_PACKAGING_PRESET: 'test' }, version, now)).toBe(generated)
    expect(() => desktopCiVersion({ ...env, PACKAGE_VERSION_MODE: 'manual', PACKAGE_BUILD_VERSION: 'invalid' }, version, now)).toThrow('Invalid build version')
  }
})

it.each(['arm64', 'x64'] as const)('embeds stable in a prerelease macOS %s package and provider', (arch) => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  const version = `${desktopBuildVersionPrefix(manifest.version)}20261103.1`
  const config = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.example.channel-test',
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_UPDATE_CHANNEL: 'stable',
    DSH_DESKTOP_BUILD_VERSION: version,
    DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
    DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
    APPLE_KEYCHAIN_PROFILE: 'channel-test',
  }, 'darwin', arch)
  expect(config.extraMetadata).toMatchObject({ version, dshDesktopUpdateChannel: 'stable' })
  expect(config.publish).toEqual([{ provider: 'generic', url: `https://download.deepseek.com/dsh-desk/feeds/mac-${arch}/`, channel: 'stable' }])
})

it('accepts a stable prerelease in an unsigned Windows x64 configuration', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  const version = `${desktopBuildVersionPrefix(manifest.version)}20261103.1`
  const config = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.example.channel-test',
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_UPDATE_CHANNEL: 'stable',
    DSH_DESKTOP_BUILD_VERSION: version,
    DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_UNSIGNED: '1',
  }, 'win32', 'x64')
  expect(config.extraMetadata).toMatchObject({ version })
  expect(config.publish).toBeNull()
})
