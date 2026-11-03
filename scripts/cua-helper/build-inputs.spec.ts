/** Byte-level source reuse survives unrelated releases and invalidates changed build inputs. */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { cuaHelperBuildKey, cuaHelperSourceDigest, readCuaSigningSettings } from './build-inputs.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cua-inputs-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: root, stdio: 'pipe' }) }
  const files = {
    'package.json': JSON.stringify({ version: '1.0.0', packageManager: 'pnpm@11.28.5' }),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'packages/experimental/cua-macos/native/Package.swift': '// swift package\n',
    'packages/experimental/cua-macos/native/Sources/Main.swift': 'print("one")\n',
    'packages/experimental/cua-macos/native/Info.plist': 'application identity',
    'scripts/cua-helper/package.ts': 'build helper',
    'apps/desktop/scripts/notarize-macos.mjs': 'notarize helper',
    '.github/workflows/cua-helper-package.yml': 'build configuration',
    'packages/client/unrelated/src/index.ts': 'unrelated feature',
  }
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  git('init', '--quiet')
  git('add', '.')
  return { root, git, source: join(root, 'packages/experimental/cua-macos/native/Sources/Main.swift') }
}

it('keeps identical source bytes across product versions and unrelated package edits', () => {
  const f = fixture()
  const before = cuaHelperSourceDigest(f.root)
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: '2.0.0', packageManager: 'pnpm@11.28.5' }))
  writeFileSync(join(f.root, 'packages/client/unrelated/src/index.ts'), 'another unrelated feature')
  utimesSync(f.source, new Date('2001-01-01'), new Date('2001-01-01'))
  expect(cuaHelperSourceDigest(f.root)).toBe(before)
  writeFileSync(f.source, readFileSync(f.source).toString().replace('one', 'two'))
  utimesSync(f.source, new Date('2001-01-01'), new Date('2001-01-01'))
  expect(cuaHelperSourceDigest(f.root)).not.toBe(before)
})

it.each(['add', 'delete', 'rename', 'resource', 'dependency', 'script', 'workflow', 'package manager'])(
  'invalidates %s changes', (change) => {
    const f = fixture()
    const before = cuaHelperSourceDigest(f.root)
    if (change === 'add') writeFileSync(join(dirname(f.source), 'Added.swift'), 'new source')
    if (change === 'delete') rmSync(f.source)
    if (change === 'rename') renameSync(f.source, join(dirname(f.source), 'Renamed.swift'))
    if (change === 'resource') writeFileSync(join(f.root, 'packages/experimental/cua-macos/native/Info.plist'), 'changed identity')
    if (change === 'dependency') writeFileSync(join(f.root, 'pnpm-lock.yaml'), 'changed dependency')
    if (change === 'script') writeFileSync(join(f.root, 'apps/desktop/scripts/notarize-macos.mjs'), 'changed notarization')
    if (change === 'workflow') writeFileSync(join(f.root, '.github/workflows/cua-helper-package.yml'), 'changed build configuration')
    if (change === 'package manager') writeFileSync(join(f.root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@12.0.0' }))
    f.git('add', '-A')
    expect(cuaHelperSourceDigest(f.root)).not.toBe(before)
  },
)

it.skipIf(process.platform === 'win32')('includes executable mode and rejects source links', () => {
  const f = fixture()
  const before = cuaHelperSourceDigest(f.root)
  chmodSync(f.source, 0o755)
  expect(cuaHelperSourceDigest(f.root)).not.toBe(before)
  rmSync(f.source)
  symlinkSync(join(f.root, 'pnpm-lock.yaml'), f.source)
  expect(() => cuaHelperSourceDigest(f.root)).toThrow('regular file')
})

it('fails on missing required tracked build inputs', () => {
  const f = fixture()
  f.git('rm', '--cached', 'scripts/cua-helper/package.ts')
  expect(() => cuaHelperSourceDigest(f.root)).toThrow('missing tracked build input')
})

it.each(['preset', 'identity', 'team', 'certificate', 'toolchain', 'source'])(
  'invalidates changed %s while credentials stay outside the build key', (change) => {
    const f = fixture()
    const certificate = join(f.root, 'signing.p12')
    writeFileSync(certificate, 'fixture encrypted certificate')
    const environment = { CSC_LINK: certificate, DSH_PACKAGING_PRESET: 'production',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Fixture (ABCDEFGHIJ)', DSH_DESKTOP_MACOS_TEAM_ID: 'ABCDEFGHIJ',
      APPLE_APP_SPECIFIC_PASSWORD: 'private-password' }
    const source = cuaHelperSourceDigest(f.root)
    const run = (_command: string, args: string[]): string => args.join(' ')
    const before = cuaHelperBuildKey(source, environment, run)
    environment.APPLE_APP_SPECIFIC_PASSWORD = 'new-private-password'
    expect(cuaHelperBuildKey(source, environment, run)).toBe(before)
    if (change === 'preset') environment.DSH_PACKAGING_PRESET = 'test'
    if (change === 'identity') environment.DSH_DESKTOP_MACOS_SIGNING_IDENTITY = 'Other (ABCDEFGHIJ)'
    if (change === 'team') environment.DSH_DESKTOP_MACOS_TEAM_ID = '1234567890'
    if (change === 'certificate') writeFileSync(certificate, 'another certificate')
    const after = cuaHelperBuildKey(change === 'source' ? 'b'.repeat(64) : source, environment,
      change === 'toolchain' ? () => 'another toolchain' : run)
    expect(after).not.toBe(before)
  },
)

it('resolves the configured signing file without installing desktop dependencies or exposing parser errors', () => {
  const f = fixture()
  const config = join(f.root, 'config')
  mkdirSync(join(config, 'secrets'), { recursive: true })
  writeFileSync(join(config, 'secrets/macos-signing.env'), 'CSC_LINK=./signing.p12\nDSH_DESKTOP_MACOS_TEAM_ID=ABCDEFGHIJ\n')
  const environment = { DSH_PACKAGING_CONFIG_DIR: config, DSH_PACKAGING_PRESET: 'production' }
  expect(readCuaSigningSettings(environment)).toMatchObject({ CSC_LINK: join(config, 'secrets/signing.p12'), DSH_PACKAGING_PRESET: 'production' })
  expect(() => readCuaSigningSettings({ ...environment, DSH_PACKAGING_PRESET: 'invalid' })).toThrow('preset')
  expect(() => readCuaSigningSettings({ ...environment, DSH_PACKAGING_CONFIG_DIR: 'relative' })).toThrow('CONFIG_DIR')
})

it('loads fingerprinting and selection under plain Node with no node_modules directory', () => {
  const f = fixture()
  for (const file of ['scripts/cua-helper/build-inputs.ts', 'scripts/cua-helper/select-artifact.ts',
    'apps/desktop/scripts/desktop-file-settings.mjs', 'apps/desktop/scripts/desktop-release-environment.mjs']) {
    mkdirSync(dirname(join(f.root, file)), { recursive: true })
    copyFileSync(resolve(file), join(f.root, file))
  }
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const a = await import('./scripts/cua-helper/select-artifact.ts'); const b = await import('./scripts/cua-helper/build-inputs.ts'); console.log(typeof a.selectCuaHelperArtifact, typeof b.cuaHelperSourceDigest)"],
  { cwd: f.root, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' })
  expect(output.trim()).toBe('function function')
})
