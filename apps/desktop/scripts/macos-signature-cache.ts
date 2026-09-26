/** Reuse verified standalone signatures by file content and complete signing policy. */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function digest(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }
function regular(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error(`macOS signature cache: expected regular file ${path}`)
}
function directory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error(`macOS signature cache: expected directory ${path}`)
}
function ensureDirectory(path: string): void {
  if (dirname(path) !== path) ensureDirectory(dirname(path))
  if (!existsSync(path)) {
    try { mkdirSync(path, { mode: 0o700 }) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
  }
  directory(path)
}

function readEntry(entry: string, key: string): { payload: string; sha256: string } {
  directory(entry)
  const record = join(entry, 'record.json')
  const payload = join(entry, 'code')
  regular(record); regular(payload)
  const metadata = JSON.parse(readFileSync(record, 'utf8')) as { key?: unknown; sha256?: unknown }
  if (metadata.key !== key || typeof metadata.sha256 !== 'string') throw new Error(`macOS signature cache: invalid record ${entry}`)
  if (digest(readFileSync(payload)) !== metadata.sha256) throw new Error(`macOS signature cache: damaged payload ${entry}`)
  return { payload, sha256: metadata.sha256 }
}

/** A signer whose verifier checks all policy fields represented by its stable key. */
export interface MacOSCachedSigner {
  readonly policy: string
  /** @param path Private executable copy to sign. @returns Completion after all owned signing activity settles. */
  sign: (path: string) => Promise<void>
  /** @param path Executable whose signature must satisfy the complete policy. */
  verify: (path: string) => void
}

/**
 * Sign a private copy or validate a cached copy, then atomically replace an unchanged input.
 * @param path Regular standalone executable owned by this build.
 * @param cacheRoot Private content-addressed signature storage.
 * @param signer Complete signing policy and its signing/verification operations.
 * @returns Whether a previously verified signature was reused.
 */
export async function cachedMacOSSignature(path: string, cacheRoot: string, signer: MacOSCachedSigner): Promise<boolean> {
  regular(path)
  const mode = lstatSync(path).mode & 0o777
  const input = digest(readFileSync(path))
  const key = digest(JSON.stringify({ schema: 1, input, mode, policy: signer.policy }))
  ensureDirectory(cacheRoot)
  const entry = join(cacheRoot, key)
  const work = mkdtempSync(join(dirname(path), '.dsh-sign-'))
  const candidate = join(work, 'code')
  const unchanged = (): void => {
    regular(path)
    if (digest(readFileSync(path)) !== input || (lstatSync(path).mode & 0o777) !== mode) {
      throw new Error('macOS signature cache: input changed during signing')
    }
  }
  try {
    const hit = existsSync(entry)
    if (hit) {
      const { payload, sha256 } = readEntry(entry, key)
      copyFileSync(payload, candidate)
      if (digest(readFileSync(candidate)) !== sha256) throw new Error(`macOS signature cache: damaged payload ${entry}`)
    } else {
      copyFileSync(path, candidate)
      if (digest(readFileSync(candidate)) !== input) throw new Error('macOS signature cache: input changed while copying')
      await signer.sign(candidate)
    }
    chmodSync(candidate, mode)
    const signed = digest(readFileSync(candidate))
    signer.verify(candidate)
    if (digest(readFileSync(candidate)) !== signed) throw new Error('macOS signature cache: candidate changed during verification')
    unchanged()
    if (!hit) {
      const staging = mkdtempSync(join(cacheRoot, '.pending-'))
      try {
        copyFileSync(candidate, join(staging, 'code'))
        if (digest(readFileSync(join(staging, 'code'))) !== signed) throw new Error('macOS signature cache: staged payload changed')
        writeFileSync(join(staging, 'record.json'), `${JSON.stringify({ key, sha256: signed })}\n`, { mode: 0o600, flag: 'wx', flush: true })
        try { renameSync(staging, entry) }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && ['ENOTEMPTY', 'EEXIST'].includes(String(error.code)))) throw error
          const winner = readEntry(entry, key)
          signer.verify(winner.payload)
        }
      } finally { rmSync(staging, { recursive: true, force: true }) }
    }
    unchanged()
    renameSync(candidate, path)
    return hit
  } finally { rmSync(work, { recursive: true, force: true }) }
}

/**
 * Retain newest complete cache entries within a one-GiB payload budget; active readers fail closed on eviction races.
 * @param root Cache directory owned by packaging.
 * @returns Nothing.
 */
export function pruneMacOSSignatureCache(root: string): void {
  if (!existsSync(root)) return
  directory(root)
  const entries = readdirSync(root).filter(name => /^[a-f0-9]{64}$/u.test(name)).map((name) => {
    const path = join(root, name)
    directory(path)
    const payload = join(path, 'code')
    regular(payload)
    const stat = lstatSync(payload)
    return { path, bytes: stat.size, time: stat.mtimeMs }
  }).sort((a, b) => b.time - a.time)
  let bytes = 0
  for (const entry of entries) {
    bytes += entry.bytes
    if (bytes > 1024 ** 3) rmSync(entry.path, { recursive: true })
  }
}
