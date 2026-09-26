/** Fault checks for the exploratory cache; these never call signing hardware. */
import { it as test, type TestContext } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createCachedSigner, maintainSignatureCache, migrateSignatureCache, signatureCacheIdentity } from '../scripts/windows-signature-cache.mjs'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(import.meta.dirname, 'cache-test-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'module.node')
  await writeFile(path, 'original')
  const cache = join(root, 'cache')
  const state = { hardwareCalls: 0, events: [] as object[] }
  const thumbprint = 'A'.repeat(40)
  const options: import('../scripts/windows-signature-cache.mjs').WindowsSignatureCacheOptions = {
    root: cache, identity: 'test-policy', thumbprint,
    sign: async ({ path }) => { state.hardwareCalls++; await writeFile(path, `signed:${await readFile(path, 'utf8')}`) },
    inspect: async path => ({ status: (await readFile(path, 'utf8')).startsWith('signed:') ? 'Valid' : 'NotSigned', timestamped: true, thumbprint }),
    record: event => state.events.push(event),
  }
  const request = { path, hash: 'sha256', isNest: false }
  return { root, path, cache, state, options, request }
}

test('restore misses leave inputs and hardware untouched, then share a cached payload across targets', async (t) => {
  const f = await fixture(t)
  const signer = createCachedSigner(f.options)
  assert.equal(await signer.restore(f.request), false)
  assert.equal(f.state.hardwareCalls, 0)
  assert.equal(signer.summary().misses, 0)
  assert.equal(await readFile(f.path, 'utf8'), 'original')
  await signer(f.request)
  const targets = [join(f.root, 'first.node'), join(f.root, 'second.node')]
  await Promise.all(targets.map(path => writeFile(path, 'original')))
  assert.deepEqual(await Promise.all(targets.map(path => signer.restore({ ...f.request, path }))), [true, true])
  assert.deepEqual(await Promise.all(targets.map(path => readFile(path, 'utf8'))), ['signed:original', 'signed:original'])
  assert.equal(f.state.hardwareCalls, 1)
  assert.equal(signer.summary().hits, 2)
})

test('unchanged bytes restored in another file avoid another hardware call', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  const second = join(f.root, 'other.node')
  await writeFile(second, 'original')
  await createCachedSigner(f.options)({ ...f.request, path: second })
  assert.equal(f.state.hardwareCalls, 1)
  assert.equal(await readFile(second, 'utf8'), 'signed:original')
  assert.equal(f.state.events.filter(e => 'type' in e && e.type === 'signature-cache-hit').length, 1)
})

test('cache summaries distinguish avoided signatures from actual signing attempts', async (t) => {
  const f = await fixture(t)
  const signer = createCachedSigner(f.options)
  await signer(f.request)
  await writeFile(f.path, 'original')
  await signer(f.request)
  const { verificationMs, restoreMs, signingMs, ...summary } = signer.summary()
  assert.deepEqual(summary, { root: f.cache, identity: f.options.identity, hits: 1, misses: 1,
    published: 1, retained: 0, signingCalls: 1, avoidedSigningCalls: 1, validationFailures: 0 })
  assert(verificationMs >= 0 && restoreMs >= 0 && signingMs >= 0)
  assert.equal(f.state.hardwareCalls, summary.signingCalls)
  assert.equal(await readFile(f.path, 'utf8'), 'signed:original')
})

test('restores cached signatures into deeply nested dependency paths', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  const directory = join(f.root, 'dependency'.repeat(12))
  await mkdir(directory)
  const path = join(directory, 'module.node')
  await writeFile(path, 'original')
  await createCachedSigner(f.options)({ ...f.request, path })
  assert.equal(await readFile(path, 'utf8'), 'signed:original')
  assert.equal(f.state.hardwareCalls, 1)
  assert.deepEqual(await readdir(directory), ['module.node'])
})

test('different content or signing policy misses the cache', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  await writeFile(f.path, 'changed')
  await createCachedSigner(f.options)(f.request)
  await writeFile(f.path, 'original')
  await createCachedSigner({ ...f.options, identity: 'changed-policy' })(f.request)
  assert.equal(f.state.hardwareCalls, 3)
})

