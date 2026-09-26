import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Stats } from 'node:fs'
import { Arch, Packager, type BeforePackContext, type Configuration } from 'app-builder-lib'
import { WinPackager } from 'app-builder-lib/out/winPackager.js'
import { getFileMatchers } from 'app-builder-lib/out/fileMatcher.js'
import { readAsar } from 'app-builder-lib/out/asar/asar.js'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareWindowsAsarUnpack, verifyWindowsAsarUnpack } from '../scripts/windows-asar-unpack.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { verifyRuntimeArchive } from '../scripts/verify-runtime-archive.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { inventoryDesktopRuntime, type DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

vi.mock('../scripts/windows-sign.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/windows-sign.mjs')>(),
  createWindowsTokenSigner: () => async () => {},
  installWindowsNsisBootstrapSigner: () => {},
  resolveWindowsUpdatePublisher: () => 'Fixture Publisher',
}))
vi.mock('../scripts/windows-runtime-signature.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/windows-runtime-signature.mjs')>(),
  signWindowsCode: async () => {},
}))
// Vite's root-relative IDs also resolve mocked build outputs on a clean checkout.
vi.mock('/apps/desktop/lib/types/runtime-tree.js', () => ({ verifyDesktopRuntime: async () => {} }))
vi.mock('/apps/desktop/lib/types/mandatory-update-policy.js', async () => import('../src/mandatory-update-policy.ts'))
vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  X509Certificate: class { fingerprint = 'AA:BB' },
}))

const require = createRequire(import.meta.url)
// The locked builder omits declarations for its AsarPackager implementation.
const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil.js') as {
  AsarPackager: new (packager: object, configuration: object) => {
    pack(files: { src: string; destination: string; files: string[]; metadata: Map<string, Stats> }[]): Promise<void>
  }
}
const roots: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function unsignedWindowsConfig(appId: string, source: string) {
  return createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: appId, DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    DSH_DESKTOP_UNSIGNED: '1',
  }, 'win32', 'x64', source)
}

async function fixture(external: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'windows-asar-'))
  roots.push(root)
  const appDir = join(root, 'app')
  const source = external ? join(root, 'private', 'dsh') : join(appDir, '.desktop-build', 'dsh')
  const resources = join(root, 'output', 'resources')
  await mkdir(resources, { recursive: true })
  await mkdir(appDir, { recursive: true })
  const pe = Buffer.alloc(128)
  pe.writeUInt16LE(0x5a4d, 0)
  pe.writeUInt32LE(64, 0x3c)
  pe.writeUInt32LE(0x4550, 64)
  const names = ['extensionless', 'custom.binary', 'native.node', 'a[0]{x,y}+(z)@!#.binary', '${arch}.binary']
  for (const name of names) {
    const file = join(source, 'node_modules', 'foo', name)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, pe)
  }
  await writeFile(join(source, 'node_modules', 'foo', 'companion.json'), '{}')
  await writeFile(join(source, 'node_modules', 'foo', '$xarchy.binary'), 'neighbor')
  for (const [name, manifest] of [
    ['@deepseek-ai/libreoffice-kit', { name: '@deepseek-ai/libreoffice-kit', optionalDependencies: { '@deepseek-ai/libreoffice-kit-win32-x64': '0.0.4' }, dependencies: { 'office-codec': '1' } }],
    ['@deepseek-ai/libreoffice-kit-win32-x64', { name: '@deepseek-ai/libreoffice-kit-win32-x64' }],
    ['office-codec', { name: 'office-codec' }],
  ] as const) {
    const directory = join(source, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'cli.js'), 'export {}')
  }
  const config = {
    files: [{ from: source, to: 'dsh', filter: ['**/*'] },
      { from: join(source, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] }],
    asarUnpack: ['**/*.node'],
  } satisfies Configuration
  const info = new Packager({ projectDir: appDir })
  Object.defineProperties(info, {
    appDir: { value: appDir }, config: { value: config },
    metadata: { value: { name: 'fixture', version: '1.0.0', description: 'Fixture' } },
    framework: { value: { name: 'electron' } },
  })
  vi.spyOn(info, 'disposeOnBuildFinish').mockImplementation((cleanup) => { cleanups.push(cleanup) })
  const context: BeforePackContext = { packager: new WinPackager(info), arch: Arch.x64,
    appOutDir: dirname(resources), outDir: dirname(resources), electronPlatformName: 'win32', targets: [] }
  return { root, appDir, source, resources, config, context, names }
}

