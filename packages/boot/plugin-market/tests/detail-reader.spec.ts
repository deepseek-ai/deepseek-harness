/** Market entry detail documents: package document, repository README, caching, and images beside a read document. */
import { afterEach, expect, it, vi } from 'vitest'
import { DetailFailure, readmeName, type DetailFiles } from '@deepseek-ai/dsh-plugin-detail'
import { DetailReader, manifestRepository, repositoryOf, type DetailLocation } from '../src/detail.ts'
import type { RepositoryFileOptions } from '../src/detail-files.ts'

/** Await a rejection that matches `fields` and whose message contains `message`. */
async function expectRejection(promise: Promise<unknown>, fields: object, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject(fields)
  await expect(promise).rejects.toThrow(message)
}

/** In-memory files under one key. */
function memory(key: string, contents: Record<string, string>): DetailFiles & { reads: string[] } {
  const reads: string[] = []
  const read = (path: string, maxBytes: number) => {
    reads.push(path)
    const value = contents[path]
    if (value === undefined) return Promise.resolve(undefined)
    if (value.length > maxBytes) return Promise.reject(new DetailFailure('too-large', path))
    return Promise.resolve(new TextEncoder().encode(value))
  }
  return {
    key, reads, read,
    async readme(dir, maxBytes) {
      const prefix = dir === '' ? '' : `${dir}/`
      const name = readmeName(Object.keys(contents).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length)))
      if (name === undefined) return undefined
      const path = `${prefix}${name}`
      return { path, bytes: (await read(path, maxBytes)) as Uint8Array }
    },
  }
}

const lifetime = new AbortController().signal

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function reader(repositoryContents: Record<string, string> = {}, limits: { ttlMs?: number } = {}) {
  const raw = vi.fn((url: string) => Promise.resolve(new Response(repositoryContents[url] ?? 'missing', { status: url in repositoryContents ? 200 : 404 })))
  vi.stubGlobal('fetch', raw)
  const repositories: RepositoryFileOptions = {
    timeoutMs: 1000, lifetime, gitlabHosts: [],
    cache: { isPublic: () => Promise.resolve(true), read: () => Promise.resolve(undefined), readme: () => Promise.resolve(undefined) },
  }
  return new DetailReader({ maxDocumentBytes: 100, maxImageBytes: 10, ttlMs: limits.ttlMs ?? 60_000 }, repositories)
}

const EN_ZH = ['zh', 'en']

it('parses repositories from manifests, shorthands, and web pages', () => {
  expect(manifestRepository('github:o/r')).toEqual({ host: 'github.com', project: 'o/r', url: 'https://github.com/o/r.git', directory: '' })
  expect(manifestRepository({ type: 'git', url: 'git+https://gitlab.com/g/s/p.git#main', directory: './packages/a/' }))
    .toEqual({ host: 'gitlab.com', project: 'g/s/p', url: 'https://gitlab.com/g/s/p.git', directory: 'packages/a' })
  expect(manifestRepository({ url: 'git+https://git.example:8443/team/repo.git', directory: '../x' }))
    .toEqual({ host: 'git.example', project: 'team/repo', url: 'https://git.example:8443/team/repo.git', directory: '' })
  expect(manifestRepository({ url: 'github:o/r', directory: '/abs' })).toMatchObject({ directory: '' })
  expect(manifestRepository({ url: 'https://git.example/team/repo', directory: '.' })).toMatchObject({ directory: '' })
  expect(manifestRepository({ url: 'https://git.example/team/repo', directory: 7 })).toMatchObject({ directory: '' })
  for (const value of [undefined, null, 7, { url: 7 }, 'not a repository', 'ftp://git.example/a/b', 'https://git.example/one', 'gist:abc']) {
    expect(manifestRepository(value)).toBeUndefined()
  }
  expect(repositoryOf('https://github.com/o/r/tree/main/pkg')).toEqual({ host: 'github.com', project: 'o/r', url: 'https://github.com/o/r.git' })
  expect(repositoryOf('https://git.corp.example/g/p/-/tree/main')).toEqual({ host: 'git.corp.example', project: 'g/p', url: 'https://git.corp.example/g/p.git' })
  expect(repositoryOf('https://user:pw@git.example/a/b')).toBeUndefined()
  expect(repositoryOf('http://intranet/a/b/')).toEqual({ host: 'intranet', project: 'a/b', url: 'http://intranet/a/b.git' })
})

