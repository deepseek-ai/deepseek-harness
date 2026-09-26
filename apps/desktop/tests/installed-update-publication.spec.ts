import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInstalledUpdateRun } from '../scripts/installed-update-qualification.ts'
import { planInstalledUpdateDistribution } from '../scripts/installed-update-distribution.ts'
import { installedUpdateFileHash } from '../scripts/installed-update-signature.mjs'
import { executeInstalledUpdatePublication, verifiedInstalledUpdateDistribution,
  type InstalledUpdatePublicationStore } from '../scripts/installed-update-publication.ts'

const digest = (bytes: Buffer) => ({ sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length })
afterEach(() => { vi.restoreAllMocks() })

class Store implements InstalledUpdatePublicationStore {
  readonly objects = new Map<string, Buffer>()
  readonly writes: { key: string; immutable: boolean }[] = []
  disabled = true
  failure: 'none' | 'write' | 'public' = 'none'
  async versioningDisabled() { return this.disabled }
  async read(key: string) { const value = this.objects.get(key); return value === undefined ? null : digest(value) }
  async publicRead(url: string) {
    if (this.failure === 'public') return digest(Buffer.from('stale public bytes'))
    expect(url).not.toContain('?')
    return this.read(new URL(url).pathname.slice(1))
  }
  async put(key: string, object: Parameters<InstalledUpdatePublicationStore['put']>[1]) {
    this.writes.push({ key, immutable: object.forbidOverwrite })
    if (this.failure === 'write') throw Object.assign(new Error('fixture-secret-must-not-be-recorded'), { statusCode: 503 })
    if (object.forbidOverwrite && this.objects.has(key)) throw new Error('object exists')
    const bytes = 'path' in object.source ? await readFile(object.source.path) : Buffer.from(object.source.contents)
    expect(digest(bytes)).toEqual({ sha512: object.sha512, size: object.size })
    this.objects.set(key, bytes)
    return { requestId: 'fixture-request' }
  }
}

async function fixture(body: (context: {
  manifest: string
  versions: readonly [string, string]
  receipts: string[]
  journals: string
  store: Store
}) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-publication-'))
  try {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const run = await createInstalledUpdateRun(parent, ['0.1.6-nightly.20260914.1', '0.1.6-nightly.20260914.2'],
      { version: '0.1.5-rc.2', commit: 'a'.repeat(40), dirtyFiles: [] })
    const manifest = join(run.root, 'run.json')
    const receipts: string[] = []
    for (const version of run.versions) {
      const directory = join(run.root, version, 'installer')
      await mkdir(directory, { recursive: true })
      const name = `deepseek-harness-${version}-win-x64.exe`
      const bytes = Buffer.from(`inert installer ${version}`)
      await writeFile(join(directory, name), bytes)
      await writeFile(join(directory, `${name}.blockmap`), 'inert map')
      await writeFile(join(directory, 'nightly.yml'), JSON.stringify({ version, files: [{ url: name, ...digest(bytes) }] }))
      const check = join(run.root, version, 'verification/check-fixture')
      await mkdir(check, { recursive: true })
      const receipt = join(check, 'result.json')
      const distribution = await planInstalledUpdateDistribution(manifest, version)
      await writeFile(receipt, JSON.stringify({ schemaVersion: 1, runId: run.id, version, passed: true, stage: 'complete',
        contents: { appId: run.appId, version }, installerSignature: { valid: true, timestamped: true,
          updaterVerificationInvoked: true, sha512: digest(bytes).sha512 } }))
      await writeFile(join(check, 'inputs.json'), JSON.stringify({ manifestSha512: await installedUpdateFileHash(manifest), distribution }))
      receipts.push(receipt)
    }
    const journals = join(parent, 'dsh-update-qualification', run.id, 'journals')
    await mkdir(journals, { recursive: true })
    const time = new Date(Date.now() - 60_000).toISOString()
    await writeFile(join(journals, '1-00000000-0000-0000-0000-000000000000.jsonl'), ['started', 'workspace-ready']
      .map((event, sequence) => JSON.stringify({ schemaVersion: 1, pid: 1, version: run.versions[0], event, sequence, time })).join('\n') + '\n')
    await body({ manifest, versions: run.versions, receipts, journals, store: new Store() })
  } finally { await rm(parent, { recursive: true, force: true }) }
}