async function packageFixture(input: Awaited<ReturnType<typeof fixture>>) {
  const destination = join(input.resources, 'app')
  const matchers = getFileMatchers(input.config, 'asarUnpack', destination, {
    defaultSrc: input.appDir, globalOutDir: dirname(input.resources), customBuildOptions: {},
    macroExpander: value => value.replaceAll('${arch}', 'x64'),
  })!
  const mapping = input.config.files[0]!
  if (typeof mapping === 'string' || mapping.from === undefined) throw new Error('missing source mapping')
  const files: string[] = []
  const metadata = new Map<string, Stats>()
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const file = join(directory, name)
      const stat = await lstat(file)
      if (stat.isDirectory()) await visit(file)
      else { files.push(file); metadata.set(file, stat) }
    }
  }
  await visit(mapping.from)
  await new AsarPackager({ info: { getWorkspaceRoot: async () => input.root } }, {
    defaultDestination: destination, resourcePath: input.resources, options: {}, unpackPattern: matchers[0]!.createFilter(),
  }).pack([{ src: mapping.from, destination: join(destination, 'dsh'), files, metadata }])
}

it.each([false, true])('unpacks PE files through builder source patterns (external=%s)', async (external) => {
  const input = await fixture(external)
  const files = await prepareWindowsAsarUnpack(input.context, input.source)
  await packageFixture(input)
  await verifyWindowsAsarUnpack(input.source, input.resources, files)
  const archive = await readAsar(join(input.resources, 'app.asar'))
  expect(archive.getFile(join('dsh', 'node_modules', 'foo', 'companion.json')).unpacked).not.toBe(true)
  expect(archive.getFile(join('dsh', 'node_modules', 'foo', '$xarchy.binary')).unpacked).toBe(true)
  expect(files).toEqual(input.names.map(name => join('node_modules', 'foo', name)).sort())
  const first = input.config.files[0]!
  const nested = input.config.files[1]!
  if (typeof first === 'string' || typeof nested === 'string') throw new Error('missing source mappings')
  expect(first.from === input.source).toBe(!external)
  expect(nested.from).toBe(join(first.from, 'node_modules'))
  expect(cleanups.length).toBe(external ? 1 : 0)
  if (external) {
    await cleanups.pop()!()
    await expect(lstat(first.from)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(input.source, files[0]!))).toHaveLength(128)
  }
})

it('rejects an inline PE even when a neighboring unpacked copy exists', async () => {
  const input = await fixture(false)
  const files = await prepareWindowsAsarUnpack(input.context, input.source)
  input.config.asarUnpack = ['**/*.node']
  await packageFixture(input)
  const path = join(input.resources, 'app.asar.unpacked', 'dsh', files[0]!)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, await readFile(join(input.source, files[0]!)))
  await expect(verifyWindowsAsarUnpack(input.source, input.resources, files)).rejects.toThrow('PE must be unpacked')
})

it.each(['changed', 'missing'] as const)('rejects %s unpacked PE bytes', async (state) => {
  const input = await fixture(false)
  const files = await prepareWindowsAsarUnpack(input.context, input.source)
  await packageFixture(input)
  const path = join(input.resources, 'app.asar.unpacked', 'dsh', files[0]!)
  if (state === 'changed') await writeFile(path, 'changed')
  else await rm(path)
  await expect(verifyWindowsAsarUnpack(input.source, input.resources, files)).rejects.toThrow(state === 'changed' ? 'PE bytes changed' : 'ENOENT')
})

it('registers external staging cleanup before a configuration rewrite fails', async () => {
  const input = await fixture(true)
  const files = input.config.files
  // The source still passes PE discovery; a destination mapping setter fails after staging is copied.
  Object.defineProperty(input.config, 'files', { get: () => files, set: () => { throw new Error('configuration rejected') } })
  await expect(prepareWindowsAsarUnpack(input.context, input.source)).rejects.toThrow('configuration rejected')
  const staging = await readdir(join(input.appDir, '.desktop-build'))
  expect(staging).toHaveLength(1)
  expect(cleanups).toHaveLength(1)
  await cleanups.pop()!()
  expect(await readdir(join(input.appDir, '.desktop-build'))).toEqual([])
})

