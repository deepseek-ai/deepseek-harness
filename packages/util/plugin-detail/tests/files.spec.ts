/** Detail file sources: local package directories, bounded HTTP reads, and npm file CDNs. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DetailFailure, fetchBody, localFiles, npmFileSourceOrder, npmFiles, readmeByName, readmeName } from '../src/files.ts'

/** Await a rejection that matches `fields` and whose message contains `message`. */
async function expectRejection(promise: Promise<unknown>, fields: object, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject(fields)
  await expect(promise).rejects.toThrow(message)
}


let root: string
const signal = new AbortController().signal
const lifetime = new AbortController().signal
const options = { timeoutMs: 5000, lifetime }

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-plugin-market-detail-files-')) })
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function file(path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}

const text = (bytes: Uint8Array | undefined): string | undefined => bytes === undefined ? undefined : new TextDecoder().decode(bytes)

/** Answer requests by URL with a fresh response each time; any other URL fails the test. */
function serve(routes: Record<string, Error | (() => Response)>) {
  const fetch = vi.fn((url: string) => {
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected fetch ${url}`)
    if (route instanceof Error) return Promise.reject(route)
    return Promise.resolve(route())
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

it('reads package files and README names, and refuses paths whose real location leaves the package', async () => {
  file('pkg/README.md', '# Pkg')
  file('pkg/docs/readme', 'docs')
  file('pkg/big.md', 'x'.repeat(20))
  file('outside.md', 'secret')
  symlinkSync(join(root, 'outside.md'), join(root, 'pkg', 'link.md'))
  file('escaping/x', '')
  symlinkSync(join(root, 'outside.md'), join(root, 'escaping', 'README.md'))
  const files = localFiles(join(root, 'pkg'), '1.0.0')
  expect(files.key).toBe(`local:${join(root, 'pkg')}@1.0.0`)
  expect(text(await files.read('README.md', 100, signal))).toBe('# Pkg')
  expect(await files.read('missing.md', 100, signal)).toBeUndefined()
  expect(await files.read('docs', 100, signal)).toBeUndefined()
  expect(await files.read('link.md', 100, signal)).toBeUndefined()
  await expect(files.read('big.md', 10, signal)).rejects.toMatchObject({ reason: 'too-large' })
  expect(await files.readme('', 100, signal)).toMatchObject({ path: 'README.md' })
  expect(await files.readme('docs', 100, signal)).toMatchObject({ path: 'docs/readme' })
  expect(await files.readme('missing', 100, signal)).toBeUndefined()
  expect(await localFiles(join(root, 'pkg', 'docs'), '1.0.0').readme('', 100, signal)).toMatchObject({ path: 'readme' })
  expect(await localFiles(join(root, 'empty'), '1.0.0').readme('', 100, signal)).toBeUndefined()
  file('noreadme/index.js', '')
  expect(await localFiles(join(root, 'noreadme'), '1.0.0').readme('', 100, signal)).toBeUndefined()
  expect(await localFiles(join(root, 'escaping'), '1.0.0').readme('', 100, signal)).toBeUndefined()
})

it('orders README names', () => {
  expect(readmeName(['readme.markdown', 'README', 'Readme.md', 'readme.txt'])).toBe('Readme.md')
  expect(readmeName(['readme.MD', 'README.markdown'])).toBe('README.markdown')
  expect(readmeName(['readme.MD', 'Readme.MD'])).toBe('Readme.MD')
  expect(readmeName(['Readme.MD', 'readme.MD'])).toBe('Readme.MD')
  expect(readmeName(['index.md'])).toBeUndefined()
})

it('reads bodies under a limit and reports failures', async () => {
  serve({
    'https://a.example/ok': () => new Response('ok'),
    'https://a.example/empty': () => new Response(null),
    'https://a.example/missing': () => new Response('no', { status: 404 }),
    'https://a.example/declared': () => new Response('x', { headers: { 'content-length': '99' } }),
    'https://a.example/long': () => new Response('x'.repeat(20)),
    'https://a.example/down': new Error('refused'),
    'https://a.example/broken': () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('reset')) } })),
    'https://a.example/odd': () => new Response(new ReadableStream({ pull(controller) { controller.error('reset') } })),
  })
  expect(await fetchBody('https://a.example/ok', 10, signal, options)).toEqual({ ok: true, bytes: Buffer.from('ok') })
  expect(await fetchBody('https://a.example/empty', 10, signal, options)).toEqual({ ok: true, bytes: Buffer.alloc(0) })
  expect(await fetchBody('https://a.example/missing', 10, signal, options)).toEqual({ ok: false, status: 404 })
  await expect(fetchBody('https://a.example/declared', 10, signal, options)).rejects.toMatchObject({ reason: 'too-large' })
  await expect(fetchBody('https://a.example/long', 10, signal, options)).rejects.toMatchObject({ reason: 'too-large' })
  await expectRejection(fetchBody('https://a.example/down', 10, signal, options), { reason: 'network' }, 'refused')
  await expectRejection(fetchBody('https://a.example/broken', 10, signal, options), { reason: 'network' }, 'reset')
  await expectRejection(fetchBody('https://a.example/odd', 10, signal, options), { reason: 'network' }, 'reset')
  // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection keeps its text in the failure
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject('plain')))
  await expectRejection(fetchBody('https://a.example/plain', 10, signal, options), { reason: 'network' }, 'plain')
})

it('rejects a cancelled read with the cancellation reason instead of a network failure', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('aborted'))))
  const cancelled = new AbortController()
  cancelled.abort(new Error('closed by caller'))
  await expect(fetchBody('https://a.example/x', 10, cancelled.signal, options)).rejects.toThrow('closed by caller')
  const disposed = new AbortController()
  disposed.abort(new Error('service disposed'))
  await expect(fetchBody('https://a.example/x', 10, signal, { ...options, lifetime: disposed.signal })).rejects.toThrow('service disposed')
})

it('follows redirects within the origin only', async () => {
  serve({
    'https://a.example/old': () => new Response(null, { status: 301, headers: { location: '/new' } }),
    'https://a.example/new': () => new Response('moved'),
    'https://a.example/away': () => new Response(null, { status: 302, headers: { location: 'https://b.example/x' } }),
    'https://a.example/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    'https://a.example/bare': () => new Response(null, { status: 302 }),
  })
  expect(await fetchBody('https://a.example/old', 10, signal, options)).toEqual({ ok: true, bytes: Buffer.from('moved') })
  expect(await fetchBody('https://a.example/away', 10, signal, options)).toEqual({ ok: false, status: 302 })
  expect(await fetchBody('https://a.example/loop', 10, signal, options)).toEqual({ ok: false, status: 302 })
  expect(await fetchBody('https://a.example/bare', 10, signal, options)).toEqual({ ok: false, status: 302 })
})

it('reads npm files from the CDNs in order, trusting a 404 and asking the next CDN after a failure', async () => {
  const fetch = serve({
    'https://cdn.jsdelivr.net/npm/@a/b@1.0.0/docs/A%20B.md': new Error('offline'),
    'https://unpkg.com/@a/b@1.0.0/docs/A%20B.md': () => new Response('fail', { status: 502 }),
    'https://registry.npmmirror.com/@a/b/1.0.0/files/docs/A%20B.md': () => new Response('# AB'),
    'https://registry.npmmirror.com/@a/b/1.0.0/files/README.md': () => new Response('no', { status: 404 }),
    'https://registry.npmmirror.com/@a/b/1.0.0/files/readme.md': () => new Response('# readme'),
    'https://registry.npmmirror.com/@a/b/1.0.0/files/big.md': () => new Response('x'.repeat(20)),
    'https://cdn.jsdelivr.net/npm/@a/b@1.0.0/down.md': new Error('offline'),
  })
  const files = npmFiles('@a/b', '1.0.0', ['jsdelivr', 'unpkg', 'npmmirror'], options)
  expect(files.key).toBe('npm:@a/b@1.0.0')
  expect(text(await files.read('docs/A B.md', 100, signal))).toBe('# AB')
  const mirror = npmFiles('@a/b', '1.0.0', ['npmmirror'], options)
  expect(await mirror.readme('', 100, signal)).toMatchObject({ path: 'readme.md' })
  await expect(mirror.read('big.md', 10, signal)).rejects.toMatchObject({ reason: 'too-large' })
  const failure = npmFiles('@a/b', '1.0.0', ['jsdelivr'], options).read('down.md', 10, signal)
  await expect(failure).rejects.toBeInstanceOf(DetailFailure)
  await expectRejection(failure, { reason: 'network' }, 'offline')
  expect(fetch).toHaveBeenCalledTimes(7)
})

it('reads the first README name that exists', async () => {
  const read = (path: string) => Promise.resolve(path === 'd/readme.md' ? Buffer.from('r') : undefined)
  expect(await readmeByName(read, 'd', 10, signal)).toMatchObject({ path: 'd/readme.md' })
  expect(await readmeByName(read, 'd', 10, signal, ['README.md'])).toBeUndefined()
})

it('orders the configured npm CDNs by a preference, ignoring CDNs that are not configured', () => {
  const all = ['jsdelivr', 'unpkg', 'npmmirror'] as const
  expect(npmFileSourceOrder(all, ['npmmirror'])).toEqual(['npmmirror', 'jsdelivr', 'unpkg'])
  expect(npmFileSourceOrder(all, ['unpkg', 'npmmirror'])).toEqual(['unpkg', 'npmmirror', 'jsdelivr'])
  expect(npmFileSourceOrder(all)).toEqual(['jsdelivr', 'unpkg', 'npmmirror'])
  expect(npmFileSourceOrder(['unpkg'], ['npmmirror', 'other'])).toEqual(['unpkg'])
})
