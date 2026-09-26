/** Local-only material allocation and journal inspection for operator-driven installed updates. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { gt, valid } from 'semver'

/** Source identifiers exclude file contents, configuration values, and credentials. */
export interface InstalledUpdateSource {
  readonly version: string
  readonly commit: string
  readonly dirtyFiles: readonly string[]
}

/** A private test namespace; creating it performs no signing, installation, or remote operation. */
export interface InstalledUpdateRun {
  readonly schemaVersion: 1
  readonly id: string
  readonly root: string
  readonly createdAt: string
  readonly source: InstalledUpdateSource
  readonly versions: readonly [string, string]
  readonly appId: string
  readonly productName: string
  readonly environment: 'test'
  readonly origin: string
  readonly bucket: string
  readonly feedKey: string
  readonly binPrefix: string
}

/**
 * Allocate a new local run and retain its manifest without reading release credentials.
 * @param parent Ignored material directory; each invocation acquires a separate child atomically.
 * @param versions Explicit original and successor test versions, in increasing order.
 * @param source Source version, Git commit, and dirty-file list captured before material preparation.
 * @returns The retained run manifest; no package or publication is implied by its presence.
 */
export async function createInstalledUpdateRun(
  parent: string, versions: readonly [string, string], source: InstalledUpdateSource,
): Promise<InstalledUpdateRun> {
  validateVersions(versions)
  if (valid(source.version) === null || !/^[a-f0-9]{40,64}$/u.test(source.commit)) {
    throw new Error('installed update: valid source version and Git commit are required')
  }
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(resolve(parent), 'installed-update-'))
  const id = randomBytes(12).toString('hex')
  const run: InstalledUpdateRun = {
    schemaVersion: 1, id, root, createdAt: new Date().toISOString(), source, versions,
    appId: `com.deepseek.dsh.qualification.q${id}`, productName: `DSH Update Test ${id}`,
    environment: 'test', origin: 'https://download-test.deepseek.com', bucket: 'bj-toc-download-test-1320056602',
    feedKey: `dsh-desk/feeds/qualification/${id}/win-x64/nightly.yml`,
    binPrefix: `dsh-desk/bin/qualification/${id}/win-x64`,
  }
  await writeFile(join(root, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true })
  return run
}

function validateVersions(versions: readonly [string, string]): void {
  const pattern = /^\d+\.\d+\.\d+-(?:nightly\.[0-9.]+|[0-9A-Za-z.-]+\.\d{8}\.[1-9]\d*)$/u
  if (versions.some(version => valid(version) !== version || !pattern.test(version))
    || !gt(versions[1], versions[0])) {
    throw new Error('installed update: two increasing dated test versions are required')
  }
}

/**
 * Load a retained manifest and reject altered destinations or application identities.
 * @param path Local run.json produced by the allocator.
 * @returns Validated test-only run; the directory must still be the original manifest location.
 */
export async function readInstalledUpdateRun(path: string): Promise<InstalledUpdateRun> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('installed update: invalid run manifest')
  const row = value as Record<string, unknown>
  if (row.schemaVersion !== 1 || typeof row.id !== 'string' || !/^[a-f0-9]{24}$/u.test(row.id)
    || row.root !== resolve(dirname(path)) || row.environment !== 'test'
    || row.origin !== 'https://download-test.deepseek.com' || row.bucket !== 'bj-toc-download-test-1320056602'
    || row.appId !== `com.deepseek.dsh.qualification.q${row.id}` || row.productName !== `DSH Update Test ${row.id}`
    || row.feedKey !== `dsh-desk/feeds/qualification/${row.id}/win-x64/nightly.yml`
    || row.binPrefix !== `dsh-desk/bin/qualification/${row.id}/win-x64`
    || !Array.isArray(row.versions) || row.versions.length !== 2 || row.versions.some(version => typeof version !== 'string')) {
    throw new Error('installed update: manifest identity, location, versions, or test destination changed')
  }
  validateVersions(row.versions as [string, string])
  if (typeof row.source !== 'object' || row.source === null || Array.isArray(row.source)) {
    throw new Error('installed update: missing source version and commit')
  }
  const source = row.source as Record<string, unknown>
  if (typeof source.version !== 'string' || valid(source.version) === null
    || typeof source.commit !== 'string' || !/^[a-f0-9]{40,64}$/u.test(source.commit)
    || !Array.isArray(source.dirtyFiles) || source.dirtyFiles.some(file => typeof file !== 'string')
    || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) {
    throw new Error('installed update: invalid source version, commit, file list, or creation time')
  }
  return row as unknown as InstalledUpdateRun
}

interface JournalRecord {
  readonly pid: number
  readonly sequence: number
  readonly time: string
  readonly version: string
  readonly event: string
  readonly phase?: string
  readonly targetVersion?: string
  readonly failedOperation?: string
  readonly percent?: number
}

