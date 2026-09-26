/** Read only the bounded, regular PDF created inside a private task directory. */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { OfficeToPdfError } from './errors.ts'

/**
 * Refuse missing, link-shaped, oversized, truncated, and non-PDF output.
 * @param path - kit output path in the provider-owned scratch directory.
 * @param limit - inclusive PDF byte limit.
 * @param signal - conversion lifetime.
 * @returns complete bytes independent of the scratch file.
 */
export async function readPdf(path: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const entry = await lstat(path)
  if (!entry.isFile()) throw new OfficeToPdfError('invalid-output', 'The converter output is not a regular file.')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new OfficeToPdfError('invalid-output', 'The converter output is not a regular file.')
    if (info.size > limit) throw new OfficeToPdfError('output-too-large', 'The converted PDF exceeds maxOutputBytes.')
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < bytes.length) {
      signal.throwIfAborted()
      const read = await file.read(bytes, length, bytes.length - length, null)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    signal.throwIfAborted()
    if (length > limit) throw new OfficeToPdfError('output-too-large', 'The converted PDF exceeds maxOutputBytes.')
    const pdf = bytes.subarray(0, length)
    if (length !== info.size || !pdf.subarray(0, 8).toString('ascii').match(/^%PDF-\d\.\d/u)
      || !pdf.subarray(-1024).toString('ascii').trimEnd().endsWith('%%EOF')) {
      throw new OfficeToPdfError('invalid-output', 'The converter did not produce a complete PDF.')
    }
    return pdf
  } finally { await file.close() }
}
