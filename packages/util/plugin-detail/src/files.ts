/**
 * Read-only file sources for plugin detail documents: a local package directory and published npm package versions on
 * public file CDNs, with bounded HTTP reads. Sources keep no state between calls.
 */
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { DetailFailureReason, NpmFileSource } from './types.ts'


/** A read that must not fall back: the source exists but refused, failed, or exceeded a limit. */
export class DetailFailure extends Error {
  /**
   * @param reason - the failure kind a reader reports.
   * @param message - the diagnostic, naming the source.
   * @param options - the underlying error.
   */
  constructor(readonly reason: DetailFailureReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DetailFailure'
  }
}

/** One file found by name lookup. */
export interface FoundFile {
  /** `/`-separated path relative to the source root. */
  readonly path: string
  readonly bytes: Uint8Array
}

/** Files below one root, read by `/`-separated relative paths that never start with `/` or contain `.` or `..` segments. */
export interface DetailFiles {
  /** Identity of the files' content: two sources with the same key read the same bytes. */
  readonly key: string
  /**
   * Read one regular file.
   * @param path - path relative to the root.
   * @param maxBytes - largest accepted size.
   * @param signal - cancellation of the read.
   * @returns the file's bytes, or undefined when it does not exist.
   * @throws {DetailFailure} when the source fails or the file exceeds `maxBytes`.
   */
  read(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | undefined>
  /**
   * Read the README of a directory: `README.md`, `README.markdown`, or `README` in any letter case.
   * @param dir - directory relative to the root; `''` for the root.
   * @param maxBytes - largest accepted size.
   * @param signal - cancellation of the read.
   * @returns the file, or undefined when the directory has none.
   * @throws {DetailFailure} when the source fails or the file exceeds `maxBytes`.
   */
  readme(dir: string, maxBytes: number, signal: AbortSignal): Promise<FoundFile | undefined>
}

/** README names tried in order where a source cannot list a directory. */
export const README_NAMES: readonly string[] = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README']
const README_PATTERN = /^readme(?:\.md|\.markdown)?$/iu

/**
 * Join a directory and a file name into a root-relative path.
 * @param dir - directory relative to the root, `''` for the root.
 * @param name - path relative to `dir`.
 * @returns the joined path.
 */
export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

/**
 * Pick the README entry of a directory listing by the order of {@link README_NAMES}, then by name.
 * @param names - file names of the directory.
 * @returns the README name, or undefined.
 */
export function readmeName(names: readonly string[]): string | undefined {
  const rank = (name: string): number => {
    const index = README_NAMES.indexOf(name)
    return index === -1 ? README_NAMES.length : index
  }
  return names.filter(name => README_PATTERN.test(name)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))[0]
}

