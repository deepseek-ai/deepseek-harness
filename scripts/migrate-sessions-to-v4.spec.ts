/** The contributor command uses real persistence on private temporary corpora. */
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { encodeSegment, generationLogFilename, type JsonlCompression } from '../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../packages/session/session-persistence-jsonl/src/zstd.ts'
import { runMigrationJobs } from './migrate-sessions-to-v4.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const repository = resolve(import.meta.dirname, '..')
const script = join(repository, 'scripts/migrate-sessions-to-v4.ts')
const directories = new Set<string>()
const stopProcesses: Array<() => Promise<void>> = []

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-migrate-v4-test-'))
  directories.add(directory)
  return directory
}

async function runAt(entrypoint: string, ...args: string[]) {
  const child = execa(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
    cwd: repository, reject: false,
  })
  stopProcesses.push(async () => { child.kill('SIGKILL'); await child })
  const result = await child
  const logPath = [...result.stdout.matchAll(/^Full log: (.+)$/gmu)].at(-1)?.[1]
  const summaryPath = [...result.stdout.matchAll(/^JSON summary: (.+)$/gmu)].at(-1)?.[1]
  if (logPath !== undefined) directories.add(dirname(logPath))
  expect(result.timedOut, result.stderr).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  const summary: unknown = summaryPath === undefined ? undefined : JSON.parse(readFileSync(summaryPath, 'utf8'))
  return { stdout: result.stdout, stderr: result.stderr, status: result.exitCode, logPath, summaryPath, summary }
}

function run(...args: string[]) {
  return runAt(script, ...args)
}

afterEach(async () => {
  await Promise.all(stopProcesses.splice(0).map(stop => stop()))
  for (const directory of directories) removeFixtureSafely(directory)
  directories.clear()
})

const toolTurn: readonly SessionFormatJsonObject[] = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' } } } },
  { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: {
    id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
    content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }],
  } } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' } },
  { type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: {
    id: 'result', role: 'user', source: { kind: 'tool', callId: 'call' },
    content: [{ type: 'tool-result', toolCallId: 'call', isError: false, content: [{ type: 'text', text: 'saved output' }] }],
  } } },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]

async function fixture(
  root: string, id: string, version: number, compression: JsonlCompression, events: readonly SessionFormatJsonObject[] = [],
  headerFields: SessionFormatJsonObject = {},
) {
  const directory = join(root, '_no-cwd', encodeSegment(id))
  await mkdir(directory, { recursive: true })
  const header = JSON.stringify({ type: 'session', version, id, createdAt: 1, delegationDepth: 0,
    ...version >= 2 ? { isSeeded: false } : {},
    ...headerFields,
  }) + '\n'
  const body = events.map((event, seq) => JSON.stringify({ ...event, seq, time: seq + 2 }) + '\n').join('')
  const bytes = compression === 'none' ? Buffer.from(header + body) : Buffer.concat([
    await compressZstdFrame(header), ...body === '' ? [] : [await compressZstdFrame(body)],
  ])
  const path = join(directory, generationLogFilename(version, compression))
  await writeFile(path, bytes)
  return { path, bytes, directory }
}