it('reads the package document first, and reports an invalid one', async () => {
  const files = memory('npm:a@1', {
    'locale/en.json': JSON.stringify({ meta: { detail: 'guide/DETAIL.md' } }),
    'guide/DETAIL.md': '# Detail',
    'README.md': '# Readme',
  })
  const details = reader()
  expect(await details.read({ files, dir: '', repository: 'manifest' }, EN_ZH)).toMatchObject({ status: 'found', origin: 'locale', markdown: '# Detail' })
  expect(await details.read({ files: memory('npm:r@1', { 'README.md': '# Readme' }), dir: '', repository: undefined }, ['en']))
    .toMatchObject({ origin: 'readme', markdown: '# Readme' })
  const missing = memory('npm:b@1', { 'locale/en.json': JSON.stringify({ meta: { detail: 'GONE.md' } }) })
  await expectRejection(details.read({ files: missing, dir: '', repository: undefined }, ['en']), { reason: 'invalid' }, 'GONE.md')
})

it('reads the repository README last, from package.json or the given repository, at the default branch', async () => {
  const details = reader({
    'https://raw.githubusercontent.com/o/r/HEAD/packages/a/README.md': '# Repo A',
    'https://raw.githubusercontent.com/o/r/HEAD/README.md': '# Repo',
  })
  const files = memory('npm:a@1', { 'package.json': JSON.stringify({ repository: { url: 'github:o/r', directory: 'packages/a' } }) })
  expect(await details.read({ files, dir: '', repository: 'manifest' }, ['en'])).toMatchObject({ origin: 'repository', markdown: '# Repo A' })
  expect(await details.read({ files: memory('npm:b@1', {}), dir: '', repository: 'manifest' }, ['en'])).toEqual({ status: 'none' })
  expect(await details.read({ files: memory('npm:c@1', { 'package.json': '{' }), dir: '', repository: 'manifest' }, ['en'])).toEqual({ status: 'none' })
  const repository = { host: 'github.com', project: 'o/r', url: 'https://github.com/o/r.git', directory: '' }
  expect(await details.read({ dir: '', repository }, ['en'])).toMatchObject({ origin: 'repository', markdown: '# Repo' })
  expect(await details.read({ dir: '', repository: { ...repository, directory: 'missing' } }, ['en'])).toEqual({ status: 'none' })
  expect(await details.read({ dir: '', repository: undefined }, ['en'])).toEqual({ status: 'none' })
})

it('reports a failure of the declared repository', async () => {
  const details = reader()
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  const github = { host: 'github.com', project: 'o/r', url: 'https://github.com/o/r.git', directory: '' }
  await expectRejection(details.read({ dir: '', repository: github }, ['en']), { reason: 'network' }, 'offline')
})

it('shares concurrent reads, reuses results and lasting failures until they expire, and asks again after a network failure', async () => {
  vi.useFakeTimers()
  const files = memory('npm:a@1', { 'README.md': '# A' })
  const details = reader({}, { ttlMs: 1000 })
  const location: DetailLocation = { files, dir: '', repository: undefined }
  const [first, second] = await Promise.all([details.read(location, ['en']), details.read(location, ['en'])])
  expect(second).toBe(first)
  expect(await details.read(location, ['en'])).toBe(first)
  expect(files.reads.filter(path => path === 'README.md')).toHaveLength(1)
  vi.advanceTimersByTime(1001)
  await details.read(location, ['en'])
  expect(files.reads.filter(path => path === 'README.md')).toHaveLength(2)

  const big = memory('npm:big@1', { 'README.md': 'x'.repeat(200) })
  await expect(details.read({ files: big, dir: '', repository: undefined }, ['en'])).rejects.toMatchObject({ reason: 'too-large' })
  await expect(details.read({ files: big, dir: '', repository: undefined }, ['en'])).rejects.toMatchObject({ reason: 'too-large' })
  expect(big.reads.filter(path => path === 'README.md')).toHaveLength(1)

  let calls = 0
  const flaky: DetailFiles = {
    key: 'flaky', read: () => Promise.resolve(undefined),
    readme: () => (++calls === 1 ? Promise.reject(new DetailFailure('network', 'offline')) : Promise.resolve(undefined)),
  }
  await expect(details.read({ files: flaky, dir: '', repository: undefined }, ['en'])).rejects.toMatchObject({ reason: 'network' })
  expect(await details.read({ files: flaky, dir: '', repository: undefined }, ['en'])).toEqual({ status: 'none' })
  const broken: DetailFiles = { key: 'broken', read: () => Promise.reject(new TypeError('bug')), readme: () => Promise.resolve(undefined) }
  await expect(details.read({ files: broken, dir: '', repository: undefined }, ['en'])).rejects.toThrow('bug')
})

