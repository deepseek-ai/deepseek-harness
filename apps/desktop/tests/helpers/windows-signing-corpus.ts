/** Snapshot operator-selected release files into unsigned, hash-pinned experiment inputs. */
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { inspectWindowsRuntimeSignature } from '../../scripts/windows-runtime-signature.mjs'

/** One immutable unsigned input; its source is never modified or executed. */
export interface SigningCorpusFile {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

/**
 * Copy a nonempty JSON array of absolute paths and SHA-256 digests, then strip signatures only on copies.
 * @param manifestPath Operator-owned JSON manifest; every source must be a regular file with the pinned digest.
 * @param directory New private directory for retained unsigned templates.
 * @param removeSignature Public SignTool removal operation; never receives an original source path.
 * @param signal Stops preparation before the next file when aborted.
 * @returns Unsigned template digests and sizes in manifest order; rejects invalid signatures or changed inputs.
 */
export async function prepareSigningCorpus(
  manifestPath: string, directory: string, removeSignature: (path: string) => Promise<void>, signal: AbortSignal,
): Promise<SigningCorpusFile[]> {
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!Array.isArray(manifest) || manifest.length === 0) throw new Error('Signing corpus must be a nonempty JSON array')
  const inputs = manifest.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string'
      || !isAbsolute(entry.path) || !('sha256' in entry) || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error('Signing corpus requires absolute paths and lowercase SHA-256 digests')
    return { path: entry.path, sha256: entry.sha256 }
  })
  await mkdir(directory)
  const result: SigningCorpusFile[] = []
  for (const [index, input] of inputs.entries()) {
    signal.throwIfAborted()
    const stat = await lstat(input.path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Signing corpus source must be a regular file')
    const path = join(directory, `${index}${extname(input.path) || '.exe'}`)
    await copyFile(input.path, path)
    if (createHash('sha256').update(await readFile(path)).digest('hex') !== input.sha256) {
      throw new Error('Signing corpus source differs from its pinned digest')
    }
    const before = await inspectWindowsRuntimeSignature(path)
    if (before.status === 'Valid') await removeSignature(path)
    else if (before.status !== 'NotSigned') throw new Error('Signing corpus source has an invalid signature')
    if ((await inspectWindowsRuntimeSignature(path)).status !== 'NotSigned') throw new Error('Signing corpus copy must be unsigned')
    const content = await readFile(path)
    result.push({ path, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length })
  }
  return result
}
