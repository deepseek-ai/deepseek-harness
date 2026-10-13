/** Target-specific payload copying with filesystem link operations modeled independently of host privileges. */

import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { copyPrimaryRuntime, type PrimaryRuntimeManifest } from '../src/index.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, lstat: vi.fn(actual.lstat), readlink: vi.fn(actual.readlink), symlink: vi.fn(actual.symlink) }
})

const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(platform: string) {
  const root = await mkdtemp(join(tmpdir(), 'primary-runtime-copy-'))
  roots.push(root)
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  const bin = join(source, 'dependencies/python', ...(platform === 'win32' ? [] : ['bin']))
  await mkdir(bin, { recursive: true })
  const executable = platform === 'win32' ? 'python.exe' : 'python3.12'
  await writeFile(join(bin, executable), 'interpreter bytes')
  const manifest: PrimaryRuntimeManifest = { desktopVersion: '1', platform, arch: 'x64', python: '3.12.14', pythonPackages: {} }
  return { source, destination, bin, executable, manifest }
}

async function aliases(bin: string, target: string) {
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  const paths = ['python', 'python3'].map(name => join(bin, name))
  for (const path of paths) await writeFile(path, 'uncopied alias placeholder')
  vi.mocked(fs.lstat).mockImplementation(async (...args) => {
    const entry = await actual.lstat(...args)
    return typeof args[0] === 'string' && paths.includes(args[0])
      ? Object.assign(entry, { isSymbolicLink: () => true }) : entry
  })
  vi.mocked(fs.readlink).mockImplementation(async (path) => {
    if (typeof path === 'string' && paths.includes(path)) return target
    return actual.readlink(path)
  })
  // Exclusive writes expose accidental alias copies while recording the requested link text without OS symlink privileges.
  vi.mocked(fs.symlink).mockImplementation(async (target, path) => { await writeFile(path, String(target), { flag: 'wx' }) })
}

it.each(['linux', 'darwin', 'win32'])('copies a %s payload using its declared layout', async (platform) => {
  const { source, destination, bin, executable, manifest } = await fixture(platform)
  if (platform !== 'win32') await aliases(bin, executable)
  await copyPrimaryRuntime(source, destination, manifest)
  await rm(source, { recursive: true })
  const installedBin = join(destination, 'dependencies/python', ...(platform === 'win32' ? [] : ['bin']))
  expect(await readFile(join(installedBin, executable), 'utf8')).toBe('interpreter bytes')
  if (platform === 'win32') expect(fs.symlink).not.toHaveBeenCalled()
  else {
    expect(fs.symlink).toHaveBeenCalledTimes(2)
    for (const name of ['python', 'python3']) {
      expect(fs.symlink).toHaveBeenCalledWith('python3.12', join(installedBin, name))
      expect(await readFile(join(installedBin, name), 'utf8')).toBe('python3.12')
    }
  }
})

it.each(['absolute', 'escaping', 'chained', 'dangling', 'directory'])('rejects a %s alias before copying the payload', async (kind) => {
  const { source, destination, bin, executable, manifest } = await fixture('linux')
  const target = kind === 'absolute' ? join(bin, executable) : kind === 'escaping' ? '../outside' : kind === 'chained' ? 'python3' : executable
  await aliases(bin, target)
  if (kind === 'dangling' || kind === 'directory') await rm(join(bin, executable))
  if (kind === 'directory') await mkdir(join(bin, executable))
  if (kind === 'dangling') await expect(copyPrimaryRuntime(source, destination, manifest)).rejects.toMatchObject({ code: 'ENOENT' })
  else await expect(copyPrimaryRuntime(source, destination, manifest)).rejects.toThrow('invalid Python alias')
  await expect(fs.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(fs.symlink).not.toHaveBeenCalled()
})

it('copies legacy regular Python commands without requiring an optional alias', async () => {
  const { source, destination, bin, manifest } = await fixture('linux')
  await writeFile(join(bin, 'python3'), 'legacy interpreter')
  await copyPrimaryRuntime(source, destination, manifest)
  expect(await readFile(join(destination, 'dependencies/python/bin/python3'), 'utf8')).toBe('legacy interpreter')
  await expect(readFile(join(destination, 'dependencies/python/bin/python'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(fs.symlink).not.toHaveBeenCalled()
})
