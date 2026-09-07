/** Deterministic archive transport for the desktop seed's pnpm store. */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { create, extract, list } from 'tar'

/** Directory containing the seed's uncompressed pnpm store archives. */
export const SEED_STORE_ARCHIVE_DIR = 'store-archives'

/** Manifest describing the deterministic pnpm store archive set. */
export const SEED_STORE_ARCHIVE_MANIFEST = 'store-archives.json'

const DEFAULT_SHARD_COUNT = 16
const ARCHIVE_NAME_PATTERN = /^store-[0-9a-f]{2}\.tar$/u
const STORE_VERSION_PATTERN = /^v\d+$/u

interface SeedStoreArchiveRecord {
  readonly file: string
  readonly entries: number
}

interface SeedStoreArchiveManifest {
  readonly schemaVersion: 1
  readonly shardCount: number
  readonly archives: readonly SeedStoreArchiveRecord[]
}

function storeFiles(storeRoot: string): readonly string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`desktop seed: pnpm store contains a symbolic link: ${relative(storeRoot, path)}`)
      }
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`desktop seed: pnpm store contains an unsupported file: ${relative(storeRoot, path)}`)
      }
      files.push(relative(storeRoot, path).split(sep).join('/'))
    }
  }
  visit(storeRoot)
  return files.sort((left, right) => left.localeCompare(right))
}

function shardFor(path: string, shardCount: number): number {
  return createHash('sha256').update(path).digest().readUInt32BE(0) % shardCount
}

function readArchiveManifest(seedRoot: string): SeedStoreArchiveManifest {
  const path = join(seedRoot, SEED_STORE_ARCHIVE_MANIFEST)
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (typeof value !== 'object' || value === null) {
    throw new Error(`desktop seed: invalid pnpm store archive manifest ${path}`)
  }
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(candidate.shardCount)
    || (candidate.shardCount as number) < 1 || (candidate.shardCount as number) > 256
    || !Array.isArray(candidate.archives) || candidate.archives.length === 0) {
    throw new Error(`desktop seed: invalid pnpm store archive manifest ${path}`)
  }
  const names = new Set<string>()
  const archives = candidate.archives.map((entry): SeedStoreArchiveRecord => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`desktop seed: invalid pnpm store archive record in ${path}`)
    }
    const record = entry as Record<string, unknown>
    if (typeof record.file !== 'string' || !ARCHIVE_NAME_PATTERN.test(record.file)
      || names.has(record.file) || !Number.isSafeInteger(record.entries) || (record.entries as number) < 1) {
      throw new Error(`desktop seed: invalid pnpm store archive record in ${path}`)
    }
    const shard = Number.parseInt(record.file.slice('store-'.length, -'.tar'.length), 16)
    if (shard >= (candidate.shardCount as number)) {
      throw new Error(`desktop seed: pnpm store archive shard is outside the manifest range in ${path}`)
    }
    names.add(record.file)
    return { file: record.file, entries: record.entries as number }
  })
  return {
    schemaVersion: 1,
    shardCount: candidate.shardCount as number,
    archives,
  }
}

function assertArchivePath(path: string): void {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`desktop seed: unsafe pnpm store archive path ${JSON.stringify(path)}`)
  }
}

/**
 * Remove pnpm's registrations for projects that populated the seed store.
 * @param storeRoot - pnpm store directory included in the desktop seed.
 */
export function removePnpmProjectRegistrations(storeRoot: string): void {
  for (const entry of readdirSync(storeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^v\d+$/u.test(entry.name)) continue
    rmSync(join(storeRoot, entry.name, 'projects'), { recursive: true, force: true })
  }
}

function mergeStoreIndex(source: string, destination: string): void {
  if (!existsSync(destination)) {
    copyFileSync(source, destination)
    return
  }
  const database = new DatabaseSync(destination)
  let attached = false
  try {
    database.exec('PRAGMA busy_timeout=5000')
    database.prepare('ATTACH DATABASE ? AS seed').run(source)
    attached = true
    database.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      database.exec('INSERT OR REPLACE INTO package_index (key, data) SELECT key, data FROM seed.package_index')
      database.exec('COMMIT')
      committed = true
    } finally {
      if (!committed) database.exec('ROLLBACK')
    }
  } finally {
    if (attached) database.exec('DETACH DATABASE seed')
    database.close()
  }
}

/**
 * Merge a completely extracted seed store into Desktop's persistent pnpm store.
 * @param source - Verified temporary store extraction.
 * @param destination - Desktop-owned persistent pnpm store.
 */
