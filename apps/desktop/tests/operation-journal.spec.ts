import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { OperationJournal } from '../src/operation-journal.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir) }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-operation-journal-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  return directory
}

it('retains two bounded segments after dense operations across 50 plugins', async () => {
  const directory = await fixture()
  const journal = new OperationJournal(directory, { recordBytes: 128, segmentBytes: 1024, queuedBytes: 128 * 1000 })
  onTestFinished(async () => { await journal.close() })
  for (let i = 0; i < 1000; i++) expect(journal.enqueue(JSON.stringify({ plugin: i % 50, operation: i }))).toBe(true)
  await journal.close()
  expect((await readdir(directory)).sort()).toEqual(['operations.jsonl', 'operations.previous.jsonl'])
  for (const name of await readdir(directory)) {
    expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(1024)
    for (const line of (await readFile(join(directory, name), 'utf8')).trim().split('\n')) expect(() => { JSON.parse(line) }).not.toThrow()
  }
  expect(await readFile(join(directory, 'operations.jsonl'), 'utf8')).toContain('"operation":999')
  expect(journal.status()).toEqual({ dropped: 0, failed: 0, queuedBytes: 0, disabled: false, repairedSegments: 0 })
})

it('bounds the queue and encoded record bytes including multibyte characters and newline', async () => {
  const directory = await fixture()
  const journal = new OperationJournal(directory, { recordBytes: 8, segmentBytes: 32, queuedBytes: 16 })
  onTestFinished(async () => { await journal.close() })
  expect(journal.enqueue('{"中":1}')).toBe(false)
  expect(journal.enqueue('{"a":1}')).toBe(true)
  expect(journal.enqueue('{"a":2}')).toBe(true)
  expect(journal.enqueue('{"a":3}')).toBe(false)
  expect(journal.status()).toMatchObject({ queuedBytes: 16, dropped: 2 })
  await journal.close()
  expect(await readFile(join(directory, 'operations.jsonl'), 'utf8')).toBe('{"a":1}\n{"a":2}\n')
  expect(journal.enqueue('{}')).toBe(false)
})

it('disables persistence after a write failure without rejecting producers or close', async () => {
  const directory = await fixture()
  const blocked = join(directory, 'file')
  await writeFile(blocked, 'untouched')
  const journal = new OperationJournal(blocked, { recordBytes: 32, segmentBytes: 64, queuedBytes: 64 })
  expect(journal.enqueue('{"operation":1}')).toBe(true)
  await expect(journal.close()).resolves.toBeUndefined()
  expect(journal.status()).toEqual({ dropped: 0, failed: 1, queuedBytes: 0, disabled: true, repairedSegments: 0 })
  expect(await readFile(blocked, 'utf8')).toBe('untouched')
})

it.each(['', '{"old":1}\n'])('preserves both segments when repairing a partial append after %j', async (prefix) => {
  const directory = await fixture()
  const previous = '{"previous":0}\n'
  await writeFile(join(directory, 'operations.previous.jsonl'), previous)
  await writeFile(join(directory, 'operations.jsonl'), prefix + '{"partial":')
  const journal = new OperationJournal(directory, { recordBytes: 32, segmentBytes: 64, queuedBytes: 64 })
  expect(journal.enqueue('{"new":2}')).toBe(true)
  await journal.close()
  expect(await readFile(join(directory, 'operations.jsonl'), 'utf8')).toBe(prefix + '{"new":2}\n')
  expect(await readFile(join(directory, 'operations.previous.jsonl'), 'utf8')).toBe(previous)
  expect(journal.status()).toMatchObject({ repairedSegments: 1, disabled: false })
})

it('bounds both pre-existing oversized segments before writing new records', async () => {
  const directory = await fixture()
  for (const name of ['operations.jsonl', 'operations.previous.jsonl']) await writeFile(join(directory, name), 'x'.repeat(1000))
  const journal = new OperationJournal(directory, { recordBytes: 32, segmentBytes: 64, queuedBytes: 64 })
  journal.enqueue('{"new":2}')
  await journal.close()
  for (const name of await readdir(directory)) expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(64)
  expect(journal.status()).toMatchObject({ repairedSegments: 2, disabled: false })
})

it('stops scheduling writes after a drain deadline without claiming the in-flight request ended', async () => {
  const directory = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.mocked(mkdir).mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return undefined })
  const journal = new OperationJournal(directory, { recordBytes: 32, segmentBytes: 64, queuedBytes: 64 })
  onTestFinished(async () => { release.resolve(undefined); await journal.close(); vi.useRealTimers() })
  journal.enqueue('{"operation":1}')
  await entered.promise
  vi.useFakeTimers()
  const draining = journal.drain(500)
  await vi.advanceTimersByTimeAsync(500)
  expect(await draining).toBe(false)
  expect(journal.status()).toMatchObject({ disabled: true, queuedBytes: 16 })
  expect(journal.enqueue('{"operation":2}')).toBe(false)
  let repeated: boolean | undefined
  void journal.drain(500).then((result) => { repeated = result })
  await vi.advanceTimersByTimeAsync(0)
  expect(repeated).toBe(false)
  release.resolve(undefined)
  await journal.close()
  expect(await readdir(directory)).toEqual([])
  expect(journal.status()).toMatchObject({ failed: 1, queuedBytes: 0 })
})

it('can keep recording after successful installer preparation when the installer later fails', async () => {
  const directory = await fixture()
  const journal = new OperationJournal(directory, { recordBytes: 32, segmentBytes: 64, queuedBytes: 64 })
  onTestFinished(async () => { await journal.close() })
  journal.enqueue('{"operation":1}')
  expect(await journal.drain(1000)).toBe(true)
  expect(journal.enqueue('{"operation":2}')).toBe(true)
  await journal.close()
  expect(await readFile(join(directory, 'operations.jsonl'), 'utf8')).toBe('{"operation":1}\n{"operation":2}\n')
})
