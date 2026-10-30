import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { desktopOfficeEnvironment, officeCliPath } from '../src/office-cli.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-office-cli-')))
  roots.push(root)
  return root
}

function installPackage(directory: string, name: string): string {
  const pkg = join(directory, 'node_modules', '@deepseek-ai', name)
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}` }))
  writeFileSync(join(pkg, 'lib', 'cli.js'), 'export {}\n')
  return pkg
}

function runtime(directory: string): string {
  installPackage(directory, 'dsh-desktop-host')
  return join(installPackage(directory, 'libreoffice-kit'), 'lib', 'cli.js')
}

function archiveRuntime(runtimeName = 'dsh') {
  const root = temporaryRoot()
  const resources = join(root, '应用 Resources')
  mkdirSync(resources)
  const archive = join(resources, 'app.asar')
  // Plain Node cannot traverse an archive file; this helper must only read its unpacked sibling.
  writeFileSync(archive, 'archive fixture')
  return { root, resources, archive, directory: join(archive, runtimeName), unpacked: join(`${archive}.unpacked`, runtimeName) }
}

it('returns the CLI entry inside a prepared runtime', () => {
  const directory = join(temporaryRoot(), '准备 runtime')
  const cli = runtime(directory)
  expect(officeCliPath(directory)).toBe(cli)
})

it('preserves default DesktopHost dependency resolution outside ASAR', () => {
  const directory = join(temporaryRoot(), 'dsh')
  runtime(directory)
  const host = join(directory, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  const kit = installPackage(host, 'libreoffice-kit')
  expect(officeCliPath(directory)).toBe(join(kit, 'lib', 'cli.js'))
})

it('accepts a prepared runtime directory alias', () => {
  const root = temporaryRoot()
  const directory = join(root, '准备 runtime')
  const cli = runtime(directory)
  const alias = join(root, 'runtime alias')
  symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(officeCliPath(alias)).toBe(cli)
})

it('resolves an unpacked CLI beside an ASAR file under plain Node', () => {
  const f = archiveRuntime()
  const cli = runtime(f.unpacked)
  // An ancestor package must not substitute for the shipped unpacked copy.
  installPackage(f.root, 'libreoffice-kit')
  expect(statSync(f.archive).isFile()).toBe(true)
  expect(desktopOfficeEnvironment(f.directory, '/resources/runtime/primary-runtime')).toEqual({
    DSH_BUNDLED_PRIMARY_RUNTIME: '/resources/runtime/primary-runtime',
    DSH_BUNDLED_OFFICE_CLI: cli,
  })
  expect(statSync(cli).isFile()).toBe(true)
})

it('preserves the ASAR runtime basename with spaces and non-ASCII characters', () => {
  const f = archiveRuntime('运行 runtime')
  const cli = runtime(f.unpacked)
  expect(officeCliPath(f.directory)).toBe(cli)
})

it('accepts an ASAR resource directory alias', () => {
  const f = archiveRuntime()
  const cli = runtime(f.unpacked)
  const alias = join(f.root, '资源 alias')
  symlinkSync(f.resources, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(officeCliPath(join(alias, 'app.asar', 'dsh'))).toBe(cli)
})

it('accepts an unpacked runtime directory alias', () => {
  const f = archiveRuntime()
  const physical = join(f.root, '实体 runtime')
  const cli = runtime(physical)
  mkdirSync(dirname(f.unpacked))
  symlinkSync(physical, f.unpacked, process.platform === 'win32' ? 'junction' : 'dir')
  expect(officeCliPath(f.directory)).toBe(cli)
})

it('resolves kit from the physical DesktopHost package through a directory alias', () => {
  const f = archiveRuntime()
  const host = installPackage(join(f.unpacked, 'packages'), 'dsh-desktop-host')
  const kit = installPackage(host, 'libreoffice-kit')
  const alias = join(f.unpacked, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(dirname(alias), { recursive: true })
  symlinkSync(host, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(officeCliPath(f.directory)).toBe(join(kit, 'lib', 'cli.js'))
})

it('fails when the unpacked runtime is missing', () => {
  const f = archiveRuntime()
  installPackage(f.root, 'libreoffice-kit')
  expect(() => officeCliPath(f.directory)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
})

it('resolves the unpacked kit when DesktopHost itself remains in the archive', () => {
  const f = archiveRuntime()
  const kit = installPackage(f.unpacked, 'libreoffice-kit')
  expect(officeCliPath(f.directory)).toBe(join(kit, 'lib', 'cli.js'))
})

it('fails when the unpacked kit package is missing', () => {
  const f = archiveRuntime()
  installPackage(f.unpacked, 'dsh-desktop-host')
  expect(() => officeCliPath(f.directory)).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
})

it('rejects an ancestor kit package when the unpacked kit is missing', () => {
  const f = archiveRuntime()
  const host = installPackage(f.unpacked, 'dsh-desktop-host')
  const external = installPackage(f.root, 'libreoffice-kit')
  expect(createRequire(join(host, 'package.json')).resolve('@deepseek-ai/libreoffice-kit/package.json'))
    .toBe(join(external, 'package.json'))
  expect(() => officeCliPath(f.directory)).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
})

it('rejects a kit directory alias outside the unpacked runtime', () => {
  const f = archiveRuntime()
  installPackage(f.unpacked, 'dsh-desktop-host')
  const external = installPackage(`${f.unpacked}-external`, 'libreoffice-kit')
  const alias = join(f.unpacked, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  symlinkSync(external, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => officeCliPath(f.directory)).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
})
