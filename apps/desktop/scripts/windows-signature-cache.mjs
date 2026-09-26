/** Cache complete signed files; corrupt entries stop the caller before hardware access. */
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, toNamespacedPath } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * Include public certificate and every file that controls signing output in the policy identity.
 * @param {readonly string[]} files Certificate, SignTool, signing script and signer implementation paths, in fixed order.
 * @returns {Promise<string>} Content identity independent of installation paths and PIN values.
 */
export async function signatureCacheIdentity(files) {
  return digest(JSON.stringify(await Promise.all(files.map(async path => digest(await regularFile(path))))))
}

async function regularFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`signature cache: expected regular file: ${path}`)
  return readFile(path)
}

async function directory(path) {
  const stat = await lstat(path)
  const normalize = value => process.platform === 'win32' ? toNamespacedPath(resolve(value)).toLowerCase() : resolve(value)
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(await realpath(path)) !== normalize(path)) {
    throw new Error(`signature cache: expected unlinked directory: ${path}`)
  }
}

function validSignature(signature, thumbprint) {
  return signature.status === 'Valid' && signature.timestamped
    && signature.thumbprint?.toUpperCase() === thumbprint.toUpperCase()
}

async function readCacheEntry(entry, key) {
  await directory(entry)
  const record = JSON.parse((await regularFile(join(entry, 'record.json'))).toString('utf8'))
  if (record === null || typeof record !== 'object' || record.version !== 1 || record.key !== key
    || typeof record.inputDigest !== 'string' || !/^[a-f\d]{64}$/u.test(record.inputDigest)
    || typeof record.identity !== 'string' || typeof record.signedDigest !== 'string'
    || !/^[a-f\d]{64}$/u.test(record.signedDigest)
    || digest(JSON.stringify({ version: 1, inputDigest: record.inputDigest, identity: record.identity })) !== key) {
    throw new Error('signature cache: invalid input record')
  }
  if (digest(await regularFile(join(entry, 'payload'))) !== record.signedDigest) throw new Error('signature cache: corrupt signed payload')
  return record
}

/**
 * Import complete integrity-checked entries while the caller holds the signing-stage lock.
 * @param {import('./windows-signature-cache.mjs').SignatureCacheMigrationOptions} options Validated source, private destination and audit sink.
 * @returns {Promise<{published: number, retained: number, skipped: number}>} Counts; existing valid entries win even when timestamp bytes differ. Trust is rechecked at actual use.
 */
