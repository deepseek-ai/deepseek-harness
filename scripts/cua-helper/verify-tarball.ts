/** Reject incomplete or modified CUA payloads before any npm publication. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract } from 'tar'
import { verifyCuaHelperPayload } from './payload.ts'

/**
 * Verify both helper applications in the exact provider tarball being published.
 * @param tarball - pnpm-produced provider package archive.
 * @param expected - Product version and source commit of the publishing checkout.
 * @returns Resolves only when the archive has complete, digest-verified application generations.
 */
export async function verifyCuaHelperTarball(tarball: string, expected: { version: string; commit: string }): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cua-publish-verify-'))
  try {
    await extract({ file: tarball, cwd: root, strict: true, filter: (path, entry) => {
      if (!path.startsWith('package/') || path.split('/').includes('..')
        || !('type' in entry) || !['File', 'Directory'].includes(entry.type)) throw new Error(`Invalid CUA package entry: ${path}`)
      return true
    } })
    verifyCuaHelperPayload(join(root, 'package'), expected)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
