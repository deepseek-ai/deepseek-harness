import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { appendOperationReport } from '../src/operation-report.ts'
import { writeCrashReport, type CrashReportInput } from '../src/crash-report.ts'

const input: CrashReportInput = {
  operationHistoryPlanned: true, source: 'host', phase: 'startup', error: new Error('startup failed'),
  rendererConsole: [], time: new Date('2026-10-19T00:00:00Z'),
  app: { name: 'test', version: '1', platform: 'win32', arch: 'x64', electron: '44', node: '24', locale: 'zh-CN' },
}
const limits = { bytes: 65536, recordBytes: 4096, records: 100, outputBytes: 65536 }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-operation-report-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const report = await writeCrashReport(directory, input)
  if (report === undefined) throw new Error('Basic report fixture was not saved')
  return { directory, report, basic: await readFile(report, 'utf8') }
}

it('preserves the independently saved basic report and appends whitelisted recent history', async () => {
  const { directory, report, basic } = await fixture()
  const record = { runId: 'c254ab28-97c9-4382-95e6-2db9c66f98c8', transportDropped: 0,
    operation: { id: 'c254ab28-97c9-4382-95e6-2db9c66f98c9', time: '2026-10-19T00:00:00.000Z',
      reason: 'bundle', phase: 'started', target: 'test-bundle', stage: 'enable', diagnostic: 'secret' } }
  await writeFile(join(directory, 'operations.jsonl'), JSON.stringify(record) + '\n')
  expect(await appendOperationReport(report, directory, limits, new AbortController().signal, null)).toBe(true)
  const combined = await readFile(report, 'utf8')
  expect(combined.startsWith(basic)).toBe(true)
  expect(combined).toContain('test-bundle')
  expect(combined).not.toContain('secret')
  expect(combined).toContain('operation history collection complete')
  await expect(combined.slice(basic.length)).toMatchFileSnapshot('./expected/operation-history.txt')
})

it('leaves basic bytes unchanged when collection is cancelled or fails before append', async () => {
  const { directory, report, basic } = await fixture()
  expect(await appendOperationReport(report, directory, limits, AbortSignal.abort(), null)).toBe(false)
  expect(await appendOperationReport(report, directory, { ...limits, bytes: 0 }, new AbortController().signal, null)).toBe(false)
  expect(await readFile(report, 'utf8')).toBe(basic)
  expect(basic).toContain('unavailable or incomplete')
})

it('bounds the entire appended section and refuses a budget smaller than its metadata', async () => {
  const { directory, report, basic } = await fixture()
  expect(await appendOperationReport(report, directory, { ...limits, outputBytes: 1 }, new AbortController().signal, null)).toBe(false)
  expect(await readFile(report, 'utf8')).toBe(basic)
  expect(await appendOperationReport(report, directory, { ...limits, outputBytes: 512 }, new AbortController().signal, null)).toBe(true)
  const summary = (await readFile(report, 'utf8')).slice(basic.length)
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(512)
  expect(summary).toContain('"outputRecordsOmitted":0')
})

it('omits oldest records to fit the output budget, counting UTF-8 bytes and all metadata', async () => {
  const { directory, report, basic } = await fixture()
  const records = Array.from({ length: 20 }, (_, index) => ({
    runId: 'c254ab28-97c9-4382-95e6-2db9c66f98c8', transportDropped: 0,
    operation: { id: 'c254ab28-97c9-4382-95e6-2db9c66f98c9', time: '2026-10-19T00:00:00.000Z',
      reason: 'bundle', phase: 'started', target: `测试插件-${index}`, stage: 'enable' },
  }))
  await writeFile(join(directory, 'operations.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  expect(await appendOperationReport(report, directory, { ...limits, outputBytes: 1024 }, new AbortController().signal, null)).toBe(true)
  const section = (await readFile(report, 'utf8')).slice(basic.length)
  expect(Buffer.byteLength(section)).toBeLessThanOrEqual(1024)
  const summary = JSON.parse(section.split('\n').find(line => line.startsWith('{'))!) as {
    outputRecordsOmitted: number
    records: { operation: { target: string } }[]
  }
  expect(summary.outputRecordsOmitted).toBeGreaterThan(0)
  expect(summary.records.length + summary.outputRecordsOmitted).toBe(20)
  expect(summary.records[0]?.operation.target).toBe('测试插件-19')
})