export function mergePnpmStore(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const indexPaths = readdirSync(source, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && STORE_VERSION_PATTERN.test(entry.name)
      && existsSync(join(source, entry.name, 'index.db')))
    .map(entry => `${entry.name}/index.db`)
  const indexes = new Set(indexPaths)
  cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: path => !indexes.has(relative(source, path).split(sep).join('/')),
  })
  for (const path of indexPaths) {
    mergeStoreIndex(join(source, ...path.split('/')), join(destination, ...path.split('/')))
  }
}

/**
 * Replace a prepared loose pnpm store with deterministic uncompressed archive shards.
 * @param seedRoot - seed directory that owns the archive output.
 * @param storeRoot - populated pnpm store to archive and remove after success.
 * @param shardCount - stable shard count used to limit update churn.
 */
export function archivePnpmStore(
  seedRoot: string,
  storeRoot: string,
  shardCount = DEFAULT_SHARD_COUNT,
): void {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 256) {
    throw new Error(`desktop seed: invalid pnpm store shard count ${shardCount}`)
  }
  const archiveRoot = join(seedRoot, SEED_STORE_ARCHIVE_DIR)
  const manifestPath = join(seedRoot, SEED_STORE_ARCHIVE_MANIFEST)
  rmSync(archiveRoot, { recursive: true, force: true })
  rmSync(manifestPath, { force: true })
  mkdirSync(archiveRoot, { recursive: true })
  const shards = Array.from({ length: shardCount }, (): string[] => [])
  for (const path of storeFiles(storeRoot)) (shards[shardFor(path, shardCount)] as string[]).push(path)
  const archives: SeedStoreArchiveRecord[] = []
  for (const [index, paths] of shards.entries()) {
    if (paths.length === 0) continue
    const file = `store-${index.toString(16).padStart(2, '0')}.tar`
    create({
      cwd: storeRoot,
      file: join(archiveRoot, file),
      noDirRecurse: true,
      noMtime: true,
      portable: true,
      sync: true,
    }, paths)
    chmodSync(join(archiveRoot, file), 0o644)
    archives.push({ file, entries: paths.length })
  }
  if (archives.length === 0) throw new Error('desktop seed: pnpm store is empty')
  writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, shardCount, archives }, undefined, 2)}\n`)
  rmSync(storeRoot, { recursive: true })
}

/**
 * Validate and extract a packaged pnpm store archive set into an empty directory.
 * @param seedRoot - verified packaged seed directory.
 * @param destination - empty Desktop-owned temporary extraction directory.
 */
export function extractPnpmStoreArchives(seedRoot: string, destination: string): void {
  const manifest = readArchiveManifest(seedRoot)
  const archiveRoot = join(seedRoot, SEED_STORE_ARCHIVE_DIR)
  const actualFiles = readdirSync(archiveRoot, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`desktop seed: invalid pnpm store archive entry ${entry.name}`)
    }
    return entry.name
  }).sort()
  const expectedFiles = manifest.archives.map(archive => archive.file).sort()
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('desktop seed: pnpm store archive set does not match its manifest')
  }
  if (existsSync(destination) && readdirSync(destination).length !== 0) {
    throw new Error(`desktop seed: pnpm store extraction directory is not empty: ${destination}`)
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const paths = new Set<string>()
  for (const archive of manifest.archives) {
    const archivePath = join(archiveRoot, archive.file)
    const archiveShard = Number.parseInt(archive.file.slice('store-'.length, -'.tar'.length), 16)
    let entries = 0
    list({
      file: archivePath,
      onReadEntry: (entry) => {
        if (entry.type !== 'File' && entry.type !== 'OldFile') {
          throw new Error(`desktop seed: unsupported pnpm store archive entry type ${entry.type}`)
        }
        assertArchivePath(entry.path)
        if (shardFor(entry.path, manifest.shardCount) !== archiveShard) {
          throw new Error(`desktop seed: pnpm store path is assigned to the wrong archive shard: ${entry.path}`)
        }
        if (paths.has(entry.path)) {
          throw new Error(`desktop seed: duplicate pnpm store archive path ${entry.path}`)
        }
        paths.add(entry.path)
        entries += 1
      },
      strict: true,
      sync: true,
    })
    if (entries !== archive.entries) {
      throw new Error(`desktop seed: pnpm store archive ${archive.file} has an unexpected entry count`)
    }
  }
  for (const archive of manifest.archives) {
    extract({
      chmod: true,
      cwd: destination,
      file: join(archiveRoot, archive.file),
      noMtime: true,
      preservePaths: false,
      processUmask: 0,
      strict: true,
      sync: true,
    })
  }
}
