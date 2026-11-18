/** Which directory layouts name a shared Git directory, against a real filesystem and the layouts Git writes. */
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sharedGitDirectory } from '../src/linked-worktree.ts'
import { cleanup, filesystem, git, repository, scratch, worktree } from './harness.ts'

const signal = new AbortController().signal

afterEach(cleanup)

async function layout(): Promise<{ base: string; repo: string; read: (root: string) => Promise<string | undefined> }> {
  const { base, repo } = await scratch()
  const fs = await filesystem(base)
  return { base, repo, read: root => sharedGitDirectory(fs, root, signal) }
}

/** A hand-written checkout directory whose `.git` file holds `pointer`. */
async function checkout(base: string, name: string, pointer: string): Promise<string> {
  const root = join(base, name)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, '.git'), pointer)
  return root
}

/** A hand-written administration directory at `path` with the given pointer files; undefined omits a file. */
async function administration(path: string, commondir: string | undefined, gitdir: string | undefined): Promise<string> {
  await mkdir(path, { recursive: true })
  if (commondir !== undefined) await writeFile(join(path, 'commondir'), commondir)
  if (gitdir !== undefined) await writeFile(join(path, 'gitdir'), gitdir)
  return path
}

describe('layouts Git writes', () => {
  it('names the repository Git directory for a linked worktree, also when the root is spelled through a symlink', async () => {
    const { base, repo, read } = await layout()
    const linked = await worktree(repo, base, 'linked')
    await symlink(linked, join(base, 'alias'))

    expect(await read(linked)).toBe(join(repo, '.git'))
    expect(await read(join(base, 'alias'))).toBe(join(repo, '.git'))
  })

  it('names it for a worktree nested inside another worktree and for a worktree of a bare repository', async () => {
    const { base, repo, read } = await layout()
    const outer = await worktree(repo, base, 'outer')
    const inner = join(outer, 'inner')
    await git(repo, 'worktree', 'add', '-q', '-b', 'inner', inner)
    await git(base, 'clone', '-q', '--bare', repo, 'bare.git')
    const fromBare = join(base, 'from-bare')
    await git(join(base, 'bare.git'), 'worktree', 'add', '-q', '-b', 'from-bare', fromBare)

    expect(await read(inner)).toBe(join(repo, '.git'))
    expect(await read(fromBare)).toBe(join(base, 'bare.git'))
  })

  it('follows relative pointers', async () => {
    const { base, repo, read } = await layout()
    const linked = await worktree(repo, base, 'relative')
    const admin = join(repo, '.git', 'worktrees', 'relative')
    await writeFile(join(linked, '.git'), `gitdir: ${relative(linked, admin)}\n`)
    await writeFile(join(admin, 'gitdir'), `${relative(admin, join(linked, '.git'))}\n`)
    expect((await readFile(join(admin, 'commondir'), 'utf8')).trim()).toBe('../..')

    expect(await read(linked)).toBe(join(repo, '.git'))
  })

  it('names nothing for the main checkout, a subdirectory of a worktree, a plain directory, or a missing directory', async () => {
    const { base, repo, read } = await layout()
    const linked = await worktree(repo, base, 'linked')
    await mkdir(join(linked, 'src'))
    await mkdir(join(base, 'plain'))

    expect(await read(repo)).toBeUndefined()
    expect(await read(join(linked, 'src'))).toBeUndefined()
    expect(await read(join(base, 'plain'))).toBeUndefined()
    expect(await read(join(base, 'missing'))).toBeUndefined()
  })

  it('names nothing once the repository forgot the worktree', async () => {
    const { base, repo, read } = await layout()
    const linked = await worktree(repo, base, 'pruned')
    await rm(join(repo, '.git', 'worktrees', 'pruned'), { recursive: true })

    expect(await read(linked)).toBeUndefined()
  })
})

