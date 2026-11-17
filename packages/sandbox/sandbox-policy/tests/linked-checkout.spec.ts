/** The Git layout reads behind the sandbox policy's derived grants, against a real filesystem. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { linkedCheckoutAdministration, pointerDirectory, pointerText, within } from '../src/linked-checkout.ts'

const execute = promisify(execFile)
const signal = new AbortController().signal

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function scratch() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-linked-checkout-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd: base })
  return { base, fs: ctx.fs }
}

describe('within', () => {
  it('holds for the directory itself and paths below it, not for parents or siblings sharing a prefix', () => {
    const root = join(sep, 'work', 'repo')
    expect(within(root, root)).toBe(true)
    expect(within(root, join(root, 'packages', 'a'))).toBe(true)
    expect(within(root, join(sep, 'work'))).toBe(false)
    expect(within(root, `${root}-sibling`)).toBe(false)
    expect(within(root, join(root, '..', 'other'))).toBe(false)
  })
})

describe('pointer reads', () => {
  it('reads a regular pointer file relative to its directory and nothing else', async () => {
    const { base, fs } = await scratch()
    await writeFile(join(base, 'commondir'), '../..\n')
    await mkdir(join(base, 'directory'))
    expect(await pointerText(fs, 'commondir', base, signal)).toBe('../..\n')
    expect(await pointerText(fs, join(base, 'commondir'), tmpdir(), signal)).toBe('../..\n')
    expect(await pointerText(fs, 'directory', base, signal)).toBeUndefined()
    expect(await pointerText(fs, 'missing', base, signal)).toBeUndefined()
  })

  it('resolves a pointer target to the canonical directory it names, or to nothing', async () => {
    const { base, fs } = await scratch()
    const target = join(base, 'target')
    await mkdir(target)
    await symlink(target, join(base, 'link'))
    await writeFile(join(base, 'file'), '')
    expect(await pointerDirectory(fs, 'target', base, signal)).toBe(target)
    expect(await pointerDirectory(fs, 'link', base, signal)).toBe(target)
    expect(await pointerDirectory(fs, target, tmpdir(), signal)).toBe(target)
    expect(await pointerDirectory(fs, 'file', base, signal)).toBeUndefined()
    expect(await pointerDirectory(fs, 'missing', base, signal)).toBeUndefined()
  })
})

describe('linkedCheckoutAdministration', () => {
  it('names the common and administration directories of a linked worktree and nothing for its main checkout', async () => {
    const { base, fs } = await scratch()
    const repo = join(base, 'repo')
    await mkdir(repo)
    const git = (...args: string[]) => execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repo,
      env: {
        ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_DIR: undefined, GIT_WORK_TREE: undefined,
        GIT_AUTHOR_NAME: 'Policy fixture', GIT_AUTHOR_EMAIL: 'policy@example.invalid',
        GIT_COMMITTER_NAME: 'Policy fixture', GIT_COMMITTER_EMAIL: 'policy@example.invalid',
      },
    })
    await git('init', '-q', '-b', 'main')
    await git('config', 'commit.gpgSign', 'false')
    await git('commit', '-q', '--allow-empty', '-m', 'initial')
    const linked = join(base, 'linked')
    await git('worktree', 'add', '-q', '-b', 'linked', linked)

    expect(await linkedCheckoutAdministration(fs, linked, signal)).toEqual([join(repo, '.git'), join(repo, '.git', 'worktrees', 'linked')])
    expect(await linkedCheckoutAdministration(fs, repo, signal)).toEqual([])
    expect(await linkedCheckoutAdministration(fs, base, signal)).toEqual([])
  })
})
