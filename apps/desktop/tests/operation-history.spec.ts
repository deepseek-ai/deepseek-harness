import { appendFile, mkdtemp, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import type { BigIntStats, StatOptions, Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { readOperationHistory } from '../src/operation-history.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const limits = { bytes: 64 * 1024, recordBytes: 2048, records: 100 }
beforeEach(() => { vi.mocked(open).mockClear() })
function record(id: string | number) {
  return { runId: 'c254ab28-97c9-4382-95e6-2db9c66f98c8', transportDropped: 0,
    operation: { id: 'c254ab28-97c9-4382-95e6-2db9c66f98c9', time: '2026-10-19T00:00:00.000Z',
      reason: 'plugin', phase: 'started', target: String(id), stage: 'enable' } }
}
function line(id: string | number) { return JSON.stringify(record(id)) + '\n' }

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'desktop-operation-history-'))
  onTestFinished(async () => { await rm(path, { recursive: true, force: true }) })
  return path
}

it('collects recent complete records and reports malformed and incomplete entries', async () => {
  const path = await fixture()
  const current = line(1) + '{broken}\n' + line(2) + '{"incomplete":'
  await writeFile(join(path, 'operations.jsonl'), current)
  await writeFile(join(path, 'operations.previous.jsonl'), line(0))
  const result = await readOperationHistory(path, limits, new AbortController().signal)
  // The whole result is asserted so a missing record also names the collection facts that caused it.
  expect(result).toEqual({
    records: [record(2), record(1), record(0)],
    bytesRead: Buffer.byteLength(current) + Buffer.byteLength(line(0)),
    filesRead: 2,
    truncated: true,
    invalidRecords: 1,
    unavailableFiles: 0,
    cancelled: false,
  })
})

it('does not collect a rotated predecessor twice after it was appended', async () => {
  const path = await fixture()
  const current = join(path, 'operations.jsonl')
  const previous = join(path, 'operations.previous.jsonl')
  await writeFile(current, line(1))
  const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const handle = await open(current, 'r')
  const opener = vi.mocked(open).mockClear()
    .mockImplementationOnce(async () => handle)
    .mockImplementationOnce(async () => {
      // The writer appends one record, then rotates: both names still denote one file.
      await appendFile(current, line(2))
      await rename(current, previous)
      await writeFile(current, line(3))
      return actualFs.open(previous, 'r')
    })
  try {
    const result = await readOperationHistory(path, limits, new AbortController().signal)
    expect(result.records).toEqual([record(1)])
    expect(result).toMatchObject({ filesRead: 1, truncated: true, unavailableFiles: 0 })
  } finally {
    opener.mockClear()
  }
})

it('compares exact bigint identities so two nearby Numbers cannot collapse one segment', async () => {
  const path = await fixture()
  const current = join(path, 'operations.jsonl')
  const previous = join(path, 'operations.previous.jsonl')
  const currentText = line('current')
  const previousText = line('old')
  await writeFile(current, currentText)
  await writeFile(previous, previousText)
  const currentHandle = await open(current, 'r')
  const previousHandle = await open(previous, 'r')
  onTestFinished(async () => { await currentHandle.close(); await previousHandle.close() })
  const currentStat = await currentHandle.stat({ bigint: true })
  const previousStat = await previousHandle.stat({ bigint: true })
  const currentNumberStat = await currentHandle.stat()
  const previousNumberStat = await previousHandle.stat()
  // Adjacent 64-bit file IDs: distinct as bigints, one Number after the 53-bit mantissa.
  const base = 2n ** 58n + 1000n
  currentStat.dev = 0n
  currentStat.ino = base
  previousStat.dev = 0n
  previousStat.ino = base + 1n
  currentNumberStat.dev = 0
  currentNumberStat.ino = Number(base)
  previousNumberStat.dev = 0
  previousNumberStat.ino = Number(base + 1n)
  expect(currentNumberStat.ino).toBe(previousNumberStat.ino)
  const optionAware = (exact: BigIntStats, numeric: Stats) =>
    async (options?: StatOptions): Promise<BigIntStats | Stats> => options?.bigint === true ? exact : numeric
  const currentStats = vi.spyOn(currentHandle, 'stat').mockImplementation(optionAware(currentStat, currentNumberStat))
  const previousStats = vi.spyOn(previousHandle, 'stat').mockImplementation(optionAware(previousStat, previousNumberStat))
  const opener = vi.mocked(open).mockClear().mockResolvedValueOnce(currentHandle).mockResolvedValueOnce(previousHandle)
  try {
    const result = await readOperationHistory(path, limits, new AbortController().signal)
    expect(result.records).toEqual([record('current'), record('old')])
    expect(result).toMatchObject({ filesRead: 2, unavailableFiles: 0, truncated: false })
  } finally {
    currentStats.mockRestore()
    previousStats.mockRestore()
    opener.mockClear()
  }
})

