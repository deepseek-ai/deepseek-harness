import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { contents, filterCommand, git, harness, repository, testAgent } from './harness.ts'

let ctx: Context | undefined
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx?.fiber.dispose()
  ctx = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function repo(): Promise<string> {
  const root = await repository()
  roots.push(root)
  return root
}

describe('worktree checkout Git configuration', () => {
  it.each(['some.nested.driver', 'x=y', 'lfs'])('disables required clean and smudge filters named %s without changing repository configuration', async (driver) => {
    const root = await repo()
    const committed = driver === 'lfs'
      ? `version https://git-lfs.github.com/spec/v1\noid sha256:${'0'.repeat(64)}\nsize 8\n`
      : 'initial\n'
    await writeFile(join(root, 'tracked.txt'), committed)
    await writeFile(join(root, '.gitattributes'), `*.txt filter=${driver} -text\n`)
    await git(root, 'add', '.gitattributes', 'tracked.txt')
    await git(root, 'commit', '-m', 'attributes')
    const { command, marker } = await filterCommand(root)
    await git(root, 'config', `filter.${driver}.clean`, command)
    await git(root, 'config', `filter.${driver}.smudge`, command)
    await git(root, 'config', `filter.${driver}.required`, 'true')
    await git(root, 'config', `filter.${driver}.unused`, 'preserved')
    const configuration = await readFile(join(root, '.git/config'))

    const control = join(root, 'ordinary-checkout')
    await git(root, 'worktree', 'add', '-b', 'ordinary', control)
    expect(await contents(marker)).toContain('executed')
    expect(await contents(join(control, 'tracked.txt'))).toBe(`filtered\n${committed}`)
    await rm(marker)

    ctx = await harness(root)
    const created = await ctx.worktrees.create(testAgent(ctx, root), { name: 'unfiltered' })

    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await contents(join(created.path, 'tracked.txt'))).toBe(committed)
    expect(await readFile(join(root, '.git/config'))).toEqual(configuration)
  })

  it('disables a required process filter that makes ordinary checkout fail', async () => {
    const root = await repo()
    await writeFile(join(root, '.gitattributes'), '*.txt filter=process-driver -text\n')
    await git(root, 'add', '.gitattributes')
    await git(root, 'commit', '-m', 'attributes')
    const { command, marker } = await filterCommand(root, true)
    await git(root, 'config', 'filter.process-driver.process', command)
    await git(root, 'config', 'filter.process-driver.required', 'true')
    const control = join(root, 'ordinary-checkout')
    await expect(git(root, 'worktree', 'add', '-b', 'ordinary', control)).rejects.toThrow()
    expect(await contents(marker)).toBe('executed\n')
    await rm(marker)

    ctx = await harness(root)
    const created = await ctx.worktrees.create(testAgent(ctx, root), { name: 'unfiltered' })

    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await contents(join(created.path, 'tracked.txt'))).toBe('initial\n')
  })

  it('retains stored binary content without running its decryption filter', async () => {
    const root = await repo()
    const stored = Buffer.from([0, 255, 17, 128, 10])
    await writeFile(join(root, 'tracked.txt'), stored)
    await writeFile(join(root, '.gitattributes'), 'tracked.txt filter=encrypted -text\n')
    await git(root, 'add', '.gitattributes', 'tracked.txt')
    await git(root, 'commit', '-m', 'stored binary content')
    await git(root, 'config', 'filter.encrypted.smudge', "printf 'decrypted content\\n'")
    const control = join(root, 'ordinary-checkout')
    await git(root, 'worktree', 'add', '-b', 'ordinary', control)
    expect(await contents(join(control, 'tracked.txt'))).toBe('decrypted content\n')

    ctx = await harness(root)
    const created = await ctx.worktrees.create(testAgent(ctx, root), { name: 'stored' })

    expect(await readFile(join(created.path, 'tracked.txt'))).toEqual(stored)
  })

  it('reports invalid destination-only configuration and retains the unpopulated checkout', async () => {
    const root = await repo()
    const included = join(root, 'invalid-config')
    await writeFile(included, '[invalid configuration\n')
    await git(root, 'config', 'includeIf.onbranch:invalid.path', included)
    ctx = await harness(root)
    const agent = testAgent(ctx, root)

    await expect(ctx.worktrees.create(agent, { name: 'invalid' })).rejects.toThrow(/Any created checkout and branch are retained.*bad config line/s)

    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    await access(join(root, '.agents/worktrees/invalid/.git'))
    await expect(access(join(root, '.agents/worktrees/invalid/tracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'branch', '--list', 'invalid')).toContain('invalid')
  })

  it('refuses truncated destination filter configuration before materializing files', async () => {
    const root = await repo()
    await git(root, 'config', `filter.${'long-driver-'.repeat(100)}.smudge`, 'unavailable-filter')
    ctx = await harness(root, { maxOutputBytes: 256 })
    const agent = testAgent(ctx, root)

    await expect(ctx.worktrees.create(agent, { name: 'bounded' })).rejects.toThrow('output exceeds maxOutputBytes')

    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    await access(join(root, '.agents/worktrees/bounded/.git'))
    await expect(access(join(root, '.agents/worktrees/bounded/tracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discovers filters selected only by the newly created branch', async () => {
    const root = await repo()
    await writeFile(join(root, '.gitattributes'), '*.txt filter=destination-only -text\n')
    await git(root, 'add', '.gitattributes')
    await git(root, 'commit', '-m', 'attributes')
    const { command, marker } = await filterCommand(root)
    const included = join(root, 'destination-config')
    await git(root, 'config', '--file', included, 'filter.destination-only.smudge', command)
    await git(root, 'config', '--file', included, 'filter.destination-only.required', 'true')
    await git(root, 'config', 'includeIf.onbranch:destination.path', included)
    await expect(git(root, 'config', '--get-regexp', '^filter\\.')).rejects.toMatchObject({ code: 1 })

    ctx = await harness(root)
    const created = await ctx.worktrees.create(testAgent(ctx, root), { name: 'destination' })

    expect(await git(created.path, 'config', 'filter.destination-only.smudge')).toBe(command)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await contents(join(created.path, 'tracked.txt'))).toBe('initial\n')
  })

  it('ignores inherited repository, replacement-ref and command-config selectors', async () => {
    const root = await repo()
    const other = await repo()
    const baseCommit = await git(root, 'rev-parse', 'HEAD')
    await git(root, 'checkout', '-b', 'replacement')
    await writeFile(join(root, 'tracked.txt'), 'redirected\n')
    await git(root, 'commit', '-am', 'replacement')
    const replacement = await git(root, 'rev-parse', 'HEAD')
    await git(root, 'checkout', 'main')
    await git(root, 'update-ref', `refs/alternate-replacements/${baseCommit}`, replacement)
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    vi.stubEnv('GIT_DIR', join(other, '.git'))
    vi.stubEnv('GIT_WORK_TREE', other)
    vi.stubEnv('GIT_COMMON_DIR', join(other, '.git'))
    vi.stubEnv('GIT_INDEX_FILE', join(other, '.git/index'))
    vi.stubEnv('GIT_OBJECT_DIRECTORY', join(other, '.git/objects'))
    vi.stubEnv('GIT_IMPLICIT_WORK_TREE', '0')
    vi.stubEnv('GIT_REPLACE_REF_BASE', 'refs/alternate-replacements/')
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true')

    const created = await ctx.worktrees.create(agent, { name: 'selected' })

    expect(created.repositoryRoot).toBe(root)
    expect(created.baseCommit).toBe(baseCommit)
    expect(await contents(join(created.path, 'tracked.txt'))).toBe('initial\n')
    expect(await git(other, 'branch', '--list', 'selected')).toBe('')
  })

  it('uses the selected checkout attributes instead of an inherited attribute tree', async () => {
    const root = await repo()
    const baseCommit = await git(root, 'rev-parse', 'HEAD')
    await git(root, 'checkout', '-b', 'foreign-attributes')
    await writeFile(join(root, '.gitattributes'), 'tracked.txt text eol=crlf\n')
    await git(root, 'add', '.gitattributes')
    await git(root, 'commit', '-m', 'foreign attributes')
    const attributesCommit = await git(root, 'rev-parse', 'HEAD')
    await git(root, 'checkout', 'main')
    vi.stubEnv('GIT_ATTR_SOURCE', attributesCommit)
    const control = join(root, 'ordinary-checkout')
    await git(root, 'worktree', 'add', '-b', 'ordinary', control)
    expect(await contents(join(control, 'tracked.txt'))).toBe('initial\r\n')

    ctx = await harness(root)
    const created = await ctx.worktrees.create(testAgent(ctx, root), { name: 'selected' })

    expect(created.baseCommit).toBe(baseCommit)
    expect(await contents(join(created.path, 'tracked.txt'))).toBe('initial\n')
  })

  it('honors repository-local replacement refs while reporting the resolved object name', async () => {
    const root = await repo()
    const baseCommit = await git(root, 'rev-parse', 'HEAD')
    await git(root, 'checkout', '-b', 'replacement')
    await writeFile(join(root, 'tracked.txt'), 'repository replacement\n')
    await git(root, 'commit', '-am', 'replacement')
    const replacement = await git(root, 'rev-parse', 'HEAD')
    await git(root, 'checkout', 'main')
    await git(root, 'replace', baseCommit, replacement)
    const configuration = await readFile(join(root, '.git/config'))

    ctx = await harness(root)
    const created = await ctx.worktrees.create(testAgent(ctx, root), { name: 'selected' })

    expect(created.baseCommit).toBe(baseCommit)
    expect(await contents(join(created.path, 'tracked.txt'))).toBe('repository replacement\n')
    expect(await git(root, 'replace', '--list')).toBe(baseCommit)
    expect(await readFile(join(root, '.git/config'))).toEqual(configuration)
  })

  it('reports a missing Git executable before allocating a checkout', async () => {
    const root = await repo()
    ctx = await harness(root, { gitCommand: join(root, 'unavailable-git') })
    const agent = testAgent(ctx, root)

    await expect(ctx.worktrees.create(agent, { name: 'unavailable' })).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)

    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    await expect(access(join(root, '.agents/worktrees'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'branch', '--list', 'unavailable')).toBe('')
  })
})
