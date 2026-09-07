import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Packr } from 'msgpackr'
import { afterEach, describe, expect, it } from 'vitest'
import {
  signMacOSSeedStore,
  verifyMacOSSeedStore,
} from '../scripts/macos-seed-store.ts'

const temporaryRoots: string[] = []
const packr = new Packr({ moreTypes: true, useRecords: true })
const SIGNING_ENVIRONMENT = {
  signingIdentity: 'Example Company (TEAMID1234)',
  teamId: 'TEAMID1234',
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-seed-signing-test-'))
  temporaryRoots.push(root)
  return root
}

function casPath(store: string, body: Buffer, executable = false): { digest: string; path: string } {
  const digest = createHash('sha512').update(body).digest('hex')
  return {
    digest,
    path: join(store, 'v11', 'files', digest.slice(0, 2), `${digest.slice(2)}${executable ? '-exec' : ''}`),
  }
}

function createStoreFile(path: string, body: Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop macOS seed store signing', () => {
  it('rehashes signed Mach-O content, rewrites every package reference, and prunes native orphans', async () => {
    const store = temporaryRoot()
    const native = Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('native-code')])
    const nativeCas = casPath(store, native)
    createStoreFile(nativeCas.path, native)
    const orphan = Buffer.concat([Buffer.from('cafebabe', 'hex'), Buffer.from('orphan')])
    const orphanCas = casPath(store, orphan)
    createStoreFile(orphanCas.path, orphan)
    const plain = Buffer.from('plain package content')
    const plainCas = casPath(store, plain)
    createStoreFile(plainCas.path, plain)

    const database = new DatabaseSync(join(store, 'v11', 'index.db'))
    database.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID')
    const insert = database.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)')
    for (const key of ['package-a', 'package-b']) {
      insert.run(key, packr.pack({
        algo: 'sha512',
        files: new Map([
          ['native.node', { checkedAt: 1, digest: nativeCas.digest, mode: 0o644, size: native.length }],
          ['index.js', { checkedAt: 1, digest: plainCas.digest, mode: 0o644, size: plain.length }],
        ]),
        sideEffects: key === 'package-b'
          ? new Map([['build', { added: new Map([
            ['built/native.node', { checkedAt: 1, digest: nativeCas.digest, mode: 0o644, size: native.length }],
          ]) }]])
          : undefined,
      }))
    }
    database.close()

    const result = await signMacOSSeedStore(
      store,
      'com.example.desktop',
      SIGNING_ENVIRONMENT,
      {
        signer: async (path, identifier) => {
          expect(identifier).toBe(`com.example.desktop.seed.${nativeCas.digest.slice(0, 32)}`)
          appendFileSync(path, 'signed')
        },
      },
    )

    expect(result).toEqual({ signedFiles: 1, prunedOrphans: 1, updatedIndexRows: 2 })
    expect(existsSync(nativeCas.path)).toBe(false)
    expect(existsSync(orphanCas.path)).toBe(false)
    expect(readFileSync(plainCas.path)).toEqual(plain)

    const updated = new DatabaseSync(join(store, 'v11', 'index.db'), { readOnly: true })
    const digests = [...updated.prepare('SELECT data FROM package_index').iterate() as Iterable<{ data: Uint8Array }>]
      .flatMap((row) => {
        const record = packr.unpack(row.data) as {
          files: Map<string, { digest: string }>
          sideEffects?: Map<string, { added: Map<string, { digest: string }> }>
        }
        return [
          record.files.get('native.node')?.digest,
          ...[...(record.sideEffects?.values() ?? [])].map(effect => effect.added.get('built/native.node')?.digest),
        ].filter((digest): digest is string => digest !== undefined)
      })
    updated.close()
    expect(new Set(digests).size).toBe(1)
    expect(digests).toHaveLength(3)
    expect(digests[0]).not.toBe(nativeCas.digest)

    const verified: string[] = []
    expect(verifyMacOSSeedStore(store, SIGNING_ENVIRONMENT, (path) => { verified.push(path) })).toBe(1)
    expect(verified).toHaveLength(1)
  })

  it('bounds concurrent signing while allowing independent Mach-O files to overlap', async () => {
    const store = temporaryRoot()
    const files = new Map<string, { checkedAt: number; digest: string; mode: number; size: number }>()
    for (let index = 0; index < 6; index += 1) {
      const body = Buffer.concat([Buffer.from('feedfacf', 'hex'), Buffer.from(`native-${index}`)])
      const nativeCas = casPath(store, body)
      createStoreFile(nativeCas.path, body)
      files.set(`native-${index}.node`, {
        checkedAt: 1,
        digest: nativeCas.digest,
        mode: 0o644,
        size: body.length,
      })
    }
    const database = new DatabaseSync(join(store, 'v11', 'index.db'))
    database.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID')
    database.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)')
      .run('package', packr.pack({ algo: 'sha512', files }))
    database.close()

    let started = 0
    let active = 0
    let maximumActive = 0
    let releaseSigning = (): void => {}
    const signingReleased = new Promise<void>((resolve) => { releaseSigning = resolve })
    let markFirstWaveReady = (): void => {}
    const firstWaveReady = new Promise<void>((resolve) => { markFirstWaveReady = resolve })
    const signing = signMacOSSeedStore(store, 'com.example.desktop', SIGNING_ENVIRONMENT, {
      concurrency: 4,
      signer: async () => {
        started += 1
        active += 1
        maximumActive = Math.max(maximumActive, active)
        if (started === 4) markFirstWaveReady()
        try {
          await signingReleased
        } finally {
          active -= 1
        }
      },
    })

    await firstWaveReady
    expect({ started, active, maximumActive }).toEqual({ started: 4, active: 4, maximumActive: 4 })
    releaseSigning()
    await expect(signing).resolves.toMatchObject({ signedFiles: 6, updatedIndexRows: 1 })
    expect({ started, active, maximumActive }).toEqual({ started: 6, active: 0, maximumActive: 4 })
  })

  it('awaits active signers and preserves the store when one signer fails', async () => {
    const store = temporaryRoot()
    const originals: { digest: string; path: string }[] = []
    const files = new Map<string, { checkedAt: number; digest: string; mode: number; size: number }>()
    for (let index = 0; index < 2; index += 1) {
      const body = Buffer.concat([Buffer.from('feedfacf', 'hex'), Buffer.from(`native-${index}`)])
      const nativeCas = casPath(store, body)
      originals.push(nativeCas)
      createStoreFile(nativeCas.path, body)
      files.set(`native-${index}.node`, {
        checkedAt: 1,
        digest: nativeCas.digest,
        mode: 0o644,
        size: body.length,
      })
    }
    const databasePath = join(store, 'v11', 'index.db')
    const database = new DatabaseSync(databasePath)
    database.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID')
    database.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)')
      .run('package', packr.pack({ algo: 'sha512', files }))
    database.close()
    const originalIndex = readFileSync(databasePath)

    let started = 0
    let settled = 0
    let releaseSigning = (): void => {}
    const signingReleased = new Promise<void>((resolve) => { releaseSigning = resolve })
    let markBothReady = (): void => {}
    const bothReady = new Promise<void>((resolve) => { markBothReady = resolve })
    const signing = signMacOSSeedStore(store, 'com.example.desktop', SIGNING_ENVIRONMENT, {
      concurrency: 2,
      signer: async () => {
        started += 1
        const call = started
        if (started === 2) markBothReady()
        try {
          await signingReleased
          if (call === 1) throw new Error('signing failed')
        } finally {
          settled += 1
        }
      },
    })

    await bothReady
    releaseSigning()
    await expect(signing).rejects.toThrow(/signing failed/u)
    expect({ started, settled }).toEqual({ started: 2, settled: 2 })
    expect(readFileSync(databasePath)).toEqual(originalIndex)
    for (const original of originals) expect(existsSync(original.path)).toBe(true)
  })

  it('rejects an invalid signing worker bound before starting a signer', async () => {
    const store = temporaryRoot()
    mkdirSync(join(store, 'v11', 'files'), { recursive: true })
    await expect(signMacOSSeedStore(store, 'com.example.desktop', SIGNING_ENVIRONMENT, {
      concurrency: 0,
      signer: async () => {},
    })).rejects.toThrow(/positive integer/u)
  })

  it('propagates a signature-verification failure', () => {
    const store = temporaryRoot()
    const native = Buffer.concat([Buffer.from('feedfacf', 'hex'), Buffer.from('native-code')])
    const nativeCas = casPath(store, native)
    createStoreFile(nativeCas.path, native)

    expect(() => {
      verifyMacOSSeedStore(store, SIGNING_ENVIRONMENT, () => {
        throw new Error('invalid signature')
      })
    }).toThrow(/invalid signature/u)
  })
})