it('retries transient Windows sharing failures while opening a segment', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const opener = vi.mocked(open)
  onTestFinished(async () => {
    platform.mockRestore()
    opener.mockReset().mockImplementation(actualFs.open)
  })
  const path = await fixture()
  await writeFile(join(path, 'operations.jsonl'), line(2))
  await writeFile(join(path, 'operations.previous.jsonl'), line(1))
  opener.mockRejectedValueOnce(Object.assign(new Error('sharing violation'), { code: 'EBUSY' }))
  const result = await readOperationHistory(path, limits, new AbortController().signal)
  expect(result.records).toEqual([record(2), record(1)])
  expect(result.unavailableFiles).toBe(0)
  expect(opener).toHaveBeenCalledTimes(3)
})

it('counts a segment unavailable after bounded Windows open retries expire', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const opener = vi.mocked(open)
  onTestFinished(async () => {
    platform.mockRestore()
    opener.mockReset().mockImplementation(actualFs.open)
  })
  const path = await fixture()
  await writeFile(join(path, 'operations.jsonl'), line(2))
  await writeFile(join(path, 'operations.previous.jsonl'), line(1))
  for (let attempt = 0; attempt <= 4; attempt++) {
    opener.mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EPERM' }))
  }
  const result = await readOperationHistory(path, limits, new AbortController().signal)
  expect(result.records).toEqual([record(1)])
  expect(result.unavailableFiles).toBe(1)
  expect(opener).toHaveBeenCalledTimes(6)
})

it('does not retry a Windows transient code outside Windows', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const opener = vi.mocked(open)
  onTestFinished(async () => {
    platform.mockRestore()
    opener.mockReset().mockImplementation(actualFs.open)
  })
  const path = await fixture()
  await writeFile(join(path, 'operations.jsonl'), line(2))
  await writeFile(join(path, 'operations.previous.jsonl'), line(1))
  opener.mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EPERM' }))
  const result = await readOperationHistory(path, limits, new AbortController().signal)
  expect(result.records).toEqual([record(1)])
  expect(result.unavailableFiles).toBe(1)
  expect(opener).toHaveBeenCalledTimes(2)
})

it('stops Windows open retries when the collection is already cancelled', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const opener = vi.mocked(open)
  onTestFinished(async () => {
    platform.mockRestore()
    opener.mockReset().mockImplementation(actualFs.open)
  })
  const path = await fixture()
  await writeFile(join(path, 'operations.jsonl'), line(2))
  const controller = new AbortController()
  opener.mockImplementationOnce(async () => {
    controller.abort()
    throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' })
  })
  const result = await readOperationHistory(path, limits, controller.signal)
  expect(result).toMatchObject({ records: [], cancelled: true, unavailableFiles: 1 })
  expect(opener).toHaveBeenCalledTimes(1)
})

it('stops Windows open retries when cancellation lands during the retry wait', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const opener = vi.mocked(open)
  onTestFinished(async () => {
    platform.mockRestore()
    opener.mockReset().mockImplementation(actualFs.open)
  })
  const path = await fixture()
  await writeFile(join(path, 'operations.jsonl'), line(2))
  const controller = new AbortController()
  opener.mockImplementationOnce(async () => {
    setImmediate(() => { controller.abort() })
    throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' })
  })
  const result = await readOperationHistory(path, limits, controller.signal)
  expect(result).toMatchObject({ records: [], cancelled: true, unavailableFiles: 1 })
  expect(opener).toHaveBeenCalledTimes(1)
})

it('reads no more than its byte budget from a two GiB file and ignores unrelated history', async () => {
  const path = await fixture()
  await using large = await open(join(path, 'operations.jsonl'), 'w')
  const size = 2 * 1024 * 1024 * 1024
  await large.truncate(size)
  const tail = Buffer.from('\n' + line('last'))
  await large.write(tail, 0, tail.length, size - tail.length)
  await writeFile(join(path, 'pnpm.log'), 'unrelated output')
  const result = await readOperationHistory(path, limits, new AbortController().signal)
  expect(result.records).toEqual([record('last')])
  expect(result.bytesRead).toBe(limits.bytes)
  expect(result.truncated).toBe(true)
})

it('bounds parsed record size and output count independently', async () => {
  const path = await fixture()
  await writeFile(join(path, 'operations.jsonl'), line(1) + '{"large":"' + 'x'.repeat(4096) + '"}\n' + line(2))
  const result = await readOperationHistory(path, { ...limits, records: 2 }, new AbortController().signal)
  expect(result.records).toEqual([record(2), record(1)])
  expect(result.invalidRecords).toBe(1)
})

it('returns immediately without I/O when already cancelled', async () => {
  const result = await readOperationHistory('not-a-directory', limits, AbortSignal.abort())
  expect(result).toMatchObject({ records: [], bytesRead: 0, cancelled: true, unavailableFiles: 0 })
})

