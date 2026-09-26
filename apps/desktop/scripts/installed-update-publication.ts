/** Separate immutable qualification uploads from explicitly authorized fixed-feed publication. */
import { mkdir, mkdtemp, readFile, readdir, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { inspectInstalledUpdateJournals, readInstalledUpdateRun } from './installed-update-qualification.ts'
import { planInstalledUpdateDistribution } from './installed-update-distribution.ts'
import { installedUpdateFileHash } from './installed-update-signature.mjs'
import { recordPackagingEvent } from './packaging-run.mjs'

/** One fully read object; digest and byte count describe actual received bytes. */
export interface InstalledUpdateRemoteObject {
  readonly sha512: string
  readonly size: number
}

/** Transport-owned authentication is never included in publication records. */
export interface InstalledUpdatePublicationStore {
  /** @returns True only after authoritative bucket configuration confirms versioning is disabled. */
  versioningDisabled(): Promise<boolean>
  /** @param key Exact run-owned object key. @returns Actual object digest, or null only for a confirmed missing object. */
  read(key: string): Promise<InstalledUpdateRemoteObject | null>
  /** @param url Exact public URL, without cache-busting parameters. @returns Actual public bytes, or confirmed absence. */
  publicRead(url: string): Promise<InstalledUpdateRemoteObject | null>
  /**
   * Write once without automatic retries; forbidOverwrite must reach the server for immutable objects.
   * @param key Exact run-owned destination.
   * @param object Local binary or retained feed, with declared integrity and overwrite policy.
   * @returns Public server receipt, never authorization headers or credentials.
   */
  put(key: string, object: {
    readonly source: { readonly path: string } | { readonly contents: string }
    readonly size: number
    readonly sha512: string
    readonly forbidOverwrite: boolean
  }): Promise<{ readonly requestId?: string }>
}

/** Selected operator action; upload never advertises either version to clients. */
export type InstalledUpdatePublicationAction = 'upload-binaries' | 'publish-feed'

/**
 * Revalidate a successful local package check against current bytes, without credentials or network access.
 * @param manifest Original test manifest.
 * @param version Exact selected version.
 * @param receipt That version's successful package-verification result.
 * @returns Current distribution plan bound to the retained verification evidence.
 */
export async function verifiedInstalledUpdateDistribution(manifest: string, version: string, receipt: string) {
  const run = await readInstalledUpdateRun(manifest)
  const path = relative(join(run.root, version, 'verification'), resolve(receipt)).replaceAll('\\', '/')
  if (!/^check-[^/]+\/result\.json$/u.test(path)) throw new Error('installed update: matching package verification receipt is required')
  const result = JSON.parse(await readFile(receipt, 'utf8')) as {
    schemaVersion?: unknown
    runId?: unknown
    version?: unknown
    stage?: unknown
    passed?: unknown
    installerSignature?: { valid?: unknown; timestamped?: unknown; sha512?: unknown; updaterVerificationInvoked?: unknown }
    contents?: { appId?: unknown; version?: unknown }
  }
  const distribution = await planInstalledUpdateDistribution(manifest, version)
  const inputs = JSON.parse(await readFile(join(dirname(receipt), 'inputs.json'), 'utf8')) as {
    manifestSha512?: unknown
    distribution?: unknown
  }
  if (result.schemaVersion !== 1 || result.runId !== run.id || result.version !== version || result.stage !== 'complete' || result.passed !== true
    || result.contents?.appId !== run.appId || result.contents.version !== version
    || result.installerSignature?.valid !== true || result.installerSignature.timestamped !== true
    || result.installerSignature.updaterVerificationInvoked !== true
    || result.installerSignature.sha512 !== distribution.binaries[0]!.sha512
    || inputs.manifestSha512 !== await installedUpdateFileHash(manifest)
    || JSON.stringify(inputs.distribution) !== JSON.stringify(distribution)) {
    throw new Error('installed update: current files do not match successful package verification')
  }
  return { run, distribution, receiptSha512: await installedUpdateFileHash(receipt) }
}

function matches(actual: InstalledUpdateRemoteObject | null, expected: InstalledUpdateRemoteObject): boolean {
  return actual?.sha512 === expected.sha512 && actual.size === expected.size
}

async function verifiedUploadReceipt(prepared: Awaited<ReturnType<typeof verifiedInstalledUpdateDistribution>>) {
  const parent = join(prepared.run.root, 'publication-records')
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('operation-')) continue
    const directory = join(parent, entry.name)
    if (!(await readdir(directory)).includes('result.json')) continue
    const path = join(directory, 'result.json')
    const result: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof result !== 'object' || result === null) continue
    const fields = result as Record<string, unknown>
    if (fields.schemaVersion !== 1 || fields.success !== true || fields.stage !== 'complete'
      || fields.action !== 'upload-binaries' || fields.runId !== prepared.run.id || fields.version !== prepared.distribution.version) continue
    const planPath = join(directory, 'plan.json')
    const plan: unknown = JSON.parse(await readFile(planPath, 'utf8'))
    if (JSON.stringify(plan) !== JSON.stringify(prepared)) continue
    return { path, sha512: await installedUpdateFileHash(path), planSha512: await installedUpdateFileHash(planPath) }
  }
  throw new Error('matching successful binary upload receipt is required')
}

