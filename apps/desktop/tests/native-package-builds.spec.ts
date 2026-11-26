/** Native addon build environment and object-file architecture checks. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchingArchitecture, nativeBuildEnvironment, parseDeveloperEnvironment, vcvarsallTarget } from '../scripts/native-package-builds.mjs'

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
  it('recognizes only the target operating system object format', () => {
    expect(matchingArchitecture(binaryFor('darwin', 'arm64'), { platform: 'win32', arch: 'arm64' })).toBe(false)
    expect(matchingArchitecture(binaryFor('win32', 'x64'), { platform: 'darwin', arch: 'x64' })).toBe(false)
    expect(matchingArchitecture(Buffer.alloc(4), { platform: 'darwin', arch: 'arm64' })).toBe(false)
    expect(matchingArchitecture(binaryFor('win32', 'x64'), { platform: 'linux', arch: 'x64' })).toBe(false)
  })
})
