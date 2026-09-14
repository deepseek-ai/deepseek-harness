/**
 * The win32 chain's argv contract, denial dialect, and runner-failure rules,
 * exercised through the REAL LocalSandboxProvider.confine() with an injected
 * platform and runner argv prefix. Platform-independent assertions: they run
 * in every CI lane (Windows included, where sandbox-local's own POSIX-only
 * suites are excluded) — the end-to-end runner behavior lives in
 * runner.spec.ts on win32 hosts.
 */

import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

const RO: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' }
const WW: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/ws' }

async function setup(internals: LocalSandboxProvider['internals']) {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = internals
  return sandbox
}

describe('windows-acl win32 chain (LocalSandboxProvider)', () => {
  it('agentless workspace-write: runner argv prefix, temp root, mode flag, partial enforcement, ACL denial dialect', async () => {
    const probeWindowsAcl = vi.fn(() => true)
    const sandbox = await setup({
      platform: 'win32',
      windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'],
      probeWindowsAcl,
    })
    const confined = await sandbox.confine(['pwsh', '/Command', 'x'], WW)
    expect(confined.argv).toEqual([
      'node', 'windows-acl-runner.js',
      '--workspace', '/ws',
      '--temp', tmpdir(),
      '--mode', 'workspace-write',
      '--',
      'pwsh', '/Command', 'x',
    ])
    expect(confined.enforcement).toBe('partial')
    expect(confined.denialSignatures).toEqual(['access is denied', 'access to the path', 'permission denied', 'operation not permitted'])
    expect(confined.runnerFailureRules).toEqual([{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }])
    // A sole candidate is selected unprobed.
    expect(probeWindowsAcl).not.toHaveBeenCalled()
  })

  it('read-only: same runner and contract, read-only mode flag', async () => {
    const sandbox = await setup({ platform: 'win32', windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'] })
    const confined = await sandbox.confine(['true'], RO)
    expect(confined.argv.slice(-4)).toEqual(['--mode', 'read-only', '--', 'true'])
    expect(confined.enforcement).toBe('partial')
    expect(confined.runnerFailureRules).toEqual([{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }])
  })
})
