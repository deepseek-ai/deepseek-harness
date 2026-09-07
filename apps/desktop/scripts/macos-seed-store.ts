/** Sign Mach-O content in a pnpm CAS without invalidating the store index. */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Packr } from 'msgpackr'
import type { MacOSSigningEnvironment } from './desktop-release-environment.mjs'
import { signMacOSSeedCode, verifyMacOSSeedCode } from './verify-macos-signature.mjs'

const MACH_O_MAGICS = new Set([
  'cafebabe',
  'cafebabf',
  'cefaedfe',
  'cffaedfe',
  'feedface',
  'feedfacf',
  'bebafeca',
  'bfbafeca',
])
const CAS_PATH_PATTERN = /^([0-9a-f]{2})\/([0-9a-f]{126})(-exec)?$/u
const MAX_CONCURRENT_CODE_SIGNERS = 4
const packr = new Packr({ moreTypes: true, useRecords: true })

interface PnpmStoreFileRecord {
  checkedAt: number
  digest: string
  mode: number
  size: number
}

interface PnpmSideEffectsRecord {
  readonly added?: Map<string, PnpmStoreFileRecord>
}

interface PnpmPackageIndexRecord {
  readonly algo?: string
  readonly files?: Map<string, PnpmStoreFileRecord>
  readonly sideEffects?: Map<string, PnpmSideEffectsRecord>
}

interface DecodedIndexRow {
  readonly key: string
  readonly value: PnpmPackageIndexRecord
  changed: boolean
}

interface CasFile {
  readonly path: string
  readonly digest: string
  readonly executable: boolean
}

interface FileReference {
  readonly row: DecodedIndexRow
  readonly record: PnpmStoreFileRecord
}

interface SigningWork {
  readonly file: CasFile
  readonly references: readonly FileReference[]
  readonly temporaryPath: string
}

/** Summary of native code rewritten in one pnpm store. */
export interface MacOSSeedStoreSigningResult {
  readonly signedFiles: number
  readonly prunedOrphans: number
  readonly updatedIndexRows: number
}

/** A signer used to make one writable Mach-O copy release-valid. */
export type MacOSSeedCodeSigner = (path: string, identifier: string) => Promise<void>

/** A verifier used to check one Mach-O file after packaging transport. */
export type MacOSSeedCodeVerifier = (path: string) => void

/** Optional execution controls for seed-store code signing. */
export interface MacOSSeedStoreSigningOptions {
  readonly signer?: MacOSSeedCodeSigner
  readonly concurrency?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStoreFileRecord(value: unknown): value is PnpmStoreFileRecord {
  if (!isRecord(value)) return false
  return typeof value.checkedAt === 'number'
    && typeof value.digest === 'string'
    && /^[0-9a-f]{128}$/u.test(value.digest)
    && Number.isSafeInteger(value.mode)
    && Number.isSafeInteger(value.size)
}

function packageFileMaps(value: unknown, key: string): readonly Map<string, PnpmStoreFileRecord>[] {
  if (!isRecord(value)) throw new Error(`desktop seed signing: invalid pnpm index record ${key}`)
  const record = value as PnpmPackageIndexRecord
  if (record.algo !== undefined && record.algo !== 'sha512') {
    throw new Error(`desktop seed signing: unsupported pnpm index algorithm in ${key}`)
  }
  const maps: Map<string, PnpmStoreFileRecord>[] = []
  if (record.files !== undefined) {
    if (!(record.files instanceof Map)) throw new Error(`desktop seed signing: invalid pnpm file map in ${key}`)
    maps.push(record.files)
  }
  if (record.sideEffects !== undefined) {
    if (!(record.sideEffects instanceof Map)) {
      throw new Error(`desktop seed signing: invalid pnpm side-effects map in ${key}`)
    }
    for (const effect of record.sideEffects.values()) {
      if (!isRecord(effect)) throw new Error(`desktop seed signing: invalid pnpm side effect in ${key}`)
      if (effect.added === undefined) continue
      if (!(effect.added instanceof Map)) {
        throw new Error(`desktop seed signing: invalid pnpm side-effect file map in ${key}`)
      }
      maps.push(effect.added)
    }
  }
  for (const files of maps) {
    for (const file of files.values()) {
      if (!isStoreFileRecord(file)) throw new Error(`desktop seed signing: invalid pnpm file record in ${key}`)
    }
  }
  return maps
}

function isExecutableMode(mode: number): boolean {
  return (mode & 0o111) !== 0
}

function referenceKey(digest: string, executable: boolean): string {
  return `${digest}:${executable ? 'exec' : 'nonexec'}`
}

function isMachO(path: string): boolean {
  const descriptor = openSync(path, 'r')
  try {
    const header = Buffer.alloc(4)
    return readSync(descriptor, header, 0, header.length, 0) === header.length
      && MACH_O_MAGICS.has(header.toString('hex'))
  } finally {
    closeSync(descriptor)
  }
}

function visitFiles(root: string): readonly string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`desktop seed signing: pnpm store contains a symbolic link: ${relative(root, path)}`)
      }
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`desktop seed signing: unsupported pnpm store entry: ${relative(root, path)}`)
    }
  }
  visit(root)
  return files.sort((left, right) => left.localeCompare(right))
}

