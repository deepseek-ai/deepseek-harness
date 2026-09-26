/** The unchanged sandbox-local → bash-sandbox → subprocess stack over the Worker Node layer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { setActiveVfs } from '../../src/storage/active.ts'
import { processAlive, signalProcess } from '../../src/node/process-table.ts'
import type { ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** Historical foreground shorthand over the unified execute() seam. */
async function run(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellRunResult> {
  return (await x.execute(spec)).result()
}


vi.mock('node:child_process', async () => await import('../../src/node/builtin_modules/implemented/child_process.ts'))

const WORKSPACE = '/dsh/workspace'
const OUTSIDE = '/dsh/home'
let vfs: MemoryVfs
const contexts: Context[] = []

beforeEach(() => {
  vfs = new MemoryVfs()
  setActiveVfs(vfs)
  vfs.mkdirSync(WORKSPACE, { recursive: true })
  vfs.mkdirSync(OUTSIDE, { recursive: true })
  vfs.mkdirSync('/dsh/tmp', { recursive: true })
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number): true => {
    if (signal === 0) {
      if (processAlive(pid)) return true
      const error = new Error('kill ESRCH') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    }
    signalProcess(pid, (signal ?? 'SIGTERM') as NodeJS.Signals)
    return true
  })
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  vi.restoreAllMocks()
})

/** Boot the production providers while only their platform primitives are replaced. */
async function setup(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<SandboxBashExecutor> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSandboxProvider)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: WORKSPACE })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { cwd: WORKSPACE })
  return ctx.shell as SandboxBashExecutor
}

describe('Worker Landlock through the production sandbox stack', () => {
  it('allows workspace and temp writes while classifying an outside write as denied', async () => {
    const bash = await setup('workspace-write')
    const allowed = await run(bash, bash.resolve({
      command: `echo workspace > ${WORKSPACE}/allowed.txt; echo temp > /tmp/allowed.txt`,
    }))
    expect(allowed.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(vfs.readFileSync(`${WORKSPACE}/allowed.txt`, 'utf8')).toBe('workspace\n')
    expect(vfs.readFileSync('/dsh/tmp/allowed.txt', 'utf8')).toBe('temp\n')

    const denied = await run(bash, bash.resolve({ command: `echo denied > ${OUTSIDE}/denied.txt` }))
    expect(denied.exitCode).toBe(1)
    expect(denied.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement: 'full' })
    expect(vfs.existsSync(`${OUTSIDE}/denied.txt`)).toBe(false)
  })

  it('keeps read-only confined and danger-full-access unwrapped', async () => {
    const readOnly = await setup('read-only')
    const strict = await run(readOnly, readOnly.resolve({
      command: `echo discarded > /dev/null; echo denied > ${WORKSPACE}/strict.txt`,
    }))
    expect(strict.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    expect(vfs.existsSync(`${WORKSPACE}/strict.txt`)).toBe(false)

    const unrestricted = await setup('danger-full-access')
    const result = await run(unrestricted, unrestricted.resolve({ command: `echo allowed > ${OUTSIDE}/full.txt` }))
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(vfs.readFileSync(`${OUTSIDE}/full.txt`, 'utf8')).toBe('allowed\n')
  })

  it('does not leak a concurrent command policy into another process', async () => {
    const bash = await setup('read-only')
    const strict = run(bash, bash.resolve({
      command: `sleep 0.02; echo denied > ${WORKSPACE}/strict.txt`,
    }))
    const writable = run(bash, bash.resolve({
      command: `echo allowed > ${WORKSPACE}/writable.txt`,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: WORKSPACE },
    }))
    const [strictResult, writableResult] = await Promise.all([strict, writable])
    expect(strictResult.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    expect(writableResult.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(vfs.existsSync(`${WORKSPACE}/strict.txt`)).toBe(false)
    expect(vfs.readFileSync(`${WORKSPACE}/writable.txt`, 'utf8')).toBe('allowed\n')
  })
})
