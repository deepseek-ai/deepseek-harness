import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { mergeReportDirectories, renderMergedReport } from '../benchmarks/support/scaling-report.ts'

/** A private directory removed when the current test finishes. */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-benchmark-report-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

const machine = { cpuModel: 'AMD EPYC 9454P', platform: 'linux-x64', node: 'v24.12.0', cores: 4, measuredProfile: 'ci-4' }

/** Write one phase report directory as a benchmark job uploads it. */
async function writePhase(root: string, name: string, benchmarks: readonly string[], environment: object = machine): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  const records = benchmarks.map(benchmark => ({ kind: 'time', benchmark, measures: 'm', affects: 'a', metric: 'ms', ms: 10, cpuMs: 9 }))
  await writeFile(join(directory, 'results.jsonl'), records.map(record => JSON.stringify(record) + '\n').join(''))
  await writeFile(join(directory, 'environment.json'), JSON.stringify(environment))
  return directory
}

describe('merged benchmark report', () => {
  it('concatenates the phase records and keeps the shared measuring machine', async () => {
    const root = await temporaryRoot()
    const first = await writePhase(root, 'benchmark-results-1', ['session-corpus/list'])
    const last = await writePhase(root, 'benchmark-results-2', ['user-text/paste', 'session-open/first-open'])

    const { data, warnings } = mergeReportDirectories([first, last], 'abc123', '2026-11-20T00:00:00.000Z')

    expect(data.records.map(record => record.benchmark)).toEqual(['session-corpus/list', 'user-text/paste', 'session-open/first-open'])
    expect(data).toMatchObject({ ...machine, revision: 'abc123', generatedAt: '2026-11-20T00:00:00.000Z' })
    expect(warnings).toEqual([])
  })

  it('lists both CPUs and leaves the measured profile to the reader when the phases ran on different machines', async () => {
    const root = await temporaryRoot()
    const first = await writePhase(root, 'benchmark-results-1', ['a'])
    const last = await writePhase(root, 'benchmark-results-2', ['b'], { ...machine, cpuModel: 'Intel Xeon 8375C', measuredProfile: 'other' })

    const { data, warnings } = mergeReportDirectories([first, last], undefined, 'now')

    expect(data.cpuModel).toBe('AMD EPYC 9454P | Intel Xeon 8375C')
    expect(data.measuredProfile).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('skips a phase that recorded nothing and refuses when no phase did', async () => {
    const root = await temporaryRoot()
    const first = await writePhase(root, 'benchmark-results-1', ['a'])
    const empty = join(root, 'benchmark-results-2')
    await mkdir(empty)

    expect(mergeReportDirectories([first, empty], undefined, 'now').data.records).toHaveLength(1)
    expect(() => mergeReportDirectories([empty], undefined, 'now')).toThrow(/no benchmark results/)
  })

  it('refuses results without a valid measuring environment', async () => {
    const root = await temporaryRoot()
    const phase = await writePhase(root, 'benchmark-results-1', ['a'], { cpuModel: 'x', cores: 0 })

    expect(() => mergeReportDirectories([phase], undefined, 'now')).toThrow(/must record cpuModel/)
  })

  it('writes one report page into the output directory', async () => {
    const root = await temporaryRoot()
    const phase = await writePhase(root, 'benchmark-results-1', ['session-corpus/list'])
    const output = join(root, 'report')

    expect(renderMergedReport(output, [phase])).toEqual([])
    expect(await readFile(join(output, 'report.html'), 'utf8')).toContain('session-corpus/list')
  })
})
