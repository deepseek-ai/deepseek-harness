/** Shell facts and lookup failures retain remote execution semantics. */
import { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SshSubprocessRuntime } from '../src/index.ts'

it('validates remote shell facts and distinguishes a lookup miss from transport failure', async () => {
  const ctx = new Context()
  let facts: unknown = { platform: 'posix', defaultShell: '/remote/bin/zsh' }
  let failure: Error | undefined
  const request = vi.fn(async <T>(method: string, _params: unknown, schema: z.ZodType<T>): Promise<T> => {
    if (failure !== undefined) throw failure
    return schema.parse(method === 'terminal.environment' ? facts : '/remote/bin/bash')
  })
  ctx.provide('ssh', { request } as never)
  const runtime = new SshSubprocessRuntime(ctx)
  const signal = new AbortController().signal
  try {
    expect(await runtime.terminalEnvironment(signal)).toEqual(facts)
    expect(request).toHaveBeenCalledWith('terminal.environment', {}, expect.anything(), signal)
    facts = { platform: 'posix' }
    expect(await runtime.terminalEnvironment()).toEqual(facts)
    facts = { platform: 'untrusted' }
    await expect(runtime.terminalEnvironment()).rejects.toBeInstanceOf(z.ZodError)
    expect(await runtime.resolveExecutable('bash', undefined, signal)).toBe('/remote/bin/bash')
    failure = new RemoteOperationError('not installed', 'SUBPROCESS_EXECUTABLE_NOT_FOUND')
    await expect(runtime.resolveExecutable('absent')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    failure = new RemoteOperationError('permission', 'EACCES')
    await expect(runtime.resolveExecutable('bash')).rejects.toBe(failure)
    failure = new Error('SSH disconnected')
    await expect(runtime.resolveExecutable('bash')).rejects.toBe(failure)
  } finally { await ctx.fiber.dispose() }
})

it.skipIf(process.platform === 'win32')('queries the real helper and resizes its PTY without replacing the shell', async () => {
  const { createHelperHarness } = await import('../../ssh/tests/fixtures/helper.ts')
  const helper = await createHelperHarness()
  const ctx = new Context()
  ctx.provide('ssh', helper.connection as never)
  const runtime = new SshSubprocessRuntime(ctx)
  try {
    expect(await runtime.terminalEnvironment()).toMatchObject({ platform: 'posix' })
    await expect(runtime.resolveExecutable(`${helper.root}/absent`)).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    const terminal = await runtime.spawnTerminal({ argv: ['/bin/sh', '-i'], cwd: helper.root, cols: 80, rows: 24, terminalType: 'xterm-256color', graceMs: 100, shellActivity: true })
    let output = ''
    terminal.output.on('data', (chunk: Buffer) => { output += chunk.toString() })
    expect((await terminal.inspectActivity()).state).toBe('unknown')
    await terminal.resize(120, 40)
    await terminal.write('printf "REMOTE_TERM:%s\\n" "$TERM"; stty size\n')
    await expect.poll(() => output).toContain('REMOTE_TERM:xterm-256color')
    await expect.poll(() => output).toMatch(/40\s+120/u)
    await terminal.terminate()
    await terminal.done
  } finally {
    try { await ctx.fiber.dispose() } finally { await helper.close() }
  }
})
