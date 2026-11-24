/** Fixtures for upstream skill tests: crafted commit archives, a pinned set over them, and a local archive host. */
import { createHash } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { Header, type HeaderData } from 'tar'
import type { UpstreamSkillSelection, UpstreamSkillSet } from '../src/types.ts'

/** One crafted tar entry; a file's size is its content's. */
export interface ArchiveEntry {
  readonly path: string
  readonly type?: HeaderData['type']
  readonly content?: string
  readonly linkpath?: string
}

/** The archive's top-level directory, as GitHub names it `<repository>-<commit>`. */
export const ROOT = 'skills-repo-0123456789abcdef0123456789abcdef01234567'

export const SELECTION: UpstreamSkillSelection = {
  repository: 'vendor/skills-repo',
  commit: '0123456789abcdef0123456789abcdef01234567',
  directory: 'skills',
  exclude: ['skills/alpha/scripts/init.py'],
  license: 'LICENSE',
}

/** The kept files of {@link repository}, keyed by their repository paths. */
export const KEPT: Readonly<Record<string, string>> = {
  'LICENSE': 'MIT License\n',
  'skills/alpha/SKILL.md': '# Alpha\n\nSee references/a.md.\n',
  'skills/alpha/references/a.md': '多字节内容\n',
  'skills/beta/SKILL.md': '# Beta\n',
}

/**
 * Gzip a tar stream of the given entries, in order.
 * @param entries - the crafted entries; directories end in `/`.
 * @returns the archive bytes.
 */
export function tarball(entries: readonly ArchiveEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '')
    const header = new Header({
      path: entry.path, type: entry.type ?? 'File', size: content.length, mode: 0o644, mtime: new Date(0),
      ...entry.linkpath === undefined ? {} : { linkpath: entry.linkpath },
    })
    header.encode()
    if (header.block === undefined) throw new Error(`tar header for ${entry.path} was not encoded`)
    blocks.push(header.block, content, Buffer.alloc((512 - (content.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/**
 * The archive of a repository holding the kept files plus unrelated files, directories, and an excluded script.
 * @param kept - the kept files at their repository paths.
 * @returns the archive bytes.
 */
export function repository(kept: Readonly<Record<string, string>> = KEPT): Buffer {
  return tarball([
    { path: `${ROOT}/`, type: 'Directory' },
    { path: `${ROOT}/README.md`, content: 'upstream readme\n' },
    { path: `${ROOT}/bin/`, type: 'Directory' },
    { path: `${ROOT}/bin/cli`, type: 'SymbolicLink', linkpath: '../dist/cli' },
    { path: `${ROOT}/skills/`, type: 'Directory' },
    { path: `${ROOT}/skills/alpha/scripts/init.py`, content: 'print("init")\n' },
    ...Object.entries(kept).map(([path, content]) => ({ path: `${ROOT}/${path}`, content })),
  ])
}

/**
 * Pin a selection to the given kept files the way the digest script does.
 * @param kept - the kept files at their repository paths.
 * @returns the pinned set.
 */
export function pin(kept: Readonly<Record<string, string>> = KEPT): UpstreamSkillSet {
  const hash = createHash('sha256')
  let bytes = 0
  for (const [path, content] of Object.entries(kept).toSorted(([left], [right]) => (left < right ? -1 : 1))) {
    const data = Buffer.from(content)
    bytes += data.length
    hash.update(`${path}\0${String(data.length)}\0`).update(data)
  }
  return { ...SELECTION, bytes, sha256: hash.digest('hex') }
}

/** A local archive host whose routes a test replaces; unknown paths answer 404. */
export interface ArchiveHost {
  readonly base: string
  readonly requests: string[]
  routes: Record<string, (response: ServerResponse) => void | Promise<void>>
  close(): Promise<void>
}

/** @returns a started host on a free loopback port. */
export async function startHost(): Promise<ArchiveHost> {
  const requests: string[] = []
  const host: Pick<ArchiveHost, 'routes'> = { routes: {} }
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? '')
    const route = host.routes[request.url ?? '']
    if (route === undefined) response.writeHead(404).end('not found')
    else void route(response)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return Object.assign(host, {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  })
}

/**
 * @param body - the archive bytes.
 * @returns a route that answers them without a declared length, as GitHub's archive host streams them.
 */
export const serve = (body: Buffer) => (response: ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'application/x-gzip' }).end(body)
}

/** The archive path the set is downloaded from under a prefix. */
export const archivePath = (set: UpstreamSkillSelection, prefix = ''): string => `${prefix}/${set.repository}/tar.gz/${set.commit}`
