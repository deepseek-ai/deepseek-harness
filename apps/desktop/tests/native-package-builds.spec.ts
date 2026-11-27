/** Desktop packaging builds and verifies the native addons runtime packages declare in `dsh.native`, knowing no package by name. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildNativePackage, buildNativePackages, matchingArchitecture, nativeBuildEnvironment, nativePackageBuildAt, nativePackageBuilds,
  parseDeveloperEnvironment, vcvarsallTarget, verifyNativePackages,
} from '../scripts/native-package-builds.mjs'

const roots: string[] = []
const targets = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'] as const
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
/**
 * The fixture builds only run Node, so on Windows they present an MSVC environment already set up for `arch` instead
 * of probing for a C++ toolchain of that architecture; the conditional test below covers the real probe.
 */
function toolchainFor(arch: string): void {
  vi.stubEnv('VSCMD_ARG_TGT_ARCH', arch)
}

function binaryFor(platform: string, arch: string): Buffer {
  const binary = Buffer.alloc(80)
  if (platform === 'darwin') {
    binary.writeUInt32LE(0xfeedfacf, 0)
    binary.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4)
  } else {
    binary.writeUInt16LE(0x5a4d, 0)
    binary.writeUInt32LE(64, 0x3c)
    binary.writeUInt32LE(0x4550, 64)
    binary.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68)
  }
  return binary
}
function split(name: string): { platform: string; arch: string } {
  const [platform, arch] = name.split('-') as [string, string]
  return { platform, arch }
}

/**
 * A runtime root with one declaring package, optionally nested under another package, whose build script writes the
 * addon and its record for the requested architecture.
 */
async function runtime(options: { nested?: boolean; native?: unknown; failBuild?: boolean } = {}) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'native-package-builds-'))
  roots.push(runtimeRoot)
  const packageRoot = options.nested === true
    ? join(runtimeRoot, 'node_modules', 'host', 'node_modules', '@deepseek-ai', 'dsh-addon-package')
    : join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-addon-package')
  await mkdir(join(packageRoot, 'native'), { recursive: true })
  if (options.nested === true) await writeFile(join(runtimeRoot, 'node_modules', 'host', 'package.json'), JSON.stringify({ name: 'host' }))
  await mkdir(join(runtimeRoot, 'node_modules', 'plain'), { recursive: true })
  await writeFile(join(runtimeRoot, 'node_modules', 'plain', 'package.json'), JSON.stringify({ name: 'plain' }))
  await mkdir(join(runtimeRoot, 'node_modules', '.bin'), { recursive: true })
  const native = options.native ?? { build: 'native/build.mjs', addons: ['native/out/{platform}-{arch}/addon.node'] }
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-addon-package', dsh: { native } }))
  await writeFile(join(packageRoot, 'native', 'build.mjs'), `
    import { createHash } from 'node:crypto'
    import { mkdirSync, writeFileSync } from 'node:fs'
    if (${String(options.failBuild === true)}) process.exit(3)
    const arch = process.argv[process.argv.indexOf('--arch') + 1]
    const bytes = Buffer.alloc(80)
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4)
    const directory = 'native/out/darwin-' + arch
    mkdirSync(directory, { recursive: true })
    writeFileSync(directory + '/addon.node', bytes)
    writeFileSync(directory + '/addon.json', JSON.stringify({ platform: 'darwin-' + arch, sha256: createHash('sha256').update(bytes).digest('hex') }))
    writeFileSync(directory + '/headers.txt', process.env.DSH_NODE_API_HEADERS ?? '')
  `)
  return { runtimeRoot, packageRoot }
}

async function writeAddon(packageRoot: string, name: string, binary = binaryFor(...Object.values(split(name)) as [string, string])) {
  const directory = join(packageRoot, 'native', 'out', name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'addon.node'), binary)
  const record = { platform: name, sha256: createHash('sha256').update(binary).digest('hex') }
  await writeFile(join(directory, 'addon.json'), JSON.stringify(record))
  return { directory, record }
}