/** Reads one file: its bytes, or undefined when it is absent. */
export type ReadFile = (path: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array | undefined>

/**
 * Read the first README of `names` that exists, for sources that cannot list a directory.
 * @param read - reads one file.
 * @param dir - directory relative to the root; `''` for the root.
 * @param maxBytes - largest accepted size.
 * @param signal - cancellation of the reads.
 * @param names - the names to try, in order.
 * @returns the file, or undefined when none exists.
 * @throws {DetailFailure} what `read` throws.
 */
export async function readmeByName(
  read: ReadFile, dir: string, maxBytes: number, signal: AbortSignal, names: readonly string[] = README_NAMES,
): Promise<FoundFile | undefined> {
  for (const name of names) {
    const path = joinPath(dir, name)
    const bytes = await read(path, maxBytes, signal)
    if (bytes !== undefined) return { path, bytes }
  }
  return undefined
}

function tooLarge(label: string, maxBytes: number): DetailFailure {
  return new DetailFailure('too-large', `${label} exceeds ${String(maxBytes)} bytes`)
}

/**
 * Files of a local package directory. A path whose real location leaves the directory reads as absent.
 * @param root - absolute package directory.
 * @param revision - the installed version, so a reinstalled package reads as different files.
 * @returns the files.
 */
export function localFiles(root: string, revision: string): DetailFiles {
  const files: DetailFiles = {
    key: `local:${root}@${revision}`,
    async read(path, maxBytes) {
      let file: string
      try {
        const base = await realpath(root)
        file = await realpath(join(base, ...path.split('/')))
        const inside = relative(base, file)
        if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`)) return undefined
        const info = await lstat(file)
        if (!info.isFile()) return undefined
        if (info.size > maxBytes) throw tooLarge(path, maxBytes)
      } catch (error) {
        if (error instanceof DetailFailure) throw error
        // A missing file or directory, or one the process may not read, is a file the package does not provide.
        return undefined
      }
      const bytes = await readFile(file)
      /* v8 ignore next -- the file grew between its size check and its read; no test controls that timing */
      if (bytes.byteLength > maxBytes) throw tooLarge(path, maxBytes)
      return bytes
    },
    async readme(dir, maxBytes, signal) {
      let names: string[]
      try {
        names = (await readdir(join(root, ...dir === '' ? [] : dir.split('/')), { withFileTypes: true }))
          .filter(entry => entry.isFile() || entry.isSymbolicLink()).map(entry => entry.name)
      } catch (_missing) {
        // An absent or unreadable directory has no README.
        return undefined
      }
      const name = readmeName(names)
      if (name === undefined) return undefined
      const path = joinPath(dir, name)
      const bytes = await files.read(path, maxBytes, signal)
      return bytes === undefined ? undefined : { path, bytes }
    },
  }
  return files
}

/** Request settings of a remote file source. */
export interface RemoteFileOptions {
  readonly timeoutMs: number
  /** Cancellation that outlives one read, such as the owning service's disposal. */
  readonly lifetime: AbortSignal
}

/** One HTTP answer: the body of a 2xx response, or the status of any other. */
export type FetchedBody = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly status: number }

/** Redirects followed within one origin, such as a renamed repository's raw files; a redirect to another origin is not followed. */
const MAX_REDIRECTS = 3

/**
 * GET a URL, following redirects within its origin, and read the body up to `maxBytes`.
 * @param url - the request URL.
 * @param maxBytes - largest accepted body.
 * @param signal - cancellation of the read.
 * @param options - deadline and service lifetime.
 * @returns the body, or the status of a non-2xx response, including a redirect to another origin.
 * @throws {DetailFailure} `network` when no response arrives or the body fails, `too-large` over `maxBytes`.
 */
export async function fetchBody(url: string, maxBytes: number, signal: AbortSignal, options: RemoteFileOptions): Promise<FetchedBody> {
  const combined = AbortSignal.any([signal, options.lifetime, AbortSignal.timeout(options.timeoutMs)])
  let response: Response | undefined
  let target = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      response = await fetch(target, { signal: combined, redirect: 'manual' })
    } catch (error) {
      // A cancelled read says nothing about the source, so it keeps the caller's reason.
      signal.throwIfAborted()
      options.lifetime.throwIfAborted()
      throw new DetailFailure('network', `Could not fetch ${target}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (location === null || !URL.canParse(location, target) || new URL(location, target).origin !== new URL(url).origin) break
    await response.body?.cancel()
    target = new URL(location, target).href
  }
  // The loop runs at least once.
  const answer = response as Response
  if (!answer.ok) {
    await answer.body?.cancel()
    return { ok: false, status: answer.status }
  }
  if (Number(answer.headers.get('content-length') ?? 0) > maxBytes) {
    await answer.body?.cancel()
    throw tooLarge(url, maxBytes)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for await (const chunk of answer.body ?? []) {
      size += chunk.byteLength
      if (size > maxBytes) throw tooLarge(url, maxBytes)
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof DetailFailure) throw error
    throw new DetailFailure('network', `Could not read ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return { ok: true, bytes: Buffer.concat(chunks) }
}

/** Every npm file CDN, in the default order. */
export const NPM_FILE_SOURCES = ['jsdelivr', 'unpkg', 'npmmirror'] as const satisfies readonly NpmFileSource[]

/**
 * Order the configured npm file CDNs by a caller's preference: the preferred ones that are configured, in the preferred
 * order, then the other configured ones in configured order. A preferred CDN that is not configured is not asked.
 * @param configured - the configured CDNs in order.
 * @param preferred - CDNs to ask first, such as those a Client measured as fastest; names other than CDNs are ignored.
 * @returns the CDNs to ask, first to last.
 */
export function npmFileSourceOrder(configured: readonly NpmFileSource[], preferred: readonly string[] = []): NpmFileSource[] {
  const first = configured.filter(source => preferred.includes(source)).sort((a, b) => preferred.indexOf(a) - preferred.indexOf(b))
  return [...first, ...configured.filter(source => !first.includes(source))]
}

/**
 * Percent-encode each segment of a `/`-separated path for a URL.
 * @param path - the path.
 * @returns the encoded path.
 */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

const NPM_FILE_URLS: Record<NpmFileSource, (name: string, version: string, path: string) => string> = {
  jsdelivr: (name, version, path) => `https://cdn.jsdelivr.net/npm/${name}@${version}/${encodePath(path)}`,
  unpkg: (name, version, path) => `https://unpkg.com/${name}@${version}/${encodePath(path)}`,
  npmmirror: (name, version, path) => `https://registry.npmmirror.com/${name}/${version}/files/${encodePath(path)}`,
}

/**
 * Files of one published npm package version, read from public file CDNs in order. A 404 from a CDN means the package
 * does not contain the file; a network failure or another status asks the next CDN.
 * @param name - package name.
 * @param version - exact version.
 * @param sources - the CDNs to ask, first to last; never empty.
 * @param options - deadline and service lifetime.
 * @returns the files.
 */
export function npmFiles(name: string, version: string, sources: readonly NpmFileSource[], options: RemoteFileOptions): DetailFiles {
  const files: DetailFiles = {
    key: `npm:${name}@${version}`,
    async read(path, maxBytes, signal) {
      const failures: string[] = []
      for (const source of sources) {
        const url = NPM_FILE_URLS[source](name, version, path)
        try {
          const body = await fetchBody(url, maxBytes, signal, options)
          if (body.ok) return body.bytes
          if (body.status === 404) return undefined
          failures.push(`${url}: HTTP ${String(body.status)}`)
        } catch (error) {
          if (!(error instanceof DetailFailure) || error.reason !== 'network') throw error
          failures.push(error.message)
        }
      }
      throw new DetailFailure('network', failures.join('; '))
    },
    readme: (dir, maxBytes, signal) => readmeByName((path, max, readSignal) => files.read(path, max, readSignal), dir, maxBytes, signal),
  }
  return files
}
