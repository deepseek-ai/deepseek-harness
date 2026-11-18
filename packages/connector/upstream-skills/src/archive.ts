/** Download one upstream skill set from a GitHub commit archive: kept files, path checks, the size bound, and the digest. */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import type { UpstreamSkillSelection, UpstreamSkillSet } from './types.ts'

/** Entry types read as regular files. */
const FILE_TYPES: ReadonlySet<string> = new Set(['File', 'OldFile', 'ContiguousFile'])

/** Whether a slash-separated path relative to the repository root is one of the selection's kept files. */
function isKept(selection: UpstreamSkillSelection, path: string): boolean {
  return path === selection.license || (path.startsWith(`${selection.directory}/`) && !selection.exclude.includes(path))
}

/**
 * Read the kept files of a commit archive whose entries all sit under one top-level directory.
 * @param archive - the gzip tarball.
 * @param selection - which files to keep.
 * @param maxBytes - the most bytes the kept files may hold; reading stops at the entry that exceeds it.
 * @returns the kept files keyed by their path relative to the repository root.
 * @throws when an entry path is empty, `.`, `..`, or holds a backslash (on Windows node-tar has already turned backslashes
 *   into slashes, so the segments they separate are checked instead), entries sit under more than one top-level
 *   directory, a kept path is not a regular file or appears twice, the kept files exceed `maxBytes`, the license file is
 *   missing, or the archive is malformed.
 */
export async function readArchive(archive: Readable, selection: UpstreamSkillSelection, maxBytes: number): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const seen = new Set<string>()
  let root: string | undefined
  let bytes = 0
  let failure: Error | undefined
  const fail = (error: Error): void => {
    failure ??= error
    archive.destroy(failure)
  }
  // Loaded at the first download: the experimental Web preview's browser worker cannot evaluate node-tar, and the Service loads there.
  const { t: list } = await import('tar')
  const parser = list({
    strict: true,
    onReadEntry: (entry) => {
      if (failure !== undefined) return
      const segments = entry.path.replace(/\/$/u, '').split('/')
      if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) {
        fail(new Error(`the archive holds the unsafe path ${entry.path}`))
        return
      }
      const [top, ...rest] = segments
      root ??= top
      if (top !== root) {
        fail(new Error(`the archive holds ${entry.path} outside its top-level directory ${String(root)}`))
        return
      }
      const path = rest.join('/')
      if (rest.length === 0 || !isKept(selection, path) || entry.type === 'Directory') return
      if (!FILE_TYPES.has(entry.type)) {
        fail(new Error(`the archive holds ${path} as a ${entry.type}, not a regular file`))
        return
      }
      if (seen.has(path)) {
        fail(new Error(`the archive holds ${path} twice`))
        return
      }
      seen.add(path)
      bytes += entry.size
      if (bytes > maxBytes) {
        fail(new Error(`the kept files of the archive exceed ${String(maxBytes)} bytes`))
        return
      }
      const chunks: Buffer[] = []
      entry.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      entry.on('end', () => { files.set(path, Buffer.concat(chunks)) })
    },
  })
  try {
    await pipeline(archive, parser)
  } catch (error) {
    throw failure ?? error
  }
  if (!files.has(selection.license)) throw new Error(`the archive holds no ${selection.license}`)
  return files
}

/**
 * Digest files by their sorted paths and their contents; the digest covers the files, not the archive bytes, which a
 * host may compress differently.
 * @param files - the files keyed by their path relative to the repository root.
 * @returns the lowercase hexadecimal SHA-256 digest.
 */
export function digestFiles(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash('sha256')
  for (const [path, content] of [...files].toSorted(([left], [right]) => (left < right ? -1 : 1))) {
    hash.update(`${path}\0${String(content.length)}\0`).update(content)
  }
  return hash.digest('hex')
}

/**
 * Write files under a directory at their repository paths.
 * @param files - the files keyed by their path relative to the repository root.
 * @param into - the existing directory that receives them.
 * @returns after every file is written.
 */
export async function writeFiles(files: ReadonlyMap<string, Uint8Array>, into: string): Promise<void> {
  for (const [path, content] of files) {
    const file = join(into, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}

/**
 * The archive URL of a selection's commit under one download prefix.
 * @param base - the prefix, with or without trailing slashes.
 * @param selection - the repository and commit.
 * @returns `<prefix>/<owner>/<repository>/tar.gz/<commit>`.
 */
export function archiveUrl(base: string, selection: UpstreamSkillSelection): string {
  return `${base.replace(/\/+$/u, '')}/${selection.repository}/tar.gz/${selection.commit}`
}

/**
 * Download an archive and read its kept files.
 * @param url - the archive URL.
 * @param selection - which files to keep.
 * @param maxBytes - the most bytes the kept files may hold.
 * @param signal - aborts the download.
 * @returns the kept files keyed by their path relative to the repository root.
 * @throws when the response is not successful or has no body, or when {@link readArchive} refuses the archive.
 */
export async function fetchArchive(
  url: string, selection: UpstreamSkillSelection, maxBytes: number, signal: AbortSignal,
): Promise<Map<string, Buffer>> {
  const response = await fetch(url, { signal })
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new Error(`${url} returned HTTP ${String(response.status)}`)
  }
  // The DOM and Node declarations name the same WHATWG stream class.
  return readArchive(Readable.fromWeb(response.body as ReadableStream<Uint8Array>, { signal }), selection, maxBytes)
}

/**
 * Download the archive of the pinned commit from the first prefix whose kept files match the pinned size and digest.
 * @param set - the pinned selection.
 * @param urls - archive download prefixes tried in order; each serves `<owner>/<repository>/tar.gz/<commit>`.
 * @param timeoutMs - how long one prefix may take to deliver the whole archive.
 * @param signal - aborts the download without trying the next prefix.
 * @param warn - receives one message and error for each prefix that fails.
 * @returns the verified kept files.
 * @throws the abort reason, or an error naming the set when every prefix fails.
 */
export async function downloadSkillSet(
  set: UpstreamSkillSet, urls: readonly string[], timeoutMs: number, signal: AbortSignal,
  warn: (message: string, error: unknown) => void,
): Promise<Map<string, Buffer>> {
  let failure: unknown
  for (const base of urls) {
    const url = archiveUrl(base, set)
    try {
      const files = await fetchArchive(url, set, set.bytes, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]))
      if (digestFiles(files) !== set.sha256) throw new Error(`the kept files of ${url} do not match the pinned digest`)
      return files
    } catch (error) {
      signal.throwIfAborted()
      failure = error
      warn(`downloading the upstream skills from ${base} failed`, error)
    }
  }
  const at = `${set.repository} at ${set.commit}`
  throw new Error(`could not download the upstream skills of ${at} from any skills URL`, { cause: failure })
}
