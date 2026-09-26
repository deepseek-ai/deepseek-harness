/** One-time contributor command to publish V4 successors through JSONL persistence. */

import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { appendFileSync, closeSync, mkdtempSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { availableParallelism, homedir, tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { inspect, parseArgs } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { encodeSegment, generationLogFilename, parseGenerationLogFilename, type JsonlCompression } from '../packages/session/session-persistence-jsonl/src/format.ts'
import { JsonlGenerationSourceChangedError } from '../packages/session/session-persistence-jsonl/src/generation.ts'
import { classifyMigrationFailure, type MigrationFailureDiagnostic } from './migration-failure-summary.ts'

const usage = `Usage: pnpm run migrate:sessions-to-v4 [--sessions-dir PATH] [--jobs N]

Publish V4 successors beside unchanged historical Session generations.
Defaults to ~/.dsh/sessions. Already-V4 Sessions are opened read-only.
No model or API key is used. Failures do not stop subsequent Sessions.
The text log and final JSON summary are saved in a private OS temporary directory.

Options:
  --sessions-dir PATH  Session root to migrate
  --jobs N             Concurrent Sessions, positive integer (default: CPU count capped at 16)
  --help              Show this help
`

interface Candidate {
  readonly directory: string
  readonly source?: { readonly filename: string; readonly version: number; readonly compression: JsonlCompression; readonly bytes: number }
  readonly error?: unknown
}

interface OutcomeCounts {
  converted: number
  alreadyV4: number
  failed: number
  skipped: number
}

type SourceVersion = number | 'unknown'
interface Failure extends MigrationFailureDiagnostic {
  inputPath: string
  sourceVersion: SourceVersion
}

interface FailureGroup extends Pick<MigrationFailureDiagnostic, 'reason' | 'errorName' | 'eventType' | 'member' | 'child'> {
  sourceVersion: SourceVersion
  count: number
  items: Array<MigrationFailureDiagnostic & { inputPath: string }>
}

function emptyCounts(): OutcomeCounts {
  return { converted: 0, alreadyV4: 0, failed: 0, skipped: 0 }
}

function summarizeFailures(failures: readonly Failure[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>()
  for (const { sourceVersion, ...item } of failures) {
    const key = JSON.stringify([
      String(sourceVersion), item.reason, item.errorName, item.eventType ?? null, item.member ?? null, item.child ?? false,
    ])
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        sourceVersion, reason: item.reason, errorName: item.errorName,
        ...item.eventType === undefined ? {} : { eventType: item.eventType },
        ...item.member === undefined ? {} : { member: item.member },
        ...item.child === undefined ? {} : { child: item.child },
        count: 0, items: [],
      }
      groups.set(key, group)
    }
    group.count += 1
    group.items.push(item)
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => ({
    ...group, items: group.items.sort((left, right) => left.inputPath.localeCompare(right.inputPath)),
  }))
}

async function inspectDirectory(directory: string): Promise<Candidate> {
  try {
    const entries = await readdir(directory)
    const generations = entries.flatMap(filename => (['none', 'zstd'] as const).flatMap((compression) => {
      const version = parseGenerationLogFilename(filename, compression)
      return version === undefined ? [] : [{ filename, version, compression }]
    })).sort((left, right) => right.version - left.version || left.filename.localeCompare(right.filename))
    const selected = generations[0]
    if (selected === undefined) return { directory }
    const metadata = await stat(join(directory, selected.filename))
    return { directory, source: { ...selected, bytes: metadata.size } }
  } catch (error: unknown) {
    return { directory, error }
  }
}

async function discover(root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  const projects = await readdir(root, { withFileTypes: true })
  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(root, project.name)
    if (project.isSymbolicLink()) {
      candidates.push({ directory, error: new Error('project symbolic links are not traversed') })
      continue
    }
    if (!project.isDirectory()) {
      if (project.name.endsWith('.jsonl') || project.name.endsWith('.jsonl.zstd')) {
        candidates.push({ directory, error: new Error('unsupported flat-file layout; expected project/session/generation') })
      }
      continue
    }
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) candidates.push({ directory: path, error: new Error('Session symbolic links are not traversed') })
        else if (entry.isDirectory()) candidates.push(await inspectDirectory(path))
        else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) {
          candidates.push({ directory: path, error: new Error('unsupported flat-file layout; expected project/session/generation') })
        }
      }
    } catch (error: unknown) {
      candidates.push({ directory, error })
    }
  }
  return candidates
}

