/** Partial clones of real local repositories: reads, README lookup, limits, eviction, and Git failures. */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DetailFailure } from '@deepseek-ai/dsh-plugin-detail'
import { RepositoryCache, type RepositoryCacheOptions } from '../src/repository-cache.ts'

/** Await a rejection that matches `fields` and whose message contains `message`. */
async function expectRejection(promise: Promise<unknown>, fields: object, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject(fields)
  await expect(promise).rejects.toThrow(message)
}


let root: string
const lifetime = new AbortController()
const signal = new AbortController().signal
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-plugin-market-repositories-'))
  // Git reads no configuration of the developer running the tests.
  mkdirSync(join(root, 'home'))
  vi.stubEnv('HOME', join(root, 'home'))
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'home'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  // Fixture repositories ignore inherited Git overrides, such as a hook's `GIT_DIR`, and every user or system configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8',
    env: { ...env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim()
}

/** The cache directory name of a repository URL. */
function cloneName(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24)
}

/** Bytes of the regular files below a directory. */
function dirSize(dir: string): number {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map(name => lstatSync(join(dir, name)))
    .reduce((sum, entry) => sum + (entry.isFile() ? entry.size : 0), 0)
}

/** A repository with `files` committed on its default branch, served as a `file:` URL. */
function repository(name: string, files: Record<string, string | Uint8Array>): { url: string; commit: string; dir: string } {
  const dir = join(root, 'sources', name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--quiet', '--initial-branch=main')
  // A partial fetch from a local repository needs the server side to accept object filters.
  git(dir, 'config', 'uploadpack.allowFilter', 'true')
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), contents)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', 'init')
  return { url: pathToFileURL(dir).href, commit: git(dir, 'rev-parse', 'HEAD'), dir }
}

function cache(options: Partial<RepositoryCacheOptions> = {}): RepositoryCache {
  return new RepositoryCache({
    dir: join(root, 'cache'), maxRepositoryBytes: 10 * 1024 * 1024, maxCacheBytes: 100 * 1024 * 1024,
    timeoutMs: 30_000, ttlMs: 60_000, transports: ['file', 'ssh'], lifetime: lifetime.signal, sizePollMs: 1, ...options,
  })
}

it('reads files at a pinned commit and the default branch, fetching contents only when read', async () => {
  const source = repository('a', { 'packages/p/README.md': '# P', 'packages/p/img/a.png': 'png', 'big.bin': 'x'.repeat(4096) })
  const repositories = cache()
  expect(new TextDecoder().decode(await repositories.read(source.url, source.commit, 'packages/p/img/a.png', 100, signal))).toBe('png')
  expect(await repositories.read(source.url, source.commit, 'packages/p/missing.png', 100, signal)).toBeUndefined()
  expect(await repositories.read(source.url, source.commit, 'packages/p', 100, signal)).toBeUndefined()
  await expect(repositories.read(source.url, source.commit, 'big.bin', 100, signal)).rejects.toMatchObject({ reason: 'too-large' })
  // A file over its read's size leaves the clone usable.
  expect(readdirSync(join(root, 'cache'))).toHaveLength(1)
  writeFileSync(join(source.dir, 'packages/p/README.md'), '# P2')
  git(source.dir, 'commit', '--quiet', '-am', 'second')
  expect(new TextDecoder().decode((await repositories.readme(source.url, undefined, 'packages/p', 100, signal))?.bytes)).toBe('# P2')
  writeFileSync(join(source.dir, 'packages/p/README.md'), '# P3')
  git(source.dir, 'commit', '--quiet', '-am', 'third')
  // The default branch commit stays cached for the TTL.
  expect(new TextDecoder().decode((await repositories.readme(source.url, undefined, 'packages/p', 100, signal))?.bytes)).toBe('# P2')
  expect(await repositories.readme(source.url, source.commit, 'packages/p/img', 100, signal)).toBeUndefined()
  expect(new TextDecoder().decode((await repositories.readme(source.url, source.commit, 'packages/p', 100, signal))?.bytes)).toBe('# P')
  await repositories.settled()
})

