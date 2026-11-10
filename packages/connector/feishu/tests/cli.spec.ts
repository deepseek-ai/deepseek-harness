import { Context } from '@deepseek-ai/cordis'
import { CliCommandExecutor } from '@deepseek-ai/dsh-cli-account'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseJson, PROGRAM, runJson } from '../src/cli.ts'
import { ScriptedSubprocess, type CliReply } from './harness.ts'

const EXECUTABLE = '/fixture/bin/lark-cli'

describe('lark-cli JSON commands', () => {
  let ctx: Context
  let subprocess: ScriptedSubprocess

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(ScriptedSubprocess)
    subprocess = ctx.subprocess as ScriptedSubprocess
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  const json = (reply: CliReply) => {
    subprocess.respond = (process) => { process.reply(reply) }
    const cli = new CliCommandExecutor(ctx.subprocess, { program: PROGRAM, executable: EXECUTABLE, commandTimeoutMs: 5_000 })
    return runJson(cli, ['skills', 'list', '--json'], AbortSignal.timeout(5_000))
  }

  it('runs lark-cli and parses its stdout', async () => {
    await expect(json({ stdout: '{"ok":\ntrue}\n' })).resolves.toEqual({ ok: true })
    expect(subprocess.lookups.map(lookup => lookup.command)).toEqual([EXECUTABLE])
    expect(subprocess.processes[0]?.spec.argv).toEqual([EXECUTABLE, 'skills', 'list', '--json'])
  })

  it.each([
    [{ exitCode: 2, stderr: ' {"ok":false} \n' }, 'lark-cli skills list --json exited with 2: {"ok":false}'],
    [{ exitCode: 1 }, /^lark-cli skills list --json exited with 1$/u],
    [{ stdout: 'not json' }, 'lark-cli skills list --json returned invalid JSON'],
  ])('names the command that failed %#', async (reply, message) => {
    await expect(json(reply)).rejects.toThrow(message)
  })

  it('parses JSON a caller read from another stream', () => {
    expect(parseJson(['auth', 'status'], '{"ok":false}')).toEqual({ ok: false })
    expect(() => parseJson(['auth', 'status'], '')).toThrow('lark-cli auth status returned invalid JSON')
  })
})