function directoryId(directory: string): SessionId {
  const segment = basename(directory)
  const id = segment.replace(/~([0-9A-F]{4})/gu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  if (encodeSegment(id) !== segment) throw new Error(`noncanonical Session directory name ${JSON.stringify(segment)}`)
  return SessionId(id)
}

/**
 * Run bounded Session jobs, then retry deferred inputs once after every initial job settles.
 * An unexpected visit rejection drains active workers and aborts the retry pass.
 * @param count - Number of discovered inputs.
 * @param jobs - Positive number of concurrent initial operations.
 * @param visit - Attempt an input; return true to defer its first attempt until the serial retry pass.
 * @returns Completion after all active operations have settled, including on unexpected rejection.
 */
export async function runMigrationJobs(
  count: number,
  jobs: number,
  visit: (index: number, retry: boolean) => Promise<boolean>,
): Promise<void> {
  let next = 0
  const deferred: number[] = []
  const workers = Array.from({ length: Math.min(jobs, count) }, async () => {
    while (next < count) {
      const index = next++
      if (await visit(index, false)) deferred.push(index)
    }
  })
  const results = await Promise.allSettled(workers)
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  for (const index of deferred.sort((a, b) => a - b)) await visit(index, true)
}

async function migrate(root: string, jobs: number): Promise<number> {
  const reportDirectory = mkdtempSync(join(tmpdir(), 'dsh-migrate-v4-'))
  const logPath = join(reportDirectory, 'migration.log')
  const summaryPath = join(reportDirectory, 'summary.json')
  const log = openSync(logPath, 'wx', 0o600)
  const write = (line: string): void => {
    appendFileSync(log, `${line}\n`)
    console.log(line)
  }
  const totals = emptyCounts()
  const bySourceVersion: Record<string, OutcomeCounts> = {}
  const recordOutcome = (version: SourceVersion, outcome: keyof OutcomeCounts): void => {
    totals[outcome] += 1
    const counts = bySourceVersion[String(version)] ??= emptyCounts()
    counts[outcome] += 1
  }
  const failures: Failure[] = []
  const fail = (inputPath: string, error: unknown, sourceVersion: SourceVersion = 'unknown'): void => {
    const diagnostic = classifyMigrationFailure(error)
    failures.push({ inputPath, sourceVersion, ...diagnostic })
    recordOutcome(sourceVersion, 'failed')
    write(`ERROR ${JSON.stringify(inputPath)}: ${diagnostic.message}`)
    appendFileSync(log, `${inspect(error, { depth: null, colors: false })}\n`)
  }
  const startedAt = new Date().toISOString()
  let inputCount = 0
  let checkoutCommit: string | null = null
  try {
    write(`Session migration to V4 started ${startedAt}`)
    write(`Root: ${root}`)
    write(`Session jobs: ${jobs}`)
    write(`Node: ${process.version}; platform: ${process.platform}/${process.arch}`)
    checkoutCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }).trim()
    write(`Git HEAD: ${checkoutCommit}`)
    write(`Full log: ${logPath}`)
    assert.equal(SESSION_FORMAT_VERSION, 4, 'this one-time command requires a V4 Session writer')
    assert.equal(sessionFormatCatalog.currentVersion, 4, 'this one-time command requires a V4 format catalog')
    const candidates = await discover(root)
    inputCount = candidates.length
    write(`Discovered ${candidates.length} Session directories or invalid layout entries.`)
    const compression = candidates.find(candidate => candidate.source !== undefined)?.source?.compression ?? 'zstd'
    const ctx = new Context()
    try {
      await ctx.plugin(JsonlSessionPersistence, { root, compression })
      let completed = 0
      await runMigrationJobs(candidates.length, jobs, async (index, retry) => {
        const candidate = candidates[index]
        assert(candidate !== undefined, 'migration job index must name a discovered input')
        const { directory, source } = candidate
        const label = `[${index + 1}/${candidates.length}] ${JSON.stringify(relative(root, directory))}`
        const started = performance.now()
        write(`${label} ${retry ? 'RETRY' : 'START'} ${source === undefined ? 'inspect entry' : `${source.filename} (V${source.version}, ${source.bytes} bytes)`}`)
        const finish = (status: string): void => {
          completed += 1
          write(`${label} ${status}; completed=${completed}/${candidates.length}`)
        }
        try {
          if (candidate.error !== undefined) {
            throw candidate.error instanceof Error ? candidate.error : new Error('directory inspection failed', { cause: candidate.error })
          }
          if (source === undefined) {
            recordOutcome('unknown', 'skipped')
            finish('SKIPPED: no canonical Session generation')
            return false
          }
          const id = directoryId(directory)
          const handle = await ctx.sessionPersistence.open(id, source.version === 4 ? 'read' : 'write')
          await handle.close()
          recordOutcome(source.version, source.version === 4 ? 'alreadyV4' : 'converted')
          finish(`${source.version === 4 ? 'already V4 (opened successfully)' : `V${source.version} -> V4: ${generationLogFilename(4, source.compression)}`} (${((performance.now() - started) / 1000).toFixed(2)}s)`)
        } catch (error: unknown) {
          if (!retry && error instanceof JsonlGenerationSourceChangedError) {
            write(`${label} DEFERRED: ${error.message}; retry once after initial jobs finish`)
            appendFileSync(log, `${inspect(error, { depth: null, colors: false })}\n`)
            return true
          }
          finish(`FAILED (${((performance.now() - started) / 1000).toFixed(2)}s)`)
          fail(source === undefined ? directory : join(directory, source.filename), error, source?.version)
        }
        return false
      })
    } finally {
      await ctx.fiber.dispose()
    }
  } catch (error: unknown) {
    fail(root, error)
  } finally {
    try {
      write(`Summary: converted=${totals.converted}, already-V4=${totals.alreadyV4}, failed=${totals.failed}, skipped=${totals.skipped}`)
      if (failures.length > 0) {
        write('Failures (full stacks and causes are in the log):')
        for (const failure of failures) write(`- ${JSON.stringify(failure.inputPath)}: ${failure.message}`)
      }
      write(`Full log: ${logPath}`)
      const summary = JSON.stringify({
        schemaVersion: 1,
        targetVersion: 4,
        sessionRoot: root,
        inputCount,
        jobs,
        startedAt,
        finishedAt: new Date().toISOString(),
        checkoutCommit,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        textLogPath: logPath,
        summaryPath,
        totals,
        bySourceVersion,
        failureGroups: summarizeFailures(failures),
      }, null, 2)
      writeFileSync(summaryPath, `${summary}\n`, { flag: 'wx', mode: 0o600 })
      write(`JSON summary: ${summaryPath}`)
      write(summary)
    } finally {
      closeSync(log)
    }
  }
  return totals.failed > 0 ? 1 : 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  try {
    const { values } = parseArgs({ options: { 'sessions-dir': { type: 'string' }, jobs: { type: 'string' }, help: { type: 'boolean' } }, strict: true })
    if (values.help) console.log(usage)
    else {
      const jobs = values.jobs === undefined ? Math.min(availableParallelism(), 16) : Number(values.jobs)
      if (!Number.isSafeInteger(jobs) || jobs < 1) {
        throw new Error('--jobs must be a positive safe integer')
      }
      process.exitCode = await migrate(resolve(values['sessions-dir'] ?? join(homedir(), '.dsh', 'sessions')), jobs)
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage)
    process.exitCode = 1
  }
}
