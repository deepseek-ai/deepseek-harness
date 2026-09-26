import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_BUILD_COMMIT_ENV,
  DESKTOP_BUILD_DIRTY_ENV,
  desktopBuildCommitEnvironment,
  readDesktopBuildCommit,
  resolveDesktopBuildCommit,
} from '../scripts/desktop-build-commit.mjs'
import { probeDesktopToolchain } from '../scripts/desktop-toolchain-preflight.ts'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('desktop build commit', () => {
  it('reads nothing outside a packaging run', () => {
    expect(resolveDesktopBuildCommit({})).toBeUndefined()
    expect(resolveDesktopBuildCommit({ [DESKTOP_BUILD_COMMIT_ENV]: '  ' })).toBeUndefined()
  })

  it('round-trips a commit and its tree state through a child environment', () => {
    for (const dirty of [true, false]) {
      expect(resolveDesktopBuildCommit(desktopBuildCommitEnvironment({ commit: COMMIT, dirty })))
        .toEqual({ commit: COMMIT, dirty })
    }
  })

  it.each(['abc', `${COMMIT}0`, 'Z'.repeat(40)])('rejects %j, which is not a commit hash', (commit) => {
    expect(() => resolveDesktopBuildCommit({ [DESKTOP_BUILD_COMMIT_ENV]: commit })).toThrow(/must be a commit hash/u)
  })

  it('rejects a tree state that is neither 0 nor 1', () => {
    expect(() => resolveDesktopBuildCommit({ [DESKTOP_BUILD_COMMIT_ENV]: COMMIT, [DESKTOP_BUILD_DIRTY_ENV]: 'yes' }))
      .toThrow(/must be 0 or 1/u)
  })

  it('reads the checkout this repository is in', () => {
    const packaged = readDesktopBuildCommit(join(import.meta.dirname, '..', '..', '..'))
    expect(packaged.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(typeof packaged.dirty).toBe('boolean')
  })
})

describe('desktop toolchain preflight', () => {
  it('passes on a host that can read archives', async () => {
    expect(await probeDesktopToolchain('darwin', {})).toEqual([])
  })

  it('reports the archive reader when it cannot run', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-no-tools-'))
    directories.push(empty)
    const saved = { PATH: process.env.PATH, Path: process.env.Path }
    try {
      Object.assign(process.env, { PATH: empty, Path: empty })
      const failures = await probeDesktopToolchain('darwin', {})
      expect(failures.map(failure => failure.tool)).toEqual(['tar'])
      expect(failures[0]?.detail).not.toBe('')
    }
    finally {
      Object.assign(process.env, saved)
    }
  })

  it('reports the Windows installer compiler when the host cannot locate Visual Studio', async () => {
    const failures = await probeDesktopToolchain('win32', {})
    expect(failures.map(failure => failure.tool)).toContain('vswhere')
    expect(failures.find(failure => failure.tool === 'vswhere')?.detail).toContain('ProgramFiles(x86)')
  })

  it('writes nothing into the working directory while probing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-probe-cwd-'))
    directories.push(directory)
    await writeFile(join(directory, 'sentinel'), '')
    await probeDesktopToolchain('darwin', {})
    expect(await import('node:fs/promises').then(async fs => fs.readdir(directory))).toEqual(['sentinel'])
  })
})