for (const restoreOnly of [false, true]) for (const corrupt of ['payload', 'record.json']) test(`corrupt ${corrupt} stops without signing or replacing the input (restore-only: ${restoreOnly})`, async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  await writeFile(f.path, 'original')
  const entry = (await readdir(f.cache)).find(name => !name.startsWith('.'))
  assert(entry)
  await writeFile(join(f.cache, entry, corrupt), 'corrupt')
  const signer = createCachedSigner(f.options)
  await assert.rejects(restoreOnly ? signer.restore(f.request) : signer(f.request))
  assert.equal(signer.summary().validationFailures, 1)
  assert.equal(signer.summary().avoidedSigningCalls, 0)
  assert.equal(f.state.hardwareCalls, 1)
  assert.equal(await readFile(f.path, 'utf8'), 'original')
})

for (const signature of [
  { status: 'NotTrusted', timestamped: true, thumbprint: 'A'.repeat(40) },
  { status: 'Valid', timestamped: false, thumbprint: 'A'.repeat(40) },
  { status: 'Valid', timestamped: true, thumbprint: 'B'.repeat(40) },
]) test(`cache refuses signature ${JSON.stringify(signature)}`, async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  await writeFile(f.path, 'original')
  await assert.rejects(createCachedSigner({ ...f.options, inspect: async () => signature })(f.request), /invalid cached signature/u)
  assert.equal(f.state.hardwareCalls, 1)
  assert.equal(await readFile(f.path, 'utf8'), 'original')
})

test('hardware failure rejects queued work without publishing an entry or retrying', async (t) => {
  const f = await fixture(t)
  const signer = createCachedSigner({ ...f.options, sign: async () => { f.state.hardwareCalls++; throw new Error('hardware failed') } })
  const results = await Promise.allSettled([signer(f.request), signer(f.request)])
  assert(results.every(result => result.status === 'rejected'))
  assert.equal(f.state.hardwareCalls, 1)
  assert.deepEqual(await readdir(f.cache), [])
  assert.equal(signer.summary().signingCalls, 1)
  assert.equal(signer.summary().validationFailures, 0)
})

test('a failed new signature verification never publishes a cache entry', async (t) => {
  const f = await fixture(t)
  await assert.rejects(createCachedSigner({ ...f.options, inspect: async () => ({ status: 'NotTrusted', timestamped: false, thumbprint: null }) })(f.request), /new signature verification failed/u)
  assert.deepEqual(await readdir(f.cache), [])
})

test('an incomplete entry is rejected without hardware access', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  const entry = (await readdir(f.cache))[0]
  assert(entry)
  await rm(join(f.cache, entry, 'record.json'))
  await writeFile(f.path, 'original')
  await assert.rejects(createCachedSigner(f.options)(f.request))
  assert.equal(f.state.hardwareCalls, 1)
})

test('certificate and toolchain content invalidate policy identity independently of paths', async (t) => {
  const f = await fixture(t)
  const certificate = join(f.root, 'certificate.cer')
  const command = join(f.root, 'sign.cmd')
  await writeFile(certificate, 'certificate A')
  await writeFile(command, 'signing policy A')
  const first = await signatureCacheIdentity([certificate, command])
  const relocated = join(f.root, 'relocated.cer')
  await writeFile(relocated, 'certificate A')
  assert.equal(await signatureCacheIdentity([relocated, command]), first)
  await writeFile(certificate, 'certificate B')
  assert.notEqual(await signatureCacheIdentity([certificate, command]), first)
  await writeFile(command, 'signing policy B')
  assert.notEqual(await signatureCacheIdentity([relocated, command]), first)
})

test('two writers publish one complete entry without overwriting another writer', async (t) => {
  const f = await fixture(t)
  const second = join(f.root, 'second.node')
  await writeFile(second, 'original')
  const entered = Promise.withResolvers<undefined>()
  let arrivals = 0
  const options: import('../scripts/windows-signature-cache.mjs').WindowsSignatureCacheOptions = { ...f.options, sign: async (request) => {
    if (++arrivals === 2) entered.resolve(undefined)
    await entered.promise
    await f.options.sign(request)
  } }
  const results = await Promise.allSettled([
    createCachedSigner(options)(f.request),
    createCachedSigner(options)({ ...f.request, path: second }),
  ])
  for (const result of results) if (result.status === 'rejected') throw result.reason
  assert.equal(f.state.events.filter(e => 'type' in e && e.type === 'signature-cache-published').length, 1)
  assert.equal(f.state.events.filter(e => 'type' in e && e.type === 'signature-cache-retained').length, 1)
  assert.equal((await readdir(f.cache)).length, 1)
  await writeFile(f.path, 'original')
  await createCachedSigner(f.options)(f.request)
  assert.equal(f.state.hardwareCalls, 2)
  assert.equal(await readFile(f.path, 'utf8'), 'signed:original')
})

