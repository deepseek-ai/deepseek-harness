import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archivePnpmStore,
  extractPnpmStoreArchives,
  mergePnpmStore,
  removePnpmProjectRegistrations,
  SEED_STORE_ARCHIVE_DIR,
  SEED_STORE_ARCHIVE_MANIFEST,
} from '../src/seed-store.ts'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-store-'))
  temporaryRoots.push(root)
  return root
}

function archiveBytes(seed: string): readonly { path: string; body: Buffer }[] {
  return [SEED_STORE_ARCHIVE_MANIFEST, ...readdirSync(join(seed, SEED_STORE_ARCHIVE_DIR))]
    .map(path => ({
      path,
      body: readFileSync(path === SEED_STORE_ARCHIVE_MANIFEST
        ? join(seed, path)
        : join(seed, SEED_STORE_ARCHIVE_DIR, path)),
    }))
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop seed store cleanup', () => {
  it('removes project registrations without removing package data', () => {
    const storeRoot = temporaryRoot()
    mkdirSync(join(storeRoot, 'v11', 'projects', 'temporary-project'), { recursive: true })
    mkdirSync(join(storeRoot, 'v12', 'projects'), { recursive: true })
    mkdirSync(join(storeRoot, 'metadata', 'projects'), { recursive: true })
    writeFileSync(join(storeRoot, 'v11', 'package-data'), 'package')

    removePnpmProjectRegistrations(storeRoot)

    expect(existsSync(join(storeRoot, 'v11', 'projects'))).toBe(false)
    expect(existsSync(join(storeRoot, 'v12', 'projects'))).toBe(false)
    expect(existsSync(join(storeRoot, 'v11', 'package-data'))).toBe(true)
    expect(existsSync(join(storeRoot, 'metadata', 'projects'))).toBe(true)
  })
})

describe('desktop seed store merge', () => {
  it('preserves installed package records while the verified seed replaces matching records and files', () => {
    const root = temporaryRoot()
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    for (const store of [source, destination]) {
      mkdirSync(join(store, 'v11', 'files'), { recursive: true })
      const database = new DatabaseSync(join(store, 'v11', 'index.db'))
      database.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID')
      const insert = database.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)')
      if (store === source) {
        insert.run('seed-only', Buffer.from('seed'))
        insert.run('shared', Buffer.from('new'))
      } else {
        insert.run('plugin-only', Buffer.from('plugin'))
        insert.run('shared', Buffer.from('old'))
      }
      database.close()
    }
    writeFileSync(join(source, 'v11', 'files', 'shared'), 'new')
    writeFileSync(join(destination, 'v11', 'files', 'shared'), 'old')
    writeFileSync(join(destination, 'v11', 'files', 'plugin'), 'plugin')

    mergePnpmStore(source, destination)

    const database = new DatabaseSync(join(destination, 'v11', 'index.db'), { readOnly: true })
    const records = database.prepare('SELECT key, data FROM package_index ORDER BY key').all() as {
      key: string
      data: Uint8Array
    }[]
    database.close()
    expect(records.map(record => [record.key, Buffer.from(record.data).toString()])).toEqual([
      ['plugin-only', 'plugin'],
      ['seed-only', 'seed'],
      ['shared', 'new'],
    ])
    expect(readFileSync(join(destination, 'v11', 'files', 'shared'), 'utf8')).toBe('new')
    expect(readFileSync(join(destination, 'v11', 'files', 'plugin'), 'utf8')).toBe('plugin')
  })
})

describe('desktop seed store archives', () => {
  it('extracts package bytes and executable modes without retaining loose seed files', () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    const store = join(seed, 'store')
    const executable = join(store, 'v10', 'files', 'native-addon')
    mkdirSync(join(store, 'v10', 'files'), { recursive: true })
    writeFileSync(executable, 'native')
    chmodSync(executable, 0o755)
    writeFileSync(join(store, 'v10', 'files', 'package-data'), 'package')

    archivePnpmStore(seed, store)
    const destination = join(root, 'extracted')
    extractPnpmStoreArchives(seed, destination)

    expect(existsSync(store)).toBe(false)
    expect(readFileSync(join(destination, 'v10', 'files', 'package-data'), 'utf8')).toBe('package')
    if (process.platform !== 'win32') {
      expect(statSync(join(destination, 'v10', 'files', 'native-addon')).mode & 0o111).toBe(0o111)
    }
  })

  it('produces identical shards for identical paths, bytes, and modes', () => {
    const root = temporaryRoot()
    const seeds = [join(root, 'first'), join(root, 'second')]
    for (const [index, seed] of seeds.entries()) {
      const store = join(seed, 'store')
      mkdirSync(join(store, 'nested'), { recursive: true })
      const paths = index === 0 ? ['alpha', 'nested/beta'] : ['nested/beta', 'alpha']
      for (const path of paths) {
        const target = join(store, path)
        writeFileSync(target, path)
        utimesSync(target, new Date(index * 10_000), new Date(index * 20_000))
      }
      archivePnpmStore(seed, store)
    }

    const first = archiveBytes(seeds[0] as string)
    const second = archiveBytes(seeds[1] as string)
    expect(second.map(entry => entry.path)).toEqual(first.map(entry => entry.path))
    expect(second.map(entry => entry.body)).toEqual(first.map(entry => entry.body))
  })

  it('rejects an archive whose entry count differs from the manifest', () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    const store = join(seed, 'store')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'package-data'), 'package')
    archivePnpmStore(seed, store)
    const manifestPath = join(seed, SEED_STORE_ARCHIVE_MANIFEST)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      archives: { entries: number }[]
    }
    const archive = manifest.archives[0]
    if (archive === undefined) throw new Error('test seed has no archive')
    archive.entries += 1
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() => { extractPnpmStoreArchives(seed, join(root, 'extracted')) }).toThrow(/unexpected entry count/u)
  })
})
