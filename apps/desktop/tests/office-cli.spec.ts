import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { desktopNodeEnvironment } from '../src/node-environment.ts'
import { OFFICE_KIT_DIAGNOSTIC, desktopOfficeEnvironment, officeCliPath, writeOfficeKitDiagnostic } from '../src/office-cli.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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
  installPackage(directory, 'dsh-skill-office')
  return join(installPackage(directory, 'libreoffice-kit'), 'lib', 'cli.js')
}

// pnpm's NODE_PATH exposes workspace packages; missing-package fixtures need plain Node's local search only.
function resolveWithoutGlobalPackages(directory: string): unknown {
  return JSON.parse(execFileSync(process.execPath, ['--no-global-search-paths', '--input-type=module', '-e', `
    import { officeCliPath } from ${JSON.stringify(new URL('../src/office-cli.ts', import.meta.url).href)}
    try {
      console.log(JSON.stringify(officeCliPath(process.argv[1])))
    } catch (error) {
      console.log(JSON.stringify(error, ['message', 'code', 'cause', 'requireStack']))
    }
  `, directory], { encoding: 'utf8' }))
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

it('preserves default skill-office dependency resolution outside ASAR', () => {
  const directory = join(temporaryRoot(), 'dsh')
  runtime(directory)
  const skill = join(directory, 'node_modules', '@deepseek-ai', 'dsh-skill-office')
  const kit = installPackage(skill, 'libreoffice-kit')
  expect(officeCliPath(directory)).toBe(join(kit, 'lib', 'cli.js'))
})

it('rejects kit available only through the Desktop Host package in a prepared runtime', () => {
  const directory = join(temporaryRoot(), 'dsh')
  const host = installPackage(directory, 'dsh-desktop-host')
  const kit = installPackage(host, 'libreoffice-kit')
  expect(createRequire(join(host, 'package.json')).resolve('@deepseek-ai/libreoffice-kit/package.json'))
    .toBe(join(kit, 'package.json'))
  expect(resolveWithoutGlobalPackages(directory)).toEqual(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
})

it('reports a missing kit with reinstall guidance and the original resolution error', () => {
  const directory = join(temporaryRoot(), 'dsh')
  mkdirSync(directory)
  const error = resolveWithoutGlobalPackages(directory)
  expect(error).toMatchObject({
    message: `LibreOffice Kit is missing from the Desktop runtime: ${directory}. Reinstall Desktop.`,
    code: 'MODULE_NOT_FOUND',
    cause: {
      code: 'MODULE_NOT_FOUND',
      requireStack: [join(directory, 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'package.json')],
    },
  })
  expect(error).toHaveProperty('cause.message', expect.stringContaining("Cannot find module '@deepseek-ai/libreoffice-kit/package.json'"))
})

it('preserves resolution errors other than a missing module', () => {
  const directory = join(temporaryRoot(), 'dsh')
  const kit = installPackage(directory, 'libreoffice-kit')
  writeFileSync(join(kit, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/libreoffice-kit', exports: { '.': './lib/cli.js' },
  }))
  const error = resolveWithoutGlobalPackages(directory)
  expect(error).toEqual(expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }))
  expect(error).not.toHaveProperty('cause')
})

