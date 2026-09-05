/** Verbatim content-addressed local file storage. @module @deepseek-ai/dsh-attachment-local/file-store */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef, SaveFileAttachment, SaveFileStreamAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  publishImmutableAlias, publishImmutableObject, publishImmutableObjectStream,
} from './store.ts'

const FILE_ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

function isWindowsDeviceName(name: string): boolean {
  const dot = name.indexOf('.')
  const stem = (dot < 0 ? name : name.slice(0, dot)).replace(/[. ]+$/u, '')
  return WINDOWS_DEVICE_NAME.test(stem)
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0
  let prefix = ''
  for (const character of Buffer.from(value).toString('utf8')) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return prefix
}

/**
 * Sanitize one caller display name into a safe stored leaf name. Both
 * separator styles are stripped by hand: a POSIX host treats `\` as an
 * ordinary character, so path.basename would keep a Windows client's full
 * local path and leak it into the reference and the session log. Characters
 * Windows refuses in file names become `_` so one reference stays valid on
 * every supported host.
 * @param value - caller-declared display name, possibly a full client path.
 * @returns a non-empty leaf name safe to store on every supported filesystem.
 */
export function fileLeafName(value: string | undefined): string {
  if (value === undefined) return 'file'
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  let clean = leaf
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  if (isWindowsDeviceName(clean)) clean = `_${clean}`
  clean = utf8Prefix(clean, 255).replace(/[. ]+$/u, '')
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean
}

function ensureFileReference(ref: FileAttachmentRef): string {
  const match = FILE_ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined || ref.name !== fileLeafName(ref.name)) {
    throw new AttachmentError('File attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  }
  return match[1]
}

/**
 * Derive the absolute immutable-object path for one stored file. The digest
 * names a directory so the sanitized display name stays the stored leaf name,
 * giving models and users a path that ends in the real filename.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - durable file reference from the session log or an upload receipt.
 * @returns provider-local path without reading the object.
 * @throws an AttachmentError when the reference digest or name is invalid.
 */
export function storedFilePath(root: string, ref: FileAttachmentRef): string {
  const sha256 = ensureFileReference(ref)
  return join(root, 'files', sha256.slice(0, 2), sha256, ref.name)
}

/** Canonical object path shared by every display name for one digest. */
function storedFileObjectPath(root: string, sha256: string): string {
  return join(root, 'file-objects', sha256.slice(0, 2), sha256)
}

/**
 * Commit one file byte-for-byte below a versioned attachment root.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param input - exact bytes and optional display name.
 * @returns the durable content-addressed file reference.
 */
export async function saveFileVerbatim(
  root: string,
  input: SaveFileAttachment,
): Promise<FileAttachmentRef> {
  const sha256 = createHash('sha256').update(input.data).digest('hex')
  const ref: FileAttachmentRef = {
    attachmentId: AttachmentId(`sha256:${sha256}`),
    name: fileLeafName(input.name),
    bytes: input.data.byteLength,
  }
  const objectPath = storedFileObjectPath(root, sha256)
  await publishImmutableObject(root, objectPath, input.data, sha256)
  await publishImmutableAlias(root, objectPath, storedFilePath(root, ref), sha256)
  return ref
}

/**
 * Commit one file byte-for-byte from bounded chunks below a versioned attachment root.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param input - ordered exact bytes, optional cancellation, and display name.
 * @returns the durable content-addressed file reference.
 */
export async function saveFileStreamVerbatim(
  root: string,
  input: SaveFileStreamAttachment,
): Promise<FileAttachmentRef> {
  const name = fileLeafName(input.name)
  const stored = await publishImmutableObjectStream(
    root,
    input.data,
    sha256 => storedFileObjectPath(root, sha256),
    input.signal,
  )
  const ref: FileAttachmentRef = {
    attachmentId: AttachmentId(`sha256:${stored.sha256}`),
    name,
    bytes: stored.bytes,
  }
  input.signal?.throwIfAborted()
  await publishImmutableAlias(
    root,
    storedFileObjectPath(root, stored.sha256),
    storedFilePath(root, ref),
    stored.sha256,
  )
  input.signal?.throwIfAborted()
  return ref
}

/**
 * Read one stored file in bounded chunks and verify its byte count and digest.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - durable file reference from the session log.
 * @param signal - optional cancellation for filesystem reads.
 * @returns exact stored bytes in order; integrity failures reject after the final chunk.
 */
export async function* readFileStreamVerbatim(
  root: string,
  ref: FileAttachmentRef,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  signal?.throwIfAborted()
  const sha256 = ensureFileReference(ref)
  const stream = createReadStream(storedFilePath(root, ref), {
    highWaterMark: 1 << 16,
    ...(signal === undefined ? {} : { signal }),
  })
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      const data = chunk as Buffer
      hash.update(data)
      bytes += data.byteLength
      yield data
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new AttachmentError('File attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    throw new AttachmentError('Unable to read file attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  } finally {
    stream.destroy()
  }
  signal?.throwIfAborted()
  if (bytes !== ref.bytes || hash.digest('hex') !== sha256) {
    throw new AttachmentError('Stored file attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  }
}