test('linked cache directories cannot redirect cache restoration', async (t) => {
  const f = await fixture(t)
  const elsewhere = join(f.root, 'elsewhere')
  await mkdir(elsewhere)
  await symlink(elsewhere, f.cache, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createCachedSigner(f.options)(f.request), /unlinked directory/u)
  assert.equal(f.state.hardwareCalls, 0)
})

test('a target changed during verification is never replaced with stale cache bytes', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  await writeFile(f.path, 'original')
  const inspect = async (candidate: string) => { await writeFile(f.path, 'new input'); return f.options.inspect(candidate) }
  await assert.rejects(createCachedSigner({ ...f.options, inspect })(f.request), /target changed/u)
  assert.equal(await readFile(f.path, 'utf8'), 'new input')
  assert.equal(f.state.hardwareCalls, 1)
  assert(!(await readdir(f.root)).some(name => name.startsWith('.signature-restore-')))
})

test('migration preserves different valid timestamp bytes at the same destination key', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  const destination = join(f.root, 'shared')
  await writeFile(f.path, 'original')
  await createCachedSigner({ ...f.options, root: destination,
    sign: async ({ path }) => writeFile(path, 'signed:original:another-timestamp'),
  })(f.request)
  const key = (await readdir(f.cache))[0]!
  const sourceRecord = await readFile(join(f.cache, key, 'record.json'), 'utf8')
  const counts = await migrateSignatureCache({ source: f.cache, root: destination, record: () => {} })
  assert.deepEqual(counts, { published: 0, retained: 1, skipped: 0 })
  assert.equal(await readFile(join(destination, key, 'payload'), 'utf8'), 'signed:original:another-timestamp')
  assert.equal(await readFile(join(f.cache, key, 'record.json'), 'utf8'), sourceRecord)
})

test('migration copies complete entries and skips staging directories without reading them', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  await mkdir(join(f.cache, '.publish-incomplete'))
  const destination = join(f.root, 'shared')
  assert.deepEqual(await migrateSignatureCache({ source: f.cache, root: destination, record: () => {} }),
    { published: 1, retained: 0, skipped: 1 })
  await writeFile(f.path, 'original')
  await createCachedSigner({ ...f.options, root: destination })(f.request)
  assert.equal(f.state.hardwareCalls, 1)
  assert.equal(await readFile(f.path, 'utf8'), 'signed:original')
  assert.equal((await readdir(destination)).length, 1)
})

test('migration refuses a corrupt existing destination instead of replacing it', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  const destination = join(f.root, 'shared')
  await migrateSignatureCache({ source: f.cache, root: destination, record: () => {} })
  const key = (await readdir(destination))[0]!
  await writeFile(join(destination, key, 'payload'), 'corrupt')
  await assert.rejects(migrateSignatureCache({ source: f.cache, root: destination, record: () => {} }), /corrupt/u)
  assert.equal(await readFile(join(destination, key, 'payload'), 'utf8'), 'corrupt')
})

test('maintenance counts and clears complete entries while preserving incomplete staging', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  await mkdir(join(f.cache, '.publish-incomplete'))
  const usage = await maintainSignatureCache(f.cache)
  assert.equal(usage.entries, 1)
  assert(usage.bytes > 0)
  assert.equal(usage.incomplete, 1)
  assert.deepEqual(await maintainSignatureCache(f.cache, true), usage)
  assert.deepEqual(await readdir(f.cache), ['.publish-incomplete'])
  assert.equal(await readFile(f.path, 'utf8'), 'signed:original')
})

test('maintenance refuses unexpected entry contents without deleting them', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  const key = (await readdir(f.cache))[0]!
  const unexpected = join(f.cache, key, 'unrecognized')
  await writeFile(unexpected, 'keep')
  await assert.rejects(maintainSignatureCache(f.cache, true), /unexpected files/u)
  assert.equal(await readFile(unexpected, 'utf8'), 'keep')
})
