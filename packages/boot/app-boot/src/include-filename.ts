/** Resolve an Include `path` to the file the Include plugin reads. */

import { fileURLToPath, pathToFileURL } from 'node:url'

// A Windows drive-letter path, e.g. `C:\app\cordis.yml` or `C:/app/cordis.yml`.
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/u

/**
 * Resolve an Include `path` as the vendored Include does: on Windows a drive-letter path is a file path, and every
 * other path is a URL reference resolved against the owning tree's base URL.
 * @param path - literal Include `path`.
 * @param baseUrl - base URL of the tree that owns the Include entry.
 * @param platform - platform whose path rules apply to both branches; defaults to the running one.
 * @returns the absolute filename.
 * @throws when `path` resolves to a URL that is not a `file:` URL.
 */
export function includeFilename(path: string, baseUrl: string, platform: NodeJS.Platform = process.platform): string {
  const windows = platform === 'win32'
  if (windows && DRIVE_LETTER.test(path)) return fileURLToPath(pathToFileURL(path, { windows }), { windows })
  return fileURLToPath(new URL(path, baseUrl), { windows })
}
