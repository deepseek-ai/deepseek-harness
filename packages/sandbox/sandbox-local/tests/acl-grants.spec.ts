/**
 * windows-acl grant ownership through the real LocalSandboxProvider: one
 * standing capability per workspace plus one random, distinct, revocable
 * temp capability per live session/workspace pair. The Win32 grant surface
 * is mocked; native access checks live in sandbox-windows-acl's runner suite.
 */

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

/** Cross-file state shared with the vi.mock factory (hoisting contract). */
const mockState = vi.hoisted(() => ({
  grants: [] as Array<{ writeSid: string; added: Array<{ path: string; standing: boolean }>; disposed: boolean }>,
  addFailure: undefined as Error | undefined,
  /** Restrict an add failure to standing (workspace) or revocable (temp). */
  addFailureStanding: undefined as boolean | undefined,
  createTempFailure: undefined as Error | undefined,
  disposeFailure: undefined as Error | undefined,
}))

vi.mock('@deepseek-ai/dsh-sandbox-windows-acl', () => {
  class MockAclWriteGrant {
    readonly writeSid: string
    readonly added: Array<{ path: string; standing: boolean }> = []
    disposed = false
    constructor(writeSid: string) {
      this.writeSid = writeSid
      mockState.grants.push(this)
    }
    static create(writeSid: string): MockAclWriteGrant {
      if (writeSid.startsWith('TEMP:') && mockState.createTempFailure !== undefined) throw mockState.createTempFailure
      return new MockAclWriteGrant(writeSid)
    }
    add(path: string, standing = false): void {
      this.added.push({ path, standing })
      if (mockState.addFailure !== undefined
        && (mockState.addFailureStanding === undefined || mockState.addFailureStanding === standing)) {
        throw mockState.addFailure
      }
    }
    dispose(): void {
      if (mockState.disposeFailure !== undefined) throw mockState.disposeFailure
      this.disposed = true
    }
  }
  return {
    AclWriteGrant: MockAclWriteGrant,
    assertTempRootOutsideWorkspace: (workspaceRoot: string, tempRoot: string) => {
      const workspace = realpathSync.native(workspaceRoot)
      const temp = realpathSync.native(tempRoot)
      if (temp === workspace || temp.startsWith(`${workspace}${process.platform === 'win32' ? '\\' : '/'}`)) {
        throw new Error(`Windows ACL temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`)
      }
    },
    workspaceWriteSid: () => 'S-1-4-42-42',
    tempWriteSid: (path: string) => `TEMP:${path}`,
  }
})

const WORKSPACE_SID = 'S-1-4-42-42'

