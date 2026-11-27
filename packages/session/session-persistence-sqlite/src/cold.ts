/** Durable whole-Session JSONL archives owned by the SQLite store. @module */
import { createHash, randomUUID } from 'node:crypto'
import { link, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { z } from 'zod'
import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, SessionLogOffset as logOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { SessionFormatUnsupportedError, sessionFormatVersionRefusal } from '@deepseek-ai/dsh-session-persistence'
import { decodeEvent, decodeHeader, materializeHeader } from './codec.ts'
import { publishNewFileWin32 } from './win32.ts'

/** A codec reserved for an indexed event whose payload is in a cold archive. */
export const EVENT_CODEC_COLD = 254

// Uncompressed JSONL cap per archived Session; compressed frames allow Zstandard framing headroom.
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_COMPRESSED_BYTES = MAX_ARCHIVE_BYTES + 1024 * 1024
const DECODE_YIELD_EVENTS = 256
const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)
const archiveHeader = z.object({ id: z.unknown(), version: z.number().int(), inheritedEventCount: z.unknown().optional() }).loose()

/** Validate a database locator before using it to construct a file path. */
export const archiveRow = z.object({ segment_id: z.number().int(), archive: z.uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u), bytes: z.number().int().positive().max(MAX_COMPRESSED_BYTES) })

/** File identity and checksum pinned by the database before it releases the inline payload. */
export type ColdArchive = Pick<z.infer<typeof archiveRow>, 'archive' | 'sha256' | 'bytes'>

/** Validated Session header, inherited cut, and decoded logical events read from a cold archive. */
export interface ColdSnapshot {
  readonly meta: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: (SessionFormatEvent & SessionEvent)[]
}

/** Publish a synced archive before the database can refer to it.
 * @param directory - the already durable archive directory.
 * @param header - the Session header to encode.
 * @param inheritedCount - the exact fork prefix length stored in the header.
 * @param history - the Session's validated events in sequence order.
 * @param eventCount - the number of events the archive must contain.
 * @param signal - cancels work before publishing the archive.
 * @returns the published archive identity, or undefined when the stream ends early or exceeds the byte cap.
 */
export async function archiveSession(directory: string, header: SessionHeader, inheritedCount: SessionLogOffset,
  history: AsyncIterable<SessionEvent>, eventCount: number, signal: AbortSignal): Promise<ColdArchive | undefined> {
  const storedHeader = materializeHeader(header, inheritedCount)
  const first = Buffer.from(`${JSON.stringify({ ...storedHeader, ...storedHeader.isSeeded ? { inheritedEventCount: inheritedCount } : {} })}\n`, 'utf8')
  const chunks = [first]
  let bytes = first.length, count = 0
  for await (const event of history) {
    signal.throwIfAborted()
    const chunk = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')
    bytes += chunk.length
    if (bytes > MAX_ARCHIVE_BYTES) return undefined
    chunks.push(chunk)
    count++
  }
  if (count !== eventCount) return undefined
  const text = Buffer.concat(chunks, bytes)
  chunks.length = 0
  const compressed = await compress(text, { params: {
    [constants.ZSTD_c_compressionLevel]: 12, [constants.ZSTD_c_checksumFlag]: 1,
  } })
  signal.throwIfAborted()
  const archive = randomUUID(), destination = join(directory, `${archive}.jsonl.zst`)
  const staging = join(directory, `${archive}.tmp`)
  const file = await open(staging, 'wx', 0o600)
  try {
    try { await file.writeFile(compressed); await file.sync() } finally { await file.close() }
    /* v8 ignore start -- Windows uses write-through MoveFileExW instead of link and directory fsync. */
    if (process.platform === 'win32') await publishNewFileWin32(staging, destination)
    /* v8 ignore stop */
    /* v8 ignore start -- Windows cannot fsync directory handles; its write-through publication runs above. */
    else {
      await link(staging, destination)
      try {
        const parent = await open(directory, 'r')
        try { await parent.sync() } finally { await parent.close() }
      } catch (error: unknown) {
        await rm(destination, { force: true })
        throw error
      }
    }
    /* v8 ignore stop */
  } finally { await rm(staging, { force: true }) }
  return { archive, sha256: createHash('sha256').update(compressed).digest('hex'), bytes: compressed.length }
}

/** Verify and decode the complete archive. A recoverable JSONL suffix is not allowed here.
 * @param directory - the archive directory.
 * @param locator - the validated file identity and digest recorded by SQLite.
 * @param signal - optional cancellation while scanning the archive.
 * @returns the complete Session log, checked against the archived byte length.
 */
export async function readArchive(directory: string, locator: ColdArchive, signal?: AbortSignal): Promise<ColdSnapshot> {
  const file = await open(join(directory, `${locator.archive}.jsonl.zst`), 'r')
  const compressed = Buffer.alloc(locator.bytes + 1)
  let offset = 0
  try {
    while (offset < compressed.length) {
      const { bytesRead } = await file.read(compressed, offset, compressed.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
  } finally { await file.close() }
  const body = compressed.subarray(0, offset)
  if (offset !== locator.bytes || createHash('sha256').update(body).digest('hex') !== locator.sha256) {
    throw new Error('Cold Session archive does not match its recorded length and checksum')
  }
  return scanArchive(await decompress(body, { maxOutputLength: MAX_ARCHIVE_BYTES }), signal)
}

async function scanArchive(text: Buffer, signal?: AbortSignal): Promise<ColdSnapshot> {
  if (text.length === 0 || text[text.length - 1] !== 0x0A) throw new Error('Cold Session archive is not a complete JSONL log')
  const firstEnd = text.indexOf(0x0A)
  const parsedHeader = archiveHeader.parse(JSON.parse(text.subarray(0, firstEnd).toString('utf8')))
  if (parsedHeader.version !== SESSION_FORMAT_VERSION) {
    throw new SessionFormatUnsupportedError(sessionFormatVersionRefusal(String(parsedHeader.id), parsedHeader.version))
  }
  const { inheritedEventCount: rawCut, ...headerFields } = parsedHeader
  const inheritedEventCount = rawCut === undefined ? logOffset(0) : logOffset(z.number().int().nonnegative().parse(rawCut))
  const meta = materializeHeader(decodeHeader(headerFields), inheritedEventCount)
  const events: (SessionFormatEvent & SessionEvent)[] = []
  try {
    for (let pos = firstEnd + 1, index = 0; pos < text.length; index++) {
      if (index > 0 && index % DECODE_YIELD_EVENTS === 0) await setImmediate(undefined, { signal })
      const end = text.indexOf(0x0A, pos)
      const value: unknown = JSON.parse(text.subarray(pos, end).toString('utf8'))
      events.push(decodeEvent(value))
      pos = end + 1
    }
    const artifact = { header: { ...meta, delegationDepth: Number(meta.delegationDepth) }, inheritedEventCount, events }
    restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)
  } catch (error: unknown) {
    if (error instanceof SessionFormatUnsupportedMigrationError) throw new SessionFormatUnsupportedError(error.message)
    throw error
  }
  return { meta, inheritedEventCount, events }
}