describe('pointer files the checkout itself could have written', () => {
  it('names nothing for a pointer that is malformed, a symlink, or aimed outside the worktree layout', async () => {
    const { base, repo, read } = await layout()
    const linked = await worktree(repo, base, 'genuine')
    await mkdir(join(base, 'administration'))
    const viaLink = join(base, 'via-link')
    await mkdir(viaLink)
    await symlink(join(linked, '.git'), join(viaLink, '.git'))

    expect(await read(await checkout(base, 'malformed', 'not a pointer\n'))).toBeUndefined()
    expect(await read(await checkout(base, 'blank', '\n'))).toBeUndefined()
    expect(await read(viaLink)).toBeUndefined()
    expect(await read(await checkout(base, 'to-root', 'gitdir: /\n'))).toBeUndefined()
    expect(await read(await checkout(base, 'to-base', `gitdir: ${base}\n`))).toBeUndefined()
    expect(await read(await checkout(base, 'to-directory', `gitdir: ${join(base, 'administration')}\n`))).toBeUndefined()
    expect(await read(await checkout(base, 'to-git-directory', `gitdir: ${join(repo, '.git')}\n`))).toBeUndefined()
    expect(await read(await checkout(base, 'dangling', `gitdir: ${join(base, 'absent', 'worktrees', 'x')}\n`))).toBeUndefined()
  })

  it('names nothing for the administration directory of another checkout or of a submodule', async () => {
    const { base, repo, read } = await layout()
    await worktree(repo, base, 'victim')
    const modules = join(base, 'super', '.git', 'modules', 'module')
    await mkdir(modules, { recursive: true })

    expect(await read(await checkout(base, 'thief', `gitdir: ${join(repo, '.git', 'worktrees', 'victim')}\n`))).toBeUndefined()
    expect(await read(await checkout(base, join('super', 'module'), 'gitdir: ../.git/modules/module\n'))).toBeUndefined()
  })

  it('names nothing when commondir is absent, blank, a directory, or resolves elsewhere', async () => {
    const { base, read } = await layout()
    const forged = async (name: string, commondir: string | undefined): Promise<string> => {
      const root = join(base, name)
      const admin = await administration(join(base, `${name}-git`, 'worktrees', 'x'), commondir, `${join(root, '.git')}\n`)
      return checkout(base, name, `gitdir: ${admin}\n`)
    }
    const directory = await forged('directory', undefined)
    await mkdir(join(base, 'directory-git', 'worktrees', 'x', 'commondir'))

    expect(await read(await forged('absent', undefined))).toBeUndefined()
    expect(await read(await forged('blank', '\n'))).toBeUndefined()
    expect(await read(directory)).toBeUndefined()
    expect(await read(await forged('escaping', '/\n'))).toBeUndefined()
    expect(await read(await forged('sibling', '..\n'))).toBeUndefined()
    expect(await read(await forged('complete', '../..\n'))).toBe(join(base, 'complete-git'))
  })

  it('names nothing when the administration directory does not point back at the checkout', async () => {
    const { base, read } = await layout()
    const forged = async (name: string, gitdir: string | undefined): Promise<string> => {
      const admin = await administration(join(base, `${name}-git`, 'worktrees', 'x'), '../..\n', gitdir)
      return checkout(base, name, `gitdir: ${admin}\n`)
    }

    expect(await read(await forged('absent', undefined))).toBeUndefined()
    expect(await read(await forged('blank', '\n'))).toBeUndefined()
    expect(await read(await forged('elsewhere', `${join(base, 'other', '.git')}\n`))).toBeUndefined()
    expect(await read(await forged('to-root', `${join(base, 'to-root')}\n`))).toBeUndefined()
  })

  it('names nothing when the shared directory contains the checkout, is the checkout, or lies inside it', async () => {
    const { base, read } = await layout()
    // <base>/pool/worktrees/self is its own administration directory, so <base>/pool would contain the checkout.
    const self = join(base, 'pool', 'worktrees', 'self')
    await administration(self, '../..\n', `${join(self, '.git')}\n`)
    await writeFile(join(self, '.git'), `gitdir: ${self}\n`)
    const same = join(base, 'same')
    await administration(join(same, 'worktrees', 'x'), '../..\n', `${join(same, '.git')}\n`)
    await writeFile(join(same, '.git'), `gitdir: ${join(same, 'worktrees', 'x')}\n`)
    const inside = join(base, 'inside')
    await administration(join(inside, 'fake', 'worktrees', 'x'), '../..\n', `${join(inside, '.git')}\n`)
    await writeFile(join(inside, '.git'), `gitdir: ${join(inside, 'fake', 'worktrees', 'x')}\n`)

    expect(await read(self)).toBeUndefined()
    expect(await read(same)).toBeUndefined()
    expect(await read(inside)).toBeUndefined()
  })
})

describe('repositories beside each other', () => {
  it('names each worktree\'s own repository', async () => {
    const { base, repo, read } = await layout()
    const other = await repository(base, 'other')

    expect(await read(await worktree(repo, base, 'of-repo'))).toBe(join(repo, '.git'))
    expect(await read(await worktree(other, base, 'of-other'))).toBe(join(other, '.git'))
  })
})