it('forgets a document id unused for the result lifetime, and keeps one that reads or images keep using', async () => {
  vi.useFakeTimers()
  const details = reader({}, { ttlMs: 1000 })
  const read = (key: string) => details.read({ files: memory(key, { 'README.md': '# A', 'a.png': 'png' }), dir: '', repository: undefined }, ['en'])
  const kept = await read('npm:kept@1')
  const idle = await read('npm:idle@1')
  if (kept.status !== 'found' || idle.status !== 'found') throw new Error('expected documents')
  vi.advanceTimersByTime(600)
  expect(await details.image(kept.document, 'a.png')).toMatchObject({ mediaType: 'image/png' })
  vi.advanceTimersByTime(600)
  // The cached read of `kept` expired, but its image request keeps the id; `idle` went unused for longer than the lifetime.
  expect(await details.image(kept.document, 'a.png')).toMatchObject({ mediaType: 'image/png' })
  expect(await details.image(idle.document, 'a.png')).toBeUndefined()
  expect(await read('npm:idle@1')).toEqual(idle)
  expect(await details.image(idle.document, 'a.png')).toMatchObject({ mediaType: 'image/png' })
  vi.advanceTimersByTime(500)
  // A cached read marks its document used.
  expect(await read('npm:idle@1')).toEqual(idle)
  vi.advanceTimersByTime(700)
  expect(await details.image(idle.document, 'a.png')).toMatchObject({ mediaType: 'image/png' })  // A cached read without a document marks nothing.
  const empty = { files: memory('npm:empty@1', {}), dir: '', repository: undefined } as const
  expect(await details.read(empty, ['en'])).toEqual({ status: 'none' })
  expect(await details.read(empty, ['en'])).toEqual({ status: 'none' })
})

it('reads images beside a document and refuses other paths', async () => {
  const files = memory('npm:a@1', {
    'locale/en.json': JSON.stringify({ meta: { detail: 'guide/DETAIL.md' } }),
    'guide/DETAIL.md': '# Detail', 'guide/img/a.png': 'png', 'logo.SVG': '<svg/>', 'guide/notes.txt': 'text', 'guide/big.gif': 'x'.repeat(20),
    'guide/a b.webp': 'webp',
  })
  const details = reader()
  const detail = await details.read({ files, dir: '', repository: undefined }, ['en'])
  if (detail.status !== 'found') throw new Error('expected a document')
  expect(await details.image(detail.document, 'img/a.png?raw=1#x')).toEqual({ bytes: new TextEncoder().encode('png'), mediaType: 'image/png' })
  expect(await details.image(detail.document, '/logo.SVG')).toMatchObject({ mediaType: 'image/svg+xml' })
  expect(await details.image(detail.document, './a%20b.webp')).toMatchObject({ mediaType: 'image/webp' })
  for (const path of ['../../etc/passwd.png', 'notes.txt', 'img/missing.png']) {
    expect(await details.image(detail.document, path)).toBeUndefined()
  }
  await expect(details.image(detail.document, 'big.gif')).rejects.toMatchObject({ reason: 'too-large' })
  expect(await details.image('unknown', 'img/a.png')).toBeUndefined()
  const root = await details.read({ files: memory('npm:b@1', { 'README.md': '# B', 'b.png': 'b' }), dir: '', repository: undefined }, ['en'])
  if (root.status !== 'found') throw new Error('expected a document')
  expect(await details.image(root.document, 'b.png')).toMatchObject({ mediaType: 'image/png' })
})