export async function migrateSignatureCache(options) {
  if (resolve(options.source).toLowerCase() === resolve(options.root).toLowerCase()) throw new Error('signature cache: migration source equals destination')
  await directory(options.source)
  await mkdir(options.root, { recursive: true })
  await directory(options.root)
  const counts = { published: 0, retained: 0, skipped: 0 }
  for (const key of await readdir(options.source)) {
    if (!/^[a-f\d]{64}$/u.test(key)) {
      counts.skipped++
      options.record({ type: 'signature-cache-migration-skipped', reason: 'not-complete-entry-name' })
      continue
    }
    const source = join(options.source, key)
    await readCacheEntry(source, key)
    const target = join(options.root, key)
    let exists = false
    try { await lstat(target); exists = true }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (exists) {
      await readCacheEntry(target, key)
      counts.retained++
      continue
    }
    const staging = await mkdtemp(toNamespacedPath(join(options.root, '.publish-')))
    try {
      await copyFile(join(source, 'record.json'), join(staging, 'record.json'))
      await copyFile(join(source, 'payload'), join(staging, 'payload'))
      await readCacheEntry(staging, key)
      await rename(staging, target)
      counts.published++
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  return counts
}

/**
 * Count or explicitly clear complete entries while the caller holds the signing-stage lock.
 * @param {string} root Validated, current-account cache directory.
 * @param {boolean} clear Retire each complete entry atomically before removing its two regular files.
 * @returns {Promise<{entries: number, bytes: number, incomplete: number}>} Complete-entry size and count; incomplete entries are left untouched.
 */
export async function maintainSignatureCache(root, clear = false) {
  await directory(root)
  let entries = 0
  let bytes = 0
  let incomplete = 0
  for (const name of await readdir(root)) {
    if (!/^[a-f\d]{64}$/u.test(name)) { incomplete++; continue }
    const entry = join(root, name)
    await directory(entry)
    const files = await readdir(entry)
    if (files.length !== 2 || !files.includes('record.json') || !files.includes('payload')) {
      throw new Error('signature cache: unexpected files prevent cache maintenance')
    }
    for (const file of files) {
      const stat = await lstat(join(entry, file))
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('signature cache: expected a regular entry file')
      bytes += stat.size
    }
    if (clear) {
      const retired = join(root, `.clear-${randomUUID()}`)
      await rename(entry, retired)
      for (const file of files) await unlink(join(retired, file))
      await rmdir(retired)
    }
    entries++
  }
  return { entries, bytes, incomplete }
}

/**
 * Wrap a supervised signer with immutable entries keyed by unsigned bytes and signing policy.
 * @param {import('./windows-signature-cache.mjs').WindowsSignatureCacheOptions} options Cache policy and existing supervised operations.
 * @returns {import('./windows-signature-cache.mjs').WindowsCachedSigner} Serial, fail-stop signer plus hardware-free restores; cache hits still verify trust and timestamp.
 */
export function createCachedSigner(options) {
  let pending = Promise.resolve()
  const statistics = { hits: 0, misses: 0, published: 0, retained: 0, signingCalls: 0, validationFailures: 0,
    verificationMs: 0, restoreMs: 0, signingMs: 0 }
  async function verify(path) {
    const start = performance.now()
    try {
      if (!validSignature(await options.inspect(path), options.thumbprint)) throw new Error('signature cache: invalid signature')
    } finally { statistics.verificationMs += performance.now() - start }
  }
  async function readEntry(entry, key, inputDigest) {
    const record = await readCacheEntry(entry, key)
    if (record.inputDigest !== inputDigest || record.identity !== options.identity) throw new Error('signature cache: invalid input record')
    return record
  }
  async function sign(configuration, restoreOnly = false) {
    if (configuration.hash !== 'sha256' || configuration.isNest) throw new Error('signature cache: only unsigned SHA-256 runtime files are supported')
    const inputDigest = digest(await regularFile(configuration.path))
    const key = digest(JSON.stringify({ version: 1, inputDigest, identity: options.identity }))
    await mkdir(options.root, { recursive: true })
    await directory(options.root)
    const entry = join(options.root, key)
    let hit = false
    try { await lstat(entry); hit = true }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (hit) {
      const start = performance.now()
      try {
        const record = await readEntry(entry, key, inputDigest)
        const staging = await mkdtemp(toNamespacedPath(join(dirname(configuration.path), '.signature-restore-')))
        try {
          const candidate = join(staging, basename(configuration.path))
          await copyFile(join(entry, 'payload'), candidate)
          if (digest(await regularFile(candidate)) !== record.signedDigest) throw new Error('signature cache: restore changed signed bytes')
          try { await verify(candidate) }
          catch (error) { throw new Error('signature cache: invalid cached signature', { cause: error }) }
          if (digest(await regularFile(configuration.path)) !== inputDigest) throw new Error('signature cache: target changed before restore')
          await rename(candidate, configuration.path)
        } finally { await rm(staging, { recursive: true, force: true }) }
      } catch (error) {
        statistics.validationFailures++
        options.record({ type: 'signature-cache-validation-failed', key, path: configuration.path })
        throw error
      } finally { statistics.restoreMs += performance.now() - start }
      statistics.hits++
      options.record({ type: 'signature-cache-hit', key, path: configuration.path })
      return true
    }
    if (restoreOnly) return false
    statistics.misses++
    options.record({ type: 'signature-cache-miss', key, path: configuration.path })
    const start = performance.now()
    statistics.signingCalls++
    try { await options.sign(configuration) }
    finally { statistics.signingMs += performance.now() - start }
    try { await verify(configuration.path) }
    catch (error) {
      statistics.validationFailures++
      options.record({ type: 'signature-cache-validation-failed', key, path: configuration.path })
      throw new Error('signature cache: new signature verification failed', { cause: error })
    }
    const staging = await mkdtemp(toNamespacedPath(join(options.root, '.publish-')))
    try {
      await copyFile(configuration.path, join(staging, 'payload'))
      const signedDigest = digest(await regularFile(join(staging, 'payload')))
      if (signedDigest !== digest(await regularFile(configuration.path))) throw new Error('signature cache: signed file changed during publication')
      await writeFile(join(staging, 'record.json'), JSON.stringify({ version: 1, key, inputDigest, identity: options.identity, signedDigest }), { flag: 'wx', flush: true })
      let published = false
      try { await rename(staging, entry); published = true }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
        try { await readEntry(entry, key, inputDigest) }
        catch (validationError) {
          statistics.validationFailures++
          options.record({ type: 'signature-cache-validation-failed', key, path: configuration.path })
          throw validationError
        }
      }
      if (published) statistics.published++
      else statistics.retained++
      options.record({ type: published ? 'signature-cache-published' : 'signature-cache-retained', key, path: configuration.path })
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  const signer = configuration => {
    pending = pending.then(async () => { await sign(configuration) })
    return pending
  }
  signer.restore = configuration => sign(configuration, true)
  signer.summary = () => ({ root: options.root, identity: options.identity, ...statistics, avoidedSigningCalls: statistics.hits })
  return signer
}
