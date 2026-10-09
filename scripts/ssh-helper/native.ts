/** Inspect every native payload, including modules embedded in the executable. */
import { execFileSync } from 'node:child_process'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { payloadFiles, type SshHelperTarget } from './artifact.ts'

function newer(version: string, ceiling: number[]): boolean {
  const components = version.split('.').map(Number)
  for (let index = 0; index < Math.max(components.length, ceiling.length); index += 1) {
    const difference = (components[index] ?? 0) - (ceiling[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

/**
 * Read deployment versions without confusing linked-library versions with OS requirements.
 * @param output - otool load-command text, possibly containing multiple architecture slices.
 * @returns every minimum macOS version declared by the binary.
 */
export function macosDeploymentVersions(output: string): string[] {
  let command: string | undefined
  const versions: string[] = []
  for (const line of output.split('\n')) {
    const text = line.trim()
    if (/^Load command \d+$/.test(text)) command = undefined
    else if (text.startsWith('cmd ')) command = text.slice(4)
    else {
      const match = /^(minos|version)\s+(\d+(?:\.\d+)+)$/.exec(text)
      if (match !== null && ((command === 'LC_BUILD_VERSION' && match[1] === 'minos') || (command === 'LC_VERSION_MIN_MACOSX' && match[1] === 'version'))) versions.push(match[2] as string)
    }
  }
  return versions
}

/**
 * Inspect all ELF or Mach-O files for the requested architecture and deployment baseline.
 * @param directory - symlink-free staging or payload directory.
 * @param target - build target whose ABI must match every native file.
 * @returns relative paths of inspected native files.
 */
export async function verifyNativePayload(directory: string, target: SshHelperTarget): Promise<string[]> {
  const inspected: string[] = []
  const linux = target.includes('-linux-')
  const arch = target.endsWith('-arm64') ? 'arm64' : 'x64'
  for (const path of await payloadFiles(directory)) {
    const filename = join(directory, path)
    const file = await open(filename, 'r')
    const header = Buffer.alloc(4)
    try { await file.read(header, 0, 4, 0) } finally { await file.close() }
    const magic = header.readUInt32BE()
    const elf = magic === 0x7f454c46
    const macho = [0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe, 0xbebafeca, 0xcafebabf].includes(magic)
    if (!elf && !macho) continue
    if (linux !== elf) throw new Error(`Native file does not belong to ${target}: ${path}`)
    if (elf) {
      const elfHeader = execFileSync('readelf', ['--file-header', filename], { encoding: 'utf8' })
      const expected = arch === 'arm64' ? /Machine:\s+AArch64/ : /Machine:\s+Advanced Micro Devices X86-64/
      if (!expected.test(elfHeader)) throw new Error(`ELF architecture differs from ${target}: ${path}`)
      const versions = execFileSync('readelf', ['--version-info', filename], { encoding: 'utf8' })
      for (const match of versions.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)/g)) {
        if (newer(match[1] as string, [2, 28])) throw new Error(`${path} requires GLIBC_${match[1]}, exceeding 2.28`)
      }
    } else {
      execFileSync('lipo', [filename, '-verify_arch', arch === 'arm64' ? 'arm64' : 'x86_64'], { stdio: 'pipe' })
      const loads = execFileSync('otool', ['-l', filename], { encoding: 'utf8' })
      const versions = macosDeploymentVersions(loads)
      if (versions.length === 0) throw new Error(`Mach-O has no deployment version: ${path}`)
      if (versions.some(version => newer(version, [14, 0]))) throw new Error(`${path} requires macOS newer than 14.0`)
    }
    inspected.push(path)
  }
  return inspected
}