describe('qualification publication sequencing', () => {
  it('uploads without advertising, publishes version 1, then requires version 1 startup before publishing version 2', async () => {
    await fixture(async ({ manifest, versions, receipts, journals, store }) => {
      for (const [index, version] of versions.entries()) {
        await executeInstalledUpdatePublication(manifest, version, receipts[index]!, 'upload-binaries', store)
      }
      expect(store.writes).toHaveLength(4)
      expect(store.writes.every(write => write.immutable && write.key.includes('/bin/'))).toBe(true)
      expect([...store.objects.keys()].some(key => key.endsWith('nightly.yml'))).toBe(false)
      const reads = vi.spyOn(store, 'read')
      const publicReads = vi.spyOn(store, 'publicRead')
      const versioning = vi.spyOn(store, 'versioningDisabled')
      await executeInstalledUpdatePublication(manifest, versions[0], receipts[0]!, 'publish-feed', store)
      const result = await executeInstalledUpdatePublication(manifest, versions[1], receipts[1]!, 'publish-feed', store, journals)
      expect(store.writes.slice(-2).map(write => write.immutable)).toEqual([true, false])
      expect(store.writes.at(-1)!.key).toBe(store.writes.at(-2)!.key)
      expect(JSON.parse(await readFile(result, 'utf8'))).toMatchObject({ success: true, action: 'publish-feed', startup: { sequence: 1 } })
      const reconciled = await executeInstalledUpdatePublication(manifest, versions[1], receipts[1]!, 'publish-feed', store, journals)
      expect(store.writes).toHaveLength(6)
      expect(JSON.parse(await readFile(reconciled, 'utf8'))).toMatchObject({ success: true, alreadyPublished: true })
      expect(reads.mock.calls.every(([key]) => key.endsWith('nightly.yml'))).toBe(true)
      expect(publicReads.mock.calls.every(([url]) => url.endsWith('nightly.yml'))).toBe(true)
      expect(versioning).not.toHaveBeenCalled()
      const publication = JSON.parse(await readFile(result, 'utf8')) as { binaryUploadReceipt: { sha512: string } }
      expect(publication.binaryUploadReceipt.sha512).toBeTypeOf('string')
      expect(await readdir(join(manifest, '..'))).not.toContain('publication.lock')
    })
  })

  it('rechecks matching immutable objects on a separately requested upload without rewriting them', async () => {
    await fixture(async ({ manifest, versions, receipts, store }) => {
      await executeInstalledUpdatePublication(manifest, versions[0], receipts[0]!, 'upload-binaries', store)
      await executeInstalledUpdatePublication(manifest, versions[0], receipts[0]!, 'upload-binaries', store)
      expect(store.writes).toHaveLength(2)
    })
  })

  it.each(['failed', 'wrong-version', 'different-plan'])('refuses a %s upload receipt without reading binaries', async (failure) => {
    await fixture(async ({ manifest, versions, receipts, store }) => {
      const resultPath = await executeInstalledUpdatePublication(manifest, versions[0], receipts[0]!, 'upload-binaries', store)
      if (failure === 'different-plan') {
        await writeFile(join(resultPath, '../plan.json'), '{}')
      } else {
        const result = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>
        if (failure === 'failed') result.success = false
        else result.version = versions[1]
        await writeFile(resultPath, JSON.stringify(result))
      }
      const read = vi.spyOn(store, 'read')
      const publicRead = vi.spyOn(store, 'publicRead')
      store.writes.length = 0
      await expect(executeInstalledUpdatePublication(manifest, versions[0], receipts[0]!, 'publish-feed', store)).rejects.toThrow('publication stopped')
      expect(read).not.toHaveBeenCalled()
      expect(publicRead).not.toHaveBeenCalled()
      expect(store.writes).toHaveLength(0)
    })
  })

  it.each(['versioning', 'existing-object', 'write', 'public', 'missing-binary', 'wrong-feed'])(
    'stops on %s and retains a failed operation without leaking adapter errors', async (failure) => {
      await fixture(async ({ manifest, versions, receipts, store }) => {
        const { distribution } = await verifiedInstalledUpdateDistribution(manifest, versions[0], receipts[0]!)
        if (failure === 'versioning') store.disabled = false
        if (failure === 'existing-object') store.objects.set(distribution.binaries[0]!.key, Buffer.from('foreign'))
        if (failure === 'write' || failure === 'public') store.failure = failure
        if (failure === 'wrong-feed') {
          await executeInstalledUpdatePublication(manifest, versions[0], receipts[0]!, 'upload-binaries', store)
          store.writes.length = 0
          store.objects.set(distribution.feed.key, Buffer.from('foreign feed'))
        }
        const action = ['missing-binary', 'wrong-feed'].includes(failure) ? 'publish-feed' : 'upload-binaries'
        await expect(executeInstalledUpdatePublication(manifest, versions[0], receipts[0]!, action, store)).rejects.toThrow('publication stopped')
        expect(store.writes).toHaveLength(['write', 'public'].includes(failure) ? 1 : 0)
        const records = join(manifest, '../publication-records')
        const paths = await readdir(records)
        const results = await Promise.all(paths.map(path => readFile(join(records, path, 'result.json'), 'utf8')))
        const record = results.find(value => (JSON.parse(value) as { success: unknown }).success === false)!
        expect(JSON.parse(record)).toMatchObject({ success: false })
        if (failure === 'write') expect(JSON.parse(record)).toMatchObject({ httpStatus: 503 })
        expect(record).not.toContain('fixture-secret')
        expect(await readdir(join(manifest, '..'))).not.toContain('publication.lock')
      })
    })

  it.each(['missing-journal', 'wrong-journal-directory', 'changed-binary', 'failed-receipt', 'lock'])(
    'rejects %s before remote writes', async (failure) => {
      await fixture(async ({ manifest, versions, receipts, journals, store }) => {
        if (failure === 'missing-journal') await rm(journals, { recursive: true })
        if (failure === 'wrong-journal-directory') journals = join(journals, '..')
        if (failure === 'changed-binary') {
          const plan = await planInstalledUpdateDistribution(manifest, versions[1])
          await writeFile(plan.binaries[0]!.path, 'changed')
        }
        if (failure === 'failed-receipt') await writeFile(receipts[1]!, '{"passed":false}')
        if (failure === 'lock') await mkdir(join(manifest, '../publication.lock'))
        await expect(executeInstalledUpdatePublication(manifest, versions[1], receipts[1]!, 'publish-feed', store, journals)).rejects.toThrow()
        expect(store.writes).toHaveLength(0)
        if (failure === 'lock') expect(await readdir(join(manifest, '..'))).toContain('publication.lock')
      })
    })
})
