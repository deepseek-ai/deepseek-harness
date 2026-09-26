/**
 * Real-backend end-to-end: LocalSandboxProvider (win32 chain → the
 * windows-acl runner), SandboxPolicyService, and SandboxPwshExecutor with
 * REAL pwsh spawns confined through the runner — the debug-instance
 * verification of both modes on ordinary user-owned paths: read-only denies
 * writes, workspace-write allows its promised roots while denying escape
 * writes, and the partial-enforcement/denial facts ride the settled result.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SandboxPwshExecutor } from '../src/index.ts'
import type { ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** Historical foreground shorthand over the unified execute() seam. */
async function run(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellRunResult> {
  return (await x.execute(spec)).result()
}


const isWin32 = process.platform === 'win32'

function pwshAvailable(): boolean {
  return spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0
}

describe.skipIf(!isWin32 || !pwshAvailable())('pwsh-sandbox real ACL confinement', () => {
  let scratchRoot!: string
  let writableDir!: string
  let outsideTempDir!: string
  let secretFile!: string
  let escapeFile!: string
  let executor!: SandboxPwshExecutor

  beforeAll(async () => {
    // The workspace escape sits under the profile. A separate directory under
    // the ambient temp root proves that the root itself is not granted: the
    // runner creates its own private child and rewrites TMP/TEMP to it.
    scratchRoot = mkdtempSync(join(homedir(), 'dsh-pwsh-sandbox-e2e-'))
    writableDir = join(scratchRoot, 'writable')
    mkdirSync(writableDir)
    outsideTempDir = mkdtempSync(join(tmpdir(), 'dsh-pwsh-sandbox-e2e-outside-temp-'))
    secretFile = join(scratchRoot, 'secret.txt')
    writeFileSync(secretFile, 'top secret - must stay readable to prove the read boundary')
    escapeFile = join(scratchRoot, 'escaped.txt')

    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: writableDir })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SandboxPwshExecutor, {})
    executor = ctx.shell as SandboxPwshExecutor
  })

  afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true })
    rmSync(outsideTempDir, { recursive: true, force: true })
  })

  it('read-only: ordinary path writes denied, reads fine, partial and denial facts ride the result', async () => {
    const policy: SandboxExecutionPolicy = { mode: 'read-only', workspaceRoot: writableDir }
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      `try{Set-Content -Path '${writableDir}\\ro-write.txt' -Value ok -ErrorAction Stop;'TARGET-WRITE: OK'}catch{'TARGET-WRITE: DENIED'};`,
      `try{Set-Content -Path '${outsideTempDir}\\ro-write.txt' -Value ok -ErrorAction Stop;'TEMP-WRITE: OK'}catch{'TEMP-WRITE: DENIED'};`,
      `try{Set-Content -Path '${escapeFile}' -Value ok -ErrorAction Stop;'ESCAPE-WRITE: OK'}catch{'ESCAPE-WRITE: DENIED'};`,
      `try{Get-Content '${secretFile}' -ErrorAction Stop | Out-Null;'SECRET-READ: OK'}catch{'SECRET-READ: DENIED'}`,
    ].join('')
    const result = await run(executor, executor.resolve({ command: probe, sandboxPolicy: policy }))
    expect(result.exitCode, `stderr: ${result.stderr.text}`).toBe(0)
    expect(result.stdout.text).toContain('TARGET-WRITE: DENIED')
    expect(result.stdout.text).toContain('TEMP-WRITE: DENIED')
    expect(result.stdout.text).toContain('ESCAPE-WRITE: DENIED')
    expect(result.stdout.text).toContain('SECRET-READ: OK')
    expect(existsSync(join(writableDir, 'ro-write.txt'))).toBe(false)
    // A self-caught denial keeps the command exit 0: no denial fact.
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })

    // A raw failing write must classify as a denial of the ACL dialect.
    const denied = await run(executor, executor.resolve({
      command: `Set-Content -Path '${escapeFile}' -Value x`,
      sandboxPolicy: policy,
    }))
    expect(denied.exitCode).not.toBe(0)
    expect(denied.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
  }, 60_000)

  it('workspace-write: workspace and private temp writable, ambient temp and escape denied', async () => {
    const policy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: writableDir }
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      `try{Set-Content -Path '${writableDir}\\ww-write.txt' -Value ok -ErrorAction Stop;'TARGET-WRITE: OK'}catch{'TARGET-WRITE: DENIED'};`,
      "try{Set-Content -Path (Join-Path $env:TEMP 'ww-write.txt') -Value ok -ErrorAction Stop;'TEMP-WRITE: OK'}catch{'TEMP-WRITE: DENIED'};",
      `try{Set-Content -Path '${outsideTempDir}\\ww-write.txt' -Value ok -ErrorAction Stop;'AMBIENT-TEMP-WRITE: OK'}catch{'AMBIENT-TEMP-WRITE: DENIED'};`,
      `try{Set-Content -Path '${escapeFile}' -Value ok -ErrorAction Stop;'ESCAPE-WRITE: OK'}catch{'ESCAPE-WRITE: DENIED'};`,
      `try{Get-Content '${secretFile}' -ErrorAction Stop | Out-Null;'SECRET-READ: OK'}catch{'SECRET-READ: DENIED'};`,
      "'TEMP-PATH: ' + $env:TEMP",
    ].join('')
    const result = await run(executor, executor.resolve({ command: probe, sandboxPolicy: policy }))
    expect(result.exitCode, `stderr: ${result.stderr.text}`).toBe(0)
    expect(result.stdout.text).toContain('TARGET-WRITE: OK')
    expect(result.stdout.text).toContain('TEMP-WRITE: OK')
    expect(result.stdout.text).toContain('AMBIENT-TEMP-WRITE: DENIED')
    expect(result.stdout.text).toContain('ESCAPE-WRITE: DENIED')
    expect(result.stdout.text).toContain('SECRET-READ: OK')
    expect(existsSync(join(writableDir, 'ww-write.txt'))).toBe(true)
    expect(existsSync(join(outsideTempDir, 'ww-write.txt'))).toBe(false)
    expect(existsSync(escapeFile)).toBe(false)
    const privateTemp = result.stdout.text.match(/^TEMP-PATH: (.+)$/mu)?.[1]?.trim()
    expect(privateTemp).toBeDefined()
    expect(privateTemp?.startsWith(tmpdir())).toBe(true)
    expect(existsSync(privateTemp ?? '')).toBe(false)
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'partial' })
  }, 60_000)
})
