import { spawnSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { verifyMacOSDiskImage } from '../scripts/verify-macos-signature.mjs'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawnSync: vi.fn(),
}))
afterEach(() => { vi.resetAllMocks() })

const signingIdentity = 'Example Company (TEAMID1234)'
const teamId = 'TEAMID1234'
const environment = {
  DSH_DESKTOP_APP_ID: 'com.example.desktop', DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
  DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
  DOWNLOAD_PROD_ORIGIN: 'https://updates.example.com',
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: signingIdentity, DSH_DESKTOP_MACOS_TEAM_ID: teamId,
  DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: '1',
}

function toolResult(details = `Authority=Developer ID Application: ${signingIdentity}\nTeamIdentifier=${teamId}`) {
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1, output: [null, '', details], stdout: '', stderr: details, status: 0, signal: null,
  })
}

it('verifies an unnotarized DMG signature and identity without invoking Apple notarization tools', () => {
  toolResult()
  const config = createElectronBuilderConfig(environment, 'darwin', 'arm64')
  expect(config.artifactBuildCompleted({ file: '/fixture/debug.dmg' })).toBeUndefined()
  expect(vi.mocked(spawnSync).mock.calls.map(call => call.slice(0, 2))).toEqual([
    ['/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', '/fixture/debug.dmg']],
    ['/usr/bin/codesign', ['--display', '--verbose=4', '/fixture/debug.dmg']],
  ])
})

it('rejects an unnotarized DMG signed by another team', () => {
  toolResult('Authority=Developer ID Application: Other (OTHERID123)\nTeamIdentifier=OTHERID123')
  const config = createElectronBuilderConfig(environment, 'darwin', 'arm64')
  expect(() => config.artifactBuildCompleted({ file: '/fixture/debug.dmg' })).toThrow(/release identity/u)
})

it('rejects a corrupt unnotarized DMG before inspecting its identity', () => {
  toolResult()
  vi.mocked(spawnSync).mockReturnValueOnce({ pid: 1, output: [null, '', 'invalid signature'],
    stdout: '', stderr: 'invalid signature', status: 1, signal: null })
  const config = createElectronBuilderConfig(environment, 'darwin', 'arm64')
  expect(() => config.artifactBuildCompleted({ file: '/fixture/debug.dmg' })).toThrow(/invalid signature/u)
  expect(spawnSync).toHaveBeenCalledOnce()
})

it('still requires a stapled ticket and Gatekeeper acceptance for release DMGs', () => {
  toolResult()
  verifyMacOSDiskImage('/fixture/release.dmg', { signingIdentity, teamId })
  expect(vi.mocked(spawnSync).mock.calls.map(call => call[0])).toEqual([
    '/usr/bin/codesign', '/usr/bin/codesign', '/usr/bin/xcrun', '/usr/sbin/spctl',
  ])
})