it('picks the README of a root directory by name order, in any letter case', async () => {
  const source = repository('b', { 'readme.markdown': 'second', 'Readme.md': 'first', 'docs/readme': 'plain' })
  const repositories = cache()
  expect(await repositories.readme(source.url, source.commit, '', 100, signal)).toMatchObject({ path: 'Readme.md' })
  expect(await repositories.readme(source.url, source.commit, 'docs', 100, signal)).toMatchObject({ path: 'docs/readme' })
})

it('asks the smart HTTP endpoint without credentials whether a repository is public, and caches the answer', async () => {
  const answers: Record<string, Response | Error> = {
    'https://git.example/public.git/info/refs?service=git-upload-pack': new Response('refs'),
    'https://git.example/private.git/info/refs?service=git-upload-pack': new Response('no', { status: 401 }),
    'https://git.example/moved.git/info/refs?service=git-upload-pack': new Response(null, { status: 302, headers: { location: '/login' } }),
    'https://git.example/broken.git/info/refs?service=git-upload-pack': new Response('no', { status: 500 }),
    'https://git.example/down.git/info/refs?service=git-upload-pack': new Error('offline'),
  }
  const fetch = vi.fn((url: string, init: RequestInit) => {
    expect(init.redirect).toBe('manual')
    const answer = answers[url]
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as Response)
  })
  vi.stubGlobal('fetch', fetch)
  const repositories = cache()
  const [first, second] = await Promise.all([repositories.isPublic('https://git.example/public.git'), repositories.isPublic('https://git.example/public.git')])
  expect([first, second]).toEqual([true, true])
  expect(await repositories.isPublic('https://git.example/public.git')).toBe(true)
  expect(await repositories.isPublic('https://git.example/private.git')).toBe(false)
  expect(await repositories.isPublic('https://git.example/moved.git')).toBe(false)
  await expectRejection(repositories.isPublic('https://git.example/broken.git'), { reason: 'network' }, 'HTTP 500')
  await expectRejection(repositories.isPublic('https://git.example/down.git'), { reason: 'network' }, 'offline')
  expect(fetch).toHaveBeenCalledTimes(5)
})

it('reports an unreachable host as a network failure, a failed local command as a plain error, and a Git that cannot run', async () => {
  vi.stubEnv('GIT_SSH_COMMAND', 'ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=5')
  await expectRejection(cache().read('ssh://127.0.0.1:1/owner/repo.git', undefined, 'README.md', 100, signal), { reason: 'network' }, 'git fetch')
  const source = repository('t', { 'README.md': 'x' })
  const repositories = cache()
  await repositories.read(source.url, source.commit, 'README.md', 100, signal)
  // A clone whose commit refs cannot be written fails a local command after a successful fetch; that says nothing about
  // the repository, and the clone is deleted.
  const [clone] = readdirSync(join(root, 'cache'))
  rmSync(join(root, 'cache', clone as string, 'refs', 'dsh'), { recursive: true })
  writeFileSync(join(root, 'cache', clone as string, 'refs', 'dsh'), 'not a directory')
  writeFileSync(join(source.dir, 'README.md'), 'y')
  git(source.dir, 'commit', '--quiet', '-am', 'next')
  const broken = repositories.read(source.url, git(source.dir, 'rev-parse', 'HEAD'), 'README.md', 100, signal)
  await expect(broken).rejects.toThrow('git update-ref')
  await expect(broken).rejects.not.toBeInstanceOf(DetailFailure)
  expect(readdirSync(join(root, 'cache'))).toEqual([])
  // Git that cannot answer `git --version` within the deadline cannot run.
  const other = repository('t2', { 'README.md': 'x' })
  await expectRejection(cache({ timeoutMs: 1 }).read(other.url, other.commit, 'README.md', 100, signal), { reason: 'git-unavailable' }, 'timed out')
  vi.stubEnv('PATH', join(root, 'no-git'))
  const missing = cache().read(other.url, other.commit, 'README.md', 100, signal)
  await expectRejection(missing, { reason: 'git-unavailable' }, 'git --version')
  expect(readdirSync(join(root, 'cache'))).toEqual([])
})