it('reports unreadable segments without failing the whole collection', async () => {
  const path = await fixture()
  await mkdir(join(path, 'operations.jsonl'))
  await writeFile(join(path, 'operations.previous.jsonl'), line(1))
  const result = await readOperationHistory(path, limits, new AbortController().signal)
  expect(result.records).toEqual([record(1)])
  expect(result.unavailableFiles).toBe(1)
})

it('awaits an in-flight read before closing and schedules no further reads after cancellation', async () => {
  const path = await fixture()
  const filename = join(path, 'operations.jsonl')
  await writeFile(filename, ' '.repeat(limits.bytes))
  const handle = await open(filename, 'r')
  onTestFinished(async () => { await handle.close() })
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const opener = vi.mocked(open).mockClear().mockResolvedValueOnce(handle)
  const reader = vi.spyOn(handle, 'read').mockImplementationOnce(async () => {
    started.resolve(undefined)
    await release.promise
    return { bytesRead: 1, buffer: Buffer.alloc(1) }
  })
  const controller = new AbortController()
  let settled = false
  const collecting = readOperationHistory(path, limits, controller.signal)
    .then((result) => { settled = true; return result })
  try {
    await started.promise
    controller.abort()
    await Promise.resolve(undefined)
    expect(settled).toBe(false)
    expect(handle.fd).not.toBe(-1)
    release.resolve(undefined)
    expect(await collecting).toMatchObject({ cancelled: true, bytesRead: 1, records: [] })
    expect(handle.fd).toBe(-1)
    expect(reader).toHaveBeenCalledTimes(1)
    expect(opener).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve(undefined)
    await collecting
    reader.mockRestore()
    opener.mockClear()
    await handle.close()
  }
})

it('contains truncation between stat and read and still collects the previous segment', async () => {
  const path = await fixture()
  const filename = join(path, 'operations.jsonl')
  await writeFile(filename, line(2))
  await writeFile(join(path, 'operations.previous.jsonl'), line(1))
  const handle = await open(filename, 'r+')
  onTestFinished(async () => { await handle.close() })
  const originalStat = await handle.stat()
  const stat = vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
    await handle.truncate(0)
    return originalStat
  })
  const opener = vi.mocked(open).mockClear().mockResolvedValueOnce(handle)
  try {
    const result = await readOperationHistory(path, limits, new AbortController().signal)
    expect(result).toMatchObject({ records: [record(1)], truncated: true, unavailableFiles: 0 })
    expect(handle.fd).toBe(-1)
  } finally {
    stat.mockRestore()
    opener.mockClear()
    await handle.close()
  }
})

it('rejects invalid resource budgets before opening a file', async () => {
  for (const bytes of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(readOperationHistory('not-a-directory', { ...limits, bytes }, new AbortController().signal))
      .rejects.toThrow(RangeError)
  }
})

it('does not collect the same open segment twice when it rotates during collection', async () => {
  const path = await fixture()
  const current = join(path, 'operations.jsonl')
  await writeFile(current, line(1))
  const handle = await open(current, 'r')
  onTestFinished(async () => { await handle.close() })
  const opener = vi.mocked(open).mockImplementationOnce(async () => {
    await rename(current, join(path, 'operations.previous.jsonl'))
    await writeFile(current, line(2))
    return handle
  })
  try {
    const result = await readOperationHistory(path, limits, new AbortController().signal)
    expect(result.records).toEqual([record(1)])
    expect(result).toMatchObject({ filesRead: 1, truncated: true })
    expect(handle.fd).toBe(-1)
  } finally {
    opener.mockClear()
    await handle.close()
  }
})

it('does not re-collect a rotated segment while the current path is briefly absent', async () => {
  const path = await fixture()
  const current = join(path, 'operations.jsonl')
  await writeFile(current, line(1))
  const handle = await open(current, 'r')
  onTestFinished(async () => { await handle.close() })
  const opener = vi.mocked(open).mockClear().mockImplementationOnce(async () => {
    await rename(current, join(path, 'operations.previous.jsonl'))
    return handle
  })
  try {
    const result = await readOperationHistory(path, limits, new AbortController().signal)
    expect(result.records).toEqual([record(1)])
    expect(result).toMatchObject({ filesRead: 1, truncated: true })
    expect(handle.fd).toBe(-1)
  } finally {
    opener.mockClear()
    await handle.close()
  }
})

it.each(['absent', 'empty', 'nonempty'])('reports omitted bytes at an exact budget: previous segment %s', async (previous) => {
  const path = await fixture()
  const current = line(1)
  await writeFile(join(path, 'operations.jsonl'), current)
  if (previous !== 'absent') await writeFile(join(path, 'operations.previous.jsonl'), previous === 'empty' ? '' : line(0))
  const result = await readOperationHistory(path,
    { ...limits, bytes: Buffer.byteLength(current), records: 1 }, new AbortController().signal)
  expect(result.records).toEqual([record(1)])
  expect(result.truncated).toBe(previous === 'nonempty')
  expect(result.filesRead).toBe(1)
})