/** A location in retained evidence, never a copy of raw diagnostics. */
export interface InstalledUpdateObservation {
  readonly file: string
  readonly sequence: number
  readonly time: string
}

/** Observed journal sequence is deliberately separate from operator acceptance. */
export interface InstalledUpdateEvidence {
  readonly schemaVersion: 1
  readonly versions: readonly [string, string]
  readonly filesRead: number
  readonly recordedFlow: 'complete' | 'incomplete'
  readonly milestones: Readonly<Record<string, InstalledUpdateObservation>>
  readonly missing: readonly string[]
  readonly operatorVerificationRequired: readonly string[]
}

const FIELDS = new Set(['schemaVersion', 'sequence', 'time', 'pid', 'version', 'event', 'phase',
  'targetVersion', 'percent', 'failedOperation', 'errorCode'])
const ACTIONS = new Set(['started', 'workspace-ready', 'workspace-failed', 'check-requested',
  'download-requested', 'install-confirmed', 'quit-requested', 'state'])
const PHASES = new Set(['idle', 'checking', 'available', 'downloading', 'verifying', 'installing', 'ready', 'error'])
const OPERATIONS = new Set(['check', 'download', 'install'])
const ERROR_CODES = new Set(['ETIMEDOUT', 'ENOSPC', 'ERR_INTERNET_DISCONNECTED', 'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_UPDATER_INVALID_SIGNATURE', 'ERR_UPDATER_CHECKSUM_MISMATCH', 'UNCLASSIFIED'])
const STAGES = ['original-workspace', 'first-download', 'transfer-started', 'download-failed',
  'manual-retry', 'download-ready', 'install-confirmed', 'original-quit', 'successor-started', 'successor-workspace'] as const

function parseRecord(line: string, sequence: number): JournalRecord {
  let value: unknown
  try { value = JSON.parse(line) }
  catch { throw new Error('installed update: invalid journal JSON; raw input is withheld') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('installed update: invalid journal record')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !FIELDS.has(key)) || row.schemaVersion !== 1 || row.sequence !== sequence
    || !Number.isSafeInteger(row.pid) || (row.pid as number) <= 0
    || typeof row.time !== 'string' || !Number.isFinite(Date.parse(row.time))
    || new Date(row.time).toISOString() !== row.time || typeof row.version !== 'string' || valid(row.version) !== row.version
    || typeof row.event !== 'string' || !ACTIONS.has(row.event)
    || (sequence === 0 && row.event !== 'started') || (sequence > 0 && row.event === 'started')
    || (row.event === 'state' && (typeof row.phase !== 'string' || !PHASES.has(row.phase)))
    || (row.phase !== undefined && (typeof row.phase !== 'string' || !PHASES.has(row.phase)))
    || (row.failedOperation !== undefined && (typeof row.failedOperation !== 'string' || !OPERATIONS.has(row.failedOperation)))
    || (row.errorCode !== undefined && (typeof row.errorCode !== 'string' || !ERROR_CODES.has(row.errorCode)))
    || (row.percent !== undefined && (typeof row.percent !== 'number' || !Number.isInteger(row.percent)
      || row.percent < 0 || row.percent > 100))
    || (row.targetVersion !== undefined && (typeof row.targetVersion !== 'string' || valid(row.targetVersion) !== row.targetVersion))) {
    throw new Error('installed update: unsupported or inconsistent journal record; raw input is withheld')
  }
  return row as unknown as JournalRecord
}

/**
 * Inspect a private evidence directory without changing files or declaring the installation successful.
 * @param directory Directory containing only the qualification run's per-process JSONL journals.
 * @param versions Expected installed original and successor versions.
 * @returns Ordered failure/retry/restart observations plus required independent operator verification.
 */
export async function inspectInstalledUpdateJournals(
  directory: string, versions: readonly [string, string],
): Promise<InstalledUpdateEvidence> {
  return inspectJournalRuns(await readJournalRuns(directory, versions), versions)
}

interface JournalRun { readonly file: string; readonly text: string; readonly records: JournalRecord[] }

async function readJournalRuns(directory: string, versions: readonly [string, string]): Promise<JournalRun[]> {
  validateVersions(versions)
  const files = (await readdir(directory)).filter(file => file.endsWith('.jsonl')).sort()
  const runs: JournalRun[] = []
  let totalBytes = 0
  for (const file of files) {
    if (!/^\d+-[a-f0-9-]{36}\.jsonl$/u.test(file)) throw new Error('installed update: unexpected journal filename')
    if ((await stat(join(directory, file))).size > 10 * 1024 * 1024) throw new Error('installed update: journal exceeds 10 MiB inspection limit')
    const text = await readFile(join(directory, file), 'utf8')
    const bytes = Buffer.byteLength(text)
    totalBytes += bytes
    if (bytes > 10 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) throw new Error('installed update: journal snapshot exceeds inspection limit')
    if (!text.endsWith('\n')) throw new Error('installed update: incomplete journal tail')
    const records = text.slice(0, -1).split('\n').map(parseRecord)
    if (records.some(row => row.version !== records[0]!.version || row.pid !== records[0]!.pid || !versions.includes(row.version))) {
      throw new Error('installed update: mixed or unexpected installed versions')
    }
    runs.push({ file, text, records })
  }
  return runs
}

