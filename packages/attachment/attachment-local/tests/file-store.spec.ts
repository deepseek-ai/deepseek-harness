import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  fileLeafName, readFileStreamVerbatim, saveFileStreamVerbatim, saveFileVerbatim, storedFilePath,
} from '../src/file-store.ts'
import { publishImmutableAlias } from '../src/store.ts'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), 'dsh-file-store-')), 'attachments', 'v1')
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(join(root, '..', '..'), { recursive: true, force: true, maxRetries: 3 })
  }
})

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

async function readStream(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return new Uint8Array(Buffer.concat(chunks))
}

describe('fileLeafName', () => {
  it('keeps ordinary names and strips client paths of both separator styles', () => {
    expect(fileLeafName('notes.pdf')).toBe('notes.pdf')
    expect(fileLeafName('/home/user/data.csv')).toBe('data.csv')
    expect(fileLeafName('C:\\Users\\me\\report.docx')).toBe('report.docx')
  })

  it('removes control characters, rewrites Windows-invalid characters, and bounds UTF-8 length', () => {
    expect(fileLeafName('a\u0000b\u001f.txt')).toBe('ab.txt')
    expect(fileLeafName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt')
    expect(fileLeafName(`${'x'.repeat(300)}.bin`).length).toBe(255)
    const multibyte = fileLeafName(`${'文'.repeat(100)}.txt`)
    expect(Buffer.byteLength(multibyte)).toBeLessThanOrEqual(255)
    expect(multibyte.endsWith('\ufffd')).toBe(false)
    expect(fileLeafName(`safe-${'x'.repeat(248)}\ud83d\ude00`)).not.toMatch(/\ud83d$/u)
  })

  it('removes Windows trailing characters and protects reserved device names', () => {
    expect(fileLeafName('report. ')).toBe('report')
    expect(fileLeafName('CON')).toBe('_CON')
    expect(fileLeafName('com1.txt')).toBe('_com1.txt')
    expect(fileLeafName('con .txt')).toBe('_con .txt')
    expect(fileLeafName('com10.txt')).toBe('com10.txt')
  })

  it('falls back to a stable name for absent, empty, and dot-only inputs', () => {
    expect(fileLeafName(undefined)).toBe('file')
    expect(fileLeafName('')).toBe('file')
    expect(fileLeafName('   ')).toBe('file')
    expect(fileLeafName('.')).toBe('file')
    expect(fileLeafName('..')).toBe('file')
  })
})

describe('saveFileVerbatim', () => {
  it('stores the exact bytes read-only at a digest-and-name path', async () => {
    const root = await makeRoot()
    const data = Uint8Array.from([0, 1, 2, 250, 251, 252])
    const ref = await saveFileVerbatim(root, { data, name: 'blob.bin' })
    expect(ref).toEqual({
      attachmentId: AttachmentId(`sha256:${sha256(data)}`),
      name: 'blob.bin',
      bytes: data.byteLength,
    })
    const path = storedFilePath(root, ref)
    expect(path.endsWith(join(sha256(data), 'blob.bin'))).toBe(true)
    expect(new Uint8Array(await readFile(path))).toEqual(data)
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o400)
    }
  })

  it('accepts a zero-byte file', async () => {
    const root = await makeRoot()
    const ref = await saveFileVerbatim(root, { data: new Uint8Array(0), name: 'empty.txt' })
    expect(ref.bytes).toBe(0)
    expect((await readFile(storedFilePath(root, ref))).byteLength).toBe(0)
  })

  it('stores sanitized Windows-reserved and multibyte names', async () => {
    const root = await makeRoot()
    const reserved = await saveFileVerbatim(root, { data: new Uint8Array(0), name: 'NUL.txt' })
    const multibyte = await saveFileVerbatim(root, { data: Uint8Array.of(1), name: '文'.repeat(100) })
    expect(reserved.name).toBe('_NUL.txt')
    expect(Buffer.byteLength(multibyte.name)).toBeLessThanOrEqual(255)
    await expect(readFile(storedFilePath(root, reserved))).resolves.toHaveLength(0)
    await expect(readFile(storedFilePath(root, multibyte))).resolves.toEqual(Buffer.from([1]))
  })

  it('deduplicates identical bytes and stores distinct names beside one digest', async () => {
    const root = await makeRoot()
    const data = Uint8Array.from([7, 7, 7])
    const first = await saveFileVerbatim(root, { data, name: 'a.txt' })
    const again = await saveFileVerbatim(root, { data, name: 'a.txt' })
    expect(again).toEqual(first)
    const renamed = await saveFileVerbatim(root, { data, name: 'b.txt' })
    expect(renamed.attachmentId).toBe(first.attachmentId)
    expect((await stat(storedFilePath(root, first))).ino)
      .toBe((await stat(storedFilePath(root, renamed))).ino)
    const digestDir = join(root, 'files', sha256(data).slice(0, 2), sha256(data))
    expect((await readdir(digestDir)).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('refuses a stored object whose bytes no longer match the digest', async () => {
    const root = await makeRoot()
    const data = Uint8Array.from([1, 2, 3])
    const ref = await saveFileVerbatim(root, { data, name: 'c.txt' })
    const path = storedFilePath(root, ref)
    await chmod(path, 0o600)
    await writeFile(path, Uint8Array.from([9, 9, 9]))
    await expect(saveFileVerbatim(root, { data, name: 'c.txt' }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('rejects a conflicting display-name alias and wraps alias publication failures', async () => {
    const root = await makeRoot()
    const data = Uint8Array.of(1, 2, 3)
    const ref = await saveFileVerbatim(root, { data, name: 'alias.bin' })
    const alias = storedFilePath(root, ref)
    await unlink(alias)
    await writeFile(alias, Uint8Array.of(9, 9, 9))
    await expect(saveFileVerbatim(root, { data, name: 'alias.bin' }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })

    await expect(publishImmutableAlias(
      root,
      join(root, 'missing-object'),
      join(root, 'files', 'ff', 'missing', 'alias.bin'),
      'f'.repeat(64),
    )).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
  })
})

describe('saveFileStreamVerbatim', () => {
  it('stores ordered chunks without materializing one aggregate byte array', async () => {
    const root = await makeRoot()
    const ref = await saveFileStreamVerbatim(root, {
      data: (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(0, 1)
        yield Uint8Array.of(2, 250)
        yield Uint8Array.of(251, 252)
      })(),
      name: 'large.bin',
    })
    const expected = Uint8Array.of(0, 1, 2, 250, 251, 252)
    expect(ref).toEqual({
      attachmentId: AttachmentId(`sha256:${sha256(expected)}`),
      name: 'large.bin',
      bytes: expected.byteLength,
    })
    expect(new Uint8Array(await readFile(storedFilePath(root, ref)))).toEqual(expected)
  })

  it('removes its staging file when cancellation interrupts the source', async () => {
    const root = await makeRoot()
    const abort = new AbortController()
    const reason = new Error('upload cancelled')
    await expect(saveFileStreamVerbatim(root, {
      data: (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1, 2)
        abort.abort(reason)
        yield Uint8Array.of(3, 4)
      })(),
      signal: abort.signal,
      name: 'cancelled.bin',
    })).rejects.toBe(reason)
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })

  it('wraps source failures and removes the staging file', async () => {
    const root = await makeRoot()
    await expect(saveFileStreamVerbatim(root, {
      data: (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1, 2)
        throw new Error('source failed')
      })(),
      name: 'failed.bin',
    })).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })
})

describe('readFileStreamVerbatim', () => {
  it('returns exact bounded chunks and accepts an empty file', async () => {
    const root = await makeRoot()
    const data = Uint8Array.from({ length: (1 << 16) + 3 }, (_, index) => index % 251)
    const ref = await saveFileVerbatim(root, { data, name: 'large.bin' })
    await expect(readStream(readFileStreamVerbatim(root, ref))).resolves.toEqual(data)
    const empty = await saveFileVerbatim(root, { data: new Uint8Array(), name: 'empty.bin' })
    await expect(readStream(readFileStreamVerbatim(root, empty))).resolves.toEqual(new Uint8Array())
  })

  it('rejects invalid, missing, and unreadable references with storage codes', async () => {
    const root = await makeRoot()
    const ref: FileAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
      name: 'missing.bin',
      bytes: 1,
    }
    await expect(readStream(readFileStreamVerbatim(root, { ...ref, name: '../escape' })))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
    await expect(readStream(readFileStreamVerbatim(root, ref)))
      .rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })

    const saved = await saveFileVerbatim(root, { data: Uint8Array.of(1), name: 'unreadable.bin' })
    const path = storedFilePath(root, saved)
    await unlink(path)
    await mkdir(path)
    await expect(readStream(readFileStreamVerbatim(root, saved)))
      .rejects.toMatchObject({ code: 'ATTACHMENT_READ_FAILED' })
  })

  it('detects changed bytes and recorded lengths', async () => {
    const root = await makeRoot()
    const ref = await saveFileVerbatim(root, { data: Uint8Array.of(1, 2, 3), name: 'data.bin' })
    const path = storedFilePath(root, ref)
    await chmod(path, 0o600)
    await writeFile(path, Uint8Array.of(3, 2, 1))
    await expect(readStream(readFileStreamVerbatim(root, ref)))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    await writeFile(path, Uint8Array.of(1, 2, 3))
    await expect(readStream(readFileStreamVerbatim(root, { ...ref, bytes: 4 })))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('preserves caller cancellation before and during a read', async () => {
    const root = await makeRoot()
    const ref = await saveFileVerbatim(root, {
      data: Uint8Array.from({ length: 1 << 17 }, () => 7),
      name: 'cancel.bin',
    })
    const before = new AbortController()
    const beforeReason = new Error('cancelled before read')
    before.abort(beforeReason)
    await expect(readStream(readFileStreamVerbatim(root, ref, before.signal))).rejects.toBe(beforeReason)

    const during = new AbortController()
    const stream = readFileStreamVerbatim(root, ref, during.signal)[Symbol.asyncIterator]()
    await expect(stream.next()).resolves.toMatchObject({ done: false })
    const duringReason = new Error('cancelled during read')
    during.abort(duringReason)
    await expect(stream.next()).rejects.toBe(duringReason)
  })
})

describe('storedFilePath', () => {
  it('rejects malformed digests and unsanitized names before deriving a path', () => {
    const good: FileAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      name: 'ok.txt',
      bytes: 1,
    }
    expect(() => storedFilePath('/root', { ...good, attachmentId: AttachmentId('sha256:short') }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ATTACHMENT_REF' }) as Error)
    expect(() => storedFilePath('/root', { ...good, name: '../escape.txt' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ATTACHMENT_REF' }) as Error)
    expect(() => storedFilePath('/root', { ...good, name: 'nested/name.txt' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ATTACHMENT_REF' }) as Error)
    expect(storedFilePath('/root', good).endsWith(join('a'.repeat(64), 'ok.txt'))).toBe(true)
  })
})
