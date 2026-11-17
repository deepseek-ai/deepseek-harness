import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { expect, it } from 'vitest'
import { loadDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'

it('loads machine signing credentials independently of the checkout and rejects misplaced settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'macos-preset-'))
  try {
    await mkdir(join(root, 'presets'))
    await mkdir(join(root, 'secrets'))
    const preset = join(root, 'presets/test.env')
    const secrets = join(root, 'secrets/macos-signing.env')
    await writeFile(preset, 'DSH_DESKTOP_AUTO_UPDATE_ENV=test\nDSH_DESKTOP_MACOS_PACK_CONCURRENCY=2\nDSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR=/machine/cache\n')
    await writeFile(secrets, 'CSC_LINK=../certificates/app.p12\nCSC_KEY_PASSWORD=machine-secret\nAPPLE_API_KEY=../certificates/key.p8\n')
    const env = { DSH_PACKAGING_PRESET: 'test', DSH_PACKAGING_CONFIG_DIR: root, CSC_KEY_PASSWORD: 'ambient-secret' }
    for (const options of [{}, { prepareOnly: true }]) {
      const selected = loadDesktopPackageEnvironment('darwin', env, join(root, 'absent-checkout'), options)
      expect(selected.CSC_LINK).toBe(join(root, 'certificates/app.p12'))
      expect(selected.APPLE_API_KEY).toBe(join(root, 'certificates/key.p8'))
      expect(selected.CSC_KEY_PASSWORD).toBe('machine-secret')
      expect(selected.DSH_DESKTOP_MACOS_PACK_CONCURRENCY).toBe('2')
      expect(selected.DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR).toBe('/machine/cache')
    }
    await rm(secrets)
    expect(loadDesktopPackageEnvironment('darwin', env, root, { unsigned: true }).CSC_KEY_PASSWORD).toBeUndefined()
    expect(() => loadDesktopPackageEnvironment('darwin', env)).toThrow(/cannot read/u)
    await writeFile(secrets, 'DSH_DESKTOP_MACOS_DOWNLOAD_PROXY=http://localhost:1234\n')
    expect(() => loadDesktopPackageEnvironment('darwin', env)).toThrow(/unsupported setting/u)
    await writeFile(preset, 'DSH_DESKTOP_AUTO_UPDATE_ENV=test\nCSC_KEY_PASSWORD=private-value\n')
    expect(() => loadDesktopPackageEnvironment('darwin', env)).toThrow(/unsupported setting CSC_KEY_PASSWORD/u)
    expect(() => loadDesktopPackageEnvironment('darwin', env)).not.toThrow(/private-value/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform !== 'darwin')('prepares private machine directories without overwriting existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'macos-setup-'))
  try {
    const machine = join(await realpath(root), 'machine')
    const run = (...args: string[]) => spawnSync(process.execPath,
      [join(import.meta.dirname, '../scripts/setup-macos-packaging.mjs'), machine, ...args], { encoding: 'utf8' })
    expect(run().status).toBe(0)
    const config = join(machine, 'packaging/presets/test.env.example')
    expect(parseEnv(await readFile(config, 'utf8')).DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR).toBe(join(machine, 'cache/macos-signatures'))
    await writeFile(config, 'keep existing configuration\n')
    expect(run().status).toBe(0)
    expect(await readFile(config, 'utf8')).toBe('keep existing configuration\n')
    expect(run('--check').status).toBe(0)
    await rm(join(machine, 'packaging/secrets'), { recursive: true })
    const missing = run('--check')
    expect(missing.error).toBeUndefined()
    expect(missing.signal).toBeNull()
    expect(missing.status).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['arm64', 'x64'])('records %s debugging artifact paths only for an explicit CI selection without notarization credentials', async (arch) => {
  const root = await mkdtemp(join(tmpdir(), 'macos-ci-settings-'))
  try {
    await mkdir(join(root, 'presets'))
    await mkdir(join(root, 'secrets'))
    await writeFile(join(root, 'certificate.p12'), 'fixture')
    await writeFile(join(root, 'presets/test.env'), [
      'DSH_DESKTOP_APP_ID=com.example.fixture', 'DSH_DESKTOP_AUTO_UPDATE_ENV=test',
      'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=https://policy.example.com',
      'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG={"allowedAuthOrigins":["https://login.example.com"]}',
      'DOWNLOAD_TEST_ORIGIN=https://updates.example.com', 'DOWNLOAD_TEST_RELEASE_ID=0123456789abcdef0123456789abcdef',
    ].join('\n'))
    await writeFile(join(root, 'secrets/macos-signing.env'), [
      'CSC_LINK=../certificate.p12', 'CSC_KEY_PASSWORD=fixture-password',
      'DSH_DESKTOP_MACOS_SIGNING_IDENTITY=Example Company (TEAMID1234)', 'DSH_DESKTOP_MACOS_TEAM_ID=TEAMID1234',
    ].join('\n'))
    const output = join(root, 'output')
    const summary = join(root, 'summary')
    const run = (skip: string) => spawnSync(process.execPath,
      [join(import.meta.dirname, '../scripts/prepare-macos-ci.mjs')], { encoding: 'utf8', env: {
        ...process.env, DSH_PACKAGING_CONFIG_DIR: root, DSH_PACKAGING_PRESET: 'test',
        DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: arch,
        PACKAGE_SKIP_NOTARIZATION: skip, PACKAGE_BUILD_VERSION: 'auto',
        GITHUB_RUN_NUMBER: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      } })
    const missingCredentials = run('false')
    expect(missingCredentials.status).toBe(1)
    expect(missingCredentials.stderr).toContain('macOS packaging requires APPLE_API_KEY')
    const invalidSelection = run('yes')
    expect(invalidSelection.status).toBe(1)
    expect(invalidSelection.stderr).toContain('Invalid skip notarization selection')
    const debugging = run('true')
    expect(debugging.error).toBeUndefined()
    expect(debugging.signal).toBeNull()
    expect(debugging.stderr).toBe('')
    expect(debugging.status).toBe(0)
    expect(await readFile(output, 'utf8')).toContain('artifacts=unnotarized-artifacts\nmode=unnotarized-debug\n')
    expect(await readFile(summary, 'utf8')).toContain('Internal debugging only')
    expect(await readFile(summary, 'utf8')).toContain(`macOS ${arch} signed installer`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