describe('one-time V4 migration command', () => {
  it('bounds active jobs and retries changed-source inputs only after the initial pass drains', async () => {
    const entered = Array.from({ length: 4 }, () => Promise.withResolvers<undefined>())
    const release = Array.from({ length: 4 }, () => Promise.withResolvers<undefined>())
    const initial: number[] = []
    const retries: number[] = []
    let active = 0
    let peak = 0
    const task = runMigrationJobs(4, 2, async (index, retry) => {
      if (retry) {
        expect(active).toBe(0)
        expect(initial.toSorted()).toEqual([0, 1, 2, 3])
        retries.push(index)
        return false
      }
      active += 1
      peak = Math.max(peak, active)
      entered[index]!.resolve(undefined)
      await release[index]!.promise
      active -= 1
      initial.push(index)
      return index === 0
    })
    try {
      await Promise.all([entered[0]!.promise, entered[1]!.promise])
      expect(active).toBe(2)
      release[1]!.resolve(undefined)
      await entered[2]!.promise
      expect(active).toBe(2)
      release[0]!.resolve(undefined)
      await entered[3]!.promise
      expect(active).toBe(2)
      expect(retries).toEqual([])
      release[2]!.resolve(undefined)
      release[3]!.resolve(undefined)
      await task
      expect(peak).toBe(2)
      expect(retries).toEqual([0])
    } finally {
      for (const barrier of release) barrier.resolve(undefined)
      await task
    }
  })

  it('runs each input to completion before starting the next with one job', async () => {
    const order: string[] = []
    await runMigrationJobs(3, 1, async (index, retry) => {
      expect(retry).toBe(false)
      order.push(`start ${index}`)
      await Promise.resolve()
      order.push(`end ${index}`)
      return false
    })
    expect(order).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2'])
  })

  it('drains ten thousand immediate inputs without exceeding the worker limit', async () => {
    const visits = new Uint8Array(10_000)
    let active = 0
    let peak = 0
    await runMigrationJobs(visits.length, 16, async (index, retry) => {
      expect(retry).toBe(false)
      visits[index]! += 1
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      return false
    })
    expect(visits.every(count => count === 1)).toBe(true)
    expect(peak).toBe(16)
    expect(active).toBe(0)
  })

  it.each(['none', 'zstd'] as const)('publishes %s successors, preserves sources and current bytes on rerun', async (compression) => {
    const root = temporaryRoot()
    const old = await fixture(root, 'old', 0, compression)
    const older = await fixture(root, 'tool/session~名', 0, compression)
    const source = await fixture(root, 'tool/session~名', 3, compression, toolTurn)
    const current = await fixture(root, 'current', 4, compression)
    await mkdir(join(root, '_no-cwd', 'empty'))
    const first = await run('--sessions-dir', root)
    expect(first.status, first.stdout + first.stderr).toBe(0)
    expect(first.stdout).toContain(`Session jobs: ${Math.min(availableParallelism(), 16)}`)
    expect(first.stdout).toContain('converted=2, already-V4=1, failed=0, skipped=1')
    expect(first.stdout).toContain('START session.v3.jsonl')
    expect(first.stdout).toContain('V3 -> V4: session.v4.jsonl')
    const checkoutCommit = /^Git HEAD: ([0-9a-f]{40})$/mu.exec(first.stdout)?.[1]
    expect(checkoutCommit).toBeDefined()
    expect(first.summary).toMatchObject({
      schemaVersion: 1,
      targetVersion: 4,
      sessionRoot: root,
      inputCount: 4,
      jobs: Math.min(availableParallelism(), 16),
      checkoutCommit,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      textLogPath: first.logPath,
      summaryPath: first.summaryPath,
      totals: { converted: 2, alreadyV4: 1, failed: 0, skipped: 1 },
      bySourceVersion: {
        '0': { converted: 1, alreadyV4: 0, failed: 0, skipped: 0 },
        '3': { converted: 1, alreadyV4: 0, failed: 0, skipped: 0 },
        '4': { converted: 0, alreadyV4: 1, failed: 0, skipped: 0 },
        unknown: { converted: 0, alreadyV4: 0, failed: 0, skipped: 1 },
      },
      failureGroups: [],
    })
    const target = join(source.directory, generationLogFilename(4, compression))
    const targetBytes = await readFile(target)
    const decoded = compression === 'none' ? targetBytes : Buffer.concat(await Promise.all(
      scanZstdFrames(targetBytes).frames.map(frame => decompressZstdFrame(targetBytes.subarray(frame.start, frame.end))),
    ))
    expect(decoded.toString()).toContain('"role":"tool"')
    expect(decoded.toString()).toContain('"text":"saved output"')
    expect(decoded.toString()).not.toContain('"type":"tool-result"')
    const second = await run('--sessions-dir', root)
    expect(second.status, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).toContain('converted=0, already-V4=3, failed=0, skipped=1')
    expect(second.summary).toMatchObject({
      totals: { converted: 0, alreadyV4: 3, failed: 0, skipped: 1 },
      bySourceVersion: { '4': { converted: 0, alreadyV4: 3, failed: 0, skipped: 0 } },
      failureGroups: [],
    })
    expect(await readFile(target)).toEqual(targetBytes)
    for (const original of [old, older, source, current]) expect(await readFile(original.path)).toEqual(original.bytes)
    expect(first.logPath).toBeDefined()
    const log = readFileSync(first.logPath!, 'utf8')
    expect(log).toContain('Git HEAD: ')
    expect(log).toContain(`Node: ${process.version}; platform: ${process.platform}/${process.arch}`)
    expect(log).toContain(first.stdout.trim())
    expect(first.summaryPath).toBe(join(dirname(first.logPath!), 'summary.json'))
    const json = readFileSync(first.summaryPath!, 'utf8')
    expect(first.stdout.endsWith(json.trimEnd())).toBe(true)
    expect(log.endsWith(json)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(first.logPath!).mode & 0o777).toBe(0o600)
      expect(statSync(first.summaryPath!).mode & 0o777).toBe(0o600)
    }
  })

  it.each(['none', 'zstd'] as const)('preserves %s parent/child history and catalog with serial or parallel jobs', async (compression) => {
    const outputs: Buffer[][] = []
    for (const jobs of [1, 2]) {
      const root = temporaryRoot()
      const parent = await fixture(root, 'a-parent', 3, compression)
      const child = await fixture(root, 'z-child', 3, compression, [
        { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'saved child' } },
      ], { origin: 'subagent', parentSession: 'a-parent', createdAt: 2, delegationDepth: 1 })
      const result = await run('--sessions-dir', root, '--jobs', String(jobs))
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('converted=2, already-V4=0, failed=0, skipped=0')
      expect(result.stdout).toContain('completed=2/2')
      const current: Buffer[] = []
      for (const original of [parent, child]) {
        expect(await readFile(original.path)).toEqual(original.bytes)
        const bytes = await readFile(join(original.directory, generationLogFilename(4, compression)))
        const decoded = compression === 'none' ? bytes : Buffer.concat(await Promise.all(
          scanZstdFrames(bytes).frames.map(frame => decompressZstdFrame(bytes.subarray(frame.start, frame.end))),
        ))
        current.push(decoded)
      }
      expect(current[0]!.toString().trim().split('\n').slice(1).map((line): unknown => JSON.parse(line))).toMatchObject([
        { type: 'subagent/catalog', data: { childId: 'z-child', childCreatedAt: 2, mode: 'continuable', label: 'saved child' } },
      ])
      outputs.push(current)
    }
    expect(outputs[1]).toEqual(outputs[0])
  })

  it('reports a bad Session and still migrates a later good Session', async () => {
    const root = temporaryRoot()
    const bad = await fixture(root, 'a-bad', 3, 'none', [{ type: 'unrecognized/required', data: {} }])
    const good = await fixture(root, 'z-good', 3, 'none', toolTurn)
    const result = await run('--sessions-dir', root)
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout, readFileSync(result.logPath!, 'utf8')).toContain('converted=1, already-V4=0, failed=1, skipped=0')
    expect(result.stdout).toMatch(/\[1\/2\].*FAILED/u)
    expect(result.stdout).toMatch(/\[2\/2\].*V3 -> V4/u)
    expect(result.stdout).not.toContain('DEFERRED')
    expect(result.stdout).not.toContain('RETRY')
    expect(result.stdout).toContain('Failures (full stacks and causes are in the log):')
    expect(result.stdout).toContain(bad.path)
    expect(readFileSync(result.logPath!, 'utf8')).toContain('unrecognized/required')
    expect(await readFile(bad.path)).toEqual(bad.bytes)
    expect(existsSync(join(bad.directory, 'session.v4.jsonl'))).toBe(false)
    expect(existsSync(join(good.directory, 'session.v4.jsonl'))).toBe(true)
  })

  it('groups matching failures by source version while retaining each input diagnostic', async () => {
    const root = temporaryRoot()
    const event = { type: 'unrecognized/required', data: {} }
    const first = await fixture(root, 'a-v3', 3, 'none', [event])
    const second = await fixture(root, 'b-v3', 3, 'none', [event])
    const legacy = await fixture(root, 'c-v0', 0, 'none', [event])
    const result = await run('--sessions-dir', root)
    expect(result.status, result.stdout + result.stderr).toBe(1)
    const anyString: unknown = expect.any(String)
    expect(result.summary).toMatchObject({
      inputCount: 3,
      totals: { converted: 0, alreadyV4: 0, failed: 3, skipped: 0 },
      bySourceVersion: {
        '0': { converted: 0, alreadyV4: 0, failed: 1, skipped: 0 },
        '3': { converted: 0, alreadyV4: 0, failed: 2, skipped: 0 },
      },
      failureGroups: [
        { sourceVersion: 0, reason: 'unknown_event', eventType: 'unrecognized/required', count: 1,
          items: [{ inputPath: legacy.path, reason: 'unknown_event', errorName: anyString, message: anyString }] },
        { sourceVersion: 3, reason: 'unknown_event', eventType: 'unrecognized/required', count: 2,
          items: [
            { inputPath: first.path, reason: 'unknown_event', errorName: anyString, message: anyString },
            { inputPath: second.path, reason: 'unknown_event', errorName: anyString, message: anyString },
          ] },
      ],
    })
    for (const source of [first, second, legacy]) expect(await readFile(source.path)).toEqual(source.bytes)
  })

  it('groups sequence failures without dropping their distinct sequence coordinates', async () => {
    const root = temporaryRoot()
    const items: Array<{ inputPath: string; expectedSeq: number; actualSeq: number }> = []
    for (const [id, actualSeq] of [['a-gap', 2], ['b-gap', 4]] as const) {
      const source = await fixture(root, id, 2, 'none', [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ])
      await writeFile(source.path, source.bytes.toString().replace('"seq":1', `"seq":${actualSeq}`))
      items.push({ inputPath: source.path, expectedSeq: 1, actualSeq })
    }
    const result = await run('--sessions-dir', root)
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.summary).toMatchObject({
      inputCount: 2,
      totals: { converted: 0, alreadyV4: 0, failed: 2, skipped: 0 },
      bySourceVersion: { '2': { converted: 0, alreadyV4: 0, failed: 2, skipped: 0 } },
      failureGroups: [{ sourceVersion: 2, reason: 'sequence_gap', count: 2, items }],
    })
  })

  it('reports a source-change deferral and retries after the other input completes', async () => {
    const root = temporaryRoot()
    const parent = await fixture(root, 'a-parent', 3, 'none')
    const child = await fixture(root, 'b-child', 3, 'none', [{
      type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'fixture child' },
    }], { origin: 'subagent', parentSession: 'a-parent', createdAt: 2, delegationDepth: 1 })
    const entrypoint = join(temporaryRoot(), 'retry-once.mjs')
    const backendUrl = pathToFileURL(join(repository, 'packages/session/session-persistence-jsonl/src/index.ts')).href
    const generationUrl = pathToFileURL(join(repository, 'packages/session/session-persistence-jsonl/src/generation.ts')).href
    await writeFile(entrypoint, `
      const { default: Backend } = await import(${JSON.stringify(backendUrl)});
      const { JsonlGenerationSourceChangedError } = await import(${JSON.stringify(generationUrl)});
      const open = Backend.prototype.open;
      let changed = false;
      Backend.prototype.open = async function(id, access, options) {
        if (id === 'a-parent' && access === 'write' && !changed) {
          changed = true;
          throw new JsonlGenerationSourceChangedError(${JSON.stringify(child.path)});
        }
        return open.call(this, id, access, options);
      };
      process.argv[1] = ${JSON.stringify(script)};
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `)
    const result = await runAt(entrypoint, '--sessions-dir', root, '--jobs', '2')
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const lines = result.stdout.split('\n')
    const deferred = lines.findIndex(line => line.includes('[1/2]') && line.includes('DEFERRED'))
    const childDone = lines.findIndex(line => line.includes('[2/2]') && line.includes('completed=1/2'))
    const retry = lines.findIndex(line => line.includes('[1/2]') && line.includes('RETRY'))
    expect(deferred).toBeGreaterThanOrEqual(0)
    expect(childDone).toBeGreaterThan(deferred)
    expect(retry).toBeGreaterThan(childDone)
    expect(lines.filter(line => line.includes('RETRY'))).toHaveLength(1)
    expect(result.summary).toMatchObject({ totals: { converted: 2, alreadyV4: 0, failed: 0, skipped: 0 }, failureGroups: [] })
    const target = await readFile(join(parent.directory, 'session.v4.jsonl'), 'utf8')
    expect(target).toContain('"type":"subagent/catalog"')
    for (const source of [parent, child]) expect(await readFile(source.path)).toEqual(source.bytes)
  })

  it('opens an existing V4 torn tail without repairing its bytes', async () => {
    const root = temporaryRoot()
    const current = await fixture(root, 'current', 4, 'none')
    const torn = Buffer.concat([current.bytes, Buffer.from('{"unfinished"')])
    await writeFile(current.path, torn)
    const result = await run('--sessions-dir', root)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('already V4 (opened successfully)')
    expect(await readFile(current.path)).toEqual(torn)
  })

  it('reports unsupported root-level logs and does not traverse directory links', async () => {
    const root = temporaryRoot()
    const outside = temporaryRoot()
    const original = await fixture(outside, 'outside', 3, 'none')
    await writeFile(join(root, 'legacy.jsonl'), original.bytes)
    await symlink(outside, join(root, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await run('--sessions-dir', root)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unsupported flat-file layout')
    expect(result.stdout).toContain('project symbolic links are not traversed')
    expect(existsSync(join(original.directory, 'session.v4.jsonl'))).toBe(false)
  })

  it('shows help, rejects unknown arguments, and logs a missing root failure', async () => {
    const help = await run('--help')
    expect(help.stdout).toContain('Defaults to ~/.dsh/sessions')
    expect(help.stdout).toContain('CPU count capped at 16')
    expect((await run('--unknown')).status).toBe(1)
    const missing = join(temporaryRoot(), 'missing')
    const result = await run('--sessions-dir', missing)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('converted=0, already-V4=0, failed=1, skipped=0')
    expect(result.logPath).toBeDefined()
    expect(result.summary).toMatchObject({
      inputCount: 0,
      totals: { converted: 0, alreadyV4: 0, failed: 1, skipped: 0 },
      bySourceVersion: { unknown: { converted: 0, alreadyV4: 0, failed: 1, skipped: 0 } },
      failureGroups: [{ sourceVersion: 'unknown', count: 1, items: [{ inputPath: missing }] }],
    })
  })

  it.each(['32', '1e2', '+1', '01', ' 1'])('accepts positive safe-integer --jobs %s', async (jobs) => {
    const result = await run('--sessions-dir', temporaryRoot(), '--jobs', jobs)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain(`Session jobs: ${Number(jobs)}`)
    expect(result.stdout).toContain('converted=0, already-V4=0, failed=0, skipped=0')
    expect(result.summary).toMatchObject({
      inputCount: 0,
      totals: { converted: 0, alreadyV4: 0, failed: 0, skipped: 0 },
      bySourceVersion: {},
      failureGroups: [],
    })
  })

  it('runs the entrypoint through a symbolic link to the checkout', async () => {
    const checkout = join(temporaryRoot(), 'checkout')
    await symlink(repository, checkout, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const result = await runAt(join(checkout, 'scripts/migrate-sessions-to-v4.ts'), '--help')
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('Usage: pnpm run migrate:sessions-to-v4')
    } finally {
      await unlink(checkout)
    }
  })

  it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])('rejects invalid --jobs %s before opening a corpus', async (jobs) => {
    const result = await run('--sessions-dir', join(temporaryRoot(), 'missing'), `--jobs=${jobs}`)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--jobs must be a positive safe integer')
    expect(result.stdout).not.toContain('Session migration')
    expect(result.logPath).toBeUndefined()
  })
})
