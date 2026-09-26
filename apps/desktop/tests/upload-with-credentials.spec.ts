import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCredentialUploadEnvironment } from '../scripts/upload-target.ts'

const execute = promisify(execFile)
const launcher = fileURLToPath(new URL('../scripts/upload-with-credentials.ps1', import.meta.url))
const roots: string[] = []
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`

async function check(mode: 'valid' | 'plaintext' | 'blank' | 'missing' | 'upload' | 'upload-failure', deployment = 'production') {
  const root = await mkdtemp(join(tmpdir(), 'desktop-credentials-'))
  roots.push(root)
  const credentialPath = join(root, 'credential.clixml')
  let entry = launcher
  let uploadArguments = ''
  if (mode === 'upload' || mode === 'upload-failure') {
    const scripts = join(root, 'apps/desktop/scripts')
    await mkdir(scripts, { recursive: true })
    entry = join(scripts, 'upload-with-credentials.ps1')
    await copyFile(launcher, entry)
    await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction')
    // Replace only the child uploader: this fixture must never contact real release storage.
    await writeFile(join(scripts, 'upload-target.ts'), `
      import assert from 'node:assert/strict'
      assert.equal(process.env.DOWNLOAD_PROD_COS_SECRET_ID, 'fixture-id')
      assert.equal(process.env.DOWNLOAD_PROD_COS_SECRET_KEY, 'fixture-secret')
      assert.equal(process.env.DOWNLOAD_PROD_COS_BUCKET, 'fixture-bucket')
      assert.equal(process.env.DOWNLOAD_TEST_COS_SECRET_KEY, undefined)
      assert.equal(process.env.DSH_DESKTOP_WINDOWS_TOKEN_PIN, undefined)
      assert.equal(process.env.NODE_OPTIONS, undefined)
      assert.equal(process.argv[2], 'win-x64')
      assert.deepEqual(process.argv.slice(3), ['--credential-launcher', '--environment', 'production', '--bucket', 'fixture-bucket'])
      console.log('fixture-id fixture-secret')
      console.error('private service details fixture-secret')
      process.exit(${mode === 'upload-failure' ? 17 : 0})
    `)
    uploadArguments = ' -Upload -Target win-x64 -Bucket fixture-bucket'
  }
  const setup = mode === 'missing' ? '' : `
    [pscustomobject]@{
      SecretId = ${mode === 'plaintext' ? "'fixture-id'" : "ConvertTo-SecureString 'fixture-id' -AsPlainText -Force"}
      SecretKey = ConvertTo-SecureString '${mode === 'blank' ? ' ' : 'fixture-secret'}' -AsPlainText -Force
    } | Export-Clixml -LiteralPath ${quote(credentialPath)}
  `
  const script = `
    $ErrorActionPreference = 'Stop'
    ${setup}
    $env:DOWNLOAD_PROD_COS_SECRET_ID = 'parent-sentinel'
    $env:DOWNLOAD_TEST_COS_SECRET_KEY = 'unrelated-test-key'
    $env:DSH_DESKTOP_WINDOWS_TOKEN_PIN = 'unrelated-signing-pin'
    $env:NODE_OPTIONS = '--require=missing-preload-must-not-run'
    $global:LASTEXITCODE = 0
    & ${quote(entry)} -CredentialFile ${quote(credentialPath)} -Environment ${quote(deployment)}${uploadArguments}
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($env:DOWNLOAD_PROD_COS_SECRET_ID -ne 'parent-sentinel') { throw 'Parent environment changed' }
    Write-Output 'parent environment unchanged'
  `
  // The child creates its own DPAPI file; real runner credentials never enter the fixture.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^DSH_DESKTOP_WINDOWS_|^APPLE_|^CSC_/iu.test(name),
  ))
  const pathKey = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`
  try {
    const result = await execute('pwsh', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { env, timeout: 30_000 })
    return { code: 0, output: result.stdout + result.stderr }
  }
  catch (error) {
    const result = error as Error & { code: number | string; stdout: string; stderr: string; killed?: boolean }
    expect(result.killed).not.toBe(true)
    expect(typeof result.code).toBe('number')
    return { code: result.code, output: result.stdout + result.stderr }
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
})

