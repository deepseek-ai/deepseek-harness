/** ZIP fixtures shared by the importer specs. */
import { strToU8, zipSync } from 'fflate'
import type { Zippable } from 'fflate'

/** A ZIP whose deflated entry `name` has its compressed data overwritten. */
export function damagedZip(entries: Record<string, Uint8Array>, name: string): Uint8Array {
  const archive = zipSync({ ...entries, [name]: [strToU8('compressible '.repeat(64)), { level: 9 }] })
  const encoded = strToU8(name)
  // The first occurrence of the name ends its local header; deflate data follows (no extra field).
  const start = Buffer.from(archive).indexOf(Buffer.from(encoded)) + encoded.length
  archive.fill(0xff, start, start + 4)
  return archive
}

/**
 * A ZIP that lists two entries under one name: every occurrence of `alias` in the
 * local and central headers is rewritten to the equally long `duplicate`.
 */
export function duplicateNameZip(entries: Zippable, duplicate: string, alias: string): Uint8Array {
  const archive = zipSync(entries)
  const from = Buffer.from(strToU8(alias))
  const to = Buffer.from(strToU8(duplicate))
  if (from.length !== to.length) throw new Error('the duplicate and alias names must have the same length')
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  for (let at = bytes.indexOf(from); at !== -1; at = bytes.indexOf(from, at + from.length)) to.copy(bytes, at)
  return archive
}

/**
 * A ZIP whose central directory declares `declared` uncompressed bytes for
 * entry `name` regardless of its real size.
 */
export function misdeclaredZip(entries: Zippable, name: string, declared: number): Uint8Array {
  const archive = zipSync(entries)
  const encoded = Buffer.from(strToU8(name))
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  // The second occurrence of the name follows its 46-byte central directory header; the size field sits at offset 24.
  const central = bytes.indexOf(encoded, bytes.indexOf(encoded) + encoded.length) - 46
  bytes.writeUInt32LE(declared, central + 24)
  return archive
}

/**
 * A ZIP whose local header names `name` as the equally long `alias`, leaving
 * the central directory under the real name.
 */
export function localNameZip(entries: Zippable, name: string, alias: string): Uint8Array {
  const archive = zipSync(entries)
  const from = Buffer.from(strToU8(name))
  const to = Buffer.from(strToU8(alias))
  if (from.length !== to.length) throw new Error('the local name and its alias must have the same length')
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  // The first occurrence is the local file header; the directory keeps the real name.
  to.copy(bytes, bytes.indexOf(from))
  return archive
}

/** A ZIP whose local header claims entry `name` carries far more compressed bytes than the archive holds. */
export function localCompressedSizeZip(entries: Zippable, name: string): Uint8Array {
  const archive = zipSync(entries)
  const encoded = Buffer.from(strToU8(name))
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  // The local header is 30 bytes; its compressed size sits at offset 18.
  bytes.writeUInt32LE(0x7fffffff, bytes.indexOf(encoded) - 30 + 18)
  return archive
}
