import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rootCertificates } from 'node:tls'
import { expect, it, vi } from 'vitest'
import { inspectWindowsTokenIdentity, windowsTokenIdentityFailure } from '../scripts/windows-token-identity.ts'

const launch = vi.hoisted(() => vi.fn(async (_file: string, _args: string[], _options: { env: NodeJS.ProcessEnv; timeout: number }) => ({ stdout: '', stderr: '' })))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: launch }) }
})

const certificate = new X509Certificate(rootCertificates.find(pem => new X509Certificate(pem).publicKey.asymmetricKeyType === 'rsa')!)
const jwk = certificate.publicKey.export({ format: 'jwk' })
const modulus = Buffer.from(jwk.n!, 'base64url')
const exponent = Buffer.from(jwk.e!, 'base64url').reduce((value, byte) => value * 256 + byte, 0)
const blob = Buffer.alloc(20 + modulus.length)
blob[0] = 6; blob[1] = 2
blob.writeUInt32LE(0x2400, 4); blob.writeUInt32LE(0x31415352, 8)
blob.writeUInt32LE(modulus.length * 8, 12); blob.writeUInt32LE(exponent, 16)
Buffer.from(modulus).reverse().copy(blob, 20)
const input = { certificate: certificate.raw, container: 'fixture-container', environment: {} }

it('compares the returned public key with the certificate, not the container name', async () => {
  const query = vi.fn(async () => JSON.stringify({ status: 'public-keys', publicKeys: [blob.toString('base64')] }))
  expect(await inspectWindowsTokenIdentity({ ...input, query })).toBe('matched')
  expect(query).toHaveBeenCalledOnce()
  const other = Buffer.from(blob)
  other[20] = other[20]! ^ 2
  expect(await inspectWindowsTokenIdentity({ ...input, query: async () => JSON.stringify({
    status: 'public-keys', publicKeys: [other.toString('base64')],
  }) })).toBe('certificate-mismatch')
})

it.each(['provider-unavailable', 'container-unavailable', 'unknown'])('preserves public query result %s', async (status) => {
  expect(await inspectWindowsTokenIdentity({ ...input, query: async () => JSON.stringify({ status }) })).toBe(status)
})

it.each(['not json', '{}', '{"status":"public-keys","publicKeys":[]}',
  '{"status":"public-keys","publicKeys":["bad"]}', '{"status":"matched"}',
  JSON.stringify({ status: 'public-keys', publicKeys: [blob.toString('base64'), 'bad'] })])
('rejects incomplete or malformed public data without accepting a partial match: %s', async (output) => {
  expect(await inspectWindowsTokenIdentity({ ...input, query: async () => output })).toBe('unknown')
})

it('contains query failures without retrying or exposing diagnostics', async () => {
  const query = vi.fn(async () => { throw new Error('private fixture diagnostic') })
  expect(await inspectWindowsTokenIdentity({ ...input, query })).toBe('unknown')
  expect(query).toHaveBeenCalledOnce()
})

it('launches only the public query with no PIN, signing tool or inherited secrets', async () => {
  launch.mockClear()
  launch.mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'public-keys', publicKeys: [blob.toString('base64')] }), stderr: '' })
  expect(await inspectWindowsTokenIdentity({ ...input, environment: {
    PATH: 'fixture-path', DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'must-not-pass', API_KEY: 'must-not-pass',
    DSH_DESKTOP_WINDOWS_SIGNTOOL: 'must-not-run', NODE_OPTIONS: 'must-not-pass', NODE_PATH: 'must-not-pass',
  } })).toBe('matched')
  expect(launch).toHaveBeenCalledOnce()
  const [file, args, options] = launch.mock.calls[0]!
  expect(file).toBe('pwsh')
  expect(args).toContain('-NonInteractive')
  expect(args.at(-1)).toMatch(/windows-token-public-key\.ps1$/u)
  expect(options.timeout).toBe(15_000)
  expect(options.env).toEqual({ PATH: 'fixture-path', DSH_TOKEN_PUBLIC_CONTAINER: 'fixture-container' })
})

it('reports a helper timeout or stderr as unknown without retry', async () => {
  launch.mockClear()
  launch.mockRejectedValueOnce(new Error('timeout with private diagnostic'))
  expect(await inspectWindowsTokenIdentity(input)).toBe('unknown')
  expect(launch).toHaveBeenCalledOnce()
  launch.mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'public-keys', publicKeys: [blob.toString('base64')] }), stderr: 'unexpected' })
  expect(await inspectWindowsTokenIdentity(input)).toBe('unknown')
})

it('reports a missing query launcher without exposing process diagnostics or retrying', async () => {
  launch.mockClear()
  launch.mockRejectedValueOnce(Object.assign(new Error('private launcher diagnostic'), { code: 'ENOENT' }))
  const result = await inspectWindowsTokenIdentity(input)
  expect(result).toBe('unknown')
  expect(launch).toHaveBeenCalledOnce()
  const message = windowsTokenIdentityFailure('unknown')
  expect(message).toContain('PowerShell 7 (pwsh) can start')
  expect(message).not.toContain('private launcher diagnostic')
  expect(message).toContain('no signing was attempted')
})

it.skipIf(process.platform !== 'win32')('exercises native control flow with a fake CSP and never constructs the native adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'token-public-test-'))
  try {
    const source = resolve(import.meta.dirname, '../scripts/windows-token-public-key.cs')
    const runner = join(root, 'test.ps1')
    const fixture = resolve(import.meta.dirname, 'fixtures/windows-token-public-key-fake.cs')
    writeFileSync(runner, `param([string]$Source, [string]$Fixture)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ((Get-Content -LiteralPath $Source -Raw) + (Get-Content -LiteralPath $Fixture -Raw))
[FakeTokenPublicKey]::Test()
`)
    expect(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', runner, source, fixture], { encoding: 'utf8', timeout: 30_000 }))
      .toContain('fake CSP cases passed')
    const native = readFileSync(source, 'utf8')
    const provider = /Provider = "([^"]+)"/u.exec(native)![1]
    expect(readFileSync(resolve(import.meta.dirname, '../scripts/windows-sign.cmd'), 'utf8')).toContain(`/csp "${provider}"`)
    expect(native).toContain('CryptAcquireContextW(out context, container, Provider, 1, PublicContextFlags)')
    expect(native).toContain('CryptExportKey(key, IntPtr.Zero, 6, 0, bytes, ref length)')
    expect(native).not.toMatch(/CryptSign|CryptSetProvParam|CryptGenKey|CryptAcquireCertificatePrivateKey/u)
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3 }) }
})
