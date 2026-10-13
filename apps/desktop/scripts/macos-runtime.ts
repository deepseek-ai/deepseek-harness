/** Sign final native runtime files before the enclosing Desktop application is signed. */

import { createHash } from 'node:crypto'
import { closeSync, openSync, readdirSync, readSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { primaryRuntimePythonAliases, readPrimaryRuntime } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { inventoryDesktopRuntime } from '../src/runtime-tree.ts'
import type { MacOSSigningEnvironment } from './desktop-release-environment.mjs'
import { cachedMacOSSignature, pruneMacOSSignatureCache } from './macos-signature-cache.ts'
import { macOSCachePolicy } from './macos-cache-policy.ts'
import { signMacOSRuntimeCode, verifyMacOSRuntimeCode } from './verify-macos-signature.mjs'

const MACH_O_MAGICS = new Set(['cafebabe', 'cafebabf', 'cefaedfe', 'cffaedfe', 'feedface', 'feedfacf', 'bebafeca', 'bfbafeca'])

function magic(path: string): string {
  const descriptor = openSync(path, 'r')
  try {
    const header = Buffer.alloc(4)
    return readSync(descriptor, header, 0, 4, 0) === 4 ? header.toString('hex') : ''
  } finally { closeSync(descriptor) }
}

async function primaryRuntimeFiles(root: string): Promise<string[]> {
  const aliases = await primaryRuntimePythonAliases(root, await readPrimaryRuntime(root))
  const files: string[] = []
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')
    if (entry.isDirectory() || (entry.isSymbolicLink() && aliases.has(path))) continue
    if (!entry.isFile()) throw new Error(`desktop runtime: unsupported filesystem entry ${path}`)
    files.push(path)
  }
  return files.sort()
}

/**
 * Sign and verify every materialized Mach-O file, awaiting all signers on failure.
 * @param root - Self-contained production runtime.
 * @param appId - Release application identifier.
 * @param expected - Required signing identity.
 * @param arch - Target runtime architecture, independent of the signing host.
 * @param cacheDirectory - Optional content-addressed cache; requires the keychain-owned signing probe.
 * @param kind - Primary payloads admit validated Python aliases; Desktop application runtimes reject every link.
 * @returns Number of signed native files.
 */
export async function signMacOSRuntime(
  root: string, appId: string, expected: MacOSSigningEnvironment, arch: 'arm64' | 'x64', cacheDirectory?: string,
  kind: 'desktop' | 'primary' = 'desktop',
): Promise<number> {
  const inventory = kind === 'primary' ? await primaryRuntimeFiles(root) : inventoryDesktopRuntime(root).map(file => file.path)
  const files = inventory.filter(path => MACH_O_MAGICS.has(magic(join(root, path))))
  const policy = cacheDirectory === undefined ? undefined : macOSCachePolicy(process.env.DSH_DESKTOP_MACOS_SIGNING_PROBE ?? '')
  let hits = 0
  let misses = 0
  let next = 0
  const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
    for (;;) {
      const path = files[next++]
      if (path === undefined) return
      const identifier = `${appId}.runtime.${createHash('sha256').update(path).digest('hex')}`
      const isNode = path === 'dependencies/node/bin/node'
      const needsJit = isNode
        || /^node_modules\/@deepseek-ai\/libreoffice-kit-darwin-(?:arm64|x64)\/bin\/libreoffice-kit$/u.test(path)
      const entitlementsFile = isNode && arch === 'x64'
        ? 'node-x64-entitlements.plist' : 'jit-entitlements.plist'
      const entitlements = needsJit ? join(import.meta.dirname, entitlementsFile) : undefined
      const file = join(root, path)
      const thin = ['cefaedfe', 'cffaedfe', 'feedface', 'feedfacf'].includes(magic(file))
      if (cacheDirectory !== undefined && policy !== undefined && thin) {
        if (await cachedMacOSSignature(file, cacheDirectory, policy(identifier, expected, entitlements))) hits++
        else misses++
      } else {
        await signMacOSRuntimeCode(file, identifier, expected, entitlements)
        verifyMacOSRuntimeCode(file, expected)
      }
    }
  })
  const results = await Promise.allSettled(workers)
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
  if (errors.length > 0) throw new AggregateError(errors, 'desktop runtime: native signing failed')
  if (cacheDirectory !== undefined) {
    pruneMacOSSignatureCache(cacheDirectory)
    console.info(`desktop macOS signing cache: ${hits} hits, ${misses} misses, ${files.length - hits - misses} uncached`)
  }
  return files.length
}