async function setup() {
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { platform: 'win32', windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'] }
  return { ctx, sandbox, fiber }
}

function workspaceRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dsh-acl-grants-ws-')))
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

describe('windows-acl write grants (LocalSandboxProvider)', () => {
  const scratch: string[] = []

  beforeEach(() => {
    mockState.grants = []
    mockState.addFailure = undefined
    mockState.addFailureStanding = undefined
    mockState.createTempFailure = undefined
    mockState.disposeFailure = undefined
  })

  const cleanup = () => {
    for (const grant of mockState.grants) {
      for (const added of grant.added) {
        if (!added.standing) rmSync(added.path, { recursive: true, force: true })
      }
    }
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  }

  it('does not create grants for a cancelled confinement request', async () => {
    const { sandbox, fiber } = await setup()
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const reason = new Error('cancel before grant creation')
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('cancelled'),
      }, AbortSignal.abort(reason))).rejects.toBe(reason)
      expect(mockState.grants).toEqual([])
    } finally { await fiber.dispose(); cleanup() }
  })

  it('workspace-write materializes one standing workspace grant and one private temp capability, then reuses both', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-1') }

      const confined = await sandbox.confine(['pwsh', '/Command', 'x'], policy)
      const tempDir = flag(confined.argv, '--temp')
      const tempSid = flag(confined.argv, '--temp-write-sid')
      expect(tempDir).toBeDefined()
      expect(basename(tempDir ?? '')).toMatch(/^dsh-[A-Za-z0-9_-]{6}$/u)
      expect(tempSid).toBe(`TEMP:${tempDir}`)
      expect(tempSid).not.toBe(WORKSPACE_SID)
      expect(confined.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', tempDir,
        '--mode', 'workspace-write',
        '--write-sid', WORKSPACE_SID,
        '--temp-write-sid', tempSid,
        '--',
        'pwsh', '/Command', 'x',
      ])
      expect(mockState.grants).toEqual([
        expect.objectContaining({ writeSid: WORKSPACE_SID, added: [{ path: ws, standing: true }], disposed: false }),
        expect.objectContaining({ writeSid: tempSid, added: [{ path: tempDir, standing: false }], disposed: false }),
      ])
      expect(existsSync(tempDir ?? '')).toBe(true)

      expect((await sandbox.confine(['pwsh', '/Command', 'x'], policy)).argv).toEqual(confined.argv)
      expect(mockState.grants).toHaveLength(2)

      await fiber.dispose()
      expect(mockState.grants.every(grant => grant.disposed)).toBe(true)
      expect(existsSync(tempDir ?? '')).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('read-only materializes no capability; upgrade creates them and downgrade leaves them reusable', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws, sessionId: SessionId('switch') }
      const workspaceWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('switch') }

      expect((await sandbox.confine(['true'], readOnly)).argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', tmpdir(),
        '--mode', 'read-only',
        '--',
        'true',
      ])
      expect(mockState.grants).toHaveLength(0)

      const upgraded = await sandbox.confine(['true'], workspaceWrite)
      expect(flag(upgraded.argv, '--temp-write-sid')).not.toBe(WORKSPACE_SID)
      expect(mockState.grants).toHaveLength(2)
      await sandbox.confine(['true'], readOnly)
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants.every(grant => !grant.disposed)).toBe(true)
      expect((await sandbox.confine(['true'], workspaceWrite)).argv).toEqual(upgraded.argv)

      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('a fresh provider gives a resumed session a new temp path and SID, so crash residue cannot collide', async () => {
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('resumed') }
      const first = await setup()
      const firstConfined = await first.sandbox.confine(['true'], policy)
      const firstTemp = flag(firstConfined.argv, '--temp') ?? ''

      // The first provider remains live: model an unclean prior process whose
      // temp directory and ACE survived. A new provider must still proceed.
      const second = await setup()
      const secondConfined = await second.sandbox.confine(['true'], policy)
      const secondTemp = flag(secondConfined.argv, '--temp') ?? ''
      expect(secondTemp).not.toBe(firstTemp)
      expect(flag(secondConfined.argv, '--temp-write-sid')).not.toBe(flag(firstConfined.argv, '--temp-write-sid'))
      expect(existsSync(firstTemp)).toBe(true)
      expect(existsSync(secondTemp)).toBe(true)

      await second.fiber.dispose()
      await first.fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('forks and workspace changes receive distinct temp capabilities while each workspace grant is reused', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const wsA = workspaceRoot()
      const wsB = workspaceRoot()
      scratch.push(wsA, wsB)
      const parent = await sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsA, sessionId: SessionId('parent') })
      const child = await sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsA, sessionId: SessionId('child') })
      const moved = await sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsB, sessionId: SessionId('parent') })

      expect(flag(child.argv, '--temp')).not.toBe(flag(parent.argv, '--temp'))
      expect(flag(child.argv, '--temp-write-sid')).not.toBe(flag(parent.argv, '--temp-write-sid'))
      expect(flag(moved.argv, '--temp')).not.toBe(flag(parent.argv, '--temp'))
      expect(mockState.grants).toHaveLength(5) // workspace A + two temps + workspace B + one temp

      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('workspace grant failure disposes its SID, aggregates cleanup failure, and never creates a temp directory', async () => {
    try {
      const { sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      mockState.addFailureStanding = true
      mockState.addFailure = new Error('workspace grant exploded')
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('workspace-fail'),
      })).rejects.toThrow('workspace grant exploded')
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]!.disposed).toBe(true)

      mockState.disposeFailure = new Error('workspace cleanup exploded')
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('workspace-cleanup-fail'),
      })).rejects.toThrow(/workspace grant failed and its cleanup also failed/u)
      expect(mockState.grants).toHaveLength(2)
    } finally {
      cleanup()
    }
  })

  it('rejects a workspace containing the ambient temp root before any ACL mutation', async () => {
    const { sandbox } = await setup()
    await expect(sandbox.confine(['true'], {
      mode: 'workspace-write', workspaceRoot: realpathSync.native(tmpdir()), sessionId: SessionId('overlap'),
    })).rejects.toThrow(/temp root must be outside the workspace/u)
    expect(mockState.grants).toHaveLength(0)
  })

  it('temp grant creation/add failures remove the random directory; cleanup failures aggregate', async () => {
    try {
      const { sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)

      mockState.createTempFailure = new Error('temp SID creation exploded')
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('create-fail'),
      })).rejects.toThrow('temp SID creation exploded')
      expect(mockState.grants).toHaveLength(1) // workspace only; random temp was removed

      mockState.createTempFailure = undefined
      mockState.addFailureStanding = false
      mockState.addFailure = new Error('temp add exploded')
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('add-fail'),
      })).rejects.toThrow('temp add exploded')
      const failedTempGrant = mockState.grants.at(-1)
      expect(failedTempGrant?.disposed).toBe(true)
      expect(failedTempGrant?.added).toHaveLength(1)
      expect(existsSync(failedTempGrant?.added[0]?.path ?? '')).toBe(false)

      mockState.addFailureStanding = false
      mockState.addFailure = new Error('temp add exploded')
      sandbox.internals.rmTempDir = () => { throw new Error('temp rm exploded') }
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('rm-fail'),
      })).rejects.toThrow(/temp grant materialization failed and its cleanup also failed/u)
      delete sandbox.internals.rmTempDir

      mockState.addFailureStanding = false
      mockState.addFailure = new Error('temp add exploded')
      mockState.disposeFailure = new Error('temp cleanup exploded')
      await expect(sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('aggregate-fail'),
      })).rejects.toThrow(/temp grant materialization failed and its cleanup also failed/u)
    } finally {
      cleanup()
    }
  })

  it('agentless calls pass a temp root and no capabilities; the runner owns the private child lifecycle', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const confined = await sandbox.confine(['pwsh', '/Command', 'x'], { mode: 'workspace-write', workspaceRoot: '/ws' })
      expect(confined.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', '/ws',
        '--temp', tmpdir(),
        '--mode', 'workspace-write',
        '--',
        'pwsh', '/Command', 'x',
      ])
      expect(mockState.grants).toHaveLength(0)
      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('provider teardown reports grant and directory cleanup failures without aborting teardown', async () => {
    try {
      const { ctx, sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const confined = await sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('dispose'),
      })
      const tempDir = flag(confined.argv, '--temp') ?? ''
      mockState.disposeFailure = new Error('revoke exploded')
      sandbox.internals.rmTempDir = () => { throw new Error('rm exploded') }
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

      await fiber.dispose()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup completed with 3 failure(s)'))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'revoke exploded' }))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'rm exploded' }))
      expect(existsSync(tempDir)).toBe(true) // injected removal failed; test cleanup reclaims it
    } finally {
      cleanup()
    }
  })
})
