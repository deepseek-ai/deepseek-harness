import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuCli } from '../src/cli.ts'
import { createBinDir, ScriptedSubprocess } from './harness.ts'

const LIMITS = { commandTimeoutMs: 5_000, maxOutputBytes: 1024 }

describe('FeishuCli', () => {
  let ctx: Context
  let subprocess: ScriptedSubprocess
  let binDir: string

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(ScriptedSubprocess)
    await ctx.plugin(ShellEnv)
    subprocess = ctx.subprocess as ScriptedSubprocess
    binDir = await createBinDir()
    ctx.shellEnv.registerPath({ name: 'feishu', directories: [binDir] })
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(binDir, { recursive: true, force: true })
  })

  const cli = (limits = LIMITS) => new FeishuCli(ctx.subprocess, ctx.shellEnv, limits)

  it('finds lark-cli on the prepared private PATH, spawns it with that environment, and parses stdout', async () => {
    subprocess.respond = (process) => { process.reply({ stdout: '{"ok":true}' }) }

    await expect(cli().json(['skills', 'list', '--json'], AbortSignal.timeout(5_000))).resolves.toEqual({ ok: true })

    const [lookup] = subprocess.lookups
    expect(lookup?.command).toBe('lark-cli')
    expect(lookup?.env?.PATH?.split(delimiter)[0]).toBe(binDir)
    const [process] = subprocess.processes
    expect(process?.spec).toMatchObject({
      argv: ['/fixture/bin/lark-cli', 'skills', 'list', '--json'],
      cwd: homedir(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 } },
    })
    expect(process?.spec.env).toBe(lookup?.env)
    expect(process?.terminated).toBe(true)
  })

  it.each([
    [{ exitCode: 2, stderr: ' {"ok":false} \n' }, 'lark-cli skills list exited with 2: {"ok":false}'],
    [{ exitCode: 1 }, /^lark-cli skills list exited with 1$/u],
    [{ exitCode: null, signal: 'SIGKILL' as const }, 'lark-cli skills list exited with SIGKILL'],
    [{ stdout: '{"ok":', lossy: true }, 'lark-cli skills list output exceeded 1024 bytes'],
    [{ stdout: 'not json' }, 'lark-cli skills list returned invalid JSON'],
  ])('rejects a failed command %#', async (reply, message) => {
    subprocess.respond = (process) => { process.reply(reply) }

    await expect(cli().json(['skills', 'list'], AbortSignal.timeout(5_000))).rejects.toThrow(message)
  })

  it.each(['lookup', 'process'] as const)('applies the command deadline during %s', async (phase) => {
    if (phase === 'lookup') {
      subprocess.lookup = signal => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason instanceof Error ? signal.reason : new Error('lookup aborted')) }, { once: true })
      })
    } else {
      subprocess.respond = () => {}
    }

    await expect(cli({ ...LIMITS, commandTimeoutMs: 20 }).json(['skills', 'list'], new AbortController().signal))
      .rejects.toThrow('lark-cli skills list timed out after 20ms')
    expect(subprocess.processes.map(process => process.terminated)).toEqual(phase === 'lookup' ? [] : [true])
  })

  it('keeps a caller deadline reason instead of reporting the command deadline', async () => {
    subprocess.respond = () => {}

    await expect(cli().json(['skills', 'list'], AbortSignal.timeout(20))).rejects.toThrow(expect.objectContaining({ name: 'TimeoutError' }))
  })

  it('terminates the process and rejects with the caller reason on cancellation', async () => {
    const caller = new AbortController()
    subprocess.respond = () => { caller.abort(new Error('caller left')) }

    await expect(cli().json(['skills', 'read', 'lark-doc'], caller.signal)).rejects.toThrow('caller left')
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })

  it('settles disposal only after owned processes exit and refuses later commands', async () => {
    subprocess.respond = (process) => { process.holdExit = true }
    const owner = cli()
    const pending = owner.json(['skills', 'list'], new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow('plugin disposed')
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })

    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(subprocess.processes[0]?.terminated).toBe(true) })
    expect(disposed).toBe(false)

    subprocess.processes[0]?.release()
    await disposal
    await rejected
    await expect(owner.json(['skills', 'list'], new AbortController().signal)).rejects.toThrow('plugin disposed')
    expect(subprocess.processes).toHaveLength(1)
  })
})
