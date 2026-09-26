/** Finish timestamps on isolated copies without repeating a verified private-key operation. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, cp, lstat, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { dirname, extname, join, toNamespacedPath } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'

async function digest(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Windows timestamp: expected a regular file')
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * Remove unsigned signature attributes on a private copy using the configured SignTool.
 * @param {string} path Previously verified, single-signature private copy.
 * @param {string} signTool Configured SignTool executable.
 * @param {NodeJS.ProcessEnv} environment Credential-free subprocess environment.
 * @returns {Promise<void>} Resolves after removal, or a warning that left all bytes unchanged.
 */
export async function normalizeWindowsSignature(path, signTool, environment) {
  const before = await digest(path)
  try {
    await promisify(execFile)(signTool, ['remove', '/u', path], { env: environment, windowsHide: true, timeout: 60_000 })
  } catch (error) {
    // SignTool returns warning status when a verified signature has no unsigned attributes.
    if (error.code !== 2 || error.signal || error.killed || await digest(path) !== before) throw error
  }
}

/**
 * Sign once, timestamp fresh copies at most three times, then atomically replace the unchanged input.
 * @param {string} path Exclusively owned build file; storage must be trusted.
 * @param {import('./windows-timestamp.mjs').WindowsTimestampOptions} options Verified hardware signer and credential-free public operations.
 * @returns {Promise<void>} Resolves only after complete signature, exact normalized bytes and committed-byte verification.
 */
export async function completeWindowsSignature(path, options) {
  const original = await digest(path)
  const staging = await mkdtemp(join(tmpdir(), 'dsh-sign-'))
  const extension = extname(path)
  let publication
  let completed = false
  let retained = false
  try {
    const raw = join(staging, `raw${extension}`)
    const normalized = join(staging, `normalized${extension}`)
    // SignTool does not consistently support extended-length Windows paths.
    if (normalized.length >= 260) throw new Error('Windows timestamp: temporary SignTool path exceeds MAX_PATH')
    await copyFile(path, raw)
    if (await digest(raw) !== original) throw new Error('Windows timestamp: input changed during staging')
    options.record({ type: 'signature-staging', path, stagedPath: raw })
    await options.sign(raw)
    const frozen = await digest(raw)
    await copyFile(raw, normalized)
    await options.normalize(normalized)
    const baseline = await digest(normalized)
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await digest(raw) !== frozen) throw new Error('Windows timestamp: signed input changed')
      const candidate = join(staging, `attempt-${attempt}${extension}`)
      await copyFile(raw, candidate)
      if (await digest(candidate) !== frozen) throw new Error('Windows timestamp: copy changed')
      options.record({ type: 'timestamp-start', path, attempt })
      try { await options.timestamp(candidate) }
      catch (error) {
        options.record({ type: 'timestamp-failure', path, attempt, code: typeof error.code === 'number' ? error.code : null })
        if (await digest(raw) !== frozen) throw new Error('Windows timestamp: signed input changed after failure')
        if (attempt === 3 || ![1, 2].includes(error.code) || error.signal || error.killed) throw error
        await (options.wait ?? setTimeout)(attempt * 1000)
        continue
      }
      const signature = await options.inspect(candidate)
      if (signature.status !== 'Valid' || !signature.timestamped || signature.thumbprint?.toUpperCase() !== options.thumbprint.toUpperCase()) {
        throw new Error('Windows timestamp: completed signature verification failed')
      }
      await copyFile(candidate, normalized)
      await options.normalize(normalized)
      if (await digest(normalized) !== baseline) throw new Error('Windows timestamp: signing content changed')
      if (await digest(raw) !== frozen || await digest(path) !== original) throw new Error('Windows timestamp: input changed before publication')
      const expected = await digest(candidate)
      publication = await mkdtemp(toNamespacedPath(join(dirname(path), '.complete-signature-')))
      const ready = join(publication, `ready${extension}`)
      await copyFile(candidate, ready)
      if (await digest(ready) !== expected || await digest(path) !== original) throw new Error('Windows timestamp: input changed before publication')
      await rename(ready, path)
      if (await digest(path) !== expected) throw new Error('Windows timestamp: committed bytes changed')
      options.record({ type: 'timestamp-success', path, attempt })
      completed = true
      return
    }
  } catch (error) {
    try {
      const evidence = await mkdtemp(join(options.evidenceDirectory, 'signature-failure-'))
      await cp(staging, join(evidence, 'files'), { recursive: true, errorOnExist: true, force: false })
      options.record({ type: 'signature-failure-evidence', path, directory: evidence })
      retained = true
    } catch (evidenceError) {
      throw new AggregateError([error, evidenceError], 'Windows signature failed and its evidence could not be retained')
    }
    throw error
  } finally {
    if (publication) await rm(publication, { recursive: true, force: true })
    // Failure staging remains available if evidence publication or its audit record fails.
    if (completed || retained) await rm(staging, { recursive: true, force: true })
  }
}
