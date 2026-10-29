/**
 * End-to-end probe of the ACL write-restriction sandbox, using the same
 * probes as the POC verification harness: the confined child must be able to
 * write into the granted target and temp directories, must be DENIED writing
 * anywhere else, and (documented boundary) may still READ outside — the
 * WRITE_RESTRICTED token intersects write accesses only.
 *
 * The escape target sits in its own scratch dir under the system temp
 * directory, OUTSIDE both granted trees: tempDir is an explicit private
 * mkdtemp directory (the API never grants the ambient temp root implicitly),
 * and the writable dir is a separate mkdtemp directory that contains neither
 * sibling. Nothing under the user profile is touched.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AclSandbox } from '../src/index.ts'

const isWin32 = process.platform === 'win32'

function pwshAvailable(): boolean {
  try {
    execFileSync('where.exe', ['pwsh'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!isWin32 || !pwshAvailable())('AclSandbox write restriction', () => {
  let scratchRoot!: string
  let writableDir!: string
  let isolatedTemp!: string
  let secretFile!: string
  let escapeFile!: string
  let sandbox: AclSandbox

  beforeAll(async () => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'dsh-acl-sandbox-'))
    writableDir = join(scratchRoot, 'writable')
    mkdirSync(writableDir)
    isolatedTemp = mkdtempSync(join(tmpdir(), 'dsh-acl-sandbox-temp-'))
    secretFile = join(scratchRoot, 'secret.txt')
    writeFileSync(secretFile, 'top secret - must stay readable to prove the read boundary')
    escapeFile = join(scratchRoot, 'escaped.txt')
    // The direct API requires this explicit private temp directory and its
    // own SID; it never widens the grant over the ambient temp root.
    sandbox = new AclSandbox({
      writableDirs: [writableDir],
      tempDir: isolatedTemp,
      writeSid: 'S-1-4-9000-4',
      tempWriteSid: 'S-1-4-9000-4-1',
      mode: 'workspace-write',
    })
    await sandbox.init()
  })

  afterAll(() => {
    sandbox.dispose()
    rmSync(scratchRoot, { recursive: true, force: true })
    rmSync(isolatedTemp, { recursive: true, force: true })
  })

  it('allows writes only in granted directories and denies the escape write', async () => {
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      `try{Set-Content -Path '${writableDir}\\child-wrote.txt' -Value ok -ErrorAction Stop;'TARGET-WRITE: OK'}catch{'TARGET-WRITE: DENIED'};`,
      `try{Set-Content -Path '${isolatedTemp}\\child-wrote.txt' -Value ok -ErrorAction Stop;'TEMP-WRITE: OK'}catch{'TEMP-WRITE: DENIED'};`,
      `try{Set-Content -Path '${escapeFile}' -Value ok -ErrorAction Stop;'ESCAPE-WRITE: OK (ESCAPE!)'}catch{'ESCAPE-WRITE: DENIED'};`,
      `try{Get-Content '${secretFile}' -ErrorAction Stop | Out-Null;'SECRET-READ: OK'}catch{'SECRET-READ: DENIED'}`,
    ].join('')
    const child = sandbox.spawn({
      command: 'pwsh',
      args: ['/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe],
      cwd: writableDir,
    })
    const result = await child.wait()
    const output = result.stdout.toString('utf8') + result.stderr.toString('utf8')

    expect(result.exitCode, `child output:\n${output}`).toBe(0)
    expect(output, `child output:\n${output}`).toContain('TARGET-WRITE: OK')
    expect(output, `child output:\n${output}`).toContain('TEMP-WRITE: OK')
    expect(output, `child output:\n${output}`).toContain('ESCAPE-WRITE: DENIED')
    // Documented boundary: WRITE_RESTRICTED intersects write accesses only,
    // so reads outside the allowlist still succeed.
    expect(output, `child output:\n${output}`).toContain('SECRET-READ: OK')
    expect(existsSync(escapeFile)).toBe(false)
    expect(existsSync(join(writableDir, 'child-wrote.txt'))).toBe(true)
  }, 30_000)

  it('fails closed when the write SID cannot be parsed (no unrestricted fallback)', async () => {
    // A malformed SID makes ConvertStringSidToSidW fail; init must throw
    // before any grant is applied and never spawn unrestricted.
    const broken = new AclSandbox({ writableDirs: [writableDir], tempDir: null, writeSid: 'S-1-4-abc-1', mode: 'workspace-write' })
    await expect(broken.init()).rejects.toThrow(/ConvertStringSidToSidW/u)
  }, 15_000)

  it('failed init clears provisional temp state before a retry', async () => {
    const broken = new AclSandbox({ writableDirs: [writableDir], tempDir: null, writeSid: 'S-1-4-abc-1', mode: 'workspace-write' })
    const provisionalState = broken as unknown as { tempDirResolved: string | undefined }
    provisionalState.tempDirResolved = isolatedTemp

    await expect(broken.init()).rejects.toThrow(/ConvertStringSidToSidW/u)
    expect(broken.tempDir).toBeUndefined()
  }, 15_000)
})
