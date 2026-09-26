/** Bind reusable thin Mach-O signatures to the actual certificate, tools, identifier, and entitlements. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, release } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { MacOSSigningEnvironment } from './desktop-release-environment.mjs'
import { assertMacOSRuntimeSignatureDetails, signMacOSRuntimeCode } from './verify-macos-signature.mjs'
import type { MacOSCachedSigner } from './macos-signature-cache.ts'

function apple(command: string, args: string[], input?: string): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', input, timeout: 120_000 })
  if (result.error || result.status !== 0 || result.signal) throw new Error(`macOS signature cache: ${command} verification failed`)
  return result
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function plist(xml: string): unknown {
  if (xml.trim() === '') return {}
  return JSON.parse(apple('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], xml).stdout) as unknown
}
function inspect(path: string): { certificate: string; details: string; entitlements: unknown } {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-signature-policy-'))
  try {
    const prefix = join(directory, 'certificate')
    const result = apple('/usr/bin/codesign', ['--display', '--verbose=4', `--extract-certificates=${prefix}`, '--entitlements', '-', '--xml', path])
    return { certificate: digest(readFileSync(`${prefix}0`)), details: result.stderr, entitlements: plist(result.stdout) }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

/**
 * Resolve a policy from the keychain's signed probe and current implementation; no credential enters the key.
 * @param probe Verified thin executable signed by this invocation's temporary keychain.
 * @returns Factory for per-file signing and verification policies.
 */
export function macOSCachePolicy(probe: string):
(identifier: string, expected: MacOSSigningEnvironment, entitlements?: string) => MacOSCachedSigner {
  const certificate = inspect(probe).certificate
  const tools = ['/usr/bin/codesign', join(import.meta.dirname, 'verify-macos-signature.mjs'),
    join(import.meta.dirname, 'macos-cache-policy.ts'), join(import.meta.dirname, 'macos-signature-cache.ts')].map(path => digest(readFileSync(path)))
  return (identifier, expected, entitlements) => {
    const entitlementBytes = entitlements === undefined ? undefined : readFileSync(entitlements)
    const desired = entitlementBytes === undefined ? {} : plist(entitlementBytes.toString('utf8'))
    return {
      policy: JSON.stringify({ certificate, identifier, expected, entitlements: entitlementBytes?.toString('base64') ?? null, tools, os: release() }),
      sign: path => signMacOSRuntimeCode(path, identifier, expected, entitlements),
      verify: (path) => {
        if (!['cefaedfe', 'cffaedfe', 'feedface', 'feedfacf'].includes(readFileSync(path).subarray(0, 4).toString('hex'))) {
          throw new Error('macOS signature cache: only thin Mach-O files can be reused')
        }
        apple('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path])
        const actual = inspect(path)
        assertMacOSRuntimeSignatureDetails(actual.details, expected)
        if (actual.certificate !== certificate || !actual.details.split(/\r?\n/u).includes(`Identifier=${identifier}`)
          || !isDeepStrictEqual(actual.entitlements, desired)) {
          throw new Error('macOS signature cache: signature does not match certificate, identifier, or entitlements')
        }
      },
    }
  }
}
