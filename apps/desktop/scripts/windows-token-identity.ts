/** Compare CSP public material without supplying a PIN or invoking a signing operation. */
import { execFile } from 'node:child_process'
import { createPublicKey, X509Certificate } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

/** Public-data results do not attest physical device presence, authentication or remaining PIN attempts. */
export type WindowsTokenIdentity = 'matched' | 'certificate-mismatch' | 'provider-unavailable' | 'container-unavailable' | 'unknown'

interface PublicKeyQuery {
  container: string
  environment: NodeJS.ProcessEnv
}

async function queryPublicKeys({ container, environment }: PublicKeyQuery): Promise<string> {
  const { NODE_OPTIONS: _options, NODE_PATH: _path, ...safeEnvironment } = scrubWindowsSigningEnvironment(environment)
  const { stdout, stderr } = await promisify(execFile)('pwsh', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./windows-token-public-key.ps1', import.meta.url))], {
    env: { ...safeEnvironment, DSH_TOKEN_PUBLIC_CONTAINER: container },
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
  })
  if (stderr) throw new Error('Public-key query returned diagnostics')
  return stdout
}

function publicBlobKey(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || bytes.length < 20 || bytes[0] !== 6 || bytes[1] !== 2
    || bytes.readUInt16LE(2) !== 0 || ![0x2400, 0xa400].includes(bytes.readUInt32LE(4))
    || bytes.readUInt32LE(8) !== 0x31415352) throw new Error('Invalid RSA public blob')
  const bits = bytes.readUInt32LE(12)
  const exponent = bytes.readUInt32LE(16)
  if (bits < 512 || bits % 8 !== 0 || bytes.length !== 20 + bits / 8 || exponent < 3 || exponent % 2 === 0) {
    throw new Error('Invalid RSA public parameters')
  }
  const exponentBytes = Buffer.alloc(4)
  exponentBytes.writeUInt32BE(exponent)
  const first = exponentBytes.findIndex(byte => byte !== 0)
  return createPublicKey({ format: 'jwk', key: { kty: 'RSA',
    n: Buffer.from(bytes.subarray(20)).reverse().toString('base64url'),
    e: exponentBytes.subarray(first).toString('base64url') } }).export({ format: 'der', type: 'spki' })
}

/**
 * Read both CSP public key slots and compare them with the configured certificate; never sign or retry.
 * @param options Certificate bytes, container, process environment and optional isolated public-query adapter.
 * @returns Matched public information, a specific unavailable/mismatch result, or unknown on incomplete/invalid output.
 */
export async function inspectWindowsTokenIdentity(options: PublicKeyQuery & {
  certificate: Uint8Array
  query?: (input: PublicKeyQuery) => Promise<string>
}): Promise<WindowsTokenIdentity> {
  try {
    const value: unknown = JSON.parse(await (options.query ?? queryPublicKeys)({
      container: options.container, environment: options.environment,
    }))
    if (!value || typeof value !== 'object' || !('status' in value)) return 'unknown'
    if (value.status === 'provider-unavailable' || value.status === 'container-unavailable') return value.status
    if (value.status !== 'public-keys' || !('publicKeys' in value) || !Array.isArray(value.publicKeys)
      || value.publicKeys.length < 1 || value.publicKeys.length > 2) return 'unknown'
    const keys = value.publicKeys.map((key: unknown) => {
      if (typeof key !== 'string') throw new Error('Invalid public key')
      return publicBlobKey(key)
    })
    const expected = new X509Certificate(options.certificate).publicKey.export({ format: 'der', type: 'spki' })
    return keys.some(key => key.equals(expected)) ? 'matched' : 'certificate-mismatch'
  } catch {
    // Native failures may include container names or inherited diagnostics; expose only the incomplete result.
    return 'unknown'
  }
}

/**
 * Explain why public-data validation stopped signing without asserting device lock or authentication status.
 * @param result Non-matching public-data result.
 * @returns A credential-free operator diagnostic.
 */
export function windowsTokenIdentityFailure(result: Exclude<WindowsTokenIdentity, 'matched'>): string {
  const reasons = {
    'provider-unavailable': 'The configured eToken provider is unavailable; check the SafeNet driver.',
    'container-unavailable': 'The configured container could not be opened; after replacing the UKey, check its container name and visibility.',
    'certificate-mismatch': 'The returned container public keys do not match the configured certificate; check the certificate and container after replacing the UKey.',
    unknown: 'The container public identity could not be confirmed; check that PowerShell 7 (pwsh) can start, then check device visibility and SafeNet public-information support.',
  }
  return `${reasons[result]} No PIN was supplied and no signing was attempted by this check. Signing stopped; device lock and PIN retry counts are unknown.`
}
