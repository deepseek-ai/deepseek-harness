/** Process failures, budgets and lossless literal path filters over real ripgrep. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mountSearchSubprocess } from './search-harness.ts'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { WorkspaceFiles, type Config, type WorkspaceFileSearchRequest } from '../src/index.ts'
import { failureOf, openWorkspace, signal, type Caps, type Harness } from './harness.ts'

let harness: Harness
beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-search-rg-')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await harness.ctx.fiber.dispose()
  await harness.dispose()
})
async function files(...paths: string[]): Promise<void> {
  for (const path of paths) {
    const absolute = join(harness.workspace, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, '')
  }
}
const request = (query: string, options: Partial<WorkspaceFileSearchRequest> = {}): WorkspaceFileSearchRequest => ({
  query, includeHidden: true, respectGitignore: false, excludedPaths: [], ...options,
})
const search = (query: string, caps?: Caps, options?: Partial<WorkspaceFileSearchRequest>, abort = signal()) =>
  harness.endpoint(caps).search(harness.scope, request(query, options), abort)

describe('ripgrep-backed workspace discovery', () => {
  beforeEach(async () => { await mountSearchSubprocess(harness) })

  it('sorts shallow matches before path-sorted deep files and truncates only matching results', async () => {
    await files('a-match/deep-match/file-match', 'z-match', 'b-match')
    expect(await search('match', { search: { maxResults: 3 } })).toEqual({ matches: [
      { path: 'a-match', type: 'directory' }, { path: 'b-match', type: 'file' }, { path: 'z-match', type: 'file' },
    ], truncated: true, incomplete: false })
  })

  it('sorts full paths independently of rg directory visitation order', async () => {
    await files('a/file', 'a-file/file')
    expect((await search('file')).matches.map(match => match.path)).toEqual(['a-file', 'a-file/file', 'a/file'])
  })

  it('does not truncate at exactly the result cap', async () => {
    await files('a1', 'a2')
    expect(await search('a', { search: { maxResults: 2 } })).toMatchObject({ truncated: false, incomplete: false })
  })

  it.each([2, 3])('reports incompleteness only when %s files exceed the two-file cap', async (total) => {
    await files(...Array.from({ length: total }, (_, i) => i < 2 ? `a${i}` : `z-a/a${i}`))
    const original = harness.ctx.subprocess.spawn.bind(harness.ctx.subprocess)
    const terminate = vi.fn()
    const waitForExit = vi.fn()
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = original(spec)
      return { ...handle,
        terminate: () => { terminate(); handle.terminate() },
        waitForExit: async () => { waitForExit(); return handle.waitForExit() },
      }
    })
    expect(await search('a', { search: { maxEntries: 2 } })).toEqual({ matches: [
      { path: 'a0', type: 'file' }, { path: 'a1', type: 'file' },
    ], truncated: false, incomplete: total > 2 })
    expect(terminate).toHaveBeenCalledTimes(total > 2 ? 1 : 0)
    expect(waitForExit).toHaveBeenCalledOnce()
  })

  it('uses native hidden/ignore switches, path sorting, lossless separators and no ambient config', async () => {
    const spawn = vi.spyOn(harness.ctx.subprocess, 'spawn')
    await search('absent')
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ cwd: await realpath(harness.workspace), graceMs: 3000 })
    expect(spawn.mock.calls[0]?.[0].argv).toEqual(expect.arrayContaining([
      '--no-config', '--files', '--sort=path', '--null', '--path-separator=/', '--hidden', '--no-ignore',
    ]))
    expect(spawn.mock.calls[0]?.[0].argv[1]).toBe('--no-config')
  })

  it.each(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])('excludes %s internals even with hidden and ignored files enabled', async (vcs) => {
    await files(`${vcs}/a.txt`, `sub/${vcs}/a.txt`, 'a.txt')
    expect((await search('a.txt')).matches).toEqual([{ path: 'a.txt', type: 'file' }])
    expect((await search(vcs)).matches).toEqual([])
  })

  it.each(['[x]', '{x,y}', '!x'])('quotes the portable glob metacharacters in %s literally', async (name) => {
    await files(`${name}/target`, `sub/${name}/target`, 'x/target', 'y/target')
    expect((await search('target', undefined, { excludedPaths: [name] })).matches.map(m => m.path)).toEqual(['x/target', 'y/target'])
    expect((await search('target', undefined, { excludedPaths: [`sub/${name}`] })).matches.map(m => m.path)).toEqual([`${name}/target`, 'x/target', 'y/target'].sort())
  })

  it.skipIf(process.platform === 'win32')('quotes star, question mark and backslash names and preserves embedded newlines', async () => {
    // Windows does not permit these literal filename characters.
    await files('a*/target', 'a?/target', 'a\\b/target', 'ax/target', 'new\nline/target')
    expect((await search('target', undefined, { excludedPaths: ['a*', 'a?', 'a\\b'] })).matches.map(m => m.path)).toEqual(['ax/target', 'new\nline/target'])
  })

  it('does not return empty directories or directory links inside/outside the root', async () => {
    await files('real/target')
    await mkdir(join(harness.workspace, 'empty'))
    await writeFile(join(harness.outside, 'outside-target'), '')
    await symlink(join(harness.workspace, 'real'), join(harness.workspace, 'linked'), 'junction')
    await symlink(harness.outside, join(harness.workspace, 'outside-link'), 'junction')
    expect((await search('link')).matches).toEqual([])
    expect((await search('empty')).matches).toEqual([])
    expect((await search('target')).matches).toEqual([{ path: 'real/target', type: 'file' }])
  })

  it.skipIf(process.platform === 'win32')('omits regular and broken file symlinks', async () => {
    // File symlinks on Windows require privileges absent from some test hosts.
    await files('target')
    await symlink(join(harness.workspace, 'target'), join(harness.workspace, 'file-link'))
    await symlink(join(harness.workspace, 'missing'), join(harness.workspace, 'broken-link'))
    expect((await search('link')).matches).toEqual([])
  })

  it('keeps git ignore repository detection and does not interpret core.ignorecase', async () => {
    await files('SECRET.txt')
    await writeFile(join(harness.workspace, '.gitignore'), 'SECRET.txt\n')
    expect((await search('secret', undefined, { respectGitignore: true })).matches).toHaveLength(1)
    await mkdir(join(harness.workspace, '.git'))
    expect((await search('secret', undefined, { respectGitignore: true })).matches).toEqual([])
    await writeFile(join(harness.workspace, '.gitignore'), 'secret.txt\n')
    await writeFile(join(harness.workspace, '.git', 'config'), '[core]\nignorecase = true\n')
    expect((await search('secret', undefined, { respectGitignore: true })).matches).toHaveLength(1)
  })

  it('honors the private home global Git exclude file', async () => {
    const home = join(harness.outside, 'home')
    await mkdir(join(harness.workspace, '.git'))
    await writeFile(join(home, '.gitconfig'), '[core]\nexcludesFile = ~/.global-ignore\n')
    await writeFile(join(home, '.global-ignore'), 'global.txt\n')
    await files('global.txt', 'keep.txt')
    expect((await search('.txt', undefined, { respectGitignore: true })).matches).toEqual([{ path: 'keep.txt', type: 'file' }])
    expect((await search('global.txt')).matches).toEqual([{ path: 'global.txt', type: 'file' }])
  })

  it('honors parent .gitignore and .ignore without disabling native defaults', async () => {
    await mkdir(join(dirname(harness.workspace), '.git'))
    await writeFile(join(dirname(harness.workspace), '.gitignore'), 'parent.txt\n')
    await writeFile(join(harness.workspace, '.ignore'), 'dot.txt\n')
    await files('parent.txt', 'dot.txt', 'keep.txt')
    expect((await search('.txt', undefined, { respectGitignore: true })).matches).toEqual([{ path: 'keep.txt', type: 'file' }])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('returns actual rg exit-2 partial results for an unreadable directory', async () => {
    // POSIX permissions cannot deny reads to root and have no Windows equivalent.
    await files('a.txt', 'blocked/a.txt')
    const blocked = join(harness.workspace, 'blocked')
    await chmod(blocked, 0)
    try {
      expect(await search('a.txt')).toEqual({ matches: [{ path: 'a.txt', type: 'file' }], truncated: false, incomplete: true })
    } finally {
      await chmod(blocked, 0o700)
    }
  })

  it('reports synchronous and asynchronous launch failures with a stable Remote code', async () => {
    const spawn = vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation(() => { throw new Error('remote executable missing') })
    expect((await failureOf(search('a'))).code).toBe('workspace-file/search-failed')
    spawn.mockRestore()
    const original = harness.ctx.subprocess.spawn.bind(harness.ctx.subprocess)
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation(spec => original({ ...spec, argv: [join(harness.workspace, 'missing-rg')] }))
    expect((await failureOf(search('a'))).code).toBe('workspace-file/search-failed')
  })

  it.each([
    { exitCode: 2, signal: null }, { exitCode: 3, signal: null }, { exitCode: null, signal: 'SIGTERM' }, { exitCode: null, signal: null },
  ] satisfies SubprocessOutcome[])('classifies exit facts %j independently from retained paths', async (outcome) => {
    await files('a.txt')
    const original = harness.ctx.subprocess.spawn.bind(harness.ctx.subprocess)
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = original(spec)
      return { ...handle, done: handle.done.then(() => outcome) }
    })
    if (outcome.exitCode === 2) expect(await search('a')).toEqual({ matches: [{ path: 'a.txt', type: 'file' }], truncated: false, incomplete: true })
    else expect((await failureOf(search('a'))).code).toBe('workspace-file/search-failed')
  })

  it('includes the configured bounded stderr excerpt in execution failures', async () => {
    const original = harness.ctx.subprocess.spawn.bind(harness.ctx.subprocess)
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = original({ ...spec, argv: [...spec.argv, '--unknown-search-flag'] })
      return { ...handle, done: handle.done.then(() => ({ exitCode: 3, signal: null })) }
    })
    const pending = search('a', { search: { stderrMaxBytes: 65536 } })
    await expect(pending).rejects.toMatchObject({ code: 'workspace-file/search-failed' })
    await expect(pending).rejects.toThrow('unknown-search-flag')
  })

  it('preserves cancellation before start and after real stdout arrives', async () => {
    const aborted = new AbortController()
    const reason = new Error('cancel search')
    aborted.abort(reason)
    await expect(search('a', undefined, undefined, aborted.signal)).rejects.toBe(reason)
    await files('a.txt')
    const active = new AbortController()
    const original = harness.ctx.subprocess.spawn.bind(harness.ctx.subprocess)
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = original(spec)
      handle.stdout!.once('data', () => { active.abort(reason) })
      return handle
    })
    await expect(search('a', undefined, undefined, active.signal)).rejects.toBe(reason)
  })

  it('enforces the configured deadline and waits for process cleanup', async () => {
    const exited = vi.fn(async () => true)
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const stdout = new PassThrough()
      let finish!: (outcome: SubprocessOutcome) => void
      const done = new Promise<SubprocessOutcome>((resolve) => { finish = resolve })
      const terminate = () => { stdout.end(); finish({ exitCode: null, signal: 'SIGTERM' }) }
      spec.signal!.addEventListener('abort', terminate, { once: true })
      return { stdout, stdin: undefined, stderr: undefined, control: undefined,
        collected: {}, done, terminate, waitForExit: exited } satisfies SubprocessHandle
    })
    expect((await failureOf(search('a', { search: { timeoutMs: 1 } }))).code).toBe('workspace-file/search-failed')
    expect(exited).toHaveBeenCalledOnce()
  })
})