it('rejects kit available only through the Desktop Host package', () => {
  const f = archiveRuntime()
  const host = installPackage(f.unpacked, 'dsh-desktop-host')
  const kit = installPackage(host, 'libreoffice-kit')
  expect(createRequire(join(host, 'package.json')).resolve('@deepseek-ai/libreoffice-kit/package.json'))
    .toBe(join(kit, 'package.json'))
  expect(() => officeCliPath(f.directory)).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
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
  expect(desktopOfficeEnvironment(f.directory, '/resources/runtime/primary-runtime')).toEqual({ kind: 'ready', environment: {
    DSH_BUNDLED_PRIMARY_RUNTIME: '/resources/runtime/primary-runtime',
    DSH_BUNDLED_OFFICE_CLI: cli,
  } })
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

it('resolves kit from the physical skill-office package through a directory alias', () => {
  const f = archiveRuntime()
  const skill = installPackage(join(f.unpacked, 'packages'), 'dsh-skill-office')
  const kit = installPackage(skill, 'libreoffice-kit')
  const alias = join(f.unpacked, 'node_modules', '@deepseek-ai', 'dsh-skill-office')
  mkdirSync(dirname(alias), { recursive: true })
  symlinkSync(skill, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(officeCliPath(f.directory)).toBe(join(kit, 'lib', 'cli.js'))
})

it('fails when the unpacked runtime is missing', () => {
  const f = archiveRuntime()
  installPackage(f.root, 'libreoffice-kit')
  expect(() => officeCliPath(f.directory)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
})

it('resolves the unpacked kit when skill-office itself remains in the archive', () => {
  const f = archiveRuntime()
  const kit = installPackage(f.unpacked, 'libreoffice-kit')
  expect(officeCliPath(f.directory)).toBe(join(kit, 'lib', 'cli.js'))
})

it('fails when the unpacked kit package is missing', () => {
  const f = archiveRuntime()
  installPackage(f.unpacked, 'dsh-skill-office')
  expect(() => officeCliPath(f.directory)).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
})

it('rejects an ancestor kit package when the unpacked kit is missing', () => {
  const f = archiveRuntime()
  const skill = installPackage(f.unpacked, 'dsh-skill-office')
  const external = installPackage(f.root, 'libreoffice-kit')
  expect(createRequire(join(skill, 'package.json')).resolve('@deepseek-ai/libreoffice-kit/package.json'))
    .toBe(join(external, 'package.json'))
  expect(() => officeCliPath(f.directory)).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
})

it('rejects a kit directory alias outside the unpacked runtime', () => {
  const f = archiveRuntime()
  installPackage(f.unpacked, 'dsh-skill-office')
  const external = installPackage(`${f.unpacked}-external`, 'libreoffice-kit')
  const alias = join(f.unpacked, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  symlinkSync(external, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => officeCliPath(f.directory)).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
})

it.each([
  ['the unpacked runtime is missing', 'ENOENT', () => archiveRuntime()],
  ['the unpacked Kit is missing', 'MODULE_NOT_FOUND', () => {
    const f = archiveRuntime()
    installPackage(f.unpacked, 'dsh-skill-office')
    return f
  }],
  ['the Kit resolves outside the unpacked runtime', 'MODULE_NOT_FOUND', () => {
    const f = archiveRuntime()
    installPackage(f.unpacked, 'dsh-skill-office')
    const alias = join(f.unpacked, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
    symlinkSync(installPackage(`${f.unpacked}-external`, 'libreoffice-kit'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    return f
  }],
])('keeps the primary runtime and replaces an inherited CLI when %s', (_label, code, fixture) => {
  const f = fixture()
  const office = desktopOfficeEnvironment(f.directory, '/resources/runtime/primary-runtime')
  expect(office).toMatchObject({ kind: 'kit-unavailable', error: { code } })
  expect(office.environment).toStrictEqual({ DSH_BUNDLED_PRIMARY_RUNTIME: '/resources/runtime/primary-runtime', DSH_BUNDLED_OFFICE_CLI: undefined })
  // The Host child receives its environment through the same Node-mode projection as Desktop.
  const inherited: NodeJS.ProcessEnv = { ...process.env, DSH_BUNDLED_OFFICE_CLI: join(f.root, 'stale-cli.js') }
  const child = execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify([process.env.DSH_BUNDLED_PRIMARY_RUNTIME, "DSH_BUNDLED_OFFICE_CLI" in process.env]))'], {
    encoding: 'utf8',
    env: desktopNodeEnvironment(process.execPath, undefined, { ...inherited, ...office.environment }),
  })
  expect(JSON.parse(child)).toEqual(['/resources/runtime/primary-runtime', false])
})

it('records the Kit failure, its impact, and the reinstall action', async () => {
  const f = archiveRuntime()
  const office = desktopOfficeEnvironment(f.directory, '/primary-runtime')
  if (office.kind !== 'kit-unavailable') throw new Error('fixture located a Kit')
  const logs = join(f.root, 'logs')
  const path = await writeOfficeKitDiagnostic(logs, f.directory, office.error, new Date('2026-01-02T03:04:05.006Z'))
  expect(path).toBe(join(logs, OFFICE_KIT_DIAGNOSTIC))
  const report = readFileSync(path!, 'utf8')
  expect(report).toContain('time: 2026-01-02T03:04:05.006Z')
  expect(report).toContain(`runtime: ${f.directory}`)
  expect(report).toContain('impact: the LibreOffice Kit CLI is unavailable to Office skills; Office skills and the Desktop Host continue without CLI paths.')
  expect(report).toContain('action: reinstall Desktop to restore the bundled LibreOffice Kit.')
  expect(report).toContain('ENOENT')
})

it('reports a failed Kit diagnostic write to stderr without rejecting', async () => {
  const root = temporaryRoot()
  const logs = join(root, 'logs')
  writeFileSync(logs, 'not a directory')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const original = new Error('kit missing')
  await expect(writeOfficeKitDiagnostic(logs, join(root, 'dsh'), original, new Date())).resolves.toBeUndefined()
  expect(error).toHaveBeenCalledOnce()
  const call: readonly unknown[] = error.mock.calls[0]!
  const [summary, path, failure, reported] = call
  expect(summary).toContain('LibreOffice Kit diagnostic could not be written')
  expect(path).toBe(join(logs, OFFICE_KIT_DIAGNOSTIC))
  expect(failure).toBeInstanceOf(Error)
  expect(typeof (failure as NodeJS.ErrnoException).code).toBe('string')
  expect(reported).toBe(original)
})

it('rejects a runtime smoke without a Kit', async () => {
  const f = archiveRuntime()
  const smoke = smokeDesktopRuntime(f.directory, process.execPath, {} as DesktopRuntimeDescriptor, {}, join(f.root, 'resources'))
  const error = await smoke.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe('desktop runtime: LibreOffice Kit CLI is missing from the runtime')
  expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT')
})