it('reports a repository Git cannot fetch as denied', async () => {
  const repositories = cache()
  const missing = pathToFileURL(join(root, 'missing')).href
  const failure = await repositories.read(missing, undefined, 'README.md', 100, signal).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(DetailFailure)
  expect(failure).toMatchObject({ reason: 'denied' })
  expect(readdirSync(join(root, 'cache'))).toEqual([])
  const source = repository('d', { 'README.md': 'x' })
  await expect(repositories.read(source.url, 'f'.repeat(40), 'README.md', 100, signal)).rejects.toMatchObject({ reason: 'denied' })
  await expect(repositories.read(source.url, source.commit, 'README.md', 100, signal)).resolves.toBeDefined()
})

it('stops a fetch once the repository grows past its limit, and deletes the repository', async () => {
  const source = repository('e', { 'README.md': 'x' })
  // The empty repository already exceeds one byte, so the first size check stops Git.
  const repositories = cache({ maxRepositoryBytes: 1 })
  await expect(repositories.read(source.url, source.commit, 'README.md', 100, signal)).rejects.toMatchObject({ reason: 'too-large' })
  expect(readdirSync(join(root, 'cache'))).toEqual([])
})

it('refuses a repository that a completed fetch left past its limit', async () => {
  // Distinct files make distinct trees, so the fetch adds one tree object per directory.
  const source = repository('e2', Object.fromEntries(Array.from({ length: 1000 }, (_value, index) => [`dir${String(index)}/f.txt`, String(index)])))
  const repositories = cache({ maxRepositoryBytes: 4096, sizePollMs: 3_600_000 })
  await expect(repositories.read(source.url, source.commit, 'dir0/f.txt', 100, signal)).rejects.toMatchObject({ reason: 'too-large' })
  expect(readdirSync(join(root, 'cache'))).toEqual([])
})

it('deletes least recently used repositories beyond the cache size and stale staging directories', async () => {
  const first = repository('f', { 'README.md': 'first' })
  const second = repository('g', { 'README.md': 'second' })
  const third = repository('h', { 'README.md': 'third' })
  // The total holds one of these clones, not two.
  const probe = cache({ dir: join(root, 'probe') })
  await probe.read(first.url, first.commit, 'README.md', 100, signal)
  const one = dirSize(join(root, 'probe'))
  const repositories = cache({ maxCacheBytes: Math.floor(one * 2.5) })
  mkdirSync(join(root, 'cache', '.init-stale'), { recursive: true })
  utimesSync(join(root, 'cache', '.init-stale'), new Date(0), new Date(0))
  mkdirSync(join(root, 'cache', '.init-running'))
  writeFileSync(join(root, 'cache', 'stray.txt'), 'not a repository')
  // An entry that disappears while it is measured no longer counts.
  symlinkSync(join(root, 'gone'), join(root, 'cache', 'vanished'))
  await repositories.read(first.url, first.commit, 'README.md', 100, signal)
  expect(readdirSync(join(root, 'cache')).filter(name => name.startsWith('.init-'))).toEqual(['.init-running'])
  rmSync(join(root, 'cache', '.init-running'), { recursive: true })
  rmSync(join(root, 'cache', 'vanished'))
  rmSync(join(root, 'cache', 'stray.txt'))
  await repositories.read(second.url, second.commit, 'README.md', 100, signal)
  await repositories.settled()
  expect(readdirSync(join(root, 'cache'))).toHaveLength(2)
  await repositories.read(third.url, third.commit, 'README.md', 100, signal)
  await repositories.settled()
  // The least recently used clone goes first; the two newer ones fit.
  expect(readdirSync(join(root, 'cache')).sort()).toEqual([second.url, third.url].map(cloneName).sort())
  // A cached commit is read again without a fetch.
  await repositories.read(third.url, third.commit, 'README.md', 100, signal)
  expect(existsSync(join(root, 'cache'))).toBe(true)
})

it('completes concurrent fetches of different repositories that each evict the other', async () => {
  const a = repository('ca', { 'README.md': 'a' })
  const b = repository('cb', { 'README.md': 'b' })
  const repositories = cache({ maxCacheBytes: 1 })
  const reads = await Promise.all([a, b].map(source => repositories.readme(source.url, undefined, '', 100, signal)))
  expect(reads.map(read => text(read?.bytes))).toEqual(['a', 'b'])
  await repositories.settled()
  expect(readdirSync(join(root, 'cache')).length).toBeLessThanOrEqual(1)
})