function inspectJournalRuns(runs: readonly JournalRun[], versions: readonly [string, string]): InstalledUpdateEvidence {
  let milestones: Record<string, InstalledUpdateObservation> = {}
  // A retry and installation authorization must belong to the same original process.
  for (const run of runs.filter(run => run.records[0]!.version === versions[0])) {
    const candidate: Record<string, InstalledUpdateObservation> = {}
    let stage = 0
    for (const record of run.records) {
      if (stage >= 6 && (record.event === 'download-requested' || (record.event === 'state' && record.phase === 'error'))) {
        for (const key of STAGES.slice(4)) delete candidate[key]
        stage = 4
      }
      const matches = [record.event === 'workspace-ready', record.event === 'download-requested',
        record.event === 'state' && record.phase === 'downloading' && record.targetVersion === versions[1]
          && record.percent !== undefined && record.percent > 0,
        record.event === 'state' && record.phase === 'error' && record.failedOperation === 'download'
          && record.targetVersion === versions[1],
        record.event === 'download-requested',
        record.event === 'state' && record.phase === 'ready' && record.targetVersion === versions[1],
        record.event === 'install-confirmed', record.event === 'quit-requested']
      if (stage < 8 && matches[stage]) {
        candidate[STAGES[stage]!] = { file: run.file, sequence: record.sequence, time: record.time }
        stage++
      }
    }
    if (Object.keys(candidate).length > Object.keys(milestones).length) milestones = candidate
  }
  const quit = milestones['original-quit']
  if (quit !== undefined) {
    for (const run of runs.filter(run => run.records[0]!.version === versions[1])) {
      const started = run.records[0]!
      if (Date.parse(started.time) < Date.parse(quit.time)) continue
      const ready = run.records.find(record => record.event === 'workspace-ready')
      if (ready === undefined) continue
      milestones['successor-started'] = { file: run.file, sequence: started.sequence, time: started.time }
      milestones['successor-workspace'] = { file: run.file, sequence: ready.sequence, time: ready.time }
      break
    }
  }
  const missing = STAGES.filter(stage => milestones[stage] === undefined)
  return { schemaVersion: 1, versions, filesRead: runs.length,
    recordedFlow: missing.length === 0 ? 'complete' : 'incomplete', milestones, missing,
    operatorVerificationRequired: ['feed-publication-after-original-startup', 'network-fault-and-recovery',
      'installer-completion-and-installed-path', 'test-data-preserved', 'screenshots-and-user-confirmations'] }
}

/**
 * Retain validated journal bytes and a report from that same snapshot, without copying application data.
 * @param manifest Original test run manifest.
 * @param directory The run's installed-app journals directory; collection never changes its files.
 * @returns Independent local collection directory; incomplete flow is retained as incomplete, not acceptance.
 */
export async function collectInstalledUpdateJournals(manifest: string, directory: string): Promise<string> {
  const run = await readInstalledUpdateRun(manifest)
  if (!resolve(directory).replaceAll('\\', '/').endsWith(`/dsh-update-qualification/${run.id}/journals`)) {
    throw new Error('installed update: matching installed-app journal directory is required')
  }
  const snapshots = await readJournalRuns(directory, run.versions)
  const evidence = inspectJournalRuns(snapshots, run.versions)
  const parent = join(run.root, 'evidence')
  await mkdir(parent, { recursive: true })
  const collection = await mkdtemp(join(parent, 'collection-'))
  try {
    await writeFile(join(collection, 'started.json'), `${JSON.stringify({ time: new Date().toISOString(), runId: run.id })}\n`,
      { flag: 'wx', mode: 0o600, flush: true })
    await mkdir(join(collection, 'journals'))
    for (const snapshot of snapshots) {
      await writeFile(join(collection, 'journals', snapshot.file), snapshot.text, { flag: 'wx', mode: 0o600, flush: true })
    }
    const result = { schemaVersion: 1, runId: run.id, collectedAt: new Date().toISOString(), sourceDirectory: resolve(directory),
      evidence, operatorAcceptance: 'pending', files: snapshots.map(snapshot => ({ path: `journals/${snapshot.file}`,
        bytes: Buffer.byteLength(snapshot.text), sha256: createHash('sha256').update(snapshot.text).digest('hex') })) }
    await writeFile(join(collection, 'report.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true })
    return collection
  } catch {
    await writeFile(join(collection, 'failed.json'), `${JSON.stringify({ failed: true, time: new Date().toISOString() })}\n`,
      { flag: 'wx', mode: 0o600, flush: true })
    throw new Error(`installed update: journal collection failed; partial evidence retained at ${collection}`)
  }
}
