/** Built job and packaged Worker acceptance without provider credentials. */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { expect, it, onTestFinished } from 'vitest'

const job = new URL('../lib/types/operation-report-job.js', import.meta.url)
const worker = new URL('../lib/operation-report-worker.js', import.meta.url)

it.skipIf(!existsSync(new URL('../lib/types/', import.meta.url)))('appends operation history through the built job and packaged Worker', async () => {
  expect(existsSync(job), 'built report job').toBe(true)
  expect(existsSync(worker), 'packaged report Worker').toBe(true)
  const directory = await mkdtemp(join(tmpdir(), 'desktop-operation-worker-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const record = { runId: 'c254ab28-97c9-4382-95e6-2db9c66f98c8', transportDropped: 0,
    operation: { id: 'c254ab28-97c9-4382-95e6-2db9c66f98c9', time: '2026-10-19T00:00:00.000Z',
      reason: 'bundle', phase: 'started', target: 'real-worker-test', stage: 'enable' } }
  await writeFile(join(directory, 'operations.jsonl'), JSON.stringify(record) + '\n')
  for (const mode of ['job', 'packaged']) {
    const reportPath = join(directory, mode + '.log')
    await writeFile(reportPath, 'basic report\n')
    const input = { reportPath, directory, journal: null,
      limits: { bytes: 65536, recordBytes: 4096, records: 100, outputBytes: 65536 } }
    const script = join(directory, mode + '.mjs')
    await writeFile(script, mode === 'job'
      ? `import { runOperationReportJob } from ${JSON.stringify(job.href)};\nconsole.log(JSON.stringify(await runOperationReportJob(${JSON.stringify(input)}, { timeoutMs: 10000, cancellationGraceMs: 100 }, new AbortController().signal)));\n`
      : `import { Worker } from 'node:worker_threads';\nconst worker = new Worker(${JSON.stringify(fileURLToPath(worker))}, { workerData: ${JSON.stringify(input)} });\nworker.on('error', error => { throw error });\nworker.on('exit', code => { if (code !== 0) process.exitCode = 1 });\n`)
    const result = await execa(process.execPath, [script], { timeout: 30000, reject: false })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    if (mode === 'job') expect(JSON.parse(result.stdout)).toEqual({ appended: true, timedOut: false, cancelled: false })
    const report = await readFile(reportPath, 'utf8')
    expect(report.startsWith('basic report\n')).toBe(true)
    const summary = JSON.parse(report.split('\n').find(line => line.startsWith('{'))!) as { records: unknown[] }
    expect(summary.records).toEqual([record])
    expect(report).toContain('operation history collection complete')
  }
})

it.skipIf(!existsSync(new URL('../lib/types/', import.meta.url)))('cancels the packaged Worker after an in-flight open settles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-operation-cancel-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const reportPath = join(directory, 'report.log')
  await writeFile(reportPath, 'basic report\n')
  await writeFile(join(directory, 'operations.jsonl'), '{}\n')
  const hook = join(directory, 'hook.mjs')
  await writeFile(hook, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { parentPort } from 'node:worker_threads';
const original = fs.open;
fs.open = async (...args) => {
  const handle = await original(...args);
  parentPort.postMessage('opened');
  await new Promise(resolve => parentPort.once('message', resolve));
  return handle;
};
syncBuiltinESMExports();
`)
  const input = { reportPath, directory, journal: null,
    limits: { bytes: 65536, recordBytes: 4096, records: 100, outputBytes: 65536 } }
  const script = join(directory, 'cancel.mjs')
  await writeFile(script, `import { Worker } from 'node:worker_threads';
const worker = new Worker(${JSON.stringify(fileURLToPath(worker))}, {
  workerData: ${JSON.stringify(input)}, execArgv: ['--import', ${JSON.stringify(pathToFileURL(hook).href)}]
});
worker.on('message', message => {
  if (message === 'opened') worker.postMessage('cancel');
  else console.log(JSON.stringify(message));
});
worker.on('error', error => { throw error });
worker.on('exit', code => { process.exitCode = code });
`)
  const result = await execa(process.execPath, [script], { timeout: 30000, reject: false })
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toBe('false')
  expect(await readFile(reportPath, 'utf8')).toBe('basic report\n')
})
