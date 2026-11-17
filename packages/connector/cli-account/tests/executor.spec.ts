import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliCommandExecutor } from '../src/executor.ts'
import { EXECUTABLE, PROGRAM, ScriptedSubprocess, type ScriptedProcess } from './harness.ts'

const MAX_OUTPUT_BYTES = 1_048_576
const STDERR_TAIL_BYTES = 4096
const DRAIN_AFTER_EXIT_MS = 2_000

/** Write each chunk but the last as its own read, then finish the command with the last one on stderr. */
async function writeStderr(process: ScriptedProcess, chunks: readonly string[]): Promise<void> {
  for (const chunk of chunks.slice(0, -1)) {
    process.write('stderr', chunk)
    await vi.waitFor(() => { expect(process.stderr.readableLength).toBe(0) })
  }
  process.reply({ stderr: chunks.at(-1) as string })
}

describe('CliCommandExecutor', () => {
  let ctx: Context
  let subprocess: ScriptedSubprocess

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(ScriptedSubprocess)
    subprocess = ctx.subprocess as ScriptedSubprocess
  })

  afterEach(async () => {
    vi.useRealTimers()
    await ctx.fiber.dispose()
  })

  const executor = (commandTimeoutMs = 5_000) =>
    new CliCommandExecutor(ctx.subprocess, { program: PROGRAM, executable: EXECUTABLE, commandTimeoutMs })

  it('verifies the executable by its absolute path, spawns it without an environment, and returns its output', async () => {
    subprocess.respond = (process) => { process.reply({ stdout: 'authorized\n', stderr: 'progress\n', exitCode: 2 }) }

    await expect(executor().run(['auth', 'status'], AbortSignal.timeout(5_000)))
      .resolves.toEqual({ exitCode: 2, stdout: 'authorized\n', stderr: 'progress\n' })

    expect(subprocess.lookups).toEqual([{ command: EXECUTABLE, env: undefined }])
    const [process] = subprocess.processes
    expect(process?.spec).toMatchObject({
      argv: [EXECUTABLE, 'auth', 'status'],
      cwd: homedir(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    expect(process?.spec.env).toBeUndefined()
    expect(process?.terminated).toBe(true)
  })

  it.each([
    [{ exitCode: null, signal: 'SIGKILL' as const }, 'fixture-cli auth status exited with SIGKILL'],
    [{ stdout: 'x'.repeat(MAX_OUTPUT_BYTES + 1) }, `fixture-cli auth status output exceeded ${String(MAX_OUTPUT_BYTES)} bytes`],
  ])('rejects a command it cannot report %#', async (reply, message) => {
    subprocess.respond = (process) => { process.reply(reply) }

    await expect(executor().run(['auth', 'status'], AbortSignal.timeout(5_000))).rejects.toThrow(message)
  })

  it('keeps draining stdout after it exceeds the limit', async () => {
    subprocess.respond = async (process) => {
      process.write('stdout', 'x'.repeat(MAX_OUTPUT_BYTES + 1))
      await vi.waitFor(() => { expect(process.stdout.readableLength).toBe(0) })
      process.reply({ stdout: 'y' })
    }

    await expect(executor().run(['auth', 'status'], AbortSignal.timeout(5_000)))
      .rejects.toThrow(`fixture-cli auth status output exceeded ${String(MAX_OUTPUT_BYTES)} bytes`)
  })

  it('stops reading pipes a descendant keeps open 2 seconds after the command exits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    subprocess.respond = (process) => {
      process.holdPipes = true
      process.reply({ stdout: '{"ok":true}\n', stderr: 'progress\n' })
      setTimeout(() => { process.write('stderr', 'late\n') }, DRAIN_AFTER_EXIT_MS / 2)
    }
    let settled = false
    const running = executor().run(['auth', 'status'], new AbortController().signal).finally(() => { settled = true })

    await vi.advanceTimersByTimeAsync(DRAIN_AFTER_EXIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(running).resolves.toEqual({ exitCode: 0, stdout: '{"ok":true}\n', stderr: 'progress\nlate\n' })
    const [process] = subprocess.processes
    expect(process?.stdout.destroyed).toBe(true)
    expect(process?.stderr.destroyed).toBe(true)
    expect(process?.terminated).toBe(true)
  })

  it('reports output lines while the command runs and keeps the last 4 KiB of stderr', async () => {
    const lines: string[] = []
    subprocess.respond = (process) => {
      process.write('stderr', 'Open this link:\r\n  https://example.com/authorize?code=1\npart')
      process.write('stdout', 'one\n')
      process.reply({ stdout: 'two', stderr: 'ial\n' + 'e'.repeat(5000), exitCode: 3 })
    }

    const result = await executor().run(['auth', 'login'], AbortSignal.timeout(5_000), {
      onLine: (stream, line) => { lines.push(`${stream}:${line}`) },
    })

    expect(result.exitCode).toBe(3)
    expect(result.stdout).toBe('one\ntwo')
    expect(result.stderr).toBe('e'.repeat(STDERR_TAIL_BYTES))
    // Each stream keeps its own order; the two pipes interleave in any order. The final 5000-byte stderr line
    // exceeds the stderr limit and is skipped.
    expect(lines.filter(line => line.startsWith('stdout:'))).toEqual(['stdout:one', 'stdout:two'])
    expect(lines.filter(line => line.startsWith('stderr:'))).toEqual([
      'stderr:Open this link:', 'stderr:  https://example.com/authorize?code=1', 'stderr:partial',
    ])
  })

  it('ends a line at a lone carriage return, so a line the CLI redraws arrives while the command runs', async () => {
    const lines: string[] = []
    let login!: ScriptedProcess
    subprocess.respond = (process) => { login = process }
    const running = executor().run(['auth', 'login'], AbortSignal.timeout(5_000), {
      onLine: (stream, line) => { lines.push(`${stream}:${line}`) },
    })
    await vi.waitFor(() => { expect(login).toBeDefined() })

    login.write('stdout', 'https://example.com/device\r')
    await vi.waitFor(() => { expect(lines).toEqual(['stdout:https://example.com/device']) })
    // The `\n` completing the `\r\n` split across two reads ends no second line.
    login.write('stdout', '\nwaiting 1\rwaiting 2\r\nauthorized')
    login.reply({})
    await running

    expect(lines).toEqual(['stdout:https://example.com/device', 'stdout:waiting 1', 'stdout:waiting 2', 'stdout:authorized'])
  })

  it('skips each line longer than its stream limit and reports the lines around it', async () => {
    const lines: string[] = []
    subprocess.respond = process => writeStderr(process, [
      `${'e'.repeat(STDERR_TAIL_BYTES)}\n${'e'.repeat(STDERR_TAIL_BYTES + 1)}`,
      `e\n${'e'.repeat(3000)}`,
      `${'e'.repeat(3000)}\nhttps://example.com/device\n${'汉'.repeat(1365)}\n${'汉'.repeat(1366)}`,
    ])

    await executor().run(['auth', 'login'], AbortSignal.timeout(5_000), {
      onLine: (stream, line) => { lines.push(`${stream}:${String(Buffer.byteLength(line))}:${line.slice(0, 3)}`) },
    })

    expect(lines).toEqual(['stderr:4096:eee', 'stderr:26:htt', 'stderr:4095:汉汉汉'])
  })

  it('rejects with what onLine throws only after terminating the command and stopping its readers', async () => {
    const failure = new Error('unreadable line')
    const events: string[] = []
    subprocess.respond = async (process) => {
      process.holdPipes = true
      process.write('stderr', 'progress\npartial')
      await vi.waitFor(() => { expect(events).toEqual(['stderr:progress']) })
      process.write('stdout', 'unreadable\n')
    }
    const running = executor().run(['auth', 'login'], new AbortController().signal, {
      onLine: (stream, line) => {
        if (stream === 'stdout') throw failure
        events.push(`${stream}:${line}`)
      },
    }).finally(() => { events.push('settled') })

    await expect(running).rejects.toBe(failure)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(events).toEqual(['stderr:progress', 'stderr:partial', 'settled'])
    const [process] = subprocess.processes
    expect(process?.stdout.destroyed).toBe(true)
    expect(process?.stderr.destroyed).toBe(true)
    expect(process?.terminated).toBe(true)
  })

  it.each([
    ['three-byte characters in one read', ['汉'.repeat(5000)], '汉'.repeat(1365)],
    ['three-byte characters across reads', ['汉'.repeat(2000), '汉'.repeat(3000)], '汉'.repeat(1365)],
    ['surrogate pairs', [`${'😀'.repeat(3000)}x`], `${'😀'.repeat(1023)}x`],
    ['an exact fit', [`a${'é'.repeat(2048)}`], 'é'.repeat(2048)],
  ])('keeps the last 4 KiB of stderr by UTF-8 bytes, cut at a character boundary: %s', async (_name, chunks, tail) => {
    subprocess.respond = process => writeStderr(process, chunks)

    const result = await executor().run(['auth', 'status'], AbortSignal.timeout(5_000))

    expect(result.stderr).toBe(tail)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(STDERR_TAIL_BYTES)
  })

  it.each(['lookup', 'process'] as const)('applies the command deadline during %s', async (phase) => {
    if (phase === 'lookup') {
      subprocess.lookup = signal => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason instanceof Error ? signal.reason : new Error('lookup aborted')) }, { once: true })
      })
    } else {
      subprocess.respond = () => {}
    }

    await expect(executor(20).run(['auth', 'status'], new AbortController().signal))
      .rejects.toThrow('fixture-cli auth status timed out after 20ms')
    expect(subprocess.processes.map(process => process.terminated)).toEqual(phase === 'lookup' ? [] : [true])
  })

  it('lets a command that waits for the user outlast the command deadline', async () => {
    subprocess.respond = async (process) => {
      await new Promise((resolve) => { setTimeout(resolve, 60) })
      process.reply({ stdout: 'done' })
    }

    await expect(executor(20).run(['auth', 'login'], new AbortController().signal, { awaitsUser: true }))
      .resolves.toMatchObject({ exitCode: 0, stdout: 'done' })
  })

  it('keeps a caller deadline reason instead of reporting the command deadline', async () => {
    subprocess.respond = () => {}

    await expect(executor().run(['auth', 'status'], AbortSignal.timeout(20))).rejects.toThrow(expect.objectContaining({ name: 'TimeoutError' }))
  })

  it('terminates the process and rejects with the caller reason on cancellation', async () => {
    const caller = new AbortController()
    subprocess.respond = () => { caller.abort(new Error('caller left')) }

    await expect(executor().run(['auth', 'login'], caller.signal)).rejects.toThrow('caller left')
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })

  it('rejects a cancelled command 2 seconds after its exit when a descendant keeps the pipes open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const caller = new AbortController()
    subprocess.respond = (process) => {
      process.holdPipes = true
      caller.abort(new Error('caller left'))
    }

    const rejected = expect(executor().run(['auth', 'login'], caller.signal)).rejects.toThrow('caller left')
    await vi.advanceTimersByTimeAsync(DRAIN_AFTER_EXIT_MS)
    await rejected
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })

  it('settles disposal only after owned processes exit and refuses later commands', async () => {
    subprocess.respond = (process) => { process.holdExit = true }
    const owner = executor()
    const pending = owner.run(['auth', 'status'], new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow('fixture-cli: plugin disposed')
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })

    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(subprocess.processes[0]?.terminated).toBe(true) })
    expect(disposed).toBe(false)

    subprocess.processes[0]?.release()
    await disposal
    await rejected
    await expect(owner.run(['auth', 'status'], new AbortController().signal)).rejects.toThrow('fixture-cli: plugin disposed')
    expect(subprocess.processes).toHaveLength(1)
  })

  it('names the command line for diagnostics', () => {
    expect(executor().commandLine(['auth', 'show', '--status'])).toBe('fixture-cli auth show --status')
  })
})
