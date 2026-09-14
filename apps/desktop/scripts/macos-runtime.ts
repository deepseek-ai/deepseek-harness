/** Sign final native runtime files before the enclosing Desktop application is signed. */

import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { inventoryDesktopRuntime } from '../src/runtime-tree.ts'
import type { MacOSSigningEnvironment } from './desktop-release-environment.mjs'
import { signMacOSRuntimeCode, verifyMacOSRuntimeCode } from './verify-macos-signature.mjs'

const MACH_O_MAGICS = new Set(['cafebabe', 'cafebabf', 'cefaedfe', 'cffaedfe', 'feedface', 'feedfacf', 'bebafeca', 'bfbafeca'])

function isMachO(path: string): boolean {
  const descriptor = openSync(path, 'r')
  try {
    const header = Buffer.alloc(4)
    return readSync(descriptor, header, 0, 4, 0) === 4 && MACH_O_MAGICS.has(header.toString('hex'))
  } finally { closeSync(descriptor) }
}

/**
 * Sign and verify every materialized Mach-O file, awaiting all signers on failure.
 * @param root - Self-contained production runtime without symlinks.
 * @param appId - Release application identifier.
 * @param expected - Required signing identity.
 * @returns Number of signed native files.
 */
export async function signMacOSRuntime(root: string, appId: string, expected: MacOSSigningEnvironment): Promise<number> {
  const files = inventoryDesktopRuntime(root).map(file => file.path).filter(path => isMachO(join(root, path)))
  let next = 0
  const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
    for (;;) {
      const path = files[next++]
      if (path === undefined) return
      const identifier = `${appId}.runtime.${createHash('sha256').update(path).digest('hex')}`
      await signMacOSRuntimeCode(join(root, path), identifier, expected)
      verifyMacOSRuntimeCode(join(root, path), expected)
    }
  })
  const results = await Promise.allSettled(workers)
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
  if (errors.length > 0) throw new AggregateError(errors, 'desktop runtime: native signing failed')
  return files.length
}
