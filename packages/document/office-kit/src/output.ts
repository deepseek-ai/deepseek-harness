/** Read only bounded, regular output files created inside a private task directory. */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { OfficeKitError } from './errors.ts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Refuse missing, link-shaped, oversized, and truncated output.
 * @param path - kit output path in the provider-owned scratch directory.
 * @param limit - inclusive byte limit.
 * @param signal - conversion lifetime.
 * @returns complete bytes independent of the scratch file.
 * @throws {OfficeKitError} `invalid-output` for a non-regular or changing file and `output-too-large` above `limit`.
 */
export async function readOutput(path: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const entry = await lstat(path)
  if (!entry.isFile()) throw new OfficeKitError('invalid-output', 'The converter output is not a regular file.')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new OfficeKitError('invalid-output', 'The converter output is not a regular file.')
    if (info.size > limit) throw new OfficeKitError('output-too-large', 'The converter output exceeds its byte limit.')
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < bytes.length) {
      signal.throwIfAborted()
      const read = await file.read(bytes, length, bytes.length - length, null)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    signal.throwIfAborted()
    if (length > limit) throw new OfficeKitError('output-too-large', 'The converter output exceeds its byte limit.')
    if (length !== info.size) throw new OfficeKitError('invalid-output', 'The converter output changed while it was read.')
    return bytes.subarray(0, length)
  } finally { await file.close() }
}

/**
 * Refuse missing, link-shaped, oversized, truncated, and non-PDF output.
 * @param path - kit output path in the provider-owned scratch directory.
 * @param limit - inclusive PDF byte limit.
 * @param signal - conversion lifetime.
 * @returns complete bytes independent of the scratch file.
 */
export async function readPdf(path: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const pdf = await readOutput(path, limit, signal)
  if (!pdf.subarray(0, 8).toString('ascii').match(/^%PDF-\d\.\d/u)
    || !pdf.subarray(-1024).toString('ascii').trimEnd().endsWith('%%EOF')) {
    throw new OfficeKitError('invalid-output', 'The converter did not produce a complete PDF.')
  }
  return pdf
}

/**
 * Refuse missing, link-shaped, oversized, and non-PNG image output.
 * @param path - kit image path in the provider-owned scratch directory.
 * @param limit - inclusive PNG byte limit.
 * @param signal - rendering lifetime.
 * @returns complete PNG bytes independent of the scratch file.
 */
export async function readPng(path: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const png = await readOutput(path, limit, signal)
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new OfficeKitError('invalid-output', 'The converter did not produce a PNG image.')
  }
  return png
}