it('fails only search when subprocess is absent; reads and listings remain usable', async () => {
  await files('a.txt')
  expect((await failureOf(search('a'))).code).toBe('workspace-file/search-failed')
  expect((await harness.endpoint().list(harness.scope, '.', signal())).entries).toHaveLength(1)
  expect((await harness.endpoint().read(harness.scope, 'a.txt', {}, signal())).text).toBe('')
})

/** Parse loader input, which may omit any defaulted field, including the whole `search` group. */
const parseConfig = (input: object): Config => new WorkspaceFiles.Config(input as Config)

it('validates subprocess budgets and supplies defaults', () => {
  const defaults = new WorkspaceFiles.Config()
  expect(defaults.search).toMatchObject({ graceMs: 3000, timeoutMs: 30000, stderrMaxBytes: 65536 })
  for (const name of ['graceMs', 'timeoutMs', 'stderrMaxBytes']) {
    expect(() => parseConfig({ search: { ...defaults.search, [name]: 0 } })).toThrow()
    expect(() => parseConfig({ search: { ...defaults.search, [name]: 1.5 } })).toThrow()
  }
  expect(() => parseConfig({ search: { ...defaults.search, timeoutMs: 2147483648 } })).toThrow()
})

it('fills every search default when the search group is omitted', () => {
  expect(parseConfig({ maxEntries: 7 })).toEqual({
    maxBytes: 2 * 1024 * 1024,
    maxFileBytes: 32 * 1024 * 1024,
    maxLines: 5000,
    maxEntries: 7,
    search: { maxResults: 512, maxEntries: 100000, graceMs: 3000, timeoutMs: 30000, stderrMaxBytes: 65536 },
  })
})

it('fills the remaining search defaults when the search group is partial', () => {
  expect(parseConfig({ search: { maxResults: 3, timeoutMs: 10 } }).search)
    .toEqual({ maxResults: 3, maxEntries: 100000, graceMs: 3000, timeoutMs: 10, stderrMaxBytes: 65536 })
})