describe('credential launcher destination', () => {
  const fileEnvironment = {
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'test', DOWNLOAD_TEST_ORIGIN: 'https://download-test.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    DOWNLOAD_TEST_COS_BUCKET: 'test-bucket', DOWNLOAD_TEST_COS_SECRET_ID: 'stale-id', DOWNLOAD_TEST_COS_SECRET_KEY: 'stale-key',
  }
  const injectedEnvironment = {
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'test', DOWNLOAD_TEST_COS_BUCKET: 'test-bucket',
    DOWNLOAD_TEST_COS_SECRET_ID: 'decrypted-id', DOWNLOAD_TEST_COS_SECRET_KEY: 'decrypted-key',
  }

  it('uses decrypted credentials only for the matching packaged deployment and bucket', () => {
    expect(resolveCredentialUploadEnvironment(fileEnvironment, injectedEnvironment, 'test', 'test-bucket', 'win-x64'))
      .toMatchObject({ DOWNLOAD_TEST_COS_SECRET_ID: 'decrypted-id', DOWNLOAD_TEST_COS_SECRET_KEY: 'decrypted-key' })
    expect(() => resolveCredentialUploadEnvironment(fileEnvironment, injectedEnvironment, 'production', 'test-bucket', 'win-x64'))
      .toThrow(/differs from the packaged release destination/u)
    expect(() => resolveCredentialUploadEnvironment(fileEnvironment, injectedEnvironment, 'test', 'other-bucket', 'win-x64'))
      .toThrow(/differs from the packaged release destination/u)
  })

  it('rejects child credentials that do not match the explicit launcher selection', () => {
    expect(() => resolveCredentialUploadEnvironment(fileEnvironment, { ...injectedEnvironment,
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    }, 'test', 'test-bucket', 'win-x64')).toThrow(/differs from its explicit arguments/u)
    expect(() => resolveCredentialUploadEnvironment(fileEnvironment, { ...injectedEnvironment,
      DOWNLOAD_TEST_COS_SECRET_KEY: '',
    }, 'test', 'test-bucket', 'win-x64')).toThrow(/DOWNLOAD_TEST_COS_SECRET_KEY/u)
  })
})

// DPAPI's user-and-machine encryption is Windows-only.
describe.skipIf(process.platform !== 'win32')('Windows upload credentials', () => {
  it.each(['production', 'test'])('checks %s credentials without uploading or changing the parent', async (deployment) => {
    const result = await check('valid', deployment)
    expect(result.code, result.output).toBe(0)
    const expected = await readFile(new URL('./expected/upload-credentials-check.txt', import.meta.url), 'utf8')
    expect(result.output.replaceAll('\r\n', '\n')).toBe(expected)
    expect(result.output).not.toContain('fixture-id')
    expect(result.output).not.toContain('fixture-secret')
    expect(result.output).not.toContain('uploading')
  })

  it.each(['plaintext', 'blank', 'missing'] as const)('rejects %s credentials without printing values', async (mode) => {
    const result = await check(mode)
    expect(result.code).toBe(1)
    expect(result.output).toContain('desktop credentials: failed;')
    expect(result.output).not.toContain('fixture-id')
    expect(result.output).not.toContain('fixture-secret')
    expect(result.output).not.toContain('child environment verified')
  })

  it.each(['upload', 'upload-failure'] as const)('isolates the %s child and sanitizes both output streams', async (mode) => {
    const result = await check(mode)
    expect(result.code, result.output).toBe(mode === 'upload' ? 0 : 1)
    expect(result.output).toContain('[REDACTED] [REDACTED]')
    expect(result.output).not.toContain('fixture-id')
    expect(result.output).not.toContain('fixture-secret')
    expect(result.output).not.toContain('private service details')
  })
})
