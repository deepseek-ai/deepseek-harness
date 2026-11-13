import { strToU8, zipSync } from 'fflate'
import type { Zippable } from 'fflate'
import { describe, expect, it } from 'vitest'
import { ExportSourceError, openExportArchive } from '../src/archive.ts'
import type { ExportArchive, ExportEntryInfo, ExportStreamHandler } from '../src/archive.ts'
import {
  damagedZip, duplicateNameZip, localCompressedSizeZip, localNameZip, misdeclaredZip,
} from './helpers/zip.ts'

const LIMIT = 1024
const live = (): AbortSignal => new AbortController().signal
const decode = (bytes: Uint8Array | undefined): string | undefined => bytes === undefined ? undefined : new TextDecoder().decode(bytes)

/** Records what a streaming pass offered, accepted, and rejected. */
function recorder(select: (entry: ExportEntryInfo) => boolean = () => true) {
  const offered: string[] = []
  const delivered = new Map<string, Uint8Array>()
  const rejected: Array<{ readonly name: string; readonly oversized: boolean; readonly message: string }> = []
  const handler: ExportStreamHandler = {
    select: (entry) => {
      offered.push(entry.name)
      return select(entry)
    },
    entry: (entry, data) => {
      delivered.set(entry.name, data)
      return Promise.resolve()
    },
    reject: (entry, error) => {
      rejected.push({ name: entry.name, oversized: error.oversized, message: error.message })
    },
  }
  return { handler, offered, delivered, rejected }
}

/** Bytes that deflate cannot shrink, so their compressed size spans archive slices. */
function incompressible(size: number): Uint8Array {
  const data = new Uint8Array(size)
  let state = 123456789
  for (let index = 0; index < size; index++) {
    state = (state * 1103515245 + 12345) >>> 0
    data[index] = state & 0xff
  }
  return data
}

/** A ZIP holding one conversation file and a manifest. */
const conversationZip = (): Uint8Array => zipSync({
  'manifest.json': strToU8('{"export_format_version":3}'),
  'chat_sessions/a.json': strToU8('{"id":"a"}'),
  'chat_sessions/b.json': strToU8('{"id":"b"}'),
  'chat_sessions/a_files/img-1-x.png': new Uint8Array([1, 2, 3]),
})

/** Run one streaming pass and return what it recorded. */
async function pass(archive: ExportArchive, select?: (entry: ExportEntryInfo) => boolean) {
  const record = recorder(select)
  await archive.stream(record.handler, live())
  return record
}

describe('openExportArchive', () => {
  it('rejects bytes that are not a ZIP archive', async () => {
    await expect(openExportArchive(strToU8('plain text'), LIMIT, live()))
      .rejects.toThrow(new ExportSourceError('unreadable-archive', 'the uploaded file is not a readable ZIP archive'))
  })

  it('rejects an archive that lists two entries under one name before any pass starts', async () => {
    const archive = duplicateNameZip({
      'chat_sessions/a.json': strToU8('{"id":"a"}'),
      'chat_sessions/b.json': strToU8('{"id":"b"}'),
    }, 'chat_sessions/a.json', 'chat_sessions/b.json')
    await expect(openExportArchive(archive, LIMIT, live()))
      .rejects.toThrow(new ExportSourceError('unreadable-archive', 'the archive has more than one entry named chat_sessions/a.json'))
  })

  it('reads one entry by name and reports a missing one', async () => {
    const archive = await openExportArchive(conversationZip(), LIMIT, live())
    expect(decode(await archive.read('manifest.json', live()))).toBe('{"export_format_version":3}')
    expect([...await archive.read('chat_sessions/a_files/img-1-x.png', live()) ?? []]).toEqual([1, 2, 3])
    expect(await archive.read('missing.png', live())).toBeUndefined()
  })

  it('never yields more bytes than an entry declares', async () => {
    const archive = await openExportArchive(misdeclaredZip({ 'chat_sessions/a.json': [new Uint8Array(LIMIT * 64), { level: 9 }] }, 'chat_sessions/a.json', 16), LIMIT, live())
    expect((await archive.read('chat_sessions/a.json', live()))?.byteLength).toBe(16)
  })

  it('reports a damaged entry when it is read by name', async () => {
    const archive = await openExportArchive(damagedZip({ 'chat_sessions/a.json': strToU8('{"id":"a"}') }, 'chat_sessions/a.json'), LIMIT, live())
    await expect(archive.read('chat_sessions/a.json', live())).rejects.toMatchObject({
      name: 'ExportEntryError', oversized: false, message: 'chat_sessions/a.json cannot be decompressed',
    })
  })

  it('refuses an oversized entry before inflating it', async () => {
    const bomb = zipSync({ 'chat_sessions/bomb.json': [new Uint8Array(LIMIT * 64), { level: 9 }] })
    expect(bomb.byteLength).toBeLessThan(LIMIT)
    const archive = await openExportArchive(bomb, LIMIT, live())
    await expect(archive.read('chat_sessions/bomb.json', live())).rejects.toMatchObject({
      oversized: true,
      message: `chat_sessions/bomb.json declares ${LIMIT * 64} uncompressed bytes, more than the ${LIMIT}-byte entry limit`,
    })
  })
})