describe('discovery', () => {
  it('finds declaring packages at the top level and nested under other packages, and skips the rest', async () => {
    const top = await runtime()
    expect(nativePackageBuilds(top.runtimeRoot)).toEqual([{
      name: '@deepseek-ai/dsh-addon-package', root: top.packageRoot, build: 'native/build.mjs', addons: ['native/out/{platform}-{arch}/addon.node'],
    }])
    const nested = await runtime({ nested: true })
    expect(nativePackageBuilds(nested.runtimeRoot).map(declaration => declaration.root)).toEqual([nested.packageRoot])
    expect(nativePackageBuilds(join(tmpdir(), 'no-such-runtime'))).toEqual([])
    expect(nativePackageBuildAt(join(top.runtimeRoot, 'node_modules', 'plain'))).toBeUndefined()
    expect(nativePackageBuildAt(join(top.runtimeRoot, 'missing'))).toBeUndefined()
  })
  it('ignores the declaration of a package outside DeepSeek Harness and never runs its build', async () => {
    const f = await runtime()
    const foreign = join(f.runtimeRoot, 'node_modules', 'foreign')
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'package.json'), JSON.stringify({ name: 'foreign', dsh: { native: { build: 'build.mjs', addons: ['a.node'] } } }))
    await writeFile(join(foreign, 'build.mjs'), 'require(\'node:fs\').writeFileSync(\'ran\', \'\')')
    const scoped = join(f.runtimeRoot, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
    await mkdir(scoped, { recursive: true })
    await writeFile(join(scoped, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit', dsh: { native: 'invalid' } }))
    expect(nativePackageBuilds(f.runtimeRoot).map(declaration => declaration.name)).toEqual(['@deepseek-ai/dsh-addon-package'])
    toolchainFor('arm64')
    expect(buildNativePackages(f.runtimeRoot, 'arm64')).toEqual(['@deepseek-ai/dsh-addon-package'])
    await expect(readFile(join(foreign, 'ran'))).rejects.toThrow('ENOENT')
  })
  it.each([
    ['no object', 'native/build.mjs'],
    ['an absolute build', { build: '/tmp/build.mjs', addons: ['a.node'] }],
    ['an escaping build', { build: '../build.mjs', addons: ['a.node'] }],
    ['no addons', { build: 'native/build.mjs', addons: [] }],
    ['an addon that is not .node', { build: 'native/build.mjs', addons: ['native/a.dll'] }],
  ])('rejects a declaration with %s', async (_name, native) => {
    const f = await runtime({ native })
    expect(() => nativePackageBuilds(f.runtimeRoot)).toThrow('@deepseek-ai/dsh-addon-package declares an invalid dsh.native')
  })
})

describe('build environment', () => {
  it('names the vcvarsall.bat target for native and cross builds', () => {
    expect(vcvarsallTarget('x64', 'x64')).toBe('x64')
    expect(vcvarsallTarget('x64', 'arm64')).toBe('x64_arm64')
    expect(vcvarsallTarget('arm64', 'x64')).toBe('arm64_x64')
  })
  it('reads the environment set prints after the marker, ignoring the vcvarsall.bat banner', () => {
    const output = [
      '** Visual Studio 2022 Developer Command Prompt', 'BANNER=not environment', '--- dsh native build environment --- ',
      'Path=C:\\VS\\bin;C:\\Windows', 'VSCMD_ARG_TGT_ARCH=arm64', 'EMPTY=', 'not a variable', '',
    ].join('\r\n')
    expect(parseDeveloperEnvironment(output)).toEqual({ Path: 'C:\\VS\\bin;C:\\Windows', VSCMD_ARG_TGT_ARCH: 'arm64', EMPTY: '' })
    expect(() => parseDeveloperEnvironment('[ERROR:vcvarsall.bat] Invalid argument found')).toThrow('printed no environment')
  })
  it.skipIf(process.platform === 'win32')('keeps the packaging environment outside Windows and names Desktop\'s Node-API headers', () => {
    const { DSH_NODE_API_HEADERS: headers, ...rest } = nativeBuildEnvironment('arm64', { PATH: '/usr/bin' })
    expect(rest).toEqual({ PATH: '/usr/bin' })
    if (headers === undefined) throw new Error('DSH_NODE_API_HEADERS is unset')
    expect(headers).toMatch(/node-api-headers$/u)
    expect(existsSync(join(headers, 'include', 'node_api.h'))).toBe(true)
    expect(existsSync(join(headers, 'def', 'node_api.def'))).toBe(true)
  })
})

describe('build', () => {
  it('runs each declared build for the target architecture and leaves an addon packaging accepts', async () => {
    const f = await runtime({ nested: true })
    toolchainFor('x64')
    expect(buildNativePackages(f.runtimeRoot, 'x64')).toEqual(['@deepseek-ai/dsh-addon-package'])
    const record = JSON.parse(await readFile(join(f.packageRoot, 'native', 'out', 'darwin-x64', 'addon.json'), 'utf8')) as { platform: string }
    expect(record.platform).toBe('darwin-x64')
    expect(await readFile(join(f.packageRoot, 'native', 'out', 'darwin-x64', 'headers.txt'), 'utf8')).toMatch(/node-api-headers$/u)
    expect(() => { verifyNativePackages(f.runtimeRoot, { platform: 'darwin', arch: 'x64' }) }).not.toThrow()
  })
  it('names the package whose build fails', async () => {
    const f = await runtime({ failBuild: true })
    toolchainFor('arm64')
    expect(() => buildNativePackages(f.runtimeRoot, 'arm64')).toThrow('@deepseek-ai/dsh-addon-package native build failed (3)')
    expect(() => { buildNativePackage({ name: 'missing', root: f.runtimeRoot, build: 'nothing.mjs' }, 'arm64') }).toThrow('missing native build failed')
  })
})

const vswhere = join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')

describe('build environment', () => {
  it('names the vcvarsall.bat target for native and cross builds', () => {
    expect(vcvarsallTarget('x64', 'x64')).toBe('x64')
    expect(vcvarsallTarget('x64', 'arm64')).toBe('x64_arm64')
    expect(vcvarsallTarget('arm64', 'x64')).toBe('arm64_x64')
  })
  it('reads the environment set prints after the marker, ignoring the vcvarsall.bat banner', () => {
    const output = [
      '** Visual Studio 2022 Developer Command Prompt', 'BANNER=not environment', '--- dsh native build environment --- ',
      'Path=C:\\VS\\bin;C:\\Windows', 'VSCMD_ARG_TGT_ARCH=arm64', 'EMPTY=', 'not a variable', '',
    ].join('\r\n')
    expect(parseDeveloperEnvironment(output)).toEqual({ Path: 'C:\\VS\\bin;C:\\Windows', VSCMD_ARG_TGT_ARCH: 'arm64', EMPTY: '' })
    expect(() => parseDeveloperEnvironment('[ERROR:vcvarsall.bat] Invalid argument found')).toThrow('printed no environment')
  })
  it('keeps an environment already set up for the target and names Desktop\'s Node-API headers', () => {
    const { DSH_NODE_API_HEADERS: headers, ...rest } = nativeBuildEnvironment('arm64', { PATH: 'fixture', VSCMD_ARG_TGT_ARCH: 'arm64' })
    expect(rest).toEqual({ PATH: 'fixture', VSCMD_ARG_TGT_ARCH: 'arm64' })
    if (headers === undefined) throw new Error('DSH_NODE_API_HEADERS is unset')
    expect(headers).toMatch(/node-api-headers$/u)
    expect(existsSync(join(headers, 'include', 'node_api.h'))).toBe(true)
    expect(existsSync(join(headers, 'def', 'node_api.def'))).toBe(true)
  })
  it.runIf(process.platform === 'win32' && existsSync(vswhere))('sets up the MSVC developer environment for the Windows target', () => {
    const environment = nativeBuildEnvironment('x64', { ...process.env, VSCMD_ARG_TGT_ARCH: undefined })
    expect(environment.VSCMD_ARG_TGT_ARCH).toBe('x64')
    expect(environment.INCLUDE).toBeTruthy()
  }, 120_000)
})

describe('verification', () => {
  it.each(targets)('accepts the built %s addon', async (name) => {
    const f = await runtime()
    await writeAddon(f.packageRoot, name)
    expect(() => { verifyNativePackages(f.runtimeRoot, split(name)) }).not.toThrow()
  })
  it('requires the addon of the packaged target and names the package that builds it', async () => {
    const f = await runtime()
    await writeAddon(f.packageRoot, 'darwin-arm64')
    expect(() => { verifyNativePackages(f.runtimeRoot, { platform: 'darwin', arch: 'x64' }) }).toThrow('prepare:dsh builds @deepseek-ai/dsh-addon-package')
  })
  it.each([
    ['a stale hash', { sha256: '0'.repeat(64) }],
    ['another platform', { platform: 'darwin-x64' }],
  ] as const)('rejects a build record from %s', async (_name, override) => {
    const f = await runtime()
    const { directory, record } = await writeAddon(f.packageRoot, 'darwin-arm64')
    await writeFile(join(directory, 'addon.json'), JSON.stringify({ ...record, ...override }))
    expect(() => { verifyNativePackages(f.runtimeRoot, { platform: 'darwin', arch: 'arm64' }) }).toThrow('differs from its build record')
  })
  it('rejects an addon without a build record', async () => {
    const f = await runtime()
    const { directory } = await writeAddon(f.packageRoot, 'darwin-arm64')
    await rm(join(directory, 'addon.json'))
    expect(() => { verifyNativePackages(f.runtimeRoot, { platform: 'darwin', arch: 'arm64' }) }).toThrow('differs from its build record')
  })
  it('rejects an addon for another CPU even when its directory and record name the target', async () => {
    const f = await runtime()
    await writeAddon(f.packageRoot, 'darwin-arm64', binaryFor('darwin', 'x64'))
    expect(() => { verifyNativePackages(f.runtimeRoot, { platform: 'darwin', arch: 'arm64' }) }).toThrow('is not darwin-arm64')
  })
  it('recognizes only the target operating system object format', () => {
    expect(matchingArchitecture(binaryFor('darwin', 'arm64'), { platform: 'win32', arch: 'arm64' })).toBe(false)
    expect(matchingArchitecture(binaryFor('win32', 'x64'), { platform: 'darwin', arch: 'x64' })).toBe(false)
    expect(matchingArchitecture(Buffer.alloc(4), { platform: 'darwin', arch: 'arm64' })).toBe(false)
    expect(matchingArchitecture(binaryFor('win32', 'x64'), { platform: 'linux', arch: 'x64' })).toBe(false)
  })
})