function versionRoots(storeRoot: string): readonly string[] {
  return readdirSync(storeRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^v\d+$/u.test(entry.name))
    .map(entry => join(storeRoot, entry.name))
    .filter(root => existsSync(join(root, 'files')))
    .sort((left, right) => left.localeCompare(right))
}

function casFiles(versionRoot: string): readonly CasFile[] {
  const filesRoot = join(versionRoot, 'files')
  const result: CasFile[] = []
  for (const path of visitFiles(filesRoot)) {
    if (!isMachO(path)) continue
    const normalized = relative(filesRoot, path).split(sep).join('/')
    const match = CAS_PATH_PATTERN.exec(normalized)
    if (match === null) {
      throw new Error(`desktop seed signing: Mach-O content has an unsupported pnpm CAS path: ${normalized}`)
    }
    result.push({
      path,
      digest: `${match[1]}${match[2]}`,
      executable: match[3] !== undefined,
    })
  }
  return result
}

function readIndexRows(database: DatabaseSync): readonly DecodedIndexRow[] {
  const rows: DecodedIndexRow[] = []
  for (const row of database.prepare('SELECT key, data FROM package_index').iterate() as Iterable<{
    key: string
    data: Uint8Array
  }>) {
    rows.push({ key: row.key, value: packr.unpack(row.data) as PnpmPackageIndexRecord, changed: false })
  }
  return rows
}

function fileReferences(rows: readonly DecodedIndexRow[]): ReadonlyMap<string, readonly FileReference[]> {
  const references = new Map<string, FileReference[]>()
  for (const row of rows) {
    for (const files of packageFileMaps(row.value, row.key)) {
      for (const record of files.values()) {
        const key = referenceKey(record.digest, isExecutableMode(record.mode))
        const values = references.get(key) ?? []
        values.push({ row, record })
        references.set(key, values)
      }
    }
  }
  return references
}

function writeCasFile(path: string, body: Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, body, { flag: 'wx', mode })
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST' || !readFileSync(path).equals(body)) throw error
  }
  chmodSync(path, mode)
}

function signedCasPath(versionRoot: string, digest: string, executable: boolean): string {
  return join(
    versionRoot,
    'files',
    digest.slice(0, 2),
    `${digest.slice(2)}${executable ? '-exec' : ''}`,
  )
}