async function startupEvidence(manifest: string, directory: string | undefined) {
  const run = await readInstalledUpdateRun(manifest)
  if (!directory || !resolve(directory).replaceAll('\\', '/').endsWith(`/dsh-update-qualification/${run.id}/journals`)) {
    throw new Error('installed update: original installed application journal directory is required before successor publication')
  }
  const report = await inspectInstalledUpdateJournals(directory, run.versions)
  const ready = report.milestones['original-workspace']
  if (!ready || Date.parse(ready.time) > Date.now()) throw new Error('installed update: original workspace startup is not recorded')
  return ready
}

/**
 * Execute one separately authorized upload or feed publication with local exclusion and retained evidence.
 * @param manifest Original qualification manifest.
 * @param version Version to upload or advertise.
 * @param receipt Matching successful package verification.
 * @param action Upload objects without a feed, or publish only after public object verification.
 * @param store Explicit transport, supplied only after operator authorization; writes must not retry.
 * @param journalDirectory Original installed-app journal directory, required for successor publication.
 * @returns Retained operation result path; any error stops subsequent writes and preserves partial evidence.
 */
export async function executeInstalledUpdatePublication(
  manifest: string, version: string, receipt: string, action: InstalledUpdatePublicationAction,
  store: InstalledUpdatePublicationStore, journalDirectory?: string,
): Promise<string> {
  const prepared = await verifiedInstalledUpdateDistribution(manifest, version, receipt)
  const { run, distribution } = prepared
  const successor = action === 'publish-feed' && version === run.versions[1]
  const startup = successor ? await startupEvidence(manifest, journalDirectory) : undefined
  const lock = join(run.root, 'publication.lock')
  await mkdir(lock)
  let record: string | undefined
  const result: Record<string, unknown> = { schemaVersion: 1, runId: run.id, version, action, success: false, startup,
    startedAt: new Date().toISOString(), singlePublisherRequired: true }
  const stage = (name: string, data: object = {}): void => {
    result.stage = name
    recordPackagingEvent(record!, { type: 'publication-stage', stage: name, ...data })
    console.log(`INSTALLED_UPDATE_PUBLICATION_STAGE ${name}`)
  }
  try {
    const parent = join(run.root, 'publication-records')
    await mkdir(parent, { recursive: true })
    record = await mkdtemp(join(parent, 'operation-'))
    console.log(`INSTALLED_UPDATE_PUBLICATION_RECORD ${record}`)
    await writeFile(join(record, 'plan.json'), `${JSON.stringify(prepared, null, 2)}\n`, { flag: 'wx', flush: true })
    if (action === 'publish-feed') {
      stage('binary-upload-receipt')
      result.binaryUploadReceipt = await verifiedUploadReceipt(prepared)
      stage('binary-upload-receipt-verified', result.binaryUploadReceipt as object)
    } else {
      stage('bucket-versioning')
      if (!await store.versioningDisabled()) throw new Error('bucket versioning is not confirmed disabled')
    }
    for (const binary of action === 'upload-binaries' ? distribution.binaries : []) {
      stage('binary-origin-read', { key: binary.key })
      const existing = await store.read(binary.key)
      if (existing !== null && !matches(existing, binary)) throw new Error('existing binary differs')
      if (existing === null) {
        if (action !== 'upload-binaries') throw new Error('binary upload must precede feed publication')
        if (JSON.stringify(await verifiedInstalledUpdateDistribution(manifest, version, receipt)) !== JSON.stringify(prepared)) {
          throw new Error('local inputs changed')
        }
        stage('binary-put', { key: binary.key })
        const response = await store.put(binary.key, { source: { path: binary.path }, size: binary.size,
          sha512: binary.sha512, forbidOverwrite: true })
        stage('binary-put-response', { key: binary.key, ...response })
      }
      stage('binary-public-read', { key: binary.key })
      if (!matches(await store.publicRead(`${run.origin}/${binary.key}`), binary)) throw new Error('public binary differs')
    }
    if (action === 'publish-feed') {
      stage('feed-origin-read')
      const previous = await store.read(distribution.feed.key)
      const previousPlan = successor ? await planInstalledUpdateDistribution(manifest, run.versions[0]) : undefined
      const expectedPrevious = previousPlan === undefined ? null
        : { sha512: previousPlan.feed.sha512, size: Buffer.byteLength(previousPlan.feed.contents) }
      const alreadyPublished = matches(previous, { sha512: distribution.feed.sha512, size: Buffer.byteLength(distribution.feed.contents) })
      if (!alreadyPublished && (expectedPrevious === null ? previous !== null : !matches(previous, expectedPrevious))) {
        throw new Error('unexpected previous feed')
      }
      if (successor) {
        const evidence = await startupEvidence(manifest, journalDirectory)
        if (JSON.stringify(evidence) !== JSON.stringify(startup)) throw new Error('startup evidence changed')
      }
      if (JSON.stringify(await verifiedInstalledUpdateDistribution(manifest, version, receipt)) !== JSON.stringify(prepared)) {
        throw new Error('local inputs changed')
      }
      await writeFile(join(record, 'feed.yml'), distribution.feed.contents, { flag: 'wx', flush: true })
      result.alreadyPublished = alreadyPublished
      if (!alreadyPublished) {
        stage('feed-put', { key: distribution.feed.key, previous, startedAfterOriginal: successor })
        result.putResponse = await store.put(distribution.feed.key, { source: { contents: distribution.feed.contents },
          size: Buffer.byteLength(distribution.feed.contents), sha512: distribution.feed.sha512, forbidOverwrite: !successor })
      }
      stage('feed-public-read')
      if (!matches(await store.publicRead(distribution.feed.url), { sha512: distribution.feed.sha512,
        size: Buffer.byteLength(distribution.feed.contents) })) throw new Error('public feed differs')
    }
    stage('complete')
    result.success = true
    return join(record, 'result.json')
  } catch (error) {
    result.failure = 'operation stopped; inspect the retained stage and remote state before any further publication'
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const statusCode = error.statusCode
      if (typeof statusCode === 'number' && statusCode >= 100 && statusCode <= 599) {
        result.httpStatus = statusCode
      }
    }
    throw new Error(`installed update: publication stopped; record: ${record ?? 'not allocated'}`)
  } finally {
    try {
      if (record !== undefined) await writeFile(join(record, 'result.json'), `${JSON.stringify({ ...result,
        finishedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', flush: true })
    } finally { await rmdir(lock) }
  }
}
