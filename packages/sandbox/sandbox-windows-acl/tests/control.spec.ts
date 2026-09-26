import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SUBPROCESS_CONTROL_ENV } from '@deepseek-ai/dsh-subprocess/control'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

let ctx: Context | undefined
let scratch: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  ctx = undefined
  scratch = undefined
})

describe.skipIf(process.platform !== 'win32')('managed Windows ACL control pipe', () => {
  it.each(['read-only', 'workspace-write'])('runs without a visible console in %s mode', async (mode) => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-acl-console-'))
    const workspace = join(scratch, 'workspace')
    const temp = join(scratch, 'temp')
    await mkdir(workspace)
    await mkdir(temp)
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const runner = fileURLToPath(new URL('../src/runner.ts', import.meta.url))
    const fixture = fileURLToPath(new URL('../../../subprocess/win32-process/tests/fixtures/console-state.ts', import.meta.url))
    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '--import', 'tsx/esm', runner,
        '--workspace', workspace, '--temp', temp, '--mode', mode, '--', process.execPath, fixture],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 4096 } },
      graceMs: 1000,
    })
    try {
      expect(await handle.done).toEqual({ exitCode: 0, signal: null })
      expect(handle.collected.stderr?.readFrom(0).text).toBe('')
      expect(JSON.parse(handle.collected.stdout?.readFrom(0).text ?? '')).toMatchObject({ visible: false })
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  })

  it('preserves binary bytes through the Job and restricted-token runners while denying writes', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-acl-control-'))
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const runner = fileURLToPath(new URL('../src/runner.ts', import.meta.url))
    const helper = import.meta.resolve('@deepseek-ai/dsh-subprocess/src/control.ts')
    const program = `
      const { openInheritedControlChannel } = await import(process.argv[1]);
      const { writeFileSync } = await import('node:fs');
      const channel = openInheritedControlChannel();
      if (process.env.${SUBPROCESS_CONTROL_ENV} !== undefined) throw new Error('marker not consumed');
      try { writeFileSync(process.argv[2], 'must be denied'); process.exit(99); }
      catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
      process.stdout.write('ordinary stdout\\n');
      process.stderr.write('ordinary stderr\\n');
      channel.on('error', error => { throw error; });
      const chunks = []; let received = 0;
      channel.on('data', chunk => {
        chunks.push(chunk); received += chunk.length;
        if (received === 262144) channel.write(Buffer.concat(chunks), () => channel.destroy());
      });
    `
    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '--import', 'tsx/esm', runner,
        '--workspace', scratch, '--temp', scratch, '--mode', 'read-only', '--',
        process.execPath, '--input-type=module', '-e', program, helper, join(scratch, 'denied.txt')],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 4096 }, control: 'pipe' },
      graceMs: 1000,
    })
    const channel = handle.control
    if (channel === undefined) throw new Error('requested control pipe is absent')
    const input = Buffer.alloc(262144)
    for (let index = 0; index < input.length; index++) input[index] = index % 256
    const received = (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of channel) chunks.push(Buffer.from(chunk as Uint8Array))
      return Buffer.concat(chunks)
    })()
    channel.write(input)
    try {
      expect(await received).toEqual(input)
      expect(await handle.done).toEqual({ exitCode: 0, signal: null })
      expect(handle.collected.stdout?.readFrom(0).text).toBe('ordinary stdout\n')
      expect(handle.collected.stderr?.readFrom(0).text).toBe('ordinary stderr\n')
      expect(await handle.waitForExit()).toBe(true)
    } finally {
      channel.destroy()
      handle.terminate()
      await handle.waitForExit()
    }
  })
})