describe('ExportArchive.stream', () => {
  it('visits every entry in archive order and inflates only the selected ones', async () => {
    const archive = await openExportArchive(conversationZip(), LIMIT, live())
    const record = await pass(archive, entry => entry.name.startsWith('chat_sessions/') && entry.name.endsWith('.json'))
    expect(record.offered).toEqual(['manifest.json', 'chat_sessions/a.json', 'chat_sessions/b.json', 'chat_sessions/a_files/img-1-x.png'])
    expect([...record.delivered.keys()]).toEqual(['chat_sessions/a.json', 'chat_sessions/b.json'])
    expect(decode(record.delivered.get('chat_sessions/b.json'))).toBe('{"id":"b"}')
    expect(record.rejected).toEqual([])
  })

  it('reports an entry whose declared uncompressed size exceeds the limit without inflating it', async () => {
    const archive = await openExportArchive(zipSync({
      'manifest.json': strToU8('{"export_format_version":3}'),
      'chat_sessions/bomb.json': [new Uint8Array(LIMIT * 64), { level: 9 }],
    }), LIMIT, live())
    const record = await pass(archive)
    expect(record.rejected).toEqual([{
      name: 'chat_sessions/bomb.json', oversized: true,
      message: `chat_sessions/bomb.json declares ${LIMIT * 64} uncompressed bytes, more than the ${LIMIT}-byte entry limit`,
    }])
    expect([...record.delivered.keys()]).toEqual(['manifest.json'])
  })

  it('reports a stored entry whose declared size disagrees with the bytes it holds as damage, not as oversize', async () => {
    // A stored entry is copied by its compressed size: declaring 16 bytes would otherwise let 1 KiB through.
    const archive = await openExportArchive(
      misdeclaredZip({ 'chat_sessions/a.json': [new Uint8Array(LIMIT), { level: 0 }] }, 'chat_sessions/a.json', 16), LIMIT, live())
    const record = await pass(archive)
    expect(record.rejected).toEqual([{
      name: 'chat_sessions/a.json', oversized: false,
      message: `chat_sessions/a.json declares 16 uncompressed bytes but stores ${LIMIT} bytes`,
    }])
    expect(record.delivered.has('chat_sessions/a.json')).toBe(false)
  })

  it('reports a stored entry whose bytes exceed the limit as oversized', async () => {
    const archive = await openExportArchive(
      misdeclaredZip({ 'chat_sessions/a.json': [new Uint8Array(LIMIT * 2), { level: 0 }] }, 'chat_sessions/a.json', 16), LIMIT, live())
    const record = await pass(archive)
    expect(record.rejected).toEqual([{
      name: 'chat_sessions/a.json', oversized: true,
      message: `chat_sessions/a.json stores ${LIMIT * 2} bytes, more than the ${LIMIT}-byte entry limit`,
    }])
  })

  it('stops accumulating an entry that yields more than the entry limit', async () => {
    // The central directory declares 16 bytes; the deflated data inflates to 64 KiB.
    const archive = await openExportArchive(
      misdeclaredZip({ 'chat_sessions/big.json': [new Uint8Array(LIMIT * 64), { level: 9 }] }, 'chat_sessions/big.json', 16), LIMIT, live())
    const record = await pass(archive)
    expect(record.rejected).toEqual([{
      name: 'chat_sessions/big.json', oversized: true,
      message: `chat_sessions/big.json yields more than the ${LIMIT}-byte entry limit`,
    }])
  })

  it('stops accumulating an entry that yields more bytes than it declares', async () => {
    // The entry's compressed bytes span several archive slices, so its chunks
    // keep arriving after the guard has reported the first one.
    const declared = LIMIT * 100
    const archive = await openExportArchive(
      misdeclaredZip({ 'chat_sessions/big.json': [incompressible(declared * 3), { level: 9 }] }, 'chat_sessions/big.json', declared),
      declared * 5, live())
    const record = await pass(archive)
    expect(record.rejected).toEqual([{
      name: 'chat_sessions/big.json', oversized: false,
      message: `chat_sessions/big.json yields more bytes than the ${declared} bytes it declares`,
    }])
  })

  it('reports a damaged entry and keeps streaming the entries after it', async () => {
    const archive = await openExportArchive(damagedZip({
      'manifest.json': strToU8('{"export_format_version":3}'),
      'chat_sessions/a.json': strToU8('{"id":"a"}'),
      'chat_sessions/b.json': strToU8('{"id":"b"}'),
    }, 'chat_sessions/a.json'), LIMIT, live())
    const record = await pass(archive)
    expect(record.rejected).toEqual([{ name: 'chat_sessions/a.json', oversized: false, message: 'chat_sessions/a.json cannot be decompressed' }])
    expect(decode(record.delivered.get('chat_sessions/b.json'))).toBe('{"id":"b"}')
  })

  it('reports a damaged entry the archive ends on', async () => {
    const archive = await openExportArchive(damagedZip({
      'manifest.json': strToU8('{"export_format_version":3}'),
      'chat_sessions/only.json': strToU8('{"id":"only"}'),
    }, 'chat_sessions/only.json'), LIMIT, live())
    const record = await pass(archive)
    expect(record.rejected).toEqual([
      { name: 'chat_sessions/only.json', oversized: false, message: 'chat_sessions/only.json cannot be decompressed' },
    ])
  })

  it('rejects an archive whose data record its directory does not list', async () => {
    const archive = await openExportArchive(localNameZip({
      'manifest.json': strToU8('{"export_format_version":3}'),
      'chat_sessions/a.json': strToU8('{"id":"a"}'),
    }, 'chat_sessions/a.json', 'chat_sessions/z.json'), LIMIT, live())
    await expect(archive.stream(recorder().handler, live()))
      .rejects.toThrow(new ExportSourceError('unreadable-archive', 'the archive contains chat_sessions/z.json, which its directory does not list'))
  })

  it('rejects an archive whose data records do not fit the bytes it carries', async () => {
    const archive = await openExportArchive(localCompressedSizeZip({
      'manifest.json': strToU8('{"export_format_version":3}'),
      'chat_sessions/a.json': strToU8('{"id":"a"}'),
    }, 'chat_sessions/a.json'), LIMIT, live())
    await expect(archive.stream(recorder().handler, live()))
      .rejects.toThrow(new ExportSourceError('unreadable-archive', 'the uploaded file is not a readable ZIP archive'))
  })

  it('delivers an empty entry as no bytes', async () => {
    const archive = await openExportArchive(zipSync({ 'chat_sessions/empty.json': new Uint8Array(0) }), LIMIT, live())
    const record = await pass(archive)
    expect([...record.delivered.get('chat_sessions/empty.json') ?? [1]]).toEqual([])
  })

  it('stops accumulating an entry that yields more than the limit', async () => {
    // The central directory declares 16 bytes; the deflated entry inflates to
    // several times the limit, so the guard also sees chunks after its first report.
    const large = LIMIT * 256
    const archive = await openExportArchive(
      misdeclaredZip({ 'chat_sessions/big.json': [new Uint8Array(large * 4), { level: 9 }] }, 'chat_sessions/big.json', 16), large, live())
    const record = await pass(archive)
    expect(record.rejected).toEqual([{
      name: 'chat_sessions/big.json', oversized: true, message: `chat_sessions/big.json yields more than the ${large}-byte entry limit`,
    }])
  })

  it('stops at cancellation', async () => {
    const closed = (): Error => new Error('closed')
    await expect(openExportArchive(zipSync({}), LIMIT, AbortSignal.abort(closed()))).rejects.toThrow('closed')
    const archive = await openExportArchive(zipSync({ 'chat_sessions/a.json': strToU8('{"id":"a"}') }), LIMIT, live())
    await expect(archive.stream(recorder().handler, AbortSignal.abort(closed()))).rejects.toThrow('closed')
    await expect(archive.read('chat_sessions/a.json', AbortSignal.abort(closed()))).rejects.toThrow('closed')
    // A read in flight is terminated when the signal aborts.
    const large = await openExportArchive(zipSync({ 'chat_sessions/big.json': strToU8('x'.repeat(600_000)) }), 1024 * 1024, live())
    const controller2 = new AbortController()
    const reading = large.read('chat_sessions/big.json', controller2.signal)
    controller2.abort(closed())
    await expect(reading).rejects.toThrow('closed')
    // Cancelling while an accepted entry is handled ends the pass before the next chunk.
    const controller = new AbortController()
    const record = recorder()
    const cancelling: ExportStreamHandler = {
      ...record.handler,
      entry: (entry, data) => {
        controller.abort(closed())
        return record.handler.entry(entry, data)
      },
    }
    await expect(archive.stream(cancelling, controller.signal)).rejects.toThrow('closed')
  })
})

describe('archive entry checks', () => {
  it('lists an archive with no entries without delivering anything', async () => {
    const archive = await openExportArchive(zipSync({}), LIMIT, live())
    const record = await pass(archive)
    expect(record.offered).toEqual([])
    expect(record.rejected).toEqual([])
  })

  it('keeps a ZIP that stores entries without compression readable', async () => {
    const entries: Zippable = { 'chat_sessions/a.json': [strToU8('stored'), { level: 0 }] }
    const archive = await openExportArchive(zipSync(entries), LIMIT, live())
    const record = await pass(archive)
    expect(decode(record.delivered.get('chat_sessions/a.json'))).toBe('stored')
  })
})
