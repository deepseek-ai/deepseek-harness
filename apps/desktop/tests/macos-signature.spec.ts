import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import { runtimeFixture } from './runtime-fixture.ts'
import { verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NotarizeOptions } from '@electron/notarize'
import {
  resolveDesktopAppId,
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from '../scripts/desktop-release-environment.mjs'
import { notarizeMacOSDiskImageArtifact } from '../scripts/notarize-macos-disk-images.mjs'
import {
  assertMacOSRuntimeSignatureDetails,
  assertMacOSSignatureDetails,
} from '../scripts/verify-macos-signature.mjs'

// app-builder-lib omits this internal copier from its declarations; the regression exercises its actual file filter.
const { copyFiles } = createRequire(import.meta.url)('app-builder-lib/out/fileMatcher.js') as {
  copyFiles: (matchers: FileMatcher[]) => Promise<void>
}

const RELEASE_ENVIRONMENT = {
  DSH_DESKTOP_APP_ID: 'com.example.desktop',
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
  DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  APPLE_API_KEY: '/private/credentials/AuthKey_TEST123456.p8',
  APPLE_API_KEY_ID: 'TEST123456',
  APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555',
  DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
}

function portablePath(value: string): string {
  return value.replaceAll('\\', '/')
}

describe('desktop macOS release signature', () => {
  beforeAll(() => {
    for (const [name, value] of Object.entries(RELEASE_ENVIRONMENT)) vi.stubEnv(name, value)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('loads release identifiers from the environment and requires code signing', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const config = createElectronBuilderConfig(RELEASE_ENVIRONMENT, 'darwin', 'arm64')
    expect(portablePath(config.directories.output)).toContain('/.desktop-build/targets/mac-arm64/artifacts')
    expect(config.extraResources).toHaveLength(3)
    expect(config.extraResources[0]?.to).toBe('runtime')
    expect(config.extraResources[1]?.to).toBe('dsh')
    expect(portablePath(config.extraResources[0]?.from ?? '')).toContain('/.desktop-build/targets/mac-arm64/runtime')
    expect(portablePath(config.extraResources[1]?.from ?? '')).toContain('/.desktop-build/targets/mac-arm64/dsh')
    expect(config).toMatchObject({
      appId: RELEASE_ENVIRONMENT.DSH_DESKTOP_APP_ID,
      mac: {
        identity: RELEASE_ENVIRONMENT.DSH_DESKTOP_MACOS_SIGNING_IDENTITY,
        forceCodeSigning: true,
        notarize: true,
        signIgnore: ['/Contents/Resources/dsh(?:/|$)', '\\.pak$'],
      },
      dmg: {
        sign: true,
        writeUpdateInfo: false,
      },
      publish: [{
        provider: 'generic',
        url: 'https://desktop-updates.example.com/_/harness/desktop/stable/mac-arm64/',
      }],
    })
    expect(typeof config.artifactBuildCompleted).toBe('function')
  })

  it('seals PAK resources with their enclosing bundle while signing executable code', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const config = createElectronBuilderConfig(RELEASE_ENVIRONMENT, 'darwin', 'arm64')
    const ignored = (path: string): boolean => config.mac.signIgnore.some(pattern => new RegExp(pattern).test(path))
    expect(ignored('/App.app/Contents/Frameworks/Electron.framework/Versions/A/Resources/en.lproj/locale.pak')).toBe(true)
    expect(ignored('/App.app/Contents/Frameworks/Electron.framework/Versions/A/Resources/resources.pak')).toBe(true)
    for (const path of [
      '/App.app/Contents/Resources/runtime/node/node',
      '/App.app/Contents/Resources/runtime/pnpm/addon.node',
      '/App.app/Contents/Frameworks/Electron.framework/Versions/A/library.dylib',
      '/App.app/Contents/Frameworks/Electron.framework',
      '/App.app',
    ]) expect(ignored(path)).toBe(false)
  })

  it('copies the complete runtime despite electron-builder excluding root node_modules', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const config = createElectronBuilderConfig(RELEASE_ENVIRONMENT, 'darwin', 'arm64')
    const root = mkdtempSync(join(tmpdir(), 'desktop-resource-copy-'))
    try {
      const source = join(root, 'source')
      const destination = join(root, 'resources')
      runtimeFixture(source)
      const sourceRoot = config.extraResources[1].from
      const matchers = config.extraResources.slice(1).map(entry => new FileMatcher(
        join(source, relative(sourceRoot, entry.from)), join(destination, entry.to), value => value,
      ))
      await copyFiles(matchers.slice(0, 1))
      await expect(verifyDesktopRuntime(join(destination, 'dsh'), '1.0.0')).rejects.toThrow(/ENOENT/u)
      rmSync(destination, { recursive: true })
      await copyFiles(matchers)
      await expect(verifyDesktopRuntime(join(destination, 'dsh'), '1.0.0')).resolves.toMatchObject({ release: { version: '1.0.0' } })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('validates Windows signing without requiring macOS identifiers for a Windows target', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    expect(() => createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: RELEASE_ENVIRONMENT.DSH_DESKTOP_APP_ID,
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
    }, 'win32')).toThrow(/DSH_DESKTOP_WINDOWS_CER_FILE/u)
  })

  it('isolates unsigned Windows artifacts and omits updater metadata without release credentials', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: RELEASE_ENVIRONMENT.DSH_DESKTOP_APP_ID,
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(portablePath(config.directories.output)).toContain('/targets/win-x64/unsigned-artifacts')
    expect(portablePath(config.nsis.include)).toMatch(/\/scripts\/installer\.nsh$/u)
    expect(config).toMatchObject({
      win: { forceCodeSigning: false, signtoolOptions: { sign: undefined } },
      publish: null,
    })
  })

  it('rejects unsigned macOS builds and malformed signing modes', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    expect(() => createElectronBuilderConfig({ ...RELEASE_ENVIRONMENT, DSH_DESKTOP_UNSIGNED: '1' }))
      .toThrow(/unsigned builds require Windows/u)
    expect(() => createElectronBuilderConfig({ ...RELEASE_ENVIRONMENT, DSH_DESKTOP_UNSIGNED: 'yes' }))
      .toThrow(/must be 0 or 1/u)
  })

  it('accepts the configured authority and team', () => {
    const expected = resolveMacOSSigningEnvironment(RELEASE_ENVIRONMENT)
    expect(() => {
      assertMacOSSignatureDetails([
        `Authority=Developer ID Application: ${expected.signingIdentity}`,
        `TeamIdentifier=${expected.teamId}`,
      ].join('\n'), expected)
    }).not.toThrow()
  })

  it('requires a secure timestamp and hardened runtime for runtime code', () => {
    const expected = resolveMacOSSigningEnvironment(RELEASE_ENVIRONMENT)
    const details = [
      `Authority=Developer ID Application: ${expected.signingIdentity}`,
      `TeamIdentifier=${expected.teamId}`,
      'Timestamp=31 Aug 2026 at 20:00:00',
      'CodeDirectory v=20500 size=773 flags=0x10000(runtime) hashes=13+7 location=embedded',
    ].join('\n')
    expect(() => { assertMacOSRuntimeSignatureDetails(details, expected) }).not.toThrow()
    expect(() => {
      assertMacOSRuntimeSignatureDetails(details.replace(/^Timestamp=.*\n/um, ''), expected)
    }).toThrow(/secure timestamp/u)
    expect(() => {
      assertMacOSRuntimeSignatureDetails(details.replace('flags=0x10000(runtime)', 'flags=0x0(none)'), expected)
    }).toThrow(/hardened runtime/u)
  })

  it('rejects another developer identity', () => {
    const expected = resolveMacOSSigningEnvironment(RELEASE_ENVIRONMENT)
    expect(() => {
      assertMacOSSignatureDetails([
        'Authority=Developer ID Application: Other Company (OTHERID123)',
        'TeamIdentifier=OTHERID123',
      ].join('\n'), expected)
    }).toThrow(/release identity/u)
  })

  it('rejects an unexpected team even when the authority is present', () => {
    const expected = resolveMacOSSigningEnvironment(RELEASE_ENVIRONMENT)
    expect(() => {
      assertMacOSSignatureDetails([
        `Authority=Developer ID Application: ${expected.signingIdentity}`,
        'TeamIdentifier=OTHERID123',
      ].join('\n'), expected)
    }).toThrow(`TeamIdentifier=${expected.teamId}`)
  })

  it('rejects missing and malformed release identifiers', () => {
    expect(() => resolveDesktopAppId({})).toThrow(/DSH_DESKTOP_APP_ID/u)
    expect(() => resolveDesktopAppId({ DSH_DESKTOP_APP_ID: 'not-a-bundle-id' })).toThrow(/reverse-DNS/u)
    expect(() => resolveMacOSSigningEnvironment({})).toThrow(/DSH_DESKTOP_MACOS_SIGNING_IDENTITY/u)
    expect(() => resolveMacOSSigningEnvironment({
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Developer ID Application: Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
    })).toThrow(/must omit/u)
    expect(() => resolveMacOSSigningEnvironment({
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'short',
    })).toThrow(/10 uppercase/u)
  })

  it('requires one complete notarization credential strategy', () => {
    expect(resolveMacOSNotarizationEnvironment(RELEASE_ENVIRONMENT)).toEqual({
      appleApiKey: RELEASE_ENVIRONMENT.APPLE_API_KEY,
      appleApiKeyId: RELEASE_ENVIRONMENT.APPLE_API_KEY_ID,
      appleApiIssuer: RELEASE_ENVIRONMENT.APPLE_API_ISSUER,
    })
    expect(resolveMacOSNotarizationEnvironment({
      APPLE_KEYCHAIN_PROFILE: 'dsh-notary',
    })).toEqual({ keychainProfile: 'dsh-notary' })
    expect(() => resolveMacOSNotarizationEnvironment({})).toThrow(/macOS packaging requires/u)
    expect(() => resolveMacOSNotarizationEnvironment({ APPLE_API_KEY: '/tmp/key.p8' })).toThrow(/APPLE_API_KEY_ID/u)
  })

  it('notarizes and qualifies a DMG before electron-builder publishes it', async () => {
    const submitted: string[] = []
    const submit = vi.fn(async (options: NotarizeOptions) => { submitted.push(options.appPath) })
    const verified: string[] = []
    const verify = vi.fn((path: string) => { verified.push(path) })
    await notarizeMacOSDiskImageArtifact(
      { file: '/tmp/release.dmg' },
      RELEASE_ENVIRONMENT,
      resolveMacOSSigningEnvironment(RELEASE_ENVIRONMENT),
      submit,
      verify,
    )
    await notarizeMacOSDiskImageArtifact(
      { file: '/tmp/release.zip' },
      RELEASE_ENVIRONMENT,
      resolveMacOSSigningEnvironment(RELEASE_ENVIRONMENT),
      submit,
      verify,
    )
    expect(submitted).toEqual(['/tmp/release.dmg'])
    expect(verified).toEqual(['/tmp/release.dmg'])
  })
})