it.each([true, false])('validates the real builder hook for unsigned=%s', async (unsigned) => {
  const input = await fixture(true)
  const certificate = join(input.root, 'certificate.cer')
  await writeFile(certificate, 'fixture public certificate')
  const config = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.example.unpack', DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64', DSH_DESKTOP_UNSIGNED: unsigned ? '1' : '0',
    DSH_DESKTOP_WINDOWS_CER_FILE: certificate, DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
  }, 'win32', 'x64', input.source)
  // Qualification replaces files after creating the base configuration; builder owns a separate config object.
  input.config.asarUnpack = [...config.asarUnpack]
  await config.beforePack(input.context)
  await packageFixture(input)
  await config.afterPack(input.context)
  if (!unsigned) await config.afterSign(input.context)
  const file = join(input.resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'foo', 'custom.binary')
  await writeFile(file, 'changed after packaging')
  if (unsigned) await expect(config.afterPack(input.context)).rejects.toThrow('PE bytes changed')
  else {
    await config.afterPack(input.context)
    await expect(config.afterSign(input.context)).rejects.toThrow('PE bytes changed')
  }
})

it.each([false, true])('unpacks platform ripgrep executables with external source=%s', async (external) => {
  const input = await fixture(external)
  // Windows rg.exe uses the general executable rule; macOS rg uses the platform-package rule.
  const files = ['ripgrep-darwin-arm64/bin/rg', 'ripgrep-darwin-x64/bin/rg', 'ripgrep-win32-x64/bin/rg.exe']
  for (const file of [...files, 'ripgrep/lib/index.js']) {
    const path = join(input.source, 'node_modules', '@vscode', file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'ripgrep fixture')
  }
  const config = unsignedWindowsConfig('com.example.ripgrep', input.source)
  input.config.asarUnpack = [...config.asarUnpack]
  await packageFixture(input)
  const archive = await readAsar(join(input.resources, 'app.asar'))
  expect(archive.getFile(join('dsh', 'node_modules', '@vscode', 'ripgrep/lib/index.js')).unpacked).not.toBe(true)
  for (const file of files) {
    const path = join('dsh', 'node_modules', '@vscode', file)
    expect(archive.getFile(path, false).unpacked).toBe(true)
    expect(await readFile(join(input.resources, 'app.asar.unpacked', path), 'utf8')).toBe('ripgrep fixture')
  }
})