it('returns a blob whose last byte is a newline intact', async () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
  const source = repository('nl', { 'a.png': bytes })
  expect(await cache().read(source.url, source.commit, 'a.png', 100, signal)).toEqual(Buffer.from(bytes))
})

it('enforces the cache total after a blob read, deleting the repository in use after its read when it alone is too large', async () => {
  const source = repository('blob', { 'README.md': 'r', 'big.bin': randomBytes(200_000) })
  const repositories = cache()
  await repositories.read(source.url, source.commit, 'README.md', 100, signal)
  await repositories.settled()
  const kept = readdirSync(join(root, 'cache')).filter(name => !name.endsWith('.lock'))
  expect(kept).toHaveLength(1)
  // The clone without contents fits; reading the large blob downloads it and grows the repository past the total.
  const small = cache({ maxCacheBytes: 150_000 })
  expect((await small.read(source.url, source.commit, 'big.bin', 300_000, signal))?.byteLength).toBe(200_000)
  // The deletion waits for the read that holds the repository, then runs.
  await new Promise((resolve) => { setTimeout(resolve, 50) })
  await small.settled()
  expect(readdirSync(join(root, 'cache')).filter(name => !name.endsWith('.lock'))).toEqual([])
})

it('serializes one repository across caches that share the directory, as two processes on one profile do', async () => {
  const source = repository('shared', { 'README.md': 'shared' })
  const [first, second] = [cache(), cache()]
  const reads = await Promise.all([first, second].map(each => each.read(source.url, source.commit, 'README.md', 100, signal)))
  expect(reads.map(read => text(read))).toEqual(['shared', 'shared'])
  await Promise.all([first.settled(), second.settled()])
  expect(readdirSync(join(root, 'cache')).filter(name => !name.endsWith('.lock'))).toHaveLength(1)
})

it('stops Git when the caller cancels or the service is disposed', async () => {
  const source = repository('i', { 'README.md': 'x' })
  const cancelled = new AbortController()
  cancelled.abort(new Error('cancelled'))
  await expect(cache().read(source.url, source.commit, 'README.md', 100, cancelled.signal)).rejects.toThrow('cancelled')
  const disposed = new AbortController()
  disposed.abort(new Error('disposed'))
  await expect(cache({ lifetime: disposed.signal }).read(source.url, source.commit, 'README.md', 100, signal)).rejects.toThrow('disposed')
  // Neither a repository nor its staging directory remains.
  expect(readdirSync(join(root, 'cache'))).toEqual([])
})

it('reports file contents Git can no longer fetch and deletes the clone, ignoring an inherited GIT_DIR', async () => {
  vi.stubEnv('GIT_DIR', join(root, 'elsewhere'))
  const source = repository('j', { 'README.md': 'x', 'b.png': 'b' })
  const repositories = cache()
  await repositories.read(source.url, source.commit, 'README.md', 100, signal)
  rmSync(source.dir, { recursive: true, force: true })
  await expectRejection(repositories.read(source.url, source.commit, 'b.png', 100, signal), { reason: 'denied' }, 'git cat-file b.png')
  expect(readdirSync(join(root, 'cache'))).toEqual([])
})

it('fetches a cached default-branch commit again after eviction, and reports a clone that can no longer fetch it', async () => {
  const first = repository('k', { 'README.md': 'first' })
  const second = repository('l', { 'README.md': 'second' })
  const repositories = cache({ maxCacheBytes: 1 })
  await repositories.read(first.url, undefined, 'README.md', 100, signal)
  await repositories.read(second.url, undefined, 'README.md', 100, signal)
  expect(text(await repositories.read(first.url, undefined, 'README.md', 100, signal))).toBe('first')
  const [clone] = readdirSync(join(root, 'cache'))
  rmSync(join(root, 'cache', clone as string, 'objects', 'pack'), { recursive: true, force: true })
  rmSync(first.dir, { recursive: true, force: true })
  await expectRejection(repositories.read(first.url, undefined, 'README.md', 100, signal), { reason: 'denied' }, 'git fetch')
})