async function runConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const failure: { error?: unknown; failed: boolean } = { failed: false }
  const worker = async (): Promise<void> => {
    while (!failure.failed) {
      const index = next
      if (index >= values.length) return
      next += 1
      try {
        await run(values[index] as T)
      } catch (error) {
        if (!failure.failed) {
          failure.failed = true
          failure.error = error
        }
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => worker(),
  )
  await Promise.all(workers)
  if (failure.failed) throw failure.error
}

async function rewriteVersionStore(
  versionRoot: string,
  appId: string,
  signer: MacOSSeedCodeSigner,
  concurrency: number,
): Promise<MacOSSeedStoreSigningResult> {
  const databasePath = join(versionRoot, 'index.db')
  if (!existsSync(databasePath)) {
    throw new Error(`desktop seed signing: pnpm store has no package index: ${databasePath}`)
  }
  const database = new DatabaseSync(databasePath)
  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-desktop-seed-signing-'))
  const obsoleteFiles = new Set<string>()
  let prunedOrphans = 0
  let rows: readonly DecodedIndexRow[] = []
  try {
    rows = readIndexRows(database)
    const references = fileReferences(rows)
    const signingWork: SigningWork[] = []
    for (const file of casFiles(versionRoot)) {
      const body = readFileSync(file.path)
      const actualDigest = createHash('sha512').update(body).digest('hex')
      if (actualDigest !== file.digest) {
        throw new Error(`desktop seed signing: pnpm CAS digest mismatch at ${file.path}`)
      }
      const fileReferences = references.get(referenceKey(file.digest, file.executable)) ?? []
      if (fileReferences.length === 0) {
        obsoleteFiles.add(file.path)
        prunedOrphans += 1
        continue
      }
      const temporary = join(workRoot, `${signingWork.length.toString().padStart(4, '0')}-${basename(file.path)}`)
      copyFileSync(file.path, temporary)
      chmodSync(temporary, 0o755)
      signingWork.push({ file, references: fileReferences, temporaryPath: temporary })
    }
    await runConcurrent(signingWork, concurrency, async (work) => {
      await signer(work.temporaryPath, `${appId}.seed.${work.file.digest.slice(0, 32)}`)
    })
    for (const work of signingWork) {
      const signedBody = readFileSync(work.temporaryPath)
      if (!isMachO(work.temporaryPath)) {
        throw new Error(`desktop seed signing: signer produced non-Mach-O content for ${work.file.path}`)
      }
      const signedDigest = createHash('sha512').update(signedBody).digest('hex')
      const mode = work.file.executable ? 0o755 : 0o644
      const destination = signedCasPath(versionRoot, signedDigest, work.file.executable)
      writeCasFile(destination, signedBody, mode)
      const checkedAt = Date.now()
      for (const reference of work.references) {
        reference.record.checkedAt = checkedAt
        reference.record.digest = signedDigest
        reference.record.mode = mode
        reference.record.size = signedBody.length
        reference.row.changed = true
      }
      if (destination !== work.file.path) obsoleteFiles.add(work.file.path)
    }
    const changedRows = rows.filter(row => row.changed)
    database.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      const statement = database.prepare('INSERT OR REPLACE INTO package_index (key, data) VALUES (?, ?)')
      for (const row of changedRows) statement.run(row.key, packr.pack(row.value))
      database.exec('COMMIT')
      committed = true
    } finally {
      if (!committed) database.exec('ROLLBACK')
    }
    for (const path of obsoleteFiles) unlinkSync(path)
    database.exec('VACUUM')
    return { signedFiles: signingWork.length, prunedOrphans, updatedIndexRows: changedRows.length }
  } finally {
    database.close()
    rmSync(workRoot, { recursive: true, force: true })
  }
}

/**
 * Replace every Mach-O CAS object with a Developer ID signed object and update pnpm's SHA-512 index.
 * A signer rejection leaves the original CAS objects and package index unchanged.
 * @param storeRoot - Loose pnpm store prepared for the packaged seed.
 * @param appId - Electron application ID used as the signing identifier prefix.
 * @param expected - Company Developer ID identity and Team ID.
 * @param options - Optional signer and worker bound used by focused tests.
 * @returns Counts for release diagnostics after every signer completes and the index transaction commits.
 */
export async function signMacOSSeedStore(
  storeRoot: string,
  appId: string,
  expected: MacOSSigningEnvironment,
  options: MacOSSeedStoreSigningOptions = {},
): Promise<MacOSSeedStoreSigningResult> {
  const roots = versionRoots(storeRoot)
  if (roots.length === 0) throw new Error(`desktop seed signing: no pnpm store versions found in ${storeRoot}`)
  const concurrency = options.concurrency ?? Math.min(MAX_CONCURRENT_CODE_SIGNERS, availableParallelism())
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`desktop seed signing: concurrency must be a positive integer; received ${String(concurrency)}`)
  }
  const signer = options.signer ?? (async (path, identifier) => {
    await signMacOSSeedCode(path, identifier, expected)
  })
  const results: MacOSSeedStoreSigningResult[] = []
  for (const root of roots) results.push(await rewriteVersionStore(root, appId, signer, concurrency))
  return results.reduce((total, current) => ({
    signedFiles: total.signedFiles + current.signedFiles,
    prunedOrphans: total.prunedOrphans + current.prunedOrphans,
    updatedIndexRows: total.updatedIndexRows + current.updatedIndexRows,
  }), { signedFiles: 0, prunedOrphans: 0, updatedIndexRows: 0 })
}

/**
 * Verify that every Mach-O CAS object has the expected Developer ID, timestamp, and hardened runtime.
 * @param storeRoot - Loose or extracted pnpm store.
 * @param expected - Company Developer ID identity and Team ID.
 * @param verifier - Injectable signature verifier used by focused tests.
 * @returns Number of verified Mach-O files.
 */
export function verifyMacOSSeedStore(
  storeRoot: string,
  expected: MacOSSigningEnvironment,
  verifier: MacOSSeedCodeVerifier = (path) => { verifyMacOSSeedCode(path, expected) },
): number {
  let count = 0
  for (const root of versionRoots(storeRoot)) {
    for (const file of casFiles(root)) {
      verifier(file.path)
      count += 1
    }
  }
  return count
}