it.each([false, true])('keeps the complete Office engine outside ASAR with external source=%s', async (external) => {
  const input = await fixture(external)
  const engine = join('node_modules', '@deepseek-ai', 'libreoffice-kit-win32-x64')
  const files = ['package.json', 'prebuilds.json', 'bin/libreoffice-kit', 'program/registry/main.xcd']
  for (const file of files) {
    const path = join(input.source, engine, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{}')
  }
  const wasm = join(input.source, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json')
  await mkdir(dirname(wasm), { recursive: true })
  await writeFile(wasm, '{}')
  const config = unsignedWindowsConfig('com.example.office', input.source)
  input.config.asarUnpack = [...config.asarUnpack]
  await config.beforePack(input.context)
  await packageFixture(input)
  const archive = await readAsar(join(input.resources, 'app.asar'))
  expect(archive.getFile(join('dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit-wasm', 'package.json')).unpacked).not.toBe(true)
  for (const name of ['@deepseek-ai/libreoffice-kit', 'office-codec']) {
    expect(archive.getFile(join('dsh', 'node_modules', name, 'cli.js')).unpacked).toBe(true)
  }
  for (const file of files) {
    expect(archive.getFile(join('dsh', engine, file), false).unpacked).toBe(true)
    expect(await readFile(join(input.resources, 'app.asar.unpacked', 'dsh', engine, file), 'utf8')).toBe('{}')
  }
})

async function seal(input: Awaited<ReturnType<typeof fixture>>): Promise<DesktopRuntimeDescriptor> {
  const descriptor: DesktopRuntimeDescriptor = {
    schemaVersion: 1,
    release: { schemaVersion: 1, version: '1.0.0', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: process.versions.node, pnpmVersion: '11.7.0' },
    platform: process.platform, arch: process.arch,
    sharedPackages: [{ name: 'foo', version: '1.0.0', path: 'node_modules/foo' }],
    files: inventoryDesktopRuntime(input.source),
  }
  await writeFile(join(input.source, 'desktop-runtime.json'), `${JSON.stringify(descriptor, undefined, 2)}\n`)
  return descriptor
}

it('verifies archived bytes against the preparation descriptor', async () => {
  const input = await fixture(false)
  const expected = await seal(input)
  await packageFixture(input)
  const archive = join(input.resources, 'app.asar')
  await expect(verifyRuntimeArchive(archive, expected)).resolves.toBeUndefined()
  await writeFile(join(input.resources, 'app.asar.unpacked/dsh/node_modules/foo/native.node'), 'tampered')
  await expect(verifyRuntimeArchive(archive, expected)).rejects.toThrow('ASAR integrity')
})

it.each(['sharedPackages', 'release', 'files'] as const)('rejects changed archived descriptor %s', async (field) => {
  const input = await fixture(false)
  const expected = await seal(input)
  const changed = { ...expected, [field]: field === 'release' ? { ...expected.release, version: '2.0.0' } : [] }
  await writeFile(join(input.source, 'desktop-runtime.json'), `${JSON.stringify(changed, undefined, 2)}\n`)
  await packageFixture(input)
  await expect(verifyRuntimeArchive(join(input.resources, 'app.asar'), expected)).rejects.toThrow('archived descriptor differs')
})

it.each(['missing', 'extra'] as const)('rejects %s archived files', async (state) => {
  const input = await fixture(false)
  const expected = await seal(input)
  if (state === 'missing') await rm(join(input.source, 'node_modules/foo/companion.json'))
  else await writeFile(join(input.source, 'extra.json'), '{}')
  await packageFixture(input)
  await expect(verifyRuntimeArchive(join(input.resources, 'app.asar'), expected)).rejects.toThrow('ASAR integrity')
})

it.each(['directory', 'extra'] as const)('rejects an unpacked %s without a matching file record', async (state) => {
  const input = await fixture(false)
  const expected = await seal(input)
  await packageFixture(input)
  const root = join(input.resources, 'app.asar.unpacked/dsh')
  if (state === 'directory') {
    const file = join(root, 'node_modules/foo/native.node')
    await rm(file)
    await mkdir(file)
  } else await writeFile(join(root, 'extra.json'), '{}')
  await expect(verifyRuntimeArchive(join(input.resources, 'app.asar'), expected)).rejects.toThrow('unexpected unpacked entry')
})

// Windows file symlinks require privileges unavailable on some CI runners.
it.skipIf(process.platform === 'win32')('rejects ASAR links', async () => {
  const input = await fixture(false)
  const expected = await seal(input)
  await symlink('companion.json', join(input.source, 'node_modules/foo/alias.json'))
  await packageFixture(input)
  await expect(verifyRuntimeArchive(join(input.resources, 'app.asar'), expected)).rejects.toThrow('unexpected ASAR link')
})

it.skipIf(process.platform === 'win32')('checks packed executable records and physical unpacked permissions', async () => {
  const input = await fixture(false)
  for (const name of ['extensionless', 'native.node']) await chmod(join(input.source, 'node_modules/foo', name), 0o755)
  const expected = await seal(input)
  await packageFixture(input)
  const archive = join(input.resources, 'app.asar')
  await expect(verifyRuntimeArchive(archive, expected)).resolves.toBeUndefined()
  await chmod(join(input.resources, 'app.asar.unpacked/dsh/node_modules/foo/native.node'), 0o644)
  await expect(verifyRuntimeArchive(archive, expected)).rejects.toThrow('ASAR integrity')
})

it.skipIf(process.platform === 'win32')('rejects group-only executable files whose ASAR record loses that permission', async () => {
  const input = await fixture(false)
  await chmod(join(input.source, 'node_modules/foo/extensionless'), 0o654)
  const expected = await seal(input)
  await packageFixture(input)
  await expect(verifyRuntimeArchive(join(input.resources, 'app.asar'), expected)).rejects.toThrow('ASAR integrity')
})
